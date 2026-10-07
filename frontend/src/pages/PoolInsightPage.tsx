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
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchPoolDetail,
  fetchPoolWallets,
  fetchScannedPools,
  type PoolDetailResponse,
  type PoolWalletItem,
  type PoolWalletSortKey,
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
            Pool Intelligence <span className="subnav-badge">Coming Soon</span>
          </button>
        </nav>
      </header>

      {subnav === "intelligence" ? (
        <section className="pool-insight-placeholder" aria-label="Pool Intelligence placeholder">
          <div className="pool-insight-placeholder-icon">
            <Sparkles size={20} />
          </div>
          <span className="placeholder-badge">COMING SOON</span>
          <h3>Pool Intelligence</h3>
          <p>
            In-depth pool-level intelligence, LP behavioral analytics, and cohort modeling
            are currently under development. Detailed pool intelligence will be available in
            an upcoming release.
          </p>
        </section>
      ) : selectedPoolAddress ? (
        /* VIEW 2: SELECTED POOL DETAIL & WALLETS */
        <div className="pool-detail-view">
          <div className="pool-detail-nav">
            <button
              className="secondary-button"
              onClick={() => setSelectedPoolAddress(null)}
              type="button"
            >
              <ArrowLeft size={13} /> Back to Pools
            </button>
          </div>

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
                      <tr key={w.wallet}>
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
                        <td className="cell-number">{w.tradeCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : (
        /* VIEW 1: SCANNED POOLS */
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
                      onClick={() => setSelectedPoolAddress(pool.poolAddress)}
                      title={`Select ${pool.pair} pool`}
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
    </div>
  );
}
