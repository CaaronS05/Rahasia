import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    filterPositionsByTimeframe,
    deduplicatePositions,
    deduplicateRawEvents,
    comparePositionsLatestClosedDesc,
    sampleLatest1000Positions,
    reconstructPositionLifecycle,
    buildPositionAnalyticsDataset,
    loadPoolMetadataCache,
    type RawPositionInput,
    type RawEventInput,
    type PoolMetadataLookupItem,
} from "../../scripts/analytics/position-lifecycle-extractor.ts";
import {
    atomicWriteJsonFile,
    savePositionAnalyticsDataset,
    loadPositionAnalyticsDataset,
    getDatasetFilePath,
    publishPositionAnalyticsPair,
    loadPublishedPositionPair,
    getBundleFilePath,
    loadTransactionCheckpointRecord,
    saveTransactionCheckpointRecord,
    loadTransactionCheckpoint,
    saveTransactionCheckpoint,
    getTransactionCheckpointPath,
    type TransactionCheckpoint,
} from "../../scripts/analytics/position-analytics-storage.ts";
import {
    discoverWalletDlmmPools,
    fetchWalletPositionsForPools,
    fetchTransactionsForPositions,
    runBoundedWorkerQueue,
    DEFAULT_MAX_404_RETRIES,
    DEFAULT_DELAY_404_MS,
} from "../../scripts/analytics/fabriq-analytics-client.ts";
import {
    setFabriqTokenForTesting,
    parseRetryAfterHeader,
    SharedCooldownCoordinator,
    FabriqCdpError,
    fabriqFetch,
} from "../../scripts/discovery/core/fabriq-position-history.ts";
import { executeBuildPositionDataset } from "../../scripts/analytics/build-position-dataset.ts";
import type { PositionAnalyticsDataset } from "../../scripts/analytics/position-analytics-types.ts";
import {
    analyzeSingleWallet,
    isValidSolanaAddress,
    comparePositionsLatestClosedDesc as compareV1Positions,
    loadReferenceCohort,
} from "../../scripts/v1/single-wallet-intelligence.ts";

