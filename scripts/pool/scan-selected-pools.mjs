import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { discoverTokenPools } from "./discover-token-pools.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";

const MIN_PAGE_DELAY = 350;
const MAX_PAGE_DELAY = 800;
const MIN_POOL_DELAY = 2000;
const MAX_POOL_DELAY = 4500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let tokenCA = null;
  let refresh = false;
  const pools = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token") {
      tokenCA = args[i + 1]?.trim() ?? null;
      i++;
    } else if (arg === "--pool") {
      const p = args[i + 1]?.trim();
      if (p) pools.push(p);
      i++;
    } else if (arg === "--refresh") {
      refresh = true;
    }
  }

  if (!tokenCA && process.env.TOKEN_CA) {
    tokenCA = process.env.TOKEN_CA.trim();
  }

  return { tokenCA, pools, refresh };
}

function computeSelectionFingerprint(tokenMint, poolAddresses) {
  const sorted = [...new Set(poolAddresses)].sort();
  return createHash("sha256")
    .update(`${tokenMint}:${sorted.join(",")}`)
    .digest("hex");
}

async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function getGlobalWallets(completedPoolsMap) {
  const set = new Set();
  for (const p of completedPoolsMap.values()) {
    if (Array.isArray(p.wallets)) {
      for (const w of p.wallets) {
        if (typeof w?.wallet === "string" && w.wallet.trim()) {
          set.add(w.wallet.trim());
        }
      }
    }
  }
  return Array.from(set).sort();
}

async function saveCheckpoints({
  outputDir,
  tokenCA,
  fingerprint,
  selectedPools,
  completedPoolsMap,
  status = "in_progress",
  startedAt,
  error = null,
}) {
  const completedList = Array.from(completedPoolsMap.values());
  const globalWallets = getGlobalWallets(completedPoolsMap);
  const completedAddresses = Array.from(completedPoolsMap.keys());
  const isAllComplete = completedAddresses.length === selectedPools.length;

  const poolWalletsData = {
    version: "v1",
    tokenMint: tokenCA,
    updatedAt: new Date().toISOString(),
    pools: completedList,
  };
  await atomicWriteJson(path.join(outputDir, "pool-wallets.json"), poolWalletsData);

  await atomicWriteJson(path.join(outputDir, "wallets.json"), globalWallets);

  const scanStateData = {
    version: "v1",
    tokenMint: tokenCA,
    selectionFingerprint: fingerprint,
    status: isAllComplete ? "completed" : status,
    selectedPoolCount: selectedPools.length,
    completedPoolCount: completedAddresses.length,
    pendingPoolCount: selectedPools.length - completedAddresses.length,
    selectedPoolAddresses: selectedPools.map((p) => p.poolAddress),
    completedPoolAddresses: completedAddresses,
    startedAt,
    updatedAt: new Date().toISOString(),
    ...(isAllComplete ? { completedAt: new Date().toISOString() } : {}),
    ...(error ? { error } : {}),
  };
  await atomicWriteJson(path.join(outputDir, "scan-state.json"), scanStateData);
}

async function fetchTopLpersPage(page, poolAddress, pageNumber) {
  return await page.evaluate(
    async ({ poolAddress, pageNumber }) => {
      const url =
        `https://api.lpagent.io/api/v1/pools/${poolAddress}/top-lpers` +
        `?page=${pageNumber}` +
        `&pageSize=20` +
        `&order_by=total_pnl_native` +
        `&sort_order=desc`;

      const response = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `LP Agent HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const json = JSON.parse(text);

      if (json?.status !== "success" || !Array.isArray(json?.data)) {
        throw new Error(`Invalid LP Agent response page ${pageNumber}`);
      }

      return json;
    },
    {
      poolAddress,
      pageNumber,
    }
  );
}

async function scanPoolDirect(page, poolAddress) {
  await page.goto(
    `https://app.lpagent.io/pools/${poolAddress}?tab=top`,
    {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    }
  );

  const first = await fetchTopLpersPage(page, poolAddress, 1);
  const totalPages = Number(first?.pagination?.totalPages ?? 1);
  const totalCount = Number(first?.pagination?.totalCount ?? 0);

  const allRows = [...(first.data || [])];

  console.log(
    `    Page 1/${totalPages} | rows=${first.data?.length || 0} | reportedTotal=${totalCount}`
  );

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
    const delay = randomDelay(MIN_PAGE_DELAY, MAX_PAGE_DELAY);
    await sleep(delay);

    const json = await fetchTopLpersPage(page, poolAddress, pageNumber);
    const rows = json.data || [];
    allRows.push(...rows);

    console.log(
      `    Page ${pageNumber}/${totalPages} | rows=${rows.length} | totalRows=${allRows.length}`
    );
  }

  return {
    rows: allRows,
    totalPages,
    totalCount,
  };
}

