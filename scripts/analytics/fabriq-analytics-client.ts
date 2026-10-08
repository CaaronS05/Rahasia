import {
    fabriqFetch,
    isFabriqDlmmPool,
    type FabriqFetchOptions,
} from "../discovery/core/fabriq-position-history.ts";
import type {
    RawPositionInput,
    RawEventInput,
} from "./position-lifecycle-extractor.ts";

export interface DiscoveredPoolItem {
    poolId: string;
    dex?: string;
    isDlmm: boolean;
    raw?: Record<string, unknown>;
}

export interface FabriqPoolDiscoveryResult {
    wallet: string;
    allDiscoveredPools: DiscoveredPoolItem[];
    dlmmPools: DiscoveredPoolItem[];
    pagesFetched: number;
}

export interface FabriqFetchPositionsResult {
    wallet: string;
    positions: RawPositionInput[];
    batchesFetched: number;
}

export interface FabriqFetchTransactionsResult {
    wallet: string;
    events: RawEventInput[];
    batchesFetched: number;
}

export interface ClientLoggingOptions {
    onLog?: (msg: string) => void;
}

/**
 * Discover all DLMM pools for a wallet via GET /history/<wallet>/pnl-by-pool with full pagination.
 */
export async function discoverWalletDlmmPools(
    wallet: string,
    options?: ClientLoggingOptions
): Promise<FabriqPoolDiscoveryResult> {
    const log = options?.onLog ?? ((msg: string) => console.log(msg));
    log(`[FABRIQ-DISC] Discovering DLMM pools for wallet: ${wallet}`);

    const allDiscoveredPools: DiscoveredPoolItem[] = [];
    const seenPoolIds = new Set<string>();
    let page = 1;
    let pagesFetched = 0;

    while (true) {
        pagesFetched++;
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", "100");
        params.set("sortBy", "latest_close_ts");
        params.set("sortOrder", "desc");
        params.set("pnlCurrency", "USD");
        params.set("timezone", "Asia/Jakarta");
        params.append("sources", "wallet");
        params.append("sources", "hawkfi");
        params.set("pnlScope", "pool");
        params.set("lastCloseScope", "pool");
        params.set("durationScope", "pool");
        params.set("depositsScope", "pool");
        params.set("withdrawalsScope", "pool");
        params.set("feesScope", "pool");

        log(`[FABRIQ-DISC] Fetching pool page ${page}...`);
        const fetchOpts: FabriqFetchOptions = { onLog: log };
        const resJson = await fabriqFetch<unknown>(
            `/history/${wallet}/pnl-by-pool`,
            params,
            fetchOpts
        );

        let pageItems: unknown[] = [];
        if (Array.isArray(resJson)) {
            pageItems = resJson;
        } else if (resJson && typeof resJson === "object") {
            const container = resJson as Record<string, unknown>;
            const dataNode = container.data;
            if (Array.isArray(dataNode)) {
                pageItems = dataNode;
            } else if (dataNode && typeof dataNode === "object") {
                const inner = dataNode as Record<string, unknown>;
                if (Array.isArray(inner.items)) pageItems = inner.items;
                else if (Array.isArray(inner.pools)) pageItems = inner.pools;
                else if (Array.isArray(inner.data)) pageItems = inner.data;
            } else if (Array.isArray(container.items)) {
                pageItems = container.items;
            } else if (Array.isArray(container.pools)) {
                pageItems = container.pools;
            }
        }

        if (pageItems.length === 0) {
            break;
        }

        for (const item of pageItems) {
            if (!item || typeof item !== "object") continue;
            const row = item as Record<string, unknown>;
            const poolObj = row.pool && typeof row.pool === "object" ? (row.pool as Record<string, unknown>) : null;

            const poolIdCandidate =
                row.pool_id ||
                row.poolId ||
                poolObj?.id ||
                poolObj?.address ||
                row.id;

            if (!poolIdCandidate || typeof poolIdCandidate !== "string") continue;
            const poolId = poolIdCandidate.trim();
            if (!poolId || seenPoolIds.has(poolId)) continue;
            seenPoolIds.add(poolId);

            const isDlmm = isFabriqDlmmPool(row);
            allDiscoveredPools.push({
                poolId,
                dex: typeof poolObj?.dex === "string" ? poolObj.dex : typeof row.dex === "string" ? row.dex : undefined,
                isDlmm,
                raw: row,
            });
        }

        log(`[FABRIQ-DISC] Page ${page}: processed ${pageItems.length} pools (cumulative unique: ${allDiscoveredPools.length})`);

        if (pageItems.length < 100) {
            break;
        }
        page++;
    }

    const dlmmPools = allDiscoveredPools.filter((p) => p.isDlmm);
    log(`[FABRIQ-DISC] Completed pool discovery: ${allDiscoveredPools.length} total, ${dlmmPools.length} DLMM eligible`);

    return {
        wallet,
        allDiscoveredPools,
        dlmmPools,
        pagesFetched,
    };
}

