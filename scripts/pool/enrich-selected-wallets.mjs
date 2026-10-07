import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

function parseArgs() {
  const args = process.argv.slice(2);
  let tokenCA = null;
  let workers = 2;
  let limit = null;
  let refresh = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token") {
      tokenCA = args[i + 1]?.trim() ?? null;
      i++;
    } else if (arg === "--workers") {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        workers = parsed;
      }
      i++;
    } else if (arg === "--limit") {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        limit = parsed;
      }
      i++;
    } else if (arg === "--refresh") {
      refresh = true;
    }
  }

  if (!tokenCA && process.env.TOKEN_CA) {
    tokenCA = process.env.TOKEN_CA.trim();
  }

  return { tokenCA, workers, limit, refresh };
}

async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function main() {
  const { tokenCA, workers, limit, refresh } = parseArgs();

  if (!tokenCA) {
    throw new Error("Token CA is required. Use --token <TOKEN_CA>");
  }

  const selectedScanDir = path.resolve(
    ROOT,
    "data/discovery/pool-scanner",
    tokenCA,
    "selected-scan"
  );

  try {
    const stat = await fs.stat(selectedScanDir);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${selectedScanDir}`);
    }
  } catch {
    throw new Error(
      `Selected-scan directory not found for token ${tokenCA}. Please complete Step 3B first.`
    );
  }

  const scanStatePath = path.join(selectedScanDir, "scan-state.json");
  let scanState;
  try {
    const raw = await fs.readFile(scanStatePath, "utf8");
    scanState = JSON.parse(raw);
  } catch {
    throw new Error(
      `scan-state.json not found or invalid in ${selectedScanDir}. Please complete Step 3B first.`
    );
  }

  if (scanState?.status !== "completed") {
    throw new Error(
      `Selected pool scan is not completed (current status: ${scanState?.status}). Please complete Step 3B first.`
    );
  }

  const walletsPath = path.join(selectedScanDir, "wallets.json");
  let wallets;
  try {
    const raw = await fs.readFile(walletsPath, "utf8");
    wallets = JSON.parse(raw);
  } catch {
    throw new Error(
      `wallets.json not found or invalid in ${selectedScanDir}. Please complete Step 3B first.`
    );
  }

  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error(
      `wallets.json has no wallets in ${selectedScanDir}. At least one wallet is required.`
    );
  }

  const datasetPath = walletsPath;
  const outputPath = path.join(selectedScanDir, "fabriq-enriched.json");
  const checkpointPath = path.join(selectedScanDir, "fabriq-checkpoint.jsonl");
  const fabriqStatePath = path.join(selectedScanDir, "fabriq-state.json");

  const env = {
    ...process.env,
    FABRIQ_DATASET: datasetPath,
    FABRIQ_OUTPUT: outputPath,
    FABRIQ_CHECKPOINT: checkpointPath,
    FABRIQ_CONCURRENCY: String(workers),
  };
  if (limit) {
    env.FABRIQ_LIMIT = String(limit);
  }

  const startedAt = new Date().toISOString();
  if (refresh) {
    env.FABRIQ_REFRESH_BEFORE = startedAt;
  }
  const fabriqState = {
    version: "v1",
    tokenMint: tokenCA,
    status: "in_progress",
    totalWallets: wallets.length,
    workers,
    ...(limit ? { limit } : {}),
    ...(refresh ? { refresh: true, refreshCutoff: startedAt } : {}),
    startedAt,
    updatedAt: startedAt,
  };
  await atomicWriteJson(fabriqStatePath, fabriqState);

  const scriptPath = path.resolve(ROOT, "scripts/fabriq/enrich-wallets.mjs");

  console.log(`\n======================================`);
  console.log(`ENRICH SELECTED WALLETS (STEP 3C-A)`);
  console.log(`======================================`);
  console.log(`Token CA:      ${tokenCA}`);
  console.log(`Total Wallets: ${wallets.length}`);
  console.log(`Workers:       ${workers}`);
  if (limit) {
    console.log(`Limit:         ${limit}`);
  }
  if (refresh) {
    console.log(`Refresh Mode:  ENABLED (Cutoff: ${startedAt})`);
  }
  console.log(`Dataset:       ${datasetPath}`);
  console.log(`Output:        ${outputPath}`);
  console.log(`Checkpoint:    ${checkpointPath}`);
  console.log(`======================================\n`);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: ROOT,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on("error", async (err) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[ENRICH_SELECTED] Process error:", errorMsg);
    fabriqState.status = "error";
    fabriqState.error = errorMsg;
    fabriqState.updatedAt = new Date().toISOString();
    await atomicWriteJson(fabriqStatePath, fabriqState);
    process.exit(1);
  });

  child.on("exit", async (code, signal) => {
    if (code === 0) {
      console.log(`\n[ENRICH_SELECTED] COMPLETE`);
      fabriqState.status = "completed";
      fabriqState.completedAt = new Date().toISOString();
      fabriqState.updatedAt = new Date().toISOString();
      await atomicWriteJson(fabriqStatePath, fabriqState);
      process.exit(0);
    } else {
      const errMsg = `Fabriq enrichment failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
      console.error(`\n[ENRICH_SELECTED] ${errMsg}`);
      fabriqState.status = "error";
      fabriqState.error = errMsg;
      fabriqState.updatedAt = new Date().toISOString();
      await atomicWriteJson(fabriqStatePath, fabriqState);
      process.exit(code ?? 1);
    }
  });
}

main().catch((err) => {
  console.error("\n[ENRICH_SELECTED FAILED]", err);
  process.exit(1);
});
