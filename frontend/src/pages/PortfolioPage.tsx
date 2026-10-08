import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Copy,
  Loader2,
  Play,
  RotateCw,
  Search,
  ShieldCheck,
  Square,
  Star,
  Terminal,
  TrendingUp,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Wallet } from "../types";
import {
  getSingleWalletStatus,
  startSingleWalletAnalysis,
  stopSingleWalletAnalysis,
  getSingleWalletResult,
  type SingleWalletIntelligenceStatus,
  type SingleWalletIntelligenceResult,
} from "../lib/walletIntelligenceControl";
import { fmt } from "../lib/format";
import { PortfolioCalendar } from "../components/portfolio/PortfolioCalendar";
import {
  CumulativePnlChart,
  DailyPnlChart,
} from "../components/portfolio/PnlCharts";
function formatHumanErrorSummary(err: string): string {
  if (!err) return "Analysis failed";
  if (err.includes("CDP_UNREACHABLE") || err.includes("unreachable on port 9222")) {
    return "Unable to connect to Brave CDP on port 9222.";
  }
  if (err.includes("CDP_PROTOCOL_TIMEOUT") || err.includes("Timeout 120000ms") || err.includes("connectOverCDP")) {
    return "Unable to initialize Brave CDP session.";
  }
  if (err.includes("FABRIQ_TAB_MISSING")) {
    return "Fabriq tab not found. Open https://fabriq.trade in Brave.";
  }
  if (err.includes("AUTH_SESSION_ERROR")) {
    return "Fabriq session error. Refresh your session at https://fabriq.trade in Brave.";
  }
  if (err.includes("RATE_LIMITED")) {
    return "Fabriq API rate limit encountered.";
  }
  if (err.includes("FABRIQ_API_ERROR")) {
    return "Fabriq API service error.";
  }
  if (err.includes("INELIGIBLE_WALLET")) {
    return "Wallet has no qualifying DLMM positions for analysis.";
  }
  if (err.includes("DATA_NOT_FOUND") || err.includes("404 Not Found") || err.includes("HTTP 404")) {
    return "Fabriq historical data unavailable or unready for this wallet (HTTP 404).";
  }
  const firstLine = err.split("\n")[0].trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}