/**
 * Fetch positions for discovered DLMM pools in bounded batches.
 */
export async function fetchWalletPositionsForPools(
    wallet: string,
    poolIds: string[],
    options?: ClientLoggingOptions & { batchSize?: number }
): Promise<FabriqFetchPositionsResult> {
    const log = options?.onLog ?? ((msg: string) => console.log(msg));
    const batchSize = Math.max(1, options?.batchSize ?? 25);
    const positions: RawPositionInput[] = [];
    const allowedPoolIds = new Set(poolIds);
    let batchesFetched = 0;

    for (let i = 0; i < poolIds.length; i += batchSize) {
        batchesFetched++;
        const batch = poolIds.slice(i, i + batchSize);
        const params = new URLSearchParams();
        params.set("poolIds", batch.join(","));
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

        log(`[FABRIQ-POS] Fetching positions batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(poolIds.length / batchSize)} (${batch.length} pools)...`);

        const fetchOpts: FabriqFetchOptions = { onLog: log };
        const posRes = await fabriqFetch<unknown>(
            `/history/${wallet}/positions-by-pool`,
            params,
            fetchOpts
        );

        let dataNode: unknown = posRes;
        if (posRes && typeof posRes === "object" && "data" in posRes) {
            dataNode = (posRes as Record<string, unknown>).data;
        }

        if (dataNode && typeof dataNode === "object" && !Array.isArray(dataNode)) {
            const mapObj = dataNode as Record<string, unknown>;
            for (const [poolIdKey, list] of Object.entries(mapObj)) {
                if (!allowedPoolIds.has(poolIdKey)) continue;
                if (Array.isArray(list)) {
                    for (const item of list) {
                        if (!item || typeof item !== "object") continue;
                        const pos = item as Record<string, unknown>;
                        if (!pos.id) continue;
                        positions.push(normalizeRawPositionRecord(pos, poolIdKey));
                    }
                }
            }
        } else if (Array.isArray(dataNode)) {
            for (const item of dataNode) {
                if (!item || typeof item !== "object") continue;
                const pos = item as Record<string, unknown>;
                if (!pos.id) continue;
                const poolId = String(pos.pool_id || pos.poolId || "");
                if (poolId && !allowedPoolIds.has(poolId)) continue;
                positions.push(normalizeRawPositionRecord(pos, poolId));
            }
        }
    }

    log(`[FABRIQ-POS] Fetched ${positions.length} positions across ${poolIds.length} pools in ${batchesFetched} batches`);

    return {
        wallet,
        positions,
        batchesFetched,
    };
}

function normalizeRawPositionRecord(pos: Record<string, unknown>, poolIdFallback: string): RawPositionInput {
    const id = String(pos.id);
    const pool_id = String(pos.pool_id || pos.poolId || poolIdFallback);
    const source = typeof pos.source === "string" ? pos.source : "wallet";

    const numOrNull = (val: unknown): number | null => {
        if (val === null || val === undefined || val === "") return null;
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
    };

    return {
        id,
        pool_id,
        source,
        total_add_usd: numOrNull(pos.total_add_usd),
        total_add_sol: numOrNull(pos.total_add_sol),
        total_rem_usd: numOrNull(pos.total_rem_usd),
        total_rem_sol: numOrNull(pos.total_rem_sol),
        total_fee_usd: numOrNull(pos.total_fee_usd),
        total_fee_sol: numOrNull(pos.total_fee_sol),
        total_pnl_usd: numOrNull(pos.total_pnl_usd),
        total_pnl_sol: numOrNull(pos.total_pnl_sol),
        total_pnl_pct_usd: numOrNull(pos.total_pnl_pct_usd),
        total_pnl_pct_sol: numOrNull(pos.total_pnl_pct_sol),
        latest_close_ts: pos.latest_close_ts !== undefined ? (pos.latest_close_ts as string | number | null) : null,
        opened_at: pos.opened_at !== undefined ? (pos.opened_at as string | number | null) : null,
        duration: numOrNull(pos.duration),
        raw: pos,
    };
}

