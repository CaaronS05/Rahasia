import {
    fabriqFetch,
    isFabriqDlmmPool,
    type FabriqFetchOptions,
    type FabriqFetchCooldownCoordinator,
    SharedCooldownCoordinator,
} from "../discovery/core/fabriq-position-history.ts";
import {
    deduplicateRawEvents,
    type RawPositionInput,
    type RawEventInput,
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
    configuredConcurrency?: number;
    peakInFlight?: number;
    durationMs?: number;
    retryCount?: number;
    rateLimit429Count?: number;
}

export interface FabriqFetchTransactionsResult {
    wallet: string;
    events: RawEventInput[];
    batchesFetched: number;
    configuredConcurrency?: number;
    peakInFlight?: number;
    durationMs?: number;
    retryCount?: number;
    rateLimit429Count?: number;
    duplicatesRemoved?: number;
}

export const DEFAULT_MAX_404_RETRIES = Number(process.env.FABRIQ_MAX_404_RETRIES ?? "3");
export const DEFAULT_DELAY_404_MS = Number(process.env.FABRIQ_404_DELAY_MS ?? "5000");
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_POSITIONS_CONCURRENCY = 2;
export const DEFAULT_TRANSACTIONS_CONCURRENCY = 3;
export const DEFAULT_POSITIONS_BATCH_SIZE = 25;
export const DEFAULT_TRANSACTIONS_BATCH_SIZE = 20;

export const defaultPositionAnalyticsCooldown = new SharedCooldownCoordinator();

export interface ClientLoggingOptions {
    onLog?: (msg: string) => void;
    max404Retries?: number;
    delay404Ms?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    concurrency?: number;
    cooldownCoordinator?: FabriqFetchCooldownCoordinator;
}

export interface BoundedQueueOptions<TItem, TResult> {
    items: TItem[];
    concurrency: number;
    worker: (item: TItem, index: number) => Promise<TResult>;
    signal?: AbortSignal;
    onProgress?: (progress: {
        index: number;
        total: number;
        active: number;
        peak: number;
        stage: "start" | "success" | "error";
        durationMs?: number;
    }) => void;
}

export interface BoundedQueueStats {
    totalItems: number;
    peakInFlight: number;
    durationMs: number;
}

/**
 * Generic bounded worker queue preserving item order and failing fast on error.
 */
