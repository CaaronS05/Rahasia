import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeFabriqConnection,
  fabriqFetch,
  isFabriqDlmmPool,
} from "../discovery/core/fabriq-position-history.ts";
import { computeDailyRisk, computePositionRisk } from "./build-wallet-risk-metrics.ts";

// ======================================================
// DOMAIN INTERFACES
// ======================================================

export type WalletStyleV1 = "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";

export interface SingleWalletPerformance {
  totalPnl: number;
  profitFactor: number;
  medianPositionPnlPct: number;
  positionWinRate: number;
  closedPositionCount: number;
  pnlConcentrationTop1: number;
}

export interface SingleWalletShortlistReasons {
  qualityPass: boolean;
  riskPass: boolean;
  confidencePass: boolean;
  profitabilityGuardrailsPass: boolean;
}

export interface SingleWalletAnalysisResult {
  wallet: string;
  analyzedAt: string;
  referenceCohort: {
    version: "v1";
    generatedAt: string;
    validWallets: number;
    qualityThresholdP75: number;
    riskThresholdP25: number;
  };
  qualityScore: number;
  riskScore: number;
  confidenceScore: number;
  style: WalletStyleV1;
  shortlisted: boolean;
  performance: SingleWalletPerformance;
  shortlistReasons: SingleWalletShortlistReasons;
  rawMetrics: {
    medianPositionPnlPct: number;
    profitFactor: number;
    positionWinRate: number;
    pnlConcentrationTop1: number;
    cvar10PositionPnlPct: number;
    negativeDayRate: number;
    medianLosingPositionPnlPct: number;
    closedPositionCount: number;
    totalPnl: number;
    historySpanDays: number;
  };
  components: {
    quality: {
      medianPositionPnlPctPercentile: number;
      profitFactorPercentile: number;
      positionWinRatePercentile: number;
      inverseConcentrationPercentile: number;
    };
    risk: {
      cvar10RiskPercentile: number;
      negativeDayRateRiskPercentile: number;
      medianLosingPnlRiskPercentile: number;
    };
    confidence: {
      positionSampleScore: number;
      historySpanScore: number;
    };
  };
}

interface ReferenceQualityData {
  generatedAt: string;
  version: string;
  population: { wallets: number };
  wallets: Array<{
    wallet: string;
    qualityScore: number;
    raw: {
      medianPositionPnlPct: number;
      profitFactor: number;
      positionWinRate: number;
      pnlConcentrationTop1: number;
    };
  }>;
}

interface ReferenceRiskData {
  generatedAt: string;
  version: string;
  population: { wallets: number };
  wallets: Array<{
    wallet: string;
    riskScore: number;
    raw: {
      cvar10PositionPnlPct: number;
      negativeDayRate: number;
      medianLosingPositionPnlPct: number;
    };
  }>;
}

interface ReferenceShortlistData {
  generatedAt: string;
  version: string;
  rule: {
    qualityMinimum: number;
    riskMaximum: number;
    confidenceMinimum: number;
  };
}

interface ReferenceCohortDistributions {
  quality: {
    medianPnl: number[];
    profitFactor: number[];
    winRate: number[];
    concentration: number[];
  };
  risk: {
    cvar10: number[];
    negativeDayRate: number[];
    medianLosingPnl: number[];
  };
  thresholds: {
    qualityMinimum: number;
    riskMaximum: number;
    confidenceMinimum: number;
  };
  meta: {
    version: "v1";
    generatedAt: string;
    validWallets: number;
  };
}

// ======================================================
// CONSTANTS & PATHS
// ======================================================

const V1_DIR = path.resolve("data/v1");
const SINGLE_WALLET_DIR = path.join(V1_DIR, "single-wallet");
const CHECKPOINT_DIR = path.join(V1_DIR, "checkpoints");

const QUALITY_FILE = path.join(V1_DIR, "wallet-quality-scores.json");
const RISK_FILE = path.join(V1_DIR, "wallet-risk-scores.json");
const SHORTLIST_FILE = path.join(V1_DIR, "wallet-shortlist.json");

// ======================================================
// HELPERS
// ======================================================

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