/**
 * Fetch lifecycle transactions for selected position IDs in bounded batches.
 */
export async function fetchTransactionsForPositions(
    wallet: string,
    positionIds: string[],
    positionToPoolMap: Map<string, string>,
    options?: ClientLoggingOptions & { batchSize?: number }
): Promise<FabriqFetchTransactionsResult> {
    const log = options?.onLog ?? ((msg: string) => console.log(msg));
    const batchSize = Math.max(1, options?.batchSize ?? 20);
    const events: RawEventInput[] = [];
    let batchesFetched = 0;

    for (let i = 0; i < positionIds.length; i += batchSize) {
        batchesFetched++;
        const batch = positionIds.slice(i, i + batchSize);
        const params = new URLSearchParams();
        params.set("positionIds", batch.join(","));

        log(`[FABRIQ-TX] Fetching transactions batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(positionIds.length / batchSize)} (${batch.length} positions)...`);

        const fetchOpts: FabriqFetchOptions = { onLog: log };
        const txRes = await fabriqFetch<unknown>(
            `/history/transactions`,
            params,
            fetchOpts
        );

        let dataNode: unknown = txRes;
        if (txRes && typeof txRes === "object" && "data" in txRes) {
            dataNode = (txRes as Record<string, unknown>).data;
        }

        const rawEventList: Record<string, unknown>[] = [];

        if (dataNode && typeof dataNode === "object" && !Array.isArray(dataNode)) {
            const mapObj = dataNode as Record<string, unknown>;
            for (const [posId, list] of Object.entries(mapObj)) {
                if (Array.isArray(list)) {
                    for (const item of list) {
                        if (item && typeof item === "object") {
                            const rec = item as Record<string, unknown>;
                            rawEventList.push({
                                ...rec,
                                position_id: rec.position_id || rec.positionId || posId,
                            });
                        }
                    }
                }
            }
        } else if (Array.isArray(dataNode)) {
            for (const item of dataNode) {
                if (item && typeof item === "object") {
                    rawEventList.push(item as Record<string, unknown>);
                }
            }
        }

        for (const tx of rawEventList) {
            const positionId = String(tx.position_id || tx.positionId || tx.position || "");
            const poolId = String(tx.pool_id || tx.poolId || positionToPoolMap.get(positionId) || "");
            const rawId = String(tx.id || tx._id || "");
            const rawType = String(tx.type || tx.rawType || tx.action || "UNKNOWN");
            const createdAt = String(tx.created_at || tx.createdAt || tx.timestamp || "");
            const signature = String(tx.signature || tx.tx_hash || tx.txHash || "");
            const source = String(tx.source || "wallet");

            const numOrNull = (val: unknown): number | null => {
                if (val === null || val === undefined || val === "") return null;
                const n = Number(val);
                return Number.isFinite(n) ? n : null;
            };

            events.push({
                rawId,
                rawType,
                positionId,
                poolId,
                createdAt,
                signature,
                source,
                tokenXAmount: numOrNull(tx.token_x_amount ?? tx.tokenXAmount),
                tokenYAmount: numOrNull(tx.token_y_amount ?? tx.tokenYAmount),
                tokenXAmountUsd: numOrNull(tx.token_x_amount_usd ?? tx.tokenXAmountUsd),
                tokenYAmountUsd: numOrNull(tx.token_y_amount_usd ?? tx.tokenYAmountUsd),
                tokenXAmountSol: numOrNull(tx.token_x_amount_sol ?? tx.tokenXAmountSol),
                tokenYAmountSol: numOrNull(tx.token_y_amount_sol ?? tx.tokenYAmountSol),
                totalInUsd: numOrNull(tx.total_in_usd ?? tx.totalInUsd ?? tx.total_usd),
                totalInSol: numOrNull(tx.total_in_sol ?? tx.totalInSol ?? tx.total_sol),
                raw: tx,
            });
        }
    }

    log(`[FABRIQ-TX] Fetched ${events.length} transaction events across ${positionIds.length} positions in ${batchesFetched} batches`);

    return {
        wallet,
        events,
        batchesFetched,
    };
}
