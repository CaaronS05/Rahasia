export const POOL_INSIGHT_API_BASE = "http://127.0.0.1:8787";

export interface ScannedPoolItem {
  poolAddress: string;
  tokenMint: string;
  pair: string;
  binStep: number;
  baseFeePct: number;
  selectionFingerprint: string;
  walletCount: number;
  tradeCount: number;
  firstScannedAt: string;
  lastScannedAt: string;
}

export interface ScannedPoolsResponse {
  updatedAt: string | null;
  total: number;
  pools: ScannedPoolItem[];
}

export interface PoolDetailResponse {
  pool: ScannedPoolItem;
}

export type PoolWalletSortKey = "pnlUsd" | "winRate" | "positions" | "tradeCount";
export type SortOrder = "asc" | "desc";

export interface PoolWalletItem {
  poolAddress: string;
  wallet: string;
  pnlUsd: number;
  winRate: number | null;
  positions: number;
  tradeCount: number;
  selectionFingerprint: string;
  updatedAt: string;
}

export interface PoolWalletsResponse {
  poolAddress: string;
  updatedAt: string | null;
  total: number;
  wallets: PoolWalletItem[];
}

export interface PoolWalletTradeItem {
  poolAddress: string;
  wallet: string;
  positionId: string;
  openedAt: string;
  closedAt: string;
  durationSeconds: number;
  pnlUsd: number;
  pnlPct: number;
  selectionFingerprint: string;
}

export interface PoolWalletTradesResponse {
  poolAddress: string;
  wallet: string;
  total: number;
  trades: PoolWalletTradeItem[];
}

export type PoolTradeMatchMode = "individual" | "cumulative" | "both";

export interface PoolTradeFilterParams {
  minDurationMinutes?: number | null;
  maxDurationMinutes?: number | null;
  minPnlUsd?: number | null;
  maxPnlUsd?: number | null;
  minPnlPct?: number | null;
  maxPnlPct?: number | null;
  matchMode?: PoolTradeMatchMode;
}

export interface PoolTradeFilterAppliedFilters {
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  minPnlUsd: number | null;
  maxPnlUsd: number | null;
  minPnlPct: number | null;
  maxPnlPct: number | null;
  matchMode: PoolTradeMatchMode;
}

export interface MatchedPoolTradeItem {
  positionId: string;
  openedAt: string | null;
  closedAt: string;
  durationSeconds: number | null;
  pnlUsd: number;
  pnlPct: number;
}

export interface MatchedPoolTradeWalletItem {
  wallet: string;
  matchedTradeCount: number;
  trades: MatchedPoolTradeItem[];
}

export interface MatchedCumulativeGroup {
  groupId: string;
  wallet: string;
  poolAddress?: string;
  pair?: string;
  positionCount: number | null;
  cumulativePnlUsd: number | null;
  cumulativePnlPct: number | null;
  cumulativeDurationSeconds: number | null;
  totalAddUsd?: number | null;
  totalRemUsd?: number | null;
  totalFeeUsd?: number | null;
  earliestOpenedAt: string | null;
  latestClosedAt: string | null;
  source?: string;
  lastUpdated?: string | null;
  isStale?: boolean;
  positions?: MatchedPoolTradeItem[];
}

export interface PoolTradeFilterResponse {
  poolAddress: string;
  filters: PoolTradeFilterAppliedFilters;
  totalPoolTrades: number;
  matchedTradeCount: number;
  matchedGroupCount: number;
  matchedWalletCount: number;
  wallets: MatchedPoolTradeWalletItem[];
  cumulativeGroups: MatchedCumulativeGroup[];
  cumulativeStatus?: "available" | "unavailable" | "stale" | "partial";
  totalPoolAggregates?: number;
}
export type PoolRefreshStatus = "idle" | "running" | "completed" | "failed";
export type PoolRefreshStage =
  | "idle"
  | "starting"
  | "scanning"
  | "enriching"
  | "trade_history"
  | "persisting"
  | "completed"
  | "failed";

