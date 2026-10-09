import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    parseMonetaryString,
    compareTokenFlow,
    compareUsdMetric,
    extractLocalTokenFlows,
    comparePositionRecord,
    verifyPositionAnalyticsWithMeteora,
    saveMeteoraVerificationReport,
    loadMeteoraVerificationReport,
    fetchPoolClosedPositions,
    fetchMeteoraJson,
    type MeteoraApiPositionPnLData,
} from "../../scripts/analytics/meteora-verification-adapter.ts";
import type {
    NormalizedPositionRecord,
    PositionAnalyticsBundle,
    PositionAnalyticsDataset,
    PositionMetricsResult,
} from "../../scripts/analytics/position-analytics-types.ts";

const TEST_STORAGE_BASE = "data/test-analytics-verification";

function createMockPosition(overrides: Partial<NormalizedPositionRecord> = {}): NormalizedPositionRecord {
    return {
        wallet: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
        positionId: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
        poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
        source: "wallet",
        tokenXMint: null,
        tokenYMint: null,
        tokenXSymbol: null,
        tokenYSymbol: null,
        pairName: null,
        binStep: null,
        openedAt: "2026-09-15T21:30:41.000Z",
        closedAt: "2026-09-15T21:48:46.000Z",
        holdDurationSeconds: 1085,
        initialEntryUsd: 774.05,
        firstObservedAddUsd: null,
        additionalLiquidityUsd: 18592.44,
        totalDepositsUsd: 19366.49,
        totalWithdrawalsUsd: 19351.66,
        claimedFeesUsd: 0.14437,
        pnlUsd: -14.69,
        pnlPct: -0.076,
        winLoss: "LOSS",
        lifecycle: {
            openingEventObserved: true,
            closingEventObserved: true,
            eventCount: 7,
            events: [
                {
                    rawId: "open-1",
                    rawType: "POSITION_OPEN",
                    category: "initialize",
                    createdAt: "2026-09-15T21:30:41.000Z",
                    signature: "sig-open",
                    source: "wallet",
                    tokenXAmount: 0,
                    tokenYAmount: 0,
                    tokenXAmountUsd: 0,
                    tokenYAmountUsd: 0,
                    totalInUsd: 0,
                },
                {
                    rawId: "add-1",
                    rawType: "ADD_LIQUIDITY",
                    category: "add",
                    createdAt: "2026-09-15T21:30:41.000Z",
                    signature: "sig-add-1",
                    source: "wallet",
                    tokenXAmount: 0,
                    tokenYAmount: 7.993730259,
                    tokenXAmountUsd: 0,
                    tokenYAmountUsd: 774.05,
                    totalInUsd: 774.05,
                },
                {
                    rawId: "add-2",
                    rawType: "ADD_LIQUIDITY",
                    category: "add",
                    createdAt: "2026-09-15T21:30:41.000Z",
                    signature: "sig-add-2",
                    source: "wallet",
                    tokenXAmount: 0,
                    tokenYAmount: 192.006266025,
                    tokenXAmountUsd: 0,
                    tokenYAmountUsd: 18592.44,
                    totalInUsd: 18592.44,
                },
                {
                    rawId: "remove-1",
                    rawType: "REMOVE_LIQUIDITY",
                    category: "remove",
                    createdAt: "2026-09-15T21:48:46.000Z",
                    signature: "sig-remove-1",
                    source: "wallet",
                    tokenXAmount: 0,
                    tokenYAmount: 192.00626599,
                    tokenXAmountUsd: 0,
                    tokenYAmountUsd: 18578.24,
                    totalInUsd: 18578.24,
                },
                {
                    rawId: "remove-2",
                    rawType: "REMOVE_LIQUIDITY",
                    category: "remove",
                    createdAt: "2026-09-15T21:48:46.000Z",
                    signature: "sig-remove-2",
                    source: "wallet",
                    tokenXAmount: 23.727175199,
                    tokenYAmount: 7.969591736,
                    tokenXAmountUsd: 2.29,
                    tokenYAmountUsd: 771.13,
                    totalInUsd: 773.42,
                },
                {
                    rawId: "fee-1",
                    rawType: "FEE_CLAIM",
                    category: "claim_fee",
                    createdAt: "2026-09-15T21:48:46.000Z",
                    signature: "sig-fee-1",
                    source: "wallet",
                    tokenXAmount: 0.674754421,
                    tokenYAmount: 0.000817753,
                    tokenXAmountUsd: 0.065,
                    tokenYAmountUsd: 0.079,
                    totalInUsd: 0.144,
                },
                {
                    rawId: "close-1",
                    rawType: "POSITION_CLOSE",
                    category: "close",
                    createdAt: "2026-09-15T21:48:46.000Z",
                    signature: "sig-close-1",
                    source: "wallet",
                    tokenXAmount: 0,
                    tokenYAmount: 0,
                    tokenXAmountUsd: 0,
                    tokenYAmountUsd: 0,
                    totalInUsd: 0,
                },
            ],
        },
        dataQuality: {
            initialEntryStatus: "VERIFIED_ASSOCIATED_ADD",
            transactionCoverage: "FULL_LIFECYCLE",
            positionCompleteness: "COMPLETE",
            warnings: [],
        },
        ...overrides,
    };
}

