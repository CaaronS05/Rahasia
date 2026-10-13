import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { PnlPoint, Wallet } from "../../frontend/src/types.ts";
import {
    computePeriodCumulativePnl,
    extractNormalizedDailyPnl,
    filterDailyPnlByTimeframe,
    type ChartTimeframe,
    type NormalizedDailyPnlPoint,
    type CumulativePnlPoint,
} from "../../frontend/src/lib/walletMetrics.ts";
import {
    compareNullableNumbers,
    compareNullableStrings,
    compareWalletMetricValues,
    compareWallets,
    countUnknownActivityWallets,
    defaultSortKeyForTimeframe,
    derivedOrFallback,
    extractWalletActivityDates,
    formatNativeWinRate,
    formatNumberMetric,
    formatPercentMetric,
    formatSolPnl,
    formatUsdMetric,
    getWalletActivityStatus,
    isWalletTimeframeEligible,
    paginateWallets,
    pnlColorClass,
    resolveReferenceDate,
    resolveSortKeyForTimeframeChange,
    shiftUtcDays,
    sortWallets,
    toFiniteNumber,
    walletAgeMs,
    walletAllTimePnl,
    walletEffectiveFirstActivity,
    walletEffectiveLastActivity,
    walletLastActivityTimestamp,
    walletMonthlyPnl,
    walletPnl30d,
    walletPnl7d,
    walletPositions,
    walletSortValue,
    walletTimeframePnl,
    walletWinDays,
    walletLoseDays,
    walletWinRatePercent,
    type WalletSortKey,
} from "../../frontend/src/lib/walletMetrics.ts";
import {
    formatUsd,
    formatPct,
} from "../../frontend/src/lib/poolInsight.ts";

const REF_DATE = "2026-10-11";

