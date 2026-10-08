import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    computeMean,
    computeMedian,
    computePercentile,
    computeCvar10,
    computeSampleStdDev,
    parseWibDateInfo,
    computePositionAnalyticsMetrics,
} from "../../scripts/analytics/position-analytics-engine.ts";
import {
    loadPositionMetrics,
    savePositionMetrics,
    getMetricsFilePath,
    savePositionAnalyticsDataset,
    getDatasetFilePath,
} from "../../scripts/analytics/position-analytics-storage.ts";
import { executeBuildPositionMetrics } from "../../scripts/analytics/build-position-metrics.ts";
import type {
    PositionAnalyticsDataset,
    NormalizedPositionRecord,
} from "../../scripts/analytics/position-analytics-types.ts";

describe("Position Analytics Step 2 Test Suite", () => {
    // Helper to generate minimal valid PositionAnalyticsDataset fixture
    function createMockDataset(
        positions: Partial<NormalizedPositionRecord>[],
        overrides?: Partial<PositionAnalyticsDataset>
    ): PositionAnalyticsDataset {
        const fullPositions: NormalizedPositionRecord[] = positions.map((p, idx) => ({
            wallet: "3eU25d2XWqG92p4qZ9UaA721W9g3jQ25d2XWqG92p4qZ",
            positionId: p.positionId ?? `pos_${idx + 1}`,
            poolAddress: p.poolAddress ?? "PoolAddr111111111111111111111111111111111111",
            source: "wallet",
            tokenXMint: p.tokenXMint !== undefined ? p.tokenXMint : "So11111111111111111111111111111111111111112",
            tokenYMint: p.tokenYMint !== undefined ? p.tokenYMint : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            tokenXSymbol: p.tokenXSymbol !== undefined ? p.tokenXSymbol : "SOL",
            tokenYSymbol: p.tokenYSymbol !== undefined ? p.tokenYSymbol : "USDC",
            pairName: p.pairName !== undefined ? p.pairName : "SOL-USDC",
            binStep: 20,
            openedAt: p.openedAt ?? "2026-03-01T10:00:00Z",
            closedAt: p.closedAt ?? "2026-03-02T10:00:00Z",
            holdDurationSeconds: p.holdDurationSeconds ?? 86400,
            initialEntryUsd: p.initialEntryUsd ?? null,
            firstObservedAddUsd: p.firstObservedAddUsd ?? null,
            additionalLiquidityUsd: p.additionalLiquidityUsd ?? null,
            totalDepositsUsd: p.totalDepositsUsd ?? null,
            totalWithdrawalsUsd: p.totalWithdrawalsUsd ?? null,
            claimedFeesUsd: p.claimedFeesUsd ?? null,
            pnlUsd: p.pnlUsd ?? null,
            pnlPct: p.pnlPct ?? null,
            winLoss: p.winLoss ?? "UNKNOWN",
            lifecycle: {
                openTx: "tx_open",
                closeTx: "tx_close",
                transactionCount: 2,
                hasAssociatedInitialAdd: false,
                subsequentAddCount: 0,
                removeCount: 1,
                feeClaimCount: 0,
            },
            dataQuality: {
                initialEntryStatus: p.dataQuality?.initialEntryStatus ?? "UNAVAILABLE",
                transactionCoverage: p.dataQuality?.transactionCoverage ?? "FULL_LIFECYCLE",
                positionCompleteness: p.dataQuality?.positionCompleteness ?? "COMPLETE",
                warnings: p.dataQuality?.warnings ?? [],
            },
        }));

        return {
            schemaVersion: "v1",
            wallet: "3eU25d2XWqG92p4qZ9UaA721W9g3jQ25d2XWqG92p4qZ",
            period: "30D",
            dataSource: "fabriq",
            fetchedAt: "2026-03-10T12:00:00Z",
            timeframe: {
                requestedPeriod: "30D",
                effectiveStart: "2026-02-08T12:00:00Z",
                effectiveEnd: "2026-03-10T12:00:00Z",
                firstAvailableTimestamp: "2026-02-01T00:00:00Z",
                lastAvailableTimestamp: "2026-03-10T12:00:00Z",
                observedStart: "2026-02-09T00:00:00Z",
                observedEnd: "2026-03-10T10:00:00Z",
            },
            sourceCoverage: {
                status: "COMPLETE",
                fabriqPoolsDiscovered: 5,
                dlmmPoolsMatched: 5,
                totalPositionsFound: fullPositions.length,
                totalEligiblePositions: fullPositions.length,
            },
            sampling: {
                totalEligiblePositions: fullPositions.length,
                analyzedPositions: fullPositions.length,
                excludedPositions: 0,
                duplicatesRemoved: 0,
                coveragePct: 100,
                isSampled: false,
                selectionMethod: "LATEST_CLOSED_1000",
            },
            dataQuality: {
                validClosedPositions: fullPositions.length,
                initialEntriesVerified: fullPositions.filter(
                    (p) =>
                        p.dataQuality.initialEntryStatus === "VERIFIED_OPEN_EVENT" ||
                        p.dataQuality.initialEntryStatus === "VERIFIED_ASSOCIATED_ADD"
                ).length,
                initialEntriesUnavailable: 0,
                firstObservedAddOnly: 0,
                initialEntryCoveragePct: 100,
                fullLifecycleCoveragePositions: fullPositions.length,
                warnings: [],
            },
            positions: fullPositions,
            diagnostics: {
                executionMs: 120,
                poolPagesFetched: 1,
                positionBatchesFetched: 1,
                transactionBatchesFetched: 1,
                requestRetries: 0,
                skippedRecords: [],
            },
            ...overrides,
        };
    }

    // --------------------------------------------------
    // TEST 1: Average and median PnL
    // --------------------------------------------------
    it("1. Average and median PnL: computes exact arithmetic mean and median for odd and even counts", () => {
        // Odd count: [10, 20, 30] -> mean: 20, median: 20
        const datasetOdd = createMockDataset([
            { pnlPct: 10, pnlUsd: 100, winLoss: "WIN" },
            { pnlPct: 20, pnlUsd: 200, winLoss: "WIN" },
            { pnlPct: 30, pnlUsd: 300, winLoss: "WIN" },
        ]);
        const metricsOdd = computePositionAnalyticsMetrics(datasetOdd);
        assert.equal(metricsOdd.profitability.avgPositionPnlPct, 20);
        assert.equal(metricsOdd.profitability.medianPositionPnlPct, 20);
        assert.equal(metricsOdd.profitability.sampleTotalPnlUsd, 600);

        // Even count: [10, 20, 30, 40] -> mean: 25, median: 25
        const datasetEven = createMockDataset([
            { pnlPct: 10, pnlUsd: 100, winLoss: "WIN" },
            { pnlPct: 20, pnlUsd: 200, winLoss: "WIN" },
            { pnlPct: 30, pnlUsd: 300, winLoss: "WIN" },
            { pnlPct: 40, pnlUsd: 400, winLoss: "WIN" },
        ]);
        const metricsEven = computePositionAnalyticsMetrics(datasetEven);
        assert.equal(metricsEven.profitability.avgPositionPnlPct, 25);
        assert.equal(metricsEven.profitability.medianPositionPnlPct, 25);
    });

    // --------------------------------------------------
    // TEST 2: P25/P75 entry sizing
    // --------------------------------------------------
    it("2. P25/P75 entry sizing: computes deterministic linear interpolation percentiles", () => {
        const dataset = createMockDataset([
            { initialEntryUsd: 100, dataQuality: { initialEntryStatus: "VERIFIED_OPEN_EVENT", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
            { initialEntryUsd: 200, dataQuality: { initialEntryStatus: "VERIFIED_OPEN_EVENT", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
            { initialEntryUsd: 300, dataQuality: { initialEntryStatus: "VERIFIED_OPEN_EVENT", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
            { initialEntryUsd: 400, dataQuality: { initialEntryStatus: "VERIFIED_OPEN_EVENT", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
            { initialEntryUsd: 500, dataQuality: { initialEntryStatus: "VERIFIED_OPEN_EVENT", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);
        assert.equal(metrics.capital.initialEntryP25, 200);
        assert.equal(metrics.capital.initialEntryP75, 400);
        assert.deepEqual(metrics.capital.typicalPositionSize, { p25: 200, p75: 400 });
        assert.equal(metrics.capital.medianInitialEntryUsd, 300);
        assert.equal(metrics.capital.avgInitialEntryUsd, 300);
    });

    // --------------------------------------------------
    // TEST 3: Initial-entry verified-only coverage
    // --------------------------------------------------
    it("3. Initial-entry verified-only coverage: excludes FIRST_OBSERVED_ADD_ONLY and UNAVAILABLE from entry stats", () => {
        const dataset = createMockDataset([
            { initialEntryUsd: 500, totalDepositsUsd: 500, dataQuality: { initialEntryStatus: "VERIFIED_OPEN_EVENT", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
            { initialEntryUsd: 1000, totalDepositsUsd: 1000, dataQuality: { initialEntryStatus: "VERIFIED_ASSOCIATED_ADD", transactionCoverage: "FULL_LIFECYCLE", positionCompleteness: "COMPLETE", warnings: [] } },
            { initialEntryUsd: 800, totalDepositsUsd: 800, dataQuality: { initialEntryStatus: "FIRST_OBSERVED_ADD_ONLY", transactionCoverage: "PARTIAL_EVENTS", positionCompleteness: "MISSING_OPEN_EVENT", warnings: [] } },
            { initialEntryUsd: null, totalDepositsUsd: 1500, dataQuality: { initialEntryStatus: "UNAVAILABLE", transactionCoverage: "NO_TRANSACTIONS", positionCompleteness: "INCOMPLETE_AMOUNTS", warnings: [] } },
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);

        // Only first two qualify for verified initial entry
        assert.equal(metrics.capital.avgInitialEntryUsd, 750);
        assert.equal(metrics.capital.medianInitialEntryUsd, 750);
        assert.equal(metrics.metricCoverage.initialEntryObservations, 2);
        assert.equal(metrics.metricCoverage.initialEntryCoveragePct, 50);

        // Total deposits include all 4 observations
        assert.equal(metrics.capital.totalPositionDepositsUsd, 3800);
        assert.equal(metrics.metricCoverage.totalDepositsObservations, 4);
    });

    // --------------------------------------------------
    // TEST 4: Best win and worst loss
    // --------------------------------------------------
    it("4. Best win and worst loss: returns extremes and null when no qualifying win or loss exists", () => {
        const datasetMixed = createMockDataset([
            { pnlPct: 55.5, winLoss: "WIN" },
            { pnlPct: 12.0, winLoss: "WIN" },
            { pnlPct: -15.0, winLoss: "LOSS" },
            { pnlPct: -48.2, winLoss: "LOSS" },
            { pnlPct: 0.0, winLoss: "BREAKEVEN" },
        ]);
        const metricsMixed = computePositionAnalyticsMetrics(datasetMixed);
        assert.equal(metricsMixed.profitability.bestWinningPositionPct, 55.5);
        assert.equal(metricsMixed.profitability.worstLosingPositionPct, -48.2);
        assert.equal(metricsMixed.profitability.avgWinningPositionPct, 33.75);
        assert.equal(metricsMixed.profitability.avgLosingPositionPct, -31.6);

        // Only wins: worstLosingPositionPct must be null
        const datasetWinsOnly = createMockDataset([
            { pnlPct: 25.0, winLoss: "WIN" },
            { pnlPct: 10.0, winLoss: "WIN" },
        ]);
        const metricsWinsOnly = computePositionAnalyticsMetrics(datasetWinsOnly);
        assert.equal(metricsWinsOnly.profitability.bestWinningPositionPct, 25.0);
        assert.equal(metricsWinsOnly.profitability.worstLosingPositionPct, null);

        // Only losses: bestWinningPositionPct must be null
        const datasetLossesOnly = createMockDataset([
            { pnlPct: -10.0, winLoss: "LOSS" },
            { pnlPct: -30.0, winLoss: "LOSS" },
        ]);
        const metricsLossesOnly = computePositionAnalyticsMetrics(datasetLossesOnly);
        assert.equal(metricsLossesOnly.profitability.bestWinningPositionPct, null);
        assert.equal(metricsLossesOnly.profitability.worstLosingPositionPct, -30.0);
    });

    // --------------------------------------------------
    // TEST 5: Win rate with UNKNOWN values
    // --------------------------------------------------
    it("5. Win rate with UNKNOWN values: excludes UNKNOWN from denominator and never treats as BREAKEVEN", () => {
        const dataset = createMockDataset([
            { winLoss: "WIN", pnlUsd: 100, pnlPct: 10 },
            { winLoss: "WIN", pnlUsd: 200, pnlPct: 20 },
            { winLoss: "WIN", pnlUsd: 150, pnlPct: 15 },
            { winLoss: "LOSS", pnlUsd: -50, pnlPct: -5 },
            { winLoss: "BREAKEVEN", pnlUsd: 0, pnlPct: 0 },
            { winLoss: "UNKNOWN", pnlUsd: null, pnlPct: null },
            { winLoss: "UNKNOWN", pnlUsd: null, pnlPct: null },
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);

        // Denominator = 3 WIN + 1 LOSS + 1 BREAKEVEN = 5
        // Win rate = (3 / 5) * 100 = 60.0%
        assert.equal(metrics.profitability.positionWinRate, 60.0);
        assert.equal(metrics.profitability.winCount, 3);
        assert.equal(metrics.profitability.lossCount, 1);
        assert.equal(metrics.profitability.breakevenCount, 1);
        assert.equal(metrics.profitability.unknownCount, 2);
        assert.equal(metrics.profitability.unknownPnlExcludedCount, 2);
    });

    // --------------------------------------------------
    // TEST 6: Profit factor with no losses
    // --------------------------------------------------
    it("6. Profit factor with no losses: returns null with UNBOUNDED_NO_LOSSES status, never a fake score", () => {
        // Case A: Wins only
        const datasetNoLosses = createMockDataset([
            { pnlUsd: 200, winLoss: "WIN" },
            { pnlUsd: 300, winLoss: "WIN" },
        ]);
        const metricsNoLosses = computePositionAnalyticsMetrics(datasetNoLosses);
        assert.equal(metricsNoLosses.profitability.profitFactor, null);
        assert.equal(metricsNoLosses.profitability.profitFactorStatus, "UNBOUNDED_NO_LOSSES");

        // Case B: Finite profit factor
        const datasetStandard = createMockDataset([
            { pnlUsd: 400, winLoss: "WIN" },
            { pnlUsd: -100, winLoss: "LOSS" },
        ]);
        const metricsStandard = computePositionAnalyticsMetrics(datasetStandard);
        assert.equal(metricsStandard.profitability.profitFactor, 4.0);
        assert.equal(metricsStandard.profitability.profitFactorStatus, "CALCULATED");

        // Case C: No qualifying positions
        const datasetEmpty = createMockDataset([]);
        const metricsEmpty = computePositionAnalyticsMetrics(datasetEmpty);
        assert.equal(metricsEmpty.profitability.profitFactor, null);
        assert.equal(metricsEmpty.profitability.profitFactorStatus, "NO_QUALIFYING_POSITIONS");
    });

    // --------------------------------------------------
    // TEST 7: CVaR10 and outlier handling
    // --------------------------------------------------
    it("7. CVaR10 and outlier handling: calculates mean of worst ceil(10%) observed position returns", () => {
        // 10 positions: ceil(10 * 0.1) = 1 worst item
        const pnlPcts10 = [-85, -40, -20, -10, 0, 5, 10, 15, 20, 25];
        const dataset10 = createMockDataset(pnlPcts10.map((pct) => ({ pnlPct: pct })));
        const metrics10 = computePositionAnalyticsMetrics(dataset10);
        assert.equal(metrics10.riskAndConsistency.cvar10PositionPnlPct, -85);
        assert.equal(metrics10.riskAndConsistency.worstPositionPnlPct, -85);

        // 20 positions: ceil(20 * 0.1) = 2 worst items: mean(-90, -70) = -80
        const pnlPcts20 = [-90, -70, ...new Array(18).fill(10)];
        const dataset20 = createMockDataset(pnlPcts20.map((pct) => ({ pnlPct: pct })));
        const metrics20 = computePositionAnalyticsMetrics(dataset20);
        assert.equal(metrics20.riskAndConsistency.cvar10PositionPnlPct, -80);
    });

    // --------------------------------------------------
    // TEST 8: Top 1 and Top 5 concentration
    // --------------------------------------------------
    it("8. Top 1 and Top 5 concentration: calculates percentage relative to positive PnL sum", () => {
        const dataset = createMockDataset([
            { pnlUsd: 500, winLoss: "WIN" },
            { pnlUsd: 200, winLoss: "WIN" },
            { pnlUsd: 150, winLoss: "WIN" },
            { pnlUsd: 100, winLoss: "WIN" },
            { pnlUsd: 50, winLoss: "WIN" },
            { pnlUsd: 25, winLoss: "WIN" },
            { pnlUsd: -300, winLoss: "LOSS" }, // Negative must be excluded from positive concentration denominator
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);

        // Sum of positives = 500 + 200 + 150 + 100 + 50 + 25 = 1025
        // Top 1: 500 / 1025 * 100 = 48.78%
        // Top 5: 1000 / 1025 * 100 = 97.56%
        assert.equal(metrics.riskAndConsistency.top1ProfitConcentrationPct, 48.78);
        assert.equal(metrics.riskAndConsistency.top5ProfitConcentrationPct, 97.56);
    });

    // --------------------------------------------------
    // TEST 9: Losing streak chronological order
    // --------------------------------------------------
    it("9. Losing streak chronological order: sorts by closedAt ASC before evaluating consecutive losses", () => {
        // Intentionally provide positions out of chronological order
        const dataset = createMockDataset([
            { closedAt: "2026-03-05T10:00:00Z", winLoss: "LOSS" }, // 5th: LOSS
            { closedAt: "2026-03-01T10:00:00Z", winLoss: "LOSS" }, // 1st: LOSS
            { closedAt: "2026-03-03T10:00:00Z", winLoss: "LOSS" }, // 3rd: LOSS
            { closedAt: "2026-03-02T10:00:00Z", winLoss: "LOSS" }, // 2nd: LOSS (streak = 3 so far: 1st, 2nd, 3rd)
            { closedAt: "2026-03-04T10:00:00Z", winLoss: "WIN" },  // 4th: WIN (breaks streak)
            { closedAt: "2026-03-06T10:00:00Z", winLoss: "LOSS" }, // 6th: LOSS (streak = 2: 5th, 6th)
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);
        // Max streak is 3 (positions 1st, 2nd, 3rd)
        assert.equal(metrics.riskAndConsistency.longestConsecutiveLosingStreak, 3);
    });

    // --------------------------------------------------
    // TEST 10: Weekly PnL and drawdown
    // --------------------------------------------------
    it("10. Weekly PnL and drawdown: computes weekly buckets without zero-PnL weeks and tracks sample drawdown", () => {
        const dataset = createMockDataset([
            // Position 1: closes 2026-03-02 (Monday) PnL +100 -> peak = 100, dd = 0
            { closedAt: "2026-03-02T12:00:00Z", pnlUsd: 100, winLoss: "WIN" },
            // Position 2: closes 2026-03-03 PnL -40 -> cum = 60, peak = 100, dd = -40
            { closedAt: "2026-03-03T12:00:00Z", pnlUsd: -40, winLoss: "LOSS" },
            // Position 3: closes 2026-03-04 PnL -30 -> cum = 30, peak = 100, dd = -70 (max drawdown)
            { closedAt: "2026-03-04T12:00:00Z", pnlUsd: -30, winLoss: "LOSS" },
            // Position 4: closes 2026-03-10 (Next week) PnL +120 -> cum = 150, peak = 150, dd = 0
            { closedAt: "2026-03-10T12:00:00Z", pnlUsd: 120, winLoss: "WIN" },
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);

        // Weekly realized PnL
        assert.equal(metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd.length, 2);
        assert.equal(metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd[0].realizedPnlUsd, 30);
        assert.equal(metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd[0].closedPositionCount, 3);
        assert.equal(metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd[1].realizedPnlUsd, 120);
        assert.equal(metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd[1].closedPositionCount, 1);

        assert.equal(metrics.riskAndConsistency.profitableWeeksCount, 2);
        assert.equal(metrics.riskAndConsistency.losingWeeksCount, 0);

        // Drawdown
        const dd = metrics.riskAndConsistency.sampleRealizedPnlDrawdown;
        assert.equal(dd.label, "Sample Realized PnL Drawdown");
        assert.equal(dd.maxDrawdownUsd, -70);
        assert.equal(dd.peakCumulativePnlUsd, 100);
        assert.equal(dd.troughCumulativePnlUsd, 30);
    });

    // --------------------------------------------------
    // TEST 11: WIB hour and weekday boundaries
    // --------------------------------------------------
    it("11. WIB hour and weekday boundaries: respects UTC+7 boundary for hourly and weekly groupings", () => {
        // Timestamp A: 2026-03-08T18:00:00Z (Sunday 18:00 UTC)
        // In WIB (+7h): 2026-03-09T01:00:00 (Monday 01:00 WIB)
        const infoA = parseWibDateInfo("2026-03-08T18:00:00Z");
        assert.ok(infoA);
        assert.equal(infoA.hourWib, 1);
        assert.equal(infoA.isoDayWib, 1); // Monday
        assert.equal(infoA.wibIsoDate, "2026-03-09");
        assert.equal(infoA.weekStartWib, "2026-03-09");

        // Timestamp B: 2026-03-08T16:00:00Z (Sunday 16:00 UTC)
        // In WIB (+7h): 2026-03-08T23:00:00 (Sunday 23:00 WIB)
        const infoB = parseWibDateInfo("2026-03-08T16:00:00Z");
        assert.ok(infoB);
        assert.equal(infoB.hourWib, 23);
        assert.equal(infoB.isoDayWib, 7); // Sunday
        assert.equal(infoB.wibIsoDate, "2026-03-08");
        assert.equal(infoB.weekStartWib, "2026-03-02");

        // Engine integration test
        const dataset = createMockDataset([
            { openedAt: "2026-03-08T18:00:00Z" },
            { openedAt: "2026-03-08T16:00:00Z" },
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);
        assert.equal(metrics.tradingBehavior.entryActivityByHourWib[1].count, 1);
        assert.equal(metrics.tradingBehavior.entryActivityByHourWib[23].count, 1);
        assert.equal(metrics.tradingBehavior.entryActivityByWeekdayWib[0].count, 1); // Monday
        assert.equal(metrics.tradingBehavior.entryActivityByWeekdayWib[6].count, 1); // Sunday
    });

    // --------------------------------------------------
    // TEST 12: Holding time statistics
    // --------------------------------------------------
    it("12. Holding time statistics: computes mean, median, and bucket distribution", () => {
        const dataset = createMockDataset([
            { holdDurationSeconds: 1800 },   // 30m -> < 1h
            { holdDurationSeconds: 7200 },   // 2h -> 1h - 6h
            { holdDurationSeconds: 43200 },  // 12h -> 6h - 24h
            { holdDurationSeconds: 172800 }, // 48h -> 1d - 7d
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);
        assert.equal(metrics.tradingBehavior.avgHoldingTimeSeconds, 56250);
        assert.equal(metrics.tradingBehavior.medianHoldingTimeSeconds, 25200);

        const dist = metrics.tradingBehavior.holdingTimeDistribution;
        assert.equal(dist.find((b) => b.label === "< 1h")?.count, 1);
        assert.equal(dist.find((b) => b.label === "1h - 6h")?.count, 1);
        assert.equal(dist.find((b) => b.label === "6h - 24h")?.count, 1);
        assert.equal(dist.find((b) => b.label === "1d - 7d")?.count, 1);
        assert.equal(dist.find((b) => b.label === "> 7d")?.count, 0);
    });

    // --------------------------------------------------
    // TEST 13: Pair/pool grouping and missing metadata
    // --------------------------------------------------
    it("13. Pair/pool grouping and missing metadata: normalizes token order and isolates unknown metadata pools", () => {
        const mintA = "So11111111111111111111111111111111111111112";
        const mintB = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

        const dataset = createMockDataset([
            // Pool 1: mints ordered B then A
            {
                poolAddress: "Pool_1",
                tokenXMint: mintB,
                tokenYMint: mintA,
                tokenXSymbol: "USDC",
                tokenYSymbol: "SOL",
                pnlUsd: 100,
                pnlPct: 10,
                winLoss: "WIN",
            },
            // Pool 2: mints ordered A then B (same pair!)
            {
                poolAddress: "Pool_2",
                tokenXMint: mintA,
                tokenYMint: mintB,
                tokenXSymbol: "SOL",
                tokenYSymbol: "USDC",
                pnlUsd: 50,
                pnlPct: 5,
                winLoss: "WIN",
            },
            // Pool 3: missing mint metadata
            {
                poolAddress: "Pool_Unknown",
                tokenXMint: null,
                tokenYMint: null,
                tokenXSymbol: null,
                tokenYSymbol: null,
                pairName: null,
                pnlUsd: -30,
                pnlPct: -3,
                winLoss: "LOSS",
            },
        ]);
        const metrics = computePositionAnalyticsMetrics(dataset);

        // Pair breakdown: should have 2 pair groups (1 verified pair with 2 pools, 1 unidentified pair)
        assert.equal(metrics.pairBreakdown.length, 2);

        const canonicalPair = metrics.pairBreakdown.find((p) => p.pairIdentified);
        assert.ok(canonicalPair);
        assert.equal(canonicalPair.closedPositionCount, 2);
        assert.equal(canonicalPair.samplePnlUsd, 150);
        assert.deepEqual(canonicalPair.pools, ["Pool_1", "Pool_2"]);

        const unidentifiedPair = metrics.pairBreakdown.find((p) => !p.pairIdentified);
        assert.ok(unidentifiedPair);
        assert.equal(unidentifiedPair.pairKey, "pool:Pool_Unknown");
        assert.equal(unidentifiedPair.closedPositionCount, 1);
        assert.equal(unidentifiedPair.samplePnlUsd, -30);

        // Pool breakdown: 3 distinct pools preserved
        assert.equal(metrics.poolBreakdown.length, 3);
    });

    // --------------------------------------------------
    // TEST 14: Sampled vs complete coverage
    // --------------------------------------------------
    it("14. Sampled vs complete coverage: flags incomplete coverage when sampled cap excludes older data", () => {
        // Complete dataset
        const datasetComplete = createMockDataset([], {
            sampling: {
                totalEligiblePositions: 250,
                analyzedPositions: 250,
                excludedPositions: 0,
                duplicatesRemoved: 0,
                coveragePct: 100,
                isSampled: false,
                selectionMethod: "LATEST_CLOSED_1000",
            },
        });
        const metricsComplete = computePositionAnalyticsMetrics(datasetComplete);
        assert.equal(metricsComplete.riskAndConsistency.hasIncompleteCoverageDueToCap, false);

        // Sampled dataset
        const datasetSampled = createMockDataset([], {
            sampling: {
                totalEligiblePositions: 2500,
                analyzedPositions: 1000,
                excludedPositions: 1500,
                duplicatesRemoved: 0,
                coveragePct: 40,
                isSampled: true,
                selectionMethod: "LATEST_CLOSED_1000",
            },
        });
        const metricsSampled = computePositionAnalyticsMetrics(datasetSampled);
        assert.equal(metricsSampled.riskAndConsistency.hasIncompleteCoverageDueToCap, true);
    });

    // --------------------------------------------------
    // TEST 15: Null, zero and missing values
    // --------------------------------------------------
    it("15. Null, zero and missing values: gracefully handles empty datasets and missing fields without NaN", () => {
        const emptyDataset = createMockDataset([]);
        const metrics = computePositionAnalyticsMetrics(emptyDataset);

        assert.equal(metrics.capital.totalPositionDepositsUsd, null);
        assert.equal(metrics.capital.avgInitialEntryUsd, null);
        assert.equal(metrics.capital.medianInitialEntryUsd, null);
        assert.equal(metrics.profitability.sampleTotalPnlUsd, null);
        assert.equal(metrics.profitability.positionWinRate, null);
        assert.equal(metrics.profitability.profitFactor, null);
        assert.equal(metrics.riskAndConsistency.cvar10PositionPnlPct, null);
        assert.equal(metrics.tradingBehavior.observedEntriesPerDay, null);

        // Verify JSON stringify produces no NaN or Infinity
        const serialized = JSON.stringify(metrics);
        assert.equal(serialized.includes("NaN"), false);
        assert.equal(serialized.includes("Infinity"), false);
    });

    // --------------------------------------------------
    // TEST 16: 1000-position performance
    // --------------------------------------------------
    it("16. 1000-position performance: computes full metrics on 1,000 positions in under 100ms", () => {
        const positions: Partial<NormalizedPositionRecord>[] = [];
        const baseTs = Date.parse("2026-03-01T00:00:00Z");

        for (let i = 0; i < 1000; i++) {
            const pnl = (i % 2 === 0 ? 1 : -1) * ((i % 50) + 1);
            positions.push({
                positionId: `pos_perf_${i}`,
                poolAddress: `Pool_${i % 10}`,
                openedAt: new Date(baseTs + i * 3600000).toISOString(),
                closedAt: new Date(baseTs + (i + 1) * 3600000).toISOString(),
                holdDurationSeconds: 3600,
                initialEntryUsd: 100 + (i % 100),
                totalDepositsUsd: 100 + (i % 100),
                pnlUsd: pnl,
                pnlPct: pnl / 10,
                winLoss: pnl > 0 ? "WIN" : "LOSS",
                dataQuality: {
                    initialEntryStatus: "VERIFIED_OPEN_EVENT",
                    transactionCoverage: "FULL_LIFECYCLE",
                    positionCompleteness: "COMPLETE",
                    warnings: [],
                },
            });
        }

        const largeDataset = createMockDataset(positions);

        const t0 = performance.now();
        const metrics = computePositionAnalyticsMetrics(largeDataset);
        const durationMs = performance.now() - t0;

        assert.equal(metrics.metricCoverage.analyzedPositions, 1000);
        assert.ok(durationMs < 100, `Execution took ${durationMs.toFixed(2)}ms, expected < 100ms`);
    });

    // --------------------------------------------------
    // TEST 17: Output persistence and input immutability
    // --------------------------------------------------
    it("17. Output persistence and input immutability: atomically writes metrics and preserves input dataset", async () => {
        const testWallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
        const tempTestDir = path.resolve("data/test-analytics-step2");

        const dataset = createMockDataset([
            {
                initialEntryUsd: 500,
                totalDepositsUsd: 500,
                pnlUsd: 50,
                pnlPct: 10,
                winLoss: "WIN",
                dataQuality: {
                    initialEntryStatus: "VERIFIED_OPEN_EVENT",
                    transactionCoverage: "FULL_LIFECYCLE",
                    positionCompleteness: "COMPLETE",
                    warnings: [],
                },
            },
        ], { wallet: testWallet });

        // Save mock dataset to positions temp directory
        const posDir = path.join(tempTestDir, "positions");
        const metDir = path.join(tempTestDir, "metrics");
        savePositionAnalyticsDataset(dataset, posDir);

        // Take snapshot of input dataset before computation
        const datasetSnapshotBefore = JSON.stringify(dataset);

        // Run executeBuildPositionMetrics
        const buildResult = await executeBuildPositionMetrics({
            wallet: testWallet,
            period: "30D",
            force: true,
            positionsBaseDir: posDir,
            metricsBaseDir: metDir,
        });

        assert.equal(buildResult.success, true);
        assert.ok(buildResult.metrics);
        assert.ok(buildResult.persistedPath);

        // Verify input immutability
        const datasetSnapshotAfter = JSON.stringify(dataset);
        assert.equal(datasetSnapshotBefore, datasetSnapshotAfter, "Input dataset was mutated during metrics calculation!");

        // Verify loaded output matches persisted result
        const loaded = loadPositionMetrics(testWallet, "30D", metDir);
        assert.ok(loaded);
        assert.equal(loaded.wallet, testWallet);
        assert.equal(loaded.capital.totalPositionDepositsUsd, 500);
        assert.equal(loaded.profitability.sampleTotalPnlUsd, 50);

        // Cleanup temp test directory
        fs.rmSync(tempTestDir, { recursive: true, force: true });
    });

    // --------------------------------------------------
    // TEST 18: Metrics cache invalidation & recomputation on dataset refresh
    // --------------------------------------------------
    it("18. Metrics cache: invalidates and recomputes stale metrics when source dataset is refreshed", async () => {
        const testWallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
        const tempTestDir = path.resolve("data/test-analytics-cache");
        const posDir = path.join(tempTestDir, "positions");
        const metDir = path.join(tempTestDir, "metrics");

        const initialDataset = createMockDataset([
            {
                initialEntryUsd: 500,
                totalDepositsUsd: 500,
                pnlUsd: 50,
                winLoss: "WIN",
                dataQuality: {
                    initialEntryStatus: "VERIFIED_OPEN_EVENT",
                    transactionCoverage: "FULL_LIFECYCLE",
                    positionCompleteness: "COMPLETE",
                    warnings: [],
                },
            },
        ], {
            wallet: testWallet,
            fetchedAt: "2026-03-10T12:00:00Z",
        });

        savePositionAnalyticsDataset(initialDataset, posDir);

        // First run: builds and caches metrics
        const firstRun = await executeBuildPositionMetrics({
            wallet: testWallet,
            period: "30D",
            force: false,
            positionsBaseDir: posDir,
            metricsBaseDir: metDir,
        });
        assert.equal(firstRun.success, true);
        assert.equal(firstRun.fromCache, false);
        assert.equal(firstRun.metrics?.profitability.sampleTotalPnlUsd, 50);
        assert.equal(firstRun.metrics?.sourceDatasetFetchedAt, "2026-03-10T12:00:00Z");

        // Second run without dataset change: returns cached metrics
        const cachedRun = await executeBuildPositionMetrics({
            wallet: testWallet,
            period: "30D",
            force: false,
            positionsBaseDir: posDir,
            metricsBaseDir: metDir,
        });
        assert.equal(cachedRun.success, true);
        assert.equal(cachedRun.fromCache, true);
        assert.equal(cachedRun.metrics?.profitability.sampleTotalPnlUsd, 50);

        // Source dataset refreshed: fetchedAt updated and data changed
        const refreshedDataset = createMockDataset([
            {
                initialEntryUsd: 500,
                totalDepositsUsd: 500,
                pnlUsd: 120,
                winLoss: "WIN",
                dataQuality: {
                    initialEntryStatus: "VERIFIED_OPEN_EVENT",
                    transactionCoverage: "FULL_LIFECYCLE",
                    positionCompleteness: "COMPLETE",
                    warnings: [],
                },
            },
        ], {
            wallet: testWallet,
            fetchedAt: "2026-03-11T09:00:00Z",
        });
        savePositionAnalyticsDataset(refreshedDataset, posDir);

        // Third run without force: automatically detects stale cache, recomputes from new dataset
        const refreshedRun = await executeBuildPositionMetrics({
            wallet: testWallet,
            period: "30D",
            force: false,
            positionsBaseDir: posDir,
            metricsBaseDir: metDir,
        });
        assert.equal(refreshedRun.success, true);
        assert.equal(refreshedRun.fromCache, false);
        assert.equal(refreshedRun.metrics?.profitability.sampleTotalPnlUsd, 120);
        assert.equal(refreshedRun.metrics?.sourceDatasetFetchedAt, "2026-03-11T09:00:00Z");

        // Verify persisted metrics on disk updated
        const loaded = loadPositionMetrics(testWallet, "30D", metDir);
        assert.ok(loaded);
        assert.equal(loaded.profitability.sampleTotalPnlUsd, 120);
        assert.equal(loaded.sourceDatasetFetchedAt, "2026-03-11T09:00:00Z");

        // Cleanup
        fs.rmSync(tempTestDir, { recursive: true, force: true });
    });

    // --------------------------------------------------
    // TEST 19: Weekly PnL all-unknown vs partial observations
    // --------------------------------------------------
    it("19. Weekly PnL: all-unknown PnL yields null realizedPnlUsd (never breakeven), handles partial transparently", () => {
        const dataset = createMockDataset([
            // Week 1 (2026-03-02 Monday): 2 positions, BOTH have unknown PnL
            { closedAt: "2026-03-02T10:00:00Z", pnlUsd: null, winLoss: "UNKNOWN" },
            { closedAt: "2026-03-03T10:00:00Z", pnlUsd: null, winLoss: "UNKNOWN" },

            // Week 2 (2026-03-09 Monday): 2 positions, 1 WIN (+150), 1 UNKNOWN (null)
            { closedAt: "2026-03-09T10:00:00Z", pnlUsd: 150, winLoss: "WIN" },
            { closedAt: "2026-03-10T10:00:00Z", pnlUsd: null, winLoss: "UNKNOWN" },

            // Week 3 (2026-03-16 Monday): 2 positions, +50 and -50 -> genuine breakeven
            { closedAt: "2026-03-16T10:00:00Z", pnlUsd: 50, winLoss: "WIN" },
            { closedAt: "2026-03-17T10:00:00Z", pnlUsd: -50, winLoss: "LOSS" },
        ]);

        const metrics = computePositionAnalyticsMetrics(dataset);
        const weeks = metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd;
        assert.equal(weeks.length, 3);

        // Week 1: All unknown -> realizedPnlUsd MUST be null, not zero
        assert.equal(weeks[0].realizedPnlUsd, null);
        assert.equal(weeks[0].closedPositionCount, 2);
        assert.equal(weeks[0].observedPnlCount, 0);
        assert.equal(weeks[0].unknownPnlCount, 2);
        assert.equal(weeks[0].winCount, 0);
        assert.equal(weeks[0].lossCount, 0);

        // Week 2: Partial observation -> sums known observations (+150) and reports counts transparently
        assert.equal(weeks[1].realizedPnlUsd, 150);
        assert.equal(weeks[1].closedPositionCount, 2);
        assert.equal(weeks[1].observedPnlCount, 1);
        assert.equal(weeks[1].unknownPnlCount, 1);
        assert.equal(weeks[1].winCount, 1);
        assert.equal(weeks[1].lossCount, 0);

        // Week 3: Genuine breakeven -> realizedPnlUsd is 0
        assert.equal(weeks[2].realizedPnlUsd, 0);
        assert.equal(weeks[2].closedPositionCount, 2);
        assert.equal(weeks[2].observedPnlCount, 2);
        assert.equal(weeks[2].unknownPnlCount, 0);

        // Classification counts:
        // Week 1 is neither profitable, losing, nor breakeven.
        // Week 2 is profitable.
        // Week 3 is genuine breakeven.
        assert.equal(metrics.riskAndConsistency.profitableWeeksCount, 1);
        assert.equal(metrics.riskAndConsistency.losingWeeksCount, 0);
        assert.equal(metrics.riskAndConsistency.breakevenWeeksCount, 1);
    });

    // --------------------------------------------------
    // TEST 20: Entry activity qualifying timestamps within requested window
    // --------------------------------------------------
    it("20. Entry activity: hourly, weekday and entries/day use consistent qualifying opening timestamps within requested window", () => {
        const dataset30D = createMockDataset([
            // Position 1: opened 2026-03-05T08:00:00Z (Thursday 15:00 WIB) -> inside 30D window
            { openedAt: "2026-03-05T08:00:00Z", closedAt: "2026-03-06T10:00:00Z" },
            // Position 2: opened 2026-03-06T10:00:00Z (Friday 17:00 WIB) -> inside 30D window
            { openedAt: "2026-03-06T10:00:00Z", closedAt: "2026-03-07T10:00:00Z" },
            // Position 3: opened 2025-10-01T08:00:00Z (Wednesday 15:00 WIB, ~5 months old)
            // Closed in 30D window (2026-03-08), but opened OUTSIDE 30D window!
            { openedAt: "2025-10-01T08:00:00Z", closedAt: "2026-03-08T10:00:00Z" },
        ], {
            period: "30D",
            timeframe: {
                requestedPeriod: "30D",
                effectiveStart: "2026-02-08T12:00:00Z",
                effectiveEnd: "2026-03-10T12:00:00Z",
                firstAvailableTimestamp: "2025-10-01T08:00:00Z",
                lastAvailableTimestamp: "2026-03-10T12:00:00Z",
            },
        });

        const metrics = computePositionAnalyticsMetrics(dataset30D);

        // Entries/day: only 2 qualifying entries in 30D window -> 2 / 30 = 0.07
        assert.equal(metrics.tradingBehavior.observedEntriesPerDay, 0.07);

        // Hourly activity: only 2 qualifying positions
        // Position 1: 15:00 WIB -> count = 1, pct = 50%
        // Position 2: 17:00 WIB -> count = 1, pct = 50%
        // Position 3 (15:00 WIB from Oct 2025) MUST NOT be counted!
        assert.equal(metrics.tradingBehavior.entryActivityByHourWib[15].count, 1);
        assert.equal(metrics.tradingBehavior.entryActivityByHourWib[15].pct, 50);
        assert.equal(metrics.tradingBehavior.entryActivityByHourWib[17].count, 1);
        assert.equal(metrics.tradingBehavior.entryActivityByHourWib[17].pct, 50);

        const totalHourlyCounts = metrics.tradingBehavior.entryActivityByHourWib.reduce((sum, h) => sum + h.count, 0);
        assert.equal(totalHourlyCounts, 2);

        // Weekday activity: only 2 qualifying positions
        // Thursday (dayIndex 4) -> count = 1, pct = 50%
        // Friday (dayIndex 5) -> count = 1, pct = 50%
        // Wednesday (dayIndex 3, from Oct 2025 Position 3) MUST NOT be counted!
        const wednesday = metrics.tradingBehavior.entryActivityByWeekdayWib.find((w) => w.weekdayWib === "Wednesday");
        assert.ok(wednesday);
        assert.equal(wednesday.count, 0);

        const thursday = metrics.tradingBehavior.entryActivityByWeekdayWib.find((w) => w.weekdayWib === "Thursday");
        assert.ok(thursday);
        assert.equal(thursday.count, 1);
        assert.equal(thursday.pct, 50);

        const friday = metrics.tradingBehavior.entryActivityByWeekdayWib.find((w) => w.weekdayWib === "Friday");
        assert.ok(friday);
        assert.equal(friday.count, 1);
        assert.equal(friday.pct, 50);

        const totalWeekdayCounts = metrics.tradingBehavior.entryActivityByWeekdayWib.reduce((sum, w) => sum + w.count, 0);
        assert.equal(totalWeekdayCounts, 2);

        // Active entry days: 2 distinct dates
        assert.equal(metrics.tradingBehavior.activeEntryDays, 2);

        // Clear closed-position sample limitations retained
        assert.equal(metrics.tradingBehavior.entryActivityLabel, "Observed entries among analyzed closed positions");
        assert.equal(metrics.tradingBehavior.openingTimeCoverage.analyzedPositions, 3);
        assert.equal(metrics.tradingBehavior.openingTimeCoverage.openedAtObservations, 3);
        assert.equal(metrics.tradingBehavior.openingTimeCoverage.qualifyingOpenedAtObservations, 2);
    });
});
