export const POOL_API_BASE = "http://127.0.0.1:8787";

export type PoolSortKey =
  | "volume24h"
  | "tvl"
  | "fees24h"
  | "feeTvl24h"
  | "apr"
  | "apy"
  | "createdAt"
  | "binStep"
  | "baseFeePct"
  | "name";

export type SortOrder = "asc" | "desc";

export interface PoolToken {
  address: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  verified: boolean;
  holders: number | null;
  price: number | null;
  marketCap: number | null;
  totalSupply: number | null;
  freezeAuthorityDisabled: boolean | null;
}

export interface PoolTimeframeMetrics {
  "30m": number;
  "1h": number;
  "2h": number;
  "4h": number;
  "12h": number;
  "24h": number;
}

export interface LegacyDlmmPool {
  address: string;
  name: string;
  pairType: 0;
  tokenX: PoolToken;
  tokenY: PoolToken;
  binStep: number | null;
  baseFeePct: number | null;
  maxFeePct: number | null;
  protocolFeePct: number | null;
  dynamicFeePct: number | null;
  tvl: number;
  currentPrice: number | null;
  volume: PoolTimeframeMetrics;
  fees: PoolTimeframeMetrics;
  feeTvlRatio: PoolTimeframeMetrics;
  apr: number;
  apy: number;
  hasFarm: boolean;
  farmApr: number;
  farmApy: number;
  createdAt: number | null;
  cumulativeVolume: number;
  cumulativeFees: number;
  reserveX: string | null;
  reserveY: string | null;
  tokenXAmount: number | null;
  tokenYAmount: number | null;
  launchpad: string;
  tags: string[];
}

export interface PoolQuery {
  page?: number;
  pageSize?: number;
  query?: string;
  minTvl?: number | null;
  maxTvl?: number | null;
  minVolume24h?: number | null;
  minFees24h?: number | null;
  minFeeTvl24h?: number | null;
  binStep?: number | null;
  sortBy?: PoolSortKey;
  sortOrder?: SortOrder;
}

export interface PoolApiResponse {
  generatedAt: string | null;
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  filters: {
    query: string | null;
    minTvl: number | null;
    maxTvl: number | null;
    minVolume24h: number | null;
    minFees24h: number | null;
    minFeeTvl24h: number | null;
    binStep: number | null;
  };
  sort: {
    sortBy: PoolSortKey;
    sortOrder: SortOrder;
  };
  data: LegacyDlmmPool[];
}

function setNumber(
  params: URLSearchParams,
  key: string,
  value: number | null | undefined,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return;
  }

  params.set(key, String(value));
}

export async function getPools(
  query: PoolQuery,
  signal?: AbortSignal,
): Promise<PoolApiResponse> {
  const params = new URLSearchParams();

  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 50));

  if (query.query?.trim()) {
    params.set("query", query.query.trim());
  }

  setNumber(params, "minTvl", query.minTvl);
  setNumber(params, "maxTvl", query.maxTvl);
  setNumber(params, "minVolume24h", query.minVolume24h);
  setNumber(params, "minFees24h", query.minFees24h);
  setNumber(params, "minFeeTvl24h", query.minFeeTvl24h);
  setNumber(params, "binStep", query.binStep);

  params.set("sortBy", query.sortBy ?? "volume24h");
  params.set("sortOrder", query.sortOrder ?? "desc");

  const response = await fetch(
    `${POOL_API_BASE}/api/pools?${params.toString()}`,
    {
      cache: "no-store",
      signal,
    },
  );

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload?.error ||
        `Failed to load Pool Explorer (${response.status})`,
    );
  }

  return payload as PoolApiResponse;
}
