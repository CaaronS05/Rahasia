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