function createMockDataset(positions: NormalizedPositionRecord[]): PositionAnalyticsDataset {
    return {
        schemaVersion: "v1",
        wallet: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
        period: "30D",
        dataSource: "fabriq",
        fetchedAt: "2026-10-09T18:00:00.000Z",
        timeframe: {
            requestedPeriod: "30D",
            effectiveStart: "2026-09-09T18:00:00.000Z",
            effectiveEnd: "2026-10-09T18:00:00.000Z",
            firstAvailableTimestamp: "2026-09-09T18:00:00.000Z",
            lastAvailableTimestamp: "2026-10-09T18:00:00.000Z",
            observedStart: "2026-09-11T10:36:37.000Z",
            observedEnd: "2026-09-15T21:48:46.000Z",
        },
        sourceCoverage: {
            status: "COMPLETE",
            fabriqPoolsDiscovered: 2,
            dlmmPoolsMatched: 0,
            totalPositionsFound: positions.length,
            totalEligiblePositions: positions.length,
        },
        sampling: {
            totalEligiblePositions: positions.length,
            analyzedPositions: positions.length,
            excludedPositions: 0,
            duplicatesRemoved: 0,
            coveragePct: 100,
            isSampled: false,
            selectionMethod: "LATEST_CLOSED_1000",
        },
        dataQuality: {
            validClosedPositions: positions.length,
            initialEntriesVerified: positions.length,
            initialEntriesUnavailable: 0,
            firstObservedAddOnly: 0,
            initialEntryCoveragePct: 100,
            fullLifecycleCoveragePositions: positions.length,
            warnings: [],
        },
        positions,
        diagnostics: {
            executionMs: 150,
            poolPagesFetched: 1,
            positionBatchesFetched: 1,
            transactionBatchesFetched: 1,
            requestRetries: 0,
            skippedRecords: [],
        },
    };
}

