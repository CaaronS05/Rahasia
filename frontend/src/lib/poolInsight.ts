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
