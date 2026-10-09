// @ts-check
/**
 * Monitoring Assessment Engine V1
 *
 * Deterministic, explainable screening heuristic assessing whether a Meteora DLMM
 * wallet is worth monitoring and estimating the manual followability of its historical positions.
 *
 * Strictly read-only and side-effect free: operates on published dataset + metrics pair.
 * Screening heuristic ONLY — NOT a prediction of future profitability or financial advice.
 */

export const ASSESSMENT_VERSION = "v1";

/**
 * Monitoring Verdict
 * @readonly
 * @enum {string}
 */
export const MONITORING_VERDICTS = Object.freeze({
    WORTH_MONITORING: "WORTH_MONITORING",
    WATCH_WITH_CAUTION: "WATCH_WITH_CAUTION",
    NOT_RECOMMENDED: "NOT_RECOMMENDED",
    INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
});

/**
 * Historical Manual Followability
 * @readonly
 * @enum {string}
 */
export const MANUAL_FOLLOWABILITY = Object.freeze({
    HIGH: "HIGH",
    MODERATE: "MODERATE",
    LOW: "LOW",
    UNKNOWN: "UNKNOWN",
});

/**
 * Initial Configurable Scoring Weights & Thresholds (Heuristic V1)
 */
export const SCORING_THRESHOLDS = Object.freeze({
    RISK_CONSISTENCY: {
        MAX_SCORE: 35,
        CVAR10_TIER_1_MIN: -10, // >= -10% -> 20 pts
        CVAR10_TIER_1_POINTS: 20,
        CVAR10_TIER_2_MIN: -20, // >= -20% -> 10 pts
        CVAR10_TIER_2_POINTS: 10,
        WEEKLY_RATIO_TIER_1_MIN: 60, // >= 60% -> 15 pts
        WEEKLY_RATIO_TIER_1_POINTS: 15,
        WEEKLY_RATIO_TIER_2_MIN: 45, // >= 45% -> 7 pts
        WEEKLY_RATIO_TIER_2_POINTS: 7,
    },
    PROFIT_CONCENTRATION: {
        MAX_SCORE: 25,
        TOP1_TIER_1_MAX: 25, // <= 25% -> 15 pts
        TOP1_TIER_1_POINTS: 15,
        TOP1_TIER_2_MAX: 40, // <= 40% -> 7 pts
        TOP1_TIER_2_POINTS: 7,
        TOP5_TIER_1_MAX: 60, // <= 60% -> 10 pts
        TOP5_TIER_1_POINTS: 10,
        TOP5_TIER_2_MAX: 80, // <= 80% -> 5 pts
        TOP5_TIER_2_POINTS: 5,
    },
    TRACK_RECORD: {
        MAX_SCORE: 25,
        PNL_OBS_TIER_1_MIN: 100, // >= 100 each -> 12 pts
        PNL_OBS_TIER_1_POINTS: 12,
        PNL_OBS_TIER_2_MIN: 40, // >= 40 each -> 6 pts
        PNL_OBS_TIER_2_POINTS: 6,
        WEEKS_TIER_1_MIN: 8, // >= 8 weeks -> 8 pts
        WEEKS_TIER_1_POINTS: 8,
        WEEKS_TIER_2_MIN: 4, // >= 4 weeks -> 4 pts
        WEEKS_TIER_2_POINTS: 4,
        COVERAGE_MIN_PCT: 90, // >= 90% each -> 5 pts
        COVERAGE_POINTS: 5,
    },
    PROFITABILITY: {
        MAX_SCORE: 15,
        SAMPLE_TOTAL_PNL_POINTS: 8,
        MEDIAN_PNL_PCT_POINTS: 7,
    },
});

export const EVIDENCE_GATES = Object.freeze({
    MIN_ANALYZED_POSITIONS: 30,
    MIN_KNOWN_PNL_USD_OBS: 20,
    MIN_KNOWN_PNL_PCT_OBS: 20,
    MIN_OBSERVED_WEEKS_WITH_KNOWN_PNL: 3,
});

export const WORTH_MONITORING_GATES = Object.freeze({
    MIN_SCORE: 75,
    MIN_KNOWN_PNL_POSITIONS: 60,
    MIN_OBSERVED_WEEKS: 6,
    CVAR10_MIN: -20,
    TOP1_CONCENTRATION_MAX: 40,
    MIN_PNL_OBSERVATION_COVERAGE_PCT: 80,
    MIN_SAMPLING_COVERAGE_PCT_IF_CAPPED: 50,
});

