import {
    DEFAULT_FABRIQ_CDP_URL,
    getFabriqCdpUrl,
    fabriqFetch,
    isFabriqDlmmPool,
    parseSafeNumber,
    type FabriqFetchOptions,
    type FabriqFetchCooldownCoordinator,
    SharedCooldownCoordinator,
} from "../discovery/core/fabriq-position-history.ts";

export { DEFAULT_FABRIQ_CDP_URL, getFabriqCdpUrl };
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

export interface FabriqPoolCumulativeAggregate {
    poolAddress: string;
    wallet: string;
    positionCount: number | null;
    cumulativePnlUsd: number | null;
    cumulativePnlPct: number | null;
    cumulativeDurationSeconds: number | null;
    earliestOpenedAt: string | null;
    latestClosedAt: string | null;
    totalAddUsd: number | null;
    totalRemUsd: number | null;
    totalFeeUsd: number | null;
    pair?: string;
    source: "Fabriq";
    updatedAt: string;
    selectionFingerprint?: string;
    refreshFailed?: boolean;
    refreshError?: string;
    refreshPending?: boolean;
}

export function parseSafeIsoDate(val: unknown): string | null {
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
            d = new Date(String(val));
        }
    }
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return null;
    return d.toISOString();
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
    onRetry?: (info: { status?: number; attempt: number; delayMs: number; error?: unknown }) => void;
    max404Retries?: number;
    delay404Ms?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    concurrency?: number;
    cooldownCoordinator?: FabriqFetchCooldownCoordinator;
}
export interface AdaptiveLimiterOptions {
    maxConcurrency?: number;
    minConcurrency?: number;
    minIntervalMs?: number;
    onConcurrencyChange?: (newConcurrency: number, reason: string) => void;
}

export class AdaptiveRequestLimiter {
    private maxConcurrency: number;
    private minConcurrency: number;
    private currentConcurrency: number;
    private activeCount = 0;
    private queue: Array<() => void> = [];
    private consecutiveSuccesses = 0;
    private recoveryThreshold = 5;
    private minIntervalMs: number;
    private lastDispatchTime = 0;
    private timer: NodeJS.Timeout | null = null;
    private onConcurrencyChange?: (newConcurrency: number, reason: string) => void;

    constructor(options: AdaptiveLimiterOptions = {}) {
        this.maxConcurrency = Math.min(8, Math.max(1, options.maxConcurrency ?? 8));
        this.minConcurrency = Math.max(1, options.minConcurrency ?? 1);
        this.currentConcurrency = this.maxConcurrency;
        this.minIntervalMs = options.minIntervalMs ?? 50;
        this.onConcurrencyChange = options.onConcurrencyChange;
    }

    getConcurrency(): number {
        return this.currentConcurrency;
    }

    getActiveCount(): number {
        return this.activeCount;
    }

    async acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
        return new Promise<void>((resolve, reject) => {
            const onAbort = () => {
                const idx = this.queue.indexOf(resume);
                if (idx !== -1) this.queue.splice(idx, 1);
                reject(signal?.reason ?? new Error("Operation aborted"));
            };
            const resume = () => {
                signal?.removeEventListener("abort", onAbort);
                this.activeCount++;
                this.lastDispatchTime = Date.now();
                resolve();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.queue.push(resume);
            this.scheduleDrain();
        });
    }

    release(): void {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.scheduleDrain();
    }

    recordSuccess(): void {
        this.consecutiveSuccesses++;
        if (this.consecutiveSuccesses >= this.recoveryThreshold) {
            this.consecutiveSuccesses = 0;
            if (this.currentConcurrency < this.maxConcurrency) {
                this.currentConcurrency++;
                this.onConcurrencyChange?.(this.currentConcurrency, "recovery_step");
                this.scheduleDrain();
            }
        }
    }