function parseTimestampMs(ts: unknown): number | null {
  if (ts === null || ts === undefined || ts === "") return null;
  if (typeof ts === "number") {
    return ts > 1e11 ? ts : ts * 1000;
  }
  const str = String(ts).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    return num > 1e11 ? num : num * 1000;
  }
  const isoStr = str.includes("T") ? str : str.replace(" ", "T") + (str.endsWith("Z") ? "" : "Z");
  const parsed = Date.parse(isoStr);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeMedian(arr: number[]): number | null {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return Number(sorted[mid].toFixed(4));
  }
  return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}

function extractObjectField(container: unknown, key: string): unknown {
  if (container && typeof container === "object" && key in container) {
    const record = container as Record<string, unknown>;
    return record[key];
  }
  return undefined;
}

/**
 * Mid-rank percentile calculation against sorted reference cohort.
 */
function calcPercentile(
  sortedCohort: number[],
  value: number,
  direction: "higher_is_better" | "lower_is_better" | "higher_is_riskier" | "lower_is_riskier"
): number {
  const N = sortedCohort.length;
  if (N === 0) return 50;
  if (N === 1) return 100;

  let lower = 0;
  let equal = 0;
  for (const v of sortedCohort) {
    if (v < value - 1e-12) lower++;
    else if (Math.abs(v - value) <= 1e-12) equal++;
  }

  const avgRank = lower + (equal > 0 ? (equal + 1) / 2 : 1);
  const p0To1 = Math.max(0, Math.min(1, (avgRank - 1) / (N - 1)));

  let p100 = 0;
  if (direction === "higher_is_better" || direction === "higher_is_riskier") {
    p100 = p0To1 * 100;
  } else {
    // lower_is_better or lower_is_riskier
    p100 = (1 - p0To1) * 100;
  }

  return Number(Math.max(0, Math.min(100, p100)).toFixed(4));
}

// ======================================================
// REFERENCE COHORT LOADER
// ======================================================

let cachedReferenceCohort: ReferenceCohortDistributions | null = null;
let cachedReferenceMtimeMs = 0;

export async function loadReferenceCohort(): Promise<ReferenceCohortDistributions> {
  const [qualityStat, riskStat, shortlistStat] = await Promise.all([
    stat(QUALITY_FILE).catch(() => null),
    stat(RISK_FILE).catch(() => null),
    stat(SHORTLIST_FILE).catch(() => null),
  ]);

  if (!qualityStat || !riskStat || !shortlistStat) {
    throw new Error(
      "REFERENCE_REQUIRED: Compatible V1 reference cohort artifacts not found. Please ensure initial Wallet Intelligence screening is completed."
    );
  }

  const latestMtime = Math.max(qualityStat.mtimeMs, riskStat.mtimeMs, shortlistStat.mtimeMs);
  if (cachedReferenceCohort && cachedReferenceMtimeMs >= latestMtime) {
    return cachedReferenceCohort;
  }

  const [rawQuality, rawRisk, rawShortlist] = await Promise.all([
    readFile(QUALITY_FILE, "utf8"),
    readFile(RISK_FILE, "utf8"),
    readFile(SHORTLIST_FILE, "utf8"),
  ]);

  const qualityData = JSON.parse(rawQuality) as ReferenceQualityData;
  const riskData = JSON.parse(rawRisk) as ReferenceRiskData;
  const shortlistData = JSON.parse(rawShortlist) as ReferenceShortlistData;

  if (
    !Array.isArray(qualityData.wallets) ||
    !Array.isArray(riskData.wallets) ||
    qualityData.wallets.length === 0
  ) {
    throw new Error("REFERENCE_REQUIRED: Reference cohort data is empty or invalid.");
  }

  const distributions: ReferenceCohortDistributions = {
    quality: {
      medianPnl: qualityData.wallets.map((w) => w.raw.medianPositionPnlPct).sort((a, b) => a - b),
      profitFactor: qualityData.wallets.map((w) => w.raw.profitFactor).sort((a, b) => a - b),
      winRate: qualityData.wallets.map((w) => w.raw.positionWinRate).sort((a, b) => a - b),
      concentration: qualityData.wallets.map((w) => w.raw.pnlConcentrationTop1).sort((a, b) => a - b),
    },
    risk: {
      cvar10: riskData.wallets.map((w) => w.raw.cvar10PositionPnlPct).sort((a, b) => a - b),
      negativeDayRate: riskData.wallets.map((w) => w.raw.negativeDayRate).sort((a, b) => a - b),
      medianLosingPnl: riskData.wallets.map((w) => w.raw.medianLosingPositionPnlPct).sort((a, b) => a - b),
    },
    thresholds: {
      qualityMinimum: shortlistData.rule?.qualityMinimum ?? 62.5,
      riskMaximum: shortlistData.rule?.riskMaximum ?? 32.16,
      confidenceMinimum: shortlistData.rule?.confidenceMinimum ?? 80,
    },
    meta: {
      version: "v1",
      generatedAt: qualityData.generatedAt,
      validWallets: qualityData.population.wallets,
    },
  };

  cachedReferenceCohort = distributions;
  cachedReferenceMtimeMs = latestMtime;
  return distributions;
}

