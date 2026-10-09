import fs from "node:fs";
import path from "node:path";
import type {
    AnalyticsPeriod,
    MeteoraMissingOrAmbiguousRecord,
    MeteoraTokenFlowComparison,
    MeteoraUsdComparison,
    MeteoraVerificationClassification,
    MeteoraVerificationReport,
    MeteoraVerificationSourceProvenance,
    MeteoraVerificationSummary,
    MonetaryPrecisionValue,
    NormalizedPositionRecord,
    PositionAnalyticsBundle,
    PositionAnalyticsDataset,
    PositionVerificationDetail,
} from "./position-analytics-types.ts";

export const DEFAULT_METEORA_API_BASE = "https://dlmm.datapi.meteora.ag";
export const DEFAULT_VERIFICATION_STORAGE_BASE = "data/analytics/verification";

// ======================================================
// MONETARY PRECISION & VALUE PARSING
// ======================================================

/**
 * Parse an API monetary string or number while strictly preserving exact decimal precision
 * and raw string representation. Never converts null/undefined to zero.
 */
export function parseMonetaryString(
    value: string | number | null | undefined
): MonetaryPrecisionValue | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") {
            return null;
        }
        const numeric = Number(trimmed);
        if (!Number.isFinite(numeric)) {
            return null;
        }

        const dotIndex = trimmed.indexOf(".");
        const decimalPlaces = dotIndex >= 0 ? trimmed.length - dotIndex - 1 : 0;

        return {
            rawString: trimmed,
            numeric,
            decimalPlaces,
        };
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return null;
        }
        const rawString = value.toString();
        const dotIndex = rawString.indexOf(".");
        const decimalPlaces = dotIndex >= 0 ? rawString.length - dotIndex - 1 : 0;

        return {
            rawString,
            numeric: value,
            decimalPlaces,
        };
    }

    return null;
}

// ======================================================
// METEORA API INTERFACES
// ======================================================

export interface MeteoraTokenFlow {
    amount?: string | number | null;
    usd?: string | number | null;
    amountSol?: string | number | null;
}

export interface MeteoraTokenPairWithTotal {
    tokenX?: MeteoraTokenFlow | null;
    tokenY?: MeteoraTokenFlow | null;
    total?: {
        usd?: string | number | null;
        sol?: string | number | null;
    } | null;
}

export interface MeteoraApiPositionPnLData {
    positionAddress: string;
    poolAddress?: string;
    userAddress?: string;
    isClosed?: boolean;
    createdAt?: number | string | null;
    closedAt?: number | string | null;
    updatedAt?: number | string | null;
    minPrice?: string | null;
    maxPrice?: string | null;
    lowerBinId?: number | null;
    upperBinId?: number | null;
    pnlUsd?: string | number | null;
    pnlPctChange?: string | number | null;
    pnlSol?: string | number | null;
    pnlSolPctChange?: string | number | null;
    allTimeDeposits?: MeteoraTokenPairWithTotal | null;
    allTimeWithdrawals?: MeteoraTokenPairWithTotal | null;
    allTimeFees?: MeteoraTokenPairWithTotal | null;
    tokenX?: string | null;
    tokenY?: string | null;
}

export interface MeteoraApiPoolPnLResponse {
    positions?: MeteoraApiPositionPnLData[];
    total?: number;
}

export interface MeteoraApiHistoricalEvent {
    signature: string;
    ixIndex: number;
    eventType: string;
    positionAddress: string;
    poolAddress?: string;
    userAddress?: string;
    tokenX?: string;
    tokenY?: string;
    amountX?: string | number;
    amountY?: string | number;
    amountXUsd?: string | number;
    amountYUsd?: string | number;
    totalUsd?: string | number;
    createdAt: string;
    blockTime?: number;
    slot?: number;
}

export interface MeteoraApiHistoricalEventsResponse {
    events?: MeteoraApiHistoricalEvent[];
}

export interface MeteoraFetchOptions {
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    baseRetryDelayMs?: number;
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
    clientVersion?: string;
    sleepFn?: (ms: number) => Promise<void>;
}

// ======================================================
// SAFE NETWORKING & BOUNDED RETRIES
// ======================================================

