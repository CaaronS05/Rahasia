import {
  Download,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Filters, defaultFilters, type FilterState } from "./components/Filters";
import { Sidebar } from "./components/Sidebar";
import { WalletTable, type WalletSortKey } from "./components/WalletTable";
import { compact, fmt } from "./lib/format";
import { useDataPipelineStatus } from "./lib/dataPipelineStatus";
import {
  loadWalletDataset,
  loadWalletIntelligenceV1,
  joinWalletsWithIntelligenceV1,
} from "./lib/walletData";
import { loadTrackedWallets, saveTrackedWallets } from "./lib/trackedWallets";
import { DataPage, resolveDataTab, type DataTab } from "./pages/DataPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { TrackPage } from "./pages/TrackPage";
import { ActivityLogsPage } from "./pages/ActivityLogsPage";
import { PoolInsightPage } from "./pages/PoolInsightPage";
import { AlertsView } from "./pages/AlertsView";
import type { Wallet, WalletDataset } from "./types";
import {
  countUnknownActivityWallets,
  isWalletTimeframeEligible,
  pnlColorClass,
  resolveReferenceDate,
  resolveSortKeyForTimeframeChange,
  sortWallets,
  toFiniteNumber,
  walletAllTimePnl,
  walletEffectiveFirstActivity,
  walletPnl30d,
  walletPnl7d,
  walletPositions,
  walletTimeframeLp,
  walletTimeframePnl,
  walletWinRatePercent,
} from "./lib/walletMetrics";
import {
  type Timeframe,
  type Page,
  routeFromLocation,
  navigate,
} from "./lib/navigation";
export type { Timeframe, Page };
export { routeFromLocation, navigate };

function formatUpdatedAt(
  value: string | null,
) {
  if (!value) return "—";

  const date = new Date(value);

  if (
    !Number.isFinite(date.getTime())
  ) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  ).format(date);
}

function num(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}




