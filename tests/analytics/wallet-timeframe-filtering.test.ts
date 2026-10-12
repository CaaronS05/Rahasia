import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Wallet } from "../../frontend/src/types.ts";
import {
    countUnknownActivityWallets,
    extractWalletActivityDates,
    getWalletActivityStatus,
    isWalletTimeframeEligible,
    resolveReferenceDate,
    shiftUtcDays,
    walletAllTimePnl,
    walletEffectiveFirstActivity,
    walletEffectiveLastActivity,
    walletPnl30d,
    walletPnl7d,
    walletWinRatePercent,
} from "../../frontend/src/lib/walletMetrics.ts";

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
        assert.equal(walletPnl7d(w2) > walletPnl7d(w1), true);

        // In 30D, W1 (50) > W2 (30)
        assert.equal(walletPnl30d(w1) > walletPnl30d(w2), true);

        // In ALL, W1 (100) > W2 (80)
        assert.equal(walletAllTimePnl(w1) > walletAllTimePnl(w2), true);
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
});
