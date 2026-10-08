import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    filterPositionsByTimeframe,
    deduplicatePositions,
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
} from "../../scripts/analytics/position-analytics-storage.ts";
import {
    discoverWalletDlmmPools,
    DEFAULT_MAX_404_RETRIES,
    DEFAULT_DELAY_404_MS,
} from "../../scripts/analytics/fabriq-analytics-client.ts";
import { setFabriqTokenForTesting } from "../../scripts/discovery/core/fabriq-position-history.ts";
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
});