    recordError(status?: number): void {
        this.consecutiveSuccesses = 0;
        if (status === 429 || (status !== undefined && status >= 500)) {
            const prev = this.currentConcurrency;
            this.currentConcurrency = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency / 2));
            if (this.currentConcurrency !== prev) {
                this.onConcurrencyChange?.(this.currentConcurrency, `backoff_${status}`);
            }
        }
    }

    private scheduleDrain(): void {
        if (this.timer) return;
        const now = Date.now();
        const waitMs = Math.max(0, this.lastDispatchTime + this.minIntervalMs - now);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.drain();
        }, waitMs);
    }

    private drain(): void {
        while (this.queue.length > 0 && this.activeCount < this.currentConcurrency) {
            const next = this.queue.shift();
            if (next) {
                next();
            }
        }
        if (this.queue.length > 0 && this.activeCount < this.currentConcurrency) {
            this.scheduleDrain();
        }
    }
}

export function extractPoolSearchQueries(pairOrSymbol?: string): string[] {
    if (!pairOrSymbol || typeof pairOrSymbol !== "string") return [];
    const clean = pairOrSymbol.trim();
    if (!clean) return [];

    const GENERIC_TOKENS: Record<string, true> = { SOL: true, WSOL: true, USDC: true, USDT: true };
    const parts = clean.split(/[\/\-\s]+/).map((s) => s.trim()).filter(Boolean);

    if (parts.length <= 1) {
        return parts.length === 1 ? [parts[0]] : [];
    }

    const baseSymbol = parts[0];
    const quoteSymbol = parts[1];

    const isBaseGeneric = Boolean(GENERIC_TOKENS[baseSymbol.toUpperCase()]);
    const isQuoteGeneric = Boolean(GENERIC_TOKENS[quoteSymbol.toUpperCase()]);

    const queries: string[] = [];

    // Prioritize specific/non-generic token symbol
    if (!isBaseGeneric) {
        queries.push(baseSymbol);
    }
    if (!isQuoteGeneric) {
        queries.push(quoteSymbol);
    }

    // Fallback if both tokens are generic (e.g. USDC before SOL)
    if (queries.length === 0) {
        if (quoteSymbol.toUpperCase() !== "SOL" && quoteSymbol.toUpperCase() !== "WSOL") {
            queries.push(quoteSymbol);
            queries.push(baseSymbol);
        } else {
            queries.push(baseSymbol);
            queries.push(quoteSymbol);
        }
    }

    return Array.from(new Set(queries));
}

export interface CumulativeFetchStats {
    searchMode: "server_search" | "pagination" | "search_fallback_to_pagination";
    queries: string[];
    targetPoolIds: string[];
    pagesFetched: number;
    totalHttpRequests: number;
    http500Count: number;
    http429Count: number;
    retriesCount: number;
    activeConcurrency: number;
    durationMs: number;
}

