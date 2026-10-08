export type AnalyticsPeriod = "30D" | "90D" | "ALL_AVAILABLE";

export type SourceCoverageStatus =
    | "COMPLETE"
    | "BOUNDED_HISTORY"
    | "PARTIAL"
    | "UNAVAILABLE";

export type InitialEntryStatus =
    | "VERIFIED_OPEN_EVENT"
    | "VERIFIED_ASSOCIATED_ADD"
    | "FIRST_OBSERVED_ADD_ONLY"
    | "UNAVAILABLE"
    | "UNKNOWN";

export type TransactionCoverageStatus =
    | "FULL_LIFECYCLE"
    | "PARTIAL_EVENTS"
    | "NO_TRANSACTIONS";

export type PositionCompletenessStatus =
    | "COMPLETE"
    | "MISSING_OPEN_EVENT"
    | "MISSING_CLOSE_EVENT"
    | "INCOMPLETE_AMOUNTS";

export interface LifecycleTransactionItem {
    rawId: string;
    rawType: string;
    category: "initialize" | "add" | "remove" | "claim_fee" | "close" | "unknown";
    createdAt: string;
    signature: string;
    source: string;
    tokenXAmount: number | null;
    tokenYAmount: number | null;
    tokenXAmountUsd: number | null;
    tokenYAmountUsd: number | null;
    totalInUsd: number | null;
}

export interface PositionLifecycleMeta {
    openingEventObserved: boolean;
    closingEventObserved: boolean;
    events: LifecycleTransactionItem[];
    eventCount: number;
}

export interface PositionDataQuality {
    initialEntryStatus: InitialEntryStatus;
    transactionCoverage: TransactionCoverageStatus;
    positionCompleteness: PositionCompletenessStatus;
    warnings: string[];
}

export interface NormalizedPositionRecord {
    wallet: string;
    positionId: string;
    poolAddress: string;
    source: string;

    tokenXMint: string | null;
    tokenYMint: string | null;
    tokenXSymbol: string | null;
    tokenYSymbol: string | null;
    pairName: string | null;
    binStep?: number | null;

    openedAt: string | null;
    closedAt: string;
    holdDurationSeconds: number | null;

    initialEntryUsd: number | null;
    firstObservedAddUsd: number | null;
    additionalLiquidityUsd: number | null;
    totalDepositsUsd: number | null;
    totalWithdrawalsUsd: number | null;
    claimedFeesUsd: number | null;

    pnlUsd: number | null;
    pnlPct: number | null;
    winLoss: "WIN" | "LOSS" | "BREAKEVEN" | "UNKNOWN";

    lifecycle: PositionLifecycleMeta;

    dataQuality: PositionDataQuality;
}

export interface TimeframeMeta {
    requestedPeriod: AnalyticsPeriod;
    effectiveStart: string | null;
    effectiveEnd: string;
    firstAvailableTimestamp: string | null;
    lastAvailableTimestamp: string | null;
    observedStart: string | null;
    observedEnd: string | null;
}

export interface SourceCoverageMeta {
    status: SourceCoverageStatus;
    fabriqPoolsDiscovered: number;
    dlmmPoolsMatched: number;
    totalPositionsFound: number;
    totalEligiblePositions: number;
}

export interface PositionSamplingMeta {
    totalEligiblePositions: number;
    analyzedPositions: number;
    excludedPositions: number;
    duplicatesRemoved: number;
    coveragePct: number;
    isSampled: boolean;
    selectionMethod: "LATEST_CLOSED_1000";
}

export interface OverallDataQualitySummary {
    validClosedPositions: number;
    initialEntriesVerified: number;
    initialEntriesUnavailable: number;
    firstObservedAddOnly: number;
    initialEntryCoveragePct: number;
    fullLifecycleCoveragePositions: number;
    warnings: string[];
}

export interface ExtractionDiagnostics {
    executionMs: number;
    poolPagesFetched: number;
    positionBatchesFetched: number;
    transactionBatchesFetched: number;
    requestRetries: number;
    skippedRecords: Array<{
        positionId?: string;
        poolAddress?: string;
        reason: string;
    }>;
}

export interface PositionAnalyticsDataset {
    schemaVersion: "v1";
    wallet: string;
    period: AnalyticsPeriod;
    dataSource: "fabriq";
    fetchedAt: string;
    timeframe: TimeframeMeta;
    sourceCoverage: SourceCoverageMeta;
    sampling: PositionSamplingMeta;
    dataQuality: OverallDataQualitySummary;
    positions: NormalizedPositionRecord[];
    diagnostics: ExtractionDiagnostics;
}

// ======================================================
// STEP 2 POSITION ANALYTICS ENGINE CONTRACTS
// ======================================================

export interface DistributionBucket {
    label: string;
    min: number | null;
    max: number | null;
    count: number;
    pct: number;
}

