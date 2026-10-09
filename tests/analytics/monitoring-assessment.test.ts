import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
    computeMonitoringAssessment,
    formatDurationSimple,
    MONITORING_VERDICTS,
    MANUAL_FOLLOWABILITY,
    SCORING_THRESHOLDS,
    EVIDENCE_GATES,
    WORTH_MONITORING_GATES,
    FOLLOWABILITY_THRESHOLDS,
} from "../../scripts/analytics/monitoring-assessment.mjs";
import {
    publishPositionAnalyticsPair,
    getBundleFilePath,
} from "../../scripts/analytics/position-analytics-storage.ts";

const TEST_PORT = 8992;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_WALLET = "A55e5511111111111111111111111111111111111111";
const TEST_WALLET_ALT = "A55e5522222222222222222222222222222222222222";
const ROOT = process.cwd();

const POSITIONS_TEST_DIR = path.join(ROOT, "data/analytics/positions", TEST_WALLET);
const METRICS_TEST_DIR = path.join(ROOT, "data/analytics/metrics", TEST_WALLET);
const BUNDLES_TEST_DIR = path.join(ROOT, "data/analytics/bundles", TEST_WALLET);

let serverProcess: ChildProcess | null = null;

function waitForServerReady(proc: ChildProcess): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    const onData = (chunk: Buffer | string) => {
        const text = String(chunk);
        if (text.includes("Fabriq Control Server running")) {
            proc.stdout?.off("data", onData);
            resolve();
        }
    };

    proc.stdout?.on("data", onData);
    proc.once("error", reject);
    proc.once("exit", (code) => {
        reject(new Error(`Server exited unexpectedly with code ${code}`));
    });

    return promise;
}

/**
 * Helper to construct a base synthetic dataset
 */
