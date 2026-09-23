import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import {
  getPools,
  type LegacyDlmmPool,
  type PoolApiResponse,
  type PoolSortKey,
  type SortOrder,
} from "../lib/poolData";

type NumericDraft = {
  minTvl: string;
  maxTvl: string;
  minVolume24h: string;
  minFees24h: string;
  minFeeTvl24h: string;
  binStep: string;
};

const emptyDraft: NumericDraft = {
  minTvl: "",
  maxTvl: "",
  minVolume24h: "",
  minFees24h: "",
  minFeeTvl24h: "",
  binStep: "",
};

function parseOptionalNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCompact(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  if (Math.abs(value) >= 1000) {
    return `$${formatCompact(value)}`;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPct(value: number | null | undefined, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  return `${value.toFixed(digits)}%`;
}

function formatPrice(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  if (value >= 1000) return formatUsd(value);
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

function formatAge(createdAt: number | null) {
  if (!createdAt) return "—";

  const diff = Date.now() - createdAt;
  if (diff < 0) return "0d";

  const days = Math.floor(diff / 86_400_000);

  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;

  const years = days / 365;
  return `${years.toFixed(years >= 10 ? 0 : 1)}y`;
}

function formatUpdatedAt(value: string | null) {
  if (!value) return "—";

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function shortAddress(value: string) {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function SortButton({
  label,
  sortKey,
  activeKey,
  order,
  onSort,
}: {
  label: string;
  sortKey: PoolSortKey;
  activeKey: PoolSortKey;
  order: SortOrder;
  onSort: (key: PoolSortKey) => void;
}) {
  const active = sortKey === activeKey;

  return (
    <button
      className={`pool-sort-button ${active ? "active" : ""}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active ? (
        order === "desc" ? (
          <ArrowDown size={11} />
        ) : (
          <ArrowUp size={11} />
        )
      ) : null}
    </button>
  );
}

function TokenDetail({
  label,
  token,
}: {
  label: string;
  token: LegacyDlmmPool["tokenX"];
}) {
  return (
    <div className="pool-token-detail">
      <div className="pool-token-detail-heading">
        <span>{label}</span>
        <strong>
          {token.symbol ?? "Unknown"}
          {token.verified ? (
            <span className="verified-dot" title="Verified token" />
          ) : null}
        </strong>
      </div>

      <div className="pool-token-detail-grid">
        <div>
          <span>Price</span>
          <strong>{formatPrice(token.price)}</strong>
        </div>
        <div>
          <span>Market Cap</span>
          <strong>{formatUsd(token.marketCap)}</strong>
        </div>
        <div>
          <span>Holders</span>
          <strong>{formatCompact(token.holders)}</strong>
        </div>
        <div>
          <span>Supply</span>
          <strong>{formatCompact(token.totalSupply)}</strong>
        </div>
      </div>

      <div className="pool-mint-row">
        <code>{token.address ?? "—"}</code>
        {token.address ? (
          <button
            title="Copy token mint"
            onClick={() => navigator.clipboard.writeText(token.address!)}
          >
            <Copy size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function PoolExplorerPage() {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<NumericDraft>(emptyDraft);
  const [filters, setFilters] = useState<NumericDraft>(emptyDraft);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortBy, setSortBy] = useState<PoolSortKey>("volume24h");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const [response, setResponse] = useState<PoolApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedPool, setExpandedPool] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
      setPage(1);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setError("");

    getPools(
      {
        page,
        pageSize,
        query,
        minTvl: parseOptionalNumber(filters.minTvl),
        maxTvl: parseOptionalNumber(filters.maxTvl),
        minVolume24h: parseOptionalNumber(filters.minVolume24h),
        minFees24h: parseOptionalNumber(filters.minFees24h),
        minFeeTvl24h: parseOptionalNumber(filters.minFeeTvl24h),
        binStep: parseOptionalNumber(filters.binStep),
        sortBy,
        sortOrder,
      },
      controller.signal,
    )
      .then((data) => {
        setResponse(data);

        if (data.page !== page) {
          setPage(data.page);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }

        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [filters, page, pageSize, query, reloadKey, sortBy, sortOrder]);

  const rows = response?.data ?? [];

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((value) => value.trim() !== "").length,
    [filters],
  );

  function applyFilters() {
    setFilters(draft);
    setPage(1);
  }

  function clearFilters() {
    setDraft(emptyDraft);
    setFilters(emptyDraft);
    setPage(1);
  }

  function handleSort(key: PoolSortKey) {
    setPage(1);

    if (sortBy === key) {
      setSortOrder((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }

    setSortBy(key);
    setSortOrder("desc");
  }

  function navigateApp(pageName: "explore" | "track" | "portfolio") {
    const path =
      pageName === "track"
        ? "/track"
        : pageName === "portfolio"
          ? "/portfolio"
          : "/";

    window.location.assign(path);
  }

  return (
    <div className="app-shell">
      <Sidebar activePage="pools" onNavigate={navigateApp} />

      <main className="main-content">
        <header className="topbar">
          <nav className="top-nav">
            <button className="active" onClick={() => window.location.assign("/")}>
              EXPLORE
            </button>
            <button onClick={() => window.location.assign("/track")}>TRACK</button>
            <button>COPY TRADE</button>
            <button onClick={() => window.location.assign("/portfolio")}>
              PORTFOLIO
            </button>
            <button>LEADERBOARD</button>
          </nav>

          <div className="topbar-right">
            <div className="top-search">
              <Search size={16} />
              <input
                placeholder="Search pool, token, mint or address..."
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
              />
              {queryInput ? (
                <button
                  className="pool-top-search-clear"
                  title="Clear search"
                  onClick={() => setQueryInput("")}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>

            <button className="network-select">
              <span className="solana-mark">≋</span>
              Solana
            </button>

            <button
              className="icon-btn bordered"
              title="Reload cached pool data"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              <RefreshCw size={15} className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        <div className="pool-explorer-page">
          <div className="page-heading pool-page-heading">
            <div>
              <h1>Pool Explorer</h1>
              <p>
                Explore Legacy Meteora DLMM pools only. Permissionless V2 pools are excluded.
              </p>
            </div>

            <div className="pool-heading-actions">
              <div className="dataset-status">
                <span className="wallet-count">
                  {(response?.total ?? 0).toLocaleString()} pools found
                </span>
                <span className="data-updated">
                  Cache updated {formatUpdatedAt(response?.generatedAt ?? null)}
                </span>
              </div>

              <button
                className={`secondary-button ${filtersOpen ? "active" : ""}`}
                onClick={() => setFiltersOpen((current) => !current)}
              >
                <SlidersHorizontal size={15} />
                Filters
                {activeFilterCount > 0 ? (
                  <span className="pool-filter-count">{activeFilterCount}</span>
                ) : null}
              </button>
            </div>
          </div>

          <div className="pool-metrics-row">
            <div className="metric-card">
              <span className="metric-label">LEGACY DLMM RESULTS</span>
              <strong>{(response?.total ?? 0).toLocaleString()}</strong>
              <small>pairType = 0 only</small>
            </div>

            <div className="metric-card">
              <span className="metric-label">CURRENT PAGE</span>
              <strong>
                {response?.page ?? page}
                <span className="pool-metric-suffix"> / {response?.pages ?? 1}</span>
              </strong>
              <small>{pageSize} pools per page</small>
            </div>

            <div className="metric-card">
              <span className="metric-label">SORTED BY</span>
              <strong className="pool-sort-metric">{sortBy}</strong>
              <small>{sortOrder.toUpperCase()}</small>
            </div>

            <div className="metric-card">
              <span className="metric-label">DATA SOURCE</span>
              <strong className="pool-source-metric">METEORA</strong>
              <small>Local Legacy DLMM cache</small>
            </div>
          </div>

          {filtersOpen ? (
            <div className="pool-filter-panel">
              <div className="pool-filter-title">
                <SlidersHorizontal size={15} />
                <div>
                  <strong>Pool Filters</strong>
                  <span>Server-side filters against the Legacy DLMM cache.</span>
                </div>
              </div>

              <label className="pool-filter-control">
                <span>MIN TVL ($)</span>
                <input
                  type="number"
                  min="0"
                  placeholder="e.g. 100000"
                  value={draft.minTvl}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, minTvl: event.target.value }))
                  }
                />
              </label>

              <label className="pool-filter-control">
                <span>MAX TVL ($)</span>
                <input
                  type="number"
                  min="0"
                  placeholder="Optional"
                  value={draft.maxTvl}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxTvl: event.target.value }))
                  }
                />
              </label>

              <label className="pool-filter-control">
                <span>MIN VOLUME 24H ($)</span>
                <input
                  type="number"
                  min="0"
                  placeholder="e.g. 100000"
                  value={draft.minVolume24h}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      minVolume24h: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="pool-filter-control">
                <span>MIN FEES 24H ($)</span>
                <input
                  type="number"
                  min="0"
                  placeholder="e.g. 100"
                  value={draft.minFees24h}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      minFees24h: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="pool-filter-control">
                <span>MIN FEE / TVL 24H (%)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 0.1"
                  value={draft.minFeeTvl24h}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      minFeeTvl24h: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="pool-filter-control">
                <span>BIN STEP</span>
                <input
                  type="number"
                  min="0"
                  placeholder="e.g. 10"
                  value={draft.binStep}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, binStep: event.target.value }))
                  }
                />
              </label>

              <div className="pool-filter-actions">
                <button className="secondary-button" onClick={clearFilters}>
                  Clear
                </button>
                <button className="primary-button" onClick={applyFilters}>
                  Apply
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="state-card error">
              <strong>Pool Explorer failed to load.</strong>
              <span>{error}</span>
            </div>
          ) : null}

          <div className="pool-table-card">
            <div className="table-toolbar">
              <div>
                <strong>Legacy DLMM Pools</strong>
                <span>
                  {loading
                    ? "Loading..."
                    : `${response?.total.toLocaleString() ?? 0} matching pools`}
                </span>
              </div>

              <div className="pool-table-toolbar-right">
                <label>
                  <span>Rows</span>
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="pool-table-scroll">
              <table className="pool-table">
                <thead>
                  <tr>
                    <th className="pool-col-expand" />
                    <th>
                      <SortButton
                        label="POOL"
                        sortKey="name"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="BASE FEE"
                        sortKey="baseFeePct"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>DYNAMIC FEE</th>
                    <th>
                      <SortButton
                        label="BIN"
                        sortKey="binStep"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="TVL"
                        sortKey="tvl"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="VOLUME 24H"
                        sortKey="volume24h"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="FEES 24H"
                        sortKey="fees24h"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="FEE / TVL"
                        sortKey="feeTvl24h"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="APR"
                        sortKey="apr"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                    <th>
                      <SortButton
                        label="AGE"
                        sortKey="createdAt"
                        activeKey={sortBy}
                        order={sortOrder}
                        onSort={handleSort}
                      />
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {loading && rows.length === 0 ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="pool-table-state">Loading pools…</div>
                      </td>
                    </tr>
                  ) : null}

                  {!loading && !error && rows.length === 0 ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="pool-table-state">
                          No Legacy DLMM pools match the current filters.
                        </div>
                      </td>
                    </tr>
                  ) : null}

                  {rows.map((pool) => {
                    const expanded = expandedPool === pool.address;

                    return (
                      <Fragment key={pool.address}>
                        <tr
                          className={expanded ? "expanded" : ""}
                          onClick={() =>
                            setExpandedPool((current) =>
                              current === pool.address ? null : pool.address,
                            )
                          }
                        >
                          <td className="pool-col-expand">
                            <ChevronDown
                              size={14}
                              className={expanded ? "rotated" : ""}
                            />
                          </td>

                          <td>
                            <div className="pool-pair-cell">
                              <strong>{pool.name}</strong>
                              <span>{shortAddress(pool.address)}</span>
                            </div>
                          </td>

                          <td>{formatPct(pool.baseFeePct, 3)}</td>
                          <td>{formatPct(pool.dynamicFeePct, 4)}</td>
                          <td>{pool.binStep ?? "—"}</td>
                          <td className="pool-emphasis">{formatUsd(pool.tvl)}</td>
                          <td>{formatUsd(pool.volume["24h"])}</td>
                          <td>{formatUsd(pool.fees["24h"])}</td>
                          <td className="pool-positive">
                            {formatPct(pool.feeTvlRatio["24h"], 4)}
                          </td>
                          <td>{formatPct(pool.apr, 3)}</td>
                          <td>{formatAge(pool.createdAt)}</td>
                        </tr>

                        {expanded ? (
                          <tr className="pool-detail-row">
                            <td colSpan={11}>
                              <div className="pool-detail-content">
                                <div className="pool-detail-summary">
                                  <div>
                                    <span>Pool Address</span>
                                    <div className="pool-copy-value">
                                      <code>{pool.address}</code>
                                      <button
                                        title="Copy pool address"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          navigator.clipboard.writeText(pool.address);
                                        }}
                                      >
                                        <Copy size={12} />
                                      </button>
                                    </div>
                                  </div>

                                  <div>
                                    <span>Current Price</span>
                                    <strong>{formatPrice(pool.currentPrice)}</strong>
                                  </div>

                                  <div>
                                    <span>Cumulative Volume</span>
                                    <strong>{formatUsd(pool.cumulativeVolume)}</strong>
                                  </div>

                                  <div>
                                    <span>Cumulative Fees</span>
                                    <strong>{formatUsd(pool.cumulativeFees)}</strong>
                                  </div>

                                  <div>
                                    <span>Protocol Fee</span>
                                    <strong>{formatPct(pool.protocolFeePct, 2)}</strong>
                                  </div>

                                  <div>
                                    <span>Farm</span>
                                    <strong>{pool.hasFarm ? "Yes" : "No"}</strong>
                                  </div>
                                </div>

                                <div className="pool-token-details">
                                  <TokenDetail label="TOKEN X" token={pool.tokenX} />
                                  <TokenDetail label="TOKEN Y" token={pool.tokenY} />
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pool-pagination">
              <span>
                Page {response?.page ?? page} of {response?.pages ?? 1}
              </span>

              <div>
                <button
                  className="secondary-button"
                  disabled={(response?.page ?? page) <= 1 || loading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>

                <button
                  className="secondary-button"
                  disabled={
                    (response?.page ?? page) >= (response?.pages ?? 1) || loading
                  }
                  onClick={() =>
                    setPage((current) =>
                      Math.min(response?.pages ?? current + 1, current + 1),
                    )
                  }
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