async function main() {
  const { tokenCA, pools: rawPools, refresh } = parseCliArgs();
  if (!tokenCA) {
    throw new Error("Token CA is required. Use --token <TOKEN_CA>");
  }

  if (!rawPools.length) {
    throw new Error("At least one pool address is required. Use --pool <POOL_ADDRESS>");
  }

  const uniqueSelectedAddresses = [...new Set(rawPools)];

  console.log(`\n======================================`);
  console.log(`SELECTED POOL SCANNER (STEP 3B)`);
  console.log(`======================================`);
  console.log(`Token CA: ${tokenCA}`);
  console.log(`Selected Pools: ${uniqueSelectedAddresses.length}`);
  if (refresh) {
    console.log(`Refresh Mode:   ENABLED (forcing fresh LP Agent extraction)`);
  }
  console.log("\n[Discovery] Validating selected pools with Meteora API...");
  const discoveryResult = await discoverTokenPools(tokenCA);
  const discoveredMap = new Map(discoveryResult.pools.map((p) => [p.poolAddress, p]));

  for (const addr of uniqueSelectedAddresses) {
    if (!discoveredMap.has(addr)) {
      throw new Error(
        `Selected pool ${addr} is not an authoritative TOKEN/SOL pool for token ${tokenCA}`
      );
    }
  }

  const selectedPools = discoveryResult.pools.filter((p) =>
    uniqueSelectedAddresses.includes(p.poolAddress)
  );

  console.log(`[Discovery] Authoritative pools validated: ${selectedPools.length}`);
  for (const [idx, p] of selectedPools.entries()) {
    console.log(
      `  ${idx + 1}. ${p.pair} | binStep=${p.binStep ?? "—"} | fee=${p.baseFeePct ?? "—"}% | ${p.poolAddress}`
    );
  }

  const fingerprint = computeSelectionFingerprint(
    tokenCA,
    selectedPools.map((p) => p.poolAddress)
  );

  const outputDir = path.resolve(ROOT, "data/discovery/pool-scanner", tokenCA, "selected-scan");
  await fs.mkdir(outputDir, { recursive: true });

  let canResume = false;
  let savedState = null;
  const completedPoolsMap = new Map();

  try {
    const stateRaw = await fs.readFile(path.join(outputDir, "scan-state.json"), "utf8");
    savedState = JSON.parse(stateRaw);
    if (
      savedState?.tokenMint === tokenCA &&
      savedState?.selectionFingerprint === fingerprint
    ) {
      canResume = true;
    }
  } catch {
    canResume = false;
  }

  if (canResume) {
    try {
      const poolWalletsRaw = await fs.readFile(path.join(outputDir, "pool-wallets.json"), "utf8");
      const pwData = JSON.parse(poolWalletsRaw);
      if (Array.isArray(pwData?.pools)) {
        for (const poolItem of pwData.pools) {
          if (poolItem?.status === "completed" && poolItem?.poolAddress) {
            completedPoolsMap.set(poolItem.poolAddress, poolItem);
          }
        }
      }
      if (refresh) {
        for (const addr of uniqueSelectedAddresses) {
          completedPoolsMap.delete(addr);
        }
        console.log(
          `[Refresh] Cleared cached completion for ${uniqueSelectedAddresses.length} target pool(s) to force fresh extraction.`
        );
      } else {
        console.log(
          `[Resume] Matching selection fingerprint found. Resuming with ${completedPoolsMap.size} completed pool(s).`
        );
      }
    } catch {
      completedPoolsMap.clear();
    }
  } else {
    console.log(`[Init] New selection set or fingerprint mismatch. Starting fresh selected scan.`);
  }

  let createdAt = new Date().toISOString();
  try {
    if (canResume && !refresh) {
      const selRaw = await fs.readFile(path.join(outputDir, "selection.json"), "utf8");
      const selData = JSON.parse(selRaw);
      if (selData?.createdAt) {
        createdAt = selData.createdAt;
      }
    }
  } catch {}

  const selectionData = {
    version: "v1",
    tokenMint: tokenCA,
    selectionFingerprint: fingerprint,
    createdAt,
    selectedPoolCount: selectedPools.length,
    pools: selectedPools.map((p) => ({
      poolAddress: p.poolAddress,
      pair: p.pair,
      binStep: p.binStep,
      baseFeePct: p.baseFeePct,
    })),
  };
  await atomicWriteJson(path.join(outputDir, "selection.json"), selectionData);

  const startedAt = refresh ? new Date().toISOString() : (savedState?.startedAt ?? new Date().toISOString());

  const allAlreadyComplete = selectedPools.every((p) => completedPoolsMap.has(p.poolAddress));
  if (allAlreadyComplete) {
    console.log(`[Selected Scan] All ${selectedPools.length} selected pools already completed.`);
    await saveCheckpoints({
      outputDir,
      tokenCA,
      fingerprint,
      selectedPools,
      completedPoolsMap,
      status: "completed",
      startedAt,
    });
    const uniqueWallets = getGlobalWallets(completedPoolsMap).length;
    console.log(
      `[SELECTED_SCAN] POOL_PROGRESS completed=${completedPoolsMap.size} total=${selectedPools.length} wallets=${uniqueWallets}`
    );
    console.log(
      `[SELECTED_SCAN] COMPLETE totalPools=${selectedPools.length} uniqueWallets=${uniqueWallets}`
    );
    process.exit(0);
  }

  console.log(`\n[Browser] Connecting to shared Brave CDP at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(
    CDP_URL,
    {
      timeout: 120000,
    }
  );
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context found in Brave CDP session");
  }

  let page = context.pages().find(
    (p) => !p.isClosed() && p.url().includes("app.lpagent.io")
  );
  if (!page) {
    page = await context.newPage();
  }

  for (let i = 0; i < selectedPools.length; i++) {
    const pool = selectedPools[i];

    if (completedPoolsMap.has(pool.poolAddress)) {
      console.log(`\n[Skip] Pool ${i + 1}/${selectedPools.length} (${pool.poolAddress}) already completed.`);
      continue;
    }

    console.log(
      `[SELECTED_SCAN] CURRENT_POOL pair="${pool.pair}" bin=${pool.binStep} fee=${pool.baseFeePct} addr="${pool.poolAddress}"`
    );
    console.log(`\n======================================`);
    console.log(`POOL ${completedPoolsMap.size + 1}/${selectedPools.length}`);
    console.log(`Pair: ${pool.pair} | Bin Step: ${pool.binStep ?? "—"} | Base Fee: ${pool.baseFeePct ?? "—"}%`);
    console.log(`Pool Address: ${pool.poolAddress}`);
    console.log(`======================================`);

    try {
      const result = await scanPoolDirect(page, pool.poolAddress);

      const poolWalletsMap = new Map();
      for (const row of result.rows) {
        const wallet =
          typeof row?.owner === "string" && row.owner.trim()
            ? row.owner.trim()
            : typeof row?.wallet === "string" && row.wallet.trim()
            ? row.wallet.trim()
            : null;

        if (!wallet) continue;

        if (!poolWalletsMap.has(wallet)) {
          let pnlUsd = null;
          if (
            row?.total_pnl !== undefined &&
            row?.total_pnl !== null &&
            row?.total_pnl !== ""
          ) {
            const parsed = Number(row.total_pnl);
            if (Number.isFinite(parsed)) {
              pnlUsd = parsed;
            }
          }

          let winRate = null;
          if (
            row?.win_rate !== undefined &&
            row?.win_rate !== null &&
            row?.win_rate !== ""
          ) {
            const parsed = Number(row.win_rate);
            if (Number.isFinite(parsed)) {
              winRate = parsed * 100;
            }
          }

          let positions = null;
          if (
            row?.total_lp !== undefined &&
            row?.total_lp !== null &&
            row?.total_lp !== ""
          ) {
            const parsed = Number(row.total_lp);
            if (Number.isFinite(parsed)) {
              positions = parsed;
            }
          }

          poolWalletsMap.set(wallet, {
            wallet,
            pnlUsd,
            winRate,
            positions,
          });
        }
      }

      completedPoolsMap.set(pool.poolAddress, {
        poolAddress: pool.poolAddress,
        pair: pool.pair,
        binStep: pool.binStep,
        baseFeePct: pool.baseFeePct,
        status: "completed",
        walletCount: poolWalletsMap.size,
        wallets: Array.from(poolWalletsMap.values()),
      });

      await saveCheckpoints({
        outputDir,
        tokenCA,
        fingerprint,
        selectedPools,
        completedPoolsMap,
        status: "in_progress",
        startedAt,
      });

      const globalWallets = getGlobalWallets(completedPoolsMap);
      console.log(
        `\n[Pool Complete] ${pool.pair} (${pool.poolAddress}): ${poolWalletsMap.size} wallets extracted.`
      );
      console.log(
        `[SELECTED_SCAN] POOL_PROGRESS completed=${completedPoolsMap.size} total=${selectedPools.length} wallets=${globalWallets.length}`
      );

      if (i < selectedPools.length - 1) {
        const poolDelay = randomDelay(MIN_POOL_DELAY, MAX_POOL_DELAY);
        console.log(`[Global] Waiting ${poolDelay}ms before next pool...`);
        await sleep(poolDelay);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[Pool FAILED] ${pool.poolAddress}: ${msg}`);
      await saveCheckpoints({
        outputDir,
        tokenCA,
        fingerprint,
        selectedPools,
        completedPoolsMap,
        status: "error",
        startedAt,
        error: msg,
      });
      throw err;
    }
  }

  await saveCheckpoints({
    outputDir,
    tokenCA,
    fingerprint,
    selectedPools,
    completedPoolsMap,
    status: "completed",
    startedAt,
  });

  const finalGlobalWallets = getGlobalWallets(completedPoolsMap);

  console.log(`\n======================================`);
  console.log(`SELECTED POOLS SCAN COMPLETE`);
  console.log(`Total Pools: ${selectedPools.length}`);
  console.log(`Completed Pools: ${completedPoolsMap.size}`);
  console.log(`Unique Wallets: ${finalGlobalWallets.length}`);
  console.log(`Output Directory: ${outputDir}`);
  console.log(`======================================`);
  console.log(
    `[SELECTED_SCAN] COMPLETE totalPools=${selectedPools.length} uniqueWallets=${finalGlobalWallets.length}`
  );

  // Do NOT browser.close() the shared Brave browser
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[SELECTED_SCAN FAILED]", err);
  process.exit(1);
});
