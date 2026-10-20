import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWalletPoolCumulativeAggregates,
  extractPoolSearchQueries,
  AdaptiveRequestLimiter,
  type FabriqPoolCumulativeAggregate,
  type CumulativeFetchStats,
} from "../analytics/fabriq-analytics-client.ts";
import type {
  PoolTradeHistoryOutput,
  PoolCumulativeHistoryOutput,
  WalletCheckpoint,
  RunScope,
} from "./build-pool-trade-history.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

export interface CumulativeWalletCheckpoint {
  version: "v1";
  selectionFingerprint: string;
  wallet: string;
  status: "completed" | "unavailable";
  reason?: "success" | "not_found" | "http_error";
  aggregates: FabriqPoolCumulativeAggregate[];
  fetchedAt: string;
  error?: string;
}
function isValidCompletedCheckpoint(
  cp: unknown,
  selectionFingerprint: string,
  wallet: string
): boolean {
  if (!cp || typeof cp !== "object") return false;
  const record = cp as Record<string, unknown>;

  if (
    record.version !== "v1" ||
    record.selectionFingerprint !== selectionFingerprint ||
    record.wallet !== wallet ||
    record.status !== "completed" ||
    record.reason === "http_error" ||
    Boolean(record.error)
  ) {
    return false;
  }

  if (record.reason === "not_found") {
    return Array.isArray(record.aggregates);
  }

  if (record.reason === "success") {
    return Array.isArray(record.aggregates);
  }

  if (record.reason === undefined) {
    return Array.isArray(record.aggregates) && record.aggregates.length > 0;
  }

  return false;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let tokenCA: string | null = null;
  let targetWallet: string | null = null;
  let limit: number | null = null;
  let workers = 8;
  let refresh = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--token" && args[i + 1]) {
        tokenCA = args[i + 1].trim();
        i++;
      } else if (arg.startsWith("--token=")) {
        tokenCA = arg.slice(8).trim();
      } else if (arg === "--wallet" && args[i + 1]) {
        targetWallet = args[i + 1].trim();
        i++;
      } else if (arg.startsWith("--wallet=")) {
        targetWallet = arg.slice(9).trim();
      } else if (arg === "--limit" && args[i + 1]) {
        const parsed = parseInt(args[i + 1], 10);
        if (Number.isInteger(parsed) && parsed >= 1) {
          limit = parsed;
        }
        i++;
      } else if (arg.startsWith("--limit=")) {
        const parsed = parseInt(arg.slice(8), 10);
        if (Number.isInteger(parsed) && parsed >= 1) {
          limit = parsed;
        }
      } else if (arg === "--workers" && args[i + 1]) {
        const parsed = parseInt(args[i + 1], 10);
        if (Number.isInteger(parsed) && parsed >= 1) {
          workers = Math.min(8, Math.max(1, parsed));
        }
        i++;
      } else if (arg.startsWith("--workers=")) {
        const parsed = parseInt(arg.slice(10), 10);
        if (Number.isInteger(parsed) && parsed >= 1) {
          workers = Math.min(8, Math.max(1, parsed));
        }
      } else if (arg === "--refresh") {
        refresh = true;
      }
    }

  if (!tokenCA && process.env.TOKEN_CA) {
    tokenCA = process.env.TOKEN_CA.trim();
  }

  return { tokenCA, targetWallet, limit, workers, refresh };
}