describe("Wallet Explorer Timeframe Filtering Suite", () => {
    // -------------------------------------------------------------------------
    // 1. ACCEPTANCE CRITERIA: WALLET A, B, C, D ELIGIBILITY
    // -------------------------------------------------------------------------
    it("1. Acceptance Criteria: Wallet A, B, C, D eligibility matches specified rules", () => {
        // Wallet A: last active 2 days ago (2026-10-09)
        const walletA: Wallet = {
            owner: "WalletA_2DaysAgo",
            chain: "SOL",
            protocol: "meteora",
            last_activity: "2026-10-09T14:30:00.000Z",
            total_pnl_native_7d: 5.2,
            total_pnl_native_30d: 12.0,
            total_pnl_native: 25.0,
        };

        // Wallet B: last active 20 days ago (2026-09-21)
        const walletB: Wallet = {
            owner: "WalletB_20DaysAgo",
            chain: "SOL",
            protocol: "meteora",
            last_activity: "2026-09-21T09:00:00.000Z",
            total_pnl_native_7d: 0,
            total_pnl_native_30d: 8.5,
            total_pnl_native: 18.0,
        };

        // Wallet C: last active 70 days ago (2026-08-02)
        const walletC: Wallet = {
            owner: "WalletC_70DaysAgo",
            chain: "SOL",
            protocol: "meteora",
            last_activity: "2026-08-02T16:00:00.000Z",
            total_pnl_native_7d: 0,
            total_pnl_native_30d: 0,
            total_pnl_native: 40.0,
        };

        // Wallet D: has no verifiable activity timestamp
        const walletD: Wallet = {
            owner: "WalletD_NoActivityTimestamp",
            chain: "SOL",
            protocol: "meteora",
            last_activity: null,
            first_activity: null,
            total_pnl_native_7d: null,
            total_pnl_native_30d: null,
            total_pnl_native: null,
        };

        // Wallet A: Included in 7D, 30D, ALL
        assert.equal(isWalletTimeframeEligible(walletA, "7d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(walletA, "30d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(walletA, "all", REF_DATE), true);
        assert.equal(getWalletActivityStatus(walletA, "7d", REF_DATE), "CONFIRMED_ACTIVE");

        // Wallet B: Excluded from 7D, Included in 30D, ALL
        assert.equal(isWalletTimeframeEligible(walletB, "7d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(walletB, "30d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(walletB, "all", REF_DATE), true);
        assert.equal(getWalletActivityStatus(walletB, "7d", REF_DATE), "NO_ACTIVITY");
        assert.equal(getWalletActivityStatus(walletB, "30d", REF_DATE), "CONFIRMED_ACTIVE");

        // Wallet C: Included only in ALL (Excluded from 7D and 30D)
        assert.equal(isWalletTimeframeEligible(walletC, "7d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(walletC, "30d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(walletC, "all", REF_DATE), true);
        assert.equal(getWalletActivityStatus(walletC, "7d", REF_DATE), "NO_ACTIVITY");
        assert.equal(getWalletActivityStatus(walletC, "30d", REF_DATE), "NO_ACTIVITY");

        // Wallet D: Remains in ALL, Not silently classified as active within 7D or 30D
        assert.equal(isWalletTimeframeEligible(walletD, "7d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(walletD, "30d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(walletD, "all", REF_DATE), true);
        assert.equal(getWalletActivityStatus(walletD, "7d", REF_DATE), "UNKNOWN_ACTIVITY");
        assert.equal(getWalletActivityStatus(walletD, "30d", REF_DATE), "UNKNOWN_ACTIVITY");
    });

    // -------------------------------------------------------------------------
    // 2. SNAPSHOT REFERENCE DATE RESOLUTION
    // -------------------------------------------------------------------------
    it("2. Snapshot reference date: resolves derivedAsOfDate, falls back to publishedAt, then today", () => {
        // Priority 1: meta.derivedAsOfDate
        const metaWithDerived = {
            derivedAsOfDate: "2026-10-11",
            publishedAt: "2026-10-10T12:00:00.000Z",
        };
        assert.equal(resolveReferenceDate(metaWithDerived), "2026-10-11");

        // Priority 2: meta.publishedAt when derivedAsOfDate is missing
        const metaWithPublishedOnly = {
            publishedAt: "2026-09-25T08:30:00.000Z",
        };
        assert.equal(resolveReferenceDate(metaWithPublishedOnly), "2026-09-25");

        // Priority 3: Fallback when meta is null or empty
        const fallback = resolveReferenceDate(null);
        assert.match(fallback, /^\d{4}-\d{2}-\d{2}$/);
    });

    // -------------------------------------------------------------------------
    // 3. BOUNDARY TIMESTAMPS
    // -------------------------------------------------------------------------
    it("3. Boundary timestamps: respects exact inclusive 7D and 30D UTC day boundaries", () => {
        // REF_DATE is 2026-10-11
        // 7D window: 7 calendar days inclusive = [2026-10-05, 2026-10-11]
        // 30D window: 30 calendar days inclusive = [2026-09-12, 2026-10-11]
        assert.equal(shiftUtcDays(REF_DATE, -6), "2026-10-05");
        assert.equal(shiftUtcDays(REF_DATE, -29), "2026-09-12");

        // Earliest valid 7D timestamp: 2026-10-05T00:00:00.000Z
        const w7dStart: Wallet = {
            owner: "w7dStart", chain: "SOL", protocol: "meteora",
            last_activity: "2026-10-05T00:00:00.000Z",
        };
        assert.equal(isWalletTimeframeEligible(w7dStart, "7d", REF_DATE), true);

        // 1 millisecond before 7D window: 2026-10-04T23:59:59.999Z (Excluded from 7D, Included in 30D)
        const w7dJustBefore: Wallet = {
            owner: "w7dJustBefore", chain: "SOL", protocol: "meteora",
            last_activity: "2026-10-04T23:59:59.999Z",
        };
        assert.equal(isWalletTimeframeEligible(w7dJustBefore, "7d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(w7dJustBefore, "30d", REF_DATE), true);

        // Latest valid 7D/30D timestamp: 2026-10-11T23:59:59.999Z (Eligible in both)
        const wEnd: Wallet = {
            owner: "wEnd", chain: "SOL", protocol: "meteora",
            last_activity: "2026-10-11T23:59:59.999Z",
        };
        assert.equal(isWalletTimeframeEligible(wEnd, "7d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(wEnd, "30d", REF_DATE), true);

        // Earliest valid 30D timestamp: 2026-09-12T00:00:00.000Z
        const w30dStart: Wallet = {
            owner: "w30dStart", chain: "SOL", protocol: "meteora",
            last_activity: "2026-09-12T00:00:00.000Z",
        };
        assert.equal(isWalletTimeframeEligible(w30dStart, "30d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(w30dStart, "7d", REF_DATE), false);

        // 1 millisecond before 30D window: 2026-09-11T23:59:59.999Z (Excluded from 30D, Included in ALL)
        const w30dJustBefore: Wallet = {
            owner: "w30dJustBefore", chain: "SOL", protocol: "meteora",
            last_activity: "2026-09-11T23:59:59.999Z",
        };
        assert.equal(isWalletTimeframeEligible(w30dJustBefore, "30d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(w30dJustBefore, "all", REF_DATE), true);

        // Timestamp after reference date (future anomaly): outside snapshot window
        const wFuture: Wallet = {
            owner: "wFuture", chain: "SOL", protocol: "meteora",
            last_activity: "2026-10-12T00:00:00.000Z",
        };
        assert.equal(isWalletTimeframeEligible(wFuture, "7d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(wFuture, "30d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(wFuture, "all", REF_DATE), true);
    });

    // -------------------------------------------------------------------------
    // 4. LP AGENT SOURCE ACTIVITY
    // -------------------------------------------------------------------------
    it("4. LP Agent source activity: validates LP Agent last_activity timestamp", () => {
        const lpWallet: Wallet = {
            owner: "LPAgentWallet_Active",
            chain: "SOL",
            protocol: "meteora",
            source: "lpagent",
            last_activity: "2026-10-07T12:00:00.000Z",
            first_activity: "2026-09-01T10:00:00.000Z",
            total_pnl_native_7d: 3.5,
        };

        const activeDates = extractWalletActivityDates(lpWallet);
        assert.equal(activeDates.includes("2026-10-07"), true);
        assert.equal(isWalletTimeframeEligible(lpWallet, "7d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(lpWallet, "30d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(lpWallet, "all", REF_DATE), true);
    });

    // -------------------------------------------------------------------------
    // 5. POOL-ONLY WALLET WITH FABRIQ ACTIVITY
    // -------------------------------------------------------------------------
    it("5. Pool-only wallet with Fabriq activity: qualifies via Fabriq calendar despite null last_activity", () => {
        const poolWalletWithFabriq: Wallet = {
            owner: "PoolWallet_FabriqActive",
            chain: "SOL",
            protocol: "meteora",
            source: "pool-scanner",
            last_activity: null,
            first_activity: null,
            fabriqDerived: {
                asOfDate: "2026-10-11",
                currentMonth: "2026-10",
                pnl7dSol: 1.8,
                pnl30dSol: 4.2,
                monthlyPnlSol: 1.8,
                allTimePnlSol: 10.5,
                daily: [
                    {
                        date: "2026-10-08",
                        pnlSol: 0.5,
                        pnlUsd: 60.0,
                        feesSol: 0.1,
                        feesUsd: 12.0,
                        positions: 12,
                        winRateSol: 80,
                        winRateUsd: 80,
                    },
                ],
            },
        };

        assert.equal(isWalletTimeframeEligible(poolWalletWithFabriq, "7d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(poolWalletWithFabriq, "30d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(poolWalletWithFabriq, "all", REF_DATE), true);
        assert.equal(walletEffectiveLastActivity(poolWalletWithFabriq), "2026-10-08T00:00:00.000Z");
    });

    // -------------------------------------------------------------------------
    // 6. POOL-ONLY WALLET WITHOUT ACTIVITY EVIDENCE
    // -------------------------------------------------------------------------
    it("6. Pool-only wallet without activity evidence: excluded from 7D/30D, retained in ALL, counted in unknown", () => {
        const poolWalletEmpty: Wallet = {
            owner: "PoolWallet_NoFabriq",
            chain: "SOL",
            protocol: "meteora",
            source: "pool-scanner",
            last_activity: null,
            first_activity: null,
            fabriqDerived: undefined,
            fabriq: undefined,
        };

        assert.equal(isWalletTimeframeEligible(poolWalletEmpty, "7d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(poolWalletEmpty, "30d", REF_DATE), false);
        assert.equal(isWalletTimeframeEligible(poolWalletEmpty, "all", REF_DATE), true);
        assert.equal(getWalletActivityStatus(poolWalletEmpty, "7d", REF_DATE), "UNKNOWN_ACTIVITY");
        assert.equal(countUnknownActivityWallets([poolWalletEmpty]), 1);
        assert.equal(walletEffectiveLastActivity(poolWalletEmpty), null);
    });

    // -------------------------------------------------------------------------
    // 7. ZERO AND NEGATIVE PNL
    // -------------------------------------------------------------------------
    it("7. Zero and negative PnL: never disqualifies active wallets", () => {
        // Active wallet with exact zero PnL
        const zeroPnlWallet: Wallet = {
            owner: "ZeroPnlActive",
            chain: "SOL",
            protocol: "meteora",
            last_activity: "2026-10-09T10:00:00.000Z",
            total_pnl_native_7d: 0,
            total_pnl_native_30d: 0,
            total_pnl_native: 0,
        };

        // Active wallet with negative PnL
        const negativePnlWallet: Wallet = {
            owner: "NegativePnlActive",
            chain: "SOL",
            protocol: "meteora",
            last_activity: "2026-10-09T10:00:00.000Z",
            total_pnl_native_7d: -14.8,
            total_pnl_native_30d: -52.3,
            total_pnl_native: -120.0,
        };

        assert.equal(isWalletTimeframeEligible(zeroPnlWallet, "7d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(negativePnlWallet, "7d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(zeroPnlWallet, "30d", REF_DATE), true);
        assert.equal(isWalletTimeframeEligible(negativePnlWallet, "30d", REF_DATE), true);
    });

    // -------------------------------------------------------------------------
    // 8. COMBINED MANUAL FILTERS
    // -------------------------------------------------------------------------
    it("8. Combined manual filters: correctly combines timeframe eligibility with search, minPnl, minWinRate", () => {
        const pool: Wallet[] = [
            {
                owner: "Alice_Qualified", chain: "SOL", protocol: "meteora",
                last_activity: "2026-10-09T00:00:00.000Z",
                total_pnl_native_7d: 10, total_pnl_native_30d: 20, total_pnl_native: 30,
                win_rate_native: 0.8,
            },
            {
                owner: "Bob_LowWinRate", chain: "SOL", protocol: "meteora",
                last_activity: "2026-10-09T00:00:00.000Z",
                total_pnl_native_7d: 15, total_pnl_native_30d: 25, total_pnl_native: 35,
                win_rate_native: 0.2, // 20%
            },
            {
                owner: "Charlie_Inactive7d", chain: "SOL", protocol: "meteora",
                last_activity: "2026-09-20T00:00:00.000Z",
                total_pnl_native_7d: 0, total_pnl_native_30d: 15, total_pnl_native: 25,
                win_rate_native: 0.9,
            },
        ];

        // Filter 7D with minWinRate 50%
        const filtered7d = pool.filter((w) => {
            if (!isWalletTimeframeEligible(w, "7d", REF_DATE)) return false;
            if (walletWinRatePercent(w) < 50) return false;
            return true;
        });

        assert.equal(filtered7d.length, 1);
        assert.equal(filtered7d[0].owner, "Alice_Qualified");

        // Filter 30D with minWinRate 50%
        const filtered30d = pool.filter((w) => {
            if (!isWalletTimeframeEligible(w, "30d", REF_DATE)) return false;
            if (walletWinRatePercent(w) < 50) return false;
            return true;
        });

        assert.equal(filtered30d.length, 2);
        assert.deepEqual(filtered30d.map((w) => w.owner), ["Alice_Qualified", "Charlie_Inactive7d"]);
    });

    // -------------------------------------------------------------------------
    // 9. TIMEFRAME-SPECIFIC SORTING & METRICS
    // -------------------------------------------------------------------------
    it("9. Timeframe-specific sorting: correctly resolves timeframe PnL values for sorting", () => {
        const w1: Wallet = {
            owner: "W1", chain: "SOL", protocol: "meteora",
            last_activity: "2026-10-09T00:00:00.000Z",
            total_pnl_native_7d: 5, total_pnl_native_30d: 50, total_pnl_native: 100,
        };
        const w2: Wallet = {
            owner: "W2", chain: "SOL", protocol: "meteora",
            last_activity: "2026-10-09T00:00:00.000Z",
            total_pnl_native_7d: 20, total_pnl_native_30d: 30, total_pnl_native: 80,
        };

        // In 7D, W2 (20) > W1 (5)
        assert.equal((walletPnl7d(w2) ?? 0) > (walletPnl7d(w1) ?? 0), true);

        // In 30D, W1 (50) > W2 (30)
        assert.equal((walletPnl30d(w1) ?? 0) > (walletPnl30d(w2) ?? 0), true);

        // In ALL, W1 (100) > W2 (80)
        assert.equal((walletAllTimePnl(w1) ?? 0) > (walletAllTimePnl(w2) ?? 0), true);
    });

    // -------------------------------------------------------------------------
    // 10. REAL DATASET POPULATION AND EXPORT CONSISTENCY
    // -------------------------------------------------------------------------
    it("10. Local published dataset: 7D count <= 30D count <= ALL count with zero unknown", () => {
        const datasetPath = path.resolve("frontend/public/data/wallets-14d.json");
        const raw = fs.readFileSync(datasetPath, "utf8");
        const dataset = JSON.parse(raw);
        const wallets: Wallet[] = dataset.wallets;
        const refDate = resolveReferenceDate(dataset.meta);

        // Derive expected reference date from metadata with documented fallback:
        // 1) meta.derivedAsOfDate, 2) meta.publishedAt (YYYY-MM-DD), 3) today
        const expectedRefDate =
            dataset.meta?.derivedAsOfDate && /^\d{4}-\d{2}-\d{2}$/.test(dataset.meta.derivedAsOfDate)
                ? dataset.meta.derivedAsOfDate
                : dataset.meta?.publishedAt
                  ? new Date(Date.parse(dataset.meta.publishedAt)).toISOString().slice(0, 10)
                  : new Date().toISOString().slice(0, 10);
        assert.equal(refDate, expectedRefDate);

        // Derive expected wallet count from loaded snapshot's unique owners
        const uniqueOwners = new Set(wallets.map((w) => w.owner));
        const expectedWalletCount = uniqueOwners.size;
        assert.equal(wallets.length, expectedWalletCount);
        if (typeof dataset.meta?.totalUniqueWallets === "number") {
            assert.equal(dataset.meta.totalUniqueWallets, expectedWalletCount);
        }

        const eligible7d = wallets.filter((w) => isWalletTimeframeEligible(w, "7d", refDate));
        const eligible30d = wallets.filter((w) => isWalletTimeframeEligible(w, "30d", refDate));
        const eligibleAll = wallets.filter((w) => isWalletTimeframeEligible(w, "all", refDate));
        const unknownCount = countUnknownActivityWallets(wallets);

        assert.equal(eligibleAll.length, expectedWalletCount);
        assert.equal(unknownCount, 0);

        // Invariant: 7D count <= 30D count <= ALL count
        assert.equal(eligible7d.length <= eligible30d.length, true);
        assert.equal(eligible30d.length <= eligibleAll.length, true);

        // Strict subset invariants: 7D is a subset of 30D, and 30D is a subset of ALL
        const eligible30dSet = new Set(eligible30d.map((w) => w.owner));
        for (const w of eligible7d) {
            assert.ok(eligible30dSet.has(w.owner), `7D eligible wallet ${w.owner} must be in 30D set`);
        }
        const eligibleAllSet = new Set(eligibleAll.map((w) => w.owner));
        for (const w of eligible30d) {
            assert.ok(eligibleAllSet.has(w.owner), `30D eligible wallet ${w.owner} must be in ALL set`);
        }

        // Simulated CSV Export row count consistency
        const csvRows7d = eligible7d.map((w) => `${w.owner},${walletPnl7d(w)}`);
        assert.equal(csvRows7d.length, eligible7d.length);

        const csvRows30d = eligible30d.map((w) => `${w.owner},${walletPnl30d(w)}`);
        assert.equal(csvRows30d.length, eligible30d.length);
    });

    // -------------------------------------------------------------------------
    // 11. STEP 3A: PORTFOLIO PNL COLOR SEMANTICS & FORMATTING
    // -------------------------------------------------------------------------
    it("11. PnL color semantics & formatting: positive -> green, negative -> red, zero -> neutral, null/missing -> '—' neutral", () => {
        // Color class semantics
        assert.equal(pnlColorClass(12.34), "positive");
        assert.equal(pnlColorClass(0.0001), "positive");
        assert.equal(pnlColorClass(-0.31), "negative");
        assert.equal(pnlColorClass(-100), "negative");
        assert.equal(pnlColorClass(0), "");
        assert.equal(pnlColorClass(-0), "");
        assert.equal(pnlColorClass(null), "");
        assert.equal(pnlColorClass(undefined), "");
        assert.equal(pnlColorClass(NaN), "");
        assert.equal(pnlColorClass(""), "");

        // SOL PnL formatting (7D, 30D, All-time summary & card subtitle)
        assert.equal(formatSolPnl(12.345, 2), "+12.35 SOL");
        assert.equal(formatSolPnl(-0.3123, 2), "-0.31 SOL");
        assert.equal(formatSolPnl(0, 2), "0 SOL");
        assert.equal(formatSolPnl(-0, 2), "0 SOL");
        assert.equal(formatSolPnl(null, 2), "—");
        assert.equal(formatSolPnl(undefined, 2), "—");

        assert.equal(formatSolPnl(2.833, 2, "SOL all-time"), "+2.83 SOL all-time");
        assert.equal(formatSolPnl(-1.25, 2, "SOL all-time"), "-1.25 SOL all-time");
        assert.equal(formatSolPnl(0, 2, "SOL all-time"), "0 SOL all-time");
        assert.equal(formatSolPnl(null, 2, "SOL all-time"), "—");

        // USD PnL formatting
        assert.equal(formatUsdMetric(137.2879, 0), "$137");
        assert.equal(formatUsdMetric(137.2879, 2), "$137.29");
        assert.equal(formatUsdMetric(-50.4, 0), "-$50");
        assert.equal(formatUsdMetric(-50.4, 2), "-$50.40");
        assert.equal(formatUsdMetric(0, 0), "$0");
        assert.equal(formatUsdMetric(0, 2), "$0.00");
        assert.equal(formatUsdMetric(null, 0), "—");
        assert.equal(formatUsdMetric(undefined, 2), "—");
    });

    // -------------------------------------------------------------------------
    // 12. STEP 3A: DERIVED OR FALLBACK & MISSING METRICS HANDLING
    // -------------------------------------------------------------------------
    it("12. derivedOrFallback: handles derived present, fallback present, both missing, and legitimate numeric zero", () => {
        // Derived value present (positive, negative)
        assert.equal(derivedOrFallback(15.5, 3.2), 15.5);
        assert.equal(derivedOrFallback(-4.2, 3.2), -4.2);

        // Fallback value present when derived is null/undefined
        assert.equal(derivedOrFallback(null, 8.75), 8.75);
        assert.equal(derivedOrFallback(undefined, -2.5), -2.5);
        assert.equal(derivedOrFallback(NaN, 4.1), 4.1);

        // Both values missing -> returns null, never fabricates 0
        assert.equal(derivedOrFallback(null, null), null);
        assert.equal(derivedOrFallback(undefined, undefined), null);
        assert.equal(derivedOrFallback(null, undefined), null);
        assert.equal(derivedOrFallback(NaN, null), null);

        // Legitimate numeric zero preserved in both derived and fallback positions
        assert.equal(derivedOrFallback(0, 12.5), 0);
        assert.equal(derivedOrFallback(0, null), 0);
        assert.equal(derivedOrFallback(null, 0), 0);
        assert.equal(derivedOrFallback(undefined, 0), 0);
    });

    // -------------------------------------------------------------------------
    // 13. STEP 3A: WALLET-GLOBAL METRICS NULL HANDLING & POOL-LOCAL ISOLATION
    // -------------------------------------------------------------------------
    it("13. Wallet-global metrics null handling & no substitution of pool-local metrics", () => {
        // Wallet with missing global PnL and pool-local discovery metadata
        const unenrichedPoolWallet: Wallet & { _discovery?: Record<string, unknown> } = {
            owner: "PoolOnlyUnenrichedWallet1111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            source: "pool-scanner",
            total_pnl: null,
            total_pnl_native: null,
            total_pnl_native_7d: null,
            total_pnl_native_30d: null,
            avg_monthly_pnl_native: null,
            win_rate_native: null,
            total_lp: 1842,
            total_lp_7d: null,
            total_lp_30d: null,
            total_pool: null,
            _discovery: {
                pools: ["Pool1", "Pool2", "Pool3"],
                tokens: ["Token1", "Token2"],
            },
        };

        // Wallet-global PnL metrics return null when both derived and fallback are null
        assert.equal(walletPnl7d(unenrichedPoolWallet), null);
        assert.equal(walletPnl30d(unenrichedPoolWallet), null);
        assert.equal(walletAllTimePnl(unenrichedPoolWallet), null);
        assert.equal(walletMonthlyPnl(unenrichedPoolWallet), null);

        // Formatting null wallet-global metrics yields '—' and never fabricates 0
        assert.equal(formatSolPnl(unenrichedPoolWallet.total_pnl_native_7d, 2), "—");
        assert.equal(formatSolPnl(unenrichedPoolWallet.total_pnl_native_30d, 2), "—");
        assert.equal(formatSolPnl(unenrichedPoolWallet.total_pnl_native, 2), "—");
        assert.equal(formatNativeWinRate(unenrichedPoolWallet.win_rate_native), "—");
        assert.equal(formatNumberMetric(unenrichedPoolWallet.total_lp_7d, 0), "—");
        assert.equal(formatNumberMetric(unenrichedPoolWallet.total_lp_30d, 0), "—");
        assert.equal(formatNumberMetric(unenrichedPoolWallet.total_pool, 0), "—");
        assert.equal(formatPercentMetric(null), "—");
        assert.equal(toFiniteNumber(null), null);

        // Legitimate numeric 0 in wallet-global metrics is preserved and not confused with null
        const zeroPnlWallet: Wallet = {
            owner: "ZeroPnlWallet111111111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: 0,
            total_pnl_native_30d: 0,
            total_pnl_native: 0,
            avg_monthly_pnl_native: 0,
            win_rate_native: 0,
            total_lp_7d: 0,
            total_lp_30d: 0,
            total_lp: 0,
        };
        assert.equal(walletPnl7d(zeroPnlWallet), 0);
        assert.equal(walletPnl30d(zeroPnlWallet), 0);
        assert.equal(walletAllTimePnl(zeroPnlWallet), 0);
        assert.equal(walletMonthlyPnl(zeroPnlWallet), 0);
        assert.equal(formatSolPnl(zeroPnlWallet.total_pnl_native_7d, 2), "0 SOL");
        assert.equal(formatNativeWinRate(zeroPnlWallet.win_rate_native), "0.00%");
        assert.equal(formatNumberMetric(zeroPnlWallet.total_lp_7d, 0), "0");

        // Pool-local discovery metrics (_discovery.pools) are never substituted into total_pool / total_lp_7d / total_lp_30d
        assert.equal(unenrichedPoolWallet.total_pool, null);
        assert.equal(unenrichedPoolWallet.total_lp_7d, null);
        assert.equal(unenrichedPoolWallet.total_lp_30d, null);
        assert.equal(formatNumberMetric(unenrichedPoolWallet.total_lp, 0), "1,842");
    });

    // -------------------------------------------------------------------------
    // 14. STEP 3B.1: WALLET WIN RATE INTEGRITY & POOL-LOCAL ISOLATION
    // -------------------------------------------------------------------------
    it("14. Step 3B.1: Wallet win rate preserves real 0%, returns null when missing, and enforces wallet-global isolation", () => {
        // 1. Positive win rates from derived Fabriq stats
        const fabriqUsdWallet: Wallet = {
            owner: "FabriqUsdWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    positionWinUsd: { percentage: 68.5 },
                },
            },
        };
        assert.equal(walletWinRatePercent(fabriqUsdWallet), 68.5);

        const fabriqSolWallet: Wallet = {
            owner: "FabriqSolWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    positionWinSol: { percentage: 55.0 },
                },
            },
        };
        assert.equal(walletWinRatePercent(fabriqSolWallet), 55.0);

        // 2. Positive win rate from native fallback
        const nativeWallet: Wallet = {
            owner: "NativeWallet1111111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            win_rate_native: 0.72,
        };
        assert.equal(walletWinRatePercent(nativeWallet), 72);

        // 3. Legitimate numeric zero (0%) preserved across all sources
        const zeroFabriqWallet: Wallet = {
            owner: "ZeroFabriqWallet111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    positionWinUsd: { percentage: 0 },
                },
            },
        };
        assert.equal(walletWinRatePercent(zeroFabriqWallet), 0);

        const zeroNativeWallet: Wallet = {
            owner: "ZeroNativeWallet111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            win_rate_native: 0,
        };
        assert.equal(walletWinRatePercent(zeroNativeWallet), 0);

        // 4. Missing win rate returns null, NEVER fabricated 0
        const missingWallet: Wallet = {
            owner: "MissingWallet111111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            win_rate_native: null,
        };
        assert.equal(walletWinRatePercent(missingWallet), null);

        const undefinedStatsWallet: Wallet = {
            owner: "UndefinedStatsWallet111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    positionWinUsd: { percentage: null as unknown as number },
                },
            },
            win_rate_native: undefined,
        };
        assert.equal(walletWinRatePercent(undefinedStatsWallet), null);

        const nanStatsWallet: Wallet = {
            owner: "NanStatsWallet111111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    positionWinSol: { percentage: NaN },
                },
            },
            win_rate_native: NaN,
        };
        assert.equal(walletWinRatePercent(nanStatsWallet), null);

        // 5. Pool-local vs wallet-global isolation: pool-local activity is never substituted
        const poolIsolatedWallet: Wallet & { _discovery?: Record<string, unknown>; poolWinRate?: number } = {
            owner: "PoolIsolatedWallet111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            win_rate_native: null,
            poolWinRate: 85.0,
            _discovery: {
                pools: ["PoolAlpha"],
                localWinRate: 90.0,
            },
        };
        assert.equal(walletWinRatePercent(poolIsolatedWallet), null);
    });

    // -------------------------------------------------------------------------
    // 15. STEP 3B.1: POOL INSIGHT FINANCIAL FORMATTING INTEGRITY
    // -------------------------------------------------------------------------
    it("15. Step 3B.1: formatUsd and formatPct correctly format positive, negative, genuine zero, and missing values", () => {
        // Positive values
        assert.equal(formatUsd(1234.56), "+$1,234.56");
        assert.equal(formatUsd(0.01), "+$0.01");
        assert.equal(formatPct(15.2), "+15.20%");
        assert.equal(formatPct(0.5), "+0.50%");

        // Negative values preserve sign
        assert.equal(formatUsd(-54.321), "-$54.32");
        assert.equal(formatUsd(-0.01), "-$0.01");
        assert.equal(formatPct(-4.12), "-4.12%");
        assert.equal(formatPct(-0.5), "-0.50%");

        // Genuine zero
        assert.equal(formatUsd(0), "$0.00");
        assert.equal(formatUsd(-0), "$0.00");
        assert.equal(formatPct(0), "0.00%");
        assert.equal(formatPct(-0), "0.00%");

        // Missing, null, undefined, NaN, and non-finite values render '—'
        assert.equal(formatUsd(null), "—");
        assert.equal(formatUsd(undefined), "—");
        assert.equal(formatUsd(NaN), "—");
        assert.equal(formatUsd(Infinity), "—");
        assert.equal(formatUsd(-Infinity), "—");

        assert.equal(formatPct(null), "—");
        assert.equal(formatPct(undefined), "—");
        assert.equal(formatPct(NaN), "—");
        assert.equal(formatPct(Infinity), "—");
        assert.equal(formatPct(-Infinity), "—");

        // Avoid Number(null) coercion: null must not evaluate to 0 -> $0.00 / 0.00%
        assert.equal(formatUsd(null as unknown as number), "—");
        assert.equal(formatPct(null as unknown as number), "—");
    });

    // -------------------------------------------------------------------------
    // 16. STEP 3B.1: WIN DAYS AND LOSE DAYS INTEGRITY & SCOPE ISOLATION
    // -------------------------------------------------------------------------
    it("16. Step 3B.1: walletWinDays and walletLoseDays preserve count 0, return null when missing, and isolate wallet-global metrics", () => {
        // 1. Valid positive counts from dayWinUsd
        const validUsdWallet: Wallet = {
            owner: "ValidUsdWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    dayWinUsd: { wins: 14, losses: 6 },
                },
            },
        };
        assert.equal(walletWinDays(validUsdWallet), 14);
        assert.equal(walletLoseDays(validUsdWallet), 6);

        // 2. Valid positive counts from dayWinSol fallback
        const validSolWallet: Wallet = {
            owner: "ValidSolWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    dayWinSol: { wins: 9, losses: 2 },
                },
            },
        };
        assert.equal(walletWinDays(validSolWallet), 9);
        assert.equal(walletLoseDays(validSolWallet), 2);

        // 3. Legitimate count 0 preserved and distinct from missing
        const zeroDaysWallet: Wallet = {
            owner: "ZeroDaysWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    dayWinUsd: { wins: 0, losses: 0 },
                },
            },
        };
        assert.equal(walletWinDays(zeroDaysWallet), 0);
        assert.equal(walletLoseDays(zeroDaysWallet), 0);

        const zeroWinsWallet: Wallet = {
            owner: "ZeroWinsWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    dayWinUsd: { wins: 0, losses: 8 },
                },
            },
        };
        assert.equal(walletWinDays(zeroWinsWallet), 0);
        assert.equal(walletLoseDays(zeroWinsWallet), 8);

        // 4. Missing statistics return null, never fabricated 0
        const unenrichedWallet: Wallet = {
            owner: "UnenrichedWallet111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
        };
        assert.equal(walletWinDays(unenrichedWallet), null);
        assert.equal(walletLoseDays(unenrichedWallet), null);

        const emptyStatsWallet: Wallet = {
            owner: "EmptyStatsWallet111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: { stats: {} },
        };
        assert.equal(walletWinDays(emptyStatsWallet), null);
        assert.equal(walletLoseDays(emptyStatsWallet), null);

        const nullFieldsWallet: Wallet = {
            owner: "NullFieldsWallet111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            fabriq: {
                stats: {
                    dayWinUsd: { wins: null as unknown as number, losses: null as unknown as number },
                },
            },
        };
        assert.equal(walletWinDays(nullFieldsWallet), null);
        assert.equal(walletLoseDays(nullFieldsWallet), null);

        // 5. Wallet-global isolation: pool-local activity cannot fabricate daily stats
        const poolOnlyWallet: Wallet & { _discovery?: Record<string, unknown> } = {
            owner: "PoolOnlyWallet1111111111111111111111111",
            chain: "SOL",
            protocol: "meteora",
            _discovery: {
                pools: ["PoolAlpha", "PoolBeta"],
                totalTrades: 42,
                poolWinDays: 5,
            },
        };
        assert.equal(walletWinDays(poolOnlyWallet), null);
        assert.equal(walletLoseDays(poolOnlyWallet), null);
    });

    // -------------------------------------------------------------------------
    // 17. STEP 3B.3: ASCENDING SORT WITH POSITIVE, NEGATIVE, ZERO, AND NULL
    // -------------------------------------------------------------------------
    it("17. Step 3B.3 (1): Ascending sort orders negative < zero < positive < null across all numeric metrics", () => {
        const nowMs = Date.parse("2026-10-13T00:00:00.000Z");
        const wallets: Wallet[] = [
            {
                owner: "WalletNull",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: null,
                win_rate_native: null,
                total_lp: null,
                first_activity: null,
                last_activity: null,
                intelligenceV1: null,
            },
            {
                owner: "WalletPositive",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: 45.2,
                win_rate_native: 0.75,
                total_lp: 20,
                first_activity: "2026-09-01T00:00:00.000Z",
                last_activity: "2026-10-12T00:00:00.000Z",
                fabriq: { stats: { dayWinUsd: { wins: 12, losses: 5 } } },
                intelligenceV1: {
                    wallet: "WalletPositive",
                    qualityScore: 82.5,
                    riskScore: 40.0,
                    confidenceScore: 90.0,
                    style: "FARMER",
                    shortlisted: true,
                },
            },
            {
                owner: "WalletNegative",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: -12.8,
                win_rate_native: 0.2,
                total_lp: 3,
                first_activity: "2026-10-10T00:00:00.000Z",
                last_activity: "2026-10-01T00:00:00.000Z",
                fabriq: { stats: { dayWinUsd: { wins: 1, losses: 2 } } },
                intelligenceV1: {
                    wallet: "WalletNegative",
                    qualityScore: 15.0,
                    riskScore: 10.0,
                    confidenceScore: 25.0,
                    style: "SNIPER",
                    shortlisted: false,
                },
            },
            {
                owner: "WalletZero",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: 0,
                win_rate_native: 0,
                total_lp: 0,
                first_activity: "2026-10-13T00:00:00.000Z",
                last_activity: "2026-10-05T00:00:00.000Z",
                fabriq: { stats: { dayWinUsd: { wins: 0, losses: 0 } } },
                intelligenceV1: {
                    wallet: "WalletZero",
                    qualityScore: 0,
                    riskScore: 0,
                    confidenceScore: 0,
                    style: "MIXED_UNCLASSIFIED",
                    shortlisted: false,
                },
            },
        ];

        assert.deepEqual(
            sortWallets(wallets, "pnl7", "asc", nowMs).map((w) => w.owner),
            ["WalletNegative", "WalletZero", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "win", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "quality", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "risk", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "confidence", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "positions", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "winDays", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "loseDays", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "walletAge", "asc", nowMs).map((w) => w.owner),
            ["WalletZero", "WalletNegative", "WalletPositive", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "last", "asc", nowMs).map((w) => w.owner),
            ["WalletNegative", "WalletZero", "WalletPositive", "WalletNull"],
        );
    });

    // -------------------------------------------------------------------------
    // 18. STEP 3B.3: DESCENDING SORT WITH POSITIVE, NEGATIVE, ZERO, AND NULL
    // -------------------------------------------------------------------------
    it("18. Step 3B.3 (2): Descending sort orders positive > zero > negative > null with missing values always last", () => {
        const nowMs = Date.parse("2026-10-13T00:00:00.000Z");
        const wallets: Wallet[] = [
            {
                owner: "WalletNull",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: null,
                win_rate_native: null,
                total_lp: null,
                first_activity: null,
                last_activity: null,
                intelligenceV1: null,
            },
            {
                owner: "WalletNegative",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: -12.8,
                win_rate_native: 0.2,
                total_lp: 3,
                first_activity: "2026-10-10T00:00:00.000Z",
                last_activity: "2026-10-01T00:00:00.000Z",
                fabriq: { stats: { dayWinUsd: { wins: 1, losses: 2 } } },
                intelligenceV1: {
                    wallet: "WalletNegative",
                    qualityScore: 15.0,
                    riskScore: 10.0,
                    confidenceScore: 25.0,
                    style: "SNIPER",
                    shortlisted: false,
                },
            },
            {
                owner: "WalletZero",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: 0,
                win_rate_native: 0,
                total_lp: 0,
                first_activity: "2026-10-13T00:00:00.000Z",
                last_activity: "2026-10-05T00:00:00.000Z",
                fabriq: { stats: { dayWinUsd: { wins: 0, losses: 0 } } },
                intelligenceV1: {
                    wallet: "WalletZero",
                    qualityScore: 0,
                    riskScore: 0,
                    confidenceScore: 0,
                    style: "MIXED_UNCLASSIFIED",
                    shortlisted: false,
                },
            },
            {
                owner: "WalletPositive",
                chain: "SOL",
                protocol: "meteora",
                total_pnl_native_7d: 45.2,
                win_rate_native: 0.75,
                total_lp: 20,
                first_activity: "2026-09-01T00:00:00.000Z",
                last_activity: "2026-10-12T00:00:00.000Z",
                fabriq: { stats: { dayWinUsd: { wins: 12, losses: 5 } } },
                intelligenceV1: {
                    wallet: "WalletPositive",
                    qualityScore: 82.5,
                    riskScore: 40.0,
                    confidenceScore: 90.0,
                    style: "FARMER",
                    shortlisted: true,
                },
            },
        ];

        assert.deepEqual(
            sortWallets(wallets, "pnl7", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletZero", "WalletNegative", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "win", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "quality", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "risk", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "confidence", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "positions", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "winDays", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "loseDays", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "walletAge", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletNegative", "WalletZero", "WalletNull"],
        );
        assert.deepEqual(
            sortWallets(wallets, "last", "desc", nowMs).map((w) => w.owner),
            ["WalletPositive", "WalletZero", "WalletNegative", "WalletNull"],
        );
    });

    // -------------------------------------------------------------------------
    // 19. STEP 3B.3: BOTH-NULL & EQUAL NUMERIC COMPARISONS + TIE-BREAKING
    // -------------------------------------------------------------------------
    it("19. Step 3B.3 (3 & 4): Both-null and equal numeric values return 0 before tie-breaking and sort deterministically by owner", () => {
        // Direct comparator returns 0 when both values are null
        assert.equal(compareNullableNumbers(null, null, "asc"), 0);
        assert.equal(compareNullableNumbers(null, null, "desc"), 0);
        assert.equal(compareNullableStrings(null, null, "asc"), 0);
        assert.equal(compareNullableStrings(null, null, "desc"), 0);

        // Direct comparator returns 0 when numeric values are equal (including 0 and -0)
        assert.equal(compareNullableNumbers(25.5, 25.5, "asc"), 0);
        assert.equal(compareNullableNumbers(25.5, 25.5, "desc"), 0);
        assert.equal(compareNullableNumbers(0, -0, "asc"), 0);
        assert.equal(compareNullableNumbers(-0, 0, "desc"), 0);

        const nullWalletZ: Wallet = {
            owner: "ZetaNullWallet",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: null,
        };
        const nullWalletA: Wallet = {
            owner: "AlphaNullWallet",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: null,
        };
        const equalWalletB: Wallet = {
            owner: "BetaEqualWallet",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: 10,
        };
        const equalWalletA: Wallet = {
            owner: "AlphaEqualWallet",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: 10,
        };

        // Metric comparator returns 0 before tie-breaking
        assert.equal(compareWalletMetricValues(nullWalletZ, nullWalletA, "pnl7", "desc"), 0);
        assert.equal(compareWalletMetricValues(nullWalletZ, nullWalletA, "pnl7", "asc"), 0);
        assert.equal(compareWalletMetricValues(equalWalletB, equalWalletA, "pnl7", "desc"), 0);
        assert.equal(compareWalletMetricValues(equalWalletB, equalWalletA, "pnl7", "asc"), 0);

        // Full wallet comparator breaks ties deterministically by owner
        assert.ok(compareWallets(nullWalletA, nullWalletZ, "pnl7", "desc") < 0);
        assert.ok(compareWallets(equalWalletA, equalWalletB, "pnl7", "desc") < 0);

        const input = [nullWalletZ, equalWalletB, nullWalletA, equalWalletA];
        const snapshot = [...input];
        const sortedDesc = sortWallets(input, "pnl7", "desc");
        assert.deepEqual(
            sortedDesc.map((w) => w.owner),
            ["AlphaEqualWallet", "BetaEqualWallet", "AlphaNullWallet", "ZetaNullWallet"],
        );
        // Source array is not mutated
        assert.deepEqual(input, snapshot);
    });

    // -------------------------------------------------------------------------
    // 20. STEP 3B.3: NaN, UNDEFINED, AND INVALID DATE HANDLING
    // -------------------------------------------------------------------------
    it("20. Step 3B.3 (5): NaN, undefined, Infinity, and invalid dates are treated as missing (null) and never converted to -1 or 0", () => {
        assert.equal(compareNullableNumbers(NaN, 0, "asc"), 1);
        assert.equal(compareNullableNumbers(NaN, 0, "desc"), 1);
        assert.equal(compareNullableNumbers(undefined, -100, "asc"), 1);
        assert.equal(compareNullableNumbers(undefined, -100, "desc"), 1);
        assert.equal(compareNullableNumbers(Infinity, 10, "desc"), 1);
        assert.equal(compareNullableNumbers(NaN, undefined, "asc"), 0);

        const corruptedWallet: Wallet = {
            owner: "CorruptedWallet",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: NaN,
            total_pnl_native_30d: undefined,
            total_pnl_native: Number.POSITIVE_INFINITY,
            win_rate_native: NaN,
            total_lp: NaN,
            avg_age_hour: NaN,
            expected_value_native: NaN,
            avg_inflow_native: undefined,
            total_fee_native: NaN,
            first_activity: "not-a-valid-date",
            last_activity: "invalid-timestamp",
            intelligenceV1: {
                wallet: "CorruptedWallet",
                qualityScore: NaN,
                riskScore: undefined as unknown as null,
                confidenceScore: NaN,
                style: "   ",
                shortlisted: undefined as unknown as boolean,
            },
        };

        const numericKeys: WalletSortKey[] = [
            "shortlist",
            "quality",
            "risk",
            "confidence",
            "pnl7",
            "win",
            "winDays",
            "loseDays",
            "pnl30",
            "pnlAll",
            "positions",
            "walletAge",
            "age",
            "ev",
            "invested",
            "monthly",
            "fees",
            "last",
        ];
        for (const key of numericKeys) {
            assert.equal(
                walletSortValue(corruptedWallet, key),
                null,
                `Expected walletSortValue(corruptedWallet, "${key}") to be null`,
            );
        }
        assert.equal(walletSortValue(corruptedWallet, "style"), null);
        assert.equal(walletAgeMs(corruptedWallet), null);
        assert.equal(walletLastActivityTimestamp(corruptedWallet), null);
        assert.equal(walletPositions(corruptedWallet), null);
    });

    // -------------------------------------------------------------------------
    // 21. STEP 3B.3: TIMEFRAME SORT-KEY SELECTION & RANKING RECALCULATION
    // -------------------------------------------------------------------------
    it("21. Step 3B.3 (6 & 7): 7D / 30D / ALL sort-key selection and timeframe switching recalculate rankings accurately", () => {
        // Default sort keys per timeframe
        assert.equal(defaultSortKeyForTimeframe("7d"), "pnl7");
        assert.equal(defaultSortKeyForTimeframe("30d"), "pnl30");
        assert.equal(defaultSortKeyForTimeframe("all"), "pnlAll");

        // Switching timeframe updates PnL sort key
        assert.equal(resolveSortKeyForTimeframeChange("pnl7", "30d"), "pnl30");
        assert.equal(resolveSortKeyForTimeframeChange("pnl30", "all"), "pnlAll");
        assert.equal(resolveSortKeyForTimeframeChange("pnlAll", "7d"), "pnl7");

        // Non-PnL sort keys are preserved when timeframe changes
        assert.equal(resolveSortKeyForTimeframeChange("quality", "30d"), "quality");
        assert.equal(resolveSortKeyForTimeframeChange("win", "all"), "win");
        assert.equal(resolveSortKeyForTimeframeChange("risk", "7d"), "risk");

        const wallets: Wallet[] = [
            {
                owner: "Leader7D",
                chain: "SOL",
                protocol: "meteora",
                last_activity: "2026-10-10T00:00:00.000Z",
                total_pnl_native_7d: 100,
                total_pnl_native_30d: 20,
                total_pnl_native: 50,
            },
            {
                owner: "Leader30D",
                chain: "SOL",
                protocol: "meteora",
                last_activity: "2026-10-10T00:00:00.000Z",
                total_pnl_native_7d: 10,
                total_pnl_native_30d: 200,
                total_pnl_native: 80,
            },
            {
                owner: "LeaderAllTime",
                chain: "SOL",
                protocol: "meteora",
                last_activity: "2026-10-10T00:00:00.000Z",
                total_pnl_native_7d: -5,
                total_pnl_native_30d: -10,
                total_pnl_native: 500,
            },
            {
                owner: "Missing30DZero7D",
                chain: "SOL",
                protocol: "meteora",
                last_activity: "2026-10-10T00:00:00.000Z",
                total_pnl_native_7d: 0,
                total_pnl_native_30d: null,
                total_pnl_native: 0,
            },
        ];

        // 7D ranking
        const key7d = resolveSortKeyForTimeframeChange("pnlAll", "7d");
        assert.equal(key7d, "pnl7");
        assert.deepEqual(
            sortWallets(wallets, key7d, "desc").map((w) => w.owner),
            ["Leader7D", "Leader30D", "Missing30DZero7D", "LeaderAllTime"],
        );

        // 30D ranking (Missing30DZero7D has null 30D PnL -> sorts LAST after negative -10)
        const key30d = resolveSortKeyForTimeframeChange(key7d, "30d");
        assert.equal(key30d, "pnl30");
        assert.deepEqual(
            sortWallets(wallets, key30d, "desc").map((w) => w.owner),
            ["Leader30D", "Leader7D", "LeaderAllTime", "Missing30DZero7D"],
        );

        // ALL ranking
        const keyAll = resolveSortKeyForTimeframeChange(key30d, "all");
        assert.equal(keyAll, "pnlAll");
        assert.deepEqual(
            sortWallets(wallets, keyAll, "desc").map((w) => w.owner),
            ["LeaderAllTime", "Leader30D", "Leader7D", "Missing30DZero7D"],
        );

        // walletTimeframePnl matches each timeframe
        assert.equal(walletTimeframePnl(wallets[3], "7d"), 0);
        assert.equal(walletTimeframePnl(wallets[3], "30d"), null);
        assert.equal(walletTimeframePnl(wallets[3], "all"), 0);
    });

    // -------------------------------------------------------------------------
    // 22. STEP 3B.3: CONSISTENT EXPLORER & TRACKPAGE ORDERING + PAGINATION
    // -------------------------------------------------------------------------
    it("22. Step 3B.3 (8 & 9): Explorer and TrackPage share identical sort semantics and paginate after sorting", () => {
        const nowMs = Date.parse("2026-10-13T00:00:00.000Z");
        const cohort: Wallet[] = [
            {
                owner: "WalletC_DerivedActivityOnly",
                chain: "SOL",
                protocol: "meteora",
                first_activity: null,
                last_activity: null,
                total_lp: null,
                fabriq: { stats: { totalPositions: 42 } },
                fabriqDerived: {
                    asOfDate: "2026-10-11",
                    currentMonth: "2026-10",
                    pnl7dSol: 12,
                    daily: [
                        {
                            date: "2026-10-08",
                            pnlSol: 12,
                            pnlUsd: 1800,
                            feesSol: 1,
                            feesUsd: 150,
                            positions: 2,
                            winRateSol: 100,
                            winRateUsd: 100,
                        },
                    ],
                },
                intelligenceV1: null,
            },
            {
                owner: "WalletA_LowRiskZeroScore",
                chain: "SOL",
                protocol: "meteora",
                first_activity: "2026-09-01T00:00:00.000Z",
                last_activity: "2026-10-10T00:00:00.000Z",
                total_lp: 15,
                total_pnl_native_7d: 5,
                intelligenceV1: {
                    wallet: "WalletA_LowRiskZeroScore",
                    qualityScore: 0,
                    riskScore: 0,
                    confidenceScore: 0,
                    style: "FARMER",
                    shortlisted: false,
                },
            },
            {
                owner: "WalletB_Evaluated",
                chain: "SOL",
                protocol: "meteora",
                first_activity: "2026-08-01T00:00:00.000Z",
                last_activity: "2026-10-11T00:00:00.000Z",
                total_lp: 30,
                total_pnl_native_7d: 25,
                intelligenceV1: {
                    wallet: "WalletB_Evaluated",
                    qualityScore: 78,
                    riskScore: 22,
                    confidenceScore: 84,
                    style: "SNIPER",
                    shortlisted: true,
                },
            },
        ];

        // Previously in App.tsx: quality/risk/confidence used -1 fallback so WalletC sorted FIRST in asc,
        // and TrackPage ignored fabriqDerived activity dates for walletAge/last and fabriq.stats.totalPositions.
        // Now both use sortWallets and produce identical null-last order:
        assert.deepEqual(
            sortWallets(cohort, "risk", "asc", nowMs).map((w) => w.owner),
            ["WalletA_LowRiskZeroScore", "WalletB_Evaluated", "WalletC_DerivedActivityOnly"],
        );
        assert.deepEqual(
            sortWallets(cohort, "positions", "desc", nowMs).map((w) => w.owner),
            ["WalletC_DerivedActivityOnly", "WalletB_Evaluated", "WalletA_LowRiskZeroScore"],
        );
        assert.deepEqual(
            sortWallets(cohort, "walletAge", "desc", nowMs).map((w) => w.owner),
            ["WalletB_Evaluated", "WalletA_LowRiskZeroScore", "WalletC_DerivedActivityOnly"],
        );
        assert.deepEqual(
            sortWallets(cohort, "last", "desc", nowMs).map((w) => w.owner),
            ["WalletB_Evaluated", "WalletA_LowRiskZeroScore", "WalletC_DerivedActivityOnly"],
        );

        // Pagination after sorting: null values appear on the LAST page, not page 1
        const page1 = paginateWallets(sortWallets(cohort, "quality", "asc", nowMs), 1, 2);
        const page2 = paginateWallets(sortWallets(cohort, "quality", "asc", nowMs), 2, 2);
        assert.equal(page1.pageCount, 2);
        assert.equal(page1.safePage, 1);
        assert.deepEqual(
            page1.rows.map((w) => w.owner),
            ["WalletA_LowRiskZeroScore", "WalletB_Evaluated"],
        );
        assert.deepEqual(
            page2.rows.map((w) => w.owner),
            ["WalletC_DerivedActivityOnly"],
        );

        // Out-of-bounds page clamps to pageCount
        const clamped = paginateWallets(cohort, 99, 2);
        assert.equal(clamped.safePage, 2);
        assert.equal(clamped.pageCount, 2);
    });

    // -------------------------------------------------------------------------
    // 23. STEP 3B.3: WALLET-GLOBAL VS POOL-LOCAL METRIC ISOLATION IN SORTING
    // -------------------------------------------------------------------------
    it("23. Step 3B.3 (10): Sorting never substitutes pool-local discovery metrics for missing wallet-global metrics", () => {
        const poolLocalOnlyWallet: Wallet & {
            _discovery?: Record<string, unknown>;
            poolPnlSol?: number;
            poolWinRate?: number;
        } = {
            owner: "PoolLocalOnlyWallet",
            chain: "SOL",
            protocol: "meteora",
            source: "pool-scanner",
            total_pnl_native_7d: null,
            total_pnl_native_30d: null,
            total_pnl_native: null,
            avg_monthly_pnl_native: null,
            win_rate_native: null,
            total_fee_native: null,
            expected_value_native: null,
            avg_inflow_native: null,
            poolPnlSol: 9999,
            poolWinRate: 99.9,
            _discovery: {
                pools: ["Pool1", "Pool2"],
                localPnlSol: 9999,
                localWinRate: 99.9,
                localFeesSol: 500,
            },
        };

        const globalNegativeWallet: Wallet = {
            owner: "GlobalNegativeWallet",
            chain: "SOL",
            protocol: "meteora",
            total_pnl_native_7d: -50,
            total_pnl_native_30d: -50,
            total_pnl_native: -50,
            avg_monthly_pnl_native: -50,
            win_rate_native: 0,
            total_fee_native: 0,
            expected_value_native: -10,
            avg_inflow_native: 1,
        };

        for (const key of ["pnl7", "pnl30", "pnlAll", "monthly", "win", "fees", "ev", "invested"] as WalletSortKey[]) {
            assert.equal(walletSortValue(poolLocalOnlyWallet, key), null);
            assert.deepEqual(
                sortWallets([poolLocalOnlyWallet, globalNegativeWallet], key, "desc").map((w) => w.owner),
                ["GlobalNegativeWallet", "PoolLocalOnlyWallet"],
            );
            assert.deepEqual(
                sortWallets([poolLocalOnlyWallet, globalNegativeWallet], key, "asc").map((w) => w.owner),
                ["GlobalNegativeWallet", "PoolLocalOnlyWallet"],
            );
        }
    });
});