export interface CumulativeFetchOptions extends ClientLoggingOptions {
    poolQueries?: string[];
    limiter?: AdaptiveRequestLimiter;
    onStats?: (stats: CumulativeFetchStats) => void;
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
function isSolanaAddressCaseMismatch(candidate: string, canonical: string): boolean {
    if (candidate === canonical || candidate.length !== canonical.length) return false;
    for (let i = 0; i < candidate.length; i++) {
        const codeA = candidate.charCodeAt(i);
        const codeB = canonical.charCodeAt(i);
        if (codeA === codeB) continue;
        const isUpperA = codeA >= 65 && codeA <= 90;
        const isLowerA = codeA >= 97 && codeA <= 122;
        const isUpperB = codeB >= 65 && codeB <= 90;
        const isLowerB = codeB >= 97 && codeB <= 122;
        if ((isUpperA && isLowerB && codeA + 32 === codeB) || (isLowerA && isUpperB && codeB + 32 === codeA)) {
            continue;
        }
        return false;
    }
    return true;
}

/**
 * Fetch official Fabriq cumulative DLMM aggregates per pool for a wallet via GET /history/<wallet>/pnl-by-pool.
 */
export async function fetchWalletPoolCumulativeAggregates(
    wallet: string,
    poolIds?: string[],
    options?: CumulativeFetchOptions
): Promise<FabriqPoolCumulativeAggregate[]> {
    const log = options?.onLog ?? ((msg: string) => console.log(msg));
    log(`[FABRIQ-CUM] Fetching cumulative aggregates for wallet: ${wallet}`);
    const allowedPoolIds = poolIds && poolIds.length > 0 ? new Set(poolIds.map((p) => p.trim())) : null;
    const targetPoolIdList = allowedPoolIds ? Array.from(allowedPoolIds) : [];
    const aggregates: FabriqPoolCumulativeAggregate[] = [];
    const matchedTargetPoolIds = new Set<string>();
    const allSeenPoolAddresses = new Set<string>();

    const rawQueries = options?.poolQueries || [];
    const queries = Array.from(new Set(rawQueries.map((q) => q.trim()).filter(Boolean)));

    let totalHttpRequests = 0;
    let pagesFetched = 0;
    let http500Count = 0;
    let http429Count = 0;
    let retriesCount = 0;
    const startTimeMs = Date.now();

    const handleRetry = (info: { status?: number; attempt: number; delayMs: number; error?: unknown }) => {
        retriesCount++;
        if (info.status && info.status >= 500) http500Count++;
        if (info.status === 429) http429Count++;
        options?.limiter?.recordError(info.status);
        options?.onRetry?.(info);
    };

    const executePageRequest = async (params: URLSearchParams): Promise<unknown> => {
        totalHttpRequests++;
        pagesFetched++;
        if (options?.limiter) {
            await options.limiter.acquire(options?.signal);
        }
        const fetchOpts: FabriqFetchOptions = {
            onLog: log,
            onRetry: handleRetry,
            max404Retries: options?.max404Retries ?? DEFAULT_MAX_404_RETRIES,
            delay404Ms: options?.delay404Ms ?? DEFAULT_DELAY_404_MS,
            timeoutMs: options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            signal: options?.signal,
            cooldownCoordinator: options?.cooldownCoordinator ?? defaultPositionAnalyticsCooldown,
        };
        try {
            const resJson = await fabriqFetch<unknown>(
                `/history/${wallet}/pnl-by-pool`,
                params,
                fetchOpts
            );
            options?.limiter?.recordSuccess();
            return resJson;
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("500") || errMsg.includes("Server error 5")) http500Count++;
            if (errMsg.includes("429") || errMsg.includes("RATE_LIMITED")) http429Count++;
            options?.limiter?.recordError();
            throw err;
        } finally {
            options?.limiter?.release();
        }
    };

    const extractItemsAndMeta = (resJson: unknown): { pageItems: unknown[]; paginationMeta: Record<string, unknown> | null } => {
        let pageItems: unknown[] = [];
        let paginationMeta: Record<string, unknown> | null = null;
        if (Array.isArray(resJson)) {
            pageItems = resJson;
        } else if (resJson && typeof resJson === "object") {
            const container = resJson as Record<string, unknown>;
            if (container.pagination && typeof container.pagination === "object") {
                paginationMeta = container.pagination as Record<string, unknown>;
            } else if (container.meta && typeof container.meta === "object") {
                paginationMeta = container.meta as Record<string, unknown>;
            }

            const dataNode = container.data;
            if (Array.isArray(dataNode)) {
                pageItems = dataNode;
            } else if (dataNode && typeof dataNode === "object") {
                const inner = dataNode as Record<string, unknown>;
                if (inner.pagination && typeof inner.pagination === "object") {
                    paginationMeta = inner.pagination as Record<string, unknown>;
                } else if (inner.meta && typeof inner.meta === "object") {
                    paginationMeta = inner.meta as Record<string, unknown>;
                }
                if (Array.isArray(inner.items)) pageItems = inner.items;
                else if (Array.isArray(inner.pools)) pageItems = inner.pools;
                else if (Array.isArray(inner.data)) pageItems = inner.data;
            } else if (Array.isArray(container.items)) {
                pageItems = container.items;
            } else if (Array.isArray(container.pools)) {
                pageItems = container.pools;
            }
        }
        return { pageItems, paginationMeta };
    };

