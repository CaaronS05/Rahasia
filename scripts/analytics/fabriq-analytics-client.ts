import {
    fabriqFetch,
    isFabriqDlmmPool,
    type FabriqFetchOptions,
    type FabriqFetchCooldownCoordinator,
    SharedCooldownCoordinator,
} from "../discovery/core/fabriq-position-history.ts";
import {
    loadTransactionCheckpointRecord,
    saveTransactionCheckpointRecord,
    type TransactionCheckpoint,
    type CheckpointBatchRecord,
} from "./position-analytics-storage.ts";
import type { AnalyticsPeriod } from "./position-analytics-types.ts";
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
    fromCheckpoint?: boolean;
    checkpoint?: TransactionCheckpoint | null;
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
    worker: (item: TItem, index: number, signal?: AbortSignal) => Promise<TResult>;
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

    const queueAbortController = new AbortController();

    const { promise, resolve, reject } = Promise.withResolvers<{ results: TResult[]; stats: BoundedQueueStats }>();

    const checkTermination = () => {
        if (activeCount === 0) {
            isTerminated = true;
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
                reject(signal.reason ?? new Error("Operation aborted"));
            } else if (failureError) {
                reject(failureError);
            } else {
                resolve({
                    results,
                    stats: {
                        totalItems: total,
                        peakInFlight,
                        durationMs: Date.now() - startTime,
                    },
                });
            }
        }
    };

    const onAbort = () => {
        isTerminated = true;
        queueAbortController.abort(signal?.reason ?? new Error("Operation aborted"));
        checkTermination();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const launchNext = () => {
        if (isTerminated || signal?.aborted || failureError) {
            checkTermination();
            return;
        }

        if (nextIndex >= total) {
            checkTermination();
            return;
        }

        while (activeCount < maxConcurrency && nextIndex < total && !isTerminated && !signal?.aborted && !failureError) {
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

            const workerSignal = signal
                ? AbortSignal.any([signal, queueAbortController.signal])
                : queueAbortController.signal;

            worker(currentItem, currentIndex, workerSignal)
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

                    if (!failureError && !signal?.aborted) {
                        failureError = err;
                        isTerminated = true;
                        queueAbortController.abort(err);
                    }
                    launchNext();
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
        worker: async (batch: string[], _batchIdx, workerSignal) => {
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
                signal: workerSignal,
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
export interface FabriqFetchTransactionsOptions extends ClientLoggingOptions {
    batchSize?: number;
    concurrency?: number;
    timeoutMs?: number;
    max404Retries?: number;
    delay404Ms?: number;
    signal?: AbortSignal;
    cooldownCoordinator?: FabriqFetchCooldownCoordinator;
    checkpointBaseDir?: string;
    period?: AnalyticsPeriod;
    maxCheckpointAgeMs?: number;
    force?: boolean;
    checkpoint?: TransactionCheckpoint | null;
    disableCheckpoint?: boolean;
    onBatchSaved?: (checkpoint: TransactionCheckpoint) => void;
}

function parseRawEventsFromResponse(
    txRes: unknown,
    positionToPoolMap: Map<string, string>
): RawEventInput[] {
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

    const numOrNull = (val: unknown): number | null => {
        if (val === null || val === undefined || val === "") return null;
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
    };

    const batchEvents: RawEventInput[] = [];
    for (const tx of rawEventList) {
        const positionId = String(tx.position_id || tx.positionId || tx.position || "");
        const poolId = String(tx.pool_id || tx.poolId || positionToPoolMap.get(positionId) || "");
        const rawId = String(tx.id || tx._id || "");
        const rawType = String(tx.type || tx.rawType || tx.action || "UNKNOWN");
        const createdAt = String(tx.created_at || tx.createdAt || tx.timestamp || "");
        const signature = String(tx.signature || tx.tx_hash || tx.txHash || "");
        const source = String(tx.source || "wallet");

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
}

interface BatchSpec {
    batchIndex: number;
    positionIds: string[];
}

/**
 * Fetch lifecycle transactions for selected position IDs in bounded batches.
 * Supports incremental checkpoints, resumable execution, and coordinated cancellation.
 */
export async function fetchTransactionsForPositions(
    wallet: string,
    positionIds: string[],
    positionToPoolMap: Map<string, string>,
    options?: FabriqFetchTransactionsOptions
): Promise<FabriqFetchTransactionsResult> {
    const log = options?.onLog ?? ((msg: string) => console.log(msg));
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_TRANSACTIONS_BATCH_SIZE);
    const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_TRANSACTIONS_CONCURRENCY);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const cooldownCoordinator = options?.cooldownCoordinator ?? defaultPositionAnalyticsCooldown;

    const allBatches: BatchSpec[] = [];
    for (let i = 0; i < positionIds.length; i += batchSize) {
        allBatches.push({
            batchIndex: Math.floor(i / batchSize),
            positionIds: positionIds.slice(i, i + batchSize),
        });
    }

    if (positionIds.length === 0) {
        return {
            wallet,
            events: [],
            batchesFetched: 0,
            configuredConcurrency: concurrency,
            peakInFlight: 0,
            durationMs: 0,
            retryCount: 0,
            rateLimit429Count: 0,
            duplicatesRemoved: 0,
            fromCheckpoint: false,
            checkpoint: null,
        };
    }

    const useCheckpoint = !options?.force && !options?.disableCheckpoint;
    let existingCheckpoint: TransactionCheckpoint | null = null;

    if (useCheckpoint) {
        existingCheckpoint = options?.checkpoint !== undefined
            ? options.checkpoint
            : loadTransactionCheckpointRecord(wallet, positionIds, {
                baseDir: options?.checkpointBaseDir,
                period: options?.period,
                maxAgeMs: options?.maxCheckpointAgeMs,
            });
    }

    const completedBatchMap = new Map<number, { positionIds: string[]; events: RawEventInput[]; completedAt: string }>();
    const completedPositionIdsSet = new Set<string>();

    if (existingCheckpoint) {
        if (Array.isArray(existingCheckpoint.batchRecords)) {
            for (const rec of existingCheckpoint.batchRecords) {
                completedBatchMap.set(rec.batchIndex, {
                    positionIds: rec.positionIds,
                    events: rec.events || [],
                    completedAt: rec.completedAt,
                });
                for (const pid of rec.positionIds) {
                    completedPositionIdsSet.add(pid);
                }
            }
        } else if (existingCheckpoint.isComplete) {
            for (const pid of existingCheckpoint.completedPositionIds) {
                completedPositionIdsSet.add(pid);
            }
        }
    }

    if (existingCheckpoint && existingCheckpoint.isComplete && positionIds.every((id) => completedPositionIdsSet.has(id))) {
        log(`[FABRIQ-TX] Reused complete checkpoint for ${positionIds.length} positions (${existingCheckpoint.events.length} events). No network requests needed.`);
        return {
            wallet,
            events: existingCheckpoint.events,
            batchesFetched: 0,
            configuredConcurrency: concurrency,
            peakInFlight: 0,
            durationMs: 0,
            retryCount: 0,
            rateLimit429Count: 0,
            duplicatesRemoved: 0,
            fromCheckpoint: true,
            checkpoint: existingCheckpoint,
        };
    }

    const pendingBatches = allBatches.filter((b) => !b.positionIds.every((pid) => completedPositionIdsSet.has(pid)));
    const alreadyCompletedBatchesCount = allBatches.length - pendingBatches.length;

    if (alreadyCompletedBatchesCount > 0) {
        log(`[FABRIQ-TX] Resuming from checkpoint: ${alreadyCompletedBatchesCount}/${allBatches.length} batches (${completedPositionIdsSet.size}/${positionIds.length} positions) already complete. Fetching ${pendingBatches.length} remaining batches...`);
    } else {
        log(`[FABRIQ-TX] Starting transactions fetch for ${positionIds.length} positions across ${allBatches.length} batches (concurrency: ${concurrency}, batchSize: ${batchSize}, timeout: ${Math.round(timeoutMs / 1000)}s)`);
    }

    const persistCheckpoint = () => {
        if (options?.disableCheckpoint) return null;

        const sortedIndices = Array.from(completedBatchMap.keys()).sort((a, b) => a - b);
        const allRawEvents = sortedIndices.flatMap((idx) => completedBatchMap.get(idx)!.events);
        const { deduplicated } = deduplicateRawEvents(allRawEvents);

        const completedPositions = Array.from(completedPositionIdsSet);
        const isComplete = positionIds.length > 0 && positionIds.every((id) => completedPositionIdsSet.has(id));

        const batchRecords: CheckpointBatchRecord[] = sortedIndices.map((idx) => {
            const rec = completedBatchMap.get(idx)!;
            return {
                batchIndex: idx,
                positionIds: rec.positionIds,
                eventCount: rec.events.length,
                completedAt: rec.completedAt,
                events: rec.events,
            };
        });

        const checkpoint: TransactionCheckpoint = {
            schemaVersion: "v2",
            wallet: wallet.trim(),
            savedAt: new Date().toISOString(),
            period: options?.period,
            selectedPositionIds: positionIds,
            completedPositionIds: completedPositions,
            completedBatchIndices: sortedIndices,
            batchRecords,
            events: deduplicated,
            isComplete,
            coverage: {
                totalSelectedPositions: positionIds.length,
                completedPositionsCount: completedPositions.length,
                totalBatches: allBatches.length,
                completedBatchesCount: completedBatchMap.size,
                isComplete,
            },
            positionIds: completedPositions,
        };

        saveTransactionCheckpointRecord(checkpoint, {
            baseDir: options?.checkpointBaseDir,
            period: options?.period,
        });

        options?.onBatchSaved?.(checkpoint);
        return checkpoint;
    };

    let retryCount = 0;
    let rateLimit429Count = 0;

    const queueResult = await runBoundedWorkerQueue({
        items: pendingBatches,
        concurrency,
        signal: options?.signal,
        worker: async (batchSpec: BatchSpec, _workerIdx, workerSignal) => {
            const params = new URLSearchParams();
            params.set("positionIds", batchSpec.positionIds.join(","));

            const fetchOpts: FabriqFetchOptions = {
                onLog: log,
                max404Retries: options?.max404Retries ?? DEFAULT_MAX_404_RETRIES,
                delay404Ms: options?.delay404Ms ?? DEFAULT_DELAY_404_MS,
                timeoutMs,
                signal: workerSignal,
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

            const batchEvents = parseRawEventsFromResponse(txRes, positionToPoolMap);

            // Record batch completion (even if batchEvents is empty with 0 events)
            completedBatchMap.set(batchSpec.batchIndex, {
                positionIds: batchSpec.positionIds,
                events: batchEvents,
                completedAt: new Date().toISOString(),
            });
            for (const pid of batchSpec.positionIds) {
                completedPositionIdsSet.add(pid);
            }

            // Atomically update and persist checkpoint
            persistCheckpoint();

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

    const sortedIndices = Array.from(completedBatchMap.keys()).sort((a, b) => a - b);
    const allEvents = sortedIndices.flatMap((idx) => completedBatchMap.get(idx)!.events);
    const { deduplicated, duplicatesRemoved } = deduplicateRawEvents(allEvents);

    const finalCheckpoint = persistCheckpoint();

    log(`[FABRIQ-TX] Fetched ${deduplicated.length} transaction events across ${positionIds.length} positions in ${allBatches.length} batches (${queueResult.stats.durationMs}ms, peak in-flight: ${queueResult.stats.peakInFlight}, retries: ${retryCount}, 429s: ${rateLimit429Count})`);

    return {
        wallet,
        events: deduplicated,
        batchesFetched: pendingBatches.length,
        configuredConcurrency: concurrency,
        peakInFlight: queueResult.stats.peakInFlight,
        durationMs: queueResult.stats.durationMs,
        retryCount,
        rateLimit429Count,
        duplicatesRemoved,
        fromCheckpoint: false,
        checkpoint: finalCheckpoint,
    };
}