export interface PoolRefreshStatusResponse {
  poolAddress: string | null;
  status: PoolRefreshStatus;
  stage: PoolRefreshStage;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export async function fetchScannedPools(): Promise<ScannedPoolsResponse> {
  const response = await fetch(`${POOL_INSIGHT_API_BASE}/api/pool-insight/pools`, {
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Failed to fetch scanned pools (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function fetchPoolDetail(poolAddress: string): Promise<PoolDetailResponse> {
  const response = await fetch(
    `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    let message = `Failed to fetch pool detail (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function fetchPoolWallets(
  poolAddress: string,
  sortBy: PoolWalletSortKey = "pnlUsd",
  sortOrder: SortOrder = "desc"
): Promise<PoolWalletsResponse> {
  const params = new URLSearchParams({ sortBy, sortOrder });
  const response = await fetch(
    `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}/wallets?${params.toString()}`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    let message = `Failed to fetch pool wallets (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function fetchPoolWalletTrades(
  poolAddress: string,
  wallet: string
): Promise<PoolWalletTradesResponse> {
  const response = await fetch(
    `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}/wallets/${encodeURIComponent(wallet)}/trades`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    let message = `Failed to fetch wallet trades (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function startPoolRefresh(poolAddress: string): Promise<PoolRefreshStatusResponse> {
  const response = await fetch(
    `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}/refresh`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
  if (!response.ok) {
    let message = `Failed to start pool refresh (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function getPoolRefreshStatus(poolAddress: string): Promise<PoolRefreshStatusResponse> {
  const response = await fetch(
    `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}/refresh/status`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    let message = `Failed to fetch pool refresh status (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function filterPoolTrades(
  poolAddress: string,
  filters: PoolTradeFilterParams
): Promise<PoolTradeFilterResponse> {
  const params = new URLSearchParams();

  if (filters.minDurationMinutes !== undefined && filters.minDurationMinutes !== null && Number.isFinite(filters.minDurationMinutes)) {
    params.set("minDurationSeconds", String(filters.minDurationMinutes * 60));
  }
  if (filters.maxDurationMinutes !== undefined && filters.maxDurationMinutes !== null && Number.isFinite(filters.maxDurationMinutes)) {
    params.set("maxDurationSeconds", String(filters.maxDurationMinutes * 60));
  }
  if (filters.minPnlUsd !== undefined && filters.minPnlUsd !== null && Number.isFinite(filters.minPnlUsd)) {
    params.set("minPnlUsd", String(filters.minPnlUsd));
  }
  if (filters.maxPnlUsd !== undefined && filters.maxPnlUsd !== null && Number.isFinite(filters.maxPnlUsd)) {
    params.set("maxPnlUsd", String(filters.maxPnlUsd));
  }
  if (filters.minPnlPct !== undefined && filters.minPnlPct !== null && Number.isFinite(filters.minPnlPct)) {
    params.set("minPnlPct", String(filters.minPnlPct));
  }
  if (filters.maxPnlPct !== undefined && filters.maxPnlPct !== null && Number.isFinite(filters.maxPnlPct)) {
    params.set("maxPnlPct", String(filters.maxPnlPct));
  }
  if (filters.matchMode) {
    params.set("matchMode", filters.matchMode);
  }

  const queryString = params.toString();
  const url = `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}/trade-filter${queryString ? `?${queryString}` : ""}`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    let message = `Failed to filter pool trades (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  const data = await response.json();
  const matchMode: PoolTradeMatchMode = data.filters?.matchMode || filters.matchMode || "individual";
  const wallets = Array.isArray(data.wallets) ? data.wallets : [];
  const cumulativeGroups = Array.isArray(data.cumulativeGroups) ? data.cumulativeGroups : [];
  return {
    ...data,
    filters: {
      ...data.filters,
      matchMode,
    },
    wallets,
    cumulativeGroups,
  };
}

export async function refreshWalletCumulative(
  poolAddress: string,
  wallet: string
): Promise<{
  success: boolean;
  poolAddress: string;
  wallet: string;
  aggregate?: MatchedCumulativeGroup | null;
  message?: string;
}> {
  const url = `${POOL_INSIGHT_API_BASE}/api/pool-insight/pools/${encodeURIComponent(poolAddress)}/wallets/${encodeURIComponent(wallet)}/refresh-cumulative`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    let message = `Failed to refresh cumulative aggregate (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export function formatUsd(val: number | null | undefined): string {
  if (val === null || val === undefined || typeof val !== "number" || !Number.isFinite(val)) {
    return "—";
  }
  const normalized = Object.is(val, -0) ? 0 : val;
  const sign = normalized > 0 ? "+" : normalized < 0 ? "-" : "";
  const abs = Math.abs(normalized);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  return `${sign}$${formatted}`;
}

export function formatPct(val: number | null | undefined): string {
  if (val === null || val === undefined || typeof val !== "number" || !Number.isFinite(val)) {
    return "—";
  }
  const normalized = Object.is(val, -0) ? 0 : val;
  const sign = normalized > 0 ? "+" : normalized < 0 ? "-" : "";
  const abs = Math.abs(normalized);
  return `${sign}${abs.toFixed(2)}%`;
}

export interface TokenPoolGroup {
  groupKey: string;
  tokenMint: string;
  tokenName: string;
  pools: ScannedPoolItem[];
  poolCount: number;
  mostRecentScanAt: string;
}

export function groupPoolsByToken(pools: ScannedPoolItem[]): TokenPoolGroup[] {
  const groupMap = new Map<string, TokenPoolGroup>();

  for (const pool of pools) {
    const mint = pool.tokenMint?.trim();

    // Grouping rules:
    // 1. Group by exact tokenMint, NOT symbol or pair name.
    // 2. Only group pools with the same actual token mint and corresponding SOL pairing.
    // 3. Two tokens with the same symbol but different mint addresses must remain separate groups.
    // 4. Never merge pool records or their underlying data.
    // 5. Preserve all individual pool addresses.
    // 6. If tokenMint is unavailable, avoid incorrect grouping: keep that pool as a separate entry.
    let key: string;
    if (!mint) {
      key = `unminted:${pool.poolAddress}`;
    } else {
      const pairUpper = (pool.pair || "").trim().toUpperCase();
      const isSolPair = pairUpper.endsWith("/SOL") || pairUpper.endsWith("-SOL");
      key = isSolPair ? `mint:${mint}:SOL` : `mint:${mint}:${pairUpper}`;
    }

    const existing = groupMap.get(key);
    if (!existing) {
      groupMap.set(key, {
        groupKey: key,
        tokenMint: mint || "",
        tokenName: pool.pair?.trim() || "Unknown Token",
        pools: [pool],
        poolCount: 1,
        mostRecentScanAt: pool.lastScannedAt || pool.firstScannedAt || "",
      });
    } else {
      existing.pools.push(pool);
      existing.poolCount = existing.pools.length;
      if (
        pool.lastScannedAt &&
        (!existing.mostRecentScanAt ||
          Date.parse(pool.lastScannedAt) > Date.parse(existing.mostRecentScanAt))
      ) {
        existing.mostRecentScanAt = pool.lastScannedAt;
      }
    }
  }

  return Array.from(groupMap.values());
}

export function filterTokenGroups(
  groups: TokenPoolGroup[],
  query: string
): TokenPoolGroup[] {
  const term = query.trim().toLowerCase();
  if (!term) return groups;

  return groups.filter((group) => {
    if (group.tokenName && group.tokenName.toLowerCase().includes(term)) {
      return true;
    }
    if (group.tokenMint && group.tokenMint.toLowerCase().includes(term)) {
      return true;
    }
    return group.pools.some((pool) => {
      const pair = pool.pair ? pool.pair.toLowerCase() : "";
      const poolAddr = pool.poolAddress ? pool.poolAddress.toLowerCase() : "";
      const mint = pool.tokenMint ? pool.tokenMint.toLowerCase() : "";
      return pair.includes(term) || poolAddr.includes(term) || mint.includes(term);
    });
  });
}
