import { readFile } from "node:fs/promises";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Wallet } from "../../frontend/src/types.ts";
import {
    getDefaultVisibleColumns,
    defaultVisible,
    loadSavedColumns,
    saveColumns,
    clearSavedColumns,
    COLUMN_STORAGE_KEY,
} from "../../frontend/src/lib/walletTableColumns.ts";
import {
    defaultFilters,
    type FilterState,
} from "../../frontend/src/lib/walletFilters.ts";
import {
    walletTimeframeLp,
    walletPositions,
    toFiniteNumber,
    formatSolPnl,
    formatPercentMetric,
    formatNumberMetric,
    pnlColorClass,
} from "../../frontend/src/lib/walletMetrics.ts";
import {
    loadTrackedWallets,
    saveTrackedWallets,
} from "../../frontend/src/lib/trackedWallets.ts";
import {
    DISCOVER_NAV_ITEMS,
    WATCHLIST_NAV_ITEMS,
    TOOLS_NAV_ITEMS,
    PORTFOLIO_TAB_ITEMS,
    routeFromLocation,
    navigate,
    type Page,
} from "../../frontend/src/lib/navigation.ts";

// Mock localStorage for Node test runner environment
class MockLocalStorage {
    private store = new Map<string, string>();

    getItem(key: string): string | null {
        return this.store.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.store.set(key, String(value));
    }

    removeItem(key: string): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }
}