describe("Step 3B.4: Functional Portfolio PnL Charts Suite", () => {
    const FIXED_REF_DATE = "2026-10-11";

    it("1. 7D date filtering: includes exact inclusive last 7 calendar days up to reference date", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2026-10-04", pnl: 1.0 }, // 8 days before: excluded
            { date: "2026-10-05", pnl: 2.0 }, // 6 days before: included (start of 7D)
            { date: "2026-10-08", pnl: 3.0 }, // included
            { date: "2026-10-11", pnl: 4.0 }, // ref date: included
            { date: "2026-10-12", pnl: 5.0 }, // future: excluded
        ];

        const filtered = filterDailyPnlByTimeframe(points, "7D", FIXED_REF_DATE);
        assert.deepEqual(filtered.map((p) => p.date), ["2026-10-05", "2026-10-08", "2026-10-11"]);
        assert.deepEqual(filtered.map((p) => p.pnl), [2.0, 3.0, 4.0]);
    });

    it("2. 30D date filtering: includes exact inclusive last 30 calendar days up to reference date", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2026-09-11", pnl: 1.0 }, // 31 days before: excluded
            { date: "2026-09-12", pnl: 2.0 }, // 29 days before: included (start of 30D)
            { date: "2026-09-25", pnl: 3.0 }, // included
            { date: "2026-10-11", pnl: 4.0 }, // ref date: included
            { date: "2026-10-15", pnl: 5.0 }, // future: excluded
        ];

        const filtered = filterDailyPnlByTimeframe(points, "30D", FIXED_REF_DATE);
        assert.deepEqual(filtered.map((p) => p.date), ["2026-09-12", "2026-09-25", "2026-10-11"]);
    });

    it("3. ALL available-history filtering: includes all past historical points up to reference date", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2025-01-01", pnl: 10.0 }, // far past: included
            { date: "2026-08-01", pnl: 5.0 },  // included
            { date: "2026-10-11", pnl: 2.0 },  // ref date: included
            { date: "2026-10-12", pnl: 1.0 },  // future: excluded
        ];

        const filtered = filterDailyPnlByTimeframe(points, "ALL", FIXED_REF_DATE);
        assert.deepEqual(filtered.map((p) => p.date), ["2025-01-01", "2026-08-01", "2026-10-11"]);
    });

    it("4. Timeframe switching: yields hierarchical subsets 7D <= 30D <= ALL with synchronized count", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2026-08-10", pnl: 1.0 },
            { date: "2026-09-15", pnl: 2.0 },
            { date: "2026-10-01", pnl: 3.0 },
            { date: "2026-10-06", pnl: 4.0 },
            { date: "2026-10-10", pnl: 5.0 },
        ];

        const res7d = filterDailyPnlByTimeframe(points, "7D", FIXED_REF_DATE);
        const res30d = filterDailyPnlByTimeframe(points, "30D", FIXED_REF_DATE);
        const resAll = filterDailyPnlByTimeframe(points, "ALL", FIXED_REF_DATE);

        assert.equal(res7d.length, 2); // 10-06, 10-10
        assert.equal(res30d.length, 4); // 09-15, 10-01, 10-06, 10-10
        assert.equal(resAll.length, 5); // all
        assert.ok(res7d.length <= res30d.length && res30d.length <= resAll.length);
    });

    it("5. Chronological ordering: sorts out-of-order points strictly ascending by date", () => {
        const unorganised: NormalizedDailyPnlPoint[] = [
            { date: "2026-10-10", pnl: 1.0 },
            { date: "2026-10-06", pnl: 2.0 },
            { date: "2026-10-08", pnl: 3.0 },
        ];

        const sorted = filterDailyPnlByTimeframe(unorganised, "7D", FIXED_REF_DATE);
        assert.deepEqual(sorted.map((p) => p.date), ["2026-10-06", "2026-10-08", "2026-10-10"]);
    });

    it("6. Negative daily PnL: preserves negative values without inversion or clamping", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2026-10-07", pnl: -12.3456 },
            { date: "2026-10-09", pnl: -0.0001 },
        ];

        const filtered = filterDailyPnlByTimeframe(points, "7D", FIXED_REF_DATE);
        assert.equal(filtered[0].pnl, -12.3456);
        assert.equal(filtered[1].pnl, -0.0001);
    });

    it("7. Cumulative gains and losses: period cumulative correctly accumulates gains and losses", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2026-10-06", pnl: 5.0 },   // cum = 5.0
            { date: "2026-10-07", pnl: -2.0 },  // cum = 3.0
            { date: "2026-10-08", pnl: -6.0 },  // cum = -3.0 (negative cumulative preserved)
            { date: "2026-10-09", pnl: 4.5 },   // cum = 1.5
        ];

        const cum = computePeriodCumulativePnl(points);
        assert.deepEqual(
            cum.map((c) => c.cumulativePnl),
            [5.0, 3.0, -3.0, 1.5],
        );
    });

    it("8. Genuine zero preservation: preserves numeric 0 as valid non-null value", () => {
        const points: NormalizedDailyPnlPoint[] = [
            { date: "2026-10-06", pnl: 0 },
            { date: "2026-10-07", pnl: 1.5 },
        ];

        const filtered = filterDailyPnlByTimeframe(points, "7D", FIXED_REF_DATE);
        assert.equal(filtered[0].pnl, 0);
        assert.strictEqual(typeof filtered[0].pnl, "number");

        const cum = computePeriodCumulativePnl(filtered);
        assert.equal(cum[0].cumulativePnl, 0);
        assert.equal(cum[1].cumulativePnl, 1.5);
    });

    it("9. Missing, invalid, and future points: skips malformed entries, ignores future dates, dedupes deterministically", () => {
        const raw: unknown[] = [
            { close_day: "invalid-date", sum_native: 5.0 },             // invalid date: skipped
            { close_day: "2026-10-07", sum_native: null },               // missing pnl: skipped (never 0)
            { close_day: "2026-10-07", sum_native: undefined },          // missing pnl: skipped
            { close_day: "2026-10-07", sum_native: "NaN" },              // invalid pnl: skipped
            { close_day: "2026-10-08", sum_native: 2.0 },                // first duplicate
            { close_day: "2026-10-08", sum_native: 3.5 },                // second duplicate (deterministic latest wins)
            { close_day: "2026-10-20T00:00:00Z", sum_native: 10.0 },     // future date: excluded by filter
        ];

        const extracted = extractNormalizedDailyPnl(raw as PnlPoint[], "SOL");
        assert.deepEqual(extracted.map((p) => p.date), ["2026-10-08", "2026-10-20"]);
        assert.equal(extracted[0].pnl, 3.5); // deduplication preserved last entry

        const filtered = filterDailyPnlByTimeframe(extracted, "ALL", FIXED_REF_DATE);
        assert.deepEqual(filtered.map((p) => p.date), ["2026-10-08"]); // future 2026-10-20 excluded
    });

    it("10. One-point and empty series: handles zero points and single point safely", () => {
        const empty = computePeriodCumulativePnl([]);
        assert.deepEqual(empty, []);

        const onePoint: NormalizedDailyPnlPoint[] = [{ date: "2026-10-08", pnl: -3.2 }];
        const cumOne = computePeriodCumulativePnl(onePoint);
        assert.deepEqual(cumOne, [{ date: "2026-10-08", dailyPnl: -3.2, cumulativePnl: -3.2 }]);
    });

    it("11. Partial historical coverage: does not interpolate or fabricate zeroes across gaps", () => {
        const pointsWithGaps: NormalizedDailyPnlPoint[] = [
            { date: "2026-10-05", pnl: 2.0 },
            // 2026-10-06 and 2026-10-07 missing
            { date: "2026-10-08", pnl: 4.0 },
        ];

        const filtered = filterDailyPnlByTimeframe(pointsWithGaps, "7D", FIXED_REF_DATE);
        assert.equal(filtered.length, 2);
        assert.deepEqual(filtered.map((p) => p.date), ["2026-10-05", "2026-10-08"]);

        const cum = computePeriodCumulativePnl(filtered);
        assert.deepEqual(cum.map((c) => c.cumulativePnl), [2.0, 6.0]);
    });

    it("12. Consistent PnL units and data provenance: isolates SOL from USD without cross-currency leakage", () => {
        const pointsWithBothUnits: unknown[] = [
            { close_day: "2026-10-06", sum: 500.0, sum_native: 4.2 },
            { close_day: "2026-10-07", sum: -200.0, sum_native: -1.8 },
        ];

        const solExtracted = extractNormalizedDailyPnl(pointsWithBothUnits as PnlPoint[], "SOL");
        assert.deepEqual(solExtracted.map((p) => p.pnl), [4.2, -1.8]);

        const usdExtracted = extractNormalizedDailyPnl(pointsWithBothUnits as PnlPoint[], "USD");
        assert.deepEqual(usdExtracted.map((p) => p.pnl), [500.0, -200.0]);
    });

    it("13. Wallet switching without stale chart data: extracts fresh points per wallet without cross-wallet leakage", () => {
        const walletA: Wallet = {
            owner: "WalletA11111111111111111111111111111111111",
            chain: "SOL",
            pnl_chart: [
                { close_day: "2026-10-06", sum_native: 10.0 } as PnlPoint,
            ],
        };

        const walletB: Wallet = {
            owner: "WalletB22222222222222222222222222222222222",
            chain: "SOL",
            pnl_chart: [
                { close_day: "2026-10-08", sum_native: -5.0 } as PnlPoint,
            ],
        };

        const pointsA = extractNormalizedDailyPnl(walletA, "SOL");
        const pointsB = extractNormalizedDailyPnl(walletB, "SOL");

        assert.equal(pointsA.length, 1);
        assert.equal(pointsA[0].pnl, 10.0);

        assert.equal(pointsB.length, 1);
        assert.equal(pointsB[0].pnl, -5.0);
        assert.notDeepEqual(pointsA, pointsB);
    });

    it("14. Synchronized timeframe controls: daily and cumulative filtering share identical date boundaries", () => {
        const rawPoints: NormalizedDailyPnlPoint[] = [
            { date: "2026-09-01", pnl: 1.0 },
            { date: "2026-09-20", pnl: 2.0 },
            { date: "2026-10-06", pnl: 3.0 },
            { date: "2026-10-10", pnl: 4.0 },
        ];

        for (const tf of ["7D", "30D", "ALL"] as ChartTimeframe[]) {
            const daily = filterDailyPnlByTimeframe(rawPoints, tf, FIXED_REF_DATE);
            const cum = computePeriodCumulativePnl(daily);

            assert.equal(daily.length, cum.length);
            assert.deepEqual(daily.map((d) => d.date), cum.map((c) => c.date));
        }
    });
});
