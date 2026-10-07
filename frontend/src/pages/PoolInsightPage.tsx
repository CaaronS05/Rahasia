import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Layers3,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchPoolDetail,
  fetchPoolWallets,
  fetchPoolWalletTrades,
  fetchScannedPools,
  startPoolRefresh,
  getPoolRefreshStatus,
  type PoolDetailResponse,
  type PoolRefreshStage,
  type PoolWalletItem,
  type PoolWalletSortKey,
  type PoolWalletTradeItem,
  type ScannedPoolItem,
  type SortOrder,
} from "../lib/poolInsight";
import { shortWallet } from "../lib/format";
import "../pool-insight.css";

type Subnav = "explorer" | "intelligence";

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function getRefreshStageLabel(stage: PoolRefreshStage | null): string {
  switch (stage) {
    case "starting": return "Starting refresh…";
    case "scanning": return "Scanning LP wallets…";
    case "enriching": return "Refreshing Fabriq…";
    case "trade_history": return "Building trade history…";
    case "persisting": return "Persisting snapshot…";
    case "completed": return "Updated";
    case "failed": return "Refresh failed";
    default: return "Refreshing Pool…";
  }
}

function formatUsd(val: number): string {
  if (!Number.isFinite(val)) return "$0.00";
  const sign = val > 0 ? "+" : val < 0 ? "-" : "";
  const abs = Math.abs(val);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  return `${sign}$${formatted}`;
}