function createMockDataset(overrides: Record<string, any> = {}) {
    return {
        schemaVersion: "v1",
        wallet: TEST_WALLET,
        period: "90D",
        dataSource: "fabriq",
        fetchedAt: "2026-03-20T12:00:00.000Z",
        timeframe: {
            requestedPeriod: "90D",
            effectiveStart: "2025-12-20T12:00:00.000Z",
            effectiveEnd: "2026-03-20T12:00:00.000Z",
            firstAvailableTimestamp: null,
            lastAvailableTimestamp: null,
            observedStart: "2026-01-01T00:00:00.000Z",
            observedEnd: "2026-03-20T00:00:00.000Z",
        },
        sourceCoverage: {
            status: "COMPLETE",
            fabriqPoolsDiscovered: 5,
            dlmmPoolsMatched: 5,
            totalPositionsFound: 80,
            totalEligiblePositions: 80,
        },
        sampling: {
            totalEligiblePositions: 80,
            analyzedPositions: 80,
            excludedPositions: 0,
            duplicatesRemoved: 0,
            coveragePct: 100,
            isSampled: false,
            selectionMethod: "LATEST_CLOSED_1000",
        },
        dataQuality: {
            validClosedPositions: 80,
            initialEntriesVerified: 80,
            initialEntriesUnavailable: 0,
            firstObservedAddOnly: 0,
            initialEntryCoveragePct: 100,
            fullLifecycleCoveragePositions: 80,
            warnings: [],
        },
        positions: Array.from({ length: 80 }, (_, i) => ({
            wallet: TEST_WALLET,
            positionId: `pos-${i}`,
            poolAddress: "Pool111111111111111111111111111111111111111",
            source: "fabriq",
            tokenXMint: null,
            tokenYMint: null,
            tokenXSymbol: "SOL",
            tokenYSymbol: "USDC",
            pairName: "SOL-USDC",
            openedAt: "2026-01-01T12:00:00.000Z",
            closedAt: "2026-01-02T12:00:00.000Z",
            holdDurationSeconds: 86400,
            initialEntryUsd: 500,
            firstObservedAddUsd: null,
            additionalLiquidityUsd: 0,
            totalDepositsUsd: 500,
            totalWithdrawalsUsd: 550,
            claimedFeesUsd: 0,
            pnlUsd: 50,
            pnlPct: 10,
            winLoss: "WIN",
            lifecycle: { openingEventObserved: true, closingEventObserved: true, events: [], eventCount: 2 },
            dataQuality: {
                initialEntryStatus: "VERIFIED_OPEN_EVENT",
                transactionCoverage: "FULL_LIFECYCLE",
                positionCompleteness: "COMPLETE",
                warnings: [],
            },
        })),
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

/**
 * Helper to construct a base synthetic metrics result
 */
function createMockMetrics(overrides: Record<string, any> = {}) {
    // Generate 10 observed weekly items: 7 profitable, 3 losing
    const weeklyRealizedPositionPnlUsd = Array.from({ length: 10 }, (_, i) => ({
        weekStartDateWib: `2026-01-${String((i + 1) * 7).padStart(2, "0")}`,
        weekEndDateWib: `2026-01-${String((i + 1) * 7 + 6).padStart(2, "0")}`,
        realizedPnlUsd: i < 7 ? 250 : -50,
        closedPositionCount: 8,
        winCount: i < 7 ? 6 : 2,
        lossCount: i < 7 ? 2 : 6,
        observedPnlCount: 8,
        unknownPnlCount: 0,
    }));

    return {
        schemaVersion: "v1",
        wallet: TEST_WALLET,
        period: "90D",
        generatedAt: "2026-03-20T12:05:00.000Z",
        sourceDatasetFetchedAt: "2026-03-20T12:00:00.000Z",
        timeframe: {
            requestedPeriod: "90D",
            effectiveStart: "2025-12-20T12:00:00.000Z",
            effectiveEnd: "2026-03-20T12:00:00.000Z",
            firstAvailableTimestamp: null,
            lastAvailableTimestamp: null,
            observedStart: "2026-01-01T00:00:00.000Z",
            observedEnd: "2026-03-20T00:00:00.000Z",
        },
        sourceCoverage: {
            status: "COMPLETE",
            fabriqPoolsDiscovered: 5,
            dlmmPoolsMatched: 5,
            totalPositionsFound: 80,
            totalEligiblePositions: 80,
        },
        sampling: {
            totalEligiblePositions: 80,
            analyzedPositions: 80,
            excludedPositions: 0,
            duplicatesRemoved: 0,
            coveragePct: 100,
            isSampled: false,
            selectionMethod: "LATEST_CLOSED_1000",
        },
        dataQuality: {
            validClosedPositions: 80,
            initialEntriesVerified: 80,
            initialEntriesUnavailable: 0,
            firstObservedAddOnly: 0,
            initialEntryCoveragePct: 100,
            fullLifecycleCoveragePositions: 80,
            warnings: [],
        },
        metricCoverage: {
            analyzedPositions: 80,
            initialEntryObservations: 80,
            initialEntryCoveragePct: 100,
            totalDepositsObservations: 80,
            additionalLiquidityObservations: 80,
            pnlUsdObservations: 80,
            pnlPctObservations: 80,
            holdingTimeObservations: 80,
            openedAtObservations: 80,
            closedAtObservations: 80,
        },
        capital: {
            totalPositionDepositsUsd: 40000,
            avgInitialEntryUsd: 500,
            medianInitialEntryUsd: 500,
            initialEntryP25: 400,
            initialEntryP75: 600,
            typicalPositionSize: { p25: 400, p75: 600 },
            avgTotalPositionDepositsUsd: 500,
            medianTotalPositionDepositsUsd: 500,
            avgAdditionalLiquidityUsd: 0,
            positionSizeDistribution: [],
        },
        profitability: {
            sampleTotalPnlUsd: 1600,
            avgPositionPnlPct: 5.2,
            medianPositionPnlPct: 4.5,
            bestWinningPositionPct: 25.0,
            worstLosingPositionPct: -8.0,
            positionWinRate: 70.0,
            profitFactor: 2.8,
            profitFactorStatus: "CALCULATED",
            avgWinningPositionPct: 8.5,
            avgLosingPositionPct: -4.2,
            pnlDistribution: [],
            winCount: 56,
            lossCount: 24,
            breakevenCount: 0,
            unknownCount: 0,
            unknownPnlExcludedCount: 0,
        },
        riskAndConsistency: {
            cvar10PositionPnlPct: -6.5, // >= -10% -> 20 pts
            worstPositionPnlPct: -8.0,
            pnlStdDev: 4.8,
            top1ProfitConcentrationPct: 18.0, // <= 25% -> 15 pts
            top5ProfitConcentrationPct: 48.0, // <= 60% -> 10 pts
            longestConsecutiveLosingStreak: 2,
            weeklyRealizedPositionPnlUsd,
            profitableWeeksCount: 7, // 7 of 10 = 70% >= 60% -> 15 pts
            losingWeeksCount: 3,
            breakevenWeeksCount: 0,
            weeklyPnlVariability: 120,
            hasIncompleteCoverageDueToCap: false,
            sampleRealizedPnlDrawdown: {
                label: "Sample Realized PnL Drawdown",
                maxDrawdownUsd: -150,
                peakCumulativePnlUsd: 1750,
                troughCumulativePnlUsd: 1600,
            },
        },
        tradingBehavior: {
            avgHoldingTimeSeconds: 28800,
            medianHoldingTimeSeconds: 25200, // 7 hours -> >= 6 hours
            holdingTimeDistribution: [],
            observedEntriesPerDay: 1.2, // <= 2 -> HIGH followability
            entryActivityLabel: "Observed entries among analyzed closed positions",
            entryActivityByHourWib: [],
            entryActivityByWeekdayWib: [],
            activeEntryDays: 45,
            openingTimeCoverage: {
                analyzedPositions: 80,
                openedAtObservations: 80,
                qualifyingOpenedAtObservations: 80,
                coveragePct: 100,
            },
            positionSizeByPair: [],
        },
        pairBreakdown: [],
        poolBreakdown: [],
        ...overrides,
    };
}

describe("Monitoring Assessment Engine & API Suite", () => {
    // -------------------------------------------------------------------------
    // 1. All four monitoring verdicts
    // -------------------------------------------------------------------------
    it("1. All four monitoring verdicts: produces correct verdicts across distinct profile categories", () => {
        // A. WORTH_MONITORING
        const dsWorth = createMockDataset();
        const metWorth = createMockMetrics();
        const resWorth = computeMonitoringAssessment(dsWorth, metWorth);
        assert.equal(resWorth.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
        assert.ok(resWorth.monitoringScore >= 75);

        // B. WATCH_WITH_CAUTION (e.g. score between 45 and 74, or score >= 75 failing a gate)
        const metCaution = createMockMetrics({
            riskAndConsistency: {
                ...metWorth.riskAndConsistency,
                cvar10PositionPnlPct: -15.0, // 10 pts (down from 20)
                top1ProfitConcentrationPct: 35.0, // 7 pts (down from 15)
                top5ProfitConcentrationPct: 75.0, // 5 pts (down from 10)
            },
            metricCoverage: {
                ...metWorth.metricCoverage,
                pnlUsdObservations: 50, // 6 pts (down from 12)
                pnlPctObservations: 50,
            },
        });
        const resCaution = computeMonitoringAssessment(dsWorth, metCaution);
        assert.equal(resCaution.verdict, MONITORING_VERDICTS.WATCH_WITH_CAUTION);
        assert.ok(resCaution.monitoringScore >= 45 && resCaution.monitoringScore < 75);

        // C. NOT_RECOMMENDED (score < 45)
        const metNotRec = createMockMetrics({
            profitability: {
                ...metWorth.profitability,
                sampleTotalPnlUsd: -500, // 0 pts
                medianPositionPnlPct: -2.5, // 0 pts
            },
            riskAndConsistency: {
                ...metWorth.riskAndConsistency,
                cvar10PositionPnlPct: -30.0, // 0 pts
                profitableWeeksCount: 2, // 2 of 10 = 20% -> 0 pts
                top1ProfitConcentrationPct: 85.0, // 0 pts
                top5ProfitConcentrationPct: 95.0, // 0 pts
            },
            metricCoverage: {
                ...metWorth.metricCoverage,
                pnlUsdObservations: 35, // 0 pts
                pnlPctObservations: 35,
            },
        });
        const resNotRec = computeMonitoringAssessment(dsWorth, metNotRec);
        assert.equal(resNotRec.verdict, MONITORING_VERDICTS.NOT_RECOMMENDED);
        assert.ok(resNotRec.monitoringScore < 45);

        // D. INSUFFICIENT_DATA (positions < 30)
        const dsSmall = createMockDataset({
            positions: Array.from({ length: 15 }),
        });
        const metSmall = createMockMetrics({
            sampling: { analyzedPositions: 15, totalEligiblePositions: 15, coveragePct: 100, isSampled: false },
            metricCoverage: {
                ...metWorth.metricCoverage,
                analyzedPositions: 15,
                pnlUsdObservations: 15,
                pnlPctObservations: 15,
            },
        });
        const resSmall = computeMonitoringAssessment(dsSmall, metSmall);
        assert.equal(resSmall.verdict, MONITORING_VERDICTS.INSUFFICIENT_DATA);
        assert.equal(resSmall.monitoringScore, null);
        assert.equal(resSmall.scoreComponents, null);
    });

    // -------------------------------------------------------------------------
    // 2. All four followability labels
    // -------------------------------------------------------------------------
    it("2. All four followability labels: classifies HIGH, MODERATE, LOW, and UNKNOWN independently of verdict", () => {
        const ds = createMockDataset();

        // A. HIGH: Median hold >= 6h (21600s), entries/day <= 2
        const metHigh = createMockMetrics({
            tradingBehavior: {
                ...createMockMetrics().tradingBehavior,
                medianHoldingTimeSeconds: 28800, // 8 hours
                observedEntriesPerDay: 1.5,
            },
        });
        assert.equal(computeMonitoringAssessment(ds, metHigh).manualFollowability, MANUAL_FOLLOWABILITY.HIGH);

        // B. MODERATE: Median hold >= 1h (3600s), entries/day <= 6
        const metMod = createMockMetrics({
            tradingBehavior: {
                ...createMockMetrics().tradingBehavior,
                medianHoldingTimeSeconds: 7200, // 2 hours
                observedEntriesPerDay: 4.0,
            },
        });
        assert.equal(computeMonitoringAssessment(ds, metMod).manualFollowability, MANUAL_FOLLOWABILITY.MODERATE);

        // C. LOW: Adequately observed but fast trading (hold < 1h or entries/day > 6)
        const metLow = createMockMetrics({
            tradingBehavior: {
                ...createMockMetrics().tradingBehavior,
                medianHoldingTimeSeconds: 900, // 15 mins
                observedEntriesPerDay: 12.0,
            },
        });
        const resLow = computeMonitoringAssessment(ds, metLow);
        assert.equal(resLow.manualFollowability, MANUAL_FOLLOWABILITY.LOW);
        // Important rule verification: verdict is still WORTH_MONITORING if financial gates pass
        assert.equal(resLow.verdict, MONITORING_VERDICTS.WORTH_MONITORING);

        // D. UNKNOWN: Inadequate observations (< 20 hold obs or < 10 qualifying openings)
        const metUnknown = createMockMetrics({
            metricCoverage: {
                ...createMockMetrics().metricCoverage,
                holdingTimeObservations: 12, // < 20
            },
        });
        assert.equal(computeMonitoringAssessment(ds, metUnknown).manualFollowability, MANUAL_FOLLOWABILITY.UNKNOWN);
    });

    // -------------------------------------------------------------------------
    // 3. Small-sample insufficient-data gate
    // -------------------------------------------------------------------------
    it("3. Small-sample insufficient-data gate: triggers INSUFFICIENT_DATA when observation counts fail thresholds", () => {
        const ds = createMockDataset();

        // Fail condition A: Analyzed positions < 30
        const metPosFail = createMockMetrics({
            sampling: { analyzedPositions: 28, totalEligiblePositions: 28, coveragePct: 100, isSampled: false },
        });
        const resPos = computeMonitoringAssessment(ds, metPosFail);
        assert.equal(resPos.verdict, MONITORING_VERDICTS.INSUFFICIENT_DATA);
        assert.equal(resPos.monitoringScore, null);
        assert.ok(resPos.concerns.some((c: string) => c.includes("Analyzed closed positions (28) < 30")));

        // Fail condition B: PnL USD observations < 20
        const metPnlFail = createMockMetrics({
            metricCoverage: { ...createMockMetrics().metricCoverage, pnlUsdObservations: 18 },
        });
        const resPnl = computeMonitoringAssessment(ds, metPnlFail);
        assert.equal(resPnl.verdict, MONITORING_VERDICTS.INSUFFICIENT_DATA);
        assert.ok(resPnl.concerns.some((c: string) => c.includes("Known PnL USD observations (18) < 20")));

        // Fail condition C: Observed weeks with known PnL < 3
        const metWeeksFail = createMockMetrics({
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                weeklyRealizedPositionPnlUsd: [
                    { weekStartDateWib: "2026-01-01", weekEndDateWib: "2026-01-07", realizedPnlUsd: 100, closedPositionCount: 5, winCount: 5, lossCount: 0 },
                    { weekStartDateWib: "2026-01-08", weekEndDateWib: "2026-01-14", realizedPnlUsd: 200, closedPositionCount: 5, winCount: 5, lossCount: 0 },
                ],
            },
        });
        const resWeeks = computeMonitoringAssessment(ds, metWeeksFail);
        assert.equal(resWeeks.verdict, MONITORING_VERDICTS.INSUFFICIENT_DATA);
        assert.ok(resWeeks.concerns.some((c: string) => c.includes("Observed weeks with known PnL (2) < 3")));
    });

    // -------------------------------------------------------------------------
    // 4. Positive PnL but concentrated profits
    // -------------------------------------------------------------------------
    it("4. Positive PnL but concentrated profits: penalizes high concentration and blocks WORTH_MONITORING", () => {
        const ds = createMockDataset();
        const metConcentrated = createMockMetrics({
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                top1ProfitConcentrationPct: 62.0, // > 40% (0 pts, fails Worth gate)
                top5ProfitConcentrationPct: 92.0, // > 80% (0 pts)
            },
        });
        const res = computeMonitoringAssessment(ds, metConcentrated);
        assert.equal(res.scoreComponents?.profitConcentration.score, 0);
        assert.notEqual(res.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
        assert.equal(res.verdict, MONITORING_VERDICTS.WATCH_WITH_CAUTION);
        assert.ok(res.concerns.some((c: string) => c.includes("top position accounts for 62.0%")));
    });

    // -------------------------------------------------------------------------
    // 5. Negative tail risk
    // -------------------------------------------------------------------------
    it("5. Negative tail risk: penalizes poor CVaR10 and blocks WORTH_MONITORING gate", () => {
        const ds = createMockDataset();
        const metTailRisk = createMockMetrics({
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                cvar10PositionPnlPct: -28.5, // < -20% (0 pts, fails Worth gate)
            },
        });
        const res = computeMonitoringAssessment(ds, metTailRisk);
        assert.equal(res.scoreComponents?.riskAndConsistency.cvar10Points, 0);
        assert.notEqual(res.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
        assert.ok(res.concerns.some((c: string) => c.includes("Elevated tail risk: CVaR10 of -28.5%")));
    });

    // -------------------------------------------------------------------------
    // 6. Strong result with insufficient history
    // -------------------------------------------------------------------------
    it("6. Strong result with insufficient history: high score demoted to WATCH_WITH_CAUTION due to < 6 observed weeks", () => {
        const ds = createMockDataset();
        // 4 weeks of stellar results
        const weeklyRealizedPositionPnlUsd = Array.from({ length: 4 }, (_, i) => ({
            weekStartDateWib: `2026-01-${String((i + 1) * 7).padStart(2, "0")}`,
            weekEndDateWib: `2026-01-${String((i + 1) * 7 + 6).padStart(2, "0")}`,
            realizedPnlUsd: 500,
            closedPositionCount: 20,
            winCount: 18,
            lossCount: 2,
            observedPnlCount: 20,
            unknownPnlCount: 0,
        }));
        const metShortHistory = createMockMetrics({
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                weeklyRealizedPositionPnlUsd,
                profitableWeeksCount: 4, // 100%
            },
        });
        const res = computeMonitoringAssessment(ds, metShortHistory);
        // Score is still high (20+15 + 15+10 + 12+4+5 + 8+7 = 96)
        assert.ok(res.monitoringScore >= 75);
        // But fails the 6-week quality gate
        assert.equal(res.verdict, MONITORING_VERDICTS.WATCH_WITH_CAUTION);
        assert.ok(res.concerns.some((c: string) => c.includes("Failed Worth gate") && c.includes("Observed weeks")));
    });

    // -------------------------------------------------------------------------
    // 7. Missing metrics and null handling
    // -------------------------------------------------------------------------
    it("7. Missing metrics and null handling: null concentrations are never treated as 0% and null CVaR10 triggers INSUFFICIENT_DATA", () => {
        const ds = createMockDataset();

        // A. Absence of positive profits -> null concentration
        const metNoProfits = createMockMetrics({
            profitability: {
                ...createMockMetrics().profitability,
                sampleTotalPnlUsd: -100,
                medianPositionPnlPct: -1.0,
            },
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                top1ProfitConcentrationPct: null,
                top5ProfitConcentrationPct: null,
            },
        });
        const resNoProfits = computeMonitoringAssessment(ds, metNoProfits);
        assert.equal(resNoProfits.scoreComponents?.profitConcentration.score, 0);
        assert.equal(resNoProfits.scoreComponents?.profitConcentration.top1Points, 0);

        // B. Missing critical risk metric CVaR10 -> INSUFFICIENT_DATA
        const metMissingCvar = createMockMetrics({
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                cvar10PositionPnlPct: null,
            },
        });
        const resMissingCvar = computeMonitoringAssessment(ds, metMissingCvar);
        assert.equal(resMissingCvar.verdict, MONITORING_VERDICTS.INSUFFICIENT_DATA);
        assert.equal(resMissingCvar.monitoringScore, null);
        assert.ok(resMissingCvar.concerns.some((c: string) => c.includes("CVaR10 is unavailable")));
    });

    // -------------------------------------------------------------------------
    // 8. Partial source coverage
    // -------------------------------------------------------------------------
    it("8. Partial source coverage: denies coverage bonus, blocks Worth gate, and records concern without fabricating losses", () => {
        const ds = createMockDataset({
            sourceCoverage: { status: "PARTIAL", fabriqPoolsDiscovered: 5, dlmmPoolsMatched: 3, totalPositionsFound: 80, totalEligiblePositions: 80 },
        });
        const metPartial = createMockMetrics({
            sourceCoverage: { status: "PARTIAL", fabriqPoolsDiscovered: 5, dlmmPoolsMatched: 3, totalPositionsFound: 80, totalEligiblePositions: 80 },
        });
        const res = computeMonitoringAssessment(ds, metPartial);
        assert.equal(res.scoreComponents?.trackRecord.coveragePoints, 0); // 0 pts because source is PARTIAL
        assert.equal(res.verdict, MONITORING_VERDICTS.WATCH_WITH_CAUTION);
        assert.ok(res.concerns.some((c: string) => c.includes("Partial source coverage")));
        assert.ok(res.limitations.some((l: string) => l.includes("Partial source coverage")));
    });

    // -------------------------------------------------------------------------
    // 9. 1000-position sample coverage limitation
    // -------------------------------------------------------------------------
    it("9. 1000-position sample coverage limitation: enforces >= 50% coverage gate when capped", () => {
        const ds = createMockDataset();

        // 1,000 analyzed out of 2,500 eligible -> 40% coverage (< 50% threshold)
        const metCappedLow = createMockMetrics({
            sampling: {
                totalEligiblePositions: 2500,
                analyzedPositions: 1000,
                excludedPositions: 1500,
                duplicatesRemoved: 0,
                coveragePct: 40.0,
                isSampled: true,
                selectionMethod: "LATEST_CLOSED_1000",
            },
            metricCoverage: {
                ...createMockMetrics().metricCoverage,
                analyzedPositions: 1000,
                pnlUsdObservations: 1000,
                pnlPctObservations: 1000,
            },
        });
        const resLow = computeMonitoringAssessment(ds, metCappedLow);
        assert.notEqual(resLow.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
        assert.equal(resLow.verdict, MONITORING_VERDICTS.WATCH_WITH_CAUTION);
        assert.ok(resLow.concerns.some((c: string) => c.includes("Sampling coverage (40.0%) < 50%")));

        // 1,000 analyzed out of 1,600 eligible -> 62.5% coverage (>= 50% threshold)
        const metCappedPass = createMockMetrics({
            sampling: {
                totalEligiblePositions: 1600,
                analyzedPositions: 1000,
                excludedPositions: 600,
                duplicatesRemoved: 0,
                coveragePct: 62.5,
                isSampled: true,
                selectionMethod: "LATEST_CLOSED_1000",
            },
            metricCoverage: {
                ...createMockMetrics().metricCoverage,
                analyzedPositions: 1000,
                pnlUsdObservations: 1000,
                pnlPctObservations: 1000,
            },
        });
        const resPass = computeMonitoringAssessment(ds, metCappedPass);
        assert.equal(resPass.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
    });

    // -------------------------------------------------------------------------
    // 10. 30D historical-evidence limitation
    // -------------------------------------------------------------------------
    it("10. 30D historical-evidence limitation: 30D timeframe cannot achieve WORTH_MONITORING and records explicit limitation", () => {
        // In 30 days, there can be at most ~4.3 observed weeks
        const weeklyRealizedPositionPnlUsd = Array.from({ length: 4 }, (_, i) => ({
            weekStartDateWib: `2026-02-${String((i + 1) * 7).padStart(2, "0")}`,
            weekEndDateWib: `2026-02-${String((i + 1) * 7 + 6).padStart(2, "0")}`,
            realizedPnlUsd: 300,
            closedPositionCount: 15,
            winCount: 12,
            lossCount: 3,
            observedPnlCount: 15,
            unknownPnlCount: 0,
        }));
        const ds30D = createMockDataset({ period: "30D" });
        const met30D = createMockMetrics({
            period: "30D",
            riskAndConsistency: {
                ...createMockMetrics().riskAndConsistency,
                weeklyRealizedPositionPnlUsd,
                profitableWeeksCount: 4,
            },
        });
        const res = computeMonitoringAssessment(ds30D, met30D);
        assert.notEqual(res.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
        assert.equal(res.verdict, MONITORING_VERDICTS.WATCH_WITH_CAUTION);
        assert.ok(res.concerns.some((c: string) => c.includes("30D snapshot history")));
        assert.ok(res.limitations.some((l: string) => l.includes("Because of the 6-week observation requirement, a 30D snapshot alone normally cannot establish WORTH_MONITORING.")));
    });

    // -------------------------------------------------------------------------
    // 11. Exact scoring boundaries
    // -------------------------------------------------------------------------
    it("11. Exact scoring boundaries: tests exact tier boundaries across all scoring dimensions", () => {
        const ds = createMockDataset();

        // Helper to test isolated component scores
        const scoreMetrics = (overrides: Record<string, any>) => {
            const m = createMockMetrics(overrides);
            return computeMonitoringAssessment(ds, m).scoreComponents;
        };

        // CVaR10 boundaries: -10% (+20), -10.01% (+10), -20% (+10), -20.01% (+0)
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, cvar10PositionPnlPct: -10.0 } }).riskAndConsistency.cvar10Points, 20);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, cvar10PositionPnlPct: -10.01 } }).riskAndConsistency.cvar10Points, 10);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, cvar10PositionPnlPct: -20.0 } }).riskAndConsistency.cvar10Points, 10);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, cvar10PositionPnlPct: -20.01 } }).riskAndConsistency.cvar10Points, 0);

        // Weekly profit ratio boundaries: 60% (+15), 59.9% (+7), 45% (+7), 44.9% (+0)
        // 6 of 10 = 60%
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, profitableWeeksCount: 6 } }).riskAndConsistency.weeklyRatioPoints, 15);
        // 9 of 16 = 56.25% (between 45 and 60)
        const sixteenWeeks = Array.from({ length: 16 }, (_, i) => ({
            weekStartDateWib: "2026-01-01", weekEndDateWib: "2026-01-07", realizedPnlUsd: i < 9 ? 100 : -100, closedPositionCount: 5, winCount: 4, lossCount: 1,
        }));
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, weeklyRealizedPositionPnlUsd: sixteenWeeks, profitableWeeksCount: 9 } }).riskAndConsistency.weeklyRatioPoints, 7);
        // 7 of 16 = 43.75% (< 45%)
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, weeklyRealizedPositionPnlUsd: sixteenWeeks, profitableWeeksCount: 7 } }).riskAndConsistency.weeklyRatioPoints, 0);

        // Top 1 concentration boundaries: <= 25% (+15), 25.1% (+7), 40% (+7), 40.1% (+0)
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top1ProfitConcentrationPct: 25.0 } }).profitConcentration.top1Points, 15);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top1ProfitConcentrationPct: 25.1 } }).profitConcentration.top1Points, 7);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top1ProfitConcentrationPct: 40.0 } }).profitConcentration.top1Points, 7);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top1ProfitConcentrationPct: 40.1 } }).profitConcentration.top1Points, 0);

        // Top 5 concentration boundaries: <= 60% (+10), 60.1% (+5), 80% (+5), 80.1% (+0)
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top5ProfitConcentrationPct: 60.0 } }).profitConcentration.top5Points, 10);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top5ProfitConcentrationPct: 60.1 } }).profitConcentration.top5Points, 5);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top5ProfitConcentrationPct: 80.0 } }).profitConcentration.top5Points, 5);
        assert.equal(scoreMetrics({ riskAndConsistency: { ...createMockMetrics().riskAndConsistency, top5ProfitConcentrationPct: 80.1 } }).profitConcentration.top5Points, 0);

        // PnL observations: >= 100 (+12), >= 40 (+6), < 40 (+0)
        assert.equal(scoreMetrics({ metricCoverage: { ...createMockMetrics().metricCoverage, pnlUsdObservations: 100, pnlPctObservations: 100 } }).trackRecord.pnlObsPoints, 12);
        assert.equal(scoreMetrics({ metricCoverage: { ...createMockMetrics().metricCoverage, pnlUsdObservations: 99, pnlPctObservations: 99 } }).trackRecord.pnlObsPoints, 6);
        assert.equal(scoreMetrics({ metricCoverage: { ...createMockMetrics().metricCoverage, pnlUsdObservations: 40, pnlPctObservations: 40 } }).trackRecord.pnlObsPoints, 6);
        assert.equal(scoreMetrics({ metricCoverage: { ...createMockMetrics().metricCoverage, pnlUsdObservations: 39, pnlPctObservations: 39 } }).trackRecord.pnlObsPoints, 0);

        // Profitability points: sampleTotalPnlUsd > 0 (+8), <= 0 (+0); medianPositionPnlPct > 0 (+7), <= 0 (+0)
        assert.equal(scoreMetrics({ profitability: { ...createMockMetrics().profitability, sampleTotalPnlUsd: 0.01 } }).profitability.sampleTotalPnlPoints, 8);
        assert.equal(scoreMetrics({ profitability: { ...createMockMetrics().profitability, sampleTotalPnlUsd: 0 } }).profitability.sampleTotalPnlPoints, 0);
        assert.equal(scoreMetrics({ profitability: { ...createMockMetrics().profitability, medianPositionPnlPct: 0.01 } }).profitability.medianPnlPctPoints, 7);
        assert.equal(scoreMetrics({ profitability: { ...createMockMetrics().profitability, medianPositionPnlPct: 0 } }).profitability.medianPnlPctPoints, 0);
    });

    // -------------------------------------------------------------------------
    // 12. Explanation consistency
    // -------------------------------------------------------------------------
    it("12. Explanation consistency: caps reasons and concerns at 4 each and references observed metrics", () => {
        const ds = createMockDataset();
        const met = createMockMetrics();
        const res = computeMonitoringAssessment(ds, met);

        assert.ok(Array.isArray(res.reasons));
        assert.ok(res.reasons.length <= 4);
        assert.ok(Array.isArray(res.concerns));
        assert.ok(res.concerns.length <= 4);
        assert.ok(Array.isArray(res.limitations));

        // Ensure reason contains actual data references
        assert.ok(res.reasons.some((r: string) => r.includes("7 of 10 observed weeks")));
        assert.ok(res.reasons.some((r: string) => r.includes("CVaR10 of -6.5%")));
    });

    // -------------------------------------------------------------------------
    // 12b. Duration formatting regression
    // -------------------------------------------------------------------------
    it("12b. Duration formatting regression: formats durations accurately in formatDurationSimple and assessment output", () => {
        // Direct unit tests for formatDurationSimple
        assert.equal(formatDurationSimple(60), "1m");
        assert.equal(formatDurationSimple(3600), "1h");
        assert.equal(formatDurationSimple(3900), "1h 5m");
        assert.equal(formatDurationSimple(21600), "6h");
        assert.equal(formatDurationSimple(86400), "1d");
        assert.equal(formatDurationSimple(90000), "1d 1h");
        assert.equal(formatDurationSimple(null), "—");
        assert.equal(formatDurationSimple(undefined), "—");
        assert.equal(formatDurationSimple(NaN), "—");
        assert.equal(formatDurationSimple(-1), "—");
        // @ts-expect-error - testing invalid runtime input
        assert.equal(formatDurationSimple("invalid"), "—");

        const ds = createMockDataset();

        // Public assessment reason verification: HIGH manual followability
        const checkHighHoldReason = (seconds: number, expectedDurationStr: string) => {
            const met = createMockMetrics({
                riskAndConsistency: {
                    ...createMockMetrics().riskAndConsistency,
                    cvar10PositionPnlPct: -25.0, // Suppress cvar reason
                    top1ProfitConcentrationPct: 50.0, // Suppress concentration reason
                    profitableWeeksCount: 0, // Suppress weekly profit reason
                },
                profitability: {
                    ...createMockMetrics().profitability,
                    sampleTotalPnlUsd: -500, // Suppress positive pnl reason
                },
                metricCoverage: {
                    ...createMockMetrics().metricCoverage,
                    pnlUsdObservations: 35, // Suppress track record reason
                },
                tradingBehavior: {
                    ...createMockMetrics().tradingBehavior,
                    medianHoldingTimeSeconds: seconds,
                    observedEntriesPerDay: 1.0,
                },
            });
            const res = computeMonitoringAssessment(ds, met);
            assert.equal(res.manualFollowability, MANUAL_FOLLOWABILITY.HIGH);
            assert.ok(
                res.reasons.some((r: string) =>
                    r === `Manual followability favorable: median hold duration is ${expectedDurationStr} with 1.0 entries/day`
                ),
                `Expected reason with "${expectedDurationStr}", got reasons: ${JSON.stringify(res.reasons)}`
            );
        };

        checkHighHoldReason(21600, "6h");
        checkHighHoldReason(86400, "1d");
        checkHighHoldReason(90000, "1d 1h");

        // Public assessment concern verification: LOW manual followability with short hold duration
        const checkShortHoldConcern = (seconds: number, expectedDurationStr: string) => {
            const met = createMockMetrics({
                tradingBehavior: {
                    ...createMockMetrics().tradingBehavior,
                    medianHoldingTimeSeconds: seconds,
                    observedEntriesPerDay: 1.0,
                },
            });
            const res = computeMonitoringAssessment(ds, met);
            assert.equal(res.manualFollowability, MANUAL_FOLLOWABILITY.LOW);
            assert.ok(
                res.concerns.some((c: string) =>
                    c === `Short median hold duration (${expectedDurationStr}) with 1.0 entries/day makes manual following difficult`
                ),
                `Expected concern with "${expectedDurationStr}", got concerns: ${JSON.stringify(res.concerns)}`
            );
        };

        checkShortHoldConcern(60, "1m");

        // Public assessment concern verification: LOW manual followability with fast trading (>6 entries/day)
        const checkFastTradingConcern = (seconds: number, expectedDurationStr: string) => {
            const met = createMockMetrics({
                tradingBehavior: {
                    ...createMockMetrics().tradingBehavior,
                    medianHoldingTimeSeconds: seconds,
                    observedEntriesPerDay: 8.0,
                },
            });
            const res = computeMonitoringAssessment(ds, met);
            assert.equal(res.manualFollowability, MANUAL_FOLLOWABILITY.LOW);
            assert.ok(
                res.concerns.some((c: string) =>
                    c === `Short median hold duration (${expectedDurationStr}) with 8.0 entries/day makes manual following difficult`
                ),
                `Expected concern with "${expectedDurationStr}", got concerns: ${JSON.stringify(res.concerns)}`
            );
        };

        checkFastTradingConcern(3600, "1h");
        checkFastTradingConcern(3900, "1h 5m");

        // Null / invalid duration produces UNKNOWN followability without hold duration reason or concern
        const metNull = createMockMetrics({
            tradingBehavior: {
                ...createMockMetrics().tradingBehavior,
                medianHoldingTimeSeconds: null,
            },
        });
        const resNull = computeMonitoringAssessment(ds, metNull);
        assert.equal(resNull.manualFollowability, MANUAL_FOLLOWABILITY.UNKNOWN);
        assert.ok(!resNull.reasons.some((r: string) => r.includes("median hold duration")));
        assert.ok(!resNull.concerns.some((c: string) => c.includes("median hold duration")));
    });

    // -------------------------------------------------------------------------
    // 13 & 14. Server API Integration Tests (Isolation & Consistency)
    // -------------------------------------------------------------------------
    describe("Control Server Assessment API Endpoints", () => {
        before(async () => {
            fs.mkdirSync(POSITIONS_TEST_DIR, { recursive: true });
            fs.mkdirSync(METRICS_TEST_DIR, { recursive: true });
            fs.mkdirSync(BUNDLES_TEST_DIR, { recursive: true });

            // Set up a valid published pair for TEST_WALLET on 90D
            const mockDs90D = createMockDataset({ wallet: TEST_WALLET, period: "90D", fetchedAt: "2026-03-20T12:00:00.000Z" });
            const mockMet90D = createMockMetrics({ wallet: TEST_WALLET, period: "90D", sourceDatasetFetchedAt: "2026-03-20T12:00:00.000Z" });

            publishPositionAnalyticsPair({
                wallet: TEST_WALLET,
                period: "90D",
                dataset: mockDs90D as any,
                metrics: mockMet90D as any,
                bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            });

            // Start test control server on TEST_PORT
            serverProcess = spawn(process.execPath, ["scripts/control/server.mjs"], {
                cwd: ROOT,
                env: {
                    ...process.env,
                    CONTROL_SERVER_PORT: String(TEST_PORT),
                    PORT: String(TEST_PORT),
                },
                stdio: "pipe",
            });

            await waitForServerReady(serverProcess);
        });

        after(async () => {
            if (serverProcess) {
                const { promise, resolve } = Promise.withResolvers<void>();
                serverProcess.once("exit", () => resolve());
                serverProcess.kill("SIGTERM");
                await promise;
                serverProcess = null;
            }

            try {
                fs.rmSync(POSITIONS_TEST_DIR, { recursive: true, force: true });
                fs.rmSync(METRICS_TEST_DIR, { recursive: true, force: true });
                fs.rmSync(BUNDLES_TEST_DIR, { recursive: true, force: true });
            } catch {}
        });

        it("13. Assessment API wallet/period isolation: validates parameters and isolates queries", async () => {
            // A. Invalid wallet address -> 400
            const resBadWallet = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=invalid-address&period=90D`);
            assert.equal(resBadWallet.status, 400);

            // B. Invalid period -> 400
            const resBadPeriod = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=${TEST_WALLET}&period=INVALID`);
            assert.equal(resBadPeriod.status, 400);

            // C. Non-existent wallet -> 404
            const resNotFoundWallet = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=${TEST_WALLET_ALT}&period=90D`);
            assert.equal(resNotFoundWallet.status, 404);

            // D. Non-existent period for existing wallet -> 404 (30D doesn't exist, only 90D exists)
            const resNotFoundPeriod = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=${TEST_WALLET}&period=30D`);
            assert.equal(resNotFoundPeriod.status, 404);

            // E. Valid existing wallet & period -> 200 with matching assessment
            const resValid = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=${TEST_WALLET}&period=90D`);
            assert.equal(resValid.status, 200);
            const data = await resValid.json();
            assert.equal(data.wallet, TEST_WALLET);
            assert.equal(data.period, "90D");
            assert.equal(data.version, "v1");
            assert.equal(data.verdict, MONITORING_VERDICTS.WORTH_MONITORING);
            assert.equal(data.manualFollowability, MANUAL_FOLLOWABILITY.HIGH);
            assert.ok(data.monitoringScore >= 75);
        });

        it("14. Published-pair version consistency: rejects mismatched legacy snapshots and enforces alignment", async () => {
            // Delete bundle to force legacy fallback check
            const bundleFile = getBundleFilePath(TEST_WALLET, "90D", path.join(ROOT, "data/analytics/bundles"));
            if (fs.existsSync(bundleFile)) {
                fs.unlinkSync(bundleFile);
            }

            // Write mismatched legacy files: dataset fetched at T1, metrics pointing to T2
            const dsLegacy = createMockDataset({ wallet: TEST_WALLET, period: "90D", fetchedAt: "2026-03-20T12:00:00.000Z" });
            const metLegacyMismatched = createMockMetrics({ wallet: TEST_WALLET, period: "90D", sourceDatasetFetchedAt: "2026-03-22T08:00:00.000Z" });

            fs.writeFileSync(path.join(POSITIONS_TEST_DIR, "90D.json"), JSON.stringify(dsLegacy));
            fs.writeFileSync(path.join(METRICS_TEST_DIR, "90D.json"), JSON.stringify(metLegacyMismatched));

            const resMismatched = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=${TEST_WALLET}&period=90D`);
            // loadPublishedPositionPair rejects mismatched legacy files -> returns null -> server responds with 404
            assert.equal(resMismatched.status, 404);

            // Now write aligned legacy files
            const metLegacyAligned = createMockMetrics({ wallet: TEST_WALLET, period: "90D", sourceDatasetFetchedAt: "2026-03-20T12:00:00.000Z" });
            fs.writeFileSync(path.join(METRICS_TEST_DIR, "90D.json"), JSON.stringify(metLegacyAligned));

            const resAligned = await fetch(`${BASE_URL}/api/position-analytics/assessment?wallet=${TEST_WALLET}&period=90D`);
            assert.equal(resAligned.status, 200);
            const data = await resAligned.json();
            assert.equal(data.sourceDatasetFetchedAt, "2026-03-20T12:00:00.000Z");
        });
    });
});
