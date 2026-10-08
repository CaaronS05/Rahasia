import type {
    PositionAnalyticsDataset,
    PositionMetricsResult,
    CapitalAnalytics,
    ProfitabilityAnalytics,
    RiskAndConsistencyAnalytics,
    TradingBehaviorAnalytics,
    PairBreakdownItem,
    PoolBreakdownItem,
    PairPositionSizeItem,
    MetricObservationCoverage,
    DistributionBucket,
    WeeklyRealizedPnlItem,
    HourlyActivityItem,
    WeekdayActivityItem,
    NormalizedPositionRecord,
} from "./position-analytics-types.ts";

// ======================================================
// DETERMINISTIC MATHEMATICAL UTILITIES
// ======================================================

/**
 * Arithmetic Mean: sum(x) / N
 */
export function computeMean(values: number[]): number | null {
    if (!values || values.length === 0) return null;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return Number((sum / values.length).toFixed(4));
}

/**
 * Median: middle element for odd length, arithmetic mean of middle two for even length.
 */
export function computeMedian(values: number[]): number | null {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return Number(sorted[mid].toFixed(4));
    }
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}

/**
 * Linear interpolation percentile: rank = (p / 100) * (N - 1)
 * Documented interpolation method applied consistently across all quartiles.
 */
export function computePercentile(sortedValues: number[], p: number): number | null {
    if (!sortedValues || sortedValues.length === 0) return null;
    if (sortedValues.length === 1) return Number(sortedValues[0].toFixed(4));
    const rank = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    if (lower === upper) return Number(sortedValues[lower].toFixed(4));
    const interpolated = sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
    return Number(interpolated.toFixed(4));
}

/**
 * CVaR 10%: Mean of worst ceil(10%) observed position PnL percentage values.
 */
export function computeCvar10(pnlPcts: number[]): number | null {
    if (!pnlPcts || pnlPcts.length === 0) return null;
    const sorted = [...pnlPcts].sort((a, b) => a - b); // Ascending: worst/most negative first
    const k = Math.max(1, Math.ceil(sorted.length * 0.10));
    const worst10Slice = sorted.slice(0, k);
    const sum = worst10Slice.reduce((acc, v) => acc + v, 0);
    return Number((sum / k).toFixed(4));
}

/**
 * Sample Standard Deviation: sqrt( sum((x - mean)^2) / (N - 1) ) for N >= 2.
 * Returns null if N < 2.
 */
export function computeSampleStdDev(values: number[]): number | null {
    if (!values || values.length < 2) return null;
    const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
    return Number(Math.sqrt(variance).toFixed(4));
}

function isFiniteNumber(val: unknown): val is number {
    return typeof val === "number" && Number.isFinite(val);
}

// ======================================================
// ASIA/JAKARTA (WIB) TIME CONVERSIONS (UTC+7)
// ======================================================

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface WibDateInfo {
    wibIsoDate: string; // YYYY-MM-DD in WIB
    hourWib: number;    // 0..23 in WIB
    isoDayWib: number;  // 1 (Mon) .. 7 (Sun) in WIB
    weekStartWib: string; // YYYY-MM-DD (Monday)
    weekEndWib: string;   // YYYY-MM-DD (Sunday)
}