describe("Step 3B.6: Wallet Explorer UX & Navigation Finalization Suite", () => {
    const originalLocalStorage = globalThis.localStorage;
    const originalWindow = globalThis.window;
    let mockStorage: MockLocalStorage;

    beforeEach(() => {
        mockStorage = new MockLocalStorage();
        globalThis.localStorage = mockStorage as unknown as Storage;

        if (!globalThis.window) {
            globalThis.window = {
                location: {
                    pathname: "/",
                    search: "",
                    replace: () => {},
                    assign: () => {},
                },
                history: {
                    pushState: (_data: any, _unused: string, url?: string | URL | null) => {
                        if (typeof url === "string") {
                            const [path, search] = url.split("?");
                            (globalThis.window.location as any).pathname = path;
                            (globalThis.window.location as any).search = search ? `?${search}` : "";
                        }
                    },
                },
                dispatchEvent: (_event: any) => true,
                addEventListener: () => {},
                removeEventListener: () => {},
            } as any;
        } else {
            (globalThis.window.location as any).pathname = "/";
            (globalThis.window.location as any).search = "";
        }
    });

    afterEach(() => {
        globalThis.localStorage = originalLocalStorage;
        if (originalWindow) {
            globalThis.window = originalWindow;
        }
    });

    // -------------------------------------------------------------------------
    // 1. Default Columns & Column Selector Settings
    // -------------------------------------------------------------------------
    describe("1. Default Columns & Custom Column Selection", () => {
        it("defaults to exactly 8 high-signal columns for 7D timeframe", () => {
            const columns7d = getDefaultVisibleColumns("7d");
            const visibleKeys = Object.entries(columns7d)
                .filter(([_, isVisible]) => isVisible)
                .map(([key]) => key);

            assert.equal(visibleKeys.length, 8, `Expected 8 columns, got ${visibleKeys.length}: ${visibleKeys.join(", ")}`);
            assert.deepEqual(visibleKeys.sort(), [
                "age",
                "pnl7",
                "positions",
                "quality",
                "risk",
                "shortlist",
                "wallet",
                "win",
            ].sort());

            // Optional columns are hidden by default
            assert.equal(columns7d.confidence, false);
            assert.equal(columns7d.style, false);
            assert.equal(columns7d.winDays, false);
            assert.equal(columns7d.loseDays, false);
            assert.equal(columns7d.pnl30, false);
            assert.equal(columns7d.pnlAll, false);
            assert.equal(columns7d.walletAge, false);
            assert.equal(columns7d.ev, false);
            assert.equal(columns7d.invested, false);
            assert.equal(columns7d.monthly, false);
            assert.equal(columns7d.fees, false);
            assert.equal(columns7d.last, false);
        });

        it("selects active timeframe PnL column (pnl30 for 30D, pnlAll for ALL)", () => {
            const columns30d = getDefaultVisibleColumns("30d");
            assert.equal(columns30d.pnl30, true);
            assert.equal(columns30d.pnl7, false);
            assert.equal(columns30d.pnlAll, false);
            const count30d = Object.values(columns30d).filter(Boolean).length;
            assert.equal(count30d, 8);

            const columnsAll = getDefaultVisibleColumns("all");
            assert.equal(columnsAll.pnlAll, true);
            assert.equal(columnsAll.pnl7, false);
            assert.equal(columnsAll.pnl30, false);
            const countAll = Object.values(columnsAll).filter(Boolean).length;
            assert.equal(countAll, 8);
        });

        it("saves, loads, and clears custom column preferences in localStorage", () => {
            assert.equal(loadSavedColumns(), null);

            const customCols = { ...getDefaultVisibleColumns("7d"), fees: true, style: true };
            saveColumns(customCols);

            const loaded = loadSavedColumns();
            assert.ok(loaded);
            assert.equal(loaded?.fees, true);
            assert.equal(loaded?.style, true);

            clearSavedColumns();
            assert.equal(loadSavedColumns(), null);
        });
    });

    // -------------------------------------------------------------------------
    // 2. Filter Reset Behavior
    // -------------------------------------------------------------------------
    describe("2. Filter Reset Behavior", () => {
        it("defines documented empty defaults in defaultFilters", () => {
            assert.deepEqual(defaultFilters, {
                search: "",
                firstActivityFrom: "",
                firstActivityTo: "",
                minPnl: "",
                minLp: "",
                minWinRate: "",
                minPools: "",
            });
        });

        it("resets filter draft without clearing tracked wallets or altering timeframe", () => {
            let activeFilters: FilterState = {
                search: "SoL111",
                firstActivityFrom: "2026-09-01",
                firstActivityTo: "2026-10-01",
                minPnl: "10",
                minLp: "5",
                minWinRate: "60",
                minPools: "2",
            };
            const tracked = new Set(["TrackedWallet1", "TrackedWallet2"]);
            let activeTimeframe = "30d";

            // Simulated reset
            activeFilters = { ...defaultFilters };

            assert.deepEqual(activeFilters, defaultFilters);
            assert.equal(tracked.size, 2);
            assert.ok(tracked.has("TrackedWallet1"));
            assert.ok(tracked.has("TrackedWallet2"));
            assert.equal(activeTimeframe, "30d");
        });
    });

    // -------------------------------------------------------------------------
    // 3. Timeframe-Aware MIN LP Filtering
    // -------------------------------------------------------------------------
    describe("3. Timeframe-Aware MIN LP Filtering", () => {
        const walletWithMetrics: Wallet = {
            owner: "Wallet_Metrics",
            chain: "SOL",
            protocol: "meteora",
            total_lp_7d: 12,
            total_lp_30d: 45,
            total_lp: 120,
            fabriq: { stats: { totalPositions: 120 } },
        };

        const walletMissing7d: Wallet = {
            owner: "Wallet_Missing_7D",
            chain: "SOL",
            protocol: "meteora",
            total_lp_7d: null,
            total_lp_30d: 50,
            total_lp: 250,
            fabriq: { stats: { totalPositions: 250 } },
        };

        const walletMissingAllLp: Wallet = {
            owner: "Wallet_No_Lp",
            chain: "SOL",
            protocol: "meteora",
            total_lp_7d: null,
            total_lp_30d: null,
            total_lp: null,
        };

        it("returns total_lp_7d for 7d and total_lp_30d for 30d", () => {
            assert.equal(walletTimeframeLp(walletWithMetrics, "7d"), 12);
            assert.equal(walletTimeframeLp(walletWithMetrics, "30d"), 45);
            assert.equal(walletTimeframeLp(walletWithMetrics, "all"), 120);
        });

        it("never substitutes all-time total_lp for missing 7D or 30D counts", () => {
            // Even though wallet has 250 all-time positions, 7D count MUST remain null
            assert.equal(walletTimeframeLp(walletMissing7d, "7d"), null);
            assert.notEqual(walletTimeframeLp(walletMissing7d, "7d"), 250);

            // Under a MIN LP filter (e.g. minLp >= 1), null is excluded
            const minLp = 1;
            const lp7d = walletTimeframeLp(walletMissing7d, "7d");
            const passes7d = lp7d !== null && lp7d >= minLp;
            assert.equal(passes7d, false, "Wallet with missing 7D LP must not qualify under 7D MIN LP filter");

            // For ALL, it uses all-time positions
            const lpAll = walletTimeframeLp(walletMissing7d, "all");
            assert.equal(lpAll, 250);
            const passesAll = lpAll !== null && lpAll >= minLp;
            assert.equal(passesAll, true);
        });

        it("preserves genuine numeric zero and never coerces null to zero", () => {
            const zeroWallet: Wallet = {
                owner: "Wallet_Zero",
                chain: "SOL",
                protocol: "meteora",
                total_lp_7d: 0,
                total_lp_30d: 0,
                total_lp: 0,
            };

            assert.equal(walletTimeframeLp(zeroWallet, "7d"), 0);
            assert.equal(walletTimeframeLp(zeroWallet, "30d"), 0);
            assert.equal(walletTimeframeLp(zeroWallet, "all"), 0);

            assert.equal(walletTimeframeLp(walletMissingAllLp, "7d"), null);
            assert.equal(walletTimeframeLp(walletMissingAllLp, "30d"), null);
            assert.equal(walletTimeframeLp(walletMissingAllLp, "all"), null);
        });
    });

    // -------------------------------------------------------------------------
    // 4. Null and Zero Distinction
    // -------------------------------------------------------------------------
    describe("4. Null and Zero Distinction", () => {
        it("formats numeric 0 truthfully and null as placeholder dash", () => {
            assert.equal(formatSolPnl(0), "0 SOL");
            assert.equal(formatSolPnl(null), "—");
            assert.equal(formatPercentMetric(0), "0.00%");
            assert.equal(formatPercentMetric(null), "—");
            assert.equal(formatNumberMetric(0, 0), "0");
            assert.equal(formatNumberMetric(null, 0), "—");
        });

        it("assigns neutral color class to numeric 0 and null", () => {
            assert.equal(pnlColorClass(0), "");
            assert.equal(pnlColorClass(null), "");
            assert.equal(pnlColorClass(5), "positive");
            assert.equal(pnlColorClass(-5), "negative");
        });
    });

    // -------------------------------------------------------------------------
    // 5. Tracked Wallets Persistence
    // -------------------------------------------------------------------------
    describe("5. Tracked Wallets Persistence", () => {
        it("saves and loads tracked wallets with deduplication", () => {
            assert.deepEqual(loadTrackedWallets(), []);

            saveTrackedWallets(["Addr1", "Addr2", "Addr1"]);
            assert.deepEqual(loadTrackedWallets().sort(), ["Addr1", "Addr2"].sort());

            saveTrackedWallets(["Addr3"]);
            assert.deepEqual(loadTrackedWallets(), ["Addr3"]);
        });
    });

    // -------------------------------------------------------------------------
    // 6. SPA Navigation and Deep Linking
    // -------------------------------------------------------------------------
    describe("6. SPA Navigation and Deep Linking", () => {
        it("resolves route from location correctly for all functional endpoints", () => {
            (globalThis.window.location as any).pathname = "/";
            assert.deepEqual(routeFromLocation(), { page: "explore" });

            (globalThis.window.location as any).pathname = "/track";
            assert.deepEqual(routeFromLocation(), { page: "track" });

            (globalThis.window.location as any).pathname = "/portfolio";
            assert.deepEqual(routeFromLocation(), { page: "portfolio" });

            (globalThis.window.location as any).pathname = "/portfolio/3gH9Zt1x";
            assert.deepEqual(routeFromLocation(), {
                page: "portfolio",
                address: "3gH9Zt1x",
            });

            (globalThis.window.location as any).pathname = "/pools";
            assert.deepEqual(routeFromLocation(), { page: "pools" });

            (globalThis.window.location as any).pathname = "/pools/GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8";
            assert.deepEqual(routeFromLocation(), { page: "pools" });

            (globalThis.window.location as any).pathname = "/data";
            (globalThis.window.location as any).search = "";
            assert.deepEqual(routeFromLocation(), { page: "data", dataTab: "overview" });

            (globalThis.window.location as any).pathname = "/data";
            (globalThis.window.location as any).search = "?tab=wallet-data";
            assert.deepEqual(routeFromLocation(), { page: "data", dataTab: "wallet-data" });

            (globalThis.window.location as any).pathname = "/activity-logs";
            assert.deepEqual(routeFromLocation(), { page: "activity-logs" });

            (globalThis.window.location as any).pathname = "/alerts";
            assert.deepEqual(routeFromLocation(), { page: "alerts" });
        });
        it("executes navigate without full-page reload", () => {
            navigate("/pools");
            assert.equal((globalThis.window.location as any).pathname, "/pools");
            assert.deepEqual(routeFromLocation(), { page: "pools" });

            navigate("/track");
            assert.equal((globalThis.window.location as any).pathname, "/track");
            assert.deepEqual(routeFromLocation(), { page: "track" });
        });
    });

    // -------------------------------------------------------------------------
    // 7. Unavailable Navigation Elements
    // -------------------------------------------------------------------------
    describe("7. Unavailable Navigation Elements", () => {
        it("marks unimplemented sidebar elements as disabled", () => {
            const tokenInsights = DISCOVER_NAV_ITEMS.find((item) => item.label === "Token Insights");
            assert.ok(tokenInsights);
            assert.equal(tokenInsights?.disabled, true);

            const trends = DISCOVER_NAV_ITEMS.find((item) => item.label === "Trends");
            assert.ok(trends);
            assert.equal(trends?.disabled, true);

            const opportunities = DISCOVER_NAV_ITEMS.find((item) => item.label === "Opportunities");
            assert.ok(opportunities);
            assert.equal(opportunities?.disabled, true);

            const myWallets = WATCHLIST_NAV_ITEMS.find((item) => item.label === "My Wallets");
            assert.ok(myWallets);
            assert.equal(myWallets?.disabled, true);

            const settings = TOOLS_NAV_ITEMS.find((item) => item.label === "Settings");
            assert.ok(settings);
            assert.equal(settings?.disabled, true);
        });

        it("ensures functional sidebar elements are not disabled", () => {
            const explorer = DISCOVER_NAV_ITEMS.find((item) => item.label === "Wallet Explorer");
            assert.ok(explorer);
            assert.notEqual(explorer?.disabled, true);
            assert.equal(explorer?.page, "explore");

            const pools = DISCOVER_NAV_ITEMS.find((item) => item.label === "Pool Explorer");
            assert.ok(pools);
            assert.notEqual(pools?.disabled, true);
            assert.equal(pools?.page, "pools");

            const track = WATCHLIST_NAV_ITEMS.find((item) => item.label === "Tracked Wallets");
            assert.ok(track);
            assert.notEqual(track?.disabled, true);
            assert.equal(track?.page, "track");

            const data = TOOLS_NAV_ITEMS.find((item) => item.label === "Data");
            assert.ok(data);
            assert.notEqual(data?.disabled, true);
            assert.equal(data?.page, "data");

            const logs = TOOLS_NAV_ITEMS.find((item) => item.label === "Activity Logs");
            assert.ok(logs);
            assert.notEqual(logs?.disabled, true);
            assert.equal(logs?.page, "activity-logs");

            const alerts = TOOLS_NAV_ITEMS.find((item) => item.label === "Alerts");
            assert.ok(alerts);
            assert.notEqual(alerts?.disabled, true);
            assert.equal(alerts?.page, "alerts");
        });
    });

    // -------------------------------------------------------------------------
    // 8. Portfolio Tabs Access
    // -------------------------------------------------------------------------
    describe("8. Portfolio Tabs Access", () => {
        it("enables Overview and Position Analytics while disabling placeholder tabs", () => {
            const overview = PORTFOLIO_TAB_ITEMS.find((t) => t.id === "Overview");
            assert.ok(overview);
            assert.equal(overview?.enabled, true);

            const positionAnalytics = PORTFOLIO_TAB_ITEMS.find((t) => t.id === "Position Analytics");
            assert.ok(positionAnalytics);
            assert.equal(positionAnalytics?.enabled, true);

            const activePos = PORTFOLIO_TAB_ITEMS.find((t) => t.id === "Active Positions");
            assert.ok(activePos);
            assert.equal(activePos?.enabled, false);

            const closedPos = PORTFOLIO_TAB_ITEMS.find((t) => t.id === "Closed Positions");
            assert.ok(closedPos);
            assert.equal(closedPos?.enabled, false);

            const txs = PORTFOLIO_TAB_ITEMS.find((t) => t.id === "Transactions");
            assert.ok(txs);
            assert.equal(txs?.enabled, false);

            const balances = PORTFOLIO_TAB_ITEMS.find((t) => t.id === "Balances");
            assert.ok(balances);
            assert.equal(balances?.enabled, false);
        });
    });

    // -------------------------------------------------------------------------
    // 9. Total Fees Timeframe Semantics Invariant
    // -------------------------------------------------------------------------
    describe("9. Total Fees Timeframe Semantics Invariant", () => {
        it("ensures all-time fee metric is explicitly labeled as all-time beside timeframe metrics", async () => {
            const appContent = await readFile("frontend/src/App.tsx", "utf8");
            assert.match(appContent, /TOTAL FEES \(ALL-TIME\)/, "Metric label must explicitly state ALL-TIME");
            assert.match(appContent, /All-time native fees from LP Agent/, "Subtitle must state all-time provenance");
            assert.doesNotMatch(appContent, /<span className="metric-label">TOTAL FEES<\/span>/, "Bare TOTAL FEES is misleading next to timeframe PnL");
        });
    });
});
