import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const TEST_PORT = 8991;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const TEST_WALLET_ALT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const ROOT = process.cwd();
const POSITIONS_TEST_DIR = path.join(ROOT, "data/analytics/positions", TEST_WALLET);
const METRICS_TEST_DIR = path.join(ROOT, "data/analytics/metrics", TEST_WALLET);

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
});