export async function fetchMeteoraJson<T>(
    endpoint: string,
    options: MeteoraFetchOptions = {}
): Promise<{ data: T; status: number }> {
    const baseUrl = options.baseUrl || DEFAULT_METEORA_API_BASE;
    const timeoutMs = options.timeoutMs ?? 8000;
    const maxRetries = options.maxRetries ?? 3;
    const baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    const fetchImpl = options.fetchFn || globalThis.fetch;
    const sleep = options.sleepFn || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    const fullUrl = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetchImpl(fullUrl, {
                headers: {
                    Accept: "application/json",
                    "User-Agent": `Meteora-Verification-Layer/${options.clientVersion || "1.0.0"}`,
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutHandle);

            // Rate-limited 429 handling
            if (res.status === 429) {
                if (attempt === maxRetries) {
                    throw new Error(`Meteora API 429 rate limit exceeded after ${maxRetries} attempts`);
                }
                const retryAfterHeader = res.headers.get("Retry-After");
                let delay = baseRetryDelayMs * Math.pow(2, attempt - 1);
                if (retryAfterHeader) {
                    const parsedSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
                        delay = parsedSeconds * 1000;
                    }
                }
                await sleep(delay);
                continue;
            }

            // 5xx Server Error handling
            if (res.status >= 500 && res.status < 600) {
                if (attempt === maxRetries) {
                    throw new Error(`Meteora API 5xx server error (${res.status}) after ${maxRetries} attempts`);
                }
                const delay = baseRetryDelayMs * Math.pow(2, attempt - 1);
                await sleep(delay);
                continue;
            }

            if (!res.ok) {
                throw new Error(`Meteora API error HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as T;
            return { data, status: res.status };
        } catch (err: unknown) {
            clearTimeout(timeoutHandle);
            lastError = err instanceof Error ? err : new Error(String(err));

            // Don't retry if aborted explicitly or non-retryable error
            if (controller.signal.aborted && attempt === maxRetries) {
                throw new Error(`Meteora API request timed out after ${timeoutMs}ms: ${fullUrl}`);
            }

            if (attempt === maxRetries) {
                throw lastError;
            }

            await sleep(baseRetryDelayMs * attempt);
        }
    }

    throw lastError || new Error(`Unknown fetch error for ${fullUrl}`);
}

// ======================================================
// BOUNDED PAGINATION
// ======================================================

export async function fetchPoolClosedPositions(
    poolAddress: string,
    wallet: string,
    options: MeteoraFetchOptions & {
        maxPages?: number;
        pageSize?: number;
        endpointsCalled?: string[];
    } = {}
): Promise<MeteoraApiPositionPnLData[]> {
    const maxPages = options.maxPages ?? 5;
    const pageSize = options.pageSize ?? 50;
    const allPositions: MeteoraApiPositionPnLData[] = [];

    for (let page = 1; page <= maxPages; page++) {
        const queryPath = `/positions/${poolAddress}/pnl?user=${wallet}&status=closed&page=${page}&limit=${pageSize}`;
        if (options.endpointsCalled) {
            options.endpointsCalled.push(queryPath);
        }

        const res = await fetchMeteoraJson<MeteoraApiPoolPnLResponse>(queryPath, options);
        const positions = res.data?.positions || [];
        allPositions.push(...positions);

        if (positions.length === 0 || positions.length < pageSize) {
            break;
        }
    }

    return allPositions;
}

// ======================================================
// COMPARISON LOGIC
// ======================================================

export interface ComparisonTolerances {
    tokenAmountEpsilon?: number;
    usdAbsoluteTolerance?: number;
    usdPercentageTolerance?: number;
    timestampToleranceSeconds?: number;
}

const DEFAULT_TOLERANCES: Required<ComparisonTolerances> = {
    tokenAmountEpsilon: 1e-6,
    usdAbsoluteTolerance: 0.50, // $0.50 tolerance for price oracle variation
    usdPercentageTolerance: 0.25, // 0.25% tolerance for price oracle variation
    timestampToleranceSeconds: 2, // 2s timestamp tolerance for blocktime vs signature index
};

export function compareTokenFlow(
    token: "tokenX" | "tokenY",
    localAmount: number | null,
    meteoraAmount: MonetaryPrecisionValue | null,
    epsilon: number = DEFAULT_TOLERANCES.tokenAmountEpsilon
): MeteoraTokenFlowComparison {
    if (localAmount === null || meteoraAmount === null) {
        return {
            token,
            localAmount,
            meteoraAmount,
            amountDelta: null,
            isExactMatch: localAmount === null && meteoraAmount === null,
        };
    }

    const amountDelta = meteoraAmount.numeric - localAmount;
    const isExactMatch = Math.abs(amountDelta) <= epsilon;

    return {
        token,
        localAmount,
        meteoraAmount,
        amountDelta,
        isExactMatch,
    };
}

export function compareUsdMetric(
    metric: "deposits" | "withdrawals" | "claimedFees" | "pnlUsd",
    localUsd: number | null,
    meteoraUsd: MonetaryPrecisionValue | null,
    tolerances: ComparisonTolerances = {}
): MeteoraUsdComparison {
    const absTol = tolerances.usdAbsoluteTolerance ?? DEFAULT_TOLERANCES.usdAbsoluteTolerance;
    const pctTol = tolerances.usdPercentageTolerance ?? DEFAULT_TOLERANCES.usdPercentageTolerance;

    if (localUsd === null || meteoraUsd === null) {
        return {
            metric,
            localUsd,
            meteoraUsd,
            usdDelta: null,
            usdDeltaPct: null,
            isWithinTolerance: localUsd === null && meteoraUsd === null,
        };
    }

    const usdDelta = meteoraUsd.numeric - localUsd;
    const absDelta = Math.abs(usdDelta);
    const denom = Math.abs(localUsd);
    const usdDeltaPct = denom > 0 ? (absDelta / denom) * 100 : (absDelta === 0 ? 0 : null);

    const isWithinTolerance =
        absDelta <= absTol || (usdDeltaPct !== null && usdDeltaPct <= pctTol);

    return {
        metric,
        localUsd,
        meteoraUsd,
        usdDelta,
        usdDeltaPct,
        isWithinTolerance,
    };
}

/**
 * Reconstruct local token quantities from position lifecycle events
 */
export function extractLocalTokenFlows(position: NormalizedPositionRecord): {
    depositedTokenX: number;
    depositedTokenY: number;
    withdrawnTokenX: number;
    withdrawnTokenY: number;
    claimedFeesTokenX: number;
    claimedFeesTokenY: number;
} {
    let depX = 0;
    let depY = 0;
    let withX = 0;
    let withY = 0;
    let feeX = 0;
    let feeY = 0;

    const events = position.lifecycle?.events || [];
    for (const evt of events) {
        const x = evt.tokenXAmount ?? 0;
        const y = evt.tokenYAmount ?? 0;

        if (evt.category === "add") {
            depX += x;
            depY += y;
        } else if (evt.category === "remove") {
            withX += x;
            withY += y;
        } else if (evt.category === "claim_fee") {
            feeX += x;
            feeY += y;
        }
    }

    return {
        depositedTokenX: depX,
        depositedTokenY: depY,
        withdrawnTokenX: withX,
        withdrawnTokenY: withY,
        claimedFeesTokenX: feeX,
        claimedFeesTokenY: feeY,
    };
}

/**
 * Compare an individual local position against its official Meteora counterpart
 */
export function comparePositionRecord(
    wallet: string,
    localPos: NormalizedPositionRecord,
    meteoraPos: MeteoraApiPositionPnLData,
    provenance: MeteoraVerificationSourceProvenance,
    tolerances: ComparisonTolerances = {}
): PositionVerificationDetail {
    const timeTol = tolerances.timestampToleranceSeconds ?? DEFAULT_TOLERANCES.timestampToleranceSeconds;
    const matchReasons: string[] = [];
    const divergenceReasons: string[] = [];

    // 1. Timestamps
    const localOpenedAt = localPos.openedAt;
    const localClosedAt = localPos.closedAt;

    let meteoraCreatedAt: string | null = null;
    if (typeof meteoraPos.createdAt === "number") {
        meteoraCreatedAt = new Date(meteoraPos.createdAt * 1000).toISOString();
    } else if (typeof meteoraPos.createdAt === "string") {
        meteoraCreatedAt = meteoraPos.createdAt;
    }

    let meteoraClosedAt: string | null = null;
    if (typeof meteoraPos.closedAt === "number") {
        meteoraClosedAt = new Date(meteoraPos.closedAt * 1000).toISOString();
    } else if (typeof meteoraPos.closedAt === "string") {
        meteoraClosedAt = meteoraPos.closedAt;
    }

    let closedTimestampDeltaSeconds: number | null = null;
    let timestampsMatch = false;

    if (localClosedAt && meteoraClosedAt) {
        const localCloseMs = new Date(localClosedAt).getTime();
        const meteoraCloseMs = new Date(meteoraClosedAt).getTime();
        if (!isNaN(localCloseMs) && !isNaN(meteoraCloseMs)) {
            closedTimestampDeltaSeconds = Math.abs((meteoraCloseMs - localCloseMs) / 1000);
            timestampsMatch = closedTimestampDeltaSeconds <= timeTol;
        }
    }

    if (timestampsMatch) {
        matchReasons.push("Closed timestamp matches within tolerance.");
    } else if (closedTimestampDeltaSeconds !== null) {
        divergenceReasons.push(`Closed timestamp discrepancy: ${closedTimestampDeltaSeconds}s.`);
    }

    // 2. Token Flows
    const localFlows = extractLocalTokenFlows(localPos);

    const metDepX = parseMonetaryString(meteoraPos.allTimeDeposits?.tokenX?.amount);
    const metDepY = parseMonetaryString(meteoraPos.allTimeDeposits?.tokenY?.amount);
    const metWithX = parseMonetaryString(meteoraPos.allTimeWithdrawals?.tokenX?.amount);
    const metWithY = parseMonetaryString(meteoraPos.allTimeWithdrawals?.tokenY?.amount);
    const metFeeX = parseMonetaryString(meteoraPos.allTimeFees?.tokenX?.amount);
    const metFeeY = parseMonetaryString(meteoraPos.allTimeFees?.tokenY?.amount);

    const compDepX = compareTokenFlow("tokenX", localFlows.depositedTokenX, metDepX, tolerances.tokenAmountEpsilon);
    const compDepY = compareTokenFlow("tokenY", localFlows.depositedTokenY, metDepY, tolerances.tokenAmountEpsilon);
    const compWithX = compareTokenFlow("tokenX", localFlows.withdrawnTokenX, metWithX, tolerances.tokenAmountEpsilon);
    const compWithY = compareTokenFlow("tokenY", localFlows.withdrawnTokenY, metWithY, tolerances.tokenAmountEpsilon);
    const compFeeX = compareTokenFlow("tokenX", localFlows.claimedFeesTokenX, metFeeX, tolerances.tokenAmountEpsilon);
    const compFeeY = compareTokenFlow("tokenY", localFlows.claimedFeesTokenY, metFeeY, tolerances.tokenAmountEpsilon);

    const allTokensMatch =
        compDepX.isExactMatch &&
        compDepY.isExactMatch &&
        compWithX.isExactMatch &&
        compWithY.isExactMatch &&
        compFeeX.isExactMatch &&
        compFeeY.isExactMatch;

    if (allTokensMatch) {
        matchReasons.push("All underlying token quantities (deposits, withdrawals, claimed fees) match exactly.");
    } else {
        divergenceReasons.push("Token quantity discrepancies observed across lifecycle flows.");
    }

    // 3. USD Valuations
    const metDepUsd = parseMonetaryString(
        meteoraPos.allTimeDeposits?.total?.usd ??
        (Number(meteoraPos.allTimeDeposits?.tokenX?.usd || 0) + Number(meteoraPos.allTimeDeposits?.tokenY?.usd || 0))
    );
    const metWithUsd = parseMonetaryString(
        meteoraPos.allTimeWithdrawals?.total?.usd ??
        (Number(meteoraPos.allTimeWithdrawals?.tokenX?.usd || 0) + Number(meteoraPos.allTimeWithdrawals?.tokenY?.usd || 0))
    );
    const metFeeUsd = parseMonetaryString(
        meteoraPos.allTimeFees?.total?.usd ??
        (Number(meteoraPos.allTimeFees?.tokenX?.usd || 0) + Number(meteoraPos.allTimeFees?.tokenY?.usd || 0))
    );
    const metPnlUsd = parseMonetaryString(meteoraPos.pnlUsd);

    const compDepUsd = compareUsdMetric("deposits", localPos.totalDepositsUsd, metDepUsd, tolerances);
    const compWithUsd = compareUsdMetric("withdrawals", localPos.totalWithdrawalsUsd, metWithUsd, tolerances);
    const compFeeUsd = compareUsdMetric("claimedFees", localPos.claimedFeesUsd, metFeeUsd, tolerances);
    const compPnlUsd = compareUsdMetric("pnlUsd", localPos.pnlUsd, metPnlUsd, tolerances);

    // 4. Sign flip detection
    let pnlSignFlip = false;
    if (
        localPos.pnlUsd !== null &&
        metPnlUsd !== null &&
        Math.abs(localPos.pnlUsd) > 0.0001 &&
        Math.abs(metPnlUsd.numeric) > 0.0001
    ) {
        const signLocal = Math.sign(localPos.pnlUsd);
        const signMeteora = Math.sign(metPnlUsd.numeric);
        pnlSignFlip = signLocal !== signMeteora;
    }

    // 5. Classification
    let classification: MeteoraVerificationClassification;

    const isClosedLocally = Boolean(localPos.closedAt);
    const isClosedMeteora = meteoraPos.isClosed !== false && meteoraClosedAt !== null;

    if (!isClosedLocally || !isClosedMeteora) {
        classification = "NOT_COMPARABLE";
        divergenceReasons.push("Position is not closed in one or both sources.");
    } else if (pnlSignFlip) {
        classification = "SIGN_MISMATCH";
        divergenceReasons.push(
            `PnL sign flip: local Fabriq is ${localPos.pnlUsd?.toFixed(2)} USD vs official Meteora is ${metPnlUsd?.numeric.toFixed(2)} USD due to oracle valuation differences on flat position.`
        );
    } else if (!allTokensMatch) {
        classification = "USD_VALUATION_DIFFERENCE";
        divergenceReasons.push("Token quantities do not match exactly.");
    } else if (
        !compPnlUsd.isWithinTolerance ||
        !compDepUsd.isWithinTolerance ||
        !compWithUsd.isWithinTolerance
    ) {
        classification = "USD_VALUATION_DIFFERENCE";
        divergenceReasons.push(
            `USD valuation difference: token quantities match, but USD valuations vary by ${compPnlUsd.usdDelta?.toFixed(2)} USD (${compPnlUsd.usdDeltaPct?.toFixed(2)}%).`
        );
    } else {
        classification = "MATCH";
        matchReasons.push("Identity, closed status, token flows, and USD valuations match within tolerances.");
    }

    const metPnlSol = parseMonetaryString(meteoraPos.pnlSol);

    return {
        wallet,
        poolAddress: localPos.poolAddress,
        positionAddress: localPos.positionId,
        classification,
        isMatched: classification === "MATCH" || classification === "USD_VALUATION_DIFFERENCE" || classification === "SIGN_MISMATCH",
        matchReasons,
        divergenceReasons,

        timestamps: {
            localOpenedAt,
            meteoraCreatedAt,
            localClosedAt,
            meteoraClosedAt,
            closedTimestampDeltaSeconds,
            timestampsMatch,
        },

        tokenFlows: {
            depositedTokenX: compDepX,
            depositedTokenY: compDepY,
            withdrawnTokenX: compWithX,
            withdrawnTokenY: compWithY,
            claimedFeesTokenX: compFeeX,
            claimedFeesTokenY: compFeeY,
            allTokensMatch,
        },

        usdValuations: {
            deposits: compDepUsd,
            withdrawals: compWithUsd,
            claimedFees: compFeeUsd,
            pnlUsd: compPnlUsd,
            pnlSignFlip,
        },

        solValuations: {
            meteoraPnlSol: metPnlSol,
        },

        metadataEnrichment: {
            tokenXMint: meteoraPos.tokenX || null,
            tokenYMint: meteoraPos.tokenY || null,
            minPrice: meteoraPos.minPrice || null,
            maxPrice: meteoraPos.maxPrice || null,
            lowerBinId: meteoraPos.lowerBinId ?? null,
            upperBinId: meteoraPos.upperBinId ?? null,
        },

        provenance,
    };
}

// ======================================================
// VERIFICATION ADAPTER ORCHESTRATOR
// ======================================================

export interface VerifyPositionAnalyticsOptions {
    datasetOrBundle: PositionAnalyticsDataset | PositionAnalyticsBundle;
    clientOptions?: MeteoraFetchOptions & {
        maxPages?: number;
        pageSize?: number;
        targetPositionIds?: string[];
        tolerances?: ComparisonTolerances;
    };
    mockApiData?: {
        poolPositions?: Record<string, MeteoraApiPositionPnLData[]>;
    };
}

/**
 * Execute non-destructive cross-verification of existing Position Analytics data
 * against official Meteora DLMM API records.
 *
 * Never alters, overwrites, or mutates the input dataset or bundle metrics.
 */
export async function verifyPositionAnalyticsWithMeteora(
    options: VerifyPositionAnalyticsOptions
): Promise<MeteoraVerificationReport> {
    const rawInput = options.datasetOrBundle;
    const isBundle = "dataset" in rawInput && "metrics" in rawInput;
    const dataset = isBundle ? rawInput.dataset : rawInput;

    const wallet = dataset.wallet;
    const period = dataset.period;
    const clientOptions = options.clientOptions || {};
    const tolerances = clientOptions.tolerances || {};

    const targetPositions = dataset.positions.filter((pos) => {
        if (clientOptions.targetPositionIds && clientOptions.targetPositionIds.length > 0) {
            return clientOptions.targetPositionIds.includes(pos.positionId);
        }
        return true;
    });

    const endpointsCalled: string[] = [];
    const provenance: MeteoraVerificationSourceProvenance = {
        source: "meteora_official_api",
        baseUrl: clientOptions.baseUrl || DEFAULT_METEORA_API_BASE,
        endpointsCalled,
        fetchedAt: new Date().toISOString(),
        clientVersion: clientOptions.clientVersion || "1.0.0",
    };

    // Group positions by pool address for efficient batch querying
    const poolsMap = new Map<string, NormalizedPositionRecord[]>();
    for (const pos of targetPositions) {
        const pool = pos.poolAddress;
        if (!poolsMap.has(pool)) {
            poolsMap.set(pool, []);
        }
        poolsMap.get(pool)!.push(pos);
    }

    const verifiedPositions: PositionVerificationDetail[] = [];
    const missingOrAmbiguousRecords: MeteoraMissingOrAmbiguousRecord[] = [];

    let matchedCount = 0;
    let usdValuationDifferenceCount = 0;
    let signMismatchCount = 0;
    let missingCount = 0;
    let notComparableCount = 0;
    let tokenFlowExactMatches = 0;
    let closedTimestampMatches = 0;

    for (const [poolAddress, positionsInPool] of poolsMap.entries()) {
        let meteoraPositions: MeteoraApiPositionPnLData[] = [];

        if (options.mockApiData?.poolPositions?.[poolAddress]) {
            meteoraPositions = options.mockApiData.poolPositions[poolAddress];
        } else {
            meteoraPositions = await fetchPoolClosedPositions(poolAddress, wallet, {
                ...clientOptions,
                endpointsCalled,
            });
        }

        // Exact match by position address
        const meteoraPosByAddress = new Map<string, MeteoraApiPositionPnLData[]>();
        for (const mPos of meteoraPositions) {
            const addr = mPos.positionAddress;
            if (!meteoraPosByAddress.has(addr)) {
                meteoraPosByAddress.set(addr, []);
            }
            meteoraPosByAddress.get(addr)!.push(mPos);
        }

        for (const localPos of positionsInPool) {
            const candidates = meteoraPosByAddress.get(localPos.positionId) || [];

            if (candidates.length === 0) {
                missingCount++;
                missingOrAmbiguousRecords.push({
                    positionAddress: localPos.positionId,
                    poolAddress,
                    issue: "MISSING_IN_METEORA",
                    details: `Position ${localPos.positionId} not returned by Meteora pool ${poolAddress} closed positions.`,
                });
                continue;
            }

            if (candidates.length > 1) {
                notComparableCount++;
                missingOrAmbiguousRecords.push({
                    positionAddress: localPos.positionId,
                    poolAddress,
                    issue: "AMBIGUOUS_DUPLICATE",
                    details: `Multiple positions (${candidates.length}) returned with identical address ${localPos.positionId}.`,
                });
                continue;
            }

            const meteoraPos = candidates[0];

            // Verify exact wallet matching
            if (meteoraPos.userAddress && meteoraPos.userAddress !== wallet) {
                notComparableCount++;
                missingOrAmbiguousRecords.push({
                    positionAddress: localPos.positionId,
                    poolAddress,
                    issue: "INSUFFICIENT_DATA",
                    details: `User address mismatch: local ${wallet} vs Meteora ${meteoraPos.userAddress}.`,
                });
                continue;
            }

            const detail = comparePositionRecord(
                wallet,
                localPos,
                meteoraPos,
                provenance,
                tolerances
            );

            verifiedPositions.push(detail);

            if (detail.classification === "MATCH") {
                matchedCount++;
            } else if (detail.classification === "USD_VALUATION_DIFFERENCE") {
                usdValuationDifferenceCount++;
            } else if (detail.classification === "SIGN_MISMATCH") {
                signMismatchCount++;
            } else if (detail.classification === "NOT_COMPARABLE") {
                notComparableCount++;
            } else if (detail.classification === "MISSING") {
                missingCount++;
            }

            if (detail.tokenFlows.allTokensMatch) {
                tokenFlowExactMatches++;
            }
            if (detail.timestamps.timestampsMatch) {
                closedTimestampMatches++;
            }
        }
    }

    const totalEvaluated = verifiedPositions.length + missingCount;
    const tokenFlowExactMatchRatePct =
        verifiedPositions.length > 0 ? (tokenFlowExactMatches / verifiedPositions.length) * 100 : 0;
    const closedTimestampMatchRatePct =
        verifiedPositions.length > 0 ? (closedTimestampMatches / verifiedPositions.length) * 100 : 0;

    const summary: MeteoraVerificationSummary = {
        totalPositionsEvaluated: totalEvaluated,
        matchedCount,
        usdValuationDifferenceCount,
        signMismatchCount,
        missingCount,
        notComparableCount,
        tokenFlowExactMatchRatePct,
        closedTimestampMatchRatePct,
    };

    return {
        version: "v1",
        targetWallet: wallet,
        period,
        verifiedAt: provenance.fetchedAt,
        provenance,
        summary,
        positions: verifiedPositions,
        missingOrAmbiguousRecords,
        nonDestructiveNotice: "Verification results do not mutate or replace Fabriq-derived published metrics.",
    };
}

// ======================================================
// ISOLATED PERSISTENCE
// ======================================================

/**
 * Save verification report to disk in dedicated data/analytics/verification directory.
 * Atomically isolates verification artifacts from bundles and master datasets.
 */
export function saveMeteoraVerificationReport(
    report: MeteoraVerificationReport,
    baseDir: string = DEFAULT_VERIFICATION_STORAGE_BASE
): string {
    const targetDir = path.resolve(baseDir, report.targetWallet.trim());
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const filePath = path.join(targetDir, `${report.period}.json`);
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

    fs.writeFileSync(tempPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, filePath);

    return filePath;
}

/**
 * Load verification report from disk if present.
 */
export function loadMeteoraVerificationReport(
    wallet: string,
    period: AnalyticsPeriod,
    baseDir: string = DEFAULT_VERIFICATION_STORAGE_BASE
): MeteoraVerificationReport | null {
    const filePath = path.resolve(baseDir, wallet.trim(), `${period}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw) as MeteoraVerificationReport;
    } catch {
        return null;
    }
}