// ======================================================
// SINGLE WALLET DATA FETCHING (FABRIQ API)
// ======================================================

interface ClosedPositionItem {
  wallet: string;
  positionId: string;
  pool: string;
  openedAt: string | null;
  closedAt: string | null;
  holdDuration: number | null;
  holdDurationHours: number | null;
  deposit: number;
  withdrawal: number;
  claimedFees: number;
  pnl: number;
  pnlPct: number | null;
  winLoss: "WIN" | "LOSS" | "BREAKEVEN";
}

interface DailyRecordItem {
  date: string;
  pnlUsd: number;
  feesUsd?: number;
  positions?: number;
  winRateUsd?: number | null;
  feeWinRateUsd?: number | null;
}

async function fetchSingleWalletFabriqData(
  wallet: string,
  historyDays = 30,
  maxClosedPositions = 300
): Promise<{
  positions: ClosedPositionItem[];
  daily: DailyRecordItem[];
  valid: boolean;
  reason: string | null;
}> {
  const cutoffMs = Date.now() - historyDays * 24 * 60 * 60 * 1000;

  // 1. Fetch DLMM pools
  let page = 1;
  let poolsRetries = 0;
  const allDlmmPoolIds = new Set<string>();

  while (true) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", "100");
    params.set("sources", "wallet");
    params.append("sources", "hawkfi");

    let poolsResJson: unknown;
    try {
      poolsResJson = await fabriqFetch(`/history/${wallet}/pools`, params);
      poolsRetries = 0;
    } catch (err: unknown) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("404")) {
        poolsRetries++;
        if (poolsRetries > 2) {
          return {
            positions: [],
            daily: [],
            valid: false,
            reason: "404_NO_POSITION_DATA",
          };
        }
        await sleep(2000);
        continue;
      }
      throw err;
    }

    const dataNode = extractObjectField(poolsResJson, "data") ?? poolsResJson;
    const itemsNode = extractObjectField(dataNode, "items");
    const poolsNode = extractObjectField(dataNode, "pools");

    const pageItems: unknown[] = Array.isArray(dataNode)
      ? dataNode
      : Array.isArray(itemsNode)
      ? itemsNode
      : Array.isArray(poolsNode)
      ? poolsNode
      : [];

    if (pageItems.length === 0) break;

    for (const row of pageItems) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const poolField = rec.pool;
      const poolNestedId = poolField && typeof poolField === "object" ? (poolField as Record<string, unknown>).id : null;
      const poolId = rec.pool_id ?? rec.poolId ?? poolNestedId ?? rec.id;
      if (!poolId) continue;
      const poolIdStr = String(poolId).trim();
      if (isFabriqDlmmPool(row)) {
        allDlmmPoolIds.add(poolIdStr);
      }
    }

    if (pageItems.length < 100) break;
    page++;
  }

  if (allDlmmPoolIds.size === 0) {
    return {
      positions: [],
      daily: [],
      valid: false,
      reason: "NO_DLMM_POOLS",
    };
  }

  // 2. Fetch closed positions
  const poolIdsToQuery = Array.from(allDlmmPoolIds);
  const poolBatchSize = 25;
  const closedPositions: ClosedPositionItem[] = [];

  for (let i = 0; i < poolIdsToQuery.length; i += poolBatchSize) {
    const batch = poolIdsToQuery.slice(i, i + poolBatchSize);
    const posParams = new URLSearchParams();
    posParams.set("poolIds", batch.join(","));
    posParams.append("sources", "wallet");
    posParams.append("sources", "hawkfi");
    posParams.set("timezone", "Asia/Jakarta");
    posParams.set("pnlCurrency", "USD");
    posParams.set("pnlScope", "pool");
    posParams.set("lastCloseScope", "pool");
    posParams.set("durationScope", "pool");
    posParams.set("depositsScope", "pool");
    posParams.set("withdrawalsScope", "pool");
    posParams.set("feesScope", "pool");

    let posResJson: unknown;
    try {
      posResJson = await fabriqFetch(`/history/${wallet}/positions-by-pool`, posParams);
    } catch (err: unknown) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes("404")) {
        await sleep(4000);
        posResJson = await fabriqFetch(`/history/${wallet}/positions-by-pool`, posParams).catch(() => ({}));
      } else {
        throw err;
      }
    }

    const resData = extractObjectField(posResJson, "data") ?? posResJson;

    if (resData && typeof resData === "object" && !Array.isArray(resData)) {
      for (const [pId, posList] of Object.entries(resData as Record<string, unknown>)) {
        const poolKey = String(pId).trim();
        if (!allDlmmPoolIds.has(poolKey)) continue;

        if (Array.isArray(posList)) {
          for (const pos of posList) {
            if (!pos || typeof pos !== "object") continue;
            const p = pos as Record<string, unknown>;
            if (!p.id) continue;
            const closeTs = p.latest_close_ts ?? p.closed_at ?? p.closedAt;
            const closeMs = parseTimestampMs(closeTs);

            if (closeMs !== null && closeMs >= cutoffMs) {
              const openTs = p.opened_at ?? p.openedAt ?? null;
              const openMs = parseTimestampMs(openTs);

              let holdDurationSeconds: number | null = null;
              if (typeof p.duration === "number") {
                holdDurationSeconds = Math.round(p.duration);
              } else if (closeMs !== null && openMs !== null && closeMs >= openMs) {
                holdDurationSeconds = Math.round((closeMs - openMs) / 1000);
              }

              const holdDurationHours =
                holdDurationSeconds !== null
                  ? Number((holdDurationSeconds / 3600).toFixed(4))
                  : null;

              const deposit = Number(p.total_add_usd ?? p.depositUsd ?? 0);
              const withdrawal = Number(p.total_rem_usd ?? p.withdrawalUsd ?? 0);
              const claimedFees = Number(p.total_fee_usd ?? p.feeUsd ?? 0);
              const pnl = Number(p.total_pnl_usd ?? p.pnlUsd ?? 0);

              let pnlPct: number | null = null;
              if (p.total_pnl_pct_usd !== undefined && p.total_pnl_pct_usd !== null) {
                const parsed = Number(p.total_pnl_pct_usd);
                if (Number.isFinite(parsed)) pnlPct = parsed;
              } else if (deposit > 0) {
                pnlPct = Number(((pnl / deposit) * 100).toFixed(4));
              }

              let winLoss: "WIN" | "LOSS" | "BREAKEVEN";
              if (pnl > 0) winLoss = "WIN";
              else if (pnl < 0) winLoss = "LOSS";
              else winLoss = "BREAKEVEN";

              closedPositions.push({
                wallet,
                positionId: String(p.id),
                pool: poolKey,
                openedAt: openTs ? String(openTs) : null,
                closedAt: closeTs ? String(closeTs) : null,
                holdDuration: holdDurationSeconds,
                holdDurationHours,
                deposit,
                withdrawal,
                claimedFees,
                pnl,
                pnlPct,
                winLoss,
              });

              if (closedPositions.length > maxClosedPositions) {
                return {
                  positions: [],
                  daily: [],
                  valid: false,
                  reason: `WORKLOAD_GUARD (> ${maxClosedPositions})`,
                };
              }
            }
          }
        }
      }
    }
  }

  if (closedPositions.length === 0) {
    return {
      positions: [],
      daily: [],
      valid: false,
      reason: "0_CLOSED_POSITIONS",
    };
  }

  // 3. Fetch Daily Calendar
  const cutoffDateStr = new Date(cutoffMs).toISOString().slice(0, 10);
  const nowStr = new Date().toISOString().slice(0, 10);

  const calMonths = new Set<string>();
  let cur = new Date(cutoffMs);
  const end = new Date();
  while (cur <= end) {
    calMonths.add(cur.toISOString().slice(0, 7));
    cur.setMonth(cur.getMonth() + 1);
  }

  const dailyMap = new Map<string, DailyRecordItem>();
  for (const ym of calMonths) {
    try {
      const calRes: unknown = await fabriqFetch(`/history/${wallet}/calendar?month=${ym}`);
      const calData = extractObjectField(calRes, "data") ?? calRes;

      if (calData && typeof calData === "object") {
        for (const [dateStr, dayObj] of Object.entries(calData as Record<string, unknown>)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
          if (dateStr >= cutoffDateStr && dateStr <= nowStr && dayObj && typeof dayObj === "object") {
            const d = dayObj as Record<string, unknown>;
            if (!dailyMap.has(dateStr)) {
              dailyMap.set(dateStr, {
                date: dateStr,
                pnlUsd: Number(d.pnlUsd ?? d.pnl ?? 0),
                feesUsd: d.feesUsd !== undefined ? Number(d.feesUsd) : undefined,
                positions: d.positions !== undefined ? Number(d.positions) : undefined,
                winRateUsd: typeof d.winRateUsd === "number" ? d.winRateUsd : null,
              });
            }
          }
        }
      }
    } catch {
      // Month calendar optional
    }
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    positions: closedPositions,
    daily,
    valid: true,
    reason: null,
  };
}