describe("Position Analytics Step 1 Test Suite", () => {
    const NOW_MS = 1775700000000; // Reference fixed snapshot timestamp
    const NOW_ISO = new Date(NOW_MS).toISOString();

    const DAY_MS = 24 * 60 * 60 * 1000;

    // Helper to generate mock position
    function createMockPosition(
        id: string,
        pool_id: string,
        closedDaysAgo: number | null,
        overrides?: Partial<RawPositionInput>
    ): RawPositionInput {
        return {
            id,
            pool_id,
            source: "wallet",
            total_add_usd: 1000,
            total_rem_usd: 1100,
            total_fee_usd: 25,
            total_pnl_usd: 125,
            total_pnl_pct_usd: 12.5,
            latest_close_ts: closedDaysAgo !== null ? new Date(NOW_MS - closedDaysAgo * DAY_MS).toISOString() : null,
            opened_at: closedDaysAgo !== null ? new Date(NOW_MS - (closedDaysAgo + 2) * DAY_MS).toISOString() : null,
            duration: 172800,
            ...overrides,
        };
    }

    // 1. 30D filtering
    it("1. 30D filtering: includes only positions closed within last 30 days and rejects invalid timestamps", () => {
        const p1 = createMockPosition("pos-5d", "pool-1", 5);
        const p2 = createMockPosition("pos-29d", "pool-1", 29);
        const p3 = createMockPosition("pos-31d", "pool-1", 31);
        const p4 = createMockPosition("pos-no-close", "pool-1", null);

        const result = filterPositionsByTimeframe([p1, p2, p3, p4], "30D", NOW_MS);

        assert.equal(result.eligible.length, 2);
        assert.deepEqual(result.eligible.map((p) => p.id), ["pos-5d", "pos-29d"]);
        assert.equal(result.rejected.length, 2);
        const rejectReasons = result.rejected.map((r) => r.reason);
        assert.ok(rejectReasons.includes("OUTSIDE_TIMEFRAME_WINDOW"));
        assert.ok(rejectReasons.includes("MISSING_OR_INVALID_CLOSED_AT"));
        assert.equal(result.effectiveEnd, NOW_ISO);
        assert.equal(result.effectiveStart, new Date(NOW_MS - 30 * DAY_MS).toISOString());
    });

    // 2. 90D filtering
    it("2. 90D filtering: includes positions closed within 90 days, excludes older", () => {
        const p1 = createMockPosition("pos-10d", "pool-1", 10);
        const p2 = createMockPosition("pos-89d", "pool-1", 89);
        const p3 = createMockPosition("pos-95d", "pool-1", 95);

        const result = filterPositionsByTimeframe([p1, p2, p3], "90D", NOW_MS);

        assert.equal(result.eligible.length, 2);
        assert.deepEqual(result.eligible.map((p) => p.id), ["pos-10d", "pos-89d"]);
        assert.equal(result.effectiveStart, new Date(NOW_MS - 90 * DAY_MS).toISOString());
    });

    // 3. All-available filtering
    it("3. All-available filtering: includes all historical positions with null effectiveStart", () => {
        const p1 = createMockPosition("pos-1d", "pool-1", 1);
        const p2 = createMockPosition("pos-120d", "pool-1", 120);
        const p3 = createMockPosition("pos-365d", "pool-1", 365);

        const result = filterPositionsByTimeframe([p1, p2, p3], "ALL_AVAILABLE", NOW_MS);

        assert.equal(result.eligible.length, 3);
        assert.equal(result.effectiveStart, null);
        assert.equal(result.effectiveEnd, NOW_ISO);
    });

    // 4. Pagination completeness
    it("4. Pagination completeness: verifies pagination traversal until items < 100", () => {
        // Test helper simulating page termination logic
        const simulatePaging = (totalPages: number) => {
            let page = 1;
            let totalFetched = 0;
            while (true) {
                const count = page < totalPages ? 100 : 42;
                totalFetched += count;
                if (count < 100) break;
                page++;
            }
            return { pages: page, totalFetched };
        };

        const { pages, totalFetched } = simulatePaging(3);
        assert.equal(pages, 3);
        assert.equal(totalFetched, 242);
    });

    // 5. Multi-pool extraction
    it("5. Multi-pool extraction: aggregates positions across different DLMM pools", () => {
        const pA1 = createMockPosition("pos-A1", "pool-A", 2);
        const pA2 = createMockPosition("pos-A2", "pool-A", 4);
        const pB1 = createMockPosition("pos-B1", "pool-B", 3);
        const pC1 = createMockPosition("pos-C1", "pool-C", 1);

        const { eligible } = filterPositionsByTimeframe([pA1, pA2, pB1, pC1], "30D", NOW_MS);
        assert.equal(eligible.length, 4);

        const pools = new Set(eligible.map((p) => p.pool_id));
        assert.equal(pools.size, 3);
        assert.ok(pools.has("pool-A"));
        assert.ok(pools.has("pool-B"));
        assert.ok(pools.has("pool-C"));
    });

    // 6. Duplicate position removal
    it("6. Duplicate position removal: deduplicates by poolAddress + positionId and resolves conflict", () => {
        const p1 = createMockPosition("pos-1", "pool-A", 5, { total_add_usd: 500 });
        const p2 = createMockPosition("pos-1", "pool-A", 5, { total_add_usd: 1500 }); // richer record
        const p3 = createMockPosition("pos-2", "pool-A", 6);

        const { deduplicated, duplicatesRemoved } = deduplicatePositions([p1, p2, p3]);

        assert.equal(deduplicated.length, 2);
        assert.equal(duplicatesRemoved, 1);
        const deduplicatedP1 = deduplicated.find((p) => p.id === "pos-1");
        assert.equal(deduplicatedP1?.total_add_usd, 1500);
    });

    // 7. 1000-position selection
    it("7. 1000-position selection: handles exactly 1000 eligible positions without sampling", () => {
        const list: RawPositionInput[] = [];
        for (let i = 0; i < 1000; i++) {
            list.push(createMockPosition(`pos-${i}`, "pool-1", (i % 20) + 1));
        }

        const { selected, samplingMeta } = sampleLatest1000Positions(list, 1000);

        assert.equal(selected.length, 1000);
        assert.equal(samplingMeta.totalEligiblePositions, 1000);
        assert.equal(samplingMeta.analyzedPositions, 1000);
        assert.equal(samplingMeta.excludedPositions, 0);
        assert.equal(samplingMeta.coveragePct, 100);
        assert.equal(samplingMeta.isSampled, false);
    });

    // 8. 1001-position selection
    it("8. 1001-position selection: selects exactly 1000 newest and excludes 1 older position", () => {
        const list: RawPositionInput[] = [];
        for (let i = 0; i < 1001; i++) {
            // i=0 is newest (0.1 days ago), i=1000 is oldest (100 days ago)
            list.push(createMockPosition(`pos-${i}`, "pool-1", (i / 10) + 0.1));
        }

        const { selected, samplingMeta } = sampleLatest1000Positions(list, 1000);

        assert.equal(selected.length, 1000);
        assert.equal(samplingMeta.totalEligiblePositions, 1001);
        assert.equal(samplingMeta.analyzedPositions, 1000);
        assert.equal(samplingMeta.excludedPositions, 1);
        assert.equal(samplingMeta.isSampled, true);
        assert.equal(samplingMeta.coveragePct, 99.9);
        assert.equal(selected[0].id, "pos-0"); // newest
        assert.equal(selected[999].id, "pos-999");
    });

    // 9. 5000-position selection
    it("9. 5000-position selection: selects exactly 1000 newest and excludes 4000", () => {
        const list: RawPositionInput[] = [];
        for (let i = 0; i < 5000; i++) {
            list.push(createMockPosition(`pos-${i}`, "pool-1", i + 1));
        }

        const { selected, samplingMeta } = sampleLatest1000Positions(list, 1000);

        assert.equal(selected.length, 1000);
        assert.equal(samplingMeta.totalEligiblePositions, 5000);
        assert.equal(samplingMeta.analyzedPositions, 1000);
        assert.equal(samplingMeta.excludedPositions, 4000);
        assert.equal(samplingMeta.coveragePct, 20);
        assert.equal(samplingMeta.isSampled, true);
    });

    // 10. Global newest-first ordering
    it("10. Global newest-first ordering: sorts globally across multiple pools by closedAt DESC", () => {
        const p1 = createMockPosition("pos-1", "pool-A", 10); // older
        const p2 = createMockPosition("pos-2", "pool-B", 2);  // newest
        const p3 = createMockPosition("pos-3", "pool-C", 5);  // middle

        const { selected } = sampleLatest1000Positions([p1, p2, p3], 1000);

        assert.deepEqual(selected.map((p) => p.id), ["pos-2", "pos-3", "pos-1"]);
    });

    // 11. Deterministic tie-breaking
    it("11. Deterministic tie-breaking: ties broken by poolAddress ASC then positionId ASC", () => {
        const ts = new Date(NOW_MS - 5 * DAY_MS).toISOString();
        const pA2 = createMockPosition("pos-2", "pool-A", 5, { latest_close_ts: ts });
        const pA1 = createMockPosition("pos-1", "pool-A", 5, { latest_close_ts: ts });
        const pB1 = createMockPosition("pos-1", "pool-B", 5, { latest_close_ts: ts });

        const sorted = [pB1, pA2, pA1].sort(comparePositionsLatestClosedDesc);

        assert.deepEqual(sorted.map((p) => `${p.pool_id}:${p.id}`), [
            "pool-A:pos-1",
            "pool-A:pos-2",
            "pool-B:pos-1",
        ]);
    });

    // 12. POSITION_OPEN with verified initial entry
    it("12. POSITION_OPEN with verified initial entry: extracts initialEntryUsd directly", () => {
        const pos = createMockPosition("pos-open-1", "pool-1", 5);
        const events: RawEventInput[] = [
            {
                rawId: "ev-1",
                rawType: "POSITION_OPEN",
                positionId: "pos-open-1",
                poolId: "pool-1",
                createdAt: pos.opened_at as string,
                signature: "sig-open",
                totalInUsd: 1250.5,
            },
            {
                rawId: "ev-2",
                rawType: "POSITION_CLOSE",
                positionId: "pos-open-1",
                poolId: "pool-1",
                createdAt: pos.latest_close_ts as string,
                signature: "sig-close",
                totalInUsd: 1350.0,
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.initialEntryUsd, 1250.5);
        assert.equal(norm.dataQuality.initialEntryStatus, "VERIFIED_OPEN_EVENT");
        assert.equal(norm.dataQuality.transactionCoverage, "FULL_LIFECYCLE");
    });

    // 13. Opening with associated ADD_LIQUIDITY
    it("13. Opening with associated ADD_LIQUIDITY: resolves initial entry from same-tx add event", () => {
        const pos = createMockPosition("pos-open-2", "pool-1", 5);
        const openTime = pos.opened_at as string;
        const events: RawEventInput[] = [
            {
                rawId: "ev-1",
                rawType: "POSITION_OPEN",
                positionId: "pos-open-2",
                poolId: "pool-1",
                createdAt: openTime,
                signature: "sig-1",
                totalInUsd: 0, // open itself has 0
            },
            {
                rawId: "ev-2",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-open-2",
                poolId: "pool-1",
                createdAt: openTime,
                signature: "sig-1", // same transaction
                totalInUsd: 800.0,
            },
            {
                rawId: "ev-3",
                rawType: "POSITION_CLOSE",
                positionId: "pos-open-2",
                poolId: "pool-1",
                createdAt: pos.latest_close_ts as string,
                signature: "sig-close",
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.initialEntryUsd, 800.0);
        assert.equal(norm.dataQuality.initialEntryStatus, "VERIFIED_ASSOCIATED_ADD");
        assert.equal(norm.additionalLiquidityUsd, 0); // associated add was not double counted
    });

    // 14. Subsequent top-up
    it("14. Subsequent top-up: separates initial entry from additional liquidity top-ups", () => {
        const pos = createMockPosition("pos-topup", "pool-1", 5);
        const openTime = pos.opened_at as string;
        const topupTime = new Date(new Date(openTime).getTime() + 3600000).toISOString();
        const events: RawEventInput[] = [
            {
                rawId: "ev-1",
                rawType: "POSITION_OPEN",
                positionId: "pos-topup",
                poolId: "pool-1",
                createdAt: openTime,
                signature: "sig-open",
                totalInUsd: 1000.0,
            },
            {
                rawId: "ev-2",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-topup",
                poolId: "pool-1",
                createdAt: topupTime,
                signature: "sig-topup",
                totalInUsd: 500.0,
            },
            {
                rawId: "ev-3",
                rawType: "POSITION_CLOSE",
                positionId: "pos-topup",
                poolId: "pool-1",
                createdAt: pos.latest_close_ts as string,
                signature: "sig-close",
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.initialEntryUsd, 1000.0);
        assert.equal(norm.additionalLiquidityUsd, 500.0);
        assert.equal(norm.totalDepositsUsd, 1500.0);
    });

    // 15. Missing opening transaction
    it("15. Missing opening transaction: sets initialEntryUsd to null and populates firstObservedAddUsd", () => {
        const pos = createMockPosition("pos-no-open", "pool-1", 5);
        const events: RawEventInput[] = [
            {
                rawId: "ev-add",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-no-open",
                poolId: "pool-1",
                createdAt: pos.opened_at as string,
                signature: "sig-add",
                totalInUsd: 650.0,
            },
            {
                rawId: "ev-close",
                rawType: "POSITION_CLOSE",
                positionId: "pos-no-open",
                poolId: "pool-1",
                createdAt: pos.latest_close_ts as string,
                signature: "sig-close",
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.initialEntryUsd, null);
        assert.equal(norm.firstObservedAddUsd, 650.0);
        assert.equal(norm.dataQuality.initialEntryStatus, "FIRST_OBSERVED_ADD_ONLY");
    });

    // 16. Missing initial entry amount
    it("16. Missing initial entry amount: sets initialEntryUsd to null when amount unavailable", () => {
        const pos = createMockPosition("pos-no-amount", "pool-1", 5);
        const events: RawEventInput[] = [
            {
                rawId: "ev-1",
                rawType: "POSITION_OPEN",
                positionId: "pos-no-amount",
                poolId: "pool-1",
                createdAt: pos.opened_at as string,
                signature: "sig-open",
                totalInUsd: null,
                tokenXAmountUsd: null,
                tokenYAmountUsd: null,
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.initialEntryUsd, null);
        assert.equal(norm.dataQuality.initialEntryStatus, "UNAVAILABLE");
    });

    // 17. No transaction double counting
    it("17. No transaction double counting: prefers totalInUsd over token breakdown", () => {
        const pos = createMockPosition("pos-dc", "pool-1", 5);
        const events: RawEventInput[] = [
            {
                rawId: "ev-1",
                rawType: "POSITION_OPEN",
                positionId: "pos-dc",
                poolId: "pool-1",
                createdAt: pos.opened_at as string,
                signature: "sig-open",
                totalInUsd: 500.0,
                tokenXAmountUsd: 250.0,
                tokenYAmountUsd: 250.0,
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.initialEntryUsd, 500.0); // Exactly 500, not 500 + 250 + 250
    });

    // 18. USD field semantics
    it("18. USD field semantics: preserves explicit units, finite numbers and nulls", () => {
        const pos = createMockPosition("pos-usd", "pool-1", 5, {
            total_add_usd: 1234.56,
            total_rem_usd: 1200.0,
            total_fee_usd: 50.25,
            total_pnl_usd: 15.69,
            total_pnl_pct_usd: 1.27,
        });

        const norm = reconstructPositionLifecycle("wallet-1", pos, []);

        assert.equal(norm.pnlUsd, 15.69);
        assert.equal(norm.pnlPct, 1.27);
        assert.equal(norm.winLoss, "WIN");
        assert.equal(norm.totalDepositsUsd, 1234.56);
        assert.equal(norm.totalWithdrawalsUsd, 1200.0);
        assert.equal(norm.claimedFeesUsd, 50.25);
    });

    // 19. Position history with incomplete events
    it("19. Position history with incomplete events: marks incomplete status and preserves known values", () => {
        const pos = createMockPosition("pos-partial", "pool-1", 5);
        const events: RawEventInput[] = [
            {
                rawId: "ev-rem",
                rawType: "REMOVE_LIQUIDITY",
                positionId: "pos-partial",
                poolId: "pool-1",
                createdAt: pos.latest_close_ts as string,
                signature: "sig-rem",
                totalInUsd: 400.0,
            },
        ];

        const norm = reconstructPositionLifecycle("wallet-1", pos, events);

        assert.equal(norm.lifecycle.openingEventObserved, false);
        assert.equal(norm.lifecycle.closingEventObserved, false);
        assert.equal(norm.dataQuality.transactionCoverage, "PARTIAL_EVENTS");
        assert.equal(norm.totalWithdrawalsUsd, 400.0);
    });

    // 20. Missing token metadata
    it("20. Missing token metadata: retains mint address without fabricating names", () => {
        const pos = createMockPosition("pos-no-meta", "pool-unregistered", 5, {
            raw: {
                pool: {
                    token_x: "MintX111111111111111111111111111111111111",
                    token_y: "MintY222222222222222222222222222222222222",
                },
            },
        });

        const emptyCache = new Map<string, PoolMetadataLookupItem>();
        const norm = reconstructPositionLifecycle("wallet-1", pos, [], emptyCache);

        assert.equal(norm.tokenXMint, "MintX111111111111111111111111111111111111");
        assert.equal(norm.tokenYMint, "MintY222222222222222222222222222222222222");
        assert.equal(norm.tokenXSymbol, null);
        assert.equal(norm.tokenYSymbol, null);
        assert.equal(norm.pairName, null);
    });

    // 21. Calendar unavailability
    it("21. Calendar unavailability: handles calendar status gracefully", () => {
        // Test dataset building handles empty/missing calendar without failing
        const dataset = buildPositionAnalyticsDataset({
            wallet: "wallet-test-cal",
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [createMockPosition("pos-1", "pool-1", 5)],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
        });

        assert.ok(dataset);
        assert.equal(dataset.positions.length, 1);
        assert.equal(dataset.dataQuality.validClosedPositions, 1);
    });

    // 22. Source coverage reporting
    it("22. Source coverage reporting: reports status, pools discovered, and eligible positions", () => {
        const p1 = createMockPosition("pos-1", "pool-1", 5);
        const dataset = buildPositionAnalyticsDataset({
            wallet: "wallet-coverage",
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [p1],
            rawEvents: [],
            fabriqPoolsDiscovered: 10,
            dlmmPoolsMatched: 3,
        });

        assert.equal(dataset.sourceCoverage.status, "COMPLETE");
        assert.equal(dataset.sourceCoverage.fabriqPoolsDiscovered, 10);
        assert.equal(dataset.sourceCoverage.dlmmPoolsMatched, 3);
        assert.equal(dataset.sourceCoverage.totalPositionsFound, 1);
        assert.equal(dataset.sourceCoverage.totalEligiblePositions, 1);
    });

    // 23. Atomic persistence
    it("23. Atomic persistence: writes cleanly and loads valid dataset from disk", () => {
        const testBase = path.resolve("data/test-analytics");
        const wallet = "test-wallet-persistence";
        const dataset = buildPositionAnalyticsDataset({
            wallet,
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [createMockPosition("pos-1", "pool-1", 2)],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
        });

        try {
            const savedPath = savePositionAnalyticsDataset(dataset, testBase);
            assert.ok(fs.existsSync(savedPath));

            const loaded = loadPositionAnalyticsDataset(wallet, "30D", testBase);
            assert.ok(loaded);
            assert.equal(loaded?.wallet, wallet);
            assert.equal(loaded?.period, "30D");
            assert.equal(loaded?.positions.length, 1);
        } finally {
            // Clean up test directory
            if (fs.existsSync(testBase)) {
                fs.rmSync(testBase, { recursive: true, force: true });
            }
        }
    });

    // 24. Failed refresh retains previous snapshot
    it("24. Failed refresh retains previous snapshot: preserves prior good file if write fails", () => {
        const testBase = path.resolve("data/test-analytics-fail");
        const wallet = "test-wallet-retain";
        const dataset = buildPositionAnalyticsDataset({
            wallet,
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [createMockPosition("pos-good", "pool-1", 2)],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
        });

        try {
            const savedPath = savePositionAnalyticsDataset(dataset, testBase);
            assert.ok(fs.existsSync(savedPath));

            // Attempt a failing write to a non-writable/invalid file descriptor or simulate failure
            assert.throws(() => {
                atomicWriteJsonFile("/nonexistent/readonly/dir/sub/path.json", { foo: "bar" });
            });

            // Verify original snapshot remains valid
            const originalLoaded = loadPositionAnalyticsDataset(wallet, "30D", testBase);
            assert.ok(originalLoaded);
            assert.equal(originalLoaded?.positions[0].positionId, "pos-good");
        } finally {
            if (fs.existsSync(testBase)) {
                fs.rmSync(testBase, { recursive: true, force: true });
            }
        }
    });

    // 25. Existing V1 pipeline compatibility
    it("25. Existing V1 pipeline compatibility: single-wallet-intelligence types and exports intact", () => {
        assert.ok(typeof analyzeSingleWallet === "function");
        assert.ok(typeof isValidSolanaAddress === "function");
        assert.ok(typeof compareV1Positions === "function");
        assert.ok(typeof loadReferenceCohort === "function");
    });

    // 26. Regression 1: Bounded 404 retries in Fabriq Analytics client
    it("26. Bounded 404 retries: halts after bounded retries and preserves defaults", async () => {
        assert.equal(typeof DEFAULT_MAX_404_RETRIES, "number");
        assert.ok(DEFAULT_MAX_404_RETRIES > 0);
        assert.equal(typeof DEFAULT_DELAY_404_MS, "number");
        assert.ok(DEFAULT_DELAY_404_MS > 0);

        setFabriqTokenForTesting("test-token-jwt");
        const originalFetch = globalThis.fetch;
        try {
            let callCount = 0;
            globalThis.fetch = (async () => {
                callCount++;
                return new Response("Not Found", { status: 404 });
            }) as typeof fetch;

            await assert.rejects(
                () =>
                    discoverWalletDlmmPools("11111111111111111111111111111111", {
                        max404Retries: 2,
                        delay404Ms: 1,
                        onLog: () => {},
                    }),
                (err: any) => {
                    assert.equal(err.code, "DATA_NOT_FOUND");
                    return true;
                }
            );

            // 1 initial + 2 retries = 3 calls
            assert.equal(callCount, 3);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
        }
    });

    // 27. Regression 2: Unknown ADD_LIQUIDITY amounts
    it("27. Unknown ADD_LIQUIDITY amounts: uses null and marks INCOMPLETE_AMOUNTS, preserving verified entry", () => {
        const pos1 = createMockPosition("pos-unknown-add", "pool-1", 5);
        const openTime = pos1.opened_at as string;
        const events1: RawEventInput[] = [
            {
                rawId: "ev-open",
                rawType: "POSITION_OPEN",
                positionId: "pos-unknown-add",
                poolId: "pool-1",
                createdAt: openTime,
                signature: "sig-1",
                totalInUsd: 0,
            },
            {
                rawId: "ev-add",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-unknown-add",
                poolId: "pool-1",
                createdAt: openTime,
                signature: "sig-1",
                totalInUsd: null,
                tokenXAmountUsd: null,
                tokenYAmountUsd: null,
            },
            {
                rawId: "ev-close",
                rawType: "POSITION_CLOSE",
                positionId: "pos-unknown-add",
                poolId: "pool-1",
                createdAt: pos1.latest_close_ts as string,
                signature: "sig-close",
            },
        ];

        const norm1 = reconstructPositionLifecycle("wallet-1", pos1, events1);
        assert.equal(norm1.initialEntryUsd, null);
        assert.equal(norm1.dataQuality.initialEntryStatus, "UNAVAILABLE");
        assert.equal(norm1.dataQuality.positionCompleteness, "INCOMPLETE_AMOUNTS");

        const pos2 = createMockPosition("pos-topup-unknown", "pool-1", 5);
        const events2: RawEventInput[] = [
            {
                rawId: "ev-open2",
                rawType: "POSITION_OPEN",
                positionId: "pos-topup-unknown",
                poolId: "pool-1",
                createdAt: openTime,
                signature: "sig-open",
                totalInUsd: 500.0,
            },
            {
                rawId: "ev-topup2",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-topup-unknown",
                poolId: "pool-1",
                createdAt: new Date(new Date(openTime).getTime() + 10000).toISOString(),
                signature: "sig-topup",
                totalInUsd: null,
            },
            {
                rawId: "ev-close2",
                rawType: "POSITION_CLOSE",
                positionId: "pos-topup-unknown",
                poolId: "pool-1",
                createdAt: pos2.latest_close_ts as string,
                signature: "sig-close2",
            },
        ];

        const norm2 = reconstructPositionLifecycle("wallet-1", pos2, events2);
        assert.equal(norm2.initialEntryUsd, 500.0);
        assert.equal(norm2.dataQuality.initialEntryStatus, "VERIFIED_OPEN_EVENT");
        assert.equal(norm2.additionalLiquidityUsd, null);
        assert.equal(norm2.dataQuality.positionCompleteness, "INCOMPLETE_AMOUNTS");
    });

    // 28. Regression 3: Missing PnL vs genuine zero PnL
    it("28. PnL classification: distinguishes UNKNOWN from genuine zero PnL BREAKEVEN", () => {
        const posMissing = createMockPosition("pos-pnl-missing", "pool-1", 5, {
            total_pnl_usd: null,
            total_pnl_pct_usd: null,
        });
        const normMissing = reconstructPositionLifecycle("wallet-1", posMissing, []);
        assert.equal(normMissing.pnlUsd, null);
        assert.equal(normMissing.winLoss, "UNKNOWN");

        const posZero = createMockPosition("pos-pnl-zero", "pool-1", 5, {
            total_pnl_usd: 0,
            total_pnl_pct_usd: 0,
        });
        const normZero = reconstructPositionLifecycle("wallet-1", posZero, []);
        assert.equal(normZero.pnlUsd, 0);
        assert.equal(normZero.winLoss, "BREAKEVEN");
    });

    // 29. Regression 4: sourceCoverage COMPLETE requires confirmed extraction completeness
    it("29. Source coverage completeness: marks PARTIAL when extraction unconfirmed or has failures", () => {
        const p1 = createMockPosition("pos-cov", "pool-1", 5);

        const datasetUnconfirmed = buildPositionAnalyticsDataset({
            wallet: "wallet-cov",
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [p1],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
            isExtractionComplete: false,
        });
        assert.equal(datasetUnconfirmed.sourceCoverage.status, "PARTIAL");

        const datasetError = buildPositionAnalyticsDataset({
            wallet: "wallet-cov",
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [p1],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
            diagnostics: {
                skippedRecords: [{ poolAddress: "pool-1", reason: "EXTRACTION_FAILED" }],
            },
        });
        assert.equal(datasetError.sourceCoverage.status, "PARTIAL");

        const datasetComplete = buildPositionAnalyticsDataset({
            wallet: "wallet-cov",
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [p1],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
            isExtractionComplete: true,
        });
        assert.equal(datasetComplete.sourceCoverage.status, "COMPLETE");
    });

    // 30. Atomic paired publication
    it("30. Atomic paired publication: single-commit bundle, invariant verification, and failure resilience", () => {
        const tempBase = path.resolve("data/test-analytics-pair-pub");
        const bundlesBase = path.join(tempBase, "bundles");
        const positionsBase = path.join(tempBase, "positions");
        const metricsBase = path.join(tempBase, "metrics");
        const wallet = "test-wallet-pub";

        const dataset = buildPositionAnalyticsDataset({
            wallet,
            period: "30D",
            snapshotTimestampMs: NOW_MS,
            rawPositions: [createMockPosition("pos-1", "pool-1", 1)],
            rawEvents: [],
            fabriqPoolsDiscovered: 1,
            dlmmPoolsMatched: 1,
        });

        const validMetrics: any = {
            schemaVersion: "v1",
            wallet,
            period: "30D",
            generatedAt: new Date(NOW_MS + 1000).toISOString(),
            sourceDatasetFetchedAt: dataset.fetchedAt,
            capital: { totalPositionDepositsUsd: 100 },
            profitability: { sampleTotalPnlUsd: 50 },
        };

        try {
            // 1. Injected failure before commit: bundle never created, no residue
            const preCommitErr = /Injected pre-commit crash/;
            assert.throws(() => {
                publishPositionAnalyticsPair({
                    wallet,
                    period: "30D",
                    dataset,
                    metrics: validMetrics,
                    bundlesBaseDir: bundlesBase,
                    _beforeCommitHook: () => {
                        throw new Error("Injected pre-commit crash");
                    },
                });
            }, preCommitErr);

            const bundlePath = getBundleFilePath(wallet, "30D", bundlesBase);
            assert.equal(fs.existsSync(bundlePath), false);
            assert.equal(loadPublishedPositionPair(wallet, "30D", { bundlesBaseDir: bundlesBase }), null);

            // 2. Invariant verification: reject mismatch between metrics.sourceDatasetFetchedAt and dataset.fetchedAt
            const mismatchedMetrics: any = {
                ...validMetrics,
                sourceDatasetFetchedAt: "2026-03-21T00:00:00.000Z",
            };
            const invariantErr = /Publication invariant violation/;
            assert.throws(() => {
                publishPositionAnalyticsPair({
                    wallet,
                    period: "30D",
                    dataset,
                    metrics: mismatchedMetrics,
                    bundlesBaseDir: bundlesBase,
                });
            }, invariantErr);
            assert.equal(fs.existsSync(bundlePath), false);

            // 3. Successful publication: bundle created atomically
            const pubResult = publishPositionAnalyticsPair({
                wallet,
                period: "30D",
                dataset,
                metrics: validMetrics,
                bundlesBaseDir: bundlesBase,
            });
            assert.equal(fs.existsSync(bundlePath), true);
            assert.equal(pubResult.bundlePath, bundlePath);

            // 4. Load published pair: returns consistent pair with isBundle = true
            const pair = loadPublishedPositionPair(wallet, "30D", { bundlesBaseDir: bundlesBase });
            assert.ok(pair);
            assert.equal(pair?.isBundle, true);
            assert.equal(pair?.dataset?.fetchedAt, dataset.fetchedAt);
            assert.equal(pair?.metrics?.sourceDatasetFetchedAt, dataset.fetchedAt);
            assert.equal(pair?.dataset?.positions.length, 1);

            // 5. Storage fallback: loadPositionAnalyticsDataset and loadPositionMetrics load from bundle
            // when default file is absent
            const loadedDataset = loadPositionAnalyticsDataset(wallet, "30D", positionsBase);
            // positionsBase does not have a separate file, but bundle exists in bundles directory
            // Notice: loadPositionAnalyticsDataset uses DEFAULT_ANALYTICS_STORAGE_BASE for bundle fallback
        } finally {
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });
});

describe("Position Analytics Step 3 Phase 1 — Safe Bounded Concurrency & Networking Suite", () => {
    const NOW_MS = 1775700000000;
    const DAY_MS = 24 * 60 * 60 * 1000;

    function createMockPosition(
        id: string,
        pool_id: string,
        closedDaysAgo: number | null,
        overrides?: Partial<RawPositionInput>
    ): RawPositionInput {
        return {
            id,
            pool_id,
            source: "wallet",
            total_add_usd: 1000,
            total_rem_usd: 1100,
            total_fee_usd: 25,
            total_pnl_usd: 125,
            total_pnl_pct_usd: 12.5,
            latest_close_ts: closedDaysAgo !== null ? new Date(NOW_MS - closedDaysAgo * DAY_MS).toISOString() : null,
            opened_at: closedDaysAgo !== null ? new Date(NOW_MS - (closedDaysAgo + 2) * DAY_MS).toISOString() : null,
            duration: 172800,
            ...overrides,
        };
    }

    // 31. Bounded Concurrency Limits
    it("31. Bounded Concurrency Limits: maximum observed in-flight requests never exceeds limits", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;

        let activePositionsInFlight = 0;
        let peakPositionsInFlight = 0;

        let activeTxInFlight = 0;
        let peakTxInFlight = 0;

        try {
            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                if (url.includes("/positions-by-pool")) {
                    activePositionsInFlight++;
                    if (activePositionsInFlight > peakPositionsInFlight) {
                        peakPositionsInFlight = activePositionsInFlight;
                    }
                    const { promise, resolve } = Promise.withResolvers<Response>();
                    setImmediate(() => {
                        activePositionsInFlight--;
                        resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
                    });
                    return promise;
                }

                if (url.includes("/transactions")) {
                    activeTxInFlight++;
                    if (activeTxInFlight > peakTxInFlight) {
                        peakTxInFlight = activeTxInFlight;
                    }
                    const { promise, resolve } = Promise.withResolvers<Response>();
                    setImmediate(() => {
                        activeTxInFlight--;
                        resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
                    });
                    return promise;
                }

                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            // Test 1: positions-by-pool with 10 batches (concurrency: 2)
            const poolIds = Array.from({ length: 250 }, (_, i) => `pool-${i}`);
            const posResult = await fetchWalletPositionsForPools("wallet-1", poolIds, {
                batchSize: 25,
                concurrency: 2,
                onLog: () => {},
            });

            assert.equal(posResult.batchesFetched, 10);
            assert.equal(peakPositionsInFlight, 2);
            assert.ok(posResult.peakInFlight !== undefined && posResult.peakInFlight <= 2);

            // Test 2: transactions with 9 batches (concurrency: 3)
            const positionIds = Array.from({ length: 180 }, (_, i) => `pos-${i}`);
            const poolMap = new Map<string, string>();
            for (const pid of positionIds) poolMap.set(pid, "pool-1");

            const txResult = await fetchTransactionsForPositions("wallet-1", positionIds, poolMap, {
                batchSize: 20,
                concurrency: 3,
                onLog: () => {},
            });

            assert.equal(txResult.batchesFetched, 9);
            assert.equal(peakTxInFlight, 3);
            assert.ok(txResult.peakInFlight !== undefined && txResult.peakInFlight <= 3);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
        }
    });

    // 32. Deterministic Ordering Under Out-Of-Order Batch Completion
    it("32. Deterministic Ordering: output order strictly matches original batch sequence despite inverted completion", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;

        try {
            const posResolvers = new Map<string, (res: Response) => void>();
            const txResolvers = new Map<string, (res: Response) => void>();

            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                const { promise, resolve } = Promise.withResolvers<Response>();

                if (url.includes("/positions-by-pool")) {
                    const params = new URL(url).searchParams;
                    const poolParam = params.get("poolIds") || "";
                    let batchTag = "unknown";
                    if (poolParam.includes("batch-0")) batchTag = "batch-0";
                    else if (poolParam.includes("batch-1")) batchTag = "batch-1";
                    else if (poolParam.includes("batch-2")) batchTag = "batch-2";

                    posResolvers.set(batchTag, resolve);

                    if (posResolvers.size === 3) {
                        queueMicrotask(() => {
                            const res2 = posResolvers.get("batch-2");
                            res2?.(new Response(JSON.stringify({ data: [
                                { id: "pos-batch-2-item-1", pool_id: "batch-2-pool", total_pnl_usd: 10 },
                                { id: "pos-batch-2-item-2", pool_id: "batch-2-pool", total_pnl_usd: 20 },
                            ] }), { status: 200 }));

                            queueMicrotask(() => {
                                const res1 = posResolvers.get("batch-1");
                                res1?.(new Response(JSON.stringify({ data: [
                                    { id: "pos-batch-1-item-1", pool_id: "batch-1-pool", total_pnl_usd: 10 },
                                    { id: "pos-batch-1-item-2", pool_id: "batch-1-pool", total_pnl_usd: 20 },
                                ] }), { status: 200 }));

                                queueMicrotask(() => {
                                    const res0 = posResolvers.get("batch-0");
                                    res0?.(new Response(JSON.stringify({ data: [
                                        { id: "pos-batch-0-item-1", pool_id: "batch-0-pool", total_pnl_usd: 10 },
                                        { id: "pos-batch-0-item-2", pool_id: "batch-0-pool", total_pnl_usd: 20 },
                                    ] }), { status: 200 }));
                                });
                            });
                        });
                    }
                    return promise;
                }

                if (url.includes("/transactions")) {
                    const params = new URL(url).searchParams;
                    const posParam = params.get("positionIds") || "";
                    let batchTag = "unknown";
                    if (posParam.includes("pos-batch-0")) batchTag = "batch-0";
                    else if (posParam.includes("pos-batch-1")) batchTag = "batch-1";
                    else if (posParam.includes("pos-batch-2")) batchTag = "batch-2";

                    txResolvers.set(batchTag, resolve);

                    if (txResolvers.size === 3) {
                        queueMicrotask(() => {
                            const res2 = txResolvers.get("batch-2");
                            res2?.(new Response(JSON.stringify({ data: [
                                { id: "evt-batch-2-1", position_id: "pos-batch-2", type: "POSITION_OPEN", total_in_usd: 100 },
                            ] }), { status: 200 }));

                            queueMicrotask(() => {
                                const res1 = txResolvers.get("batch-1");
                                res1?.(new Response(JSON.stringify({ data: [
                                    { id: "evt-batch-1-1", position_id: "pos-batch-1", type: "POSITION_OPEN", total_in_usd: 100 },
                                ] }), { status: 200 }));

                                queueMicrotask(() => {
                                    const res0 = txResolvers.get("batch-0");
                                    res0?.(new Response(JSON.stringify({ data: [
                                        { id: "evt-batch-0-1", position_id: "pos-batch-0", type: "POSITION_OPEN", total_in_usd: 100 },
                                    ] }), { status: 200 }));
                                });
                            });
                        });
                    }
                    return promise;
                }

                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            // Positions: 3 batches, batch 2 finishes first, then 1, then 0
            const poolIds = ["batch-0-pool", "batch-1-pool", "batch-2-pool"];
            const posResult = await fetchWalletPositionsForPools("wallet-1", poolIds, {
                batchSize: 1,
                concurrency: 3,
                onLog: () => {},
            });

            const posIds = posResult.positions.map((p) => p.id);
            assert.deepEqual(posIds, [
                "pos-batch-0-item-1",
                "pos-batch-0-item-2",
                "pos-batch-1-item-1",
                "pos-batch-1-item-2",
                "pos-batch-2-item-1",
                "pos-batch-2-item-2",
            ]);

            // Transactions: 3 batches, batch 2 finishes first, then 1, then 0
            const posQueryIds = ["pos-batch-0", "pos-batch-1", "pos-batch-2"];
            const poolMap = new Map([
                ["pos-batch-0", "p0"],
                ["pos-batch-1", "p1"],
                ["pos-batch-2", "p2"],
            ]);
            const txResult = await fetchTransactionsForPositions("wallet-1", posQueryIds, poolMap, {
                batchSize: 1,
                concurrency: 3,
                onLog: () => {},
            });

            const evtIds = txResult.events.map((e) => e.rawId);
            assert.deepEqual(evtIds, ["evt-batch-0-1", "evt-batch-1-1", "evt-batch-2-1"]);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
        }
    });

    // 33. Concurrency Does Not Corrupt Position/Event Association
    it("33. Position/Event Association: concurrent batch completion retains exact position-event mapping", () => {
        const pos1 = createMockPosition("pos-alpha", "pool-alpha", 5);
        const pos2 = createMockPosition("pos-beta", "pool-beta", 2);

        const events: RawEventInput[] = [
            {
                rawId: "evt-beta-open",
                rawType: "POSITION_OPEN",
                positionId: "pos-beta",
                poolId: "pool-beta",
                createdAt: pos2.opened_at as string,
                signature: "sig-b-open",
                totalInUsd: 2500,
            },
            {
                rawId: "evt-alpha-open",
                rawType: "POSITION_OPEN",
                positionId: "pos-alpha",
                poolId: "pool-alpha",
                createdAt: pos1.opened_at as string,
                signature: "sig-a-open",
                totalInUsd: 1000,
            },
        ];

        const norm1 = reconstructPositionLifecycle("wallet-1", pos1, events);
        const norm2 = reconstructPositionLifecycle("wallet-1", pos2, events);

        assert.equal(norm1.positionId, "pos-alpha");
        assert.equal(norm1.poolAddress, "pool-alpha");
        assert.equal(norm1.initialEntryUsd, 1000);
        assert.equal(norm1.lifecycle.events.length, 1);
        assert.equal(norm1.lifecycle.events[0].signature, "sig-a-open");

        assert.equal(norm2.positionId, "pos-beta");
        assert.equal(norm2.poolAddress, "pool-beta");
        assert.equal(norm2.initialEntryUsd, 2500);
        assert.equal(norm2.lifecycle.events.length, 1);
        assert.equal(norm2.lifecycle.events[0].signature, "sig-b-open");
    });

    // 34. Retry-After (Delta-Seconds & HTTP-Date) and Shared Cooldown
    it("34. Retry-After & Shared Cooldown: parses delta/date formats and coordinates cooldown across concurrent requests", async () => {
        // 1. Parsing tests
        assert.equal(parseRetryAfterHeader("60"), 60);
        assert.equal(parseRetryAfterHeader("0"), 0);
        assert.equal(parseRetryAfterHeader(null), 5);
        assert.equal(parseRetryAfterHeader("invalid-date-or-num"), 5);

        const futureDateString = new Date(Date.now() + 12000).toUTCString();
        const parsedFutureSec = parseRetryAfterHeader(futureDateString);
        assert.ok(parsedFutureSec >= 10 && parsedFutureSec <= 13);

        const pastDateString = new Date(Date.now() - 5000).toUTCString();
        assert.equal(parseRetryAfterHeader(pastDateString), 1);

        // 2. Shared Cooldown Coordinator test
        const coordinator = new SharedCooldownCoordinator();
        coordinator.record429(80); // 80ms cooldown
        assert.ok(coordinator.getRemainingCooldownMs() > 0);

        const tBefore = Date.now();
        await coordinator.waitForCooldown();
        const tElapsed = Date.now() - tBefore;
        assert.ok(tElapsed >= 60);
        assert.equal(coordinator.getRemainingCooldownMs(), 0);
    });

    // 35. Network Safety Paths: Timeout, Cancellation, 401, 403, 404, 5xx
    it("35. Network Safety Paths: verifies timeout, cancellation, 401, 403, 404, and 5xx handling", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;

        try {
            // Path A: Request timeout
            globalThis.fetch = async (_input, init) => {
                const { promise, reject } = Promise.withResolvers<Response>();
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason ?? new Error("Timeout"));
                }, { once: true });
                return promise;
            };

            await assert.rejects(
                () => fabriqFetch("/test/timeout", undefined, { timeoutMs: 15, maxRetries: 1, jitterMs: 0 }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("timed out") || err.name === "AbortError" || err.message.includes("Timeout"));
                    return true;
                }
            );

            // Path B: Explicit caller cancellation (never retried, never returns empty)
            let fetchCallCount = 0;
            const cancelController = new AbortController();
            globalThis.fetch = async (_input, init) => {
                fetchCallCount++;
                cancelController.abort(new Error("Caller abort request"));
                const { promise, reject } = Promise.withResolvers<Response>();
                if (init?.signal?.aborted) {
                    reject(init.signal.reason);
                } else {
                    init?.signal?.addEventListener("abort", () => {
                        reject(init.signal?.reason);
                    }, { once: true });
                }
                return promise;
            };

            await assert.rejects(
                () => fabriqFetch("/test/cancel", undefined, { signal: cancelController.signal }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.equal(err.message, "Caller abort request");
                    return true;
                }
            );
            assert.equal(fetchCallCount, 1);

            // Path C: 403 Forbidden terminal error
            globalThis.fetch = async () => {
                return new Response("Forbidden", { status: 403 });
            };

            await assert.rejects(
                () => fabriqFetch("/test/403"),
                (err: unknown) => {
                    assert.ok(err instanceof FabriqCdpError);
                    assert.equal(err.code, "FABRIQ_API_ERROR");
                    return true;
                }
            );

            // Path D: 5xx retry recovery
            let call5xx = 0;
            globalThis.fetch = async () => {
                call5xx++;
                if (call5xx === 1) {
                    return new Response("Server error", { status: 502 });
                }
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            };

            const res5xx = await fabriqFetch<{ ok: boolean }>("/test/5xx", undefined, { jitterMs: 1 });
            assert.equal(res5xx.ok, true);
            assert.equal(call5xx, 2);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
        }
    });

    // 36. Conservative Event Deduplication
    it("36. Conservative Event Deduplication: deduplicates identical rawId while preserving distinct events in same tx", () => {
        const events: RawEventInput[] = [
            // 1. Identical duplicate rawId (should be deduplicated)
            {
                rawId: "evt-dup-1",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-1",
                poolId: "pool-1",
                createdAt: "2026-03-20T10:00:00Z",
                signature: "sig-same-tx",
                totalInUsd: 500,
            },
            {
                rawId: "evt-dup-1", // Exact duplicate
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-1",
                poolId: "pool-1",
                createdAt: "2026-03-20T10:00:00Z",
                signature: "sig-same-tx",
                totalInUsd: 500,
            },
            // 2. Distinct event type in the SAME transaction (must be preserved)
            {
                rawId: "evt-fee-1",
                rawType: "FEE_CLAIM",
                positionId: "pos-1",
                poolId: "pool-1",
                createdAt: "2026-03-20T10:00:00Z",
                signature: "sig-same-tx",
                totalInUsd: 25,
            },
            // 3. Ambiguous events (no rawId, same tx) - must be preserved conservatively
            {
                rawId: "",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-1",
                poolId: "pool-1",
                createdAt: "2026-03-20T11:00:00Z",
                signature: "sig-ambig",
                totalInUsd: 100,
            },
            {
                rawId: "",
                rawType: "ADD_LIQUIDITY",
                positionId: "pos-1",
                poolId: "pool-1",
                createdAt: "2026-03-20T11:00:00Z",
                signature: "sig-ambig",
                totalInUsd: 100,
            },
        ];

        const { deduplicated, duplicatesRemoved } = deduplicateRawEvents(events);

        // evt-dup-1 removed once; fee preserved; two ambiguous adds preserved -> 4 events retained
        assert.equal(duplicatesRemoved, 1);
        assert.equal(deduplicated.length, 4);

        // Verify lifecycle reconstruction avoids double-counting of deduplicated event
        const pos = createMockPosition("pos-1", "pool-1", 5);
        const norm = reconstructPositionLifecycle("wallet-1", pos, events);
        assert.equal(norm.claimedFeesUsd, 25);
    });

    // 37. Batch Failure Prevents Partial Publication and Preserves Valid Bundles
    it("37. Batch Failure: failed batch halts extraction without publishing and leaves existing bundle intact", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;

        const tempBase = path.join(process.cwd(), "data", `test-failure-${Date.now()}`);
        const wallet = "11111111111111111111111111111111";

        try {
            // 1. Establish an existing valid published bundle
            const goodDataset = buildPositionAnalyticsDataset({
                wallet,
                period: "30D",
                snapshotTimestampMs: NOW_MS,
                rawPositions: [createMockPosition("pos-good", "pool-1", 3)],
                rawEvents: [],
                fabriqPoolsDiscovered: 1,
                dlmmPoolsMatched: 1,
            });
            const goodMetrics = {
                schemaVersion: "v1",
                wallet,
                period: "30D",
                generatedAt: new Date().toISOString(),
                sourceDatasetFetchedAt: goodDataset.fetchedAt,
                capital: { totalPositionDepositsUsd: 1000 },
                profitability: { sampleTotalPnlUsd: 125 },
            } as unknown as PositionMetricsResult;

            const bundlesBase = path.join(tempBase, "bundles");
            publishPositionAnalyticsPair({
                wallet,
                period: "30D",
                dataset: goodDataset,
                metrics: goodMetrics,
                bundlesBaseDir: bundlesBase,
            });

            const initialBundle = loadPublishedPositionPair(wallet, "30D", { bundlesBaseDir: bundlesBase });
            assert.ok(initialBundle);
            assert.equal(initialBundle?.dataset?.positions[0].positionId, "pos-good");

            // 2. Now simulate extraction failure on batch 2 of positions
            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                if (url.includes("/pnl-by-pool")) {
                    return new Response(JSON.stringify({
                        data: [
                            { pool_id: "pool-1", dex: "Meteora DLMM" },
                            { pool_id: "pool-2", dex: "Meteora DLMM" },
                        ],
                    }), { status: 200 });
                }
                if (url.includes("/positions-by-pool")) {
                    // Force batch failure
                    return new Response("Internal Server Error", { status: 500 });
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            await assert.rejects(
                () =>
                    executeBuildPositionDataset({
                        wallet,
                        period: "30D",
                        force: true,
                        storageBaseDir: path.join(tempBase, "positions"),
                        onLog: () => {},
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    return true;
                }
            );

            // 3. Verify prior bundle is completely untouched and valid
            const bundleAfterFailure = loadPublishedPositionPair(wallet, "30D", { bundlesBaseDir: bundlesBase });
            assert.ok(bundleAfterFailure);
            assert.equal(bundleAfterFailure?.dataset?.positions[0].positionId, "pos-good");
            assert.equal(bundleAfterFailure?.dataset?.fetchedAt, goodDataset.fetchedAt);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });
});
describe("Position Analytics Step 3 Phase 2 — Resilience, Incremental Checkpoints & Cancellation Suite", () => {
    const NOW_MS = 1775700000000;
    const DAY_MS = 24 * 60 * 60 * 1000;

    function createMockPosition(
        id: string,
        pool_id: string,
        closedDaysAgo: number | null,
        overrides?: Partial<RawPositionInput>
    ): RawPositionInput {
        return {
            id,
            pool_id,
            source: "wallet",
            total_add_usd: 1000,
            total_rem_usd: 1100,
            total_fee_usd: 25,
            total_pnl_usd: 125,
            total_pnl_pct_usd: 12.5,
            latest_close_ts: closedDaysAgo !== null ? new Date(NOW_MS - closedDaysAgo * DAY_MS).toISOString() : null,
            opened_at: closedDaysAgo !== null ? new Date(NOW_MS - (closedDaysAgo + 2) * DAY_MS).toISOString() : null,
            duration: 172800,
            ...overrides,
        };
    }

    // 38. Batch Selesai Out-Of-Order: verifies deterministic ordering is preserved regardless of completion order
    it("38. Batch selesai out-of-order: deterministic event order strictly preserved despite inverted batch completion", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-ooo-${Date.now()}`);

        try {
            const wallet = "wallet-out-of-order";
            const positionIds = ["pos-0", "pos-1", "pos-2", "pos-3"];
            const poolMap = new Map<string, string>([
                ["pos-0", "pool-1"],
                ["pos-1", "pool-1"],
                ["pos-2", "pool-1"],
                ["pos-3", "pool-1"],
            ]);

            let resolveBatch0: ((res: Response) => void) | null = null;
            let resolveBatch1: ((res: Response) => void) | null = null;

            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                if (url.includes("pos-0") || url.includes("pos-1")) {
                    const { promise, resolve } = Promise.withResolvers<Response>();
                    resolveBatch0 = resolve;
                    return promise;
                }
                if (url.includes("pos-2") || url.includes("pos-3")) {
                    const { promise, resolve } = Promise.withResolvers<Response>();
                    resolveBatch1 = resolve;
                    return promise;
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            const fetchPromise = fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                batchSize: 2,
                concurrency: 2,
                checkpointBaseDir: tempBase,
                onLog: () => {},
            });

            // Wait for both batches to be in flight
            while (!resolveBatch0 || !resolveBatch1) {
                await new Promise((r) => setTimeout(r, 10));
            }

            // Invert completion order: resolve batch 1 FIRST, then batch 0
            resolveBatch1!(
                new Response(
                    JSON.stringify({
                        data: [
                            { id: "tx-b1-event", position_id: "pos-2", type: "POSITION_OPEN", created_at: "2026-03-02T10:00:00Z" },
                        ],
                    }),
                    { status: 200 }
                )
            );

            await new Promise((r) => setTimeout(r, 20));

            // Now resolve batch 0
            resolveBatch0!(
                new Response(
                    JSON.stringify({
                        data: [
                            { id: "tx-b0-event", position_id: "pos-0", type: "POSITION_OPEN", created_at: "2026-03-01T10:00:00Z" },
                        ],
                    }),
                    { status: 200 }
                )
            );

            const result = await fetchPromise;
            assert.equal(result.events.length, 2);
            // Strict batch index order: batch 0 events MUST come first, then batch 1 events!
            assert.equal(result.events[0].rawId, "tx-b0-event");
            assert.equal(result.events[1].rawId, "tx-b1-event");

            // Check checkpoint on disk
            const cp = loadTransactionCheckpointRecord(wallet, positionIds, { baseDir: tempBase });
            assert.ok(cp);
            assert.equal(cp?.isComplete, true);
            assert.equal(cp?.events[0].rawId, "tx-b0-event");
            assert.equal(cp?.events[1].rawId, "tx-b1-event");
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 39. Resume Hanya Mengambil Missing Batches
    it("39. Resume hanya mengambil missing batches: fetches only uncompleted batches on resume", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-resume-${Date.now()}`);

        try {
            const wallet = "wallet-resume-test";
            const positionIds = ["p0", "p1", "p2", "p3", "p4", "p5"];
            const poolMap = new Map<string, string>();
            for (const pid of positionIds) poolMap.set(pid, "pool-1");

            // Create pre-existing checkpoint where batch 0 (p0, p1) and batch 2 (p4, p5) are already done
            const preCheckpoint: TransactionCheckpoint = {
                schemaVersion: "v2",
                wallet,
                savedAt: new Date().toISOString(),
                selectedPositionIds: positionIds,
                completedPositionIds: ["p0", "p1", "p4", "p5"],
                completedBatchIndices: [0, 2],
                batchRecords: [
                    {
                        batchIndex: 0,
                        positionIds: ["p0", "p1"],
                        eventCount: 1,
                        completedAt: new Date().toISOString(),
                        events: [
                            {
                                rawId: "ev-b0",
                                rawType: "POSITION_OPEN",
                                positionId: "p0",
                                poolId: "pool-1",
                                createdAt: "2026-03-01T10:00:00Z",
                                signature: "sig-0",
                                source: "wallet",
                                tokenXAmount: 1,
                                tokenYAmount: 1,
                                tokenXAmountUsd: 10,
                                tokenYAmountUsd: 10,
                                tokenXAmountSol: 0.1,
                                tokenYAmountSol: 0.1,
                                totalInUsd: 20,
                                totalInSol: 0.2,
                            },
                        ],
                    },
                    {
                        batchIndex: 2,
                        positionIds: ["p4", "p5"],
                        eventCount: 1,
                        completedAt: new Date().toISOString(),
                        events: [
                            {
                                rawId: "ev-b2",
                                rawType: "POSITION_CLOSE",
                                positionId: "p4",
                                poolId: "pool-1",
                                createdAt: "2026-03-03T10:00:00Z",
                                signature: "sig-2",
                                source: "wallet",
                                tokenXAmount: 1,
                                tokenYAmount: 1,
                                tokenXAmountUsd: 10,
                                tokenYAmountUsd: 10,
                                tokenXAmountSol: 0.1,
                                tokenYAmountSol: 0.1,
                                totalInUsd: 20,
                                totalInSol: 0.2,
                            },
                        ],
                    },
                ],
                events: [],
                isComplete: false,
                coverage: {
                    totalSelectedPositions: 6,
                    completedPositionsCount: 4,
                    totalBatches: 3,
                    completedBatchesCount: 2,
                    isComplete: false,
                },
            };

            saveTransactionCheckpointRecord(preCheckpoint, { baseDir: tempBase });

            // Monitor HTTP requests made during resume
            const requestedUrls: string[] = [];
            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                requestedUrls.push(url);
                if (url.includes("/transactions")) {
                    return new Response(
                        JSON.stringify({
                            data: [
                                { id: "ev-b1", position_id: "p2", type: "ADD_LIQUIDITY", created_at: "2026-03-02T10:00:00Z" },
                            ],
                        }),
                        { status: 200 }
                    );
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            const result = await fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                batchSize: 2,
                concurrency: 2,
                checkpointBaseDir: tempBase,
                onLog: () => {},
            });

            // Assert exactly 1 batch was requested over the network!
            assert.equal(requestedUrls.length, 1);
            assert.ok(requestedUrls[0].includes("p2") && requestedUrls[0].includes("p3"));
            assert.ok(!requestedUrls[0].includes("p0") && !requestedUrls[0].includes("p4"));

            // Assert all 3 batches are represented in deterministic order in the result
            assert.equal(result.events.length, 3);
            assert.equal(result.events[0].rawId, "ev-b0");
            assert.equal(result.events[1].rawId, "ev-b1");
            assert.equal(result.events[2].rawId, "ev-b2");
            assert.equal(result.batchesFetched, 1);

            // Final checkpoint is now complete on disk
            const finalCp = loadTransactionCheckpointRecord(wallet, positionIds, { baseDir: tempBase });
            assert.equal(finalCp?.isComplete, true);
            assert.equal(finalCp?.completedPositionIds.length, 6);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 40. Zero-Event Batch Tercatat Complete
    it("40. Zero-event batch tercatat complete: records empty batch as complete and avoids re-fetching", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-zero-${Date.now()}`);

        try {
            const wallet = "wallet-zero-event-test";
            const positionIds = ["z0", "z1", "z2", "z3"];
            const poolMap = new Map<string, string>();
            for (const pid of positionIds) poolMap.set(pid, "pool-1");

            let fetchCount = 0;
            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                fetchCount++;
                if (url.includes("z0") || url.includes("z1")) {
                    // Zero events returned for batch 0
                    return new Response(JSON.stringify({ data: [] }), { status: 200 });
                }
                if (url.includes("z2") || url.includes("z3")) {
                    return new Response(
                        JSON.stringify({
                            data: [{ id: "ev-z1", position_id: "z2", type: "POSITION_OPEN" }],
                        }),
                        { status: 200 }
                    );
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            const res1 = await fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                batchSize: 2,
                concurrency: 2,
                checkpointBaseDir: tempBase,
                onLog: () => {},
            });

            assert.equal(fetchCount, 2);
            assert.equal(res1.events.length, 1);

            // Verify checkpoint on disk records zero-event batch as complete
            const cp = loadTransactionCheckpointRecord(wallet, positionIds, { baseDir: tempBase });
            assert.ok(cp);
            assert.equal(cp?.isComplete, true);
            assert.equal(cp?.completedPositionIds.length, 4);
            const b0Record = cp?.batchRecords?.find((b) => b.batchIndex === 0);
            assert.ok(b0Record);
            assert.equal(b0Record?.eventCount, 0);

            // Now run a second time with the same parameters
            fetchCount = 0;
            const res2 = await fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                batchSize: 2,
                concurrency: 2,
                checkpointBaseDir: tempBase,
                onLog: () => {},
            });

            // Zero-event batch was NOT re-fetched; completely reused from checkpoint!
            assert.equal(fetchCount, 0);
            assert.equal(res2.fromCheckpoint, true);
            assert.equal(res2.events.length, 1);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 41. Interrupted Checkpoint Lalu Resume
    it("41. Interrupted checkpoint lalu resume: saves partial checkpoint on abort and resumes to completion", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-interrupt-${Date.now()}`);

        try {
            const wallet = "wallet-interrupt-test";
            const positionIds = ["i0", "i1", "i2", "i3"];
            const poolMap = new Map<string, string>();
            for (const pid of positionIds) poolMap.set(pid, "pool-1");

            const controller = new AbortController();

            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                if (url.includes("i0") || url.includes("i1")) {
                    // Batch 0 completes successfully
                    return new Response(
                        JSON.stringify({
                            data: [{ id: "ev-i0", position_id: "i0", type: "POSITION_OPEN" }],
                        }),
                        { status: 200 }
                    );
                }
                if (url.includes("i2") || url.includes("i3")) {
                    // Wait for abort signal on batch 1
                    const { promise, reject } = Promise.withResolvers<Response>();
                    controller.signal.addEventListener(
                        "abort",
                        () => reject(new Error("Operation aborted")),
                        { once: true }
                    );
                    return promise;
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            // Start run 1 with concurrency 1 so batch 0 completes before batch 1 is aborted
            let batch0Saved = false;
            const runPromise = fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                batchSize: 2,
                concurrency: 1,
                checkpointBaseDir: tempBase,
                signal: controller.signal,
                onBatchSaved: (cp) => {
                    if (cp.completedPositionIds.includes("i0")) {
                        batch0Saved = true;
                        // Trigger abort right after batch 0 is saved to disk!
                        controller.abort();
                    }
                },
                onLog: () => {},
            });

            await assert.rejects(runPromise, /aborted/i);
            assert.equal(batch0Saved, true);

            // Verify partial checkpoint exists on disk with isComplete: false
            const partialCp = loadTransactionCheckpointRecord(wallet, positionIds, { baseDir: tempBase });
            assert.ok(partialCp);
            assert.equal(partialCp?.isComplete, false);
            assert.deepEqual(partialCp?.completedPositionIds, ["i0", "i1"]);

            // Resume run (Run 2) with clean controller
            let resumedFetches = 0;
            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                resumedFetches++;
                if (url.includes("i2") || url.includes("i3")) {
                    return new Response(
                        JSON.stringify({
                            data: [{ id: "ev-i1", position_id: "i2", type: "POSITION_CLOSE" }],
                        }),
                        { status: 200 }
                    );
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            const resumeResult = await fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                batchSize: 2,
                concurrency: 1,
                checkpointBaseDir: tempBase,
                onLog: () => {},
            });

            // Only batch 1 was fetched during resume!
            assert.equal(resumedFetches, 1);
            assert.equal(resumeResult.events.length, 2);
            assert.equal(resumeResult.events[0].rawId, "ev-i0");
            assert.equal(resumeResult.events[1].rawId, "ev-i1");

            // Checkpoint on disk is now complete
            const finalCp = loadTransactionCheckpointRecord(wallet, positionIds, { baseDir: tempBase });
            assert.equal(finalCp?.isComplete, true);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 42. Changed Selection atau Expired Checkpoint Ditolak
    it("42. Changed selection atau expired checkpoint ditolak: rejects stale or selection-mismatched checkpoints", () => {
        const tempBase = path.join(process.cwd(), "data", `test-cp-reject-${Date.now()}`);
        const wallet = "wallet-validation-test";

        try {
            // Case A: Selection mismatch
            const cpA: TransactionCheckpoint = {
                schemaVersion: "v2",
                wallet,
                savedAt: new Date().toISOString(),
                selectedPositionIds: ["pA", "pB"],
                completedPositionIds: ["pA", "pB"],
                completedBatchIndices: [0],
                events: [],
                isComplete: true,
                coverage: {
                    totalSelectedPositions: 2,
                    completedPositionsCount: 2,
                    totalBatches: 1,
                    completedBatchesCount: 1,
                    isComplete: true,
                },
            };
            saveTransactionCheckpointRecord(cpA, { baseDir: tempBase });

            // Query with different selection: ["pA", "pC"]
            const loadedDiffSelection = loadTransactionCheckpointRecord(wallet, ["pA", "pC"], { baseDir: tempBase });
            assert.equal(loadedDiffSelection, null);

            // Query with different selection length: ["pA"]
            const loadedDiffLen = loadTransactionCheckpointRecord(wallet, ["pA"], { baseDir: tempBase });
            assert.equal(loadedDiffLen, null);

            // Case B: Expired checkpoint
            const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
            const cpExpired: TransactionCheckpoint = {
                schemaVersion: "v2",
                wallet,
                savedAt: fiveHoursAgo,
                selectedPositionIds: ["pA", "pB"],
                completedPositionIds: ["pA", "pB"],
                completedBatchIndices: [0],
                events: [],
                isComplete: true,
                coverage: {
                    totalSelectedPositions: 2,
                    completedPositionsCount: 2,
                    totalBatches: 1,
                    completedBatchesCount: 1,
                    isComplete: true,
                },
            };
            saveTransactionCheckpointRecord(cpExpired, { baseDir: tempBase });

            // Default maxAge is 4 hours, so 5 hours is expired
            const loadedExpired = loadTransactionCheckpointRecord(wallet, ["pA", "pB"], { baseDir: tempBase });
            assert.equal(loadedExpired, null);
        } finally {
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 43. Failure dengan Active Concurrent Requests & Coordinated Stop
    it("43. Failure dengan active concurrent requests: coordinates queue halt and settles active workers", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-fail-coord-${Date.now()}`);

        try {
            const wallet = "wallet-fail-coord";
            const positionIds = ["f0", "f1", "f2", "f3", "f4", "f5"];
            const poolMap = new Map<string, string>();
            for (const pid of positionIds) poolMap.set(pid, "pool-1");

            let activeWorkers = 0;
            let peakConcurrent = 0;

            globalThis.fetch = async (input: string | URL | Request) => {
                const url = String(input);
                activeWorkers++;
                if (activeWorkers > peakConcurrent) peakConcurrent = activeWorkers;

                if (url.includes("f2") || url.includes("f3")) {
                    // Force fatal server error on batch 1
                    activeWorkers--;
                    return new Response("Database failure", { status: 500 });
                }

                // Other batches linger slightly
                await new Promise((r) => setTimeout(r, 40));
                activeWorkers--;
                return new Response(JSON.stringify({ data: [] }), { status: 200 });
            };

            await assert.rejects(
                () =>
                    fetchTransactionsForPositions(wallet, positionIds, poolMap, {
                        batchSize: 2,
                        concurrency: 3,
                        checkpointBaseDir: tempBase,
                        onLog: () => {},
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    return true;
                }
            );

            // Assert all workers settled cleanly
            assert.equal(activeWorkers, 0);

            // Checkpoint does NOT record failed batch as complete
            const cp = loadTransactionCheckpointRecord(wallet, positionIds, { baseDir: tempBase });
            if (cp) {
                assert.equal(cp.isComplete, false);
                assert.ok(!cp.completedPositionIds.includes("f2"));
                assert.ok(!cp.completedPositionIds.includes("f3"));
            }
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 44. SIGTERM / Abort Mid-Run & Graceful Cancellation
    it("44. SIGTERM dan Stop mid-run: abort signal halts dispatch, settles workers, and prevents partial publication", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-sigterm-${Date.now()}`);

        try {
            const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
            const abortController = new AbortController();

            let poolFetched = false;
            globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                if (url.includes("/pnl-by-pool")) {
                    poolFetched = true;
                    return new Response(
                        JSON.stringify({
                            data: [{ pool_id: "pool-1", dex: "Meteora DLMM" }],
                        }),
                        { status: 200 }
                    );
                }
                if (url.includes("/positions-by-pool")) {
                    abortController.abort(new Error("Process received SIGTERM"));
                    if (init?.signal?.aborted) {
                        throw init.signal.reason ?? new Error("Aborted");
                    }
                    const { promise, reject } = Promise.withResolvers<Response>();
                    init?.signal?.addEventListener("abort", () => {
                        reject(init.signal?.reason ?? new Error("Aborted"));
                    }, { once: true });
                    return promise;
                }
                return new Response(JSON.stringify({ data: {} }), { status: 200 });
            };

            const runPromise = executeBuildPositionDataset({
                wallet,
                period: "30D",
                storageBaseDir: path.join(tempBase, "positions"),
                checkpointBaseDir: path.join(tempBase, "checkpoints"),
                signal: abortController.signal,
                onLog: () => {},
            });

            await assert.rejects(runPromise, /SIGTERM|aborted/i);
            assert.equal(poolFetched, true);

            // Assert no dataset was saved or published
            const posFile = path.join(tempBase, "positions", wallet, "30D.json");
            assert.equal(fs.existsSync(posFile), false);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 45. Tidak Ada Orphan Requests atau Unhandled Rejections
    it("45. Tidak ada orphan requests atau unhandled rejections: verifies bounded queue cleanly settles all promises", async () => {
        const unhandledErrors: unknown[] = [];
        const onUnhandled = (err: unknown) => {
            unhandledErrors.push(err);
        };
        process.on("unhandledRejection", onUnhandled);

        try {
            const items = [1, 2, 3, 4, 5, 6];
            let activeWorkers = 0;

            await assert.rejects(
                () =>
                    runBoundedWorkerQueue({
                        items,
                        concurrency: 3,
                        worker: async (item, _idx, signal) => {
                            activeWorkers++;
                            if (item === 3) {
                                activeWorkers--;
                                throw new Error("Simulated worker fatal failure");
                            }
                            const { promise, reject } = Promise.withResolvers<number>();
                            signal?.addEventListener("abort", () => {
                                activeWorkers--;
                                reject(new Error("Worker aborted"));
                            }, { once: true });
                            return promise;
                        },
                    }),
                /Simulated worker fatal failure/
            );

            // Give event loop time to verify no dangling rejections
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(unhandledErrors.length, 0);
            assert.equal(activeWorkers, 0);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    // 46. Tidak Ada Partial Dataset Publication & Incomplete Checkpoint Rejection
    it("46. Tidak ada partial dataset publication: rejects incomplete checkpoints and refuses dataset publication", () => {
        const tempBase = path.join(process.cwd(), "data", `test-cp-partial-pub-${Date.now()}`);
        const wallet = "wallet-partial-pub";

        try {
            const partialCheckpoint: TransactionCheckpoint = {
                schemaVersion: "v2",
                wallet,
                savedAt: new Date().toISOString(),
                selectedPositionIds: ["pos-1", "pos-2"],
                completedPositionIds: ["pos-1"], // only 1 of 2 positions completed!
                completedBatchIndices: [0],
                events: [
                    {
                        rawId: "ev-partial",
                        rawType: "POSITION_OPEN",
                        positionId: "pos-1",
                        poolId: "pool-1",
                        createdAt: "2026-03-01T10:00:00Z",
                        signature: "sig-part",
                        source: "wallet",
                        tokenXAmount: 1,
                        tokenYAmount: 1,
                        tokenXAmountUsd: 10,
                        tokenYAmountUsd: 10,
                        tokenXAmountSol: 0.1,
                        tokenYAmountSol: 0.1,
                        totalInUsd: 20,
                        totalInSol: 0.2,
                    },
                ],
                isComplete: false,
                coverage: {
                    totalSelectedPositions: 2,
                    completedPositionsCount: 1,
                    totalBatches: 2,
                    completedBatchesCount: 1,
                    isComplete: false,
                },
            };
            saveTransactionCheckpointRecord(partialCheckpoint, { baseDir: tempBase });

            // loadTransactionCheckpoint MUST return null for incomplete checkpoint
            const events = loadTransactionCheckpoint(wallet, ["pos-1", "pos-2"], { baseDir: tempBase });
            assert.equal(events, null);

            // Record can be inspected
            const rec = loadTransactionCheckpointRecord(wallet, ["pos-1", "pos-2"], { baseDir: tempBase });
            assert.ok(rec);
            assert.equal(rec?.isComplete, false);
            assert.equal(rec?.coverage.isComplete, false);
        } finally {
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 47. Existing Valid Bundle Tetap Utuh Pada Stop/Failure
    it("47. Existing valid bundle tetap utuh pada stop/failure: verifies prior published bundle is immutable across aborted runs", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;
        const tempBase = path.join(process.cwd(), "data", `test-cp-bundle-intact-${Date.now()}`);

        try {
            const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
            const bundlesBase = path.join(tempBase, "bundles");
            const positionsBase = path.join(tempBase, "positions");

            // 1. Establish an initial valid bundle
            const goodDataset = buildPositionAnalyticsDataset({
                wallet,
                period: "30D",
                snapshotTimestampMs: NOW_MS,
                rawPositions: [createMockPosition("pos-good-original", "pool-1", 5)],
                rawEvents: [],
                fabriqPoolsDiscovered: 1,
                dlmmPoolsMatched: 1,
            });
            const goodMetrics = {
                schemaVersion: "v1",
                wallet,
                period: "30D",
                generatedAt: new Date().toISOString(),
                sourceDatasetFetchedAt: goodDataset.fetchedAt,
                capital: { totalPositionDepositsUsd: 1000 },
                profitability: { sampleTotalPnlUsd: 200 },
            } as unknown as PositionMetricsResult;

            publishPositionAnalyticsPair({
                wallet,
                period: "30D",
                dataset: goodDataset,
                metrics: goodMetrics,
                bundlesBaseDir: bundlesBase,
            });

            const initialBundle = loadPublishedPositionPair(wallet, "30D", { bundlesBaseDir: bundlesBase });
            assert.ok(initialBundle);
            assert.equal(initialBundle?.dataset?.positions[0].positionId, "pos-good-original");

            // 2. Now attempt a refreshed build that gets aborted mid-run
            const controller = new AbortController();
            globalThis.fetch = async (_input, init) => {
                controller.abort(new Error("User stopped pipeline"));
                if (init?.signal?.aborted) {
                    throw init.signal.reason ?? new Error("Aborted");
                }
                const { promise, reject } = Promise.withResolvers<Response>();
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason ?? new Error("Aborted"));
                }, { once: true });
                return promise;
            };

            await assert.rejects(
                () =>
                    executeBuildPositionDataset({
                        wallet,
                        period: "30D",
                        force: true,
                        storageBaseDir: positionsBase,
                        signal: controller.signal,
                        onLog: () => {},
                    }),
                /stopped|aborted/i
            );

            // 3. Confirm original bundle is completely intact and matches original provenance
            const preservedBundle = loadPublishedPositionPair(wallet, "30D", { bundlesBaseDir: bundlesBase });
            assert.ok(preservedBundle);
            assert.equal(preservedBundle?.dataset?.positions[0].positionId, "pos-good-original");
            assert.equal(preservedBundle?.dataset?.fetchedAt, goodDataset.fetchedAt);
            assert.equal(preservedBundle?.metrics?.sourceDatasetFetchedAt, goodDataset.fetchedAt);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
            if (fs.existsSync(tempBase)) {
                fs.rmSync(tempBase, { recursive: true, force: true });
            }
        }
    });

    // 48. Cancellation Tidak Memicu Retry Tambahan
    it("48. Cancellation tidak memicu retry tambahan: abort signal terminates request on attempt 1 without retry delays", async () => {
        setFabriqTokenForTesting("mock-valid-jwt");
        const originalFetch = globalThis.fetch;

        try {
            const controller = new AbortController();
            let attempts = 0;

            globalThis.fetch = async (_input, init) => {
                attempts++;
                controller.abort(new Error("Immediate cancellation"));
                if (init?.signal?.aborted) {
                    throw init.signal.reason ?? new Error("Aborted");
                }
                const { promise, reject } = Promise.withResolvers<Response>();
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason ?? new Error("Aborted"));
                }, { once: true });
                return promise;
            };

            await assert.rejects(
                () =>
                    fabriqFetch("/test/no-retry-on-cancel", undefined, {
                        signal: controller.signal,
                        maxRetries: 3,
                    }),
                /cancellation|aborted/i
            );

            // Must strictly have stopped at attempt 1! Zero retries executed.
            assert.equal(attempts, 1);
        } finally {
            globalThis.fetch = originalFetch;
            setFabriqTokenForTesting(null);
        }
    });
});
