import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fabriqFetch } from "../discovery/core/fabriq-position-history.ts";
import {
  fetchWalletPoolCumulativeAggregates,
  type FabriqPoolCumulativeAggregate,
} from "../analytics/fabriq-analytics-client.ts";

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
  cumulative?: FabriqPoolCumulativeAggregate | null;
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
    cumulative?: FabriqPoolCumulativeAggregate | null;
  }[];
  fetchedAt: string;
  error?: string;
}

export interface PoolCumulativeHistoryOutput {
  version: "v1";
  tokenMint: string;
  selectionFingerprint: string;
  generatedAt: string;
  runScope: RunScope;
  isFullDataset: boolean;
  membershipWalletCount: number;
  processedWalletCount: number;
  poolCount: number;
  aggregateCount: number;
  aggregates: FabriqPoolCumulativeAggregate[];
}

interface RawPoolWallet {
  wallet: string;
  pnlUsd?: number | null;
  winRate?: number | null;
  positions?: number | null;
}

interface RawPoolEntry {
  poolAddress: string;
  pair?: string;
  binStep?: number | null;
  baseFeePct?: number | null;
  wallets?: RawPoolWallet[];
}

interface CanonicalPoolRecord {
  poolAddress: string;
  tokenMint?: string;
  pair?: string;
  binStep?: number | null;
  baseFeePct?: number | null;
  selectionFingerprint?: string;
}

interface CanonicalMembershipRecord {
  poolAddress: string;
  wallet: string;
  pnlUsd?: number | null;
  winRate?: number | null;
  positions?: number | null;
  isLatestSnapshot?: boolean;
}

