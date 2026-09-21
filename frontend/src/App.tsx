import {
  Download,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Filters, defaultFilters, type FilterState } from "./components/Filters";
import { Sidebar } from "./components/Sidebar";
import { WalletTable, type WalletSortKey } from "./components/WalletTable";
import { compact, fmt } from "./lib/format";
import { loadWalletDataset } from "./lib/walletData";
import { loadTrackedWallets, saveTrackedWallets } from "./lib/trackedWallets";
import { PortfolioPage } from "./pages/PortfolioPage";
import { TrackPage } from "./pages/TrackPage";
import type { Wallet } from "./types";

type Timeframe = "7d" | "30d" | "all";
type Page = "explore" | "track" | "portfolio";

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

function routeFromLocation(): { page: Page; address?: string } {
  const match = window.location.pathname.match(/^\/portfolio\/([^/]+)$/);
  if (match) {
    return {
      page: "portfolio",
      address: decodeURIComponent(match[1]),
    };
  }

  if (window.location.pathname === "/portfolio") {
    return { page: "portfolio" };
  }

  if (window.location.pathname === "/track") {
    return { page: "track" };
  }

  return { page: "explore" };
}

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function walletPnl(wallet: Wallet, timeframe: Timeframe) {
  if (timeframe === "30d") return wallet.total_pnl_native_30d;
  if (timeframe === "all") return wallet.total_pnl_native;
  return wallet.total_pnl_native_7d;
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

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    loadWalletDataset()
      .then((dataset) => {
        setWallets(dataset.wallets);

        setDataUpdatedAt(
          dataset.meta?.publishedAt ?? null,
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    saveTrackedWallets([...trackedOwners]);
  }, [trackedOwners]);

  const selectedPortfolioWallet = useMemo(() => {
    if (!route.address) return undefined;
    return wallets.find((wallet) => wallet.owner === route.address);
  }, [route.address, wallets]);

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
      if (search && !wallet.owner.toLowerCase().includes(search)) return false;
      if (minPnl !== null && wallet.total_pnl_native_7d < minPnl) return false;
      if (minLp !== null && wallet.total_lp_7d < minLp) return false;
      if (minWin !== null && wallet.win_rate_native * 100 < minWin) return false;
      if (minPools !== null && wallet.total_pool < minPools) return false;

      const firstActivity = new Date(wallet.first_activity).getTime();
      if (firstFrom !== null && firstActivity < firstFrom) return false;
      if (firstTo !== null && firstActivity > firstTo) return false;

      return true;
    });
  }, [wallets, filters]);

  const sorted = useMemo(() => {
    const rows = [...filtered];

    const value = (wallet: Wallet, key: WalletSortKey): string | number => {
      switch (key) {
        case "wallet":
          return wallet.owner;
        case "pnl7":
          return wallet.total_pnl_native_7d;
        case "win":
          return wallet.win_rate_native;
        case "winDays": {
          const dayStats =
            wallet.fabriq?.stats?.dayWinUsd ??
            wallet.fabriq?.stats?.dayWinSol;

          return Number(
            dayStats?.wins ?? 0,
          );
        }

        case "loseDays": {
          const dayStats =
            wallet.fabriq?.stats?.dayWinUsd ??
            wallet.fabriq?.stats?.dayWinSol;

          return Number(
            dayStats?.losses ?? 0,
          );
        }
        case "pnl30":
          return wallet.total_pnl_native_30d;
        case "pnlAll":
          return wallet.total_pnl_native;
        case "positions":
          return wallet.total_lp;
        case "walletAge":
          return Date.now() - new Date(wallet.first_activity).getTime();
        case "age":
          return wallet.avg_age_hour;
        case "ev":
          return wallet.expected_value_native;
        case "invested":
          return wallet.avg_inflow_native;
        case "monthly":
          return wallet.avg_monthly_pnl_native;
        case "fees":
          return wallet.total_fee_native;
        case "last":
          return new Date(wallet.last_activity).getTime();
      }
    };

    rows.sort((a, b) => {
      const av = value(a, sortKey);
      const bv = value(b, sortKey);

      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }

      return sortDir === "asc"
        ? Number(av) - Number(bv)
        : Number(bv) - Number(av);
    });

    return rows;
  }, [filtered, sortDir, sortKey]);

  const stats = useMemo(() => {
    const pnl = filtered.reduce((sum, wallet) => sum + walletPnl(wallet, timeframe), 0);
    const fees = filtered.reduce((sum, wallet) => sum + wallet.total_fee_native, 0);
    const avgWin =
      filtered.length > 0
        ? filtered.reduce((sum, wallet) => sum + wallet.win_rate_native, 0) /
        filtered.length
        : 0;

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
    <div className="app-shell">
      <Sidebar
        activePage={topPage}
        onNavigate={(page) =>
          navigate(
            page === "portfolio"
              ? "/portfolio"
              : page === "track"
                ? "/track"
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
            <button>COPY TRADE</button>
            <button
              className={topPage === "portfolio" ? "active" : ""}
              onClick={() => navigate("/portfolio")}
            >
              PORTFOLIO
            </button>
            <button>LEADERBOARD</button>
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

            <button className="icon-btn bordered" onClick={() => window.location.reload()}>
              <RefreshCw size={15} />
            </button>
          </div>
        </header>

        {route.page === "portfolio" ? (
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
          />
        ) : route.page === "track" ? (
          <TrackPage
            wallets={wallets}
            trackedOwners={trackedOwners}
            onToggleTrack={toggleTrackedWallet}
            onOpenWallet={openWallet}
          />
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
                      onClick={() => setTimeframe(item)}
                    >
                      {item.toUpperCase()}
                    </button>
                  ))}
                </div>

                <div className="dataset-status">
                  <span className="wallet-count">
                    {filtered.length} wallets found
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

                <button
                  className="secondary-button"
                  onClick={() => {
                    const csv = [
                      "wallet,pnl7,winRate,pnl30,pnlAll,positions",
                      ...sorted.map((wallet) =>
                        [
                          wallet.owner,
                          wallet.total_pnl_native_7d,
                          wallet.win_rate_native,
                          wallet.total_pnl_native_30d,
                          wallet.total_pnl_native,
                          wallet.total_lp,
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
                    <small>{wallets.length.toLocaleString()} wallets in current snapshot</small>
                  </div>

                  <div className="metric-card">
                    <span className="metric-label">TOTAL {timeframe.toUpperCase()} PNL</span>
                    <strong className={stats.pnl >= 0 ? "positive" : "negative"}>
                      {stats.pnl >= 0 ? "+" : ""}
                      {compact(stats.pnl)} SOL
                    </strong>
                    <small>Native PnL across filtered wallets</small>
                  </div>

                  <div className="metric-card">
                    <span className="metric-label">AVG WIN RATE</span>
                    <strong className="positive">{fmt(stats.avgWin * 100, 1)}%</strong>
                    <small>Average native position win rate</small>
                  </div>

                  <div className="metric-card">
                    <span className="metric-label">TOTAL FEES</span>
                    <strong>{compact(stats.fees)} SOL</strong>
                    <small>Native fee field from LP Agent</small>
                  </div>
                </div>

                {filtersOpen ? (
                  <Filters
                    draft={draftFilters}
                    setDraft={setDraftFilters}
                    onApply={() => setFilters(draftFilters)}
                  />
                ) : null}

                <WalletTable
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