    const processItems = (pageItems: unknown[]): boolean => {
        let hasNewPoolOnPage = false;
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
            const poolAddress = poolIdCandidate.trim();
            if (!poolAddress) continue;

            if (!allSeenPoolAddresses.has(poolAddress)) {
                allSeenPoolAddresses.add(poolAddress);
                hasNewPoolOnPage = true;
            }

            if (allowedPoolIds && !allowedPoolIds.has(poolAddress)) {
                for (const canonical of allowedPoolIds) {
                    if (isSolanaAddressCaseMismatch(poolAddress, canonical)) {
                        log(
                            `[FABRIQ-CUM] [${wallet}] Diagnostic: pool_id casing mismatch detected. Fabriq returned "${poolAddress}" but canonical is "${canonical}". Solana Base58 addresses are case-sensitive; treating as non-matching.`
                        );
                        break;
                    }
                }
                continue;
            }

            const matchedPoolAddress = poolAddress;
            if (matchedTargetPoolIds.has(matchedPoolAddress)) continue;
            matchedTargetPoolIds.add(matchedPoolAddress);
            let pair: string | undefined;
            if (poolObj) {
                const tokenX = poolObj.tokenX && typeof poolObj.tokenX === "object" ? (poolObj.tokenX as Record<string, unknown>) : null;
                const tokenY = poolObj.tokenY && typeof poolObj.tokenY === "object" ? (poolObj.tokenY as Record<string, unknown>) : null;
                const symX = typeof tokenX?.symbol === "string" ? tokenX.symbol : "";
                const symY = typeof tokenY?.symbol === "string" ? tokenY.symbol : "";
                if (symX && symY) {
                    pair = `${symX}-${symY}`;
                }
            }

            aggregates.push({
                poolAddress: matchedPoolAddress,
                wallet,
                positionCount: parseSafeNumber(row.position_count),
                cumulativePnlUsd: parseSafeNumber(row.total_pnl_usd),
                cumulativePnlPct: parseSafeNumber(row.total_pnl_pct_usd),
                cumulativeDurationSeconds: parseSafeNumber(row.duration),
                earliestOpenedAt: parseSafeIsoDate(row.earliest_open_ts),
                latestClosedAt: parseSafeIsoDate(row.latest_close_ts),
                totalAddUsd: parseSafeNumber(row.total_add_usd),
                totalRemUsd: parseSafeNumber(row.total_rem_usd),
                totalFeeUsd: parseSafeNumber(row.total_fee_usd),
                pair,
                source: "Fabriq",
                updatedAt: new Date().toISOString(),
            });
        }
        return hasNewPoolOnPage;
    };

    const buildBaseParams = (pageNum: number): URLSearchParams => {
        const params = new URLSearchParams();
        params.set("page", String(pageNum));
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
        return params;
    };

    let searchMode: "server_search" | "pagination" | "search_fallback_to_pagination" = "server_search";

    // PHASE 1: Server-side search if pool queries are provided and target pools specified
    if (queries.length > 0 && allowedPoolIds && allowedPoolIds.size > 0) {
        for (const query of queries) {
            if (Array.from(allowedPoolIds).every((id) => matchedTargetPoolIds.has(id))) break;

            let queryPage = 1;
            while (true) {
                const params = buildBaseParams(queryPage);
                params.set("symbol", query);

                const pageStartTime = Date.now();
                const resJson = await executePageRequest(params);
                const reqDurationMs = Date.now() - pageStartTime;

                const { pageItems, paginationMeta } = extractItemsAndMeta(resJson);
                log(`[FABRIQ-CUM] [${wallet}] [SEARCH: ${query}] Page ${queryPage}: fetched ${pageItems.length} items (${reqDurationMs}ms)`);

                if (pageItems.length === 0) break;

                processItems(pageItems);

                if (Array.from(allowedPoolIds).every((id) => matchedTargetPoolIds.has(id))) break;
                if (pageItems.length < 100) break;

                if (paginationMeta) {
                    const totalPages = parseSafeNumber(paginationMeta.totalPages ?? paginationMeta.total_pages);
                    if (totalPages !== null && queryPage >= totalPages) break;
                    if (paginationMeta.hasMore === false || paginationMeta.has_more === false) break;
                    const totalCount = parseSafeNumber(paginationMeta.totalCount ?? paginationMeta.total ?? paginationMeta.count);
                    if (totalCount !== null && (queryPage - 1) * 100 + pageItems.length >= totalCount) break;
                }
                queryPage++;
            }
        }
    }

    // PHASE 2: Fallback to pagination if targets remain unresolved or no search queries provided
    const needsPagination = allowedPoolIds
        ? !Array.from(allowedPoolIds).every((id) => matchedTargetPoolIds.has(id))
        : true;
    if (needsPagination) {
        if (queries.length > 0 && allowedPoolIds && allowedPoolIds.size > 0) {
            searchMode = "search_fallback_to_pagination";
            log(`[FABRIQ-CUM] [${wallet}] Server search did not resolve all targets (${matchedTargetPoolIds.size}/${allowedPoolIds.size}); falling back to pagination`);
        } else {
            searchMode = "pagination";
        }

        let page = 1;
        while (true) {
            const params = buildBaseParams(page);

            const pageStartTime = Date.now();
            const resJson = await executePageRequest(params);
            const reqDurationMs = Date.now() - pageStartTime;

            const { pageItems, paginationMeta } = extractItemsAndMeta(resJson);
            log(`[FABRIQ-CUM] [${wallet}] Page ${page}: fetched ${pageItems.length} items (${reqDurationMs}ms)`);

            if (pageItems.length === 0) break;

            const hasNew = processItems(pageItems);

            if (allowedPoolIds && Array.from(allowedPoolIds).every((id) => matchedTargetPoolIds.has(id))) break;
            if (pageItems.length < 100) break;

            if (!hasNew) {
                log(`[FABRIQ-CUM] [${wallet}] Page ${page}: no new pools discovered; terminating pagination`);
                if (allowedPoolIds && !Array.from(allowedPoolIds).every((id) => matchedTargetPoolIds.has(id))) {
                    throw new Error(
                        `[FABRIQ-CUM] Pagination stagnant: page ${page} returned duplicate pools before all target pools were resolved`
                    );
                }
                break;
            }

            if (paginationMeta) {
                const totalPages = parseSafeNumber(paginationMeta.totalPages ?? paginationMeta.total_pages);
                if (totalPages !== null && page >= totalPages) break;
                if (paginationMeta.hasMore === false || paginationMeta.has_more === false) break;
                const totalCount = parseSafeNumber(paginationMeta.totalCount ?? paginationMeta.total ?? paginationMeta.count);
                if (totalCount !== null && (page - 1) * 100 + pageItems.length >= totalCount) break;
            }

            page++;
        }
    }

    const durationMs = Date.now() - startTimeMs;
    const activeConcurrency = options?.limiter?.getConcurrency() ?? 1;

    const stats: CumulativeFetchStats = {
        searchMode,
        queries,
        targetPoolIds: targetPoolIdList,
        pagesFetched,
        totalHttpRequests,
        http500Count,
        http429Count,
        retriesCount,
        activeConcurrency,
        durationMs,
    };

    log(
        `[FABRIQ-CUM] [${wallet}] mode=${searchMode} queries=${queries.join(",") || "none"} targets=${targetPoolIdList.join(",") || "none"} aggs=${aggregates.length} pages=${pagesFetched} reqs=${totalHttpRequests} 500=${http500Count} 429=${http429Count} retries=${retriesCount} concurrency=${activeConcurrency} (${durationMs}ms)`
    );

    options?.onStats?.(stats);
    return aggregates;
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
