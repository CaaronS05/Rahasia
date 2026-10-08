import fs from "node:fs";
import path from "node:path";
import type {
    AnalyticsPeriod,
    NormalizedPositionRecord,
    PositionAnalyticsDataset,
    PositionSamplingMeta,
    TimeframeMeta,
    SourceCoverageMeta,
    OverallDataQualitySummary,
    ExtractionDiagnostics,
    LifecycleTransactionItem,
    InitialEntryStatus,
    TransactionCoverageStatus,
    PositionCompletenessStatus,
} from "./position-analytics-types.ts";

export interface RawPositionInput {
    id: string;
    pool_id: string;
    source?: string;
    total_add_usd?: number | null;
    total_add_sol?: number | null;
    total_rem_usd?: number | null;
    total_rem_sol?: number | null;
    total_fee_usd?: number | null;
    total_fee_sol?: number | null;
    total_pnl_usd?: number | null;
    total_pnl_sol?: number | null;
    total_pnl_pct_usd?: number | null;
    total_pnl_pct_sol?: number | null;
    latest_close_ts?: string | number | null;
    opened_at?: string | number | null;
    duration?: number | null;
    raw?: Record<string, unknown> | null;
}

export interface RawEventInput {
    rawId?: string;
    rawType?: string;
    category?: string;
    positionId?: string;
    poolId?: string;
    createdAt?: string;
    signature?: string;
    source?: string;
    tokenXAmount?: number | null;
    tokenYAmount?: number | null;
    tokenXAmountUsd?: number | null;
    tokenYAmountUsd?: number | null;
    tokenXAmountSol?: number | null;
    tokenYAmountSol?: number | null;
    totalInUsd?: number | null;
    totalInSol?: number | null;
    raw?: Record<string, unknown> | null;
}

export interface PoolMetadataLookupItem {
    address: string;
    name?: string;
    binStep?: number | null;
    tokenX?: {
        address?: string;
        symbol?: string;
        name?: string;
    };
    tokenY?: {
        address?: string;
        symbol?: string;
        name?: string;
    };
}

let poolMetadataCache: Map<string, PoolMetadataLookupItem> | null = null;

export function loadPoolMetadataCache(customPath?: string): Map<string, PoolMetadataLookupItem> {
    if (poolMetadataCache && !customPath) {
        return poolMetadataCache;
    }

    const targetPath = customPath
        ? path.resolve(customPath)
        : path.resolve("data/pools/legacy-dlmm-pools.json");

    const cache = new Map<string, PoolMetadataLookupItem>();

    try {
        if (fs.existsSync(targetPath)) {
            const raw = fs.readFileSync(targetPath, "utf8");
            const data = JSON.parse(raw);
            const poolList: unknown[] = Array.isArray(data?.pools) ? data.pools : [];
            for (const item of poolList) {
                if (item && typeof item === "object") {
                    const p = item as Record<string, unknown>;
                    if (p.address) {
                        const tokX = p.tokenX && typeof p.tokenX === "object" ? (p.tokenX as Record<string, unknown>) : null;
                        const tokY = p.tokenY && typeof p.tokenY === "object" ? (p.tokenY as Record<string, unknown>) : null;
                        cache.set(String(p.address), {
                            address: String(p.address),
                            name: typeof p.name === "string" ? p.name : undefined,
                            binStep: typeof p.binStep === "number" ? p.binStep : null,
                            tokenX: tokX ? {
                                address: typeof tokX.address === "string" ? tokX.address : undefined,
                                symbol: typeof tokX.symbol === "string" ? tokX.symbol : undefined,
                                name: typeof tokX.name === "string" ? tokX.name : undefined,
                            } : undefined,
                            tokenY: tokY ? {
                                address: typeof tokY.address === "string" ? tokY.address : undefined,
                                symbol: typeof tokY.symbol === "string" ? tokY.symbol : undefined,
                                name: typeof tokY.name === "string" ? tokY.name : undefined,
                            } : undefined,
                        });
                    }
                }
            }
        }
    } catch {
        // Fallback: empty metadata cache
    }

    if (!customPath) {
        poolMetadataCache = cache;
    }
    return cache;
}

