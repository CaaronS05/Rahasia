import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
    publishPositionAnalyticsPair,
    getBundleFilePath,
} from "../../scripts/analytics/position-analytics-storage.ts";
const TEST_PORT = 8991;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const TEST_WALLET_ALT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TEST_WALLET_MULTI = "Hg9WqUWiXMqdv2NoTRVNY9j282QTSV1fsbm64GcFv8Rk";
const ROOT = process.cwd();
const POSITIONS_TEST_DIR = path.join(ROOT, "data/analytics/positions", TEST_WALLET);
const METRICS_TEST_DIR = path.join(ROOT, "data/analytics/metrics", TEST_WALLET);
const MULTI_POSITIONS_DIR = path.join(ROOT, "data/analytics/positions", TEST_WALLET_MULTI);
const MULTI_METRICS_DIR = path.join(ROOT, "data/analytics/metrics", TEST_WALLET_MULTI);
const MULTI_BUNDLE_PATH = getBundleFilePath(TEST_WALLET_MULTI, "30D", path.join(ROOT, "data/analytics/bundles"));
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

describe("Position Analytics Backend Control API", () => {
    before(async () => {
        // Setup mock test data
        fs.mkdirSync(POSITIONS_TEST_DIR, { recursive: true });
        fs.mkdirSync(METRICS_TEST_DIR, { recursive: true });
        try {
            fs.rmSync(path.join(ROOT, "data/analytics/bundles", TEST_WALLET), { recursive: true, force: true });
            fs.rmSync(path.join(ROOT, "data/analytics/bundles", TEST_WALLET_MULTI), { recursive: true, force: true });
        } catch {}
        const mockPositions30D = {
            schemaVersion: "v1",
            wallet: TEST_WALLET,
            period: "30D",
            dataSource: "fabriq",
            fetchedAt: "2026-03-10T12:00:00.000Z",
            timeframe: {
                requestedPeriod: "30D",
                effectiveStart: "2026-02-08T12:00:00.000Z",
                effectiveEnd: "2026-03-10T12:00:00.000Z",
                firstAvailableTimestamp: null,
                lastAvailableTimestamp: null,
                observedStart: null,
                observedEnd: null,
            },
            sourceCoverage: {
                status: "COMPLETE",
                fabriqPoolsDiscovered: 1,
                dlmmPoolsMatched: 1,
                totalPositionsFound: 1,
                totalEligiblePositions: 1,
            },
            sampling: {
                totalEligiblePositions: 1,
                analyzedPositions: 1,
                excludedPositions: 0,
                duplicatesRemoved: 0,
                coveragePct: 100,
                isSampled: false,
                selectionMethod: "LATEST_CLOSED_1000",
            },
            dataQuality: {
                validClosedPositions: 1,
                initialEntriesVerified: 1,
                initialEntriesUnavailable: 0,
                firstObservedAddOnly: 0,
                initialEntryCoveragePct: 100,
                fullLifecycleCoveragePositions: 1,
                warnings: [],
            },
            positions: [
                {
                    wallet: TEST_WALLET,
                    positionId: "pos-123456",
                    poolAddress: "pool-abc-111",
                    source: "fabriq",
                    tokenXMint: "So11111111111111111111111111111111111111112",
                    tokenYMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    tokenXSymbol: "SOL",
                    tokenYSymbol: "USDC",
                    pairName: "SOL-USDC",
                    openedAt: "2026-02-15T10:00:00.000Z",
                    closedAt: "2026-02-20T10:00:00.000Z",
                    holdDurationSeconds: 432000,
                    initialEntryUsd: 1500,
                    firstObservedAddUsd: null,
                    additionalLiquidityUsd: 0,
                    totalDepositsUsd: 1500,
                    totalWithdrawalsUsd: 1650,
                    claimedFeesUsd: 50,
                    pnlUsd: 200,
                    pnlPct: 13.33,
                    winLoss: "WIN",
                    lifecycle: {
                        openingEventObserved: true,
                        closingEventObserved: true,
                        eventCount: 2,
                        events: [
                            {
                                rawId: "evt-1",
                                rawType: "POSITION_OPEN",
                                category: "initialize",
                                createdAt: "2026-02-15T10:00:00.000Z",
                                signature: "sig1",
                                source: "fabriq",
                                tokenXAmount: 10,
                                tokenYAmount: 0,
                                tokenXAmountUsd: 1500,
                                tokenYAmountUsd: 0,
                                totalInUsd: 1500,
                            },
                        ],
                    },
                    dataQuality: {
                        initialEntryStatus: "VERIFIED_OPEN_EVENT",
                        transactionCoverage: "FULL_LIFECYCLE",
                        positionCompleteness: "COMPLETE",
                        warnings: [],
                    },
                },
            ],
            diagnostics: {
                executionMs: 120,
                poolPagesFetched: 1,
                positionBatchesFetched: 1,
                transactionBatchesFetched: 1,
                requestRetries: 0,
                skippedRecords: [],
            },
        };

        const mockMetrics30D = {
            schemaVersion: "v1",
            wallet: TEST_WALLET,
            period: "30D",
            generatedAt: "2026-03-10T12:05:00.000Z",
            sourceDatasetFetchedAt: "2026-03-10T12:00:00.000Z",
            timeframe: mockPositions30D.timeframe,
            sourceCoverage: mockPositions30D.sourceCoverage,
            sampling: mockPositions30D.sampling,
            dataQuality: mockPositions30D.dataQuality,
            metricCoverage: {
                analyzedPositions: 1,
                initialEntryObservations: 1,
                initialEntryCoveragePct: 100,
                totalDepositsObservations: 1,
                additionalLiquidityObservations: 0,
                pnlUsdObservations: 1,
                pnlPctObservations: 1,
                holdingTimeObservations: 1,
                openedAtObservations: 1,
                closedAtObservations: 1,
            },
            capital: {
                totalPositionDepositsUsd: 1500,
                avgInitialEntryUsd: 1500,
                medianInitialEntryUsd: 1500,
                initialEntryP25: 1500,
                initialEntryP75: 1500,
                typicalPositionSize: { p25: 1500, p75: 1500 },
                avgTotalPositionDepositsUsd: 1500,
                medianTotalPositionDepositsUsd: 1500,
                avgAdditionalLiquidityUsd: 0,
                positionSizeDistribution: [],
            },
            profitability: {
                sampleTotalPnlUsd: 200,
                avgPositionPnlPct: 13.33,
                medianPositionPnlPct: 13.33,
                bestWinningPositionPct: 13.33,
                worstLosingPositionPct: null,
                positionWinRate: 100,
                profitFactor: null,
                profitFactorStatus: "UNBOUNDED_NO_LOSSES",
                avgWinningPositionPct: 13.33,
                avgLosingPositionPct: null,
                pnlDistribution: [],
                winCount: 1,
                lossCount: 0,
                breakevenCount: 0,
                unknownCount: 0,
                unknownPnlExcludedCount: 0,
            },
            riskAndConsistency: {
                cvar10PositionPnlPct: 13.33,
                worstPositionPnlPct: 13.33,
                pnlStdDev: 0,
                top1ProfitConcentrationPct: 100,
                top5ProfitConcentrationPct: 100,
                longestConsecutiveLosingStreak: 0,
                weeklyRealizedPositionPnlUsd: [],
                profitableWeeksCount: 1,
                losingWeeksCount: 0,
                breakevenWeeksCount: 0,
                weeklyPnlVariability: null,
                hasIncompleteCoverageDueToCap: false,
                sampleRealizedPnlDrawdown: {
                    label: "Sample Realized PnL Drawdown",
                    maxDrawdownUsd: 0,
                    peakCumulativePnlUsd: 200,
                    troughCumulativePnlUsd: 200,
                },
            },
            tradingBehavior: {
                avgHoldingTimeSeconds: 432000,
                medianHoldingTimeSeconds: 432000,
                holdingTimeDistribution: [],
                observedEntriesPerDay: 0.2,
                entryActivityLabel: "Observed entries among analyzed closed positions",
                entryActivityByHourWib: [],
                entryActivityByWeekdayWib: [],
                activeEntryDays: 1,
                openingTimeCoverage: {
                    analyzedPositions: 1,
                    openedAtObservations: 1,
                    coveragePct: 100,
                },
                positionSizeByPair: [],
            },
            pairBreakdown: [],
            poolBreakdown: [],
        };

        fs.writeFileSync(path.join(POSITIONS_TEST_DIR, "30D.json"), JSON.stringify(mockPositions30D));
        fs.writeFileSync(path.join(METRICS_TEST_DIR, "30D.json"), JSON.stringify(mockMetrics30D));

        // Setup mock dataset for TEST_WALLET_MULTI with shared positionId across distinct pools
        fs.mkdirSync(MULTI_POSITIONS_DIR, { recursive: true });
        fs.mkdirSync(MULTI_METRICS_DIR, { recursive: true });
        const mockMultiPositions = {
            schemaVersion: "v1",
            wallet: TEST_WALLET_MULTI,
            period: "30D",
            dataSource: "fabriq",
            fetchedAt: "2026-03-15T10:00:00.000Z",
            timeframe: {
                requestedPeriod: "30D",
                effectiveStart: "2026-02-13T10:00:00.000Z",
                effectiveEnd: "2026-03-15T10:00:00.000Z",
                firstAvailableTimestamp: null,
                lastAvailableTimestamp: null,
                observedStart: null,
                observedEnd: null,
            },
            sourceCoverage: {
                status: "COMPLETE",
                fabriqPoolsDiscovered: 2,
                dlmmPoolsMatched: 2,
                totalPositionsFound: 2,
                totalEligiblePositions: 2,
            },
            sampling: {
                totalEligiblePositions: 2,
                analyzedPositions: 2,
                excludedPositions: 0,
                duplicatesRemoved: 0,
                coveragePct: 100,
                isSampled: false,
                selectionMethod: "LATEST_CLOSED_1000",
            },
            dataQuality: {
                validClosedPositions: 2,
                initialEntriesVerified: 2,
                initialEntriesUnavailable: 0,
                firstObservedAddOnly: 0,
                initialEntryCoveragePct: 100,
                fullLifecycleCoveragePositions: 2,
                warnings: [],
            },
            positions: [
                {
                    wallet: TEST_WALLET_MULTI,
                    positionId: "shared-pos-999",
                    poolAddress: "pool-alpha",
                    source: "fabriq",
                    tokenXMint: "So11111111111111111111111111111111111111112",
                    tokenYMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    tokenXSymbol: "SOL",
                    tokenYSymbol: "USDC",
                    pairName: "SOL-USDC",
                    openedAt: "2026-02-15T10:00:00.000Z",
                    closedAt: "2026-02-20T10:00:00.000Z",
                    holdDurationSeconds: 432000,
                    initialEntryUsd: 1000,
                    firstObservedAddUsd: null,
                    additionalLiquidityUsd: 0,
                    totalDepositsUsd: 1000,
                    totalWithdrawalsUsd: 1100,
                    claimedFeesUsd: 20,
                    pnlUsd: 100,
                    pnlPct: 10,
                    winLoss: "WIN",
                    lifecycle: {
                        openingEventObserved: true,
                        closingEventObserved: true,
                        eventCount: 1,
                        events: [
                            {
                                rawId: "evt-alpha",
                                rawType: "POSITION_OPEN",
                                category: "initialize",
                                createdAt: "2026-02-15T10:00:00.000Z",
                                signature: "sig-alpha",
                                source: "fabriq",
                                tokenXAmount: 10,
                                tokenYAmount: 0,
                                tokenXAmountUsd: 1000,
                                tokenYAmountUsd: 0,
                                totalInUsd: 1000,
                            },
                        ],
                    },
                    dataQuality: {
                        initialEntryStatus: "VERIFIED_OPEN_EVENT",
                        transactionCoverage: "FULL_LIFECYCLE",
                        positionCompleteness: "COMPLETE",
                        warnings: [],
                    },
                },
                {
                    wallet: TEST_WALLET_MULTI,
                    positionId: "shared-pos-999",
                    poolAddress: "pool-beta",
                    source: "fabriq",
                    tokenXMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
                    tokenYMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    tokenXSymbol: "RAY",
                    tokenYSymbol: "USDC",
                    pairName: "RAY-USDC",
                    openedAt: "2026-02-16T10:00:00.000Z",
                    closedAt: "2026-02-21T10:00:00.000Z",
                    holdDurationSeconds: 432000,
                    initialEntryUsd: 500,
                    firstObservedAddUsd: null,
                    additionalLiquidityUsd: 0,
                    totalDepositsUsd: 500,
                    totalWithdrawalsUsd: 550,
                    claimedFeesUsd: 10,
                    pnlUsd: 50,
                    pnlPct: 10,
                    winLoss: "WIN",
                    lifecycle: {
                        openingEventObserved: true,
                        closingEventObserved: true,
                        eventCount: 1,
                        events: [
                            {
                                rawId: "evt-beta",
                                rawType: "POSITION_OPEN",
                                category: "initialize",
                                createdAt: "2026-02-16T10:00:00.000Z",
                                signature: "sig-beta",
                                source: "fabriq",
                                tokenXAmount: 250,
                                tokenYAmount: 0,
                                tokenXAmountUsd: 500,
                                tokenYAmountUsd: 0,
                                totalInUsd: 500,
                            },
                        ],
                    },
                    dataQuality: {
                        initialEntryStatus: "VERIFIED_OPEN_EVENT",
                        transactionCoverage: "FULL_LIFECYCLE",
                        positionCompleteness: "COMPLETE",
                        warnings: [],
                    },
                },
            ],
        };
        fs.writeFileSync(path.join(MULTI_POSITIONS_DIR, "30D.json"), JSON.stringify(mockMultiPositions));

        const mockMultiMetrics = {
            schemaVersion: "v1",
            wallet: TEST_WALLET_MULTI,
            period: "30D",
            generatedAt: "2026-03-15T10:00:05.000Z",
            sourceDatasetFetchedAt: "2026-03-15T10:00:00.000Z",
            timeframe: mockMultiPositions.timeframe,
            sourceCoverage: mockMultiPositions.sourceCoverage,
            sampling: mockMultiPositions.sampling,
            dataQuality: mockMultiPositions.dataQuality,
            metricCoverage: {
                totalEligiblePositions: 2,
                analyzedPositions: 2,
                excludedPositions: 0,
                initialEntryObservations: 2,
                initialEntryCoveragePct: 100,
                fullLifecyclePositions: 2,
                fullLifecycleCoveragePct: 100,
            },
            capital: {
                initialEntryObservations: 2,
                averageInitialEntryUsd: 750,
                medianInitialEntryUsd: 750,
                typicalInitialEntrySize: { p25: 625, p75: 875 },
                totalPositionDepositsUsd: 1500,
                totalPositionWithdrawalsUsd: 1650,
                totalClaimedFeesUsd: 30,
            },
            profitability: {
                positionWinRate: 100,
                profitFactor: null,
                profitFactorStatus: "UNBOUNDED_NO_LOSSES",
                sampleTotalPnlUsd: 150,
                averagePnlUsd: 75,
                medianPnlUsd: 75,
                bestWinUsd: 100,
                worstLossUsd: null,
                averageHoldingPnlPct: 10,
                medianHoldingPnlPct: 10,
            },
            riskAndConsistency: {
                cvar10PnlPct: 10,
                sampleRealizedPnlDrawdown: { maxDrawdownUsd: 0, maxDrawdownPct: 0 },
                maxConsecutiveLosses: 0,
                weeklyRealizedPnl: [],
                pnlConcentration: { top1PctOfPositivePnl: 66.67, top5PctOfPositivePnl: 100 },
            },
            tradingBehavior: {
                averageHoldingTimeSeconds: 432000,
                medianHoldingTimeSeconds: 432000,
                holdingTimeDistribution: [],
                observedEntriesPerDay: 0.2,
                entryActivityLabel: "Observed entries",
                entryActivityByHourWib: [],
                entryActivityByWeekdayWib: [],
                activeEntryDays: 2,
                openingTimeCoverage: {
                    analyzedPositions: 2,
                    openedAtObservations: 2,
                    coveragePct: 100,
                },
                positionSizeByPair: [],
            },
            pairBreakdown: [],
            poolBreakdown: [],
        };
        fs.writeFileSync(path.join(MULTI_METRICS_DIR, "30D.json"), JSON.stringify(mockMultiMetrics));
        // Start local control server on TEST_PORT
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

        // Clean up test data files
        try {
            fs.rmSync(path.join(ROOT, "data/analytics/positions", TEST_WALLET), { recursive: true, force: true });
            fs.rmSync(path.join(ROOT, "data/analytics/metrics", TEST_WALLET), { recursive: true, force: true });
            fs.rmSync(path.join(ROOT, "data/analytics/bundles", TEST_WALLET), { recursive: true, force: true });
            fs.rmSync(MULTI_POSITIONS_DIR, { recursive: true, force: true });
            fs.rmSync(MULTI_METRICS_DIR, { recursive: true, force: true });
            fs.rmSync(path.join(ROOT, "data/analytics/bundles", TEST_WALLET_MULTI), { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it("1. Validation: Rejects invalid Solana wallet addresses with 400", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=invalid-wallet&period=30D`);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.match(data.error, /Invalid Solana wallet address/i);
    });

    it("2. Validation: Rejects invalid analytics periods with 400", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET}&period=7D`);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.match(data.error, /Invalid period/i);
    });

    it("3. Retrieval: Returns 404 for missing wallet or period", async () => {
        // Query non-existent period (90D)
        const res = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET}&period=90D`);
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.match(data.error, /Metrics not found/i);

        // Query non-existent wallet
        const resAlt = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET_ALT}&period=30D`);
        assert.equal(resAlt.status, 404);
    });

    it("4. Period isolation: Retrieves existing 30D metrics without cross-period leakage", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET}&period=30D`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.wallet, TEST_WALLET);
        assert.equal(data.period, "30D");
        assert.equal(data.capital.totalPositionDepositsUsd, 1500);
        assert.equal(data.profitability.sampleTotalPnlUsd, 200);
        assert.equal(data.profitability.profitFactorStatus, "UNBOUNDED_NO_LOSSES");
    });

    it("5. Positions: Returns compact position records with lifecycleMeta for list view", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/positions?wallet=${TEST_WALLET}&period=30D`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(Array.isArray(data.positions), true);
        assert.equal(data.positions.length, 1);
        const pos = data.positions[0];
        assert.equal(pos.positionId, "pos-123456");
        assert.equal(pos.pairName, "SOL-USDC");
        assert.equal(pos.initialEntryUsd, 1500);
        assert.equal(pos.pnlUsd, 200);
        assert.equal(pos.winLoss, "WIN");
        // Compact list should NOT have the raw lifecycle events array
        assert.equal(pos.lifecycle, undefined);
        assert.equal(pos.lifecycleMeta.eventCount, 2);
        assert.equal(pos.lifecycleMeta.openingEventObserved, true);
    });

    it("6. Position Detail: Returns full lifecycle details on demand", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/position-detail?wallet=${TEST_WALLET}&period=30D&positionId=pos-123456`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.position);
        assert.equal(data.position.positionId, "pos-123456");
        assert.ok(data.position.lifecycle);
        assert.equal(Array.isArray(data.position.lifecycle.events), true);
        assert.equal(data.position.lifecycle.events.length, 1);
        assert.equal(data.position.lifecycle.events[0].rawType, "POSITION_OPEN");

        // Non-existent position ID returns 404
        const resNotFound = await fetch(`${BASE_URL}/api/position-analytics/position-detail?wallet=${TEST_WALLET}&period=30D&positionId=unknown-pos`);
        assert.equal(resNotFound.status, 404);
    });

    it("7. Status: Reports valid status and file availability for existing artifacts", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/status?wallet=${TEST_WALLET}&period=30D`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.wallet, TEST_WALLET);
        assert.equal(data.period, "30D");
        assert.equal(data.hasDataset, true);
        assert.equal(data.hasMetrics, true);
        assert.equal(data.status, "completed");
        assert.ok(data.lastAnalyzedAt);
    });

    it("8. Stop: Returns 409 when stopping non-running analysis", async () => {
        const res = await fetch(`${BASE_URL}/api/position-analytics/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet: TEST_WALLET_ALT }),
        });
        assert.equal(res.status, 409);
        const data = await res.json();
        assert.match(data.error, /No active position analysis/i);
    });

    it("9. Position Detail Identity: Disambiguates by poolAddress + positionId, returns fetchedAt", async () => {
        // Query positions list and verify fetchedAt version metadata is returned
        const resPositions = await fetch(`${BASE_URL}/api/position-analytics/positions?wallet=${TEST_WALLET_MULTI}&period=30D`);
        assert.equal(resPositions.status, 200);
        const posList = await resPositions.json();
        assert.equal(posList.fetchedAt, "2026-03-15T10:00:00.000Z");
        assert.equal(posList.positions.length, 2);

        // Disambiguate position with pool-alpha
        const resAlpha = await fetch(
            `${BASE_URL}/api/position-analytics/position-detail?wallet=${TEST_WALLET_MULTI}&period=30D&positionId=shared-pos-999&poolAddress=pool-alpha`
        );
        assert.equal(resAlpha.status, 200);
        const dataAlpha = await resAlpha.json();
        assert.equal(dataAlpha.position.positionId, "shared-pos-999");
        assert.equal(dataAlpha.position.poolAddress, "pool-alpha");
        assert.equal(dataAlpha.position.pairName, "SOL-USDC");
        assert.equal(dataAlpha.position.pnlUsd, 100);

        // Disambiguate position with pool-beta
        const resBeta = await fetch(
            `${BASE_URL}/api/position-analytics/position-detail?wallet=${TEST_WALLET_MULTI}&period=30D&positionId=shared-pos-999&poolAddress=pool-beta`
        );
        assert.equal(resBeta.status, 200);
        const dataBeta = await resBeta.json();
        assert.equal(dataBeta.position.positionId, "shared-pos-999");
        assert.equal(dataBeta.position.poolAddress, "pool-beta");
        assert.equal(dataBeta.position.pairName, "RAY-USDC");
        assert.equal(dataBeta.position.pnlUsd, 50);

        // Mismatched poolAddress for the positionId returns 404
        const resMismatched = await fetch(
            `${BASE_URL}/api/position-analytics/position-detail?wallet=${TEST_WALLET_MULTI}&period=30D&positionId=shared-pos-999&poolAddress=pool-unknown`
        );
        assert.equal(resMismatched.status, 404);
    });

    it("10. Atomic Refresh CLI: build-position-metrics supports staging directory parameters", async () => {
        const stagingDir = path.join(ROOT, "data/analytics/.staging-test-cli");
        const stagingPos = path.join(stagingDir, "positions");
        const stagingMet = path.join(stagingDir, "metrics");

        try {
            fs.mkdirSync(path.join(stagingPos, TEST_WALLET_MULTI), { recursive: true });
            fs.copyFileSync(
                path.join(MULTI_POSITIONS_DIR, "30D.json"),
                path.join(stagingPos, TEST_WALLET_MULTI, "30D.json")
            );

            // Execute build-position-metrics CLI targeting staging directory
            const { promise, resolve, reject } = Promise.withResolvers<number>();
            const child = spawn(
                process.execPath,
                [
                    "--experimental-strip-types",
                    "scripts/analytics/build-position-metrics.ts",
                    "--wallet", TEST_WALLET_MULTI,
                    "--period", "30D",
                    "--positions-base-dir", stagingPos,
                    "--metrics-base-dir", stagingMet,
                    "--force",
                ],
                { cwd: ROOT, stdio: "ignore" }
            );
            child.on("exit", (code) => resolve(code ?? 1));
            child.on("error", reject);

            const exitCode = await promise;
            assert.equal(exitCode, 0);

            // Output written to staged directory
            const stagedOutput = path.join(stagingMet, TEST_WALLET_MULTI, "30D.json");
            assert.equal(fs.existsSync(stagedOutput), true);
            const generated = JSON.parse(fs.readFileSync(stagedOutput, "utf8"));
            assert.equal(generated.wallet, TEST_WALLET_MULTI);
            assert.equal(generated.profitability.sampleTotalPnlUsd, 150);

            // Canonical files remained completely untouched
            const canonicalMetrics = JSON.parse(fs.readFileSync(path.join(MULTI_METRICS_DIR, "30D.json"), "utf8"));
            assert.equal(canonicalMetrics.generatedAt, "2026-03-15T10:00:05.000Z");
        } finally {
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
        }
    });

    it("11. Atomic Refresh: Failed or interrupted refresh preserves last successful dataset+metrics pair", async () => {
        const canonicalPosPath = path.join(MULTI_POSITIONS_DIR, "30D.json");
        const canonicalMetPath = path.join(MULTI_METRICS_DIR, "30D.json");

        const originalPosRaw = fs.readFileSync(canonicalPosPath, "utf8");
        const originalMetRaw = fs.readFileSync(canonicalMetPath, "utf8");
        const originalPos = JSON.parse(originalPosRaw);
        const originalMet = JSON.parse(originalMetRaw);

        // Verify initial state is consistent
        assert.equal(originalPos.fetchedAt, originalMet.sourceDatasetFetchedAt);

        // Simulate a staged refresh that is interrupted before Stage 2 completes:
        // Staged Step 1 writes a new dataset (V2), but fails before Stage 2 can compute metrics.
        const stagingDir = path.join(ROOT, "data/analytics/.staging", `test-interrupted-${Date.now()}`);
        const stagingPos = path.join(stagingDir, "positions", TEST_WALLET_MULTI);
        fs.mkdirSync(stagingPos, { recursive: true });

        const v2Dataset = {
            ...originalPos,
            fetchedAt: "2026-03-20T12:00:00.000Z",
            positions: [],
        };
        fs.writeFileSync(path.join(stagingPos, "30D.json"), JSON.stringify(v2Dataset));

        // Failure occurs before Stage 2 / promotion: staging is cleaned up
        fs.rmSync(stagingDir, { recursive: true, force: true });

        // Assert canonical dataset and metrics STILL match the original successful pair
        const currentPos = JSON.parse(fs.readFileSync(canonicalPosPath, "utf8"));
        const currentMet = JSON.parse(fs.readFileSync(canonicalMetPath, "utf8"));

        assert.equal(currentPos.fetchedAt, "2026-03-15T10:00:00.000Z");
        assert.equal(currentMet.sourceDatasetFetchedAt, "2026-03-15T10:00:00.000Z");
        assert.equal(currentPos.fetchedAt, currentMet.sourceDatasetFetchedAt);
        // No mismatched Step 1 positions and Step 2 metrics are exposed
        assert.equal(currentPos.positions.length, 2);
        assert.equal(currentMet.profitability.sampleTotalPnlUsd, 150);

        // Query API during/after failed refresh to verify consistent data is returned
        const resPos = await fetch(`${BASE_URL}/api/position-analytics/positions?wallet=${TEST_WALLET_MULTI}&period=30D`);
        const resMet = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET_MULTI}&period=30D`);
        assert.equal(resPos.status, 200);
        assert.equal(resMet.status, 200);

        const apiPos = await resPos.json();
        const apiMet = await resMet.json();
        assert.equal(apiPos.fetchedAt, apiMet.sourceDatasetFetchedAt);
    });

    it("12. Atomic Promotion: Executes real single-commit publication and handles failure before commit", async () => {
        const stagingDir = path.join(ROOT, "data/analytics/.staging", `test-promote-${Date.now()}`);
        const stagingPosDir = path.join(stagingDir, "positions", TEST_WALLET_MULTI);
        const stagingMetDir = path.join(stagingDir, "metrics", TEST_WALLET_MULTI);
        fs.mkdirSync(stagingPosDir, { recursive: true });
        fs.mkdirSync(stagingMetDir, { recursive: true });

        try {
            const stagedV2Positions = {
                schemaVersion: "v1" as const,
                wallet: TEST_WALLET_MULTI,
                period: "30D" as const,
                dataSource: "fabriq" as const,
                fetchedAt: "2026-03-25T18:00:00.000Z",
                timeframe: { requestedPeriod: "30D" as const, effectiveStart: null, effectiveEnd: null },
                sourceCoverage: { status: "COMPLETE" as const, totalPositionsFound: 1, totalEligiblePositions: 1 },
                sampling: { totalEligiblePositions: 1, analyzedPositions: 1, excludedPositions: 0, coveragePct: 100 },
                dataQuality: { validClosedPositions: 1, initialEntriesVerified: 1, initialEntryCoveragePct: 100 },
                positions: [
                    {
                        wallet: TEST_WALLET_MULTI,
                        positionId: "promoted-pos-1",
                        poolAddress: "pool-gamma",
                        pairName: "SOL-USDT",
                        closedAt: "2026-03-24T12:00:00.000Z",
                        pnlUsd: 350,
                        winLoss: "WIN" as const,
                        lifecycleMeta: { openingEventObserved: true, closingEventObserved: true, eventCount: 1 },
                    },
                ],
            };
            const stagedV2Metrics = {
                schemaVersion: "v1" as const,
                wallet: TEST_WALLET_MULTI,
                period: "30D" as const,
                generatedAt: "2026-03-25T18:00:05.000Z",
                sourceDatasetFetchedAt: "2026-03-25T18:00:00.000Z",
                capital: { totalPositionDepositsUsd: 2000 },
                profitability: { sampleTotalPnlUsd: 350, positionWinRate: 100 },
            };

            fs.writeFileSync(path.join(stagingPosDir, "30D.json"), JSON.stringify(stagedV2Positions));
            fs.writeFileSync(path.join(stagingMetDir, "30D.json"), JSON.stringify(stagedV2Metrics));

            // --- Case 1: Injected failure before commit ---
            // Executes REAL publication implementation with injected pre-commit crash
            const preCommitErr = /Simulated I\/O failure before atomic rename commit/;
            assert.throws(() => {
                publishPositionAnalyticsPair({
                    wallet: TEST_WALLET_MULTI,
                    period: "30D",
                    dataset: stagedV2Positions as any,
                    metrics: stagedV2Metrics as any,
                    bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
                    _beforeCommitHook: () => {
                        throw new Error("Simulated I/O failure before atomic rename commit");
                    },
                });
            }, preCommitErr);

            // Assert that NO bundle was published
            assert.equal(fs.existsSync(MULTI_BUNDLE_PATH), false);

            // Query API to verify original V1 dataset+metrics pair remains served in lockstep
            const resPosPre = await fetch(`${BASE_URL}/api/position-analytics/positions?wallet=${TEST_WALLET_MULTI}&period=30D`);
            const resMetPre = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET_MULTI}&period=30D`);
            assert.equal(resPosPre.status, 200);
            assert.equal(resMetPre.status, 200);
            const posDataPre = await resPosPre.json();
            const metDataPre = await resMetPre.json();
            assert.equal(posDataPre.fetchedAt, "2026-03-15T10:00:00.000Z");
            assert.equal(metDataPre.sourceDatasetFetchedAt, "2026-03-15T10:00:00.000Z");
            assert.equal(posDataPre.fetchedAt, metDataPre.sourceDatasetFetchedAt);

            // --- Case 2: Invariant mismatch rejection ---
            // Reject publication when metrics.sourceDatasetFetchedAt !== positions.fetchedAt
            const mismatchedMetrics = {
                ...stagedV2Metrics,
                sourceDatasetFetchedAt: "2026-03-99T99:99:99.000Z",
            };
            const invariantErr = /Publication invariant violation/;
            assert.throws(() => {
                publishPositionAnalyticsPair({
                    wallet: TEST_WALLET_MULTI,
                    period: "30D",
                    dataset: stagedV2Positions as any,
                    metrics: mismatchedMetrics as any,
                    bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
                });
            }, invariantErr);
            assert.equal(fs.existsSync(MULTI_BUNDLE_PATH), false);

            // --- Case 3: Successful real single-commit publication ---
            const publishResult = publishPositionAnalyticsPair({
                wallet: TEST_WALLET_MULTI,
                period: "30D",
                dataset: stagedV2Positions as any,
                metrics: stagedV2Metrics as any,
                bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            });

            assert.equal(fs.existsSync(MULTI_BUNDLE_PATH), true);
            assert.equal(publishResult.bundlePath, MULTI_BUNDLE_PATH);

            // Query both endpoints and verify they immediately return the promoted V2 pair in lockstep
            const resPos = await fetch(`${BASE_URL}/api/position-analytics/positions?wallet=${TEST_WALLET_MULTI}&period=30D`);
            const resMet = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${TEST_WALLET_MULTI}&period=30D`);
            assert.equal(resPos.status, 200);
            assert.equal(resMet.status, 200);

            const posData = await resPos.json();
            const metData = await resMet.json();
            assert.equal(posData.fetchedAt, "2026-03-25T18:00:00.000Z");
            assert.equal(metData.sourceDatasetFetchedAt, "2026-03-25T18:00:00.000Z");
            assert.equal(posData.fetchedAt, metData.sourceDatasetFetchedAt);
            assert.equal(posData.positions[0].positionId, "promoted-pos-1");
            assert.equal(posData.positions[0].poolAddress, "pool-gamma");
            assert.equal(metData.profitability.sampleTotalPnlUsd, 350);
        } finally {
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
            try { fs.rmSync(MULTI_BUNDLE_PATH, { force: true }); } catch {}
        }
    });

    it("13. Mismatched Legacy Snapshot Rejection: Refuses to serve mismatched legacy versions", async () => {
        const mismatchWallet = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
        const misPosDir = path.join(ROOT, "data/analytics/positions", mismatchWallet);
        const misMetDir = path.join(ROOT, "data/analytics/metrics", mismatchWallet);
        fs.mkdirSync(misPosDir, { recursive: true });
        fs.mkdirSync(misMetDir, { recursive: true });

        try {
            const legacyPos = {
                schemaVersion: "v1",
                wallet: mismatchWallet,
                period: "30D",
                fetchedAt: "2026-03-01T10:00:00.000Z",
                positions: [],
            };
            const legacyMet = {
                schemaVersion: "v1",
                wallet: mismatchWallet,
                period: "30D",
                sourceDatasetFetchedAt: "2026-03-02T12:00:00.000Z",
                capital: {},
                profitability: {},
            };
            fs.writeFileSync(path.join(misPosDir, "30D.json"), JSON.stringify(legacyPos));
            fs.writeFileSync(path.join(misMetDir, "30D.json"), JSON.stringify(legacyMet));

            const resPos = await fetch(`${BASE_URL}/api/position-analytics/positions?wallet=${mismatchWallet}&period=30D`);
            const resMet = await fetch(`${BASE_URL}/api/position-analytics/metrics?wallet=${mismatchWallet}&period=30D`);
            assert.equal(resPos.status, 404);
            assert.equal(resMet.status, 404);
        } finally {
            try {
                fs.rmSync(misPosDir, { recursive: true, force: true });
                fs.rmSync(misMetDir, { recursive: true, force: true });
            } catch {}
        }
    });
});