function parseSafeNumber(val: unknown): number | null {
  if (val === undefined || val === null || val === "") return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function parseSafeDate(val: unknown): { iso: string; ms: number } | null {
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
      d = new Date(val as string | number);
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

function normalizeTrade(rawPos: unknown): NormalizedTrade | null {
  const pos = rawPos && typeof rawPos === "object" ? (rawPos as Record<string, unknown>) : null;
  const positionId =
    pos?.id !== undefined && pos?.id !== null ? String(pos.id).trim() : "";
  if (!positionId) return null;

  const openedDate = parseSafeDate(pos!.opened_at);
  const closedDate = parseSafeDate(pos!.latest_close_ts);

  // Closed positions only: must have valid closedAt
  if (!closedDate) return null;

  const openedAt = openedDate ? openedDate.iso : null;
  const closedAt = closedDate.iso;

  const durationSeconds = calculateDuration(
    openedDate?.ms ?? null,
    closedDate?.ms ?? null
  );

  const pnlUsd = parseSafeNumber(pos!.total_pnl_usd);
  const pnlPct = parseSafeNumber(pos!.total_pnl_pct_usd);

  return {
    positionId,
    openedAt,
    closedAt,
    durationSeconds,
    pnlUsd,
    pnlPct,
  };
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let tokenCA: string | null = null;
  let targetPool: string | null = null;
  let targetWallet: string | null = null;
  let limit: number | null = null;
  let workers = 2;
  let refresh = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token" && args[i + 1]) {
      tokenCA = args[i + 1].trim();
      i++;
    } else if (arg === "--pool" && args[i + 1]) {
      targetPool = args[i + 1].trim();
      i++;
    } else if (arg.startsWith("--pool=")) {
      targetPool = arg.slice("--pool=".length).trim();
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

  return { tokenCA, targetPool, targetWallet, limit, workers, refresh };
}

async function main() {
  const { tokenCA, targetPool, targetWallet, limit, workers, refresh } = parseCliArgs();

  if (!tokenCA) {
    throw new Error("Token CA is required. Use --token <TOKEN_CA>");
  }

  const selectedScanDir = path.resolve(
    ROOT,
    "data/discovery/pool-scanner",
    tokenCA,
    "selected-scan"
  );
  let selectionFingerprint = "";
  let rawPools: RawPoolEntry[] = [];

  const scanStatePath = path.join(selectedScanDir, "scan-state.json");
  const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
  let hasSelectedScan = false;

  try {
    const rawState = await fs.readFile(scanStatePath, "utf8");
    const scanState = JSON.parse(rawState);
    if (scanState?.selectionFingerprint && scanState?.status === "completed") {
      selectionFingerprint = scanState.selectionFingerprint;
      const rawPw = await fs.readFile(poolWalletsPath, "utf8");
      const pwData = JSON.parse(rawPw);
      if (Array.isArray(pwData?.pools)) {
        rawPools = pwData.pools as RawPoolEntry[];
        hasSelectedScan = true;
      }
    }
  } catch {
    // selected-scan artifacts missing or incomplete
  }

  if (targetPool && hasSelectedScan) {
    const matched = rawPools.filter((p) => p?.poolAddress === targetPool);
    if (matched.length > 0) {
      rawPools = matched;
    } else {
      hasSelectedScan = false;
    }
  }

  // Existing Pool Fast Path: if targetPool is specified and not in selected-scan, load from canonical master
  if (targetPool && (!hasSelectedScan || rawPools.length === 0)) {
    const scannedPoolsPath = path.resolve(ROOT, "data/master/scanned-pools.json");
    const membershipPath = path.resolve(ROOT, "data/master/pool-wallet-membership.json");

    let canonicalPool: CanonicalPoolRecord | null = null;
    try {
      const rawSp = await fs.readFile(scannedPoolsPath, "utf8");
      const spData = JSON.parse(rawSp) as { pools?: CanonicalPoolRecord[] };
      canonicalPool = (spData?.pools || []).find((p) => p?.poolAddress === targetPool) || null;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read canonical pools: ${errMsg}`);
    }

    if (!canonicalPool) {
      throw new Error(
        `Pool ${targetPool} not found in selected-scan or canonical scanned-pools.json. Please run minimal LP Wallet Extraction first.`
      );
    }

    let memberships: CanonicalMembershipRecord[] = [];
    try {
      const rawM = await fs.readFile(membershipPath, "utf8");
      const mData = JSON.parse(rawM) as { memberships?: CanonicalMembershipRecord[] };
      memberships = (mData?.memberships || []).filter(
        (m) => m?.poolAddress === targetPool && m?.isLatestSnapshot !== false
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read canonical pool memberships: ${errMsg}`);
    }

    if (memberships.length === 0) {
      throw new Error(
        `No valid wallet membership found for pool ${targetPool}. Please run minimal LP Wallet Extraction first.`
      );
    }

    selectionFingerprint =
      canonicalPool.selectionFingerprint ||
      `canonical_${targetPool.slice(0, 16)}`;

    rawPools = [
      {
        poolAddress: targetPool,
        pair: canonicalPool.pair || "",
        binStep: canonicalPool.binStep ?? null,
        baseFeePct: canonicalPool.baseFeePct ?? null,
        wallets: memberships.map((m) => ({
          wallet: m.wallet,
          pnlUsd: m.pnlUsd,
          winRate: m.winRate,
          positions: m.positions,
        })),
      },
    ];

    await fs.mkdir(selectedScanDir, { recursive: true });
    const selectionPath = path.join(selectedScanDir, "selection.json");
    try {
      await fs.access(selectionPath);
    } catch {
      await atomicWriteJson(selectionPath, {
        version: "v1",
        tokenMint: tokenCA,
        selectionFingerprint,
        createdAt: new Date().toISOString(),
        selectedPoolCount: 1,
        pools: [
          {
            poolAddress: targetPool,
            pair: canonicalPool.pair || "",
            binStep: canonicalPool.binStep ?? 0,
            baseFeePct: canonicalPool.baseFeePct ?? 0,
          },
        ],
      });
    }

    try {
      await fs.access(scanStatePath);
    } catch {
      await atomicWriteJson(scanStatePath, {
        version: "v1",
        tokenMint: tokenCA,
        selectionFingerprint,
        status: "completed",
        selectedPoolCount: 1,
        completedPoolCount: 1,
        pendingPoolCount: 0,
        selectedPoolAddresses: [targetPool],
        completedPoolAddresses: [targetPool],
        completedAt: new Date().toISOString(),
      });
    }

    try {
      await fs.access(poolWalletsPath);
    } catch {
      await atomicWriteJson(poolWalletsPath, {
        version: "v1",
        tokenMint: tokenCA,
        updatedAt: new Date().toISOString(),
        pools: rawPools,
      });
    }
  }

  if (!selectionFingerprint) {
    throw new Error(`selectionFingerprint missing or invalid in scan-state.json.`);
  }
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
  let checkpointsReused = 0;
  let networkRequests = 0;
  let retriesCount = 0;
  let http500Count = 0;
  let http429Count = 0;
  const stageStartTimeMs = Date.now();

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

  let previousState: Record<string, unknown> | null = null;
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
      failedWallets,
      totalTrades: totalTradesCount,
      workers,
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
    const checkpointFile = path.join(checkpointDir, `${wallet}.json`);
    const poolAddresses = Array.from(walletToPoolsMap.get(wallet) || []).sort();

    // 1. Try reading existing completed checkpoint
    // If not refreshing: reuse any completed checkpoint.
    // If refreshing: only reuse checkpoint if it was fetched in this refresh run (fetchedAt >= refreshCutoff).
    try {
      const raw = await fs.readFile(checkpointFile, "utf8");
      const cp: WalletCheckpoint = JSON.parse(raw);
      const isFresh = Boolean(refreshCutoff && cp?.fetchedAt && cp.fetchedAt >= refreshCutoff);
      const hasTargetPool = !targetPool || cp?.pools?.some((p) => p.poolAddress === targetPool);
      const canReuse =
        cp?.version === "v1" &&
        cp?.selectionFingerprint === selectionFingerprint &&
        cp?.wallet === wallet &&
        cp?.status === "completed" &&
        Array.isArray(cp?.pools) &&
        hasTargetPool &&
        (!refresh || isFresh);

      if (canReuse) {
        walletResults.set(wallet, cp);
        completedWallets++;
        checkpointsReused++;
        const tradesInCp = cp.pools.reduce((acc, p) => acc + (p.trades?.length || 0), 0);
        totalTradesCount += tradesInCp;
        console.log(
          `[W${index}/${total}] [CHECKPOINT REUSED] ${wallet} (${tradesInCp} trades in ${cp.pools.length} pools)`
        );
        console.log(
          `[TRADE_HISTORY] PROGRESS completed=${completedWallets} total=${total} failed=${failedWallets} trades=${totalTradesCount}`
        );
        return;
      }
    } catch {
      // no valid checkpoint yet, proceed to fetch
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
      networkRequests++;
      const resJson = await fabriqFetch<unknown>(
        `/history/${wallet}/positions-by-pool`,
        params,
        {
          onLog: (msg) => {
            if (msg.includes("500") || msg.includes("Server error 5")) http500Count++;
            if (msg.includes("429") || msg.includes("RATE_LIMITED")) http429Count++;
            console.log(`  [FABRIQ] ${msg}`);
          },
          onRetry: ({ status }: { status?: number }) => {
            retriesCount++;
            if (status !== undefined && status >= 500) http500Count++;
            if (status === 429) http429Count++;
          },
        }
      );

      // Preserve existing cumulative aggregate from previous checkpoint if available
      const existingCumulativeMap = new Map<string, FabriqPoolCumulativeAggregate>();
      try {
        const rawExisting = await fs.readFile(checkpointFile, "utf8");
        const parsedExisting = JSON.parse(rawExisting);
        if (Array.isArray(parsedExisting?.pools)) {
          for (const p of parsedExisting.pools) {
            if (p?.poolAddress && p?.cumulative) {
              existingCumulativeMap.set(p.poolAddress, p.cumulative);
            }
          }
        }
      } catch {
        // no existing checkpoint to preserve cumulative from
      }

      let resData: unknown = resJson;
      if (resJson && typeof resJson === "object" && "data" in resJson) {
        resData = resJson.data;
      }

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
          const posObj = pos && typeof pos === "object" ? (pos as Record<string, unknown>) : null;
          const poolObj = posObj?.pool && typeof posObj.pool === "object" ? (posObj.pool as Record<string, unknown>) : null;
          const poolId = String(
            posObj?.pool_id || posObj?.poolId || poolObj?.id || poolObj?.address || ""
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
        const cumulative = existingCumulativeMap.get(poolAddress) ?? null;
        return {
          poolAddress,
          trades,
          cumulative,
        };
      });

      const walletTradesCount = poolsData.reduce((acc, p) => acc + p.trades.length, 0);

      // Preserve existing pools from previous checkpoint if available so other pool data is not lost
      const existingPoolsMap = new Map<string, { poolAddress: string; trades: NormalizedTrade[]; cumulative?: FabriqPoolCumulativeAggregate | null }>();
      try {
        const rawExisting = await fs.readFile(checkpointFile, "utf8");
        const parsedExisting = JSON.parse(rawExisting) as WalletCheckpoint;
        if (Array.isArray(parsedExisting?.pools)) {
          for (const p of parsedExisting.pools) {
            if (p?.poolAddress) existingPoolsMap.set(p.poolAddress, p);
          }
        }
      } catch {
        // no existing checkpoint to preserve
      }
      for (const p of poolsData) {
        existingPoolsMap.set(p.poolAddress, p);
      }

      const checkpointData: WalletCheckpoint = {
        version: "v1",
        selectionFingerprint,
        wallet,
        status: "completed",
        pools: Array.from(existingPoolsMap.values()),
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
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      failedWallets++;
      const errMsg = err instanceof Error ? err.message : String(err);
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
      ? rawPool.wallets.map((w) => String(w.wallet).trim()).filter(Boolean)
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
            cp = parsed as WalletCheckpoint;
          }
        } catch {
          // not found or not completed
        }
      }

      const poolObj = cp?.pools?.find((p) => p.poolAddress === poolAddress);
      const trades = poolObj?.trades || [];
      const cumulative = poolObj?.cumulative ?? null;
      poolTradesCount += trades.length;

      walletsList.push({
        wallet,
        tradeCount: trades.length,
        trades,
        cumulative,
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
  if (targetPool) {
    try {
      const rawExisting = await fs.readFile(finalOutputPath, "utf8");
      const parsedExisting = JSON.parse(rawExisting) as PoolTradeHistoryOutput;
      if (Array.isArray(parsedExisting?.pools)) {
        for (const ep of parsedExisting.pools) {
          if (ep?.poolAddress && ep.poolAddress !== targetPool && !finalPoolEntries.some((p) => p.poolAddress === ep.poolAddress)) {
            finalPoolEntries.push(ep);
          }
        }
      }
    } catch {
      // no existing output to merge
    }
  }

  await atomicWriteJson(finalOutputPath, finalOutput);

  if (!targetPool) {
    // Preserve existing cumulative aggregates from previous file or checkpoints (Full Scan mode only)
    const cumulativeMap = new Map<string, FabriqPoolCumulativeAggregate>();
    const cumulativeOutputPath = path.join(selectedScanDir, "pool-cumulative-history.json");
    try {
      const rawExisting = await fs.readFile(cumulativeOutputPath, "utf8");
      const parsedExisting = JSON.parse(rawExisting) as PoolCumulativeHistoryOutput;
      if (Array.isArray(parsedExisting?.aggregates)) {
        for (const a of parsedExisting.aggregates) {
          if (a?.poolAddress && a?.wallet) {
            cumulativeMap.set(`${a.poolAddress}::${a.wallet}`, a);
          }
        }
      }
    } catch {
      // no existing cumulative history file
    }

    for (const poolEntry of finalPoolEntries) {
      for (const w of poolEntry.wallets) {
        if (w.cumulative) {
          cumulativeMap.set(`${w.cumulative.poolAddress}::${w.cumulative.wallet}`, {
            ...w.cumulative,
            selectionFingerprint,
          });
        }
      }
    }

    const allAggregates = Array.from(cumulativeMap.values());
    const finalCumulativeOutput: PoolCumulativeHistoryOutput = {
      version: "v1",
      tokenMint: tokenCA,
      selectionFingerprint,
      generatedAt: new Date().toISOString(),
      runScope,
      isFullDataset,
      membershipWalletCount,
      processedWalletCount,
      poolCount: finalPoolEntries.length,
      aggregateCount: allAggregates.length,
      aggregates: allAggregates,
    };

    if (allAggregates.length > 0) {
      await atomicWriteJson(cumulativeOutputPath, finalCumulativeOutput);
    }
  }

  const stageDurationSec = ((Date.now() - stageStartTimeMs) / 1000).toFixed(1);
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

  console.log(`\n--- Trade History Performance Metrics ---`);
  console.log(`Duration:              ${stageDurationSec}s`);
  console.log(`Checkpoints Reused:    ${checkpointsReused}`);
  console.log(`Network Requests:      ${networkRequests}`);
  console.log(`Retries:               ${retriesCount}`);
  console.log(`HTTP 500 Server Err:   ${http500Count}`);
  console.log(`HTTP 429 Rate Limits:  ${http429Count}`);
  console.log(`-----------------------------------------\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[TRADE_HISTORY FAILED]", err);
  process.exit(1);
});