export async function runBoundedWorkerQueue<TItem, TResult>(
    options: BoundedQueueOptions<TItem, TResult>
): Promise<{ results: TResult[]; stats: BoundedQueueStats }> {
    const { items, concurrency, worker, signal, onProgress } = options;
    const total = items.length;
    if (total === 0) {
        return {
            results: [],
            stats: { totalItems: 0, peakInFlight: 0, durationMs: 0 },
        };
    }

    if (signal?.aborted) {
        throw signal.reason ?? new Error("Operation aborted");
    }

    const maxConcurrency = Math.max(1, Math.min(concurrency, total));
    const results: TResult[] = new Array(total);
    let nextIndex = 0;
    let activeCount = 0;
    let peakInFlight = 0;
    let failureError: unknown = null;
    let isTerminated = false;
    const startTime = Date.now();

    const { promise, resolve, reject } = Promise.withResolvers<{ results: TResult[]; stats: BoundedQueueStats }>();

    const onAbort = () => {
        isTerminated = true;
        reject(signal?.reason ?? new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const launchNext = () => {
        if (isTerminated || signal?.aborted) return;

        if (failureError) {
            isTerminated = true;
            signal?.removeEventListener("abort", onAbort);
            reject(failureError);
            return;
        }

        if (nextIndex >= total) {
            if (activeCount === 0) {
                isTerminated = true;
                signal?.removeEventListener("abort", onAbort);
                resolve({
                    results,
                    stats: {
                        totalItems: total,
                        peakInFlight,
                        durationMs: Date.now() - startTime,
                    },
                });
            }
            return;
        }

        while (activeCount < maxConcurrency && nextIndex < total && !isTerminated) {
            const currentIndex = nextIndex++;
            const currentItem = items[currentIndex];
            activeCount++;
            if (activeCount > peakInFlight) {
                peakInFlight = activeCount;
            }

            const itemStart = Date.now();
            onProgress?.({
                index: currentIndex,
                total,
                active: activeCount,
                peak: peakInFlight,
                stage: "start",
            });

            worker(currentItem, currentIndex)
                .then((res) => {
                    results[currentIndex] = res;
                    activeCount--;
                    onProgress?.({
                        index: currentIndex,
                        total,
                        active: activeCount,
                        peak: peakInFlight,
                        stage: "success",
                        durationMs: Date.now() - itemStart,
                    });
                    launchNext();
                })
                .catch((err: unknown) => {
                    activeCount--;
                    onProgress?.({
                        index: currentIndex,
                        total,
                        active: activeCount,
                        peak: peakInFlight,
                        stage: "error",
                        durationMs: Date.now() - itemStart,
                    });
                    if (!failureError) {
                        failureError = err;
                    }
                    isTerminated = true;
                    signal?.removeEventListener("abort", onAbort);
                    reject(failureError);
                });
        }
    };

    launchNext();
    return promise;
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
        const fetchOpts: FabriqFetchOptions = {
            onLog: log,
            max404Retries: options?.max404Retries ?? DEFAULT_MAX_404_RETRIES,
            delay404Ms: options?.delay404Ms ?? DEFAULT_DELAY_404_MS,
            timeoutMs: options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            signal: options?.signal,
            cooldownCoordinator: options?.cooldownCoordinator ?? defaultPositionAnalyticsCooldown,
        };
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
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_POSITIONS_BATCH_SIZE);
    const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_POSITIONS_CONCURRENCY);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const cooldownCoordinator = options?.cooldownCoordinator ?? defaultPositionAnalyticsCooldown;
    const allowedPoolIds = new Set(poolIds);

    const batches: string[][] = [];
    for (let i = 0; i < poolIds.length; i += batchSize) {
        batches.push(poolIds.slice(i, i + batchSize));
    }

    log(`[FABRIQ-POS] Starting positions fetch for ${poolIds.length} pools across ${batches.length} batches (concurrency: ${concurrency}, batchSize: ${batchSize}, timeout: ${Math.round(timeoutMs / 1000)}s)`);

    let retryCount = 0;
    let rateLimit429Count = 0;

    const queueResult = await runBoundedWorkerQueue({
        items: batches,
        concurrency,
        signal: options?.signal,
        worker: async (batch: string[]) => {
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

            const fetchOpts: FabriqFetchOptions = {
                onLog: log,
                max404Retries: options?.max404Retries ?? DEFAULT_MAX_404_RETRIES,
                delay404Ms: options?.delay404Ms ?? DEFAULT_DELAY_404_MS,
                timeoutMs,
                signal: options?.signal,
                cooldownCoordinator,
                onRetry: (info) => {
                    retryCount++;
                    if (info.status === 429) rateLimit429Count++;
                },
            };

            const posRes = await fabriqFetch<unknown>(
                `/history/${wallet}/positions-by-pool`,
                params,
                fetchOpts
            );

            let dataNode: unknown = posRes;
            if (posRes && typeof posRes === "object" && "data" in posRes) {
                dataNode = (posRes as Record<string, unknown>).data;
            }

            const batchPositions: RawPositionInput[] = [];

            if (dataNode && typeof dataNode === "object" && !Array.isArray(dataNode)) {
                const mapObj = dataNode as Record<string, unknown>;
                for (const [poolIdKey, list] of Object.entries(mapObj)) {
                    if (!allowedPoolIds.has(poolIdKey)) continue;
                    if (Array.isArray(list)) {
                        for (const item of list) {
                            if (!item || typeof item !== "object") continue;
                            const pos = item as Record<string, unknown>;
                            if (!pos.id) continue;
                            batchPositions.push(normalizeRawPositionRecord(pos, poolIdKey));
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
                    batchPositions.push(normalizeRawPositionRecord(pos, poolId));
                }
            }

            return batchPositions;
        },
        onProgress: (p) => {
            const batchNum = p.index + 1;
            if (p.stage === "start") {
                log(`[FABRIQ-POS] [Batch ${batchNum}/${p.total}] Fetching batch | active: ${p.active}/${concurrency} (peak: ${p.peak})`);
            } else if (p.stage === "success") {
                log(`[FABRIQ-POS] [Batch ${batchNum}/${p.total}] Completed in ${p.durationMs}ms | active: ${p.active}/${concurrency}`);
            } else if (p.stage === "error") {
                log(`[FABRIQ-POS] [Batch ${batchNum}/${p.total}] FAILED after ${p.durationMs}ms`);
            }
        },
    });

    // Flatten in strict batch order
    const positions: RawPositionInput[] = queueResult.results.flatMap((batchPositions) => batchPositions);

    log(`[FABRIQ-POS] Fetched ${positions.length} positions across ${poolIds.length} pools in ${batches.length} batches (${queueResult.stats.durationMs}ms, peak in-flight: ${queueResult.stats.peakInFlight}, retries: ${retryCount}, 429s: ${rateLimit429Count})`);

    return {
        wallet,
        positions,
        batchesFetched: batches.length,
        configuredConcurrency: concurrency,
        peakInFlight: queueResult.stats.peakInFlight,
        durationMs: queueResult.stats.durationMs,
        retryCount,
        rateLimit429Count,
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
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_TRANSACTIONS_BATCH_SIZE);
    const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_TRANSACTIONS_CONCURRENCY);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const cooldownCoordinator = options?.cooldownCoordinator ?? defaultPositionAnalyticsCooldown;

    const batches: string[][] = [];
    for (let i = 0; i < positionIds.length; i += batchSize) {
        batches.push(positionIds.slice(i, i + batchSize));
    }

    log(`[FABRIQ-TX] Starting transactions fetch for ${positionIds.length} positions across ${batches.length} batches (concurrency: ${concurrency}, batchSize: ${batchSize}, timeout: ${Math.round(timeoutMs / 1000)}s)`);

    let retryCount = 0;
    let rateLimit429Count = 0;

    const queueResult = await runBoundedWorkerQueue({
        items: batches,
        concurrency,
        signal: options?.signal,
        worker: async (batch: string[]) => {
            const params = new URLSearchParams();
            params.set("positionIds", batch.join(","));

            const fetchOpts: FabriqFetchOptions = {
                onLog: log,
                max404Retries: options?.max404Retries ?? DEFAULT_MAX_404_RETRIES,
                delay404Ms: options?.delay404Ms ?? DEFAULT_DELAY_404_MS,
                timeoutMs,
                signal: options?.signal,
                cooldownCoordinator,
                onRetry: (info) => {
                    retryCount++;
                    if (info.status === 429) rateLimit429Count++;
                },
            };

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

            const batchEvents: RawEventInput[] = [];
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

                batchEvents.push({
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
                    totalInSol: numOrNull(tx.total_in_sol ?? tx.totalInSol ?? tx.total_usd),
                    raw: tx,
                });
            }

            return batchEvents;
        },
        onProgress: (p) => {
            const batchNum = p.index + 1;
            if (p.stage === "start") {
                log(`[FABRIQ-TX] [Batch ${batchNum}/${p.total}] Fetching batch | active: ${p.active}/${concurrency} (peak: ${p.peak})`);
            } else if (p.stage === "success") {
                log(`[FABRIQ-TX] [Batch ${batchNum}/${p.total}] Completed in ${p.durationMs}ms | active: ${p.active}/${concurrency}`);
            } else if (p.stage === "error") {
                log(`[FABRIQ-TX] [Batch ${batchNum}/${p.total}] FAILED after ${p.durationMs}ms`);
            }
        },
    });

    // Flatten in strict batch order
    const allEvents: RawEventInput[] = queueResult.results.flatMap((batchEvents) => batchEvents);

    // Conservative deduplication of duplicate events with strong identity evidence
    const { deduplicated, duplicatesRemoved } = deduplicateRawEvents(allEvents);
    if (duplicatesRemoved > 0) {
        log(`[FABRIQ-TX] Deduplicated ${duplicatesRemoved} redundant event records (${deduplicated.length} retained)`);
    }

    log(`[FABRIQ-TX] Fetched ${deduplicated.length} transaction events across ${positionIds.length} positions in ${batches.length} batches (${queueResult.stats.durationMs}ms, peak in-flight: ${queueResult.stats.peakInFlight}, retries: ${retryCount}, 429s: ${rateLimit429Count})`);

    return {
        wallet,
        events: deduplicated,
        batchesFetched: batches.length,
        configuredConcurrency: concurrency,
        peakInFlight: queueResult.stats.peakInFlight,
        durationMs: queueResult.stats.durationMs,
        retryCount,
        rateLimit429Count,
        duplicatesRemoved,
    };
}