export default function App() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [dataUpdatedAt, setDataUpdatedAt] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(routeFromLocation);
  const [timeframe, setTimeframe] = useState<Timeframe>("7d");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<FilterState>(defaultFilters);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [sortKey, setSortKey] = useState<WalletSortKey>("pnl7");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [globalSearch, setGlobalSearch] = useState("");
  const [trackedOwners, setTrackedOwners] = useState<Set<string>>(
    () => new Set(loadTrackedWallets()),
  );
  const [intelligenceUpdatedAt, setIntelligenceUpdatedAt] = useState<string | null>(null);
  const [datasetMeta, setDatasetMeta] = useState<WalletDataset["meta"] | null>(null);

  const refreshDataset = useCallback(() => {
    return Promise.all([
      loadWalletDataset(),
      loadWalletIntelligenceV1().catch((err) => {
        console.warn(
          "Failed to load V1 wallet intelligence, continuing without V1 data:",
          err,
        );
        return null;
      }),
    ])
      .then(([dataset, intelData]) => {
        const joined = joinWalletsWithIntelligenceV1(dataset.wallets, intelData);
        setWallets(joined);
        setIntelligenceUpdatedAt(intelData?.generatedAt ?? null);
        setDataUpdatedAt(dataset.meta?.publishedAt ?? null);
        setDatasetMeta(dataset.meta ?? null);
      })
      .catch((err) => {
        console.error("Failed to load wallet dataset:", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    refreshDataset();
  }, [refreshDataset]);

  const pipelines = useDataPipelineStatus(refreshDataset);
  const dataUpdateRunning = pipelines.anyRunning;

  useEffect(() => {
    saveTrackedWallets([...trackedOwners]);
  }, [trackedOwners]);

  const selectedPortfolioWallet = useMemo(() => {
    if (!route.address) return undefined;
    return wallets.find((wallet) => wallet.owner === route.address);
  }, [route.address, wallets]);
  const referenceDate = useMemo(() => resolveReferenceDate(datasetMeta), [datasetMeta]);
  const unknownCoverageCount = useMemo(() => countUnknownActivityWallets(wallets), [wallets]);

  const filtered = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    const minPnl = num(filters.minPnl);
    const minLp = num(filters.minLp);
    const minWin = num(filters.minWinRate);
    const minPools = num(filters.minPools);
    const firstFrom = filters.firstActivityFrom
      ? new Date(`${filters.firstActivityFrom}T00:00:00Z`).getTime()
      : null;
    const firstTo = filters.firstActivityTo
      ? new Date(`${filters.firstActivityTo}T23:59:59.999Z`).getTime()
      : null;

    return wallets.filter((wallet) => {
      if (!isWalletTimeframeEligible(wallet, timeframe, referenceDate)) {
        return false;
      }
      if (search && !wallet.owner.toLowerCase().includes(search)) return false;
      const pnl = walletTimeframePnl(wallet, timeframe);
      if (
        minPnl !== null &&
        (pnl === null || pnl < minPnl)
      ) {
        return false;
      }
      const lp = walletTimeframeLp(wallet, timeframe);
      if (minLp !== null && (lp === null || lp < minLp)) return false;
      if (minWin !== null) {
        const wr = walletWinRatePercent(wallet);
        if (wr === null || wr < minWin) return false;
      }
      const pools = toFiniteNumber(wallet.total_pool);
      if (minPools !== null && (pools === null || pools < minPools)) return false;
      const firstActivityIso = walletEffectiveFirstActivity(wallet);
      const firstActivity = firstActivityIso ? new Date(firstActivityIso).getTime() : NaN;
      if (firstFrom !== null) {
        if (!Number.isFinite(firstActivity) || firstActivity < firstFrom) return false;
      }
      if (firstTo !== null) {
        if (!Number.isFinite(firstActivity) || firstActivity > firstTo) return false;
      }

      return true;
    });
  }, [wallets, timeframe, referenceDate, filters]);
  const sorted = useMemo(() => {
    return sortWallets(filtered, sortKey, sortDir);
  }, [filtered, sortDir, sortKey]);

  const hasActiveFilters = Boolean(
    filters.search ||
    filters.minPnl ||
    filters.minLp ||
    filters.minWinRate ||
    filters.minPools ||
    filters.firstActivityFrom ||
    filters.firstActivityTo,
  );

  const resetFilters = useCallback(() => {
    setDraftFilters(defaultFilters);
    setFilters(defaultFilters);
  }, []);

  const stats = useMemo(() => {
    const pnl = filtered.reduce(
      (sum, wallet) => sum + (walletTimeframePnl(wallet, timeframe) ?? 0),
      0,
    );
    const fees = filtered.reduce(
      (sum, wallet) => sum + (toFiniteNumber(wallet.total_fee_native) ?? 0),
      0,
    );
    const walletsWithWinRate = filtered
      .map((wallet) => walletWinRatePercent(wallet))
      .filter((rate): rate is number => rate !== null);
    const avgWin =
      walletsWithWinRate.length > 0
        ? walletsWithWinRate.reduce((sum, rate) => sum + rate, 0) /
          walletsWithWinRate.length
        : null;

    return { pnl, fees, avgWin };
  }, [filtered, timeframe]);

  function handleSort(key: WalletSortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(key);
    setSortDir("desc");
  }
  function handleTimeframeChange(item: Timeframe) {
    setTimeframe(item);
    setSortKey((current) => resolveSortKeyForTimeframeChange(current, item));
  }

  function toggleTrackedWallet(owner: string) {
    setTrackedOwners((current) => {
      const next = new Set(current);

      if (next.has(owner)) {
        next.delete(owner);
      } else {
        next.add(owner);
      }

      return next;
    });
  }

  function openWallet(wallet: Wallet) {
    navigate(`/portfolio/${encodeURIComponent(wallet.owner)}`);
  }

  function openPortfolioAddress(address: string) {
    const cleaned = address.trim();
    if (!cleaned) {
      navigate("/portfolio");
      return;
    }

    navigate(`/portfolio/${encodeURIComponent(cleaned)}`);
  }

  function handleGlobalSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    const cleaned = globalSearch.trim();
    if (!cleaned) return;
    openPortfolioAddress(cleaned);
  }

  const topPage = route.page;

  return (
    <div className={`app-shell page-${topPage}`}>
      <Sidebar
        activePage={topPage}
        onNavigate={(page) =>
          navigate(
            page === "portfolio"
              ? "/portfolio"
              : page === "track"
                ? "/track"
                : page === "pools"
                  ? "/pools"
                  : page === "data"
                    ? "/data"
                    : page === "activity-logs"
                      ? "/activity-logs"
                      : "/",
          )
        }
      />

      <main className="main-content">
        <header className="topbar">
          <nav className="top-nav">
            <button
              className={topPage === "explore" ? "active" : ""}
              onClick={() => navigate("/")}
            >
              EXPLORE
            </button>
            <button
              className={route.page === "track" ? "active" : ""}
              onClick={() => navigate("/track")}
            >
              TRACK
            </button>
            <button
              className={route.page === "pools" ? "active" : ""}
              onClick={() => navigate("/pools")}
            >
              POOLS
            </button>
            <button
              className="top-nav-disabled"
              disabled
              aria-disabled="true"
              title="Unavailable"
            >
              COPY TRADE
            </button>
            <button
              className={topPage === "portfolio" ? "active" : ""}
              onClick={() => navigate("/portfolio")}
            >
              PORTFOLIO
            </button>
            <button
              className="top-nav-disabled"
              disabled
              aria-disabled="true"
              title="Unavailable"
            >
              LEADERBOARD
            </button>
          </nav>

          <div className="topbar-right">
            <form className="top-search" onSubmit={handleGlobalSearchSubmit}>
              <Search size={16} />
              <input
                placeholder="Search wallet address..."
                value={globalSearch}
                onChange={(event) => setGlobalSearch(event.target.value)}
              />
              <span>⌘ K</span>
            </form>

            <button className="network-select">
              <span className="solana-mark">≋</span>
              Solana
            </button>

            <button
              className={`icon-btn bordered ${dataUpdateRunning ? "fabriq-active" : ""}`}
              onClick={() => navigate("/data?tab=wallet-data")}
              title={
                dataUpdateRunning
                  ? "Update pipeline is running — click to view progress"
                  : "Update wallet data"
              }
            >
              <RefreshCw size={15} className={dataUpdateRunning ? "spin" : ""} />
              {dataUpdateRunning && <span className="fabriq-active-dot" />}
            </button>
          </div>
        </header>

        {route.page === "pools" ? (
          <div className="pool-explorer-page">
            <PoolInsightPage />
          </div>
        ) : route.page === "data" ? (
          <DataPage
            tab={route.dataTab ?? "overview"}
            onTabChange={(tab) => navigate(`/data?tab=${tab}`)}
            walletCount={loading || error ? null : wallets.length}
            lastUpdated={dataUpdatedAt}
            intelligenceUpdatedAt={intelligenceUpdatedAt}
            pipelines={pipelines}
            onDatasetRefreshed={refreshDataset}
          />
        ) : route.page === "portfolio" ? (
          <PortfolioPage
            wallets={wallets}
            loading={loading}
            error={error}
            wallet={selectedPortfolioWallet}
            requestedAddress={route.address}
            onSearch={openPortfolioAddress}
            onBack={() => navigate("/")}
            isTracked={
              selectedPortfolioWallet
                ? trackedOwners.has(selectedPortfolioWallet.owner)
                : false
            }
            onToggleTrack={toggleTrackedWallet}
            referenceDate={referenceDate}
          />
        ) : route.page === "track" ? (
          <TrackPage
            wallets={wallets}
            trackedOwners={trackedOwners}
            onToggleTrack={toggleTrackedWallet}
            onOpenWallet={openWallet}
          />
        ) : route.page === "activity-logs" ? (
          <ActivityLogsPage />
        ) : route.page === "alerts" ? (
          <AlertsView />
        ) : (
          <div className="explorer-page">
            <div className="page-heading explorer-heading">
              <div>
                <h1>Wallet Explorer</h1>
                <p>Discover and compare Meteora DLMM wallets on Solana.</p>
              </div>

              <div className="explorer-actions">
                <div className="segmented timeframe">
                  {(["7d", "30d", "all"] as Timeframe[]).map((item) => (
                    <button
                      key={item}
                      className={timeframe === item ? "active" : ""}
                      onClick={() => handleTimeframeChange(item)}
                    >
                      {item.toUpperCase()}
                    </button>
                  ))}
                </div>

                <div className="dataset-status">
                  <span className="wallet-count">
                    {filtered.length} wallets found
                    {unknownCoverageCount > 0 ? ` · ${unknownCoverageCount} unknown coverage` : ""}
                  </span>
                  <span className="data-updated">
                    Data updated{" "}
                    {formatUpdatedAt(dataUpdatedAt)}
                  </span>
                </div>

                <button
                  className={`secondary-button ${filtersOpen ? "active" : ""}`}
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  <SlidersHorizontal size={15} />
                  Filters
                </button>

                {hasActiveFilters ? (
                  <button
                    className="ghost-button reset-filters-toolbar-btn"
                    onClick={resetFilters}
                    title="Reset active screening filters"
                  >
                    Reset Filters
                  </button>
                ) : null}
                <button
                  className="secondary-button"
                  onClick={() => {
                    const csv = [
                      "wallet,pnl7,winRate,pnl30,pnlAll,positions",
                      ...sorted.map((wallet) =>
                        [
                          wallet.owner,
                          walletPnl7d(wallet) ?? "",
                          walletWinRatePercent(wallet) ?? "",
                          walletPnl30d(wallet) ?? "",
                          walletAllTimePnl(wallet) ?? "",
                          walletPositions(wallet) ?? "",
                        ].join(","),
                      ),
                    ].join("\n");

                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = "wallets.csv";
                    anchor.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download size={15} />
                  Export
                </button>
              </div>
            </div>

            {loading ? <div className="state-card">Loading wallet snapshot…</div> : null}
            {error ? <div className="state-card error">{error}</div> : null}

            {!loading && !error ? (
              <>
                <div className="metrics-row">
                  <div className="metric-card">
                    <span className="metric-label">TOTAL WALLETS</span>
                    <strong>{filtered.length.toLocaleString()}</strong>
                    <small>
                      {wallets.length.toLocaleString()} wallets in current snapshot
                      {unknownCoverageCount > 0 ? ` (${unknownCoverageCount} unknown coverage)` : ""}
                    </small>
                  </div>

                  <div className="metric-card">
                    <span className="metric-label">TOTAL {timeframe.toUpperCase()} PNL</span>
                    <strong className={pnlColorClass(stats.pnl)}>
                      {stats.pnl > 0 ? "+" : ""}
                      {compact(stats.pnl)} SOL
                    </strong>
                    <small>Native PnL across filtered wallets</small>
                  </div>

                  <div className="metric-card">
                    <span className="metric-label">AVG WIN RATE</span>
                    <strong className="positive">{stats.avgWin !== null ? `${fmt(stats.avgWin, 1)}%` : "—"}</strong>
                    <small>Average native position win rate</small>
                  </div>

                  <div className="metric-card">
                    <span className="metric-label">TOTAL FEES (ALL-TIME)</span>
                    <strong>{compact(stats.fees)} SOL</strong>
                    <small>All-time native fees from LP Agent</small>
                  </div>
                </div>

                {filtersOpen ? (
                  <Filters
                    draft={draftFilters}
                    setDraft={setDraftFilters}
                    onApply={() => setFilters(draftFilters)}
                    onReset={resetFilters}
                    timeframe={timeframe}
                  />
                ) : null}

                <WalletTable
                  key={timeframe}
                  timeframe={timeframe}
                  wallets={sorted}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  onOpenWallet={openWallet}
                  trackedOwners={trackedOwners}
                  onToggleTrack={toggleTrackedWallet}
                />
              </>
            ) : null}
          </div>
        )}
      </main>


    </div>
  );
}