export interface TypicalPositionSize {
    p25: number | null;
    p75: number | null;
}

export interface CapitalAnalytics {
    totalPositionDepositsUsd: number | null;
    avgInitialEntryUsd: number | null;
    medianInitialEntryUsd: number | null;
    initialEntryP25: number | null;
    initialEntryP75: number | null;
    typicalPositionSize: TypicalPositionSize;
    avgTotalPositionDepositsUsd: number | null;
    medianTotalPositionDepositsUsd: number | null;
    avgAdditionalLiquidityUsd: number | null;
    positionSizeDistribution: DistributionBucket[];
}

export interface ProfitabilityAnalytics {
    sampleTotalPnlUsd: number | null;
    avgPositionPnlPct: number | null;
    medianPositionPnlPct: number | null;
    bestWinningPositionPct: number | null;
    worstLosingPositionPct: number | null;
    positionWinRate: number | null;
    profitFactor: number | null;
    profitFactorStatus: "CALCULATED" | "UNBOUNDED_NO_LOSSES" | "NO_QUALIFYING_POSITIONS";
    avgWinningPositionPct: number | null;
    avgLosingPositionPct: number | null;
    pnlDistribution: DistributionBucket[];
    winCount: number;
    lossCount: number;
    breakevenCount: number;
    unknownCount: number;
    unknownPnlExcludedCount: number;
}

export interface WeeklyRealizedPnlItem {
    weekStartDateWib: string; // YYYY-MM-DD
    weekEndDateWib: string;   // YYYY-MM-DD
    realizedPnlUsd: number | null;
    closedPositionCount: number;
    winCount: number;
    lossCount: number;
    observedPnlCount?: number;
    unknownPnlCount?: number;
}

export interface SampleRealizedPnlDrawdown {
    label: "Sample Realized PnL Drawdown";
    maxDrawdownUsd: number; // <= 0
    peakCumulativePnlUsd: number;
    troughCumulativePnlUsd: number;
}

export interface RiskAndConsistencyAnalytics {
    cvar10PositionPnlPct: number | null;
    worstPositionPnlPct: number | null;
    pnlStdDev: number | null;
    top1ProfitConcentrationPct: number | null;
    top5ProfitConcentrationPct: number | null;
    longestConsecutiveLosingStreak: number;
    weeklyRealizedPositionPnlUsd: WeeklyRealizedPnlItem[];
    profitableWeeksCount: number;
    losingWeeksCount: number;
    breakevenWeeksCount: number;
    weeklyPnlVariability: number | null;
    hasIncompleteCoverageDueToCap: boolean;
    sampleRealizedPnlDrawdown: SampleRealizedPnlDrawdown;
}

export interface HourlyActivityItem {
    hourWib: number; // 0..23
    count: number;
    pct: number;
}

export interface WeekdayActivityItem {
    weekdayWib: string;
    dayIndexWib: number; // 1 (Mon) .. 7 (Sun)
    count: number;
    pct: number;
}

export interface PairPositionSizeItem {
    pairKey: string;
    pairSymbol: string | null;
    medianInitialEntryUsd: number | null;
    avgInitialEntryUsd: number | null;
    medianTotalDepositsUsd: number | null;
    avgTotalDepositsUsd: number | null;
    closedPositionCount: number;
}

export interface OpeningTimeCoverage {
    analyzedPositions: number;
    openedAtObservations: number;
    qualifyingOpenedAtObservations?: number;
    coveragePct: number;
}

export interface TradingBehaviorAnalytics {
    avgHoldingTimeSeconds: number | null;
    medianHoldingTimeSeconds: number | null;
    holdingTimeDistribution: DistributionBucket[];
    observedEntriesPerDay: number | null;
    entryActivityLabel: "Observed entries among analyzed closed positions";
    entryActivityByHourWib: HourlyActivityItem[];
    entryActivityByWeekdayWib: WeekdayActivityItem[];
    activeEntryDays: number;
    openingTimeCoverage: OpeningTimeCoverage;
    positionSizeByPair: PairPositionSizeItem[];
}

export interface PairBreakdownItem {
    pairKey: string;
    pairSymbol: string | null;
    pairIdentified: boolean;
    token0Mint: string | null;
    token1Mint: string | null;
    pools: string[];
    closedPositionCount: number;
    samplePnlUsd: number | null;
    winRate: number | null;
    medianPositionPnlPct: number | null;
    avgPositionPnlPct: number | null;
    medianInitialEntryUsd: number | null;
    avgHoldingDurationSeconds: number | null;
    worstPositionPct: number | null;
}

export interface PoolBreakdownItem {
    poolAddress: string;
    pairName: string | null;
    tokenXMint: string | null;
    tokenYMint: string | null;
    closedPositionCount: number;
    samplePnlUsd: number | null;
    winRate: number | null;
    medianPositionPnlPct: number | null;
    avgPositionPnlPct: number | null;
    medianInitialEntryUsd: number | null;
    avgHoldingDurationSeconds: number | null;
    worstPositionPct: number | null;
}

