import {
  ArrowLeft,
  CalendarDays,
  Copy,
  Search,
  ShieldCheck,
  Star,
  TrendingUp,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { Wallet } from "../types";
import { fmt } from "../lib/format";
import { PortfolioCalendar } from "../components/portfolio/PortfolioCalendar";
import {
  CumulativePnlChart,
  DailyPnlChart,
} from "../components/portfolio/PnlCharts";

type WalletWithFabriq = Wallet & {
  fabriq?: {
    fetchedAt?: string;
    month?: string;
    stats?: Record<string, any>;
    calendar?: any;
    calendars?: Record<string, any>;
  };
};

type Props = {
  wallets: Wallet[];
  loading: boolean;
  error: string;
  wallet?: Wallet;
  requestedAddress?: string;
  onSearch: (address: string) => void;
  onBack: () => void;
  isTracked: boolean;
  onToggleTrack: (owner: string) => void;
};

function usd(value: unknown, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(number);
}

function percent(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number.toFixed(2)}%`;
}

function number(value: unknown, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return parsed.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
}

function shortWallet(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-5)}`;
}

function formatStyleDisplay(style?: string | null): string {
  if (!style) return "—";
  if (style === "SNIPER" || style === "sniper") return "Sniper";
  if (style === "FARMER" || style === "farmer") return "Farmer";
  if (
    style === "MIXED_UNCLASSIFIED" ||
    style === "mixed_unclassified" ||
    style === "mixed"
  ) {
    return "Mixed / Unclassified";
  }
  return style;
}

function formatStyleTag(tag?: string | null): string {
  return formatStyleDisplay(tag);
}

function clampPercent(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(100, parsed),
  );
}

function ratioShare(
  positiveValue: unknown,
  negativeValue: unknown,
) {
  const positive =
    Math.max(
      0,
      Number(positiveValue) || 0,
    );

  const negative =
    Math.abs(
      Number(negativeValue) || 0,
    );

  const total =
    positive + negative;

  if (total === 0) {
    return 0;
  }

  return (
    positive /
    total *
    100
  );
}

