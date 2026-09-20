import {
  BarChart3,
  Coins,
  RefreshCw,
  Search,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Filters, defaultFilters, type FilterState } from "./components/Filters";
import { MetricCard } from "./components/MetricCard";
import { Sidebar } from "./components/Sidebar";
import { WalletDetailPanel } from "./components/WalletDetailPanel";
import { WalletTable } from "./components/WalletTable";
import { compact, fmt } from "./lib/format";
import { loadWalletDataset } from "./lib/walletData";
import type { SortKey, Wallet } from "./types";

function num(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function App() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Wallet | undefined>();
  const [draftFilters, setDraftFilters] = useState<FilterState>(defaultFilters);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [sortKey, setSortKey] = useState<SortKey>("last_activity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    loadWalletDataset()
      .then((dataset) => {
        setWallets(dataset.wallets);
        setSelected(dataset.wallets[0]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    const minPnl = num(filters.minPnl);
    const minLp = num(filters.minLp);
    const minWin = num(filters.minWinRate);
    const minPools = num(filters.minPools);
    const firstFrom = filters.firstActivityFrom
      ? new Date(`${filters.firstActivityFrom}T00:00:00Z`).getTime()
      : null;

    return wallets.filter((w) => {
      if (search && !w.owner.toLowerCase().includes(search)) return false;
      if (minPnl !== null && w.total_pnl_native_7d < minPnl) return false;
      if (minLp !== null && w.total_lp_7d < minLp) return false;
      if (minWin !== null && w.win_rate_native * 100 < minWin) return false;
      if (minPools !== null && w.total_pool < minPools) return false;
      if (firstFrom !== null && new Date(w.first_activity).getTime() < firstFrom) return false;
      return true;
    });
  }, [wallets, filters]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      let av: string | number = a[sortKey] as string | number;
      let bv: string | number = b[sortKey] as string | number;

      if (sortKey === "last_activity") {
        av = new Date(String(av)).getTime();
        bv = new Date(String(bv)).getTime();
      }

      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc"
        ? Number(av) - Number(bv)
        : Number(bv) - Number(av);
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  const stats = useMemo(() => {
    const profitable = filtered.filter((w) => w.total_pnl_native_7d > 0).length;
    const pnl = filtered.reduce((sum, w) => sum + w.total_pnl_native_7d, 0);
    const fees = filtered.reduce((sum, w) => sum + w.total_fee_native, 0);
    return { profitable, pnl, fees };
  }, [filtered]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div className="app-shell">
      <Sidebar />

      <main className="main-content">
        <header className="topbar">
          <div className="top-search">
            <Search size={15} />
            <input
              placeholder="Search wallet, pool, token..."
              value={draftFilters.search}
              onChange={(e) =>
                setDraftFilters({ ...draftFilters, search: e.target.value })
              }
              onKeyDown={(e) => e.key === "Enter" && setFilters(draftFilters)}
            />
            <span>/</span>
          </div>

          <div className="topbar-right">
            <button className="network-select">◎ Solana</button>
            <button className="date-range">14D · Sep 6–20, 2026</button>
            <button className="icon-btn bordered" onClick={() => location.reload()}>
              <RefreshCw size={14} />
            </button>
          </div>
        </header>

        <div className="workspace">
          <section className="explorer-pane">
            <div className="page-heading">
              <div>
                <h1>Wallet Explorer</h1>
                <p>Discover and analyze LP wallets on Meteora.</p>
              </div>
            </div>

            {loading ? <div className="state-card">Loading 14-day wallet snapshot…</div> : null}
            {error ? <div className="state-card error">{error}</div> : null}

            {!loading && !error ? (
              <>
                <div className="metrics-row">
                  <MetricCard
                    label="Total Wallets"
                    value={filtered.length.toLocaleString()}
                    helper={`${wallets.length.toLocaleString()} in snapshot`}
                    icon={<WalletCards size={15} />}
                  />
                  <MetricCard
                    label="Profitable Wallets"
                    value={stats.profitable.toLocaleString()}
                    helper={`${fmt(filtered.length ? (stats.profitable / filtered.length) * 100 : 0, 1)}% of filtered`}
                    positive
                  />
                  <MetricCard
                    label="Total PnL 7D"
                    value={`${stats.pnl >= 0 ? "+" : ""}${compact(stats.pnl)} SOL`}
                    helper="Sum of native 7D PnL"
                    icon={<BarChart3 size={15} />}
                    positive={stats.pnl >= 0}
                  />
                  <MetricCard
                    label="Total Fees"
                    value={`${compact(stats.fees)} SOL`}
                    helper="All-time native fee field"
                    icon={<Coins size={15} />}
                    positive
                  />
                </div>

                <Filters
                  draft={draftFilters}
                  setDraft={setDraftFilters}
                  onApply={() => setFilters(draftFilters)}
                  onReset={() => {
                    setDraftFilters(defaultFilters);
                    setFilters(defaultFilters);
                  }}
                />

                <WalletTable
                  wallets={sorted}
                  totalUnfiltered={wallets.length}
                  selected={selected?.owner}
                  onSelect={setSelected}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
              </>
            ) : null}
          </section>

          <WalletDetailPanel wallet={selected} />
        </div>
      </main>
    </div>
  );
}