export const FOLLOWABILITY_THRESHOLDS = Object.freeze({
    MIN_HOLDING_TIME_OBS: 20,
    MIN_QUALIFYING_OPENING_OBS: 10,
    MIN_OPENING_TIME_COVERAGE_PCT: 50,
    HIGH_MEDIAN_HOLD_HOURS: 6,
    HIGH_MAX_ENTRIES_PER_DAY: 2,
    MODERATE_MEDIAN_HOLD_HOURS: 1,
    MODERATE_MAX_ENTRIES_PER_DAY: 6,
});

/**
 * Format duration in human-readable compact form
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatDurationSimple(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Pure evaluation function: Computes deterministic monitoring assessment
 * from an atomic dataset + metrics pair.
 *
 * @param {any} dataset Step 1 PositionAnalyticsDataset
 * @param {any} metrics Step 2 PositionMetricsResult
 * @returns {any} Structured monitoring assessment
 */
export function computeMonitoringAssessment(dataset, metrics) {
    if (!dataset || !metrics) {
        throw new Error("Both dataset and metrics are required to compute monitoring assessment");
    }

    const wallet = metrics.wallet || dataset.wallet || "";
    const period = metrics.period || dataset.period || "30D";
    const sourceDatasetFetchedAt = metrics.sourceDatasetFetchedAt || dataset.fetchedAt || "";

    // 1. Core Observation Counts & Boundaries
    const analyzedClosedPositions = Number.isFinite(metrics.sampling?.analyzedPositions)
        ? metrics.sampling.analyzedPositions
        : Array.isArray(dataset.positions)
        ? dataset.positions.length
        : 0;

    const totalEligiblePositions = Number.isFinite(metrics.sampling?.totalEligiblePositions)
        ? metrics.sampling.totalEligiblePositions
        : Number.isFinite(dataset.sourceCoverage?.totalEligiblePositions)
        ? dataset.sourceCoverage.totalEligiblePositions
        : analyzedClosedPositions;

    const isSampled = Boolean(
        metrics.sampling?.isSampled ??
        (totalEligiblePositions > analyzedClosedPositions && totalEligiblePositions > 1000)
    );

    const samplingCoveragePct = Number.isFinite(metrics.sampling?.coveragePct)
        ? metrics.sampling.coveragePct
        : totalEligiblePositions > 0
        ? Number(((analyzedClosedPositions / totalEligiblePositions) * 100).toFixed(2))
        : 100;

    const sourceCoverageStatus =
        metrics.sourceCoverage?.status ||
        dataset.sourceCoverage?.status ||
        "UNAVAILABLE";

    const pnlUsdObservations = Number.isFinite(metrics.metricCoverage?.pnlUsdObservations)
        ? metrics.metricCoverage.pnlUsdObservations
        : 0;

    const pnlPctObservations = Number.isFinite(metrics.metricCoverage?.pnlPctObservations)
        ? metrics.metricCoverage.pnlPctObservations
        : 0;

    const pnlUsdCoveragePct = analyzedClosedPositions > 0
        ? Number(((pnlUsdObservations / analyzedClosedPositions) * 100).toFixed(2))
        : 0;

    const pnlPctCoveragePct = analyzedClosedPositions > 0
        ? Number(((pnlPctObservations / analyzedClosedPositions) * 100).toFixed(2))
        : 0;

    // Weekly PnL Observations
    const weeklyItems = Array.isArray(metrics.riskAndConsistency?.weeklyRealizedPositionPnlUsd)
        ? metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd
        : [];

    const weeksWithKnownPnl = weeklyItems.filter(
        (w) => w && w.realizedPnlUsd !== null && Number.isFinite(w.realizedPnlUsd)
    );
    const observedWeeksWithKnownPnl = weeksWithKnownPnl.length;

    const profitableWeeksCount = Number.isFinite(metrics.riskAndConsistency?.profitableWeeksCount)
        ? metrics.riskAndConsistency.profitableWeeksCount
        : weeksWithKnownPnl.filter((w) => w.realizedPnlUsd > 0.0001).length;

    const profitableWeeksRatioPct = observedWeeksWithKnownPnl > 0
        ? Number(((profitableWeeksCount / observedWeeksWithKnownPnl) * 100).toFixed(2))
        : null;

    // Risk, Profitability & Concentration Metrics
    const cvar10PositionPnlPct = Number.isFinite(metrics.riskAndConsistency?.cvar10PositionPnlPct)
        ? metrics.riskAndConsistency.cvar10PositionPnlPct
        : null;

    const top1ProfitConcentrationPct = Number.isFinite(metrics.riskAndConsistency?.top1ProfitConcentrationPct)
        ? metrics.riskAndConsistency.top1ProfitConcentrationPct
        : null;

    const top5ProfitConcentrationPct = Number.isFinite(metrics.riskAndConsistency?.top5ProfitConcentrationPct)
        ? metrics.riskAndConsistency.top5ProfitConcentrationPct
        : null;

    const sampleTotalPnlUsd = Number.isFinite(metrics.profitability?.sampleTotalPnlUsd)
        ? metrics.profitability.sampleTotalPnlUsd
        : null;

    const medianPositionPnlPct = Number.isFinite(metrics.profitability?.medianPositionPnlPct)
        ? metrics.profitability.medianPositionPnlPct
        : null;

    // Followability & Trading Behavior Metrics
    const holdingTimeObservations = Number.isFinite(metrics.metricCoverage?.holdingTimeObservations)
        ? metrics.metricCoverage.holdingTimeObservations
        : 0;

    const qualifyingOpenedAtObservations = Number.isFinite(
        metrics.tradingBehavior?.openingTimeCoverage?.qualifyingOpenedAtObservations
    )
        ? metrics.tradingBehavior.openingTimeCoverage.qualifyingOpenedAtObservations
        : Number.isFinite(metrics.tradingBehavior?.openingTimeCoverage?.openedAtObservations)
        ? metrics.tradingBehavior.openingTimeCoverage.openedAtObservations
        : Number.isFinite(metrics.metricCoverage?.openedAtObservations)
        ? metrics.metricCoverage.openedAtObservations
        : 0;

    const openingTimeCoveragePct = Number.isFinite(
        metrics.tradingBehavior?.openingTimeCoverage?.coveragePct
    )
        ? metrics.tradingBehavior.openingTimeCoverage.coveragePct
        : analyzedClosedPositions > 0
        ? Number(((qualifyingOpenedAtObservations / analyzedClosedPositions) * 100).toFixed(2))
        : 0;

    const medianHoldingTimeSeconds = Number.isFinite(metrics.tradingBehavior?.medianHoldingTimeSeconds)
        ? metrics.tradingBehavior.medianHoldingTimeSeconds
        : null;

    const observedEntriesPerDay = Number.isFinite(metrics.tradingBehavior?.observedEntriesPerDay)
        ? metrics.tradingBehavior.observedEntriesPerDay
        : null;

    const medianInitialEntryUsd = Number.isFinite(metrics.capital?.medianInitialEntryUsd)
        ? metrics.capital.medianInitialEntryUsd
        : null;

    const historyStart = metrics.timeframe?.observedStart || dataset.timeframe?.observedStart || null;
    const historyEnd = metrics.timeframe?.observedEnd || dataset.timeframe?.observedEnd || null;

    // -------------------------------------------------------------------------
    // 2. CHECK INSUFFICIENT DATA GATES
    // -------------------------------------------------------------------------
    const missingEvidence = [];

    if (analyzedClosedPositions < EVIDENCE_GATES.MIN_ANALYZED_POSITIONS) {
        missingEvidence.push(
            `Analyzed closed positions (${analyzedClosedPositions}) < ${EVIDENCE_GATES.MIN_ANALYZED_POSITIONS} minimum required`
        );
    }
    if (pnlUsdObservations < EVIDENCE_GATES.MIN_KNOWN_PNL_USD_OBS) {
        missingEvidence.push(
            `Known PnL USD observations (${pnlUsdObservations}) < ${EVIDENCE_GATES.MIN_KNOWN_PNL_USD_OBS} minimum required`
        );
    }
    if (pnlPctObservations < EVIDENCE_GATES.MIN_KNOWN_PNL_PCT_OBS) {
        missingEvidence.push(
            `Known PnL % observations (${pnlPctObservations}) < ${EVIDENCE_GATES.MIN_KNOWN_PNL_PCT_OBS} minimum required`
        );
    }
    if (observedWeeksWithKnownPnl < EVIDENCE_GATES.MIN_OBSERVED_WEEKS_WITH_KNOWN_PNL) {
        missingEvidence.push(
            `Observed weeks with known PnL (${observedWeeksWithKnownPnl}) < ${EVIDENCE_GATES.MIN_OBSERVED_WEEKS_WITH_KNOWN_PNL} minimum required`
        );
    }
    if (sourceCoverageStatus === "UNAVAILABLE") {
        missingEvidence.push("Source data coverage status is UNAVAILABLE");
    }
    if (cvar10PositionPnlPct === null) {
        missingEvidence.push("Critical risk metric CVaR10 is unavailable");
    }

    const isInsufficient = missingEvidence.length > 0;

    // -------------------------------------------------------------------------
    // 3. SCORE CALCULATION (Only when data is sufficient)
    // -------------------------------------------------------------------------
    let scoreComponents = null;
    let monitoringScore = null;

    if (!isInsufficient) {
        // Dimension A: Risk & Consistency (max 35)
        let cvar10Points = 0;
        if (cvar10PositionPnlPct !== null && cvar10PositionPnlPct >= SCORING_THRESHOLDS.RISK_CONSISTENCY.CVAR10_TIER_1_MIN) {
            cvar10Points = SCORING_THRESHOLDS.RISK_CONSISTENCY.CVAR10_TIER_1_POINTS;
        } else if (cvar10PositionPnlPct !== null && cvar10PositionPnlPct >= SCORING_THRESHOLDS.RISK_CONSISTENCY.CVAR10_TIER_2_MIN) {
            cvar10Points = SCORING_THRESHOLDS.RISK_CONSISTENCY.CVAR10_TIER_2_POINTS;
        }

        let weeklyRatioPoints = 0;
        if (profitableWeeksRatioPct !== null && profitableWeeksRatioPct >= SCORING_THRESHOLDS.RISK_CONSISTENCY.WEEKLY_RATIO_TIER_1_MIN) {
            weeklyRatioPoints = SCORING_THRESHOLDS.RISK_CONSISTENCY.WEEKLY_RATIO_TIER_1_POINTS;
        } else if (profitableWeeksRatioPct !== null && profitableWeeksRatioPct >= SCORING_THRESHOLDS.RISK_CONSISTENCY.WEEKLY_RATIO_TIER_2_MIN) {
            weeklyRatioPoints = SCORING_THRESHOLDS.RISK_CONSISTENCY.WEEKLY_RATIO_TIER_2_POINTS;
        }

        const riskAndConsistencyScore = cvar10Points + weeklyRatioPoints;

        // Dimension B: Profit Concentration (max 25)
        // Rule: Do not treat null concentration or absence of positive profits as zero concentration.
        let top1Points = 0;
        if (top1ProfitConcentrationPct !== null) {
            if (top1ProfitConcentrationPct <= SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP1_TIER_1_MAX) {
                top1Points = SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP1_TIER_1_POINTS;
            } else if (top1ProfitConcentrationPct <= SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP1_TIER_2_MAX) {
                top1Points = SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP1_TIER_2_POINTS;
            }
        }

        let top5Points = 0;
        if (top5ProfitConcentrationPct !== null) {
            if (top5ProfitConcentrationPct <= SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP5_TIER_1_MAX) {
                top5Points = SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP5_TIER_1_POINTS;
            } else if (top5ProfitConcentrationPct <= SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP5_TIER_2_MAX) {
                top5Points = SCORING_THRESHOLDS.PROFIT_CONCENTRATION.TOP5_TIER_2_POINTS;
            }
        }

        const profitConcentrationScore = top1Points + top5Points;

        // Dimension C: Track Record / Evidence (max 25)
        let pnlObsPoints = 0;
        if (
            pnlUsdObservations >= SCORING_THRESHOLDS.TRACK_RECORD.PNL_OBS_TIER_1_MIN &&
            pnlPctObservations >= SCORING_THRESHOLDS.TRACK_RECORD.PNL_OBS_TIER_1_MIN
        ) {
            pnlObsPoints = SCORING_THRESHOLDS.TRACK_RECORD.PNL_OBS_TIER_1_POINTS;
        } else if (
            pnlUsdObservations >= SCORING_THRESHOLDS.TRACK_RECORD.PNL_OBS_TIER_2_MIN &&
            pnlPctObservations >= SCORING_THRESHOLDS.TRACK_RECORD.PNL_OBS_TIER_2_MIN
        ) {
            pnlObsPoints = SCORING_THRESHOLDS.TRACK_RECORD.PNL_OBS_TIER_2_POINTS;
        }

        let weeksPoints = 0;
        if (observedWeeksWithKnownPnl >= SCORING_THRESHOLDS.TRACK_RECORD.WEEKS_TIER_1_MIN) {
            weeksPoints = SCORING_THRESHOLDS.TRACK_RECORD.WEEKS_TIER_1_POINTS;
        } else if (observedWeeksWithKnownPnl >= SCORING_THRESHOLDS.TRACK_RECORD.WEEKS_TIER_2_MIN) {
            weeksPoints = SCORING_THRESHOLDS.TRACK_RECORD.WEEKS_TIER_2_POINTS;
        }

        let coveragePoints = 0;
        if (
            pnlUsdCoveragePct >= SCORING_THRESHOLDS.TRACK_RECORD.COVERAGE_MIN_PCT &&
            pnlPctCoveragePct >= SCORING_THRESHOLDS.TRACK_RECORD.COVERAGE_MIN_PCT &&
            (sourceCoverageStatus === "COMPLETE" || sourceCoverageStatus === "BOUNDED_HISTORY")
        ) {
            coveragePoints = SCORING_THRESHOLDS.TRACK_RECORD.COVERAGE_POINTS;
        }

        const trackRecordScore = pnlObsPoints + weeksPoints + coveragePoints;

        // Dimension D: Profitability (max 15)
        const sampleTotalPnlPoints =
            sampleTotalPnlUsd !== null && sampleTotalPnlUsd > 0
                ? SCORING_THRESHOLDS.PROFITABILITY.SAMPLE_TOTAL_PNL_POINTS
                : 0;

        const medianPnlPctPoints =
            medianPositionPnlPct !== null && medianPositionPnlPct > 0
                ? SCORING_THRESHOLDS.PROFITABILITY.MEDIAN_PNL_PCT_POINTS
                : 0;

        const profitabilityScore = sampleTotalPnlPoints + medianPnlPctPoints;

        monitoringScore = riskAndConsistencyScore + profitConcentrationScore + trackRecordScore + profitabilityScore;

        scoreComponents = {
            riskAndConsistency: {
                score: riskAndConsistencyScore,
                maxScore: SCORING_THRESHOLDS.RISK_CONSISTENCY.MAX_SCORE,
                cvar10Points,
                weeklyRatioPoints,
                cvar10: cvar10PositionPnlPct,
                profitableWeeksRatioPct,
            },
            profitConcentration: {
                score: profitConcentrationScore,
                maxScore: SCORING_THRESHOLDS.PROFIT_CONCENTRATION.MAX_SCORE,
                top1Points,
                top5Points,
                top1ConcentrationPct: top1ProfitConcentrationPct,
                top5ConcentrationPct: top5ProfitConcentrationPct,
            },
            trackRecord: {
                score: trackRecordScore,
                maxScore: SCORING_THRESHOLDS.TRACK_RECORD.MAX_SCORE,
                pnlObsPoints,
                weeksPoints,
                coveragePoints,
                pnlUsdObservations,
                pnlPctObservations,
                observedWeeksWithKnownPnl,
                pnlUsdCoveragePct,
                pnlPctCoveragePct,
            },
            profitability: {
                score: profitabilityScore,
                maxScore: SCORING_THRESHOLDS.PROFITABILITY.MAX_SCORE,
                sampleTotalPnlPoints,
                medianPnlPctPoints,
                sampleTotalPnlUsd,
                medianPositionPnlPct,
            },
        };
    }

    // -------------------------------------------------------------------------
    // 4. VERDICT DETERMINATION (Quality Gates)
    // -------------------------------------------------------------------------
    let verdict;
    /** @type {string[]} */
    const failedWorthGates = [];

    if (isInsufficient) {
        verdict = MONITORING_VERDICTS.INSUFFICIENT_DATA;
    } else {
        // Evaluate WORTH_MONITORING Gates
        if (monitoringScore === null || monitoringScore < WORTH_MONITORING_GATES.MIN_SCORE) {
            failedWorthGates.push(`Score (${monitoringScore}) is below ${WORTH_MONITORING_GATES.MIN_SCORE}`);
        }
        if (
            pnlUsdObservations < WORTH_MONITORING_GATES.MIN_KNOWN_PNL_POSITIONS ||
            pnlPctObservations < WORTH_MONITORING_GATES.MIN_KNOWN_PNL_POSITIONS
        ) {
            failedWorthGates.push(
                `Positions with known PnL (${Math.min(pnlUsdObservations, pnlPctObservations)}) < ${WORTH_MONITORING_GATES.MIN_KNOWN_PNL_POSITIONS}`
            );
        }
        if (observedWeeksWithKnownPnl < WORTH_MONITORING_GATES.MIN_OBSERVED_WEEKS) {
            failedWorthGates.push(
                `Observed weeks with known PnL (${observedWeeksWithKnownPnl}) < ${WORTH_MONITORING_GATES.MIN_OBSERVED_WEEKS}`
            );
        }
        if (sampleTotalPnlUsd === null || sampleTotalPnlUsd <= 0) {
            failedWorthGates.push("Sample total realized PnL USD is not positive");
        }
        if (medianPositionPnlPct === null || medianPositionPnlPct <= 0) {
            failedWorthGates.push("Median position PnL % is not positive");
        }
        if (cvar10PositionPnlPct === null || cvar10PositionPnlPct < WORTH_MONITORING_GATES.CVAR10_MIN) {
            failedWorthGates.push(
                `CVaR10 (${cvar10PositionPnlPct !== null ? `${cvar10PositionPnlPct.toFixed(1)}%` : "unavailable"}) is worse than ${WORTH_MONITORING_GATES.CVAR10_MIN}%`
            );
        }
        if (top1ProfitConcentrationPct === null || top1ProfitConcentrationPct > WORTH_MONITORING_GATES.TOP1_CONCENTRATION_MAX) {
            failedWorthGates.push(
                `Top 1 concentration (${top1ProfitConcentrationPct !== null ? `${top1ProfitConcentrationPct.toFixed(1)}%` : "unavailable"}) exceeds ${WORTH_MONITORING_GATES.TOP1_CONCENTRATION_MAX}%`
            );
        }
        if (sourceCoverageStatus !== "COMPLETE" && sourceCoverageStatus !== "BOUNDED_HISTORY") {
            failedWorthGates.push(
                `Source coverage status (${sourceCoverageStatus}) is not COMPLETE or BOUNDED_HISTORY`
            );
        }
        if (
            pnlUsdCoveragePct < WORTH_MONITORING_GATES.MIN_PNL_OBSERVATION_COVERAGE_PCT ||
            pnlPctCoveragePct < WORTH_MONITORING_GATES.MIN_PNL_OBSERVATION_COVERAGE_PCT
        ) {
            failedWorthGates.push(
                `PnL observation coverage (${Math.min(pnlUsdCoveragePct, pnlPctCoveragePct).toFixed(1)}%) < ${WORTH_MONITORING_GATES.MIN_PNL_OBSERVATION_COVERAGE_PCT}%`
            );
        }
        if (
            (isSampled || analyzedClosedPositions >= 1000) &&
            samplingCoveragePct < WORTH_MONITORING_GATES.MIN_SAMPLING_COVERAGE_PCT_IF_CAPPED
        ) {
            failedWorthGates.push(
                `Sampling coverage (${samplingCoveragePct.toFixed(1)}%) < ${WORTH_MONITORING_GATES.MIN_SAMPLING_COVERAGE_PCT_IF_CAPPED}% on capped history`
            );
        }

        if (failedWorthGates.length === 0) {
            verdict = MONITORING_VERDICTS.WORTH_MONITORING;
        } else if (monitoringScore !== null && monitoringScore >= 45) {
            verdict = MONITORING_VERDICTS.WATCH_WITH_CAUTION;
        } else {
            verdict = MONITORING_VERDICTS.NOT_RECOMMENDED;
        }
    }

    // -------------------------------------------------------------------------
    // 5. MANUAL FOLLOWABILITY EVALUATION (Independent)
    // -------------------------------------------------------------------------
    let manualFollowability;
    const followabilityEligibilityFailed = [];

    if (holdingTimeObservations < FOLLOWABILITY_THRESHOLDS.MIN_HOLDING_TIME_OBS) {
        followabilityEligibilityFailed.push(
            `Holding-time observations (${holdingTimeObservations}) < ${FOLLOWABILITY_THRESHOLDS.MIN_HOLDING_TIME_OBS}`
        );
    }
    if (qualifyingOpenedAtObservations < FOLLOWABILITY_THRESHOLDS.MIN_QUALIFYING_OPENING_OBS) {
        followabilityEligibilityFailed.push(
            `Qualifying opening timestamps (${qualifyingOpenedAtObservations}) < ${FOLLOWABILITY_THRESHOLDS.MIN_QUALIFYING_OPENING_OBS}`
        );
    }
    if (observedEntriesPerDay === null || !Number.isFinite(observedEntriesPerDay)) {
        followabilityEligibilityFailed.push("Observed entries per day is invalid or missing");
    }
    if (openingTimeCoveragePct < FOLLOWABILITY_THRESHOLDS.MIN_OPENING_TIME_COVERAGE_PCT) {
        followabilityEligibilityFailed.push(
            `Opening-time coverage (${openingTimeCoveragePct.toFixed(1)}%) < ${FOLLOWABILITY_THRESHOLDS.MIN_OPENING_TIME_COVERAGE_PCT}%`
        );
    }
    if (medianHoldingTimeSeconds === null || !Number.isFinite(medianHoldingTimeSeconds)) {
        followabilityEligibilityFailed.push("Median holding time is invalid or missing");
    }

    if (followabilityEligibilityFailed.length > 0) {
        manualFollowability = MANUAL_FOLLOWABILITY.UNKNOWN;
    } else {
        const medianHoldHours = medianHoldingTimeSeconds / 3600;
        if (
            medianHoldHours >= FOLLOWABILITY_THRESHOLDS.HIGH_MEDIAN_HOLD_HOURS &&
            observedEntriesPerDay <= FOLLOWABILITY_THRESHOLDS.HIGH_MAX_ENTRIES_PER_DAY
        ) {
            manualFollowability = MANUAL_FOLLOWABILITY.HIGH;
        } else if (
            medianHoldHours >= FOLLOWABILITY_THRESHOLDS.MODERATE_MEDIAN_HOLD_HOURS &&
            observedEntriesPerDay <= FOLLOWABILITY_THRESHOLDS.MODERATE_MAX_ENTRIES_PER_DAY
        ) {
            manualFollowability = MANUAL_FOLLOWABILITY.MODERATE;
        } else {
            manualFollowability = MANUAL_FOLLOWABILITY.LOW;
        }
    }

    // -------------------------------------------------------------------------
    // 6. EXPLAINABILITY: REASONS & CONCERNS (Max 4 each)
    // -------------------------------------------------------------------------
    /** @type {string[]} */
    const allReasons = [];
    /** @type {string[]} */
    const allConcerns = [];

    if (isInsufficient) {
        for (const item of missingEvidence) {
            allConcerns.push(item);
        }
        allReasons.push(`Observed ${analyzedClosedPositions} closed position records`);
    } else {
        // Supporting reasons
        if (profitableWeeksCount > 0 && observedWeeksWithKnownPnl > 0) {
            allReasons.push(
                `Profitable in ${profitableWeeksCount} of ${observedWeeksWithKnownPnl} observed weeks (${profitableWeeksRatioPct?.toFixed(0)}%)`
            );
        }
        if (cvar10PositionPnlPct !== null && cvar10PositionPnlPct >= -10) {
            allReasons.push(`Controlled tail risk: CVaR10 of ${cvar10PositionPnlPct.toFixed(1)}% (>= -10% threshold)`);
        } else if (cvar10PositionPnlPct !== null && cvar10PositionPnlPct >= -20) {
            allReasons.push(`Acceptable tail risk: CVaR10 of ${cvar10PositionPnlPct.toFixed(1)}% (>= -20% threshold)`);
        }

        if (top1ProfitConcentrationPct !== null && top1ProfitConcentrationPct <= 25) {
            allReasons.push(
                `Distributed profit base: Top position accounts for ${top1ProfitConcentrationPct.toFixed(1)}% of profits (<= 25%)`
            );
        } else if (top1ProfitConcentrationPct !== null && top1ProfitConcentrationPct <= 40) {
            allReasons.push(
                `Moderate profit concentration: Top position accounts for ${top1ProfitConcentrationPct.toFixed(1)}% of profits (<= 40%)`
            );
        }

        if (sampleTotalPnlUsd !== null && sampleTotalPnlUsd > 0 && medianPositionPnlPct !== null && medianPositionPnlPct > 0) {
            allReasons.push(
                `Positive sample realized PnL of $${Math.round(sampleTotalPnlUsd).toLocaleString()} with positive median return (+${medianPositionPnlPct.toFixed(2)}%)`
            );
        }

        if (pnlUsdObservations >= 100) {
            allReasons.push(
                `Established track record: ${pnlUsdObservations} closed positions with known PnL across ${observedWeeksWithKnownPnl} observed weeks`
            );
        } else if (pnlUsdObservations >= 40) {
            allReasons.push(
                `Observed track record: ${pnlUsdObservations} closed positions with known PnL across ${observedWeeksWithKnownPnl} observed weeks`
            );
        }

        if (
            pnlUsdCoveragePct >= 90 &&
            (sourceCoverageStatus === "COMPLETE" || sourceCoverageStatus === "BOUNDED_HISTORY")
        ) {
            allReasons.push(
                `High observation coverage: ${pnlUsdCoveragePct.toFixed(0)}% known PnL coverage with ${sourceCoverageStatus} source extraction`
            );
        }

        if (manualFollowability === MANUAL_FOLLOWABILITY.HIGH && medianHoldingTimeSeconds !== null && observedEntriesPerDay !== null) {
            allReasons.push(
                `Manual followability favorable: median hold duration is ${formatDurationSimple(medianHoldingTimeSeconds)} with ${observedEntriesPerDay.toFixed(1)} entries/day`
            );
        }

        // Risk concerns / failed gates
        if (failedWorthGates.length > 0 && monitoringScore !== null && monitoringScore >= 75) {
            for (const gate of failedWorthGates) {
                allConcerns.push(`Failed Worth gate: ${gate}`);
            }
        }

        if (top1ProfitConcentrationPct !== null && top1ProfitConcentrationPct > 40) {
            allConcerns.push(
                `High profit concentration: top position accounts for ${top1ProfitConcentrationPct.toFixed(1)}% of total profits (> 40%)`
            );
        }

        if (cvar10PositionPnlPct !== null && cvar10PositionPnlPct < -20) {
            allConcerns.push(
                `Elevated tail risk: CVaR10 of ${cvar10PositionPnlPct.toFixed(1)}% is worse than -20% threshold`
            );
        }

        if (sampleTotalPnlUsd !== null && sampleTotalPnlUsd <= 0) {
            allConcerns.push(
                `Sample total realized PnL is non-positive ($${Math.round(sampleTotalPnlUsd).toLocaleString()})`
            );
        }

        if (medianPositionPnlPct !== null && medianPositionPnlPct <= 0) {
            allConcerns.push(`Median position return is non-positive (${medianPositionPnlPct.toFixed(2)}%)`);
        }

        if (observedWeeksWithKnownPnl < 6 && period === "30D") {
            allConcerns.push(
                `30D snapshot history (${observedWeeksWithKnownPnl} observed weeks) cannot satisfy the 6-week Worth gate`
            );
        } else if (observedWeeksWithKnownPnl < 6) {
            allConcerns.push(
                `Limited history: only ${observedWeeksWithKnownPnl} observed weeks with known PnL (< 6 weeks required for worth-monitoring)`
            );
        }

        if (sourceCoverageStatus === "PARTIAL") {
            allConcerns.push("Partial source coverage: some DLMM pool positions could not be fully extracted");
        }

        if (isSampled && samplingCoveragePct < 50) {
            allConcerns.push(
                `Sampling coverage is ${samplingCoveragePct.toFixed(1)}% (< 50% threshold for capped 1,000-position history)`
            );
        }

        if (manualFollowability === MANUAL_FOLLOWABILITY.LOW && medianHoldingTimeSeconds !== null) {
            allConcerns.push(
                `Short median hold duration (${formatDurationSimple(medianHoldingTimeSeconds)}) with ${observedEntriesPerDay?.toFixed(1) ?? "—"} entries/day makes manual following difficult`
            );
        }
    }

    const reasons = allReasons.slice(0, 4);
    const concerns = allConcerns.slice(0, 4);

    // -------------------------------------------------------------------------
    // 7. LIMITATIONS & CAPITAL CONTEXT
    // -------------------------------------------------------------------------
    const limitations = [
        "Screening heuristic based strictly on analyzed closed DLMM positions; not a prediction of future profitability or financial advice.",
        "Historical Manual Followability Estimate does not guarantee entries can be detected or replicated in real time.",
        "Performance metrics reflect closed positions within the selected period, not wallet-global portfolio equity or active positions.",
    ];

    if (period === "30D") {
        limitations.push(
            "Because of the 6-week observation requirement, a 30D snapshot alone normally cannot establish WORTH_MONITORING."
        );
    }

    if (isSampled) {
        limitations.push(
            `Dataset reached 1,000-position cap (${analyzedClosedPositions} analyzed out of ${totalEligiblePositions} eligible, ${samplingCoveragePct.toFixed(1)}% coverage). Older closed positions in this timeframe were excluded.`
        );
    }

    if (sourceCoverageStatus === "PARTIAL") {
        limitations.push(
            "Partial source coverage: some DLMM pool positions were unavailable or could not be fully reconstructed from the provider."
        );
    }

    return {
        version: ASSESSMENT_VERSION,
        wallet,
        period,
        sourceDatasetFetchedAt,
        verdict,
        monitoringScore,
        scoreComponents,
        manualFollowability,
        followabilityDetails: {
            medianHoldingTimeSeconds,
            observedEntriesPerDay,
            medianInitialEntryUsd,
            holdingTimeObservations,
            qualifyingOpeningObservations: qualifyingOpenedAtObservations,
            openingTimeCoveragePct,
            label: "Historical Manual Followability Estimate",
            description:
                "Informational estimate based on observed holding durations and entry pacing. Median verified initial entry is shown for capital sizing context only; does not evaluate affordability without a user budget.",
        },
        reasons,
        concerns,
        evidence: {
            sourceCoverageStatus,
            analyzedClosedPositions,
            totalEligiblePositions,
            isSampled,
            samplingCoveragePct,
            pnlUsdObservations,
            pnlPctObservations,
            pnlUsdCoveragePct,
            pnlPctCoveragePct,
            observedWeeksWithKnownPnl,
            profitableWeeksCount,
            historyStart,
            historyEnd,
            openingTimestampObservations: qualifyingOpenedAtObservations,
            openingTimestampCoveragePct: openingTimeCoveragePct,
            holdingTimeObservations,
            medianHoldingTimeSeconds,
            observedEntriesPerDay,
            medianInitialEntryUsd,
        },
        limitations,
    };
}