function freshness(value?: string) {
  if (!value) return "No Fabriq snapshot";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "Fabriq snapshot";
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 60) return `Updated ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return `Updated ${hours} hours ago`;
}

export function PortfolioPage({
  wallets,
  loading,
  error,
  wallet,
  requestedAddress,
  onSearch,
  onBack,
  isTracked,
  onToggleTrack,
}: Props) {
  const [search, setSearch] = useState(requestedAddress ?? "");
  const [tab, setTab] = useState("Overview");

  const currentWallet = useMemo(() => {
    if (wallet) return wallet;
    if (requestedAddress) {
      return wallets.find((w) => w.owner === requestedAddress);
    }
    return undefined;
  }, [wallet, requestedAddress, wallets]);

  const enrichedWallet = currentWallet as WalletWithFabriq | undefined;
  const stats = enrichedWallet?.fabriq?.stats ?? {};
  const calendar = enrichedWallet?.fabriq?.calendar;
  const calendars = enrichedWallet?.fabriq?.calendars;

  const metricData = useMemo(() => {
    const positionWin =
      stats.positionWinUsd ??
      stats.positionWinSol ??
      {};

    const profitFactor =
      stats.profitFactorUsd ??
      stats.profitFactorSol ??
      {};

    const dayWin =
      stats.dayWinUsd ??
      stats.dayWinSol ??
      {};

    const avgWinLoss =
      stats.avgWinLoss ??
      {};

    const profitShare =
      ratioShare(
        profitFactor.grossProfit,
        profitFactor.grossLoss,
      );

    const avgWinShare =
      ratioShare(
        avgWinLoss.avgWinUsd,
        avgWinLoss.avgLossUsd,
      );

    return {
      netPnl: stats.netPnlUsd,
      positionWin,
      profitFactor,
      dayWin,
      avgWinLoss,

      profitShare,
      avgWinShare,
    };
  }, [stats]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSearch(search);
  }

  if (loading) {
    return <div className="portfolio-page"><div className="state-card">Loading portfolio…</div></div>;
  }

  if (error) {
    return <div className="portfolio-page"><div className="state-card error">{error}</div></div>;
  }

  return (
    <div className="portfolio-page">
      <div className="portfolio-title-row">
        <div className="portfolio-title-block">
          <button className="back-button" onClick={onBack}>
            <ArrowLeft size={17} />
          </button>

          <div>
            <h1>Portfolio</h1>
          </div>
        </div>

        <form className="portfolio-search" onSubmit={submit}>
          <Search size={16} />
          <input
            placeholder="Paste or search wallet address..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="submit">→</button>
        </form>
      </div>

      {!requestedAddress ? (
        <section className="portfolio-empty">
          <ShieldCheck size={32} />
          <h2>Open a wallet portfolio</h2>
          <p>Paste a wallet address above, or click a wallet from Wallet Explorer.</p>
        </section>
      ) : !currentWallet ? (
        <section className="portfolio-empty">
          <Search size={32} />
          <h2>Wallet not found</h2>
          <p>
            The address <strong>{requestedAddress}</strong> is not in the current local
            dataset.
          </p>
          <button className="secondary-button" onClick={onBack}>
            Back to Wallet Explorer
          </button>
        </section>
      ) : (
        <>
          <section className="portfolio-wallet-header">
            <div className="wallet-identity">
              <div className="wallet-shield">
                <ShieldCheck size={21} />
              </div>

              <div>
                <div className="wallet-address-line">
                  <h2>{shortWallet(currentWallet.owner)}</h2>
                  <button
                    className="copy-wallet portfolio-copy"
                    onClick={() => navigator.clipboard.writeText(currentWallet.owner)}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className={`portfolio-track-button ${isTracked ? "tracked" : ""
                      }`}
                    onClick={() => onToggleTrack(currentWallet.owner)}
                  >
                    <Star
                      size={13}
                      fill={isTracked ? "currentColor" : "none"}
                    />
                    {isTracked ? "Tracked" : "Track"}
                  </button>
                  <span className="network-pill">
                    <span className="solana-mark">≋</span>
                    Solana
                  </span>
                </div>
                <p>{freshness(enrichedWallet?.fabriq?.fetchedAt)}</p>
              </div>
            </div>
          </section>

          <nav className="portfolio-tabs">
            {["Overview", "Active Positions", "Closed Positions", "Transactions", "Balances"].map(
              (item) => (
                <button
                  key={item}
                  className={tab === item ? "active" : ""}
                  onClick={() => setTab(item)}
                >
                  {item}
                </button>
              ),
            )}
          </nav>

          {tab !== "Overview" ? (
            <section className="portfolio-empty portfolio-tab-placeholder">
              <h2>{tab}</h2>
              <p>
                This tab is ready for the next data integration phase. The current master
                dataset contains Fabriq overview stats and calendar data.
              </p>
            </section>
          ) : (
            <>
              <section className="portfolio-metrics-grid">
                <article className="portfolio-metric">
                  <span>Net PnL ⓘ</span>
                  <strong className={Number(metricData.netPnl) >= 0 ? "positive" : "negative"}>
                    {usd(metricData.netPnl)}
                  </strong>
                  <small className="positive">
                    {currentWallet.total_pnl_native >= 0 ? "+" : ""}
                    {number(currentWallet.total_pnl_native, 2)} SOL all-time
                  </small>
                  <TrendingUp size={18} />
                </article>

                <article className="portfolio-metric gauge-card">
                  <span>Position Win % ⓘ</span>
                  <strong>{percent(metricData.positionWin.percentage)}</strong>
                  <small>
                    {metricData.positionWin.wins ?? "—"} /{" "}
                    {(metricData.positionWin.wins ?? 0) + (metricData.positionWin.losses ?? 0)} positions
                  </small>
                  <div
                    className="mini-gauge"
                    style={
                      {
                        "--gauge-angle":
                          `${clampPercent(
                            metricData.positionWin.percentage,
                          ) * 1.8
                          }deg`,
                      } as React.CSSProperties
                    }
                  />
                </article>

                <article className="portfolio-metric gauge-card">
                  <span>Profit Factor ⓘ</span>
                  <strong>{number(metricData.profitFactor.ratio, 2)}</strong>
                  <small>
                    <span className="positive">
                      {usd(metricData.profitFactor.grossProfit)}
                    </span>{" "}
                    /{" "}
                    <span className="negative">
                      {usd(metricData.profitFactor.grossLoss)}
                    </span>
                  </small>
                  <div
                    className="ring-gauge"
                    style={
                      {
                        "--gauge-angle":
                          `${metricData.profitShare *
                          3.6
                          }deg`,
                      } as React.CSSProperties
                    }
                  />
                </article>

                <article className="portfolio-metric gauge-card">
                  <span>Day Win % ⓘ</span>
                  <strong>{percent(metricData.dayWin.percentage)}</strong>
                  <small>
                    {metricData.dayWin.wins ?? "—"} /{" "}
                    {(metricData.dayWin.wins ?? 0) + (metricData.dayWin.losses ?? 0)} days
                  </small>
                  <div
                    className="mini-gauge"
                    style={
                      {
                        "--gauge-angle":
                          `${clampPercent(
                            metricData.dayWin.percentage,
                          ) * 1.8
                          }deg`,
                      } as React.CSSProperties
                    }
                  />
                </article>

                <article className="portfolio-metric">
                  <span>Avg Win/Loss Position ⓘ</span>
                  <strong>{number(metricData.avgWinLoss.ratioUsd, 2)}</strong>
                  <div
                    className="avg-win-loss-bar"
                    style={
                      {
                        "--win-share":
                          `${metricData.avgWinShare}%`,
                      } as React.CSSProperties
                    }
                  />
                  <small>
                    <span className="positive">
                      {usd(metricData.avgWinLoss.avgWinUsd)}
                    </span>{" "}
                    /{" "}
                    <span className="negative">
                      {usd(metricData.avgWinLoss.avgLossUsd)}
                    </span>
                  </small>
                </article>
              </section>

              <article className="portfolio-panel" style={{ marginBottom: "11px" }}>
                <div className="panel-title">
                  <h3>LP Intelligence</h3>
                  <span>ⓘ</span>
                </div>

                {currentWallet.intelligenceV1 ? (
                  <div>
                    <div className="v1-intel-grid">
                      <div className="v1-intel-card">
                        <span>Quality Score</span>
                        <strong>
                          {currentWallet.intelligenceV1.qualityScore !== null &&
                          currentWallet.intelligenceV1.qualityScore !== undefined
                            ? fmt(currentWallet.intelligenceV1.qualityScore, 1)
                            : "—"}
                        </strong>
                        <small>Cohort relative (0–100)</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Risk Score</span>
                        <strong>
                          {currentWallet.intelligenceV1.riskScore !== null &&
                          currentWallet.intelligenceV1.riskScore !== undefined
                            ? fmt(currentWallet.intelligenceV1.riskScore, 1)
                            : "—"}
                        </strong>
                        <small>Historical loss risk (0–100)</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Confidence Score</span>
                        <strong>
                          {currentWallet.intelligenceV1.confidenceScore !== null &&
                          currentWallet.intelligenceV1.confidenceScore !== undefined
                            ? fmt(currentWallet.intelligenceV1.confidenceScore, 1)
                            : "—"}
                        </strong>
                        <small>Evidence sample & span (0–100)</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Style</span>
                        <strong style={{ fontSize: "16px", marginTop: "8px" }}>
                          {formatStyleDisplay(currentWallet.intelligenceV1.style)}
                        </strong>
                        <small>Historical DLMM behavior</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Shortlist Status</span>
                        <div style={{ marginTop: "7px" }}>
                          {currentWallet.intelligenceV1.shortlisted ? (
                            <span
                              className="v1-shortlist-badge"
                              title="Passes V1 historical monitoring criteria"
                            >
                              Shortlisted
                            </span>
                          ) : (
                            <span className="v1-not-shortlist-badge">
                              Not Shortlisted
                            </span>
                          )}
                        </div>
                        <small>
                          {currentWallet.intelligenceV1.shortlisted
                            ? "Passes V1 historical monitoring criteria"
                            : "Monitoring criteria not met"}
                        </small>
                      </div>
                    </div>

                    {currentWallet.intelligenceV1.performance ? (
                      <div className="v1-perf-strip">
                        <div className="v1-perf-item">
                          <span>Total PnL</span>
                          <strong
                            className={
                              currentWallet.intelligenceV1.performance.totalPnl >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {currentWallet.intelligenceV1.performance.totalPnl >= 0 ? "+" : ""}
                            {fmt(currentWallet.intelligenceV1.performance.totalPnl, 2)} SOL
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Profit Factor</span>
                          <strong>
                            {fmt(currentWallet.intelligenceV1.performance.profitFactor, 2)}
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Median Position PnL %</span>
                          <strong
                            className={
                              currentWallet.intelligenceV1.performance.medianPositionPnlPct >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {currentWallet.intelligenceV1.performance.medianPositionPnlPct >= 0
                              ? "+"
                              : ""}
                            {fmt(currentWallet.intelligenceV1.performance.medianPositionPnlPct, 2)}%
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Win Rate</span>
                          <strong>
                            {fmt(currentWallet.intelligenceV1.performance.positionWinRate, 1)}%
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Closed Positions</span>
                          <strong>
                            {currentWallet.intelligenceV1.performance.closedPositionCount}
                          </strong>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : currentWallet.score?.skill?.score !== null &&
                currentWallet.score?.skill?.score !== undefined ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: "16px",
                      padding: "16px 18px",
                    }}
                  >
                    <div>
                      <span
                        style={{
                          color: "#9a968f",
                          fontSize: "10px",
                          display: "block",
                          textTransform: "uppercase",
                        }}
                      >
                        Skill Score
                      </span>
                      <strong
                        style={{
                          fontSize: "22px",
                          display: "block",
                          marginTop: "6px",
                        }}
                      >
                        {fmt(currentWallet.score.skill.score, 1)}
                      </strong>
                      <small
                        style={{
                          color: "#66625c",
                          fontSize: "10px",
                          display: "block",
                          marginTop: "4px",
                        }}
                      >
                        Skill {currentWallet.score.skill.version ?? "v1.2-provisional"}
                      </small>
                    </div>

                    <div>
                      <span
                        style={{
                          color: "#9a968f",
                          fontSize: "10px",
                          display: "block",
                          textTransform: "uppercase",
                        }}
                      >
                        General Confidence
                      </span>
                      <strong
                        style={{
                          fontSize: "22px",
                          display: "block",
                          marginTop: "6px",
                        }}
                      >
                        {currentWallet.score.confidence?.generalPct !== null &&
                        currentWallet.score.confidence?.generalPct !== undefined
                          ? `${fmt(currentWallet.score.confidence.generalPct, 1)}%`
                          : "—"}
                      </strong>
                      <small
                        style={{
                          color: "#66625c",
                          fontSize: "10px",
                          display: "block",
                          marginTop: "4px",
                        }}
                      >
                        Evidence Confidence
                      </small>
                    </div>

                    <div>
                      <span
                        style={{
                          color: "#9a968f",
                          fontSize: "10px",
                          display: "block",
                          textTransform: "uppercase",
                        }}
                      >
                        Style
                      </span>
                      <strong
                        style={{
                          fontSize: "22px",
                          display: "block",
                          marginTop: "6px",
                        }}
                      >
                        {formatStyleTag(currentWallet.score.style?.tag)}
                      </strong>
                      <small
                        style={{
                          color: "#66625c",
                          fontSize: "10px",
                          display: "block",
                          marginTop: "4px",
                        }}
                      >
                        Style {currentWallet.score.style?.version ?? "v0.1-provisional"}
                      </small>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "20px 18px",
                      color: "#9a968f",
                      fontSize: "12px",
                    }}
                  >
                    Not scored yet
                  </div>
                )}
              </article>

              <section className="portfolio-middle-grid">
                <article className="portfolio-panel performance-panel">
                  <div className="panel-title">
                    <h3>Performance Summary</h3>
                    <span>ⓘ</span>
                  </div>

                  <div className="performance-values">
                    <div>
                      <span>Total Deposits</span>
                      <strong>{usd(stats.totalDepositsUsd)}</strong>
                    </div>
                    <div>
                      <span>Positions</span>
                      <strong>{number(stats.totalPositions, 0)}</strong>
                    </div>
                    <div>
                      <span>Total Withdrawals</span>
                      <strong>{usd(stats.totalWithdrawalsUsd)}</strong>
                    </div>
                    <div>
                      <span>Avg Invested</span>
                      <strong>{usd(stats.avgAddLiquidityUsd)}</strong>
                    </div>
                    <div>
                      <span>Total Fees</span>
                      <strong>{usd(stats.totalFeesUsd)}</strong>
                    </div>
                    <div>
                      <span>Win Rate</span>
                      <strong className="positive">
                        {percent(metricData.positionWin.percentage)}
                      </strong>
                    </div>
                  </div>

                  <div className="total-profit-strip">
                    <span>Total Profit</span>
                    <strong className={Number(metricData.netPnl) >= 0 ? "positive" : "negative"}>
                      {usd(metricData.netPnl, 2)}
                    </strong>
                  </div>
                </article>

                <article className="portfolio-panel calendar-panel">
                  <div className="panel-title">
                    <div>
                      <h3>Realized PnL</h3>
                      <span>ⓘ</span>
                    </div>
                    <button className="period-button">
                      <CalendarDays size={14} />
                      Monthly
                    </button>
                  </div>

                  <PortfolioCalendar
                    data={calendar}
                    calendars={calendars}
                    month={enrichedWallet?.fabriq?.month}
                  />
                </article>
              </section>

              <section className="portfolio-bottom-grid">
                <article className="portfolio-panel chart-panel">
                  <div className="panel-title">
                    <h3>Cumulative P&L</h3>
                    <span>ⓘ</span>
                    <div className="segmented mini">
                      <button>7D</button>
                      <button className="active">30D</button>
                      <button>ALL</button>
                    </div>
                  </div>
                  <CumulativePnlChart points={currentWallet.pnl_chart ?? []} />
                </article>

                <article className="portfolio-panel chart-panel">
                  <div className="panel-title">
                    <h3>Daily P&L</h3>
                    <span>ⓘ</span>
                    <div className="segmented mini">
                      <button>7D</button>
                      <button className="active">30D</button>
                      <button>ALL</button>
                    </div>
                  </div>
                  <DailyPnlChart points={currentWallet.pnl_chart ?? []} />
                </article>

                <article className="portfolio-panel weekly-panel">
                  <div className="panel-title">
                    <h3>Weekly Summary</h3>
                    <span>ⓘ</span>
                  </div>

                  <div className="weekly-table">
                    <div className="weekly-head">
                      <span>Week</span>
                      <span>PnL</span>
                      <span>Win %</span>
                      <span>Trades</span>
                    </div>
                    <div>
                      <span>Recent 7D</span>
                      <strong className="positive">
                        {currentWallet.total_pnl_native_7d >= 0 ? "+" : ""}
                        {number(currentWallet.total_pnl_native_7d, 2)} SOL
                      </strong>
                      <span>{percent(currentWallet.win_rate_native * 100)}</span>
                      <span>{currentWallet.total_lp_7d}</span>
                    </div>
                    <div>
                      <span>30D</span>
                      <strong className="positive">
                        {currentWallet.total_pnl_native_30d >= 0 ? "+" : ""}
                        {number(currentWallet.total_pnl_native_30d, 2)} SOL
                      </strong>
                      <span>—</span>
                      <span>{currentWallet.total_lp_30d}</span>
                    </div>
                    <div>
                      <span>All-time</span>
                      <strong className="positive">
                        {currentWallet.total_pnl_native >= 0 ? "+" : ""}
                        {number(currentWallet.total_pnl_native, 2)} SOL
                      </strong>
                      <span>{percent(currentWallet.win_rate_native * 100)}</span>
                      <span>{currentWallet.total_lp}</span>
                    </div>
                  </div>
                </article>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