function formatPct(val: number): string {
  if (!Number.isFinite(val)) return "0.00%";
  const sign = val > 0 ? "+" : val < 0 ? "-" : "";
  const abs = Math.abs(val);
  return `${sign}${abs.toFixed(2)}%`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const sec = Math.floor(seconds);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) {
    return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) {
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function CopyButton({ text, label = "Copy address" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : label}
      aria-label={label}
      type="button"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

export function PoolInsightPage() {
  const [subnav, setSubnav] = useState<Subnav>("explorer");
  const [selectedPoolAddress, setSelectedPoolAddress] = useState<string | null>(null);

  // View 1: Pools list state
  const [pools, setPools] = useState<ScannedPoolItem[]>([]);
  const [loadingPools, setLoadingPools] = useState(true);
  const [poolsError, setPoolsError] = useState<string | null>(null);

  // View 2: Selected Pool Detail & Wallets state
  const [poolDetail, setPoolDetail] = useState<ScannedPoolItem | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [wallets, setWallets] = useState<PoolWalletItem[]>([]);
  const [loadingWallets, setLoadingWallets] = useState(false);
  const [walletsError, setWalletsError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<PoolWalletSortKey>("pnlUsd");
  const [sortDir, setSortDir] = useState<SortOrder>("desc");

  // Drilldown View: Selected Wallet Trade History state
  const [selectedWalletForTrades, setSelectedWalletForTrades] = useState<string | null>(null);
  const [walletTrades, setWalletTrades] = useState<PoolWalletTradeItem[]>([]);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);

  // Refresh Pool state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshStage, setRefreshStage] = useState<PoolRefreshStage | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);

  // Reset drilldown and refresh state whenever selected pool changes or is deselected
  useEffect(() => {
    setSelectedWalletForTrades(null);
    setWalletTrades([]);
    setTradesError(null);
    setLoadingTrades(false);
    setIsRefreshing(false);
    setRefreshStage(null);
    setRefreshError(null);
    setRefreshSuccess(false);
  }, [selectedPoolAddress]);

  // Load trades for selected pool + wallet with stale-response protection
  useEffect(() => {
    if (!selectedPoolAddress || !selectedWalletForTrades) {
      setWalletTrades([]);
      setTradesError(null);
      setLoadingTrades(false);
      return;
    }

    let active = true;
    setLoadingTrades(true);
    setTradesError(null);
    setWalletTrades([]); // Invariant: no flash of old data

    fetchPoolWalletTrades(selectedPoolAddress, selectedWalletForTrades)
      .then((res) => {
        if (!active) return;
        if (res.poolAddress === selectedPoolAddress && res.wallet === selectedWalletForTrades) {
          setWalletTrades(res.trades || []);
        }
      })
      .catch((err) => {
        if (!active) return;
        setTradesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) {
          setLoadingTrades(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedPoolAddress, selectedWalletForTrades]);

  const handleOpenTrades = (wallet: string) => {
    setSelectedWalletForTrades(wallet);
  };

  const handleCloseTrades = () => {
    setSelectedWalletForTrades(null);
    setWalletTrades([]);
    setTradesError(null);
    setLoadingTrades(false);
  };

  // Close drilldown on Escape key
  useEffect(() => {
    if (!selectedWalletForTrades) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCloseTrades();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedWalletForTrades]);

  // Load scanned pools for View 1
  const loadPools = useCallback(async () => {
    setLoadingPools(true);
    setPoolsError(null);
    try {
      const response = await fetchScannedPools();
      setPools(response.pools || []);
    } catch (err) {
      setPoolsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPools(false);
    }
  }, []);

  useEffect(() => {
    loadPools();
  }, [loadPools]);

  // Load selected pool detail & wallets for View 2
  const loadDetail = useCallback(async (address: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await fetchPoolDetail(address);
      setPoolDetail(response.pool);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadWallets = useCallback(async (address: string, key: PoolWalletSortKey, dir: SortOrder) => {
    setLoadingWallets(true);
    setWalletsError(null);
    try {
      const response = await fetchPoolWallets(address, key, dir);
      setWallets(response.wallets || []);
    } catch (err) {
      setWalletsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingWallets(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPoolAddress) {
      loadDetail(selectedPoolAddress);
      loadWallets(selectedPoolAddress, sortKey, sortDir);
    } else {
      setPoolDetail(null);
      setWallets([]);
      setDetailError(null);
      setWalletsError(null);
    }
  }, [selectedPoolAddress, loadDetail, loadWallets, sortKey, sortDir]);

  const handleSort = (key: PoolWalletSortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Status polling for active pool refresh with stale-response protection
  useEffect(() => {
    if (!isRefreshing || !selectedPoolAddress) return;

    const currentTargetPool = selectedPoolAddress;
    let active = true;

    const interval = setInterval(async () => {
      try {
        const status = await getPoolRefreshStatus(currentTargetPool);
        if (!active || selectedPoolAddress !== currentTargetPool) return;

        setRefreshStage(status.stage);

        if (status.status === "completed") {
          setIsRefreshing(false);
          setRefreshSuccess(true);
          setTimeout(() => {
            if (active) setRefreshSuccess(false);
          }, 3000);

          // Refetch fresh canonical pool data
          loadDetail(currentTargetPool);
          loadWallets(currentTargetPool, sortKey, sortDir);
          loadPools();

          // Reset open trade drilldown so stale detail is not shown
          setSelectedWalletForTrades(null);
          setWalletTrades([]);
        } else if (status.status === "failed") {
          setIsRefreshing(false);
          setRefreshError(status.error || "Pool refresh failed");
        }
      } catch (err) {
        if (!active) return;
        console.warn("Refresh status poll error:", err);
      }
    }, 1500);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isRefreshing, selectedPoolAddress, loadDetail, loadWallets, loadPools, sortKey, sortDir]);

  const handleRefreshPool = async () => {
    if (!selectedPoolAddress || isRefreshing) return;
    setIsRefreshing(true);
    setRefreshStage("starting");
    setRefreshError(null);
    setRefreshSuccess(false);

    try {
      await startPoolRefresh(selectedPoolAddress);
    } catch (err) {
      setIsRefreshing(false);
      setRefreshStage(null);
      setRefreshError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pool-insight-page">
      <header className="pool-insight-header">
        <div>
          <h2>Pool Insight</h2>
          <p>Analyze scanned DLMM pools and LP activity.</p>
        </div>
        <nav className="pool-insight-subnav" aria-label="Pool Insight navigation">
          <button
            className={subnav === "explorer" ? "active" : ""}
            onClick={() => setSubnav("explorer")}
            type="button"
          >
            Pool Explorer
          </button>
          <button
            className={subnav === "intelligence" ? "active" : ""}
            onClick={() => setSubnav("intelligence")}
            type="button"
          >
            Pool Intelligence
          </button>
        </nav>
      </header>

      {subnav === "intelligence" ? (
        !selectedPoolAddress ? (
          /* POOL INTELLIGENCE: EMPTY STATE WHEN NO POOL SELECTED */
          <section className="pool-insight-empty-state" aria-label="No Pool Selected">
            <div className="pool-insight-placeholder-icon">
              <Layers3 size={20} />
            </div>
            <h3>No Pool Selected</h3>
            <p>
              Select a pool from the Pool Explorer to view detailed pool metadata, active wallets,
              closed trade history, and real-time refresh options.
            </p>
            <button
              className="secondary-button"
              onClick={() => setSubnav("explorer")}
              type="button"
            >
              <ArrowLeft size={13} /> Go to Pool Explorer
            </button>
          </section>
        ) : (
          /* POOL INTELLIGENCE: SELECTED POOL WORKSPACE */
          <div className="pool-detail-view">
            <div className="pool-detail-nav">
              <button
                className="secondary-button"
                onClick={() => {
                  setSubnav("explorer");
                  setSelectedPoolAddress(null);
                }}
                type="button"
              >
                <ArrowLeft size={13} /> Back to Pool Explorer
              </button>
            </div>

            {refreshError && (
              <div className="state-card error" style={{ marginBottom: 16 }} role="alert">
                <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                <span>{refreshError}</span>
                <button
                  type="button"
                  onClick={() => setRefreshError(null)}
                  style={{ marginLeft: "auto", background: "transparent", border: 0, color: "inherit", cursor: "pointer" }}
                  title="Dismiss"
                >
                  <X size={13} />
                </button>
              </div>
            )}

          {loadingDetail ? (
            <div className="state-card">
              <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              Loading pool details…
            </div>
          ) : detailError ? (
            <div className="state-card error" role="alert">
              <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              {detailError}
            </div>
          ) : poolDetail ? (
            <section className="pool-detail-card" aria-label="Pool Details">
              <div className="pool-detail-card-header">
                <div className="pool-detail-card-title">
                  <h3>{poolDetail.pair}</h3>
                  <span className="pool-detail-badge">DLMM</span>
                </div>
                <button
                  className={`refresh-pool-btn ${isRefreshing ? "refreshing" : ""} ${refreshSuccess ? "success" : ""}`}
                  onClick={handleRefreshPool}
                  disabled={isRefreshing}
                  type="button"
                  title={isRefreshing ? getRefreshStageLabel(refreshStage) : "Refresh pool data from source"}
                >
                  <RefreshCw size={12} className={isRefreshing ? "spin" : ""} />
                  <span>
                    {isRefreshing
                      ? getRefreshStageLabel(refreshStage)
                      : refreshSuccess
                      ? "Updated"
                      : "Refresh Pool Data"}
                  </span>
                </button>
              </div>
              <dl className="pool-detail-grid">
                <div className="pool-detail-item">
                  <dt>Pair</dt>
                  <dd>{poolDetail.pair}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Pool Address</dt>
                  <dd className="pool-detail-address" title={poolDetail.poolAddress}>
                    <span>{shortWallet(poolDetail.poolAddress, 6, 4)}</span>
                    <CopyButton text={poolDetail.poolAddress} label="Copy pool address" />
                  </dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Token Mint</dt>
                  <dd className="pool-detail-address" title={poolDetail.tokenMint}>
                    <span>{shortWallet(poolDetail.tokenMint, 6, 4)}</span>
                    <CopyButton text={poolDetail.tokenMint} label="Copy token mint" />
                  </dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Bin Step</dt>
                  <dd>{poolDetail.binStep}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Base Fee</dt>
                  <dd>{poolDetail.baseFeePct}%</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Wallet Count</dt>
                  <dd>{poolDetail.walletCount.toLocaleString()}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Trade Count</dt>
                  <dd>{poolDetail.tradeCount.toLocaleString()}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>First Scanned</dt>
                  <dd>{formatTimestamp(poolDetail.firstScannedAt)}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Last Scanned</dt>
                  <dd>{formatTimestamp(poolDetail.lastScannedAt)}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          {/* POOL WALLET TABLE */}
          <section className="pool-insight-table-card" style={{ marginTop: 20 }} aria-label="Pool Wallets">
            <div className="pool-insight-table-toolbar">
              <div className="pool-insight-table-toolbar-left">
                <strong>{wallets.length.toLocaleString()} Wallets</strong>
                <span>active in {poolDetail?.pair ?? "pool"}</span>
              </div>
              <div className="pool-insight-table-toolbar-right">
                <span>Values in USD</span>
              </div>
            </div>

            {loadingWallets ? (
              <div className="state-card">
                <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                Loading pool wallets…
              </div>
            ) : walletsError ? (
              <div className="state-card error" role="alert">
                <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                {walletsError}
              </div>
            ) : wallets.length === 0 ? (
              <div className="state-card">No wallets found for this pool.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="pool-insight-table">
                  <thead>
                    <tr>
                      <th>WALLET</th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("pnlUsd")}
                        >
                          POOL PNL
                          <span className={`sort-indicator ${sortKey === "pnlUsd" ? "active" : ""}`}>
                            {sortKey === "pnlUsd" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("winRate")}
                        >
                          WIN RATE
                          <span className={`sort-indicator ${sortKey === "winRate" ? "active" : ""}`}>
                            {sortKey === "winRate" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("positions")}
                        >
                          POSITIONS
                          <span className={`sort-indicator ${sortKey === "positions" ? "active" : ""}`}>
                            {sortKey === "positions" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("tradeCount")}
                        >
                          TRADES
                          <span className={`sort-indicator ${sortKey === "tradeCount" ? "active" : ""}`}>
                            {sortKey === "tradeCount" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((w) => (
                      <tr
                        key={w.wallet}
                        className="clickable-row"
                        onClick={() => handleOpenTrades(w.wallet)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleOpenTrades(w.wallet);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        title={`View trade history for ${w.wallet}`}
                        aria-label={`View trade history for wallet ${shortWallet(w.wallet, 6, 4)}`}
                      >
                        <td>
                          <div className="cell-address">
                            <span>{shortWallet(w.wallet, 6, 4)}</span>
                            <CopyButton text={w.wallet} label="Copy wallet address" />
                          </div>
                        </td>
                        <td
                          className={`cell-number ${
                            w.pnlUsd > 0 ? "positive" : w.pnlUsd < 0 ? "negative" : ""
                          }`}
                        >
                          {formatUsd(w.pnlUsd)}
                        </td>
                        <td className="cell-number">
                          {w.winRate !== null && Number.isFinite(w.winRate)
                            ? `${w.winRate.toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="cell-number">{w.positions.toLocaleString()}</td>
                        <td className="cell-number">
                          <div className="cell-trades-cta">
                            <span>{w.tradeCount.toLocaleString()}</span>
                            <span className="view-trades-pill">View Trades →</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )) : (
        /* POOL EXPLORER: SCANNED POOLS LIST ONLY */
        <section className="pool-insight-table-card" aria-label="Scanned Pools">
          <div className="pool-insight-table-toolbar">
            <div className="pool-insight-table-toolbar-left">
              <strong>{pools.length.toLocaleString()} Scanned Pools</strong>
              <span>DLMM pools analyzed</span>
            </div>
            <div className="pool-insight-table-toolbar-right">
              <button
                className="icon-btn"
                onClick={loadPools}
                title="Refresh pools"
                type="button"
              >
                <RefreshCw size={13} className={loadingPools ? "spin" : ""} />
              </button>
            </div>
          </div>

          {loadingPools ? (
            <div className="state-card">
              <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              Loading scanned pools…
            </div>
          ) : poolsError ? (
            <div className="state-card error" role="alert">
              <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              {poolsError}
            </div>
          ) : pools.length === 0 ? (
            <div className="state-card">No scanned pools found.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="pool-insight-table">
                <thead>
                  <tr>
                    <th>PAIR</th>
                    <th>POOL ADDRESS</th>
                    <th>BIN STEP</th>
                    <th>BASE FEE</th>
                    <th>WALLETS</th>
                    <th>TRADES</th>
                    <th>LAST SCANNED</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((pool) => (
                    <tr
                      key={pool.poolAddress}
                      className="clickable-row"
                      onClick={() => {
                        setSelectedPoolAddress(pool.poolAddress);
                        setSubnav("intelligence");
                      }}
                      title={`Open ${pool.pair} intelligence`}
                    >
                      <td>
                        <span className="cell-pair">{pool.pair}</span>
                      </td>
                      <td>
                        <div className="cell-address">
                          <span>{shortWallet(pool.poolAddress, 6, 4)}</span>
                          <CopyButton text={pool.poolAddress} label="Copy pool address" />
                        </div>
                      </td>
                      <td className="cell-number">{pool.binStep}</td>
                      <td className="cell-number">{pool.baseFeePct}%</td>
                      <td className="cell-number">{pool.walletCount.toLocaleString()}</td>
                      <td className="cell-number">{pool.tradeCount.toLocaleString()}</td>
                      <td>{formatTimestamp(pool.lastScannedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* WALLET TRADE HISTORY DRILLDOWN MODAL */}
      {selectedWalletForTrades && (
        <div
          className="pool-insight-modal-overlay"
          onClick={handleCloseTrades}
          role="presentation"
        >
          <div
            className="pool-insight-modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-drilldown-title"
          >
            <div className="pool-insight-modal-header">
              <div className="pool-insight-modal-header-main">
                <div className="pool-insight-modal-title-row">
                  <h3 id="trade-drilldown-title">Trade History</h3>
                  {poolDetail?.pair && (
                    <span className="pool-detail-badge">{poolDetail.pair}</span>
                  )}
                  <span className="pool-modal-count-badge">
                    {loadingTrades
                      ? "Loading…"
                      : `${walletTrades.length} Trade${walletTrades.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                <div className="pool-insight-modal-wallet-row">
                  <span className="pool-insight-modal-wallet-label">WALLET</span>
                  <span className="pool-insight-modal-wallet-addr" title={selectedWalletForTrades}>
                    {selectedWalletForTrades}
                  </span>
                  <CopyButton text={selectedWalletForTrades} label="Copy wallet address" />
                </div>
              </div>
              <button
                type="button"
                className="pool-insight-modal-close-btn"
                onClick={handleCloseTrades}
                aria-label="Close trade history"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>

            <div className="pool-insight-modal-body">
              {loadingTrades ? (
                <div className="state-card">
                  <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                  Loading trade history…
                </div>
              ) : tradesError ? (
                <div className="state-card error" role="alert">
                  <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                  {tradesError}
                </div>
              ) : walletTrades.length === 0 ? (
                <div className="state-card">
                  No closed-position trades recorded for this wallet in {poolDetail?.pair || "this pool"}.
                </div>
              ) : (
                <div className="pool-insight-modal-table-wrap">
                  <table className="pool-insight-table">
                    <thead>
                      <tr>
                        <th>POSITION</th>
                        <th>OPENED</th>
                        <th>CLOSED</th>
                        <th>DURATION</th>
                        <th>PNL</th>
                        <th>PNL %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {walletTrades.map((t) => (
                        <tr key={t.positionId}>
                          <td>
                            <div className="cell-address">
                              <span title={t.positionId}>{shortWallet(t.positionId, 6, 4)}</span>
                              <CopyButton text={t.positionId} label="Copy position ID" />
                            </div>
                          </td>
                          <td>{formatTimestamp(t.openedAt)}</td>
                          <td>{formatTimestamp(t.closedAt)}</td>
                          <td className="cell-number">{formatDuration(t.durationSeconds)}</td>
                          <td
                            className={`cell-number ${
                              t.pnlUsd > 0 ? "positive" : t.pnlUsd < 0 ? "negative" : ""
                            }`}
                          >
                            {formatUsd(t.pnlUsd)}
                          </td>
                          <td
                            className={`cell-number ${
                              t.pnlPct > 0 ? "positive" : t.pnlPct < 0 ? "negative" : ""
                            }`}
                          >
                            {formatPct(t.pnlPct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
