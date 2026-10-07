import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fabriqFetch } from "../discovery/core/fabriq-position-history.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

export interface NormalizedTrade {
  positionId: string;
  openedAt: string | null;
  closedAt: string | null;
  durationSeconds: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
}

export interface WalletTradeHistory {
  wallet: string;
  tradeCount: number;
  trades: NormalizedTrade[];
}

export type RunScope = "wallet" | "limit" | "full";

export interface PoolTradeHistoryEntry {
  poolAddress: string;
  membershipWalletCount: number;
  processedWalletCount: number;
  tradeCount: number;
  wallets: WalletTradeHistory[];
}

export interface PoolTradeHistoryOutput {
  version: "v1";
  tokenMint: string;
  selectionFingerprint: string;
  generatedAt: string;
  runScope: RunScope;
  isFullDataset: boolean;
  membershipWalletCount: number;
  processedWalletCount: number;
  requestedWallet: string | null;
  limit: number | null;
  poolCount: number;
  tradeCount: number;
  pools: PoolTradeHistoryEntry[];
}

export interface WalletCheckpoint {
  version: "v1";
  selectionFingerprint: string;
  wallet: string;
  status: "completed" | "error";
  pools: {
    poolAddress: string;
    trades: NormalizedTrade[];
  }[];
  fetchedAt: string;
  error?: string;
}