// ======================================================
// CALCULATION & ANALYSIS ENGINE
// ======================================================
async function loadFromPoolTradeCheckpoints(wallet: string): Promise<{
  positions: ClosedPositionItem[];
  daily: DailyRecordItem[];
} | null> {
  const POOL_BASE = path.resolve("data/discovery/pool-scanner");
  try {
    const tokens = await readdir(POOL_BASE);
    for (const token of tokens) {
      const checkpointsBase = path.join(POOL_BASE, token, "selected-scan", "trade-history-checkpoints");
      try {
        const fpDirs = await readdir(checkpointsBase);
        for (const fp of fpDirs) {
          const targetFile = path.join(checkpointsBase, fp, `${wallet}.json`);
          try {
            const raw = await readFile(targetFile, "utf8");
            const data = JSON.parse(raw) as {
              wallet?: string;
              pools?: Array<{
                poolAddress?: string;
                trades?: Array<{
                  positionId: string;
                  openedAt?: string | null;
                  closedAt?: string | null;
                  durationSeconds?: number | null;
                  pnlUsd?: number | null;
                  pnlPct?: number | null;
                }>;
              }>;
            };

            if (data && Array.isArray(data.pools) && data.pools.length > 0) {
              const positions: ClosedPositionItem[] = [];
              for (const pool of data.pools) {
                const poolKey = pool.poolAddress || "unknown";
                for (const t of pool.trades || []) {
                  const pnl = Number(t.pnlUsd ?? 0);
                  const pnlPct = t.pnlPct !== undefined && t.pnlPct !== null ? Number(t.pnlPct) : null;
                  const deposit = pnlPct && pnlPct !== 0 ? Math.abs((pnl / pnlPct) * 100) : 0;
                  const holdDuration = t.durationSeconds !== undefined && t.durationSeconds !== null ? Number(t.durationSeconds) : null;
                  const holdDurationHours = holdDuration !== null ? Number((holdDuration / 3600).toFixed(4)) : null;

                  positions.push({
                    wallet,
                    positionId: String(t.positionId),
                    pool: poolKey,
                    openedAt: t.openedAt ? String(t.openedAt) : null,
                    closedAt: t.closedAt ? String(t.closedAt) : null,
                    holdDuration,
                    holdDurationHours,
                    deposit,
                    withdrawal: 0,
                    claimedFees: 0,
                    pnl,
                    pnlPct,
                    winLoss: pnl > 0 ? "WIN" : (pnl < 0 ? "LOSS" : "BREAKEVEN"),
                  });
                }
              }

              if (positions.length > 0) {
                const daily: DailyRecordItem[] = [];
                try {
                  const fabRaw = JSON.parse(await readFile(path.resolve("data/master/wallets-fabriq.json"), "utf8")) as {
                    wallets?: Array<{ owner: string; fabriq?: { calendars?: Record<string, Record<string, { pnlUsd?: number; pnl?: number }>> } }>;
                  };
                  const fabMatch = fabRaw.wallets?.find((w) => w.owner === wallet);
                  if (fabMatch?.fabriq?.calendars) {
                    for (const cal of Object.values(fabMatch.fabriq.calendars)) {
                      if (cal && typeof cal === "object") {
                        for (const [d, row] of Object.entries(cal)) {
                          daily.push({
                            date: d,
                            pnlUsd: Number(row.pnlUsd ?? row.pnl ?? 0),
                          });
                        }
                      }
                    }
                  }
                } catch {
                  //
                }

                return { positions, daily };
              }
            }
          } catch {
            //
          }
        }
      } catch {
        //
      }
    }
  } catch {
    //
  }
  return null;
}


