import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const SCANNED_POOLS_PATH = path.join(ROOT, "data/master/scanned-pools.json");

function parseArgs() {
  const args = process.argv.slice(2);
  let poolAddress = null;
  let workers = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pool" && args[i + 1]) {
      poolAddress = args[i + 1].trim();
      i++;
    } else if (arg.startsWith("--pool=")) {
      poolAddress = arg.slice("--pool=".length).trim();
    } else if (arg === "--workers" && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        workers = parsed;
      }
      i++;
    } else if (arg.startsWith("--workers=")) {
      const parsed = parseInt(arg.slice("--workers=".length), 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        workers = parsed;
      }
    }
  }

  if (!workers && process.env.FABRIQ_CONCURRENCY) {
    const parsed = parseInt(process.env.FABRIQ_CONCURRENCY, 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      workers = parsed;
    }
  }
  if (!workers) {
    workers = 8;
  }

  if (!poolAddress) {
    throw new Error(
      "Pool address is required.\nUsage: node scripts/pool/refresh-pool.mjs --pool <POOL_ADDRESS> [--workers <N>]"
    );
  }

  return { poolAddress, workers };
}

function runSubprocess(cmd, args, stepName) {
  return new Promise((resolve, reject) => {
    console.log(`\n[REFRESH_POOL] EXEC: ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (err) => {
      reject(new Error(`[${stepName}] Process spawn error: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = `[${stepName}] Subprocess failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
        reject(new Error(msg));
      }
    });
  });
}

async function main() {
  const { poolAddress, workers } = parseArgs();

  console.log("========================================");
  console.log("EXACT POOL REFRESH ORCHESTRATOR");
  console.log("========================================");
  console.log(`Target Pool: ${poolAddress}`);
  if (workers) {
    console.log(`Workers:     ${workers}`);
  }
  // 1. Read canonical scanned-pools.json
  let scannedPoolsData;
  try {
    const raw = await fs.readFile(SCANNED_POOLS_PATH, "utf8");
    scannedPoolsData = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to read canonical pools from ${SCANNED_POOLS_PATH}: ${err.message}`);
  }

  const pools = Array.isArray(scannedPoolsData?.pools) ? scannedPoolsData.pools : [];
  const canonicalPool = pools.find((p) => p.poolAddress === poolAddress);

  if (!canonicalPool) {
    throw new Error(
      `404: Pool ${poolAddress} is not present in canonical registry (${SCANNED_POOLS_PATH}).`
    );
  }

  const { tokenMint, pair, binStep, baseFeePct } = canonicalPool;
  if (!tokenMint) {
    throw new Error(`Canonical pool ${poolAddress} is missing required tokenMint field.`);
  }

  console.log(`Resolved Metadata:`);
  console.log(`  Token Mint:  ${tokenMint}`);
  console.log(`  Pair:        ${pair}`);
  console.log(`  Bin Step:    ${binStep}`);
  console.log(`  Base Fee:    ${baseFeePct}%`);
  console.log(`----------------------------------------`);

  console.log(`[REFRESH_POOL] START pool="${poolAddress}" token="${tokenMint}" pair="${pair}"`);

  // Stage 1: SCANNING
  console.log(`[REFRESH_POOL] STAGE scanning`);
  await runSubprocess(
    process.execPath,
    [
      "scripts/pool/scan-selected-pools.mjs",
      "--token",
      tokenMint,
      "--pool",
      poolAddress,
      "--refresh",
    ],
    "SCANNING"
  );

  // Stage 2: ENRICHING
  console.log(`[REFRESH_POOL] STAGE enriching`);
  const enrichArgs = [
    "scripts/pool/enrich-selected-wallets.mjs",
    "--token",
    tokenMint,
    "--refresh",
  ];
  if (workers) {
    enrichArgs.push("--workers", String(workers));
  }
  await runSubprocess(
    process.execPath,
    enrichArgs,
    "ENRICHING"
  );

  // Stage 3: TRADE_HISTORY
  console.log(`[REFRESH_POOL] STAGE trade_history`);
  await runSubprocess(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/pool/build-pool-trade-history.ts",
      "--token",
      tokenMint,
      "--refresh",
    ],
    "TRADE_HISTORY"
  );

  // Stage 4: PERSISTING
  console.log(`[REFRESH_POOL] STAGE persisting`);
  await runSubprocess(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/pipeline/persist-pool-scanner.ts",
      "--token",
      tokenMint,
      "--pool",
      poolAddress,
    ],
    "PERSISTING"
  );

  // Stage 5: SYNCING
  console.log(`[REFRESH_POOL] STAGE syncing`);
  await runSubprocess(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/pipeline/sync-pool-wallets.ts",
      "--token",
      tokenMint,
      "--pool",
      poolAddress,
    ],
    "SYNCING"
  );

  // Stage 6: PUBLISHING
  console.log(`[REFRESH_POOL] STAGE publishing`);
  await runSubprocess(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/pipeline/publish-wallets.ts",
    ],
    "PUBLISHING"
  );

  console.log(`[REFRESH_POOL] COMPLETE pool="${poolAddress}"`);
  console.log("========================================");
  console.log("EXACT POOL REFRESH COMPLETE");
  console.log("========================================");
}

main().catch((err) => {
  console.error(`\n[REFRESH_POOL] ERROR: ${err.message}`);
  process.exit(1);
});