function parseSafeNumber(val: any): number | null {
  if (val === undefined || val === null || val === "") return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function parseSafeDate(val: any): { iso: string; ms: number } | null {
  if (val === undefined || val === null || val === "") return null;
  let d: Date;
  if (typeof val === "number") {
    const ms = val < 10_000_000_000 ? val * 1000 : val;
    d = new Date(ms);
  } else {
    const num = Number(val);
    if (!isNaN(num) && String(num) === String(val).trim()) {
      const ms = num < 10_000_000_000 ? num * 1000 : num;
      d = new Date(ms);
    } else {
      d = new Date(val);
    }
  }
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return { iso: d.toISOString(), ms };
}

function calculateDuration(
  openedAtMs: number | null,
  closedAtMs: number | null
): number | null {
  if (openedAtMs === null || closedAtMs === null) return null;
  const diffSec = (closedAtMs - openedAtMs) / 1000;
  if (!Number.isFinite(diffSec) || diffSec < 0) return null;
  return Number.isInteger(diffSec) ? diffSec : Math.round(diffSec);
}

function sortTrades(a: NormalizedTrade, b: NormalizedTrade): number {
  if (a.closedAt && b.closedAt) {
    if (a.closedAt !== b.closedAt) {
      return b.closedAt.localeCompare(a.closedAt);
    }
  } else if (a.closedAt && !b.closedAt) {
    return -1;
  } else if (!a.closedAt && b.closedAt) {
    return 1;
  }
  return a.positionId.localeCompare(b.positionId);
}

function normalizeTrade(pos: any): NormalizedTrade | null {
  const positionId =
    pos?.id !== undefined && pos?.id !== null ? String(pos.id).trim() : "";
  if (!positionId) return null;

  const openedDate = parseSafeDate(pos.opened_at);
  const closedDate = parseSafeDate(pos.latest_close_ts);

  // Closed positions only: must have valid closedAt
  if (!closedDate) return null;

  const openedAt = openedDate ? openedDate.iso : null;
  const closedAt = closedDate.iso;

  const durationSeconds = calculateDuration(
    openedDate?.ms ?? null,
    closedDate?.ms ?? null
  );

  const pnlUsd = parseSafeNumber(pos.total_pnl_usd);
  const pnlPct = parseSafeNumber(pos.total_pnl_pct_usd);

  return {
    positionId,
    openedAt,
    closedAt,
    durationSeconds,
    pnlUsd,
    pnlPct,
  };
}

async function atomicWriteJson(filePath: string, data: any): Promise<void> {
  const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let tokenCA: string | null = null;
  let targetWallet: string | null = null;
  let limit: number | null = null;
  let workers = 2;
  let refresh = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token" && args[i + 1]) {
      tokenCA = args[i + 1].trim();
      i++;
    } else if (arg === "--wallet" && args[i + 1]) {
      targetWallet = args[i + 1].trim();
      i++;
    } else if (arg === "--limit" && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        limit = parsed;
      }
      i++;
    } else if (arg === "--workers" && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        workers = Math.min(20, Math.max(1, parsed));
      }
      i++;
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
  let scanState: any;
  try {
    const raw = await fs.readFile(scanStatePath, "utf8");
    scanState = JSON.parse(raw);
  } catch {
    throw new Error(
      `scan-state.json not found in ${selectedScanDir}. Please complete Step 3B first.`
    );
  }

  if (scanState?.status !== "completed") {
    throw new Error(
      `Selected pool scan is not completed (current status: ${scanState?.status}). Please complete Step 3B first.`
    );
  }

  const selectionFingerprint = scanState?.selectionFingerprint;
  if (!selectionFingerprint || typeof selectionFingerprint !== "string") {
    throw new Error(
      `selectionFingerprint missing or invalid in scan-state.json.`
    );
  }

  const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
  let poolWalletsData: any;
  try {
    const raw = await fs.readFile(poolWalletsPath, "utf8");
    poolWalletsData = JSON.parse(raw);
  } catch {
    throw new Error(
      `pool-wallets.json not found in ${selectedScanDir}. Please complete Step 3B first.`
    );
  }

  const rawPools: any[] = Array.isArray(poolWalletsData?.pools)
    ? poolWalletsData.pools
    : [];
  if (rawPools.length === 0) {
    throw new Error(`No pools found in pool-wallets.json.`);
  }

  // Build wallet -> Set<poolAddress> mapping from authoritative pool-wallets.json
  const walletToPoolsMap = new Map<string, Set<string>>();
  const allPoolAddresses: string[] = [];

  for (const pool of rawPools) {
    const poolAddr = typeof pool?.poolAddress === "string" ? pool.poolAddress.trim() : "";
    if (!poolAddr) continue;
    allPoolAddresses.push(poolAddr);

    const walletsList = Array.isArray(pool?.wallets) ? pool.wallets : [];
    for (const item of walletsList) {
      const w = typeof item?.wallet === "string" ? item.wallet.trim() : "";
      if (!w) continue;
      if (!walletToPoolsMap.has(w)) {
        walletToPoolsMap.set(w, new Set());
      }
      walletToPoolsMap.get(w)!.add(poolAddr);
    }
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

  const checkpointDir = path.join(
    selectedScanDir,
    "trade-history-checkpoints",
    selectionFingerprint
  );
  await fs.mkdir(checkpointDir, { recursive: true });

  const stateFilePath = path.join(selectedScanDir, "trade-history-state.json");
  const startedAt = new Date().toISOString();

  let completedWallets = 0;
  let failedWallets = 0;
  let totalTradesCount = 0;

  const walletResults = new Map<string, WalletCheckpoint>();

  const runScope: RunScope = targetWallet
    ? "wallet"
    : limit !== null
    ? "limit"
    : "full";
  const requestedWallet: string | null = targetWallet ?? null;
  const limitValue: number | null = limit ?? null;
  const membershipWalletCount: number = walletToPoolsMap.size;
  const processedWalletCount: number = walletsToProcess.length;

  console.log(`\n======================================`);
  console.log(`BUILD POOL TRADE HISTORY (STEP 3C-B)`);
  console.log(`======================================`);
  console.log(`Token CA:              ${tokenCA}`);
  console.log(`Selection Fingerprint: ${selectionFingerprint}`);
  console.log(`Run Scope:             ${runScope}`);
  console.log(`Membership Wallets:    ${membershipWalletCount}`);
  console.log(`Processed Wallets:     ${processedWalletCount}`);
  console.log(`Associated Pools:      ${allPoolAddresses.length}`);
  console.log(`Workers:               ${workers}`);
  if (requestedWallet) console.log(`Requested Wallet:      ${requestedWallet}`);
  if (limitValue !== null) console.log(`Limit:                 ${limitValue}`);
  if (refresh) console.log(`Refresh Mode:          ENABLED (bypassing per-wallet checkpoints)`);
  console.log(`Checkpoints:           ${checkpointDir}`);
  console.log(`======================================\n`);

  async function updateStateFile(status: "in_progress" | "completed" | "error") {
    const now = new Date().toISOString();
    const stateContent = {
      version: "v1",
      tokenMint: tokenCA,
      selectionFingerprint,
      status,
      totalWallets: walletsToProcess.length,
      completedWallets,
      failedWallets,
      totalTrades: totalTradesCount,
      workers,
      startedAt,
      updatedAt: now,
      ...(status === "completed" ? { completedAt: now } : {}),
    };
    await atomicWriteJson(stateFilePath, stateContent);
  }

  await updateStateFile("in_progress");

  async function processOneWallet(wallet: string, index: number, total: number) {
    const checkpointFile = path.join(checkpointDir, `${wallet}.json`);
    const poolAddresses = Array.from(walletToPoolsMap.get(wallet) || []).sort();

    // 1. Try reading existing completed checkpoint (only if not refreshing)
    if (!refresh) {
      try {
        const raw = await fs.readFile(checkpointFile, "utf8");
        const cp: WalletCheckpoint = JSON.parse(raw);
        if (
          cp?.version === "v1" &&
          cp?.selectionFingerprint === selectionFingerprint &&
          cp?.wallet === wallet &&
          cp?.status === "completed" &&
          Array.isArray(cp?.pools)
        ) {
          walletResults.set(wallet, cp);
          completedWallets++;
          const tradesInCp = cp.pools.reduce((acc, p) => acc + (p.trades?.length || 0), 0);
          totalTradesCount += tradesInCp;
          console.log(
            `[W${index}/${total}] [CHECKPOINT] ${wallet} (${tradesInCp} trades in ${cp.pools.length} pools)`
          );
          console.log(
            `[TRADE_HISTORY] PROGRESS completed=${completedWallets} total=${total} failed=${failedWallets} trades=${totalTradesCount}`
          );
          return;
        }
      } catch {
        // no valid checkpoint yet, proceed to fetch
      }
    }

    // 2. Query Fabriq for this wallet scoped to associated pools
    const allowedPoolIds = new Set(poolAddresses);
    const poolTradesMap = new Map<string, Map<string, NormalizedTrade>>();
    for (const poolAddr of poolAddresses) {
      poolTradesMap.set(poolAddr, new Map());
    }

    const params = new URLSearchParams();
    params.set("poolIds", poolAddresses.join(","));
    params.append("sources", "wallet");
    params.append("sources", "hawkfi");
    params.set("timezone", "Asia/Jakarta");
    params.set("pnlCurrency", "USD");
    params.set("pnlScope", "pool");
    params.set("lastCloseScope", "pool");
    params.set("durationScope", "pool");
    params.set("depositsScope", "pool");
    params.set("withdrawalsScope", "pool");
    params.set("feesScope", "pool");

    try {
      console.log(
        `[W${index}/${total}] Fetching positions for ${wallet} (pools: ${poolAddresses.join(",")})...`
      );
      const resJson = await fabriqFetch<any>(
        `/history/${wallet}/positions-by-pool`,
        params,
        { onLog: (msg) => console.log(`  [FABRIQ] ${msg}`) }
      );

      const resData = resJson?.data ?? resJson;

      if (resData && typeof resData === "object" && !Array.isArray(resData)) {
        for (const [poolId, posList] of Object.entries(resData)) {
          if (!allowedPoolIds.has(poolId)) continue;
          if (Array.isArray(posList)) {
            const mapForPool = poolTradesMap.get(poolId)!;
            for (const pos of posList) {
              const trade = normalizeTrade(pos);
              if (trade && !mapForPool.has(trade.positionId)) {
                mapForPool.set(trade.positionId, trade);
              }
            }
          }
        }
      } else if (Array.isArray(resData)) {
        for (const pos of resData) {
          const poolId = String(
            pos.pool_id || pos.poolId || pos.pool?.id || pos.pool?.address || ""
          );
          if (!allowedPoolIds.has(poolId)) continue;
          const mapForPool = poolTradesMap.get(poolId);
          if (mapForPool) {
            const trade = normalizeTrade(pos);
            if (trade && !mapForPool.has(trade.positionId)) {
              mapForPool.set(trade.positionId, trade);
            }
          }
        }
      }

      const poolsData = poolAddresses.map((poolAddress) => {
        const trades = Array.from(
          poolTradesMap.get(poolAddress)?.values() || []
        ).sort(sortTrades);
        return {
          poolAddress,
          trades,
        };
      });

      const walletTradesCount = poolsData.reduce((acc, p) => acc + p.trades.length, 0);

      const checkpointData: WalletCheckpoint = {
        version: "v1",
        selectionFingerprint,
        wallet,
        status: "completed",
        pools: poolsData,
        fetchedAt: new Date().toISOString(),
      };

      await atomicWriteJson(checkpointFile, checkpointData);
      walletResults.set(wallet, checkpointData);

      completedWallets++;
      totalTradesCount += walletTradesCount;

      console.log(
        `[W${index}/${total}] [OK] ${wallet}: ${walletTradesCount} closed positions extracted across ${poolAddresses.length} pool(s).`
      );
      console.log(
        `[TRADE_HISTORY] PROGRESS completed=${completedWallets} total=${total} failed=${failedWallets} trades=${totalTradesCount}`
      );
    } catch (err: any) {
      failedWallets++;
      const errMsg = err?.message || String(err);
      console.error(`[W${index}/${total}] [FAIL] ${wallet}: ${errMsg}`);
      console.log(
        `[TRADE_HISTORY] PROGRESS completed=${completedWallets} total=${total} failed=${failedWallets} trades=${totalTradesCount}`
      );
    }
  }

  // Bounded concurrency pool
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

  try {
    await Promise.all(workerPromises);
  } catch (err) {
    await updateStateFile("error");
    throw err;
  }

  const finalStatus = failedWallets > 0 && completedWallets === 0 ? "error" : "completed";
  await updateStateFile(finalStatus);

  // Build final pool-centric output: selected-scan/pool-trade-history.json
  const finalPoolEntries: PoolTradeHistoryEntry[] = [];
  const uniquePools = rawPools.map((p) => String(p.poolAddress).trim()).sort();
  const runWalletsSet = new Set(walletsToProcess);

  for (const poolAddress of uniquePools) {
    const rawPool = rawPools.find((p) => p.poolAddress === poolAddress);
    const membershipWallets = Array.isArray(rawPool?.wallets)
      ? rawPool.wallets.map((w: any) => String(w.wallet).trim()).filter(Boolean)
      : [];

    const targetMembershipWallets = membershipWallets
      .filter((w: string) => runWalletsSet.has(w))
      .sort();

    const walletsList: WalletTradeHistory[] = [];
    let poolTradesCount = 0;

    for (const wallet of targetMembershipWallets) {
      let cp = walletResults.get(wallet);
      if (!cp) {
        try {
          const checkpointFile = path.join(checkpointDir, `${wallet}.json`);
          const raw = await fs.readFile(checkpointFile, "utf8");
          const parsed = JSON.parse(raw);
          if (
            parsed?.version === "v1" &&
            parsed?.selectionFingerprint === selectionFingerprint &&
            parsed?.wallet === wallet &&
            parsed?.status === "completed"
          ) {
            cp = parsed;
            walletResults.set(wallet, cp);
          }
        } catch {
          // not found or not completed
        }
      }

      const poolObj = cp?.pools?.find((p) => p.poolAddress === poolAddress);
      const trades = poolObj?.trades || [];
      poolTradesCount += trades.length;

      walletsList.push({
        wallet,
        tradeCount: trades.length,
        trades,
      });
    }

    finalPoolEntries.push({
      poolAddress,
      membershipWalletCount: membershipWallets.length,
      processedWalletCount: targetMembershipWallets.length,
      tradeCount: poolTradesCount,
      wallets: walletsList,
    });
  }

  const isFullDataset: boolean =
    runScope === "full" &&
    processedWalletCount === membershipWalletCount &&
    completedWallets === membershipWalletCount &&
    failedWallets === 0;

  const finalOutput: PoolTradeHistoryOutput = {
    version: "v1",
    tokenMint: tokenCA,
    selectionFingerprint,
    generatedAt: new Date().toISOString(),
    runScope,
    isFullDataset,
    membershipWalletCount,
    processedWalletCount,
    requestedWallet,
    limit: limitValue,
    poolCount: finalPoolEntries.length,
    tradeCount: finalPoolEntries.reduce((sum, p) => sum + p.tradeCount, 0),
    pools: finalPoolEntries,
  };

  const finalOutputPath = path.join(selectedScanDir, "pool-trade-history.json");
  await atomicWriteJson(finalOutputPath, finalOutput);

  console.log(`\n======================================`);
  console.log(`POOL TRADE HISTORY COMPLETE (STEP 3C-B)`);
  console.log(`======================================`);
  console.log(`Run Scope:             ${runScope}`);
  console.log(`Is Full Dataset:       ${isFullDataset}`);
  console.log(`Membership Wallets:    ${membershipWalletCount}`);
  console.log(`Processed Wallets:     ${processedWalletCount}`);
  console.log(`Total Pools:           ${finalPoolEntries.length}`);
  console.log(`Total Trades:          ${finalOutput.tradeCount}`);
  console.log(`Output:                ${finalOutputPath}`);
  console.log(`======================================`);
  console.log(
    `[TRADE_HISTORY] COMPLETE totalWallets=${walletsToProcess.length} totalTrades=${finalOutput.tradeCount}`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[TRADE_HISTORY FAILED]", err);
  process.exit(1);
});