export interface MetricObservationCoverage {
    analyzedPositions: number;
    initialEntryObservations: number;
    initialEntryCoveragePct: number;
    totalDepositsObservations: number;
    additionalLiquidityObservations: number;
    pnlUsdObservations: number;
    pnlPctObservations: number;
    holdingTimeObservations: number;
    openedAtObservations: number;
    closedAtObservations: number;
}

export interface PositionMetricsResult {
    schemaVersion: "v1";
    wallet: string;
    period: AnalyticsPeriod;
    generatedAt: string;
    sourceDatasetFetchedAt: string;
    timeframe: TimeframeMeta;
    sourceCoverage: SourceCoverageMeta;
    sampling: PositionSamplingMeta;
    dataQuality: OverallDataQualitySummary;
    metricCoverage: MetricObservationCoverage;
    capital: CapitalAnalytics;
    profitability: ProfitabilityAnalytics;
    riskAndConsistency: RiskAndConsistencyAnalytics;
    tradingBehavior: TradingBehaviorAnalytics;
    pairBreakdown: PairBreakdownItem[];
    poolBreakdown: PoolBreakdownItem[];
}

// ======================================================
// STEP 4 MONITORING ASSESSMENT CONTRACTS
// ======================================================

export type MonitoringVerdict =
    | "WORTH_MONITORING"
    | "WATCH_WITH_CAUTION"
    | "NOT_RECOMMENDED"
    | "INSUFFICIENT_DATA";

export type ManualFollowability =
    | "HIGH"
    | "MODERATE"
    | "LOW"
    | "UNKNOWN";

export interface RiskAndConsistencyScoreComponent {
    score: number;
    maxScore: number;
    cvar10Points: number;
    weeklyRatioPoints: number;
    cvar10: number | null;
    profitableWeeksRatioPct: number | null;
}

export interface ProfitConcentrationScoreComponent {
    score: number;
    maxScore: number;
    top1Points: number;
    top5Points: number;
    top1ConcentrationPct: number | null;
    top5ConcentrationPct: number | null;
}

export interface TrackRecordScoreComponent {
    score: number;
    maxScore: number;
    pnlObsPoints: number;
    weeksPoints: number;
    coveragePoints: number;
    pnlUsdObservations: number;
    pnlPctObservations: number;
    observedWeeksWithKnownPnl: number;
    pnlUsdCoveragePct: number;
    pnlPctCoveragePct: number;
}

export interface ProfitabilityScoreComponent {
    score: number;
    maxScore: number;
    sampleTotalPnlPoints: number;
    medianPnlPctPoints: number;
    sampleTotalPnlUsd: number | null;
    medianPositionPnlPct: number | null;
}

export interface MonitoringScoreComponents {
    riskAndConsistency: RiskAndConsistencyScoreComponent;
    profitConcentration: ProfitConcentrationScoreComponent;
    trackRecord: TrackRecordScoreComponent;
    profitability: ProfitabilityScoreComponent;
}

export interface FollowabilityDetails {
    medianHoldingTimeSeconds: number | null;
    observedEntriesPerDay: number | null;
    medianInitialEntryUsd: number | null;
    holdingTimeObservations: number;
    qualifyingOpeningObservations: number;
    openingTimeCoveragePct: number;
    label: "Historical Manual Followability Estimate";
    description: string;
}

export interface MonitoringAssessmentEvidence {
    sourceCoverageStatus: SourceCoverageStatus;
    analyzedClosedPositions: number;
    totalEligiblePositions: number;
    isSampled: boolean;
    samplingCoveragePct: number;
    pnlUsdObservations: number;
    pnlPctObservations: number;
    pnlUsdCoveragePct: number;
    pnlPctCoveragePct: number;
    observedWeeksWithKnownPnl: number;
    profitableWeeksCount: number;
    historyStart: string | null;
    historyEnd: string | null;
    openingTimestampObservations: number;
    openingTimestampCoveragePct: number;
    holdingTimeObservations: number;
    medianHoldingTimeSeconds: number | null;
    observedEntriesPerDay: number | null;
    medianInitialEntryUsd: number | null;
}

export interface MonitoringAssessmentResult {
    version: "v1";
    wallet: string;
    period: AnalyticsPeriod;
    sourceDatasetFetchedAt: string;
    verdict: MonitoringVerdict;
    monitoringScore: number | null;
    scoreComponents: MonitoringScoreComponents | null;
    manualFollowability: ManualFollowability;
    followabilityDetails: FollowabilityDetails;
    reasons: string[];
    concerns: string[];
    evidence: MonitoringAssessmentEvidence;
    limitations: string[];
}