export function parseWibDateInfo(tsIsoOrMs: string | number): WibDateInfo | null {
    const tsMs = typeof tsIsoOrMs === "number" ? tsIsoOrMs : Date.parse(tsIsoOrMs);
    if (!Number.isFinite(tsMs)) return null;

    const wibMs = tsMs + WIB_OFFSET_MS;
    const wibDate = new Date(wibMs);

    const year = wibDate.getUTCFullYear();
    const month = String(wibDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(wibDate.getUTCDate()).padStart(2, "0");
    const wibIsoDate = `${year}-${month}-${day}`;

    const hourWib = wibDate.getUTCHours();
    const utcDay = wibDate.getUTCDay(); // 0=Sun, 1=Mon... 6=Sat
    const isoDayWib = utcDay === 0 ? 7 : utcDay; // 1=Mon... 7=Sun

    // Calculate Monday 00:00:00 WIB of this ISO week
    const daysFromMonday = isoDayWib - 1;
    const mondayMs = Date.UTC(year, wibDate.getUTCMonth(), wibDate.getUTCDate() - daysFromMonday);
    const mondayDate = new Date(mondayMs);
    const mYear = mondayDate.getUTCFullYear();
    const mMonth = String(mondayDate.getUTCMonth() + 1).padStart(2, "0");
    const mDay = String(mondayDate.getUTCDate()).padStart(2, "0");
    const weekStartWib = `${mYear}-${mMonth}-${mDay}`;

    // Calculate Sunday 23:59:59 WIB of this ISO week
    const sundayMs = mondayMs + 6 * 86400000;
    const sundayDate = new Date(sundayMs);
    const sYear = sundayDate.getUTCFullYear();
    const sMonth = String(sundayDate.getUTCMonth() + 1).padStart(2, "0");
    const sDay = String(sundayDate.getUTCDate()).padStart(2, "0");
    const weekEndWib = `${sYear}-${sMonth}-${sDay}`;

    return {
        wibIsoDate,
        hourWib,
        isoDayWib,
        weekStartWib,
        weekEndWib,
    };
}

// ======================================================
// CORE ANALYTICS ENGINE
// ======================================================

/**
 * Pure analytics engine: Computes comprehensive wallet performance and
 * behavioral metrics from a Step 1 PositionAnalyticsDataset without side effects.
 */
export function computePositionAnalyticsMetrics(
    dataset: PositionAnalyticsDataset
): PositionMetricsResult {
    const rawPositions = Array.isArray(dataset.positions) ? dataset.positions : [];
    const totalAnalyzed = rawPositions.length;

    // Filter verified initial entry observations:
    // Only VERIFIED_OPEN_EVENT or VERIFIED_ASSOCIATED_ADD status qualify.
    const verifiedInitialEntries: number[] = [];
    const totalDepositsObs: number[] = [];
    const additionalLiquidityObs: number[] = [];
    const pnlUsdObs: number[] = [];
    const pnlPctObs: number[] = [];
    const holdDurationObs: number[] = [];
    const openedAtObs: NormalizedPositionRecord[] = [];
    const closedAtObs: NormalizedPositionRecord[] = [];

    for (const p of rawPositions) {
        if (
            isFiniteNumber(p.initialEntryUsd) &&
            (p.dataQuality?.initialEntryStatus === "VERIFIED_OPEN_EVENT" ||
                p.dataQuality?.initialEntryStatus === "VERIFIED_ASSOCIATED_ADD")
        ) {
            verifiedInitialEntries.push(p.initialEntryUsd);
        }

        if (isFiniteNumber(p.totalDepositsUsd)) {
            totalDepositsObs.push(p.totalDepositsUsd);
        }

        if (isFiniteNumber(p.additionalLiquidityUsd)) {
            additionalLiquidityObs.push(p.additionalLiquidityUsd);
        }

        if (isFiniteNumber(p.pnlUsd)) {
            pnlUsdObs.push(p.pnlUsd);
        }

        if (isFiniteNumber(p.pnlPct)) {
            pnlPctObs.push(p.pnlPct);
        }

        if (isFiniteNumber(p.holdDurationSeconds)) {
            holdDurationObs.push(p.holdDurationSeconds);
        }

        if (typeof p.openedAt === "string" && p.openedAt.trim().length > 0) {
            openedAtObs.push(p);
        }

        if (typeof p.closedAt === "string" && p.closedAt.trim().length > 0) {
            closedAtObs.push(p);
        }
    }

    // --------------------------------------------------
    // 1. CAPITAL ANALYTICS
    // --------------------------------------------------
    const sortedVerifiedEntries = [...verifiedInitialEntries].sort((a, b) => a - b);
    const initialEntryP25 = computePercentile(sortedVerifiedEntries, 25);
    const initialEntryP75 = computePercentile(sortedVerifiedEntries, 75);

    const totalPositionDepositsUsd = totalDepositsObs.length > 0
        ? Number(totalDepositsObs.reduce((sum, v) => sum + v, 0).toFixed(2))
        : null;

    // Position Size Distribution: brackets based on totalDepositsUsd (or initialEntryUsd if present)
    const positionSizesForDistribution: number[] = [];
    for (const p of rawPositions) {
        const size = isFiniteNumber(p.totalDepositsUsd) ? p.totalDepositsUsd : p.initialEntryUsd;
        if (isFiniteNumber(size) && size >= 0) {
            positionSizesForDistribution.push(size);
        }
    }

    const sizeBucketsDef: Array<{ label: string; min: number | null; max: number | null }> = [
        { label: "< $100", min: 0, max: 100 },
        { label: "$100 - $500", min: 100, max: 500 },
        { label: "$500 - $1K", min: 500, max: 1000 },
        { label: "$1K - $5K", min: 1000, max: 5000 },
        { label: "$5K - $10K", min: 5000, max: 10000 },
        { label: "> $10K", min: 10000, max: null },
    ];

    const positionSizeDistribution: DistributionBucket[] = sizeBucketsDef.map((b) => {
        const count = positionSizesForDistribution.filter((val) => {
            if (b.min !== null && val < b.min) return false;
            if (b.max !== null && val >= b.max) return false;
            return true;
        }).length;
        const pct = positionSizesForDistribution.length > 0
            ? Number(((count / positionSizesForDistribution.length) * 100).toFixed(2))
            : 0;
        return {
            label: b.label,
            min: b.min,
            max: b.max,
            count,
            pct,
        };
    });

    const capital: CapitalAnalytics = {
        totalPositionDepositsUsd,
        avgInitialEntryUsd: computeMean(verifiedInitialEntries),
        medianInitialEntryUsd: computeMedian(verifiedInitialEntries),
        initialEntryP25,
        initialEntryP75,
        typicalPositionSize: {
            p25: initialEntryP25,
            p75: initialEntryP75,
        },
        avgTotalPositionDepositsUsd: computeMean(totalDepositsObs),
        medianTotalPositionDepositsUsd: computeMedian(totalDepositsObs),
        avgAdditionalLiquidityUsd: computeMean(additionalLiquidityObs),
        positionSizeDistribution,
    };

    // --------------------------------------------------
    // 2. PROFITABILITY ANALYTICS
    // --------------------------------------------------
    let winCount = 0;
    let lossCount = 0;
    let breakevenCount = 0;
    let unknownCount = 0;

    const winningPnlPcts: number[] = [];
    const losingPnlPcts: number[] = [];
    let grossWinningPnlUsd = 0;
    let grossLosingPnlUsd = 0;

    for (const p of rawPositions) {
        if (p.winLoss === "WIN") {
            winCount++;
            if (isFiniteNumber(p.pnlPct) && p.pnlPct > 0) {
                winningPnlPcts.push(p.pnlPct);
            }
        } else if (p.winLoss === "LOSS") {
            lossCount++;
            if (isFiniteNumber(p.pnlPct) && p.pnlPct < 0) {
                losingPnlPcts.push(p.pnlPct);
            }
        } else if (p.winLoss === "BREAKEVEN") {
            breakevenCount++;
        } else {
            unknownCount++;
        }

        if (isFiniteNumber(p.pnlUsd)) {
            if (p.pnlUsd > 0) {
                grossWinningPnlUsd += p.pnlUsd;
            } else if (p.pnlUsd < 0) {
                grossLosingPnlUsd += Math.abs(p.pnlUsd);
            }
        }
    }

    const knownPnlDenominator = winCount + lossCount + breakevenCount;
    const positionWinRate = knownPnlDenominator > 0
        ? Number(((winCount / knownPnlDenominator) * 100).toFixed(2))
        : null;

    let profitFactor: number | null = null;
    let profitFactorStatus: "CALCULATED" | "UNBOUNDED_NO_LOSSES" | "NO_QUALIFYING_POSITIONS" = "NO_QUALIFYING_POSITIONS";

    if (grossLosingPnlUsd > 0) {
        profitFactor = Number((grossWinningPnlUsd / grossLosingPnlUsd).toFixed(4));
        profitFactorStatus = "CALCULATED";
    } else if (grossWinningPnlUsd > 0) {
        profitFactor = null;
        profitFactorStatus = "UNBOUNDED_NO_LOSSES";
    } else {
        profitFactor = null;
        profitFactorStatus = "NO_QUALIFYING_POSITIONS";
    }

    const bestWinningPositionPct = winningPnlPcts.length > 0
        ? Number(Math.max(...winningPnlPcts).toFixed(4))
        : null;

    const worstLosingPositionPct = losingPnlPcts.length > 0
        ? Number(Math.min(...losingPnlPcts).toFixed(4))
        : null;

    // PnL % Distribution
    const pnlBucketsDef: Array<{ label: string; min: number | null; max: number | null }> = [
        { label: "< -50%", min: null, max: -50 },
        { label: "-50% to -20%", min: -50, max: -20 },
        { label: "-20% to -5%", min: -20, max: -5 },
        { label: "-5% to 0%", min: -5, max: 0 },
        { label: "0% to +5%", min: 0, max: 5 },
        { label: "+5% to +20%", min: 5, max: 20 },
        { label: "+20% to +50%", min: 20, max: 50 },
        { label: "> +50%", min: 50, max: null },
    ];

    const pnlDistribution: DistributionBucket[] = pnlBucketsDef.map((b) => {
        const count = pnlPctObs.filter((val) => {
            if (b.min !== null && val < b.min) return false;
            if (b.max !== null && val >= b.max) return false;
            return true;
        }).length;
        const pct = pnlPctObs.length > 0
            ? Number(((count / pnlPctObs.length) * 100).toFixed(2))
            : 0;
        return {
            label: b.label,
            min: b.min,
            max: b.max,
            count,
            pct,
        };
    });

    const sampleTotalPnlUsd = pnlUsdObs.length > 0
        ? Number(pnlUsdObs.reduce((sum, v) => sum + v, 0).toFixed(4))
        : null;

    const profitability: ProfitabilityAnalytics = {
        sampleTotalPnlUsd,
        avgPositionPnlPct: computeMean(pnlPctObs),
        medianPositionPnlPct: computeMedian(pnlPctObs),
        bestWinningPositionPct,
        worstLosingPositionPct,
        positionWinRate,
        profitFactor,
        profitFactorStatus,
        avgWinningPositionPct: computeMean(winningPnlPcts),
        avgLosingPositionPct: computeMean(losingPnlPcts),
        pnlDistribution,
        winCount,
        lossCount,
        breakevenCount,
        unknownCount,
        unknownPnlExcludedCount: unknownCount,
    };

    // --------------------------------------------------
    // 3. RISK & CONSISTENCY ANALYTICS
    // --------------------------------------------------
    const sortedPnlPcts = [...pnlPctObs].sort((a, b) => a - b);
    const worstPositionPnlPct = sortedPnlPcts.length > 0
        ? Number(sortedPnlPcts[0].toFixed(4))
        : null;

    const cvar10PositionPnlPct = computeCvar10(pnlPctObs);
    const pnlStdDev = computeSampleStdDev(pnlPctObs);

    // Concentration: Denominator is sum of positive position PnL USD
    const positivePnlsUsd = pnlUsdObs.filter((v) => v > 0).sort((a, b) => b - a);
    const sumPositivePnlUsd = positivePnlsUsd.reduce((sum, v) => sum + v, 0);

    let top1ProfitConcentrationPct: number | null = null;
    let top5ProfitConcentrationPct: number | null = null;

    if (sumPositivePnlUsd > 0 && positivePnlsUsd.length > 0) {
        top1ProfitConcentrationPct = Number(((positivePnlsUsd[0] / sumPositivePnlUsd) * 100).toFixed(2));
        const top5Sum = positivePnlsUsd.slice(0, 5).reduce((sum, v) => sum + v, 0);
        top5ProfitConcentrationPct = Number(((top5Sum / sumPositivePnlUsd) * 100).toFixed(2));
    }

    // Chronological ordering for realized-position series
    // Sort by closedAt ASC, ties broken by poolAddress ASC, positionId ASC
    const chronologicalPositions = [...rawPositions].sort((a, b) => {
        const timeDiff = String(a.closedAt || "").localeCompare(String(b.closedAt || ""));
        if (timeDiff !== 0) return timeDiff;
        const poolDiff = a.poolAddress.localeCompare(b.poolAddress);
        if (poolDiff !== 0) return poolDiff;
        return a.positionId.localeCompare(b.positionId);
    });

    // Longest consecutive losing streak (in chronological order)
    let longestConsecutiveLosingStreak = 0;
    let currentLosingStreak = 0;

    for (const p of chronologicalPositions) {
        if (p.winLoss === "LOSS") {
            currentLosingStreak++;
            if (currentLosingStreak > longestConsecutiveLosingStreak) {
                longestConsecutiveLosingStreak = currentLosingStreak;
            }
        } else {
            currentLosingStreak = 0;
        }
    }

    // Weekly realized position PnL in Asia/Jakarta (WIB) week boundaries
    // Do not invent zero-PnL weeks; group only observed closed positions.
    const weeklyMap = new Map<string, {
        weekStartWib: string;
        weekEndWib: string;
        pnlUsdSum: number;
        closedPositionCount: number;
        winCount: number;
        lossCount: number;
    }>();

    for (const p of chronologicalPositions) {
        const wibInfo = parseWibDateInfo(p.closedAt);
        if (!wibInfo) continue;

        const key = wibInfo.weekStartWib;
        let weekItem = weeklyMap.get(key);
        if (!weekItem) {
            weekItem = {
                weekStartWib: wibInfo.weekStartWib,
                weekEndWib: wibInfo.weekEndWib,
                pnlUsdSum: 0,
                closedPositionCount: 0,
                winCount: 0,
                lossCount: 0,
            };
            weeklyMap.set(key, weekItem);
        }

        weekItem.closedPositionCount++;
        if (isFiniteNumber(p.pnlUsd)) {
            weekItem.pnlUsdSum += p.pnlUsd;
        }
        if (p.winLoss === "WIN") weekItem.winCount++;
        else if (p.winLoss === "LOSS") weekItem.lossCount++;
    }

    // Sort weeks chronologically
    const sortedWeekKeys = Array.from(weeklyMap.keys()).sort();
    const weeklyRealizedPositionPnlUsd: WeeklyRealizedPnlItem[] = sortedWeekKeys.map((k) => {
        const item = weeklyMap.get(k)!;
        return {
            weekStartDateWib: item.weekStartWib,
            weekEndDateWib: item.weekEndWib,
            realizedPnlUsd: Number(item.pnlUsdSum.toFixed(4)),
            closedPositionCount: item.closedPositionCount,
            winCount: item.winCount,
            lossCount: item.lossCount,
        };
    });

    let profitableWeeksCount = 0;
    let losingWeeksCount = 0;
    let breakevenWeeksCount = 0;
    const weeklyPnls: number[] = [];

    for (const w of weeklyRealizedPositionPnlUsd) {
        weeklyPnls.push(w.realizedPnlUsd);
        if (w.realizedPnlUsd > 0.0001) {
            profitableWeeksCount++;
        } else if (w.realizedPnlUsd < -0.0001) {
            losingWeeksCount++;
        } else {
            breakevenWeeksCount++;
        }
    }

    const weeklyPnlVariability = computeSampleStdDev(weeklyPnls);

    // Sample Realized PnL Drawdown (based on cumulative closed-position PnL, NOT actual wallet equity)
    // Starting cumulative value is zero.
    let cumPnl = 0;
    let runningPeak = 0;
    let maxDrawdownUsd = 0; // <= 0
    let peakAtMaxDd = 0;
    let troughAtMaxDd = 0;

    for (const p of chronologicalPositions) {
        if (!isFiniteNumber(p.pnlUsd)) continue;
        cumPnl += p.pnlUsd;
        if (cumPnl > runningPeak) {
            runningPeak = cumPnl;
        }
        const drawdown = cumPnl - runningPeak;
        if (drawdown < maxDrawdownUsd) {
            maxDrawdownUsd = drawdown;
            peakAtMaxDd = runningPeak;
            troughAtMaxDd = cumPnl;
        }
    }

    const hasIncompleteCoverageDueToCap = Boolean(
        dataset.sampling?.isSampled ||
        (dataset.sampling?.totalEligiblePositions ?? 0) > (dataset.sampling?.analyzedPositions ?? 0)
    );

    const riskAndConsistency: RiskAndConsistencyAnalytics = {
        cvar10PositionPnlPct,
        worstPositionPnlPct,
        pnlStdDev,
        top1ProfitConcentrationPct,
        top5ProfitConcentrationPct,
        longestConsecutiveLosingStreak,
        weeklyRealizedPositionPnlUsd,
        profitableWeeksCount,
        losingWeeksCount,
        breakevenWeeksCount,
        weeklyPnlVariability,
        hasIncompleteCoverageDueToCap,
        sampleRealizedPnlDrawdown: {
            label: "Sample Realized PnL Drawdown",
            maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(4)),
            peakCumulativePnlUsd: Number(peakAtMaxDd.toFixed(4)),
            troughCumulativePnlUsd: Number(troughAtMaxDd.toFixed(4)),
        },
    };

    // --------------------------------------------------
    // 4. TRADING BEHAVIOR ANALYTICS
    // --------------------------------------------------
    // Holding time distribution brackets
    const holdingBucketsDef: Array<{ label: string; min: number | null; max: number | null }> = [
        { label: "< 1h", min: 0, max: 3600 },
        { label: "1h - 6h", min: 3600, max: 21600 },
        { label: "6h - 24h", min: 21600, max: 86400 },
        { label: "1d - 7d", min: 86400, max: 604800 },
        { label: "> 7d", min: 604800, max: null },
    ];

    const holdingTimeDistribution: DistributionBucket[] = holdingBucketsDef.map((b) => {
        const count = holdDurationObs.filter((val) => {
            if (b.min !== null && val < b.min) return false;
            if (b.max !== null && val >= b.max) return false;
            return true;
        }).length;
        const pct = holdDurationObs.length > 0
            ? Number(((count / holdDurationObs.length) * 100).toFixed(2))
            : 0;
        return {
            label: b.label,
            min: b.min,
            max: b.max,
            count,
            pct,
        };
    });

    // Entry frequency: Use openedAt only. Never use closedAt.
    // For 30D / 90D: count observed openedAt within selected period window.
    // For ALL_AVAILABLE: use observed opening time window.
    let observedEntriesPerDay: number | null = null;
    const effectiveEndMs = dataset.timeframe?.effectiveEnd ? Date.parse(dataset.timeframe.effectiveEnd) : Date.now();

    if (openedAtObs.length === 0) {
        observedEntriesPerDay = null;
    } else if (dataset.period === "30D") {
        const periodStartMs = effectiveEndMs - 30 * 86400 * 1000;
        const countInWindow = openedAtObs.filter((p) => {
            const openMs = Date.parse(p.openedAt!);
            return Number.isFinite(openMs) && openMs >= periodStartMs && openMs <= effectiveEndMs;
        }).length;
        observedEntriesPerDay = Number((countInWindow / 30).toFixed(2));
    } else if (dataset.period === "90D") {
        const periodStartMs = effectiveEndMs - 90 * 86400 * 1000;
        const countInWindow = openedAtObs.filter((p) => {
            const openMs = Date.parse(p.openedAt!);
            return Number.isFinite(openMs) && openMs >= periodStartMs && openMs <= effectiveEndMs;
        }).length;
        observedEntriesPerDay = Number((countInWindow / 90).toFixed(2));
    } else {
        // ALL_AVAILABLE
        if (openedAtObs.length === 1) {
            observedEntriesPerDay = 1;
        } else {
            const openTimestamps = openedAtObs.map((p) => Date.parse(p.openedAt!)).filter(Number.isFinite);
            if (openTimestamps.length > 0) {
                const minTs = Math.min(...openTimestamps);
                const maxTs = Math.max(...openTimestamps);
                const spanDays = Math.max(1, (maxTs - minTs) / (86400 * 1000));
                observedEntriesPerDay = Number((openTimestamps.length / spanDays).toFixed(2));
            }
        }
    }

    // Hourly activity in WIB (00..23)
    const hourlyCounts = new Array(24).fill(0);
    // Weekday activity in WIB (1=Mon..7=Sun)
    const weekdayCounts = new Array(7).fill(0);
    const activeDatesWib = new Set<string>();

    for (const p of openedAtObs) {
        const wibInfo = parseWibDateInfo(p.openedAt!);
        if (!wibInfo) continue;
        hourlyCounts[wibInfo.hourWib]++;
        weekdayCounts[wibInfo.isoDayWib - 1]++;
        activeDatesWib.add(wibInfo.wibIsoDate);
    }

    const totalOpenedCount = openedAtObs.length;
    const entryActivityByHourWib: HourlyActivityItem[] = hourlyCounts.map((count, hour) => ({
        hourWib: hour,
        count,
        pct: totalOpenedCount > 0 ? Number(((count / totalOpenedCount) * 100).toFixed(2)) : 0,
    }));

    const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const entryActivityByWeekdayWib: WeekdayActivityItem[] = weekdayCounts.map((count, idx) => ({
        weekdayWib: weekdayNames[idx],
        dayIndexWib: idx + 1,
        count,
        pct: totalOpenedCount > 0 ? Number(((count / totalOpenedCount) * 100).toFixed(2)) : 0,
    }));

    const openingTimeCoverage = {
        analyzedPositions: totalAnalyzed,
        openedAtObservations: openedAtObs.length,
        coveragePct: totalAnalyzed > 0
            ? Number(((openedAtObs.length / totalAnalyzed) * 100).toFixed(2))
            : 0,
    };

    // --------------------------------------------------
    // 5. TOKEN / PAIR & POOL BREAKDOWN
    // --------------------------------------------------
    interface PairAccumulator {
        pairKey: string;
        pairSymbol: string | null;
        pairIdentified: boolean;
        token0Mint: string | null;
        token1Mint: string | null;
        pools: Set<string>;
        positions: NormalizedPositionRecord[];
    }

    interface PoolAccumulator {
        poolAddress: string;
        pairName: string | null;
        tokenXMint: string | null;
        tokenYMint: string | null;
        positions: NormalizedPositionRecord[];
    }

    const pairMap = new Map<string, PairAccumulator>();
    const poolMap = new Map<string, PoolAccumulator>();

    for (const p of rawPositions) {
        // Pool grouping
        let poolAcc = poolMap.get(p.poolAddress);
        if (!poolAcc) {
            poolAcc = {
                poolAddress: p.poolAddress,
                pairName: p.pairName ?? null,
                tokenXMint: p.tokenXMint ?? null,
                tokenYMint: p.tokenYMint ?? null,
                positions: [],
            };
            poolMap.set(p.poolAddress, poolAcc);
        }
        poolAcc.positions.push(p);

        // Pair grouping with verified token mint identities
        const hasVerifiedMints =
            typeof p.tokenXMint === "string" &&
            p.tokenXMint.trim().length > 0 &&
            typeof p.tokenYMint === "string" &&
            p.tokenYMint.trim().length > 0;

        let pairKey: string;
        let pairIdentified = false;
        let token0Mint: string | null = null;
        let token1Mint: string | null = null;
        let pairSymbol: string | null = null;

        if (hasVerifiedMints) {
            const mintX = p.tokenXMint!.trim();
            const mintY = p.tokenYMint!.trim();
            // Consistent deterministic orientation by mint address
            if (mintX.localeCompare(mintY) <= 0) {
                token0Mint = mintX;
                token1Mint = mintY;
                pairSymbol = p.tokenXSymbol && p.tokenYSymbol
                    ? `${p.tokenXSymbol}/${p.tokenYSymbol}`
                    : (p.pairName ?? null);
            } else {
                token0Mint = mintY;
                token1Mint = mintX;
                pairSymbol = p.tokenXSymbol && p.tokenYSymbol
                    ? `${p.tokenYSymbol}/${p.tokenXSymbol}`
                    : (p.pairName ?? null);
            }
            pairKey = `${token0Mint}:${token1Mint}`;
            pairIdentified = true;
        } else {
            // Missing metadata: group by exact pool address, pair identification unavailable
            pairKey = `pool:${p.poolAddress}`;
            pairIdentified = false;
            pairSymbol = p.pairName ?? null;
            token0Mint = p.tokenXMint ?? null;
            token1Mint = p.tokenYMint ?? null;
        }

        let pairAcc = pairMap.get(pairKey);
        if (!pairAcc) {
            pairAcc = {
                pairKey,
                pairSymbol,
                pairIdentified,
                token0Mint,
                token1Mint,
                pools: new Set<string>(),
                positions: [],
            };
            pairMap.set(pairKey, pairAcc);
        }
        pairAcc.pools.add(p.poolAddress);
        pairAcc.positions.push(p);
    }

    // Build Pair Breakdown items
    const pairBreakdown: PairBreakdownItem[] = Array.from(pairMap.values())
        .map((acc) => {
            const pPositions = acc.positions;
            const pPnlUsdObs = pPositions.map((p) => p.pnlUsd).filter(isFiniteNumber);
            const pPnlPctObs = pPositions.map((p) => p.pnlPct).filter(isFiniteNumber);
            const pHoldObs = pPositions.map((p) => p.holdDurationSeconds).filter(isFiniteNumber);
            const pInitialEntryObs = pPositions
                .filter((p) =>
                    isFiniteNumber(p.initialEntryUsd) &&
                    (p.dataQuality?.initialEntryStatus === "VERIFIED_OPEN_EVENT" ||
                        p.dataQuality?.initialEntryStatus === "VERIFIED_ASSOCIATED_ADD")
                )
                .map((p) => p.initialEntryUsd!);

            const wins = pPositions.filter((p) => p.winLoss === "WIN").length;
            const losses = pPositions.filter((p) => p.winLoss === "LOSS").length;
            const breakevens = pPositions.filter((p) => p.winLoss === "BREAKEVEN").length;
            const denom = wins + losses + breakevens;
            const winRate = denom > 0 ? Number(((wins / denom) * 100).toFixed(2)) : null;

            const samplePnlUsd = pPnlUsdObs.length > 0
                ? Number(pPnlUsdObs.reduce((sum, v) => sum + v, 0).toFixed(4))
                : null;

            const worstPositionPct = pPnlPctObs.length > 0
                ? Number(Math.min(...pPnlPctObs).toFixed(4))
                : null;

            return {
                pairKey: acc.pairKey,
                pairSymbol: acc.pairSymbol,
                pairIdentified: acc.pairIdentified,
                token0Mint: acc.token0Mint,
                token1Mint: acc.token1Mint,
                pools: Array.from(acc.pools).sort(),
                closedPositionCount: pPositions.length,
                samplePnlUsd,
                winRate,
                medianPositionPnlPct: computeMedian(pPnlPctObs),
                avgPositionPnlPct: computeMean(pPnlPctObs),
                medianInitialEntryUsd: computeMedian(pInitialEntryObs),
                avgHoldingDurationSeconds: computeMean(pHoldObs),
                worstPositionPct,
            };
        })
        .sort((a, b) => {
            if (b.closedPositionCount !== a.closedPositionCount) {
                return b.closedPositionCount - a.closedPositionCount;
            }
            return a.pairKey.localeCompare(b.pairKey);
        });

    // Build Position Size by Pair for Trading Behavior
    const positionSizeByPair: PairPositionSizeItem[] = Array.from(pairMap.values())
        .map((acc) => {
            const pPositions = acc.positions;
            const pInitialEntryObs = pPositions
                .filter((p) =>
                    isFiniteNumber(p.initialEntryUsd) &&
                    (p.dataQuality?.initialEntryStatus === "VERIFIED_OPEN_EVENT" ||
                        p.dataQuality?.initialEntryStatus === "VERIFIED_ASSOCIATED_ADD")
                )
                .map((p) => p.initialEntryUsd!);
            const pTotalDepositsObs = pPositions.map((p) => p.totalDepositsUsd).filter(isFiniteNumber);

            return {
                pairKey: acc.pairKey,
                pairSymbol: acc.pairSymbol,
                medianInitialEntryUsd: computeMedian(pInitialEntryObs),
                avgInitialEntryUsd: computeMean(pInitialEntryObs),
                medianTotalDepositsUsd: computeMedian(pTotalDepositsObs),
                avgTotalDepositsUsd: computeMean(pTotalDepositsObs),
                closedPositionCount: pPositions.length,
            };
        })
        .sort((a, b) => b.closedPositionCount - a.closedPositionCount);

    const tradingBehavior: TradingBehaviorAnalytics = {
        avgHoldingTimeSeconds: computeMean(holdDurationObs),
        medianHoldingTimeSeconds: computeMedian(holdDurationObs),
        holdingTimeDistribution,
        observedEntriesPerDay,
        entryActivityLabel: "Observed entries among analyzed closed positions",
        entryActivityByHourWib,
        entryActivityByWeekdayWib,
        activeEntryDays: activeDatesWib.size,
        openingTimeCoverage,
        positionSizeByPair,
    };

    // Build Pool Breakdown items
    const poolBreakdown: PoolBreakdownItem[] = Array.from(poolMap.values())
        .map((acc) => {
            const pPositions = acc.positions;
            const pPnlUsdObs = pPositions.map((p) => p.pnlUsd).filter(isFiniteNumber);
            const pPnlPctObs = pPositions.map((p) => p.pnlPct).filter(isFiniteNumber);
            const pHoldObs = pPositions.map((p) => p.holdDurationSeconds).filter(isFiniteNumber);
            const pInitialEntryObs = pPositions
                .filter((p) =>
                    isFiniteNumber(p.initialEntryUsd) &&
                    (p.dataQuality?.initialEntryStatus === "VERIFIED_OPEN_EVENT" ||
                        p.dataQuality?.initialEntryStatus === "VERIFIED_ASSOCIATED_ADD")
                )
                .map((p) => p.initialEntryUsd!);

            const wins = pPositions.filter((p) => p.winLoss === "WIN").length;
            const losses = pPositions.filter((p) => p.winLoss === "LOSS").length;
            const breakevens = pPositions.filter((p) => p.winLoss === "BREAKEVEN").length;
            const denom = wins + losses + breakevens;
            const winRate = denom > 0 ? Number(((wins / denom) * 100).toFixed(2)) : null;

            const samplePnlUsd = pPnlUsdObs.length > 0
                ? Number(pPnlUsdObs.reduce((sum, v) => sum + v, 0).toFixed(4))
                : null;

            const worstPositionPct = pPnlPctObs.length > 0
                ? Number(Math.min(...pPnlPctObs).toFixed(4))
                : null;

            return {
                poolAddress: acc.poolAddress,
                pairName: acc.pairName,
                tokenXMint: acc.tokenXMint,
                tokenYMint: acc.tokenYMint,
                closedPositionCount: pPositions.length,
                samplePnlUsd,
                winRate,
                medianPositionPnlPct: computeMedian(pPnlPctObs),
                avgPositionPnlPct: computeMean(pPnlPctObs),
                medianInitialEntryUsd: computeMedian(pInitialEntryObs),
                avgHoldingDurationSeconds: computeMean(pHoldObs),
                worstPositionPct,
            };
        })
        .sort((a, b) => {
            if (b.closedPositionCount !== a.closedPositionCount) {
                return b.closedPositionCount - a.closedPositionCount;
            }
            return a.poolAddress.localeCompare(b.poolAddress);
        });

    // --------------------------------------------------
    // 6. METRIC OBSERVATION COVERAGE & RESULT ASSEMBLY
    // --------------------------------------------------
    const metricCoverage: MetricObservationCoverage = {
        analyzedPositions: totalAnalyzed,
        initialEntryObservations: verifiedInitialEntries.length,
        initialEntryCoveragePct: totalAnalyzed > 0
            ? Number(((verifiedInitialEntries.length / totalAnalyzed) * 100).toFixed(2))
            : 0,
        totalDepositsObservations: totalDepositsObs.length,
        additionalLiquidityObservations: additionalLiquidityObs.length,
        pnlUsdObservations: pnlUsdObs.length,
        pnlPctObservations: pnlPctObs.length,
        holdingTimeObservations: holdDurationObs.length,
        openedAtObservations: openedAtObs.length,
        closedAtObservations: closedAtObs.length,
    };

    return {
        schemaVersion: "v1",
        wallet: dataset.wallet,
        period: dataset.period,
        generatedAt: new Date().toISOString(),
        sourceDatasetFetchedAt: dataset.fetchedAt,
        timeframe: { ...dataset.timeframe },
        sourceCoverage: { ...dataset.sourceCoverage },
        sampling: { ...dataset.sampling },
        dataQuality: { ...dataset.dataQuality },
        metricCoverage,
        capital,
        profitability,
        riskAndConsistency,
        tradingBehavior,
        pairBreakdown,
        poolBreakdown,
    };
}