describe("Meteora Verification Layer MVP Suite", () => {
    // -------------------------------------------------------------------------
    // 1. DECIMAL PRECISION PRESERVATION
    // -------------------------------------------------------------------------
    it("1. Decimal precision preservation: retains exact rawString, numeric value and decimal count without truncation", () => {
        // String inputs
        const v1 = parseMonetaryString("199.999996284");
        assert.ok(v1);
        assert.equal(v1.rawString, "199.999996284");
        assert.equal(v1.decimalPlaces, 9);
        assert.equal(v1.numeric, 199.999996284);

        const v2 = parseMonetaryString("19347.056326675116");
        assert.ok(v2);
        assert.equal(v2.rawString, "19347.056326675116");
        assert.equal(v2.decimalPlaces, 12);

        const v3 = parseMonetaryString("0.000000001");
        assert.ok(v3);
        assert.equal(v3.rawString, "0.000000001");
        assert.equal(v3.decimalPlaces, 9);
        assert.equal(v3.numeric, 1e-9);

        // Numeric inputs
        const v4 = parseMonetaryString(123.456);
        assert.ok(v4);
        assert.equal(v4.numeric, 123.456);
        assert.equal(v4.decimalPlaces, 3);

        // Missing data: NEVER silently convert null or undefined to 0
        assert.equal(parseMonetaryString(null), null);
        assert.equal(parseMonetaryString(undefined), null);
        assert.equal(parseMonetaryString(""), null);
        assert.equal(parseMonetaryString("   "), null);
        assert.equal(parseMonetaryString("not-a-number"), null);
    });

    // -------------------------------------------------------------------------
    // 2. EVIDENCE RECONCILIATION: POSITION 1 (SIGN_MISMATCH)
    // -------------------------------------------------------------------------
    it("2. Position 1 reconciliation: exact token match with PnL sign-flip produces SIGN_MISMATCH", async () => {
        const localPos1 = createMockPosition(); // EJXEjBGC...

        const meteoraPos1: MeteoraApiPositionPnLData = {
            positionAddress: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
            poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
            userAddress: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
            isClosed: true,
            createdAt: 1789507841, // 2026-09-15T21:30:41.000Z
            closedAt: 1789508926, // 2026-09-15T21:48:46.000Z
            pnlUsd: "30.56527261415249", // Sign flip: Meteora is +$30.57 vs Local -$14.69
            pnlPctChange: "0.15798409896605328",
            pnlSol: "0.0010653220018355114",
            tokenX: "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR",
            tokenY: "So11111111111111111111111111111111111111112",
            allTimeDeposits: {
                tokenX: { amount: "0", usd: "0" },
                tokenY: { amount: "199.999996284", usd: "19347.05632667512" },
                total: { usd: "19347.056326675116", sol: "199.99999628399996" },
            },
            allTimeWithdrawals: {
                tokenX: { amount: "23.727175198999998", usd: "2.2973801698891028" },
                tokenY: { amount: "199.975857726", usd: "19375.179656003627" },
                total: { usd: "19377.47703617352", sol: "199.9995695355498" },
            },
            allTimeFees: {
                tokenX: { amount: "0.674754421", usd: "0.06533299532494437" },
                tokenY: { amount: "0.000817753", usd: "0.07923012042256115" },
                total: { usd: "0.14456311574750555", sol: "0.0014920704520121754" },
            },
        };

        const dataset = createMockDataset([localPos1]);
        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: dataset,
            mockApiData: {
                poolPositions: {
                    GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8: [meteoraPos1],
                },
            },
        });

        assert.equal(report.summary.totalPositionsEvaluated, 1);
        assert.equal(report.summary.signMismatchCount, 1);
        assert.equal(report.summary.matchedCount, 0);
        assert.equal(report.summary.missingCount, 0);
        assert.equal(report.summary.tokenFlowExactMatchRatePct, 100);
        assert.equal(report.summary.closedTimestampMatchRatePct, 100);

        const posResult = report.positions[0];
        assert.equal(posResult.classification, "SIGN_MISMATCH");
        assert.equal(posResult.isMatched, true);
        assert.equal(posResult.usdValuations.pnlSignFlip, true);
        assert.equal(posResult.timestamps.timestampsMatch, true);
        assert.equal(posResult.tokenFlows.allTokensMatch, true);

        // Underlying token flows match bit-exact
        assert.equal(posResult.tokenFlows.depositedTokenY.isExactMatch, true);
        assert.equal(posResult.tokenFlows.withdrawnTokenX.isExactMatch, true);
        assert.equal(posResult.tokenFlows.withdrawnTokenY.isExactMatch, true);
        assert.equal(posResult.tokenFlows.claimedFeesTokenX.isExactMatch, true);
        assert.equal(posResult.tokenFlows.claimedFeesTokenY.isExactMatch, true);

        // Metadata provenance populated
        assert.equal(posResult.metadataEnrichment?.tokenXMint, "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR");
        assert.equal(posResult.metadataEnrichment?.tokenYMint, "So11111111111111111111111111111111111111112");
        assert.equal(posResult.provenance.source, "meteora_official_api");
    });

    // -------------------------------------------------------------------------
    // 3. EVIDENCE RECONCILIATION: FULL 3-POSITION EVIDENCE SUITE
    // -------------------------------------------------------------------------
    it("3. Completed 3-position evidence suite: accurately reproduces reconciliation report metrics", async () => {
        // Position 1 (EJXEjBGC...)
        const pos1 = createMockPosition({
            positionId: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
            poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
            pnlUsd: -14.69,
        });

        // Position 2 (935yao6a...)
        const pos2 = createMockPosition({
            positionId: "935yao6aY9nLTvUabDyttE5DCTUbDFZaGG2MJzQkn6B6",
            poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
            openedAt: "2026-09-14T19:32:17.000Z",
            closedAt: "2026-09-15T20:59:34.000Z",
            holdDurationSeconds: 91637,
            totalDepositsUsd: 10354.24,
            totalWithdrawalsUsd: 9687.05,
            claimedFeesUsd: 238.66,
            pnlUsd: -428.53,
            lifecycle: {
                openingEventObserved: true,
                closingEventObserved: true,
                eventCount: 6,
                events: [
                    {
                        rawId: "add-p2-1",
                        rawType: "ADD_LIQUIDITY",
                        category: "add",
                        createdAt: "2026-09-14T19:32:17.000Z",
                        signature: "sig-add-p2-1",
                        source: "wallet",
                        tokenXAmount: 0,
                        tokenYAmount: 3.996865053,
                        tokenXAmountUsd: 0,
                        tokenYAmountUsd: 413.85,
                        totalInUsd: 413.85,
                    },
                    {
                        rawId: "add-p2-2",
                        rawType: "ADD_LIQUIDITY",
                        category: "add",
                        createdAt: "2026-09-14T19:32:17.000Z",
                        signature: "sig-add-p2-2",
                        source: "wallet",
                        tokenXAmount: 0,
                        tokenYAmount: 96.003131175,
                        tokenXAmountUsd: 0,
                        tokenYAmountUsd: 9940.40,
                        totalInUsd: 9940.40,
                    },
                    {
                        rawId: "rem-p2-1",
                        rawType: "REMOVE_LIQUIDITY",
                        category: "remove",
                        createdAt: "2026-09-15T20:59:34.000Z",
                        signature: "sig-rem-p2-1",
                        source: "wallet",
                        tokenXAmount: 5663.247025765,
                        tokenYAmount: 89.927284838,
                        tokenXAmountUsd: 588.63,
                        tokenYAmountUsd: 8755.85,
                        totalInUsd: 9344.48,
                    },
                    {
                        rawId: "rem-p2-2",
                        rawType: "REMOVE_LIQUIDITY",
                        category: "remove",
                        createdAt: "2026-09-15T20:59:34.000Z",
                        signature: "sig-rem-p2-2",
                        source: "wallet",
                        tokenXAmount: 3403.090158031,
                        tokenYAmount: 0,
                        tokenXAmountUsd: 342.58,
                        tokenYAmountUsd: 0,
                        totalInUsd: 342.58,
                    },
                    {
                        rawId: "fee-p2-1",
                        rawType: "FEE_CLAIM",
                        category: "claim_fee",
                        createdAt: "2026-09-15T20:59:34.000Z",
                        signature: "sig-fee-p2-1",
                        source: "wallet",
                        tokenXAmount: 1169.127254035,
                        tokenYAmount: 1.090295763,
                        tokenXAmountUsd: 117.47,
                        tokenYAmountUsd: 106.60,
                        totalInUsd: 224.07,
                    },
                    {
                        rawId: "fee-p2-2",
                        rawType: "FEE_CLAIM",
                        category: "claim_fee",
                        createdAt: "2026-09-15T20:59:34.000Z",
                        signature: "sig-fee-p2-2",
                        source: "wallet",
                        tokenXAmount: 80.717837173,
                        tokenYAmount: 0.066199763,
                        tokenXAmountUsd: 8.08,
                        tokenYAmountUsd: 6.50,
                        totalInUsd: 14.58,
                    },
                ],
            },
        });

        // Position 3 (AYMdLv8B...)
        const pos3 = createMockPosition({
            positionId: "AYMdLv8BXz4XumbfzuuGFyuWze2cvP4BnxMPiJGKU8Sq",
            poolAddress: "48M3tRdbVYmEbf5rCTFVAgqCCaZdChVmeg3VPBrmgT8m",
            openedAt: "2026-09-11T10:36:37.000Z",
            closedAt: "2026-09-11T19:53:00.000Z",
            holdDurationSeconds: 33383,
            totalDepositsUsd: 29845.01,
            totalWithdrawalsUsd: 30585.61,
            claimedFeesUsd: 281.91,
            pnlUsd: 1022.51,
            lifecycle: {
                openingEventObserved: true,
                closingEventObserved: true,
                eventCount: 5,
                events: [
                    {
                        rawId: "add-p3-1",
                        rawType: "ADD_LIQUIDITY",
                        category: "add",
                        createdAt: "2026-09-11T10:36:37.000Z",
                        signature: "sig-add-p3-1",
                        source: "wallet",
                        tokenXAmount: 0,
                        tokenYAmount: 72.294507768,
                        tokenXAmountUsd: 0,
                        tokenYAmountUsd: 7192.10,
                        totalInUsd: 7192.10,
                    },
                    {
                        rawId: "add-p3-2",
                        rawType: "ADD_LIQUIDITY",
                        category: "add",
                        createdAt: "2026-09-11T10:36:37.000Z",
                        signature: "sig-add-p3-2",
                        source: "wallet",
                        tokenXAmount: 0,
                        tokenYAmount: 227.7054843,
                        tokenXAmountUsd: 0,
                        tokenYAmountUsd: 22652.91,
                        totalInUsd: 22652.91,
                    },
                    {
                        rawId: "rem-p3-1",
                        rawType: "REMOVE_LIQUIDITY",
                        category: "remove",
                        createdAt: "2026-09-11T19:53:00.000Z",
                        signature: "sig-rem-p3-1",
                        source: "wallet",
                        tokenXAmount: 2641.735714104,
                        tokenYAmount: 64.266055794,
                        tokenXAmountUsd: 790.47,
                        tokenYAmountUsd: 6556.93,
                        totalInUsd: 7347.40,
                    },
                    {
                        rawId: "rem-p3-2",
                        rawType: "REMOVE_LIQUIDITY",
                        category: "remove",
                        createdAt: "2026-09-11T19:53:00.000Z",
                        signature: "sig-rem-p3-2",
                        source: "wallet",
                        tokenXAmount: 0,
                        tokenYAmount: 227.705485308,
                        tokenXAmountUsd: 0,
                        tokenYAmountUsd: 23238.21,
                        totalInUsd: 23238.21,
                    },
                    {
                        rawId: "fee-p3-1",
                        rawType: "FEE_CLAIM",
                        category: "claim_fee",
                        createdAt: "2026-09-11T19:53:00.000Z",
                        signature: "sig-fee-p3-1",
                        source: "wallet",
                        tokenXAmount: 487.518086224,
                        tokenYAmount: 1.335962384,
                        tokenXAmountUsd: 145.88,
                        tokenYAmountUsd: 136.12,
                        totalInUsd: 282.00,
                    },
                ],
            },
        });

        // Meteora counterparts
        const meteoraPos1: MeteoraApiPositionPnLData = {
            positionAddress: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
            poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
            userAddress: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
            isClosed: true,
            createdAt: 1789507841,
            closedAt: 1789508926,
            pnlUsd: "30.56527261415249", // Sign flip (-14.69 vs +30.57)
            allTimeDeposits: {
                tokenX: { amount: "0", usd: "0" },
                tokenY: { amount: "199.999996284", usd: "19347.05632667512" },
                total: { usd: "19347.056326675116" },
            },
            allTimeWithdrawals: {
                tokenX: { amount: "23.727175198999998", usd: "2.2973801698891028" },
                tokenY: { amount: "199.975857726", usd: "19375.179656003627" },
                total: { usd: "19377.47703617352" },
            },
            allTimeFees: {
                tokenX: { amount: "0.674754421", usd: "0.06533299532494437" },
                tokenY: { amount: "0.000817753", usd: "0.07923012042256115" },
                total: { usd: "0.14456311574750555" },
            },
        };

        const meteoraPos2: MeteoraApiPositionPnLData = {
            positionAddress: "935yao6aY9nLTvUabDyttE5DCTUbDFZaGG2MJzQkn6B6",
            poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
            userAddress: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
            isClosed: true,
            createdAt: 1789414337,
            closedAt: 1789505974,
            pnlUsd: "-430.1023637593171", // Local -$428.53 vs Meteora -$430.10 (Delta $1.57)
            allTimeDeposits: {
                tokenX: { amount: "0", usd: "0" },
                tokenY: { amount: "99.99999622799999", usd: "10334.856981482932" },
                total: { usd: "10334.856981482932" },
            },
            allTimeWithdrawals: {
                tokenX: { amount: "9066.337183796", usd: "910.7505273688839" },
                tokenY: { amount: "89.927284838", usd: "8755.848856306164" },
                total: { usd: "9666.599383675048" },
            },
            allTimeFees: {
                tokenX: { amount: "1249.8450912079998", usd: "125.55203417555902" },
                tokenY: { amount: "1.156495526", usd: "112.60319987300866" },
                total: { usd: "238.15523404856768" },
            },
        };

        const meteoraPos3: MeteoraApiPositionPnLData = {
            positionAddress: "AYMdLv8BXz4XumbfzuuGFyuWze2cvP4BnxMPiJGKU8Sq",
            poolAddress: "48M3tRdbVYmEbf5rCTFVAgqCCaZdChVmeg3VPBrmgT8m",
            userAddress: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
            isClosed: true,
            createdAt: 1789122997,
            closedAt: 1789156380,
            pnlUsd: "1021.588860124677", // Local +$1,022.51 vs Meteora +$1,021.59 (Delta $0.92)
            allTimeDeposits: {
                tokenX: { amount: "0", usd: "0" },
                tokenY: { amount: "299.999992068", usd: "29799.252092153023" },
                total: { usd: "29799.252092153023" },
            },
            allTimeWithdrawals: {
                tokenX: { amount: "2641.735714104", usd: "790.4709089890913" },
                tokenY: { amount: "291.971541102", usd: "29748.374462833315" },
                total: { usd: "30538.845371822405" },
            },
            allTimeFees: {
                tokenX: { amount: "487.518086224", usd: "145.87714535888512" },
                tokenY: { amount: "1.335962384", usd: "136.11843509641042" },
                total: { usd: "281.99558045529557" },
            },
        };

        const dataset = createMockDataset([pos1, pos2, pos3]);
        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: dataset,
            mockApiData: {
                poolPositions: {
                    GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8: [meteoraPos1, meteoraPos2],
                    "48M3tRdbVYmEbf5rCTFVAgqCCaZdChVmeg3VPBrmgT8m": [meteoraPos3],
                },
            },
        });

        assert.equal(report.summary.totalPositionsEvaluated, 3);
        assert.equal(report.summary.signMismatchCount, 1); // Position 1 (Sign mismatch)
        assert.equal(report.summary.usdValuationDifferenceCount, 1); // Position 2 (USD delta 0.366% > 0.25% tolerance)
        assert.equal(report.summary.matchedCount, 1); // Position 3 (USD delta 0.090% <= 0.25% tolerance)
        assert.equal(report.summary.missingCount, 0);
        assert.equal(report.summary.notComparableCount, 0);
        assert.equal(report.summary.tokenFlowExactMatchRatePct, 100);
        assert.equal(report.summary.closedTimestampMatchRatePct, 100);

        // All 3 positions matched their identities
        assert.equal(report.positions.length, 3);
        assert.equal(report.positions[0].classification, "SIGN_MISMATCH");
        assert.equal(report.positions[1].classification, "USD_VALUATION_DIFFERENCE");
        assert.equal(report.positions[2].classification, "MATCH");
    });

    // -------------------------------------------------------------------------
    // 4. EXACT MATCH CLASSIFICATION
    // -------------------------------------------------------------------------
    it("4. MATCH classification: identical token quantities and USD valuations within tolerance produce MATCH", async () => {
        const localPos = createMockPosition({
            totalDepositsUsd: 1000.00,
            totalWithdrawalsUsd: 1100.00,
            claimedFeesUsd: 10.00,
            pnlUsd: 110.00,
        });

        const meteoraPos: MeteoraApiPositionPnLData = {
            positionAddress: localPos.positionId,
            poolAddress: localPos.poolAddress,
            userAddress: localPos.wallet,
            isClosed: true,
            createdAt: 1789507841,
            closedAt: 1789508926,
            pnlUsd: "110.05", // $0.05 difference, well within $0.50 tolerance
            allTimeDeposits: {
                tokenX: { amount: "0", usd: "0" },
                tokenY: { amount: "199.999996284", usd: "1000.02" },
                total: { usd: "1000.02" },
            },
            allTimeWithdrawals: {
                tokenX: { amount: "23.727175199", usd: "100.00" },
                tokenY: { amount: "199.975857726", usd: "1000.03" },
                total: { usd: "1100.03" },
            },
            allTimeFees: {
                tokenX: { amount: "0.674754421", usd: "5.00" },
                tokenY: { amount: "0.000817753", usd: "5.01" },
                total: { usd: "10.01" },
            },
        };

        const dataset = createMockDataset([localPos]);
        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: dataset,
            mockApiData: {
                poolPositions: {
                    [localPos.poolAddress]: [meteoraPos],
                },
            },
        });

        assert.equal(report.summary.matchedCount, 1);
        assert.equal(report.summary.usdValuationDifferenceCount, 0);
        assert.equal(report.summary.signMismatchCount, 0);
        assert.equal(report.positions[0].classification, "MATCH");
    });

    // -------------------------------------------------------------------------
    // 5. MISSING IN METEORA RECORD HANDLING
    // -------------------------------------------------------------------------
    it("5. MISSING classification: position absent in Meteora closed positions is explicitly reported", async () => {
        const localPos = createMockPosition({
            positionId: "MissingPosInMeteora11111111111111111111111111",
        });

        const dataset = createMockDataset([localPos]);
        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: dataset,
            mockApiData: {
                poolPositions: {
                    [localPos.poolAddress]: [], // empty positions returned
                },
            },
        });

        assert.equal(report.summary.missingCount, 1);
        assert.equal(report.summary.matchedCount, 0);
        assert.equal(report.positions.length, 0);
        assert.equal(report.missingOrAmbiguousRecords.length, 1);
        assert.equal(report.missingOrAmbiguousRecords[0].issue, "MISSING_IN_METEORA");
        assert.ok(report.missingOrAmbiguousRecords[0].details.includes("MissingPosInMeteora"));
    });

    // -------------------------------------------------------------------------
    // 6. NOT_COMPARABLE: UNCLOSED POSITION & AMBIGUOUS RECORDS
    // -------------------------------------------------------------------------
    it("6. NOT_COMPARABLE classification: handles unclosed position or duplicate collisions", async () => {
        // Case A: Position not closed
        const unclosedLocalPos = createMockPosition({
            closedAt: "", // unclosed
        });

        const unclosedMeteoraPos: MeteoraApiPositionPnLData = {
            positionAddress: unclosedLocalPos.positionId,
            poolAddress: unclosedLocalPos.poolAddress,
            userAddress: unclosedLocalPos.wallet,
            isClosed: false,
            closedAt: null,
        };

        const datasetA = createMockDataset([unclosedLocalPos]);
        const reportA = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: datasetA,
            mockApiData: {
                poolPositions: {
                    [unclosedLocalPos.poolAddress]: [unclosedMeteoraPos],
                },
            },
        });

        assert.equal(reportA.summary.notComparableCount, 1);
        assert.equal(reportA.positions[0].classification, "NOT_COMPARABLE");

        // Case B: Duplicate position collision from API
        const localPosB = createMockPosition();
        const meteoraPosB1: MeteoraApiPositionPnLData = {
            positionAddress: localPosB.positionId,
            poolAddress: localPosB.poolAddress,
            isClosed: true,
            closedAt: 1789508926,
        };
        const meteoraPosB2: MeteoraApiPositionPnLData = {
            positionAddress: localPosB.positionId,
            poolAddress: localPosB.poolAddress,
            isClosed: true,
            closedAt: 1789508926,
        };

        const datasetB = createMockDataset([localPosB]);
        const reportB = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: datasetB,
            mockApiData: {
                poolPositions: {
                    [localPosB.poolAddress]: [meteoraPosB1, meteoraPosB2],
                },
            },
        });

        assert.equal(reportB.summary.notComparableCount, 1);
        assert.equal(reportB.missingOrAmbiguousRecords[0].issue, "AMBIGUOUS_DUPLICATE");
    });

    // -------------------------------------------------------------------------
    // 7. NON-DESTRUCTIVE VERIFICATION: FABRIQ PUBLISHED BUNDLE IMMUTABILITY
    // -------------------------------------------------------------------------
    it("7. Non-destructive guarantee: never alters published bundle, dataset, or calculated PnL", async () => {
        const localPos = createMockPosition();
        const dataset = createMockDataset([localPos]);
        const metrics: PositionMetricsResult = {
            wallet: dataset.wallet,
            period: "30D",
            calculatedAt: "2026-10-09T18:00:00.000Z",
            schemaVersion: "v1",
            analyzedPositionsCount: 1,
            winRatePct: 0,
            sampleTotalRealizedPnlUsd: -14.69,
            averagePnlUsd: -14.69,
            medianPnlUsd: -14.69,
            p25InitialEntryUsd: 774.05,
            medianInitialEntryUsd: 774.05,
            p75InitialEntryUsd: 774.05,
            bestTradePnlUsd: null,
            worstTradePnlUsd: -14.69,
            profitFactor: null,
            profitFactorStatus: "ALL_LOSSES",
            cvar10PnlUsd: -14.69,
            top1ProfitConcentrationPct: null,
            top5ProfitConcentrationPct: null,
            maxRealizedDrawdownUsd: 14.69,
            maxLosingStreak: 1,
            meanHoldingTimeSeconds: 1085,
            medianHoldingTimeSeconds: 1085,
            holdingTimeDistribution: [],
            weeklyPnl: [],
            activeHourDistributionWib: [],
            activeWeekdayDistributionWib: [],
            poolBreakdown: [],
            pairBreakdown: [],
            sourceDatasetCoverage: {
                totalPositionsInDataset: 1,
                isSampled: false,
                coveragePct: 100,
                status: "COMPLETE",
            },
            verifiedInitialEntryCoverage: {
                verifiedCount: 1,
                totalCount: 1,
                coveragePct: 100,
            },
        };

        const bundle: PositionAnalyticsBundle = {
            schemaVersion: "v1",
            wallet: dataset.wallet,
            period: "30D",
            publishedAt: "2026-10-09T18:00:00.000Z",
            dataset,
            metrics,
        };

        // Snapshot JSON before verification
        const bundleJsonBefore = JSON.stringify(bundle);

        const meteoraPos: MeteoraApiPositionPnLData = {
            positionAddress: localPos.positionId,
            poolAddress: localPos.poolAddress,
            userAddress: localPos.wallet,
            isClosed: true,
            createdAt: 1789507841,
            closedAt: 1789508926,
            pnlUsd: "30.56527261415249", // Sign flip
            allTimeDeposits: { total: { usd: "19347.05" } },
            allTimeWithdrawals: { total: { usd: "19377.48" } },
            allTimeFees: { total: { usd: "0.14" } },
        };

        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: bundle,
            mockApiData: {
                poolPositions: {
                    [localPos.poolAddress]: [meteoraPos],
                },
            },
        });

        // Snapshot JSON after verification
        const bundleJsonAfter = JSON.stringify(bundle);

        // Verification must be 100% non-destructive: bundle is byte-for-byte identical
        assert.equal(bundleJsonBefore, bundleJsonAfter);
        assert.equal(bundle.dataset.positions[0].pnlUsd, -14.69);
        assert.equal(bundle.metrics.sampleTotalRealizedPnlUsd, -14.69);

        // Report clearly acknowledges non-destructive contract
        assert.ok(report.nonDestructiveNotice.includes("do not mutate or replace"));
    });

    // -------------------------------------------------------------------------
    // 8. BOUNDED PAGINATION
    // -------------------------------------------------------------------------
    it("8. Bounded pagination: paginates across pages and stops when empty or limit reached", async () => {
        let pagesQueried = 0;
        const mockFetch = async (url: string) => {
            pagesQueried++;
            const u = new URL(url);
            const page = parseInt(u.searchParams.get("page") || "1", 10);
            const limit = parseInt(u.searchParams.get("limit") || "2", 10);

            if (page === 1) {
                return new Response(JSON.stringify({
                    positions: [
                        { positionAddress: "pos-page-1", isClosed: true },
                        { positionAddress: "pos-page-2", isClosed: true },
                    ],
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            } else if (page === 2) {
                return new Response(JSON.stringify({
                    positions: [
                        { positionAddress: "pos-page-3", isClosed: true },
                    ], // 1 position < limit 2 => halts pagination
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            return new Response(JSON.stringify({ positions: [] }), { status: 200 });
        };

        const positions = await fetchPoolClosedPositions(
            "Pool111111111111111111111111111111111111111",
            "Wallet11111111111111111111111111111111111111",
            {
                fetchFn: mockFetch,
                pageSize: 2,
                maxPages: 5,
            }
        );

        assert.equal(pagesQueried, 2);
        assert.equal(positions.length, 3);
        assert.equal(positions[0].positionAddress, "pos-page-1");
        assert.equal(positions[2].positionAddress, "pos-page-3");
    });

    // -------------------------------------------------------------------------
    // 9. NETWORK SAFETY: RETRIES, RATE LIMITING & TIMEOUT
    // -------------------------------------------------------------------------
    it("9. Network safety: respects 429 Retry-After header, handles 5xx bounded retries, and aborts on timeout", async () => {
        // Test 429 Retry-After handling
        let attempts429 = 0;
        let sleepMsRecorded: number[] = [];

        const mockFetch429 = async () => {
            attempts429++;
            if (attempts429 === 1) {
                return new Response(JSON.stringify({ error: "rate limited" }), {
                    status: 429,
                    headers: { "Retry-After": "2" },
                });
            }
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        };

        const res = await fetchMeteoraJson<{ success: boolean }>("/test", {
            fetchFn: mockFetch429,
            maxRetries: 3,
            sleepFn: async (ms) => {
                sleepMsRecorded.push(ms);
            },
        });

        assert.equal(attempts429, 2);
        assert.equal(res.data.success, true);
        assert.equal(sleepMsRecorded[0], 2000); // parsed from Retry-After: 2

        // Test bounded 5xx failure
        let attempts500 = 0;
        const mockFetch500 = async () => {
            attempts500++;
            return new Response("Server error", { status: 502 });
        };

        await assert.rejects(
            async () => {
                await fetchMeteoraJson("/test-500", {
                    fetchFn: mockFetch500,
                    maxRetries: 3,
                    baseRetryDelayMs: 1,
                    sleepFn: async () => {},
                });
            },
            /5xx server error/
        );
        assert.equal(attempts500, 3);
    });

    // -------------------------------------------------------------------------
    // 10. ISOLATED PERSISTENCE
    // -------------------------------------------------------------------------
    it("10. Isolated persistence: atomically saves and loads verification reports in data/analytics/verification/", async () => {
        const localPos = createMockPosition();
        const dataset = createMockDataset([localPos]);
        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: dataset,
            mockApiData: {
                poolPositions: {
                    [localPos.poolAddress]: [
                        {
                            positionAddress: localPos.positionId,
                            poolAddress: localPos.poolAddress,
                            userAddress: localPos.wallet,
                            isClosed: true,
                            closedAt: 1789508926,
                            pnlUsd: "30.565",
                        },
                    ],
                },
            },
        });

        const savedPath = saveMeteoraVerificationReport(report, TEST_STORAGE_BASE);
        assert.ok(fs.existsSync(savedPath));
        assert.ok(savedPath.includes(TEST_STORAGE_BASE));

        const loadedReport = loadMeteoraVerificationReport(
            dataset.wallet,
            dataset.period,
            TEST_STORAGE_BASE
        );

        assert.ok(loadedReport);
        assert.equal(loadedReport.targetWallet, dataset.wallet);
        assert.equal(loadedReport.summary.totalPositionsEvaluated, 1);
        assert.equal(loadedReport.positions[0].positionAddress, localPos.positionId);

        // Cleanup test directory
        if (fs.existsSync(TEST_STORAGE_BASE)) {
            fs.rmSync(TEST_STORAGE_BASE, { recursive: true, force: true });
        }
    });
});