export async function analyzeSingleWallet(
  walletAddress: string,
  options: { forceRefresh?: boolean } = {}
): Promise<SingleWalletAnalysisResult> {
  const { forceRefresh = false } = options;

  if (!isValidSolanaAddress(walletAddress)) {
    throw new Error(`INVALID_ADDRESS: "${walletAddress}" is not a valid Solana address.`);
  }

  const normalizedWallet = walletAddress.trim();
  const resultFilePath = path.join(SINGLE_WALLET_DIR, `${normalizedWallet}.json`);

  // Return durable cached result if already exists and not forced
  if (!forceRefresh) {
    try {
      const existingText = await readFile(resultFilePath, "utf8");
      const existingData = JSON.parse(existingText) as SingleWalletAnalysisResult;
      if (existingData && existingData.wallet === normalizedWallet && existingData.qualityScore !== undefined) {
        return existingData;
      }
    } catch {
      // File not found or invalid, proceed with calculation
    }
  }

  // 1. Ensure Reference Cohort is available
  const cohort = await loadReferenceCohort();

  // 2. Fetch data (reuse checkpoint if available, or fetch fresh)
  let positions: ClosedPositionItem[] = [];
  let daily: DailyRecordItem[] = [];

  const cpFilePath = path.join(CHECKPOINT_DIR, `${normalizedWallet}.json`);
  let loadedFromCheckpoint = false;

  if (!forceRefresh) {
    try {
      const cpText = await readFile(cpFilePath, "utf8");
      const cpData = JSON.parse(cpText) as {
        valid?: boolean;
        positions?: ClosedPositionItem[];
        daily?: DailyRecordItem[];
      };
      if (cpData && cpData.valid && Array.isArray(cpData.positions) && cpData.positions.length > 0) {
        positions = cpData.positions;
        daily = Array.isArray(cpData.daily) ? cpData.daily : [];
        loadedFromCheckpoint = true;
      }
    } catch {
      // Not in checkpoint
    }

    if (!loadedFromCheckpoint) {
      const fromPoolTrade = await loadFromPoolTradeCheckpoints(normalizedWallet);
      if (fromPoolTrade && fromPoolTrade.positions.length > 0) {
        positions = fromPoolTrade.positions;
        daily = fromPoolTrade.daily;
        loadedFromCheckpoint = true;
      }
    }
  }

  if (!loadedFromCheckpoint) {
    const fetched = await fetchSingleWalletFabriqData(normalizedWallet);
    if (!fetched.valid) {
      throw new Error(`INELIGIBLE_WALLET: ${fetched.reason ?? "Wallet has no qualifying DLMM positions"}`);
    }
    positions = fetched.positions;
    daily = fetched.daily;
  }

  // 3. Compute Raw Descriptive Metrics
  const closedPositionCount = positions.length;
  const uniqueDlmmPools = new Set(positions.map((p) => p.pool).filter(Boolean)).size;

  const totalPnl = Number(positions.reduce((sum, p) => sum + p.pnl, 0).toFixed(4));
  const winningPositions = positions.filter((p) => p.winLoss === "WIN");
  const losingPositions = positions.filter((p) => p.winLoss === "LOSS");

  const grossProfit = Number(winningPositions.reduce((sum, p) => sum + p.pnl, 0).toFixed(4));
  const grossLoss = Number(Math.abs(losingPositions.reduce((sum, p) => sum + p.pnl, 0)).toFixed(4));

  const profitFactor =
    grossLoss > 0
      ? Number((grossProfit / grossLoss).toFixed(4))
      : grossProfit > 0
      ? 100 // Ceiling if no losses
      : 0;

  const positionWinRate = Number(((winningPositions.length / closedPositionCount) * 100).toFixed(2));

  const pnlPcts = positions
    .map((p) => p.pnlPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const medianPositionPnlPct = computeMedian(pnlPcts) ?? 0;

  // Concentration: Max winning position PnL / grossProfit
  const maxWinPnl = winningPositions.length > 0 ? Math.max(...winningPositions.map((p) => p.pnl)) : 0;
  const pnlConcentrationTop1 = grossProfit > 0 ? Number(((maxWinPnl / grossProfit) * 100).toFixed(2)) : 0;

  // 4. Compute Position Risk & Daily Risk
  const posRisk = computePositionRisk(positions);
  const dailyRisk = computeDailyRisk(daily);

  const cvar10PositionPnlPct = posRisk.cvar10PositionPnlPct;
  const medianLosingPositionPnlPct = posRisk.medianLosingPositionPnlPct ?? 0;
  const negativeDayRate = dailyRisk.negativeDayRate;

  // 5. Percentile Scoring Relative to Cohort Distributions
  // Quality signals
  const pnlPctPercentile = calcPercentile(cohort.quality.medianPnl, medianPositionPnlPct, "higher_is_better");
  const pfPercentile = calcPercentile(cohort.quality.profitFactor, profitFactor, "higher_is_better");
  const winRatePercentile = calcPercentile(cohort.quality.winRate, positionWinRate, "higher_is_better");
  const invConcPercentile = calcPercentile(cohort.quality.concentration, pnlConcentrationTop1, "lower_is_better");

  const qualityScore = Number(
    (
      pnlPctPercentile * 0.35 +
      pfPercentile * 0.25 +
      winRatePercentile * 0.2 +
      invConcPercentile * 0.2
    ).toFixed(2)
  );

  // Risk signals
  const cvarRiskPercentile = calcPercentile(cohort.risk.cvar10, cvar10PositionPnlPct, "lower_is_riskier");
  const negDayRiskPercentile = calcPercentile(cohort.risk.negativeDayRate, negativeDayRate, "higher_is_riskier");
  const losingPnlRiskPercentile = calcPercentile(cohort.risk.medianLosingPnl, medianLosingPositionPnlPct, "lower_is_riskier");

  const riskScore = Number(
    (
      cvarRiskPercentile * 0.45 +
      negDayRiskPercentile * 0.3 +
      losingPnlRiskPercentile * 0.25
    ).toFixed(2)
  );

  // Confidence Score (Absolute evidence-based)
  const positionSampleScore = Number(
    Math.min(100, Math.sqrt(Math.max(0, closedPositionCount) / 200) * 100).toFixed(2)
  );

  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const p of positions) {
    const oMs = parseTimestampMs(p.openedAt);
    const cMs = parseTimestampMs(p.closedAt);
    if (oMs !== null && oMs < minMs) minMs = oMs;
    if (cMs !== null && cMs > maxMs) maxMs = cMs;
  }
  const historySpanDays = Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs >= minMs
    ? Number(((maxMs - minMs) / (24 * 60 * 60 * 1000)).toFixed(2))
    : 1;

  const historySpanScore = Number(Math.min(100, (historySpanDays / 30) * 100).toFixed(2));
  const confidenceScore = Number((positionSampleScore * 0.75 + historySpanScore * 0.25).toFixed(2));

  // 6. Style Classification
  const holdHours = positions
    .map((p) => p.holdDurationHours)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const medianHoldHours = computeMedian(holdHours) ?? 0;
  const positionsPerPool = Number((closedPositionCount / Math.max(1, uniqueDlmmPools)).toFixed(2));

  // Reference thresholds from screening session
  const sniperEligible = medianHoldHours <= 0.61;
  const farmerEligible = medianHoldHours >= 2.8 && uniqueDlmmPools <= 48 && positionsPerPool >= 3.26;

  let style: WalletStyleV1 = "MIXED_UNCLASSIFIED";
  if (sniperEligible && !farmerEligible) style = "SNIPER";
  else if (farmerEligible && !sniperEligible) style = "FARMER";

  // 7. Shortlist Evaluation
  const qualityPass = qualityScore >= cohort.thresholds.qualityMinimum;
  const riskPass = riskScore <= cohort.thresholds.riskMaximum;
  const confidencePass = confidenceScore >= cohort.thresholds.confidenceMinimum;
  const profitabilityGuardrailsPass = totalPnl > 0 && profitFactor > 1 && medianPositionPnlPct > 0;
  const shortlisted = qualityPass && riskPass && confidencePass && profitabilityGuardrailsPass;

  // 8. Assemble Result
  const result: SingleWalletAnalysisResult = {
    wallet: normalizedWallet,
    analyzedAt: new Date().toISOString(),
    referenceCohort: {
      version: "v1",
      generatedAt: cohort.meta.generatedAt,
      validWallets: cohort.meta.validWallets,
      qualityThresholdP75: cohort.thresholds.qualityMinimum,
      riskThresholdP25: cohort.thresholds.riskMaximum,
    },
    qualityScore,
    riskScore,
    confidenceScore,
    style,
    shortlisted,
    performance: {
      totalPnl,
      profitFactor,
      medianPositionPnlPct,
      positionWinRate,
      closedPositionCount,
      pnlConcentrationTop1,
    },
    shortlistReasons: {
      qualityPass,
      riskPass,
      confidencePass,
      profitabilityGuardrailsPass,
    },
    rawMetrics: {
      medianPositionPnlPct,
      profitFactor,
      positionWinRate,
      pnlConcentrationTop1,
      cvar10PositionPnlPct,
      negativeDayRate,
      medianLosingPositionPnlPct,
      closedPositionCount,
      totalPnl,
      historySpanDays,
    },
    components: {
      quality: {
        medianPositionPnlPctPercentile: pnlPctPercentile,
        profitFactorPercentile: pfPercentile,
        positionWinRatePercentile: winRatePercentile,
        inverseConcentrationPercentile: invConcPercentile,
      },
      risk: {
        cvar10RiskPercentile: cvarRiskPercentile,
        negativeDayRateRiskPercentile: negDayRiskPercentile,
        medianLosingPnlRiskPercentile: losingPnlRiskPercentile,
      },
      confidence: {
        positionSampleScore,
        historySpanScore,
      },
    },
  };

  // 9. Atomic persist in isolated single-wallet storage
  await mkdir(SINGLE_WALLET_DIR, { recursive: true });
  const tempPath = `${resultFilePath}.tmp.${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  await rename(tempPath, resultFilePath);

  return result;
}

// ======================================================
// CLI ENTRY POINT
// ======================================================

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetWallet = process.argv[2];
  const force = process.argv.includes("--force");

  if (!targetWallet) {
    console.error("Usage: node --experimental-strip-types scripts/v1/single-wallet-intelligence.ts <WALLET_ADDRESS> [--force]");
    process.exit(1);
  }

  analyzeSingleWallet(targetWallet, { forceRefresh: force })
    .then((res) => {
      console.log("\n==================================================");
      console.log("SINGLE WALLET INTELLIGENCE V1 RESULT");
      console.log("==================================================");
      console.log(`Wallet     : ${res.wallet}`);
      console.log(`Quality    : ${res.qualityScore}/100`);
      console.log(`Risk       : ${res.riskScore}/100`);
      console.log(`Confidence : ${res.confidenceScore}/100`);
      console.log(`Style      : ${res.style}`);
      console.log(`Shortlist  : ${res.shortlisted ? "YES" : "NO"}`);
      console.log(`Cohort     : ${res.referenceCohort.validWallets} wallets (${res.referenceCohort.generatedAt})`);
      console.log("==================================================");
    })
    .catch((err) => {
      console.error("\nANALYSIS FAILED:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    })
    .finally(() => {
      closeFabriqConnection();
    });
}