export function parseTimestampMs(ts: unknown): number | null {
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

export function parseIsoTimestamp(ts: unknown): string | null {
    const ms = parseTimestampMs(ts);
    return ms !== null ? new Date(ms).toISOString() : null;
}

/**
 * Filter positions based on close timestamp eligibility and timeframe window.
 */
export function filterPositionsByTimeframe(
    positions: RawPositionInput[],
    period: AnalyticsPeriod,
    snapshotTimestampMs: number,
    diagnostics?: { skippedRecords?: Array<{ positionId?: string; poolAddress?: string; reason: string }> }
): {
    eligible: RawPositionInput[];
    rejected: Array<{ position: RawPositionInput; reason: string }>;
    effectiveStart: string | null;
    effectiveEnd: string;
    firstAvailableTimestamp: string | null;
    lastAvailableTimestamp: string | null;
} {
    const effectiveEnd = new Date(snapshotTimestampMs).toISOString();
    let effectiveStart: string | null = null;
    let windowStartMs = 0;

    if (period === "30D") {
        windowStartMs = snapshotTimestampMs - 30 * 24 * 60 * 60 * 1000;
        effectiveStart = new Date(windowStartMs).toISOString();
    } else if (period === "90D") {
        windowStartMs = snapshotTimestampMs - 90 * 24 * 60 * 60 * 1000;
        effectiveStart = new Date(windowStartMs).toISOString();
    } else {
        windowStartMs = 0;
        effectiveStart = null;
    }

    const eligible: RawPositionInput[] = [];
    const rejected: Array<{ position: RawPositionInput; reason: string }> = [];

    let minCloseMs: number | null = null;
    let maxCloseMs: number | null = null;

    for (const pos of positions) {
        const rawCloseTs = pos.latest_close_ts ?? pos.raw?.latest_close_ts ?? pos.raw?.closed_at ?? pos.raw?.closedAt;
        const closeMs = parseTimestampMs(rawCloseTs);

        if (closeMs === null) {
            const reason = "MISSING_OR_INVALID_CLOSED_AT";
            rejected.push({ position: pos, reason });
            diagnostics?.skippedRecords?.push({
                positionId: pos.id,
                poolAddress: pos.pool_id,
                reason,
            });
            continue;
        }

        if (minCloseMs === null || closeMs < minCloseMs) minCloseMs = closeMs;
        if (maxCloseMs === null || closeMs > maxCloseMs) maxCloseMs = closeMs;

        if (closeMs > snapshotTimestampMs) {
            const reason = "FUTURE_CLOSED_AT_AFTER_SNAPSHOT";
            rejected.push({ position: pos, reason });
            diagnostics?.skippedRecords?.push({
                positionId: pos.id,
                poolAddress: pos.pool_id,
                reason,
            });
            continue;
        }

        if (period !== "ALL_AVAILABLE" && closeMs < windowStartMs) {
            const reason = "OUTSIDE_TIMEFRAME_WINDOW";
            rejected.push({ position: pos, reason });
            // Not a skip diagnostic since it's normal window boundary
            continue;
        }

        eligible.push(pos);
    }

    return {
        eligible,
        rejected,
        effectiveStart,
        effectiveEnd,
        firstAvailableTimestamp: minCloseMs !== null ? new Date(minCloseMs).toISOString() : null,
        lastAvailableTimestamp: maxCloseMs !== null ? new Date(maxCloseMs).toISOString() : null,
    };
}

/**
 * Deduplicate positions using poolAddress + positionId with deterministic resolution.
 */
export function deduplicatePositions(
    positions: RawPositionInput[],
    warnings?: string[]
): {
    deduplicated: RawPositionInput[];
    duplicatesRemoved: number;
} {
    const keyMap = new Map<string, RawPositionInput>();
    let duplicatesRemoved = 0;

    for (const pos of positions) {
        const key = `${pos.pool_id}:${pos.id}`;
        if (!keyMap.has(key)) {
            keyMap.set(key, pos);
        } else {
            duplicatesRemoved++;
            const existing = keyMap.get(key)!;
            // Deterministic conflict resolution: prefer record with richer non-null fields
            const existingScore = (existing.total_add_usd != null ? 1 : 0) + (existing.total_pnl_usd != null ? 1 : 0) + (existing.opened_at != null ? 1 : 0);
            const newScore = (pos.total_add_usd != null ? 1 : 0) + (pos.total_pnl_usd != null ? 1 : 0) + (pos.opened_at != null ? 1 : 0);

            const shouldReplace =
                newScore > existingScore ||
                (newScore === existingScore && (pos.total_add_usd ?? 0) > (existing.total_add_usd ?? 0));

            if (shouldReplace) {
                keyMap.set(key, pos);
                warnings?.push(`Conflict resolved for position ${key}: replaced with richer record`);
            } else {
                warnings?.push(`Duplicate position ${key} ignored`);
            }
        }
    }

    return {
        deduplicated: Array.from(keyMap.values()),
        duplicatesRemoved,
    };
}

/**
 * Compare two positions for sorting:
 * 1. closedAt DESC (newest first)
 * 2. poolAddress ASC
 * 3. positionId ASC
 */
export function comparePositionsLatestClosedDesc(a: RawPositionInput, b: RawPositionInput): number {
    const aTime = parseTimestampMs(a.latest_close_ts) ?? 0;
    const bTime = parseTimestampMs(b.latest_close_ts) ?? 0;

    if (bTime !== aTime) {
        return bTime - aTime;
    }

    const poolComp = (a.pool_id || "").localeCompare(b.pool_id || "");
    if (poolComp !== 0) {
        return poolComp;
    }

    return (a.id || "").localeCompare(b.id || "");
}

/**
 * Select the latest 1000 closed positions.
 */
export function sampleLatest1000Positions(
    positions: RawPositionInput[],
    maxPositions = 1000
): {
    selected: RawPositionInput[];
    samplingMeta: PositionSamplingMeta;
    observedStart: string | null;
    observedEnd: string | null;
} {
    const sorted = positions.slice().sort(comparePositionsLatestClosedDesc);
    const totalEligiblePositions = sorted.length;
    const analyzedPositions = Math.min(totalEligiblePositions, maxPositions);
    const excludedPositions = Math.max(0, totalEligiblePositions - analyzedPositions);
    const selected = sorted.slice(0, analyzedPositions);

    const coveragePct = totalEligiblePositions > 0
        ? Number(((analyzedPositions / totalEligiblePositions) * 100).toFixed(2))
        : 100;

    const isSampled = totalEligiblePositions > maxPositions;

    let observedStart: string | null = null;
    let observedEnd: string | null = null;

    if (selected.length > 0) {
        const timestamps = selected
            .map((p) => parseTimestampMs(p.latest_close_ts))
            .filter((t): t is number => t !== null);

        if (timestamps.length > 0) {
            observedStart = new Date(Math.min(...timestamps)).toISOString();
            observedEnd = new Date(Math.max(...timestamps)).toISOString();
        }
    }

    return {
        selected,
        samplingMeta: {
            totalEligiblePositions,
            analyzedPositions,
            excludedPositions,
            duplicatesRemoved: 0,
            coveragePct,
            isSampled,
            selectionMethod: "LATEST_CLOSED_1000",
        },
        observedStart,
        observedEnd,
    };
}

/**
 * Extract USD amount from a raw transaction event without double counting.
 */
function extractEventUsdAmount(ev: RawEventInput): number | null {
    if (ev.totalInUsd !== null && ev.totalInUsd !== undefined && Number.isFinite(ev.totalInUsd) && ev.totalInUsd > 0) {
        return Number(ev.totalInUsd);
    }

    const xUsd = ev.tokenXAmountUsd !== null && ev.tokenXAmountUsd !== undefined ? Number(ev.tokenXAmountUsd) : null;
    const yUsd = ev.tokenYAmountUsd !== null && ev.tokenYAmountUsd !== undefined ? Number(ev.tokenYAmountUsd) : null;

    if ((xUsd !== null && Number.isFinite(xUsd)) || (yUsd !== null && Number.isFinite(yUsd))) {
        const sum = (xUsd ?? 0) + (yUsd ?? 0);
        return sum > 0 ? Number(sum.toFixed(6)) : 0;
    }

    if (ev.totalInUsd === 0) {
        return 0;
    }

    return null;
}

/**
 * Reconstruct position lifecycle events and derive initial entry amount.
 */
export function reconstructPositionLifecycle(
    wallet: string,
    pos: RawPositionInput,
    rawEvents: RawEventInput[],
    metadataCache?: Map<string, PoolMetadataLookupItem>
): NormalizedPositionRecord {
    // 1. Group events for this exact position
    const matchingEvents = rawEvents.filter((e) => {
        const posMatch = e.positionId === pos.id || e.raw?.position_id === pos.id || e.raw?.positionId === pos.id;
        const poolMatch = !e.poolId || e.poolId === pos.pool_id || e.raw?.pool_id === pos.pool_id;
        return posMatch && poolMatch;
    });

    // 2. Deterministic chronological sort: createdAt ASC, signature ASC, rawId ASC
    matchingEvents.sort((a, b) => {
        const timeA = parseTimestampMs(a.createdAt) ?? 0;
        const timeB = parseTimestampMs(b.createdAt) ?? 0;
        if (timeA !== timeB) return timeA - timeB;

        const sigA = a.signature || "";
        const sigB = b.signature || "";
        if (sigA !== sigB) return sigA.localeCompare(sigB);

        const idA = String(a.rawId || a.raw?.id || "");
        const idB = String(b.rawId || b.raw?.id || "");
        return idA.localeCompare(idB);
    });

    const normalizedEvents: LifecycleTransactionItem[] = matchingEvents.map((e) => {
        const rawType = String(e.rawType || e.raw?.type || e.raw?.action || "UNKNOWN");
        let category: LifecycleTransactionItem["category"] = "unknown";

        if (rawType === "POSITION_OPEN" || rawType === "initialize") {
            category = "initialize";
        } else if (rawType === "ADD_LIQUIDITY" || rawType === "add") {
            category = "add";
        } else if (rawType === "REMOVE_LIQUIDITY" || rawType === "remove") {
            category = "remove";
        } else if (rawType === "FEE_CLAIM" || rawType === "claim_fee") {
            category = "claim_fee";
        } else if (rawType === "POSITION_CLOSE" || rawType === "close") {
            category = "close";
        }

        const totalInUsd = extractEventUsdAmount(e);

        return {
            rawId: String(e.rawId || e.raw?.id || ""),
            rawType,
            category,
            createdAt: parseIsoTimestamp(e.createdAt) || new Date().toISOString(),
            signature: String(e.signature || e.raw?.signature || ""),
            source: String(e.source || e.raw?.source || "wallet"),
            tokenXAmount: e.tokenXAmount != null ? Number(e.tokenXAmount) : null,
            tokenYAmount: e.tokenYAmount != null ? Number(e.tokenYAmount) : null,
            tokenXAmountUsd: e.tokenXAmountUsd != null ? Number(e.tokenXAmountUsd) : null,
            tokenYAmountUsd: e.tokenYAmountUsd != null ? Number(e.tokenYAmountUsd) : null,
            totalInUsd,
        };
    });

    const openEvent = normalizedEvents.find((e) => e.category === "initialize" || e.rawType === "POSITION_OPEN");
    const closeEvent = normalizedEvents.find((e) => e.category === "close" || e.rawType === "POSITION_CLOSE");

    const openingEventObserved = Boolean(openEvent);
    const closingEventObserved = Boolean(closeEvent);

    let initialEntryUsd: number | null = null;
    let firstObservedAddUsd: number | null = null;
    let initialEntryStatus: InitialEntryStatus = "UNAVAILABLE";
    const warnings: string[] = [];

    // Track used event indices for liquidity adds to prevent double-counting
    const usedAddEventIndices = new Set<number>();

    if (openEvent) {
        const openUsd = openEvent.totalInUsd;
        if (openUsd !== null && openUsd > 0) {
            initialEntryUsd = openUsd;
            initialEntryStatus = "VERIFIED_OPEN_EVENT";
        } else {
            // Check for associated ADD_LIQUIDITY in the same transaction signature or within 1s
            const openTimeMs = parseTimestampMs(openEvent.createdAt) ?? 0;
            const associatedAddIdx = normalizedEvents.findIndex((e, idx) => {
                if (e.category !== "add" && e.rawType !== "ADD_LIQUIDITY") return false;
                const sameSig = Boolean(openEvent.signature && e.signature && openEvent.signature === e.signature);
                const eventTimeMs = parseTimestampMs(e.createdAt) ?? 0;
                const timeDiffMs = Math.abs(eventTimeMs - openTimeMs);
                return sameSig || timeDiffMs <= 1000;
            });

            if (associatedAddIdx >= 0) {
                const addEvent = normalizedEvents[associatedAddIdx];
                const addUsd = addEvent.totalInUsd;
                if (addUsd !== null && addUsd > 0) {
                    initialEntryUsd = addUsd;
                    initialEntryStatus = "VERIFIED_ASSOCIATED_ADD";
                    usedAddEventIndices.add(associatedAddIdx);
                } else if (openUsd === 0 || addUsd === 0) {
                    initialEntryUsd = 0;
                    initialEntryStatus = "VERIFIED_ASSOCIATED_ADD";
                    usedAddEventIndices.add(associatedAddIdx);
                } else {
                    initialEntryStatus = "UNAVAILABLE";
                    warnings.push("Opening event has no associated liquidity amount");
                }
            } else if (openUsd === 0) {
                initialEntryUsd = 0;
                initialEntryStatus = "VERIFIED_OPEN_EVENT";
            } else {
                initialEntryStatus = "UNAVAILABLE";
                warnings.push("POSITION_OPEN event found but initial liquidity amount unavailable");
            }
        }
    } else {
        // No open event observed: look for first observed add
        const firstAddIdx = normalizedEvents.findIndex(
            (e) => e.category === "add" || e.rawType === "ADD_LIQUIDITY"
        );
        if (firstAddIdx >= 0) {
            const firstAdd = normalizedEvents[firstAddIdx];
            firstObservedAddUsd = firstAdd.totalInUsd;
            initialEntryStatus = "FIRST_OBSERVED_ADD_ONLY";
            warnings.push("Missing POSITION_OPEN event; first observed addition recorded separately");
        } else {
            initialEntryStatus = "UNAVAILABLE";
            warnings.push("No opening or liquidity addition events observed");
        }
    }

    // 3. Additional liquidity calculation (subsequent add events)
    let additionalLiquidityUsd: number | null = null;
    let cumulativeAddUsd = 0;
    let addEventsCount = 0;

    normalizedEvents.forEach((e, idx) => {
        if (e.category === "add" || e.rawType === "ADD_LIQUIDITY") {
            if (usedAddEventIndices.has(idx)) {
                return; // Skip associated opening addition
            }
            addEventsCount++;
            if (e.totalInUsd !== null) {
                cumulativeAddUsd += e.totalInUsd;
            }
        }
    });

    if (initialEntryStatus === "VERIFIED_OPEN_EVENT" || initialEntryStatus === "VERIFIED_ASSOCIATED_ADD") {
        additionalLiquidityUsd = Number(cumulativeAddUsd.toFixed(6));
    } else if (addEventsCount > 0) {
        additionalLiquidityUsd = Number(cumulativeAddUsd.toFixed(6));
    }

    // 4. Totals (deposits, withdrawals, fees)
    let totalDepositsUsd: number | null = null;
    if (initialEntryUsd !== null && additionalLiquidityUsd !== null) {
        totalDepositsUsd = Number((initialEntryUsd + additionalLiquidityUsd).toFixed(6));
    } else if (pos.total_add_usd != null && Number.isFinite(pos.total_add_usd)) {
        totalDepositsUsd = Number(pos.total_add_usd);
    }

    let totalWithdrawalsUsd: number | null = null;
    let cumulativeRemUsd = 0;
    let hasRemEvents = false;
    for (const e of normalizedEvents) {
        if (e.category === "remove" || e.rawType === "REMOVE_LIQUIDITY") {
            hasRemEvents = true;
            if (e.totalInUsd !== null) {
                cumulativeRemUsd += e.totalInUsd;
            }
        }
    }
    if (hasRemEvents) {
        totalWithdrawalsUsd = Number(cumulativeRemUsd.toFixed(6));
    } else if (pos.total_rem_usd != null && Number.isFinite(pos.total_rem_usd)) {
        totalWithdrawalsUsd = Number(pos.total_rem_usd);
    }

    let claimedFeesUsd: number | null = null;
    let cumulativeFeeUsd = 0;
    let hasFeeEvents = false;
    for (const e of normalizedEvents) {
        if (e.category === "claim_fee" || e.rawType === "FEE_CLAIM") {
            hasFeeEvents = true;
            if (e.totalInUsd !== null) {
                cumulativeFeeUsd += e.totalInUsd;
            }
        }
    }
    if (hasFeeEvents) {
        claimedFeesUsd = Number(cumulativeFeeUsd.toFixed(6));
    } else if (pos.total_fee_usd != null && Number.isFinite(pos.total_fee_usd)) {
        claimedFeesUsd = Number(pos.total_fee_usd);
    }

    // 5. Reconcile reconstructed amounts with position summary
    if (pos.total_add_usd != null && totalDepositsUsd !== null) {
        const diff = Math.abs(pos.total_add_usd - totalDepositsUsd);
        if (diff > 1.0) {
            warnings.push(
                `Deposit total divergence: reconstructed $${totalDepositsUsd.toFixed(2)} vs summary $${pos.total_add_usd.toFixed(2)}`
            );
        }
    }

    // 6. Timestamps and duration
    const openedAt = parseIsoTimestamp(pos.opened_at ?? openEvent?.createdAt);
    const closedAt = parseIsoTimestamp(pos.latest_close_ts ?? closeEvent?.createdAt)!;

    let holdDurationSeconds: number | null = null;
    if (openedAt && closedAt) {
        const openMs = parseTimestampMs(openedAt)!;
        const closeMs = parseTimestampMs(closedAt)!;
        if (closeMs >= openMs) {
            holdDurationSeconds = Math.round((closeMs - openMs) / 1000);
        }
    }
    if (holdDurationSeconds === null && pos.duration != null) {
        holdDurationSeconds = Math.round(Number(pos.duration));
    }

    // 7. PnL and Win/Loss
    const pnlUsd = pos.total_pnl_usd != null ? Number(pos.total_pnl_usd) : null;
    const pnlPct = pos.total_pnl_pct_usd != null ? Number(pos.total_pnl_pct_usd) : null;

    let winLoss: "WIN" | "LOSS" | "BREAKEVEN" = "BREAKEVEN";
    if (pnlUsd !== null) {
        if (pnlUsd > 0.0001) winLoss = "WIN";
        else if (pnlUsd < -0.0001) winLoss = "LOSS";
    }

    // 8. Data quality statuses
    let transactionCoverage: TransactionCoverageStatus = "NO_TRANSACTIONS";
    if (normalizedEvents.length > 0) {
        transactionCoverage = openingEventObserved && closingEventObserved ? "FULL_LIFECYCLE" : "PARTIAL_EVENTS";
    }

    let positionCompleteness: PositionCompletenessStatus = "COMPLETE";
    if (!openingEventObserved) positionCompleteness = "MISSING_OPEN_EVENT";
    else if (!closingEventObserved) positionCompleteness = "MISSING_CLOSE_EVENT";
    else if (initialEntryUsd === null || totalDepositsUsd === null) positionCompleteness = "INCOMPLETE_AMOUNTS";

    // 9. Metadata enrichment
    const meta = metadataCache?.get(pos.pool_id);
    const rawPool = pos.raw?.pool;

    const tokenXMint = meta?.tokenX?.address || rawPool?.tokenX?.address || rawPool?.token_x || null;
    const tokenYMint = meta?.tokenY?.address || rawPool?.tokenY?.address || rawPool?.token_y || null;
    const tokenXSymbol = meta?.tokenX?.symbol || rawPool?.tokenX?.symbol || null;
    const tokenYSymbol = meta?.tokenY?.symbol || rawPool?.tokenY?.symbol || null;
    const pairName = meta?.name || (tokenXSymbol && tokenYSymbol ? `${tokenXSymbol}-${tokenYSymbol}` : null);
    const binStep = meta?.binStep ?? rawPool?.binStep ?? rawPool?.bin_step ?? null;

    return {
        wallet,
        positionId: pos.id,
        poolAddress: pos.pool_id,
        source: String(pos.source || "wallet"),

        tokenXMint,
        tokenYMint,
        tokenXSymbol,
        tokenYSymbol,
        pairName,
        binStep,

        openedAt,
        closedAt,
        holdDurationSeconds,

        initialEntryUsd,
        firstObservedAddUsd,
        additionalLiquidityUsd,
        totalDepositsUsd,
        totalWithdrawalsUsd,
        claimedFeesUsd,

        pnlUsd,
        pnlPct,
        winLoss,

        lifecycle: {
            openingEventObserved,
            closingEventObserved,
            events: normalizedEvents,
            eventCount: normalizedEvents.length,
        },

        dataQuality: {
            initialEntryStatus,
            transactionCoverage,
            positionCompleteness,
            warnings,
        },
    };
}

/**
 * Build the full position analytics dataset from extracted raw pools, positions, and events.
 */
export function buildPositionAnalyticsDataset(options: {
    wallet: string;
    period: AnalyticsPeriod;
    snapshotTimestampMs?: number;
    rawPositions: RawPositionInput[];
    rawEvents: RawEventInput[];
    fabriqPoolsDiscovered: number;
    dlmmPoolsMatched: number;
    metadataCache?: Map<string, PoolMetadataLookupItem>;
    diagnostics?: Partial<ExtractionDiagnostics>;
}): PositionAnalyticsDataset {
    const {
        wallet,
        period,
        snapshotTimestampMs = Date.now(),
        rawPositions,
        rawEvents,
        fabriqPoolsDiscovered,
        dlmmPoolsMatched,
        metadataCache = loadPoolMetadataCache(),
        diagnostics = {},
    } = options;

    const diagSkipped: ExtractionDiagnostics["skippedRecords"] = [];

    // 1. Filter positions by period window and close eligibility
    const {
        eligible,
        effectiveStart,
        effectiveEnd,
        firstAvailableTimestamp,
        lastAvailableTimestamp,
    } = filterPositionsByTimeframe(rawPositions, period, snapshotTimestampMs, {
        skippedRecords: diagSkipped,
    });

    // 2. Deduplicate positions by poolAddress + positionId
    const warnings: string[] = [];
    const { deduplicated, duplicatesRemoved } = deduplicatePositions(eligible, warnings);

    // 3. Sample latest 1000 closed positions
    const {
        selected,
        samplingMeta,
        observedStart,
        observedEnd,
    } = sampleLatest1000Positions(deduplicated, 1000);
    samplingMeta.duplicatesRemoved = duplicatesRemoved;

    // 4. Reconstruct lifecycle and derive initial entry for selected positions
    const normalizedPositions: NormalizedPositionRecord[] = [];
    let initialEntriesVerified = 0;
    let initialEntriesUnavailable = 0;
    let firstObservedAddOnly = 0;
    let fullLifecycleCoveragePositions = 0;

    for (const pos of selected) {
        const norm = reconstructPositionLifecycle(wallet, pos, rawEvents, metadataCache);
        normalizedPositions.push(norm);

        if (
            norm.dataQuality.initialEntryStatus === "VERIFIED_OPEN_EVENT" ||
            norm.dataQuality.initialEntryStatus === "VERIFIED_ASSOCIATED_ADD"
        ) {
            initialEntriesVerified++;
        } else if (norm.dataQuality.initialEntryStatus === "FIRST_OBSERVED_ADD_ONLY") {
            firstObservedAddOnly++;
        } else {
            initialEntriesUnavailable++;
        }

        if (norm.dataQuality.transactionCoverage === "FULL_LIFECYCLE") {
            fullLifecycleCoveragePositions++;
        }
    }

    const initialEntryCoveragePct = normalizedPositions.length > 0
        ? Number(((initialEntriesVerified / normalizedPositions.length) * 100).toFixed(2))
        : 100;

    const sourceCoverageStatus = dlmmPoolsMatched === 0
        ? "UNAVAILABLE"
        : samplingMeta.isSampled
        ? "BOUNDED_HISTORY"
        : "COMPLETE";

    const timeframe: TimeframeMeta = {
        requestedPeriod: period,
        effectiveStart,
        effectiveEnd,
        firstAvailableTimestamp,
        lastAvailableTimestamp,
        observedStart,
        observedEnd,
    };

    const sourceCoverage: SourceCoverageMeta = {
        status: sourceCoverageStatus,
        fabriqPoolsDiscovered,
        dlmmPoolsMatched,
        totalPositionsFound: rawPositions.length,
        totalEligiblePositions: samplingMeta.totalEligiblePositions,
    };

    const dataQuality: OverallDataQualitySummary = {
        validClosedPositions: normalizedPositions.length,
        initialEntriesVerified,
        initialEntriesUnavailable,
        firstObservedAddOnly,
        initialEntryCoveragePct,
        fullLifecycleCoveragePositions,
        warnings,
    };

    const finalDiagnostics: ExtractionDiagnostics = {
        executionMs: diagnostics.executionMs ?? 0,
        poolPagesFetched: diagnostics.poolPagesFetched ?? 0,
        positionBatchesFetched: diagnostics.positionBatchesFetched ?? 0,
        transactionBatchesFetched: diagnostics.transactionBatchesFetched ?? 0,
        requestRetries: diagnostics.requestRetries ?? 0,
        skippedRecords: [...diagSkipped, ...(diagnostics.skippedRecords ?? [])],
    };

    return {
        schemaVersion: "v1",
        wallet,
        period,
        dataSource: "fabriq",
        fetchedAt: new Date(snapshotTimestampMs).toISOString(),
        timeframe,
        sourceCoverage,
        sampling: samplingMeta,
        dataQuality,
        positions: normalizedPositions,
        diagnostics: finalDiagnostics,
    };
}