async function main() {
  const { tokenCA, targetWallet, limit, workers, refresh } = parseCliArgs();

  if (!tokenCA) {
    throw new Error("Token CA is required. Use --token <TOKEN_CA>");
  }

  const selectedScanDir = path.resolve(
    ROOT,
    "data/discovery/pool-scanner",
    tokenCA,
    "selected-scan"
  );

  const scanStatePath = path.join(selectedScanDir, "scan-state.json");
  let scanState: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(scanStatePath, "utf8");
    scanState = JSON.parse(raw);
  } catch {
    throw new Error(
      `scan-state.json not found in ${selectedScanDir}. Please complete Step 3B first.`
    );
  }

  const rawFingerprint = scanState?.selectionFingerprint;
  if (!rawFingerprint || typeof rawFingerprint !== "string") {
    throw new Error(
      `selectionFingerprint missing or invalid in scan-state.json.`
    );
  }
  const selectionFingerprint: string = rawFingerprint;

  const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
  let poolWalletsData: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(poolWalletsPath, "utf8");
    poolWalletsData = JSON.parse(raw);
  } catch {
    throw new Error(
      `pool-wallets.json not found in ${selectedScanDir}. Please complete Step 3B first.`
    );
  }

  const rawPools: unknown[] = Array.isArray(poolWalletsData?.pools)
    ? poolWalletsData.pools
    : [];
  if (rawPools.length === 0) {
    throw new Error(`No pools found in pool-wallets.json.`);
  }

  const walletToPoolsMap = new Map<string, Set<string>>();
  const allPoolAddresses: string[] = [];
  const poolToPairMap = new Map<string, string>();

  for (const rawPool of rawPools) {
    const pool = rawPool as Record<string, unknown>;
    const poolAddr = typeof pool?.poolAddress === "string" ? pool.poolAddress.trim() : "";
    if (!poolAddr) continue;
    allPoolAddresses.push(poolAddr);
    const pair = typeof pool?.pair === "string" ? pool.pair.trim() : "";
    if (pair) poolToPairMap.set(poolAddr, pair);

    const walletsList = Array.isArray(pool?.wallets) ? pool.wallets as Array<Record<string, unknown>> : [];
    for (const item of walletsList) {
      const w = typeof item?.wallet === "string" ? item.wallet.trim() : "";
      if (!w) continue;
      if (!walletToPoolsMap.has(w)) {
        walletToPoolsMap.set(w, new Set());
      }
      walletToPoolsMap.get(w)!.add(poolAddr);
    }
  }

  try {
    const scannedPoolsPath = path.resolve(ROOT, "data/master/scanned-pools.json");
    const rawScanned = await fs.readFile(scannedPoolsPath, "utf8");
    const parsedScanned = JSON.parse(rawScanned);
    const scannedList = Array.isArray(parsedScanned?.pools) ? parsedScanned.pools : [];
    for (const p of scannedList) {
      const addr = typeof p?.poolAddress === "string" ? p.poolAddress.trim() : "";
      const pair = typeof p?.pair === "string" ? p.pair.trim() : "";
      if (addr && pair && !poolToPairMap.has(addr)) {
        poolToPairMap.set(addr, pair);
      }
    }
  } catch {
    // optional enrichment fallback
  }

  let walletsToProcess = Array.from(walletToPoolsMap.keys()).sort();

  if (targetWallet) {
    if (!walletToPoolsMap.has(targetWallet)) {
      throw new Error(
        `Target wallet ${targetWallet} does not belong to any selected pools in pool-wallets.json.`
      );
    }
    walletsToProcess = [targetWallet];
  } else if (limit && Number.isInteger(limit) && limit >= 1) {
    walletsToProcess = walletsToProcess.slice(0, limit);
  }

  const cumulativeCheckpointDir = path.join(
    selectedScanDir,
    "cumulative-checkpoints",
    selectionFingerprint
  );
  await fs.mkdir(cumulativeCheckpointDir, { recursive: true });

  const tradeCheckpointDir = path.join(
    selectedScanDir,
    "trade-history-checkpoints",
    selectionFingerprint
  );

  const stateFilePath = path.join(selectedScanDir, "cumulative-state.json");
  const stageStartTimeMs = Date.now();
  const startedAt = new Date().toISOString();

  let completedWallets = 0;
  let emptyWallets = 0;
  let httpErrorWallets = 0;
  let unavailableWallets = 0;
  let totalAggregatesCount = 0;
  let checkpointsReused = 0;
  let failedCheckpointsRetried = 0;
  let walletsActuallyFetched = 0;
  let networkRequests = 0;
  let pagesFetchedTotal = 0;
  let retriesCount = 0;
  let http500Count = 0;
  let http429Count = 0;
  const walletCumulativeMap = new Map<string, FabriqPoolCumulativeAggregate[]>();
  const limiter = new AdaptiveRequestLimiter({
    maxConcurrency: workers,
    minConcurrency: 1,
    onConcurrencyChange: (newC, reason) => {
      console.log(`[CUMULATIVE_LIMITER] Concurrency adjusted to ${newC} (reason: ${reason})`);
    },
  });

  const runScope: RunScope = targetWallet
    ? "wallet"
    : limit !== null
    ? "limit"
    : "full";
  const processedWalletCount = walletsToProcess.length;

  console.log(`\n======================================`);
  console.log(`EXTRACT POOL CUMULATIVE (STEP 3C-C)`);
  console.log(`======================================`);
  console.log(`Token CA:              ${tokenCA}`);
  console.log(`Selection Fingerprint: ${selectionFingerprint}`);
  console.log(`Run Scope:             ${runScope}`);
  console.log(`Membership Wallets:    ${walletToPoolsMap.size}`);
  console.log(`Processed Wallets:     ${processedWalletCount}`);
  console.log(`Associated Pools:      ${allPoolAddresses.length}`);
  console.log(`Workers:               ${workers}`);
  if (targetWallet) console.log(`Requested Wallet:      ${targetWallet}`);
  if (limit !== null) console.log(`Limit:                 ${limit}`);
  if (refresh) console.log(`Refresh Mode:          ENABLED (bypassing checkpoints)`);
  console.log(`Checkpoints:           ${cumulativeCheckpointDir}`);
  console.log(`======================================\n`);

  let preAuditReused = 0;
  let preAuditRetry = 0;
  let preAuditUnseen = 0;

  if (!refresh) {
    for (const w of walletsToProcess) {
      const cpFile = path.join(cumulativeCheckpointDir, `${w}.json`);
      try {
        const raw = await fs.readFile(cpFile, "utf8");
        const cp = JSON.parse(raw);
        if (isValidCompletedCheckpoint(cp, selectionFingerprint, w)) {
          preAuditReused++;
        } else {
          preAuditRetry++;
        }
      } catch {
        preAuditUnseen++;
      }
    }
  } else {
    preAuditUnseen = walletsToProcess.length;
  }

  const preAuditToFetch = preAuditRetry + preAuditUnseen;

  console.log(`--- Checkpoint Resume Audit ---`);
  console.log(`Total Wallets:                ${walletsToProcess.length}`);
  console.log(`Completed Checkpoints Reused: ${preAuditReused}`);
  console.log(`Failed Checkpoints (Retry):   ${preAuditRetry}`);
  console.log(`Unvisited Wallets:            ${preAuditUnseen}`);
  console.log(`Wallets to Fetch:             ${preAuditToFetch}`);
  console.log(`--------------------------------\n`);

  if (preAuditToFetch > 0) {
    try {
      const probeRes = await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(1500) });
      if (!probeRes.ok) {
        console.warn(`[CDP_PREFLIGHT] Warning: CloakBrowser endpoint returned HTTP ${probeRes.status}.`);
      }
    } catch (probeErr: unknown) {
      const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      console.warn(`[CDP_PREFLIGHT] WARNING: CloakBrowser remote debugging endpoint is unreachable at http://127.0.0.1:9223 (${msg}).`);
      console.warn(`[CDP_PREFLIGHT] Wallets requiring network extraction will fail. Ensure CloakBrowser is running via 'npm run browser:cloak'.\n`);
    }
  }

  let previousState: any = null;
  try {
    const rawState = await fs.readFile(stateFilePath, "utf8");
    previousState = JSON.parse(rawState);
  } catch {}

  const refreshCutoff = refresh
    ? (previousState?.status === "in_progress" && previousState?.refreshCutoff ? previousState.refreshCutoff : startedAt)
    : null;

  async function updateStateFile(status: "in_progress" | "completed" | "error") {
    const now = new Date().toISOString();
    const stateContent = {
      version: "v1",
      tokenMint: tokenCA,
      selectionFingerprint,
      status,
      totalWallets: walletsToProcess.length,
      completedWallets,
      emptyWallets,
      httpErrorWallets,
      unavailableWallets,
      totalAggregates: totalAggregatesCount,
      checkpointsReused,
      failedCheckpointsRetried,
      walletsActuallyFetched,
      networkRequests,
      pagesFetched: pagesFetchedTotal,
      retriesCount,
      http500Count,
      http429Count,
      startedAt,
      refresh,
      ...(refreshCutoff ? { refreshCutoff } : {}),
      updatedAt: now,
      ...(status === "completed" ? { completedAt: now } : {}),
    };
    await atomicWriteJson(stateFilePath, stateContent);
  }

  await updateStateFile("in_progress");

  async function processOneWallet(wallet: string, index: number, total: number) {
    const cpFile = path.join(cumulativeCheckpointDir, `${wallet}.json`);
    const tradeCpFile = path.join(tradeCheckpointDir, `${wallet}.json`);
    const poolAddresses = Array.from(walletToPoolsMap.get(wallet) || []).sort();

    // 1. Try reading existing cumulative checkpoint
    // If not refreshing: reuse any completed checkpoint.
    // If refreshing: only reuse if fetched in this refresh run (fetchedAt >= refreshCutoff).
    let isRetryEligible = false;
    let previousError: string | undefined;
    try {
      const raw = await fs.readFile(cpFile, "utf8");
      const cp: CumulativeWalletCheckpoint = JSON.parse(raw);
      const isFresh = Boolean(refreshCutoff && cp?.fetchedAt && cp.fetchedAt >= refreshCutoff);
      if (isValidCompletedCheckpoint(cp, selectionFingerprint, wallet) && (!refresh || isFresh)) {
        const aggs = Array.isArray(cp.aggregates) ? cp.aggregates : [];
        walletCumulativeMap.set(wallet, aggs);
        completedWallets++;
        if (aggs.length === 0) emptyWallets++;
        checkpointsReused++;
        totalAggregatesCount += aggs.length;
        console.log(
          `[W${index}/${total}] [CHECKPOINT REUSED] ${wallet} (${aggs.length} cumulative aggregates, status: ${cp.status}${cp.reason ? `, reason: ${cp.reason}` : ""})`
        );
        console.log(
          `[CUMULATIVE_HISTORY] PROGRESS completed=${completedWallets} total=${total} unavailable=${unavailableWallets} aggregates=${totalAggregatesCount}`
        );
        return;
      } else if (!refresh) {
        isRetryEligible = true;
        previousError = cp?.error || cp?.reason || cp?.status || "incomplete";
      }
    } catch {
      // no cumulative checkpoint file yet
    }
      if (isRetryEligible) {
        failedCheckpointsRetried++;
        console.log(
          `[W${index}/${total}] [RETRYING FAILED CHECKPOINT] ${wallet} (previous: ${previousError})`
        );
      }

    // Check if trade checkpoint already has valid cumulative data for this wallet (non-refresh only)
    if (!refresh) {
      try {
        const rawTrade = await fs.readFile(tradeCpFile, "utf8");
        const tradeCp: WalletCheckpoint = JSON.parse(rawTrade);
        if (
          tradeCp?.version === "v1" &&
          tradeCp?.selectionFingerprint === selectionFingerprint &&
          tradeCp?.wallet === wallet &&
          Array.isArray(tradeCp?.pools)
        ) {
          const foundAggs: FabriqPoolCumulativeAggregate[] = [];
          for (const p of tradeCp.pools) {
            if (p?.cumulative && p.cumulative.source === "Fabriq" && poolAddresses.includes(p.poolAddress)) {
              foundAggs.push(p.cumulative);
            }
          }
          if (foundAggs.length === poolAddresses.length) {
            walletCumulativeMap.set(wallet, foundAggs);
            completedWallets++;
            checkpointsReused++;
            totalAggregatesCount += foundAggs.length;

            const cpData: CumulativeWalletCheckpoint = {
              version: "v1",
              selectionFingerprint,
              wallet,
              status: "completed",
              reason: "success",
              aggregates: foundAggs,
              fetchedAt: new Date().toISOString(),
            };
            await atomicWriteJson(cpFile, cpData);

            console.log(
              `[W${index}/${total}] [TRADE CHECKPOINT REUSED] ${wallet} (${foundAggs.length} cumulative aggregates)`
            );
            console.log(
              `[CUMULATIVE_HISTORY] PROGRESS completed=${completedWallets} total=${total} unavailable=${unavailableWallets} aggregates=${totalAggregatesCount}`
            );
            return;
          }
        }
      } catch {
        // no trade checkpoint or incomplete cumulative
      }
    }

    // 2. Fetch cumulative metrics from Fabriq via /pnl-by-pool (supports server search)
    walletsActuallyFetched++;
    let aggregates: FabriqPoolCumulativeAggregate[] = [];
    let isUnavailable = false;
    let fetchError: string | undefined;
    let walletStats: CumulativeFetchStats | undefined;
    const walletStartMs = Date.now();

    const poolQueries = Array.from(
      new Set(
        poolAddresses.flatMap((addr) => extractPoolSearchQueries(poolToPairMap.get(addr)))
      )
    );

    try {
      console.log(
        `[W${index}/${total}] Fetching cumulative aggregates for ${wallet} (pools: ${poolAddresses.join(",")}, queries: ${poolQueries.join(",") || "none"})...`
      );
      aggregates = await fetchWalletPoolCumulativeAggregates(
        wallet,
        poolAddresses,
        {
          poolQueries,
          limiter,
          onStats: (st) => {
            walletStats = st;
            pagesFetchedTotal += st.pagesFetched;
          },
          onLog: (msg) => {
            console.log(`  [FABRIQ-CUM] ${msg}`);
          },
          onRetry: ({ status }) => {
            retriesCount++;
            if (status !== undefined && status >= 500) http500Count++;
            if (status === 429) http429Count++;
          },
        }
      );
    } catch (err: unknown) {
      isUnavailable = true;
      fetchError = err instanceof Error ? err.message : String(err);
      if (fetchError.includes("500") || fetchError.includes("Server error 5")) {
        http500Count++;
      }
      if (fetchError.includes("429") || fetchError.includes("RATE_LIMITED")) {
        http429Count++;
      }
      console.warn(`[W${index}/${total}] [UNAVAILABLE] ${wallet}: cumulative fetch skipped/failed: ${fetchError}`);
    }

    if (walletStats) {
      networkRequests += walletStats.totalHttpRequests;
      http500Count += walletStats.http500Count;
      http429Count += walletStats.http429Count;
      retriesCount += walletStats.retriesCount;
    } else if (!isUnavailable) {
      networkRequests++;
    }
    const matchedAggs: FabriqPoolCumulativeAggregate[] = [];
    const poolSet = new Set(poolAddresses);
    for (const agg of aggregates) {
      if (poolSet.has(agg.poolAddress)) {
        matchedAggs.push({
          ...agg,
          selectionFingerprint,
        });
      }
    }

    // Requirement 4: If Fabriq API failed, retain previous valid aggregates if available
    if (isUnavailable) {
      try {
        const rawExisting = await fs.readFile(cpFile, "utf8");
        const existingCp: CumulativeWalletCheckpoint = JSON.parse(rawExisting);
        if (Array.isArray(existingCp?.aggregates) && existingCp.aggregates.length > 0) {
          for (const a of existingCp.aggregates) {
            matchedAggs.push({
              ...a,
              selectionFingerprint,
              refreshFailed: true,
              refreshError: fetchError,
            });
          }
        }
      } catch {
        try {
          const rawTrade = await fs.readFile(tradeCpFile, "utf8");
          const tradeCp = JSON.parse(rawTrade);
          if (Array.isArray(tradeCp?.pools)) {
            for (const p of tradeCp.pools) {
              if (p.cumulative && poolAddresses.includes(p.poolAddress)) {
                matchedAggs.push({
                  ...p.cumulative,
                  selectionFingerprint,
                  refreshFailed: true,
                  refreshError: fetchError,
                });
              }
            }
          }
        } catch {}
      }
    }

    const checkpointReason: "success" | "not_found" | "http_error" = isUnavailable
      ? "http_error"
      : matchedAggs.length > 0
      ? "success"
      : "not_found";

    const checkpointData: CumulativeWalletCheckpoint = {
      version: "v1",
      selectionFingerprint,
      wallet,
      status: isUnavailable ? "unavailable" : "completed",
      reason: checkpointReason,
      aggregates: matchedAggs,
      fetchedAt: new Date().toISOString(),
      ...(fetchError ? { error: fetchError } : {}),
      ...(isUnavailable ? { refreshPending: true } : {}),
    };
    await atomicWriteJson(cpFile, checkpointData);
    walletCumulativeMap.set(wallet, matchedAggs);

    if (isUnavailable) {
      unavailableWallets++;
      httpErrorWallets++;
    } else if (matchedAggs.length === 0) {
      completedWallets++;
      emptyWallets++;
    } else {
      completedWallets++;
      totalAggregatesCount += matchedAggs.length;
    }

    // Also enrich trade checkpoint if present, preserving trades
    try {
      const rawTrade = await fs.readFile(tradeCpFile, "utf8");
      const tradeCp: WalletCheckpoint = JSON.parse(rawTrade);
      if (Array.isArray(tradeCp?.pools)) {
        let updated = false;
        for (const poolObj of tradeCp.pools) {
          const agg = matchedAggs.find((a) => a.poolAddress === poolObj.poolAddress);
          if (agg) {
            poolObj.cumulative = agg;
            updated = true;
          }
        }
        if (updated) {
          await atomicWriteJson(tradeCpFile, tradeCp);
        }
      }
    } catch {
      // trade checkpoint not present or failed to update; non-fatal
    }

    const walletDurationMs = Date.now() - walletStartMs;
    console.log(
      `[W${index}/${total}] [${isUnavailable ? "HTTP_ERROR" : "OK"}] ${wallet} (mode=${walletStats?.searchMode ?? "pagination"}, query=${poolQueries.join(",") || "none"}, targets=${poolAddresses.join(",")}, pages=${walletStats?.pagesFetched ?? 1}, reqs=${walletStats?.totalHttpRequests ?? (isUnavailable ? 0 : 1)}, 500=${walletStats?.http500Count ?? 0}, 429=${walletStats?.http429Count ?? 0}, retries=${walletStats?.retriesCount ?? 0}, concurrency=${limiter.getConcurrency()}, ${walletDurationMs}ms)`
    );
    console.log(
      `[CUMULATIVE_HISTORY] PROGRESS completed=${completedWallets} total=${total} unavailable=${unavailableWallets} aggregates=${totalAggregatesCount}`
    );
  }

  // Bounded worker concurrency pool
  let nextWalletIdx = 0;
  async function workerLoop() {
    while (true) {
      const idx = nextWalletIdx++;
      if (idx >= walletsToProcess.length) break;
      const wallet = walletsToProcess[idx];
      await processOneWallet(wallet, idx + 1, walletsToProcess.length);
      await updateStateFile("in_progress");
    }
  }

  const concurrency = Math.min(workers, walletsToProcess.length);
  const workerPromises = Array.from({ length: concurrency }, () => workerLoop());

  await Promise.all(workerPromises);
  await updateStateFile("completed");

  // Load existing cumulative history if present to avoid wiping prior snapshots
  const cumulativeOutputPath = path.join(selectedScanDir, "pool-cumulative-history.json");
  const cumulativeAggMap = new Map<string, FabriqPoolCumulativeAggregate>();

  try {
    const rawExisting = await fs.readFile(cumulativeOutputPath, "utf8");
    const parsed = JSON.parse(rawExisting);
    if (Array.isArray(parsed?.aggregates)) {
      for (const a of parsed.aggregates) {
        if (a?.poolAddress && a?.wallet) {
          cumulativeAggMap.set(`${a.poolAddress}::${a.wallet}`, a);
        }
      }
    }
  } catch {
    // no existing cumulative history
  }

  // Merge newly extracted aggregates
  for (const aggs of walletCumulativeMap.values()) {
    for (const a of aggs) {
      if (a?.poolAddress && a?.wallet) {
        cumulativeAggMap.set(`${a.poolAddress}::${a.wallet}`, {
          ...a,
          selectionFingerprint,
        });
      }
    }
  }

  const allAggregates = Array.from(cumulativeAggMap.values()).sort((a, b) => {
    const c = a.poolAddress.localeCompare(b.poolAddress);
    if (c !== 0) return c;
    return a.wallet.localeCompare(b.wallet);
  });

  const finalCumulativeOutput: PoolCumulativeHistoryOutput = {
    version: "v1",
    tokenMint: tokenCA,
    selectionFingerprint,
    generatedAt: new Date().toISOString(),
    runScope,
    isFullDataset: runScope === "full" && completedWallets === processedWalletCount,
    membershipWalletCount: walletToPoolsMap.size,
    processedWalletCount,
    poolCount: allPoolAddresses.length,
    aggregateCount: allAggregates.length,
    aggregates: allAggregates,
  };

  await atomicWriteJson(cumulativeOutputPath, finalCumulativeOutput);

  // Update pool-trade-history.json with official cumulative aggregates if it exists
  const tradeHistoryPath = path.join(selectedScanDir, "pool-trade-history.json");
  try {
    const rawTrade = await fs.readFile(tradeHistoryPath, "utf8");
    const tradeOutput: PoolTradeHistoryOutput = JSON.parse(rawTrade);
    if (Array.isArray(tradeOutput?.pools)) {
      let updatedTradeHistory = false;
      for (const poolEntry of tradeOutput.pools) {
        for (const w of poolEntry.wallets) {
          const match = cumulativeAggMap.get(`${poolEntry.poolAddress}::${w.wallet}`);
          if (match) {
            w.cumulative = match;
            updatedTradeHistory = true;
          }
        }
      }
      if (updatedTradeHistory) {
        await atomicWriteJson(tradeHistoryPath, tradeOutput);
      }
    }
  } catch {
    // pool-trade-history.json not present yet; non-fatal
  }

  const stageDurationSec = ((Date.now() - stageStartTimeMs) / 1000).toFixed(1);

  console.log(`\n======================================`);
  console.log(`EXTRACT POOL CUMULATIVE COMPLETE (STEP 3C-C)`);
  console.log(`======================================`);
  console.log(`Processed Wallets:     ${processedWalletCount}`);
  console.log(`Completed Wallets:     ${completedWallets}`);
  console.log(`Unavailable Wallets:   ${unavailableWallets}`);
  console.log(`Total Aggregates:      ${allAggregates.length}`);
  console.log(`Output:                ${cumulativeOutputPath}`);
  console.log(`======================================`);
  console.log(`\n--- Cumulative Performance Metrics ---`);
  console.log(`Duration:                    ${stageDurationSec}s`);
  console.log(`Completed Checkpoints Reused: ${checkpointsReused}`);
  console.log(`Failed Checkpoints Retried:  ${failedCheckpointsRetried}`);
  console.log(`Wallets Actually Fetched:    ${walletsActuallyFetched}`);
  console.log(`Remaining HTTP Errors:       ${httpErrorWallets}`);
  console.log(`Actual HTTP Requests:        ${networkRequests}`);
  console.log(`Pages Fetched:               ${pagesFetchedTotal}`);
  console.log(`Retries:                     ${retriesCount}`);
  console.log(`HTTP 500 Server Err:         ${http500Count}`);
  console.log(`HTTP 429 Rate Limits:        ${http429Count}`);
  console.log(`Completed Wallets:           ${completedWallets} (with aggregates: ${completedWallets - emptyWallets}, not found: ${emptyWallets})`);
  console.log(
    `[CUMULATIVE_HISTORY] COMPLETE totalWallets=${processedWalletCount} totalAggregates=${allAggregates.length}`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[CUMULATIVE_EXTRACTION FAILED]", err);
  process.exit(1);
});