type WalletWithFabriq = Wallet & {
  fabriq?: {
    fetchedAt?: string;
    month?: string;
    stats?: Record<string, unknown>;
    calendar?: unknown;
    calendars?: Record<string, unknown>;
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
  // Single-wallet intelligence state
  const [singleStatus, setSingleStatus] = useState<SingleWalletIntelligenceStatus | null>(null);
  const [singleResult, setSingleResult] = useState<SingleWalletIntelligenceResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(0);

  useEffect(() => {
    let timer: number | null = null;
    if (isAnalyzing) {
      const start = Date.now();
      timer = window.setInterval(() => {
        setAnalysisElapsedSeconds(Math.max(1, Math.floor((Date.now() - start) / 1000)));
      }, 1000);
    } else {
      setAnalysisElapsedSeconds(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isAnalyzing]);


  useEffect(() => {
    let isMounted = true;
    let pollTimer: number | null = null;

    setSingleStatus(null);
    setSingleResult(null);
    setIsAnalyzing(false);
    setIsStopping(false);
    setActionPending(false);
    setAnalysisError(null);
    const owner = currentWallet?.owner;
    if (!owner) return;

    async function checkStatusAndResult() {
      try {
        const status = await getSingleWalletStatus(owner);
        if (!isMounted || currentWallet?.owner !== owner) return;
        setSingleStatus(status);

        if (status.status === "running") {
          setIsAnalyzing(true);
          setIsStopping(false);
          pollTimer = setTimeout(checkStatusAndResult, 1500);
          return;
        }

        if (status.status === "stopping") {
          setIsAnalyzing(false);
          setIsStopping(true);
          pollTimer = setTimeout(checkStatusAndResult, 1500);
          return;
        }

        setIsAnalyzing(false);
        setIsStopping(false);

        if (status.status === "error" && status.error) {
          setAnalysisError(status.error);
        }

        if (status.hasResult) {
          const result = await getSingleWalletResult(owner);
          if (!isMounted || currentWallet?.owner !== owner) return;
          setSingleResult(result);
        }
        if (!isMounted) return;
      } catch {
        if (!isMounted) return;
      }
    }

    void checkStatusAndResult();

    return () => {
      isMounted = false;
      clearTimeout(pollTimer);
    };
  }, [currentWallet?.owner]);

  const handleRunAnalysis = async () => {
    const owner = currentWallet?.owner;
    if (!owner || isAnalyzing || isStopping || actionPending) return;

    setActionPending(true);
    setIsAnalyzing(true);
    setIsStopping(false);
    setAnalysisError(null);

    try {
      await startSingleWalletAnalysis(owner, true);
      if (currentWallet?.owner !== owner) return;
      const poll = async () => {
        if (currentWallet?.owner !== owner) return;
        try {
          const st = await getSingleWalletStatus(owner);
          if (currentWallet?.owner !== owner) return;
          setSingleStatus(st);
          if (st.status === "completed") {
            const res = await getSingleWalletResult(owner);
            if (currentWallet?.owner !== owner) return;
            setSingleResult(res);
            setIsAnalyzing(false);
            setIsStopping(false);
          } else if (st.status === "error") {
            setAnalysisError(st.error || "Analysis failed");
            setIsAnalyzing(false);
            setIsStopping(false);
          } else if (st.status === "stopped") {
            setIsAnalyzing(false);
            setIsStopping(false);
          } else if (st.status === "stopping") {
            setIsAnalyzing(false);
            setIsStopping(true);
            setTimeout(poll, 1500);
          } else {
            setTimeout(poll, 1500);
          }
        } catch (err: unknown) {
          if (currentWallet?.owner !== owner) return;
          setAnalysisError(err instanceof Error ? err.message : String(err));
          setIsAnalyzing(false);
          setIsStopping(false);
        }
      };
      setTimeout(poll, 1000);
    } catch (err: unknown) {
      if (currentWallet?.owner === owner) {
        setAnalysisError(err instanceof Error ? err.message : String(err));
        setIsAnalyzing(false);
        setIsStopping(false);
      }
    } finally {
      setActionPending(false);
    }
  };

  const handleStopAnalysis = async () => {
    const owner = currentWallet?.owner;
    if (!owner || isStopping || actionPending) return;

    setActionPending(true);
    setIsStopping(true);
    setIsAnalyzing(false);

    try {
      const st = await stopSingleWalletAnalysis(owner);
      if (currentWallet?.owner === owner) {
        setSingleStatus(st);
        if (st.status === "stopped") {
          setIsStopping(false);
        }
      }
    } catch (err: unknown) {
      if (currentWallet?.owner === owner) {
        const st = await getSingleWalletStatus(owner).catch(() => null);
        if (st && currentWallet?.owner === owner) {
          setSingleStatus(st);
          if (st.status !== "stopping") {
            setIsStopping(false);
          }
        }
      }
    } finally {
      setActionPending(false);
    }
  };

  const activeIntelligence = useMemo(() => {
    if (singleResult) {
      return {
        qualityScore: singleResult.qualityScore,
        riskScore: singleResult.riskScore,
        confidenceScore: singleResult.confidenceScore,
        style: singleResult.style,
        shortlisted: singleResult.shortlisted,
        performance: singleResult.performance,
        referenceCohort: singleResult.referenceCohort,
        analyzedAt: singleResult.analyzedAt,
        sampling: singleResult.sampling,
        totalEligiblePositions: singleResult.sampling?.totalEligiblePositions ?? singleResult.totalEligiblePositions,
        analyzedPositions: singleResult.sampling?.analyzedPositions ?? singleResult.analyzedPositions,
        excludedPositions: singleResult.sampling?.excludedPositions ?? singleResult.excludedPositions,
        coveragePct: singleResult.sampling?.coveragePct ?? singleResult.coveragePct,
        isSampled: singleResult.sampling?.isSampled ?? singleResult.isSampled,
        selectionMethod: singleResult.sampling?.selectionMethod ?? singleResult.selectionMethod,
        isSingleWallet: true,
      };
    }
    if (currentWallet?.intelligenceV1) {
      return {
        qualityScore: currentWallet.intelligenceV1.qualityScore,
        riskScore: currentWallet.intelligenceV1.riskScore,
        confidenceScore: currentWallet.intelligenceV1.confidenceScore,
        style: currentWallet.intelligenceV1.style,
        shortlisted: currentWallet.intelligenceV1.shortlisted,
        performance: currentWallet.intelligenceV1.performance,
        referenceCohort: null,
        analyzedAt: null,
        isSingleWallet: false,
      };
    }
    return null;
  }, [singleResult, currentWallet?.intelligenceV1]);


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
                <div className="panel-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <h3>LP Intelligence</h3>
                    <span>ⓘ</span>
                  </div>

                  {isStopping ? (
                    <button
                      className="single-intel-btn"
                      disabled
                      title="Stopping analysis..."
                    >
                      <Loader2 size={12} className="spin" />
                      <span>Stopping...</span>
                    </button>
                  ) : isAnalyzing ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <button
                        className="single-intel-btn"
                        disabled
                        style={{ cursor: "default" }}
                        title="Analysis in progress"
                      >
                        <Loader2 size={12} className="spin" />
                        <span>Analyzing Wallet...</span>
                      </button>
                      <button
                        className="single-intel-btn danger"
                        onClick={handleStopAnalysis}
                        disabled={actionPending}
                        title="Stop wallet intelligence analysis"
                      >
                        <Square size={11} fill="currentColor" />
                        <span>Stop Analysis</span>
                      </button>
                    </div>
                  ) : activeIntelligence ? (
                    <button
                      className="single-intel-btn"
                      onClick={handleRunAnalysis}
                      disabled={actionPending}
                      title="Re-run Wallet Intelligence for this wallet"
                    >
                      <RotateCw size={12} />
                      <span>Re-analyze Wallet</span>
                    </button>
                  ) : (
                    <button
                      className="single-intel-btn"
                      onClick={handleRunAnalysis}
                      disabled={actionPending}
                      title="Run Wallet Intelligence for this wallet"
                    >
                      <Play size={12} />
                      <span>Run Wallet Intelligence</span>
                    </button>
                  )}
                </div>

                {isStopping ? (
                  <div className="single-intel-status-box warning" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Loader2 size={13} className="spin" />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "11.5px" }}>STOPPING ANALYSIS</div>
                        <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.7)", marginTop: "2px" }}>
                          Stopping analysis gracefully and releasing process locks...
                        </div>
                      </div>
                    </div>
                  </div>
                ) : isAnalyzing ? (
                  <div className="single-intel-status-box info" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Loader2 size={13} className="spin" />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "11.5px" }}>
                          Stage: {singleStatus?.stage ? singleStatus.stage.toUpperCase() : "ANALYZING"}
                          {analysisElapsedSeconds > 0 ? ` (${analysisElapsedSeconds}s)` : ""}
                        </div>
                        <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.7)", marginTop: "2px" }}>
                          {singleStatus?.stageDetails || "Analyzing closed positions & risk metrics for this wallet..."}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                      <button
                        className="single-intel-btn danger"
                        onClick={handleStopAnalysis}
                        disabled={actionPending}
                        style={{ fontSize: "11px", padding: "4px 8px" }}
                        title="Stop wallet intelligence analysis"
                      >
                        <Square size={11} fill="currentColor" /> Stop Analysis
                      </button>
                      {singleStatus?.runId ? (
                        <a
                          href={`/activity-logs?wallet=${encodeURIComponent(currentWallet?.owner || "")}&runId=${encodeURIComponent(singleStatus.runId)}`}
                          className="single-intel-btn"
                          style={{ textDecoration: "none", fontSize: "11px", padding: "4px 8px" }}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Terminal size={11} /> View Logs
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : singleStatus?.status === "stopped" ? (
                  <div className="single-intel-status-box neutral" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Square size={13} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "11.5px" }}>Analysis stopped by user.</div>
                        <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.7)", marginTop: "2px" }}>
                          Process terminated. Previous results and artifacts preserved. Click "Run Wallet Intelligence" to re-evaluate.
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                      <button
                        className="single-intel-btn"
                        onClick={handleRunAnalysis}
                        disabled={actionPending}
                        style={{ fontSize: "11px", padding: "4px 8px" }}
                        title="Run Wallet Intelligence for this wallet"
                      >
                        <Play size={11} /> Run Wallet Intelligence
                      </button>
                      {singleStatus?.runId ? (
                        <a
                          href={`/activity-logs?wallet=${encodeURIComponent(currentWallet?.owner || "")}&runId=${encodeURIComponent(singleStatus.runId)}`}
                          className="single-intel-btn"
                          style={{ textDecoration: "none", fontSize: "11px", padding: "4px 8px" }}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Terminal size={11} /> View Logs
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : analysisError ? (
                  <div className="single-intel-status-box error" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", flex: 1 }}>
                      <AlertCircle size={14} style={{ flexShrink: 0, marginTop: "2px" }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "11.5px" }}>
                          {formatHumanErrorSummary(analysisError)}
                        </div>
                        <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.75)", marginTop: "2px" }}>
                          Check browser connection or inspect logs for details.
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                      <button
                        className="single-intel-btn"
                        onClick={handleRunAnalysis}
                        disabled={actionPending}
                        style={{ fontSize: "11px", padding: "4px 8px" }}
                        title="Retry Wallet Intelligence for this wallet"
                      >
                        <RotateCw size={11} /> Retry Analysis
                      </button>
                      <a
                        href={`/activity-logs?wallet=${encodeURIComponent(currentWallet?.owner || "")}${singleStatus?.runId ? `&runId=${encodeURIComponent(singleStatus.runId)}` : ""}`}
                        className="single-intel-btn"
                        style={{ textDecoration: "none", fontSize: "11px", padding: "4px 8px" }}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Terminal size={11} /> View Logs
                      </a>
                    </div>
                  </div>
                ) : null}

                {singleStatus?.status === "reference_required" && !activeIntelligence ? (
                  <div className="single-intel-status-box warning">
                    <AlertCircle size={13} />
                    <span>Reference cohort required. Please run initial Wallet Intelligence screening first from Data &rarr; Screening.</span>
                  </div>
                ) : null}

                {activeIntelligence ? (
                  <div>
                    <div className="v1-intel-grid">
                      <div className="v1-intel-card">
                        <span>Quality Score</span>
                        <strong>
                          {activeIntelligence.qualityScore !== null &&
                          activeIntelligence.qualityScore !== undefined
                            ? fmt(activeIntelligence.qualityScore, 1)
                            : "—"}
                        </strong>
                        <small>Cohort relative (0–100)</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Risk Score</span>
                        <strong>
                          {activeIntelligence.riskScore !== null &&
                          activeIntelligence.riskScore !== undefined
                            ? fmt(activeIntelligence.riskScore, 1)
                            : "—"}
                        </strong>
                        <small>Historical loss risk (0–100)</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Confidence Score</span>
                        <strong>
                          {activeIntelligence.confidenceScore !== null &&
                          activeIntelligence.confidenceScore !== undefined
                            ? fmt(activeIntelligence.confidenceScore, 1)
                            : "—"}
                        </strong>
                        <small>Evidence sample & span (0–100)</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Style</span>
                        <strong style={{ fontSize: "16px", marginTop: "8px" }}>
                          {formatStyleDisplay(activeIntelligence.style)}
                        </strong>
                        <small>Historical DLMM behavior</small>
                      </div>

                      <div className="v1-intel-card">
                        <span>Shortlist Status</span>
                        <div style={{ marginTop: "7px" }}>
                          {activeIntelligence.shortlisted ? (
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
                          {activeIntelligence.shortlisted
                            ? "Passes V1 historical monitoring criteria"
                            : "Monitoring criteria not met"}
                        </small>
                      </div>
                    </div>

                    {activeIntelligence.performance ? (
                      <div className="v1-perf-strip">
                        <div className="v1-perf-item">
                          <span>Total PnL (USD)</span>
                          <strong
                            className={
                              activeIntelligence.performance.totalPnl >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {activeIntelligence.performance.totalPnl >= 0 ? "+" : ""}${fmt(activeIntelligence.performance.totalPnl, 2)} USD
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Profit Factor</span>
                          <strong>
                            {fmt(activeIntelligence.performance.profitFactor, 2)}
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Median Position PnL %</span>
                          <strong
                            className={
                              activeIntelligence.performance.medianPositionPnlPct >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {activeIntelligence.performance.medianPositionPnlPct >= 0
                              ? "+"
                              : ""}
                            {fmt(activeIntelligence.performance.medianPositionPnlPct, 2)}%
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span>Win Rate</span>
                          <strong>
                            {fmt(activeIntelligence.performance.positionWinRate, 1)}%
                          </strong>
                        </div>

                        <div className="v1-perf-item">
                          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            Positions
                            {activeIntelligence.isSampled ? (
                              <span className="v1-sampled-badge" title="Capped at 1,000 most recently closed positions">
                                Sampled
                              </span>
                            ) : null}
                          </span>
                          <strong title={activeIntelligence.totalEligiblePositions ? `${activeIntelligence.analyzedPositions ?? activeIntelligence.performance.closedPositionCount} analyzed out of ${activeIntelligence.totalEligiblePositions} qualifying (${activeIntelligence.coveragePct ?? 100}% coverage)` : undefined}>
                            {activeIntelligence.totalEligiblePositions && activeIntelligence.totalEligiblePositions !== activeIntelligence.performance.closedPositionCount
                              ? `${activeIntelligence.analyzedPositions ?? activeIntelligence.performance.closedPositionCount} / ${activeIntelligence.totalEligiblePositions}`
                              : activeIntelligence.performance.closedPositionCount}
                          </strong>
                        </div>

                        {activeIntelligence.coveragePct !== undefined && activeIntelligence.coveragePct !== null ? (
                          <div className="v1-perf-item">
                            <span>Coverage</span>
                            <strong>
                              {activeIntelligence.coveragePct}%
                            </strong>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {activeIntelligence.isSampled ? (
                      <div className="v1-sample-disclaimer">
                        <span>ⓘ</span>
                        <span>
                          <strong>Sampling notice:</strong> Scores and position PnL represent the analyzed sample of the {activeIntelligence.analyzedPositions ?? 1000} most recently closed positions ({activeIntelligence.coveragePct}% coverage of {activeIntelligence.totalEligiblePositions} eligible closed positions in the 30-day window).
                        </span>
                      </div>
                    ) : activeIntelligence.totalEligiblePositions ? (
                      <div className="v1-sample-disclaimer complete">
                        <span>ⓘ</span>
                        <span>
                          Scores and position PnL represent all {activeIntelligence.totalEligiblePositions} qualifying closed positions in the 30-day window (100% complete coverage).
                        </span>
                      </div>
                    ) : null}


                    {activeIntelligence.referenceCohort ? (
                      <div style={{ padding: "8px 14px 2px", fontSize: "10.5px", color: "#66625c", display: "flex", justifyContent: "space-between" }}>
                        <span>Reference: {activeIntelligence.referenceCohort.validWallets} wallets (V1 Strict)</span>
                        <span>Analyzed: {new Date(activeIntelligence.analyzedAt || "").toLocaleDateString()}</span>
                      </div>
                    ) : null}
                  </div>
                ) : !isAnalyzing ? (
                  <div
                    style={{
                      padding: "20px 18px",
                      color: "#9a968f",
                      fontSize: "12px",
                    }}
                  >
                    <span>No V1 intelligence calculated for this wallet yet. Click "Run Wallet Intelligence" above to evaluate.</span>
                  </div>
                ) : null}
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
