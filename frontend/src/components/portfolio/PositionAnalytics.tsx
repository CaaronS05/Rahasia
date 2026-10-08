import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Play,
  RotateCw,
  Square,
  Activity,
  AlertTriangle,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Search,
  Copy,
  Check,
  Calendar,
  Layers,
  ArrowUpDown,
  ExternalLink,
} from "lucide-react";
import {
  type AnalyticsPeriod,
  type PositionAnalyticsStatus,
  type PositionMetricsResult,
  type PositionsResponse,
  type CompactPositionRecord,
  type FullPositionDetail,
  type PairBreakdownItem,
  type PoolBreakdownItem,
  type MonitoringAssessmentResult,
  type MonitoringVerdict,
  type ManualFollowability,
  getPositionAnalyticsStatus,
  getPositionMetrics,
  getPositions,
  getPositionDetail,
  getPositionAssessment,
  startPositionAnalytics,
  stopPositionAnalytics,
} from "../../lib/positionAnalyticsApi";
import "./position-analytics.css";

interface Props {
  walletAddress: string;
}

// ---------------------------------------------------------------------------
// Formatters (Strict Data Integrity: Never silently convert null to 0)
// ---------------------------------------------------------------------------

function formatUsd(val: number | null | undefined, prefixSign = false): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  const abs = Math.abs(val);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: abs >= 100 ? 0 : 2,
    maximumFractionDigits: abs >= 100 ? 0 : 2,
  }).format(abs);

  if (val > 0) return prefixSign ? `+${formatted}` : formatted;
  if (val < 0) return `-${formatted}`;
  return formatted;
}

function formatPct(val: number | null | undefined, prefixSign = false): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  const formatted = `${val.toFixed(2)}%`;
  if (val > 0 && prefixSign) return `+${formatted}`;
  return formatted;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function formatWibDate(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d) + " WIB";
}

function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function PositionAnalytics({ walletAddress }: Props) {
  const [period, setPeriod] = useState<AnalyticsPeriod>("30D");
  const [status, setStatus] = useState<PositionAnalyticsStatus | null>(null);
  const [metrics, setMetrics] = useState<PositionMetricsResult | null>(null);
  const [positionsData, setPositionsData] = useState<PositionsResponse | null>(null);
  const [assessment, setAssessment] = useState<MonitoringAssessmentResult | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Expanded Pair Breakdown
  const [expandedPairs, setExpandedPairs] = useState<Set<string>>(new Set());

  // Positions Explorer state
  const [searchQuery, setSearchQuery] = useState("");
  const [pairFilter, setPairFilter] = useState("ALL");
  const [winLossFilter, setWinLossFilter] = useState<"ALL" | "WIN" | "LOSS" | "BREAKEVEN" | "UNKNOWN">("ALL");
  const [sortField, setSortField] = useState<keyof CompactPositionRecord>("closedAt");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedPositionKey, setExpandedPositionKey] = useState<string | null>(null);
  const [positionDetails, setPositionDetails] = useState<Record<string, FullPositionDetail>>({});
  const [loadingDetailKey, setLoadingDetailKey] = useState<string | null>(null);

  const activeWalletRef = useRef(walletAddress);
  const activePeriodRef = useRef(period);
  const currentDatasetVersionRef = useRef<string | null>(null);
  activeWalletRef.current = walletAddress;
  activePeriodRef.current = period;

  const getPositionKey = (poolAddress: string, positionId: string) => `${poolAddress}:${positionId}`;
  const copyToClipboard = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Load existing metrics and status for current wallet & period
  const loadData = useCallback(async (wallet: string, p: AnalyticsPeriod, silent = false) => {
    if (!silent) setLoading(true);
    setActionError(null);

    try {
      const [st, m, pos, assess] = await Promise.all([
        getPositionAnalyticsStatus(wallet, p).catch(() => null),
        getPositionMetrics(wallet, p).catch(() => null),
        getPositions(wallet, p).catch(() => null),
        getPositionAssessment(wallet, p).catch(() => null),
      ]);

      if (activeWalletRef.current === wallet && activePeriodRef.current === p) {
        // Prevent frontend rendering of mixed versions if publication occurred between multiple requests
        if (
          m &&
          pos &&
          m.sourceDatasetFetchedAt &&
          pos.fetchedAt &&
          m.sourceDatasetFetchedAt !== pos.fetchedAt
        ) {
          loadData(wallet, p, true);
          return;
        }

        if (
          m &&
          assess &&
          m.sourceDatasetFetchedAt &&
          assess.sourceDatasetFetchedAt &&
          m.sourceDatasetFetchedAt !== assess.sourceDatasetFetchedAt
        ) {
          loadData(wallet, p, true);
          return;
        }

        const newVersion = pos?.fetchedAt || st?.lastAnalyzedAt || null;
        if (currentDatasetVersionRef.current !== null && currentDatasetVersionRef.current !== newVersion) {
          setPositionDetails({});
          setExpandedPositionKey(null);
        }
        currentDatasetVersionRef.current = newVersion;
        setStatus(st);
        setMetrics(m);
        setPositionsData(pos);
        setAssessment(assess);
      }
    } catch (err: unknown) {
      if (activeWalletRef.current === wallet && activePeriodRef.current === p) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeWalletRef.current === wallet && activePeriodRef.current === p) {
        setLoading(false);
      }
    }
  }, []);

  // Timeframe or Wallet change
  useEffect(() => {
    setPage(1);
    setExpandedPositionKey(null);
    setExpandedPairs(new Set());
    setPositionDetails({});
    setAssessment(null);
    currentDatasetVersionRef.current = null;
    loadData(walletAddress, period);
  }, [walletAddress, period, loadData]);

  // Polling for active runs
  useEffect(() => {
    let timer: number | null = null;
    const isRunning = status?.status === "running" || status?.status === "stopping";

    if (isRunning) {
      timer = window.setInterval(async () => {
        try {
          const st = await getPositionAnalyticsStatus(walletAddress, period);
          if (activeWalletRef.current !== walletAddress || activePeriodRef.current !== period) return;

          setStatus(st);
          if (st.status === "completed" || st.status === "error" || st.status === "stopped") {
            loadData(walletAddress, period, true);
          }
        } catch {
          // Ignore polling errors
        }
      }, 1500);
    }

    return () => {
      clearInterval(timer ?? undefined);
    };
  }, [walletAddress, period, status?.status, loadData]);

  // Analysis actions
  const handleStart = async (force: boolean) => {
    setActionLoading(true);
    setActionError(null);
    try {
      const st = await startPositionAnalytics(walletAddress, period, force);
      setStatus(st);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const st = await stopPositionAnalytics(walletAddress);
      setStatus(st);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleViewLogs = () => {
    const runId = status?.runId;
    const logsUrl = `/activity-logs?wallet=${encodeURIComponent(walletAddress)}&source=position_analytics${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`;
    window.open(logsUrl, "_blank");
  };

  // Expand position detail on demand using poolAddress + positionId composite identity
  const handleToggleExpandPosition = async (pos: CompactPositionRecord) => {
    const posKey = getPositionKey(pos.poolAddress, pos.positionId);
    if (expandedPositionKey === posKey) {
      setExpandedPositionKey(null);
      return;
    }

    setExpandedPositionKey(posKey);
    if (!positionDetails[posKey]) {
      setLoadingDetailKey(posKey);
      const reqWallet = walletAddress;
      const reqPeriod = period;
      const reqVersion = currentDatasetVersionRef.current;
      try {
        const detail = await getPositionDetail(reqWallet, reqPeriod, pos.positionId, pos.poolAddress);
        // Prevent stale asynchronous responses from updating another wallet/period's view
        if (
          activeWalletRef.current !== reqWallet ||
          activePeriodRef.current !== reqPeriod ||
          currentDatasetVersionRef.current !== reqVersion
        ) {
          return;
        }
        if (detail) {
          setPositionDetails((prev) => ({ ...prev, [posKey]: detail }));
        }
      } catch {
        // Fall back to compact row
      } finally {
        if (
          activeWalletRef.current === reqWallet &&
          activePeriodRef.current === reqPeriod &&
          currentDatasetVersionRef.current === reqVersion
        ) {
          setLoadingDetailKey((prev) => (prev === posKey ? null : prev));
        }
      }
    }
  };
  // Toggle pair breakdown expand
  const handleTogglePair = (pairKey: string) => {
    setExpandedPairs((prev) => {
      const next = new Set(prev);
      if (next.has(pairKey)) next.delete(pairKey);
      else next.add(pairKey);
      return next;
    });
  };

  // Filtered & Sorted Positions
  const availablePairs = useMemo(() => {
    if (!positionsData?.positions) return [];
    const pairs = new Set<string>();
    for (const p of positionsData.positions) {
      if (p.pairName) pairs.add(p.pairName);
    }
    return Array.from(pairs).sort();
  }, [positionsData]);

  const filteredPositions = useMemo(() => {
    if (!positionsData?.positions) return [];
    const q = searchQuery.trim().toLowerCase();

    return positionsData.positions.filter((p) => {
      if (pairFilter !== "ALL" && p.pairName !== pairFilter) return false;
      if (winLossFilter !== "ALL" && p.winLoss !== winLossFilter) return false;

      if (q) {
        const matchId = p.positionId.toLowerCase().includes(q);
        const matchPool = p.poolAddress.toLowerCase().includes(q);
        const matchPair = p.pairName?.toLowerCase().includes(q) ?? false;
        const matchSymbol = (p.tokenXSymbol?.toLowerCase().includes(q) ?? false) ||
                            (p.tokenYSymbol?.toLowerCase().includes(q) ?? false);
        if (!matchId && !matchPool && !matchPair && !matchSymbol) return false;
      }

      return true;
    });
  }, [positionsData, pairFilter, winLossFilter, searchQuery]);

  const sortedPositions = useMemo(() => {
    return [...filteredPositions].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];

      if (aVal === null || aVal === undefined) return sortAsc ? -1 : 1;
      if (bVal === null || bVal === undefined) return sortAsc ? 1 : -1;

      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortAsc ? aVal - bVal : bVal - aVal;
      }
      return sortAsc
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
  }, [filteredPositions, sortField, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(sortedPositions.length / pageSize));
  const paginatedPositions = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedPositions.slice(start, start + pageSize);
  }, [sortedPositions, page, pageSize]);

  const handleSort = (field: keyof CompactPositionRecord) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  // Render Loading skeleton
  if (loading && !metrics && !status) {
    return (
      <div className="position-analytics-container">
        <div className="pa-header-card pa-skeleton" style={{ height: "110px" }} />
        <div className="pa-grid-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="pa-card pa-skeleton" style={{ height: "96px" }} />
          ))}
        </div>
      </div>
    );
  }

  const isRunning = status?.status === "running";
  const isStopping = status?.status === "stopping";
  const hasSavedMetrics = Boolean(metrics && status?.hasMetrics);

  return (
    <div className="position-analytics-container">
      {/* ---------------------------------------------------- */}
      {/* SECTION A: HEADER & CONTROL BAR */}
      {/* ---------------------------------------------------- */}
      <section className="pa-header-card">
        <div className="pa-header-top">
          <div className="pa-header-title-block">
            <h3>
              <Layers size={20} color="var(--green)" />
              Position Analytics
            </h3>
            <div className="pa-header-meta">
              <span>Wallet:</span>
              <span className="wallet-tag" title={walletAddress}>
                {shortAddress(walletAddress)}
              </span>
              <button
                className="pa-btn pa-btn-secondary"
                style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                onClick={() => copyToClipboard("header-wallet", walletAddress)}
                title="Copy full wallet address"
              >
                {copiedKey === "header-wallet" ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
              </button>
              <span>•</span>
              <span>Last Analyzed:</span>
              <strong style={{ color: "var(--text)" }}>
                {formatWibDate(metrics?.generatedAt || status?.lastAnalyzedAt)}
              </strong>
            </div>
          </div>

          <div className="pa-header-actions">
            {/* 30D / 90D / All Available Selector */}
            <div className="pa-period-selector">
              {(["30D", "90D", "ALL_AVAILABLE"] as AnalyticsPeriod[]).map((p) => (
                <button
                  key={p}
                  className={`pa-period-btn ${period === p ? "active" : ""}`}
                  onClick={() => setPeriod(p)}
                  disabled={isRunning || isStopping}
                >
                  {p === "ALL_AVAILABLE" ? "All Available" : p}
                </button>
              ))}
            </div>

            {/* Run / Refresh / Stop */}
            {isRunning || isStopping ? (
              <button
                className="pa-btn pa-btn-danger"
                onClick={handleStop}
                disabled={actionLoading || isStopping}
              >
                <Square size={14} />
                {isStopping ? "Stopping..." : "Stop Analysis"}
              </button>
            ) : hasSavedMetrics ? (
              <button
                className="pa-btn pa-btn-secondary"
                onClick={() => handleStart(true)}
                disabled={actionLoading}
              >
                <RotateCw size={14} className={actionLoading ? "spin" : ""} />
                Refresh Analysis
              </button>
            ) : (
              <button
                className="pa-btn pa-btn-primary"
                onClick={() => handleStart(false)}
                disabled={actionLoading}
              >
                <Play size={14} fill="currentColor" />
                Run Analysis
              </button>
            )}

            <button className="pa-btn pa-btn-secondary" onClick={handleViewLogs}>
              <Activity size={14} />
              View Activity Logs
            </button>
          </div>
        </div>

        {/* Live Status Bar */}
        <div className="pa-status-bar">
          <div className="pa-status-left">
            <span
              className={`pa-status-indicator ${
                isRunning ? "running" : isStopping ? "stopping" : status?.status || "idle"
              }`}
            />
            <span className="pa-status-text">
              {isRunning
                ? `Running: ${status?.stageDetails || status?.stage || "Processing"}...`
                : isStopping
                ? "Stopping analysis..."
                : status?.status === "completed"
                ? "Analysis Complete"
                : status?.status === "error"
                ? "Analysis Failed"
                : status?.status === "stopped"
                ? "Analysis Stopped"
                : "Idle"}
            </span>
            {isRunning && status?.elapsedMs ? (
              <span className="pa-status-details">
                ({Math.floor(status.elapsedMs / 1000)}s elapsed)
              </span>
            ) : null}
            {status?.error ? (
              <span className="pa-status-details" style={{ color: "var(--red)" }}>
                — {status.error}
              </span>
            ) : null}
          </div>

          {metrics?.sampling ? (
            <div className="pa-status-details">
              Coverage: {metrics.sampling.analyzedPositions.toLocaleString()} /{" "}
              {metrics.sampling.totalEligiblePositions.toLocaleString()} closed positions (
              {metrics.sampling.coveragePct.toFixed(1)}%)
            </div>
          ) : null}
        </div>

        {actionError ? (
          <div className="pa-notice-banner danger">
            <AlertTriangle size={16} />
            <div>
              <strong>Action Failed:</strong> {actionError}
            </div>
          </div>
        ) : null}

        {/* Sampling & Source Coverage Notices */}
        {metrics?.sampling?.isSampled ? (
          <div className="pa-notice-banner warning">
            <Info size={16} />
            <div>
              <strong>Sampling Limitation:</strong> Analyzed the latest{" "}
              {metrics.sampling.analyzedPositions.toLocaleString()} closed positions. History is capped at 1,000 positions.
              <div className="disclaimer-text">
                Performance is based on analyzed closed positions, not the wallet's entire exposure. Active/open position exposure is not included.
              </div>
            </div>
          </div>
        ) : null}

        {metrics?.sourceCoverage?.status === "PARTIAL" ? (
          <div className="pa-notice-banner warning">
            <AlertTriangle size={16} />
            <div>
              <strong>Partial Source Coverage:</strong> Some DLMM pool positions could not be fully extracted from the provider.
              <div className="disclaimer-text">
                Performance metrics reflect observed closed positions only.
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* If No Saved Analysis exists, show Run CTA */}
      {!hasSavedMetrics && !isRunning && !isStopping ? (
        <section className="pa-empty-state">
          <Layers size={42} color="var(--muted)" />
          <h3>No Position Analytics Available</h3>
          <p>
            No analyzed closed DLMM position data is available for wallet{" "}
            <strong>{shortAddress(walletAddress)}</strong> in the <strong>{period}</strong> timeframe.
            Click below to reconstruct lifecycle positions and calculate performance metrics.
          </p>
          <button
            className="pa-btn pa-btn-primary"
            style={{ marginTop: "8px", padding: "10px 24px" }}
            onClick={() => handleStart(false)}
            disabled={actionLoading}
          >
            <Play size={15} fill="currentColor" />
            Run Position Analysis
          </button>
        </section>
      ) : metrics ? (
        <>
          {/* ---------------------------------------------------- */}
          {/* SECTION: MONITORING ASSESSMENT */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Monitoring Assessment</h4>
                <p className="pa-section-subtitle">
                  Deterministic screening heuristic and historical manual followability — not a prediction of future profitability
                </p>
              </div>
              <span className="pa-badge" style={{ background: "rgba(255,255,255,0.05)", color: "var(--muted)" }}>
                V1 Assessment Engine
              </span>
            </div>

            {assessment ? (
              <div className="pa-assessment-container">
                {/* Top Metrics Row: Verdict, Score, Followability */}
                <div className="pa-grid-3">
                  <div className="pa-card">
                    <div className="pa-card-title">Monitoring Verdict</div>
                    <div style={{ marginTop: "6px" }}>
                      <span className={`pa-verdict-badge ${
                        assessment.verdict === "WORTH_MONITORING"
                          ? "worth-monitoring"
                          : assessment.verdict === "WATCH_WITH_CAUTION"
                          ? "watch-caution"
                          : assessment.verdict === "NOT_RECOMMENDED"
                          ? "not-recommended"
                          : "insufficient-data"
                      }`}>
                        {assessment.verdict === "WORTH_MONITORING" && <CheckCircle2 size={14} />}
                        {assessment.verdict === "WATCH_WITH_CAUTION" && <AlertTriangle size={14} />}
                        {assessment.verdict === "NOT_RECOMMENDED" && <AlertTriangle size={14} />}
                        {assessment.verdict === "INSUFFICIENT_DATA" && <Info size={14} />}
                        {assessment.verdict.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="pa-card-sub" style={{ marginTop: "8px" }}>
                      {assessment.verdict === "WORTH_MONITORING"
                        ? "Meets all 10 quality & risk screening gates"
                        : assessment.verdict === "WATCH_WITH_CAUTION"
                        ? "Promising metrics with specific gating or risk constraints"
                        : assessment.verdict === "NOT_RECOMMENDED"
                        ? "Score below threshold or elevated risk profile"
                        : "Insufficient observations to establish recommendation"}
                    </div>
                  </div>

                  <div className="pa-card">
                    <div className="pa-card-title">Monitoring Score</div>
                    <div className="pa-card-value">
                      {assessment.monitoringScore !== null ? (
                        <>
                          {assessment.monitoringScore}
                          <span style={{ fontSize: "0.85rem", color: "var(--muted)", fontWeight: 500, marginLeft: "4px" }}>
                            / 100
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                    <div className="pa-card-sub">
                      {assessment.monitoringScore !== null
                        ? `Weighted across 4 dimensions (${assessment.scoreComponents ? "Risk, Concentration, Track Record, PnL" : ""})`
                        : "Score withheld due to insufficient historical evidence"}
                    </div>
                  </div>

                  <div className="pa-card">
                    <div className="pa-card-title">Manual Followability</div>
                    <div style={{ marginTop: "6px" }}>
                      <span className={`pa-followability-badge ${
                        assessment.manualFollowability === "HIGH"
                          ? "high"
                          : assessment.manualFollowability === "MODERATE"
                          ? "moderate"
                          : assessment.manualFollowability === "LOW"
                          ? "low"
                          : "unknown"
                      }`}>
                        {assessment.manualFollowability} FOLLOWABILITY
                      </span>
                    </div>
                    <div className="pa-card-sub" style={{ marginTop: "8px" }}>
                      {assessment.followabilityDetails.medianHoldingTimeSeconds !== null
                        ? `Median Hold: ${formatDuration(assessment.followabilityDetails.medianHoldingTimeSeconds)} · ${assessment.followabilityDetails.observedEntriesPerDay?.toFixed(1) ?? "—"} entries/day`
                        : "Hold duration and entry pacing data insufficient"}
                    </div>
                  </div>
                </div>

                {/* Four Weighted Score Components */}
                {assessment.scoreComponents ? (
                  <div className="pa-grid-4" style={{ marginTop: "16px" }}>
                    <div className="pa-score-component-card">
                      <div className="pa-card-title" style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Risk & Consistency</span>
                        <span style={{ color: "var(--text)", fontWeight: 700 }}>
                          {assessment.scoreComponents.riskAndConsistency.score} / {assessment.scoreComponents.riskAndConsistency.maxScore}
                        </span>
                      </div>
                      <div className="pa-card-sub">
                        CVaR10: {assessment.scoreComponents.riskAndConsistency.cvar10 !== null ? `${assessment.scoreComponents.riskAndConsistency.cvar10.toFixed(1)}%` : "—"} (+{assessment.scoreComponents.riskAndConsistency.cvar10Points} pts)
                      </div>
                      <div className="pa-card-sub">
                        Profitable Weeks: {assessment.scoreComponents.riskAndConsistency.profitableWeeksRatioPct !== null ? `${assessment.scoreComponents.riskAndConsistency.profitableWeeksRatioPct.toFixed(0)}%` : "—"} (+{assessment.scoreComponents.riskAndConsistency.weeklyRatioPoints} pts)
                      </div>
                    </div>

                    <div className="pa-score-component-card">
                      <div className="pa-card-title" style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Profit Concentration</span>
                        <span style={{ color: "var(--text)", fontWeight: 700 }}>
                          {assessment.scoreComponents.profitConcentration.score} / {assessment.scoreComponents.profitConcentration.maxScore}
                        </span>
                      </div>
                      <div className="pa-card-sub">
                        Top 1: {assessment.scoreComponents.profitConcentration.top1ConcentrationPct !== null ? `${assessment.scoreComponents.profitConcentration.top1ConcentrationPct.toFixed(1)}%` : "—"} (+{assessment.scoreComponents.profitConcentration.top1Points} pts)
                      </div>
                      <div className="pa-card-sub">
                        Top 5: {assessment.scoreComponents.profitConcentration.top5ConcentrationPct !== null ? `${assessment.scoreComponents.profitConcentration.top5ConcentrationPct.toFixed(1)}%` : "—"} (+{assessment.scoreComponents.profitConcentration.top5Points} pts)
                      </div>
                    </div>

                    <div className="pa-score-component-card">
                      <div className="pa-card-title" style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Track Record / Evidence</span>
                        <span style={{ color: "var(--text)", fontWeight: 700 }}>
                          {assessment.scoreComponents.trackRecord.score} / {assessment.scoreComponents.trackRecord.maxScore}
                        </span>
                      </div>
                      <div className="pa-card-sub">
                        Obs Count: {assessment.scoreComponents.trackRecord.pnlUsdObservations} (+{assessment.scoreComponents.trackRecord.pnlObsPoints} pts)
                      </div>
                      <div className="pa-card-sub">
                        Obs Weeks: {assessment.scoreComponents.trackRecord.observedWeeksWithKnownPnl} (+{assessment.scoreComponents.trackRecord.weeksPoints} pts) · Cov: +{assessment.scoreComponents.trackRecord.coveragePoints} pts
                      </div>
                    </div>

                    <div className="pa-score-component-card">
                      <div className="pa-card-title" style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Profitability</span>
                        <span style={{ color: "var(--text)", fontWeight: 700 }}>
                          {assessment.scoreComponents.profitability.score} / {assessment.scoreComponents.profitability.maxScore}
                        </span>
                      </div>
                      <div className="pa-card-sub">
                        Sample PnL: {formatUsd(assessment.scoreComponents.profitability.sampleTotalPnlUsd, true)} (+{assessment.scoreComponents.profitability.sampleTotalPnlPoints} pts)
                      </div>
                      <div className="pa-card-sub">
                        Median Return: {formatPct(assessment.scoreComponents.profitability.medianPositionPnlPct, true)} (+{assessment.scoreComponents.profitability.medianPnlPctPoints} pts)
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Evidence & Qualitative Breakdown */}
                <div className="pa-grid-2" style={{ marginTop: "16px" }}>
                  {/* Reasons & Concerns */}
                  <div className="pa-card">
                    <div className="pa-card-title">Supporting Reasons & Gating Factors</div>
                    {assessment.reasons.length > 0 ? (
                      <ul className="pa-evidence-list" style={{ marginTop: "10px" }}>
                        {assessment.reasons.map((r, i) => (
                          <li key={i} className="pa-evidence-item positive">
                            <CheckCircle2 size={14} color="var(--green)" style={{ flexShrink: 0, marginTop: "2px" }} />
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {assessment.concerns.length > 0 ? (
                      <div style={{ marginTop: "16px" }}>
                        <div className="pa-card-title" style={{ color: "var(--red)" }}>
                          Key Concerns & Gating Warnings
                        </div>
                        <ul className="pa-evidence-list" style={{ marginTop: "8px" }}>
                          {assessment.concerns.map((c, i) => (
                            <li key={i} className="pa-evidence-item warning">
                              <AlertTriangle size={14} color="var(--red)" style={{ flexShrink: 0, marginTop: "2px" }} />
                              <span>{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  {/* Observation & Coverage Summary */}
                  <div className="pa-card">
                    <div className="pa-card-title">Evidence & Observation Summary</div>
                    <div className="pa-evidence-grid" style={{ marginTop: "10px" }}>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Source Extraction</span>
                        <span className="pa-evidence-val">{assessment.evidence.sourceCoverageStatus}</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Analyzed Positions</span>
                        <span className="pa-evidence-val">{assessment.evidence.analyzedClosedPositions}</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Sampling Coverage</span>
                        <span className="pa-evidence-val">{assessment.evidence.samplingCoveragePct.toFixed(1)}%</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">PnL Coverage (USD/%)</span>
                        <span className="pa-evidence-val">{assessment.evidence.pnlUsdCoveragePct.toFixed(0)}% / {assessment.evidence.pnlPctCoveragePct.toFixed(0)}%</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Observed PnL Weeks</span>
                        <span className="pa-evidence-val">{assessment.evidence.observedWeeksWithKnownPnl} weeks ({assessment.evidence.profitableWeeksCount} win)</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Entry Timestamp Cov</span>
                        <span className="pa-evidence-val">{assessment.evidence.openingTimestampCoveragePct.toFixed(0)}%</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Median Hold Duration</span>
                        <span className="pa-evidence-val">{formatDuration(assessment.evidence.medianHoldingTimeSeconds)}</span>
                      </div>
                      <div className="pa-evidence-row">
                        <span className="pa-evidence-label">Typical Entry Size</span>
                        <span className="pa-evidence-val">{formatUsd(assessment.evidence.medianInitialEntryUsd)}</span>
                      </div>
                    </div>

                    <div style={{ marginTop: "12px", fontSize: "0.75rem", color: "var(--muted)", fontStyle: "italic" }}>
                      * Median initial entry is shown as informational capital context only, not affordability evaluation.
                    </div>
                  </div>
                </div>

                {/* Limitations Banner */}
                {assessment.limitations.length > 0 ? (
                  <div className="pa-notice-banner" style={{ marginTop: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-soft)" }}>
                    <Info size={15} color="var(--muted)" style={{ flexShrink: 0, marginTop: "2px" }} />
                    <div style={{ fontSize: "0.78rem", color: "var(--muted)", display: "flex", flexDirection: "column", gap: "4px" }}>
                      {assessment.limitations.map((lim, idx) => (
                        <div key={idx}>• {lim}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="pa-card" style={{ padding: "16px 20px" }}>
                <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
                  Monitoring assessment data is not yet available for this snapshot.
                </span>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------- */}
          {/* SECTION B: CAPITAL & POSITION SIZING */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Capital & Position Sizing</h4>
                <p className="pa-section-subtitle">
                  Verified position entry sizing, additional deposits, and initial capital distribution
                </p>
              </div>
            </div>

            <div className="pa-grid-4">
              <div className="pa-card">
                <div className="pa-card-title">Typical Initial Entry (P25–P75)</div>
                <div className="pa-card-value">
                  {metrics.capital.typicalPositionSize.p25 !== null &&
                  metrics.capital.typicalPositionSize.p75 !== null
                    ? `${formatUsd(metrics.capital.typicalPositionSize.p25)} – ${formatUsd(
                        metrics.capital.typicalPositionSize.p75
                      )}`
                    : "—"}
                </div>
                <div className="pa-card-sub">Interquartile typical range</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Median Initial Entry</div>
                <div className="pa-card-value">
                  {formatUsd(metrics.capital.medianInitialEntryUsd)}
                </div>
                <div className="pa-card-sub">50th percentile entry capital</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Average Initial Entry</div>
                <div className="pa-card-value">
                  {formatUsd(metrics.capital.avgInitialEntryUsd)}
                </div>
                <div className="pa-card-sub">Arithmetic mean of verified entries</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Total Position Deposits</div>
                <div className="pa-card-value">
                  {formatUsd(metrics.capital.totalPositionDepositsUsd)}
                </div>
                <div className="pa-card-sub">Cumulative initial + added deposits</div>
              </div>
            </div>

            {/* Secondary Capital Metrics & Distribution Chart */}
            <div className="pa-grid-2">
              <div className="pa-card">
                <div className="pa-card-title">Secondary Liquidity Observations</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.86rem" }}>
                    <span style={{ color: "var(--muted)" }}>Average Additional Liquidity:</span>
                    <strong>{formatUsd(metrics.capital.avgAdditionalLiquidityUsd)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.86rem" }}>
                    <span style={{ color: "var(--muted)" }}>Initial Entry Coverage:</span>
                    <strong>
                      {formatPct(metrics.metricCoverage?.initialEntryCoveragePct)} (
                      {metrics.metricCoverage?.initialEntryObservations ?? 0} verified)
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.86rem" }}>
                    <span style={{ color: "var(--muted)" }}>Median Total Deposits:</span>
                    <strong>{formatUsd(metrics.capital.medianTotalPositionDepositsUsd)}</strong>
                  </div>
                </div>
              </div>

              {/* Position Size Distribution Chart */}
              <div className="pa-chart-card">
                <div className="pa-chart-header">
                  <span className="pa-chart-title">Position Size Distribution</span>
                  <span className="pa-chart-legend">
                    <span className="pa-legend-dot" style={{ background: "#8ba8ff" }} /> Count (%)
                  </span>
                </div>
                <div className="pa-bars-container">
                  {metrics.capital.positionSizeDistribution?.length > 0 ? (
                    metrics.capital.positionSizeDistribution.map((b) => (
                      <div key={b.label} className="pa-bar-row">
                        <span className="pa-bar-label" title={b.label}>
                          {b.label}
                        </span>
                        <div className="pa-bar-track">
                          <div
                            className="pa-bar-fill primary"
                            style={{ width: `${Math.min(100, Math.max(2, b.pct))}%` }}
                          />
                        </div>
                        <span className="pa-bar-value">
                          {b.count} ({b.pct.toFixed(1)}%)
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "var(--muted)", fontSize: "0.82rem", textAlign: "center" }}>
                      No size distribution data available
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------- */}
          {/* SECTION C: PROFITABILITY */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Profitability</h4>
                <p className="pa-section-subtitle">
                  Observed closed position PnL, win rates, and return distributions
                </p>
              </div>
            </div>

            <div className="pa-grid-4">
              <div className="pa-card">
                <div className="pa-card-title">Sample Total PnL USD</div>
                <div
                  className={`pa-card-value ${
                    (metrics.profitability.sampleTotalPnlUsd ?? 0) >= 0 ? "positive" : "negative"
                  }`}
                >
                  {formatUsd(metrics.profitability.sampleTotalPnlUsd, true)}
                </div>
                <div className="pa-card-sub">Sum of realized position PnL</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Average Position PnL %</div>
                <div
                  className={`pa-card-value ${
                    (metrics.profitability.avgPositionPnlPct ?? 0) >= 0 ? "positive" : "negative"
                  }`}
                >
                  {formatPct(metrics.profitability.avgPositionPnlPct, true)}
                </div>
                <div className="pa-card-sub">Mean return per position</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Median Position PnL %</div>
                <div
                  className={`pa-card-value ${
                    (metrics.profitability.medianPositionPnlPct ?? 0) >= 0 ? "positive" : "negative"
                  }`}
                >
                  {formatPct(metrics.profitability.medianPositionPnlPct, true)}
                </div>
                <div className="pa-card-sub">50th percentile return</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Win Rate</div>
                <div className="pa-card-value positive">
                  {formatPct(metrics.profitability.positionWinRate)}
                </div>
                <div className="pa-card-sub">
                  {metrics.profitability.winCount}W / {metrics.profitability.lossCount}L /{" "}
                  {metrics.profitability.breakevenCount}BE
                </div>
              </div>
            </div>

            <div className="pa-grid-3">
              <div className="pa-card">
                <div className="pa-card-title">Highest Win %</div>
                <div className="pa-card-value positive">
                  {formatPct(metrics.profitability.bestWinningPositionPct, true)}
                </div>
                <div className="pa-card-sub">Best observed return</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Worst Loss %</div>
                <div className="pa-card-value negative">
                  {formatPct(metrics.profitability.worstLosingPositionPct, true)}
                </div>
                <div className="pa-card-sub">Worst observed return</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Profit Factor</div>
                <div className="pa-card-value">
                  {metrics.profitability.profitFactorStatus === "UNBOUNDED_NO_LOSSES"
                    ? "No observed losses"
                    : metrics.profitability.profitFactor !== null
                    ? metrics.profitability.profitFactor.toFixed(2)
                    : "—"}
                </div>
                <div className="pa-card-sub">Gross wins / Gross losses</div>
              </div>
            </div>

            {/* Position PnL Distribution Chart */}
            <div className="pa-chart-card">
              <div className="pa-chart-header">
                <span className="pa-chart-title">Position PnL Distribution</span>
                <span className="pa-chart-legend">
                  <span className="pa-legend-dot" style={{ background: "var(--green)" }} /> Wins
                  <span className="pa-legend-dot" style={{ background: "var(--red)", marginLeft: "8px" }} /> Losses
                </span>
              </div>
              <div className="pa-bars-container">
                {metrics.profitability.pnlDistribution?.length > 0 ? (
                  metrics.profitability.pnlDistribution.map((b) => {
                    const isPositive = (b.min ?? 0) >= 0 && (b.max ?? 0) > 0;
                    const isNegative = (b.max ?? 0) <= 0 && (b.min ?? 0) < 0;
                    const fillClass = isPositive ? "positive" : isNegative ? "negative" : "neutral";

                    return (
                      <div key={b.label} className="pa-bar-row">
                        <span className="pa-bar-label" title={b.label}>
                          {b.label}
                        </span>
                        <div className="pa-bar-track">
                          <div
                            className={`pa-bar-fill ${fillClass}`}
                            style={{ width: `${Math.min(100, Math.max(2, b.pct))}%` }}
                          />
                        </div>
                        <span className="pa-bar-value">
                          {b.count} ({b.pct.toFixed(1)}%)
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ color: "var(--muted)", fontSize: "0.82rem", textAlign: "center" }}>
                    No PnL distribution data available
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------- */}
          {/* SECTION D: CONSISTENCY & RISK */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Consistency & Risk</h4>
                <p className="pa-section-subtitle">
                  Tail risk exposure, profit concentration, streak analysis, and sample realized drawdown
                </p>
              </div>
            </div>

            <div className="pa-grid-4">
              <div className="pa-card">
                <div className="pa-card-title">CVaR 10% (Expected Shortfall)</div>
                <div className="pa-card-value negative">
                  {formatPct(metrics.riskAndConsistency.cvar10PositionPnlPct, true)}
                </div>
                <div className="pa-card-sub">Mean return of worst 10% positions</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Top 1 Profit Concentration</div>
                <div className="pa-card-value">
                  {formatPct(metrics.riskAndConsistency.top1ProfitConcentrationPct)}
                </div>
                <div className="pa-card-sub">% of gross profit from top win</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Top 5 Profit Concentration</div>
                <div className="pa-card-value">
                  {formatPct(metrics.riskAndConsistency.top5ProfitConcentrationPct)}
                </div>
                <div className="pa-card-sub">% of gross profit from top 5 wins</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Longest Losing Streak</div>
                <div className="pa-card-value">
                  {metrics.riskAndConsistency.longestConsecutiveLosingStreak}
                </div>
                <div className="pa-card-sub">Max consecutive closed losses</div>
              </div>
            </div>

            {/* Drawdown Card */}
            <div className="pa-card">
              <div className="pa-card-title">Sample Realized PnL Drawdown</div>
              <div className="pa-card-value negative">
                {formatUsd(metrics.riskAndConsistency.sampleRealizedPnlDrawdown?.maxDrawdownUsd, true)}
              </div>
              <div className="pa-card-sub" style={{ color: "var(--amber)" }}>
                ⚠️ Drawdown is calculated from sample realized closed-position PnL, NOT actual wallet equity.
              </div>
            </div>

            {/* Weekly Realized Position PnL Chart */}
            <div className="pa-chart-card">
              <div className="pa-chart-header">
                <div>
                  <span className="pa-chart-title">Weekly Realized Position PnL (WIB)</span>
                  <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "2px" }}>
                    {metrics.riskAndConsistency.profitableWeeksCount} profitable weeks ·{" "}
                    {metrics.riskAndConsistency.losingWeeksCount} losing weeks ·{" "}
                    {metrics.riskAndConsistency.breakevenWeeksCount} breakeven weeks
                  </div>
                </div>
                <div className="pa-chart-legend">
                  <span className="pa-legend-dot" style={{ background: "var(--green)" }} /> Profitable
                  <span className="pa-legend-dot" style={{ background: "var(--red)", marginLeft: "8px" }} /> Losing
                  <span className="pa-legend-dot" style={{ background: "var(--muted)", marginLeft: "8px" }} /> Unavailable
                </div>
              </div>

              {metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd?.length > 0 ? (
                (() => {
                  const weeks = metrics.riskAndConsistency.weeklyRealizedPositionPnlUsd;
                  const pnlValues = weeks
                    .map((w) => w.realizedPnlUsd)
                    .filter((v): v is number => v !== null && Number.isFinite(v));
                  const maxAbs = Math.max(...pnlValues.map((v) => Math.abs(v)), 1);

                  return (
                    <div className="pa-weekly-chart-wrap">
                      <div className="pa-weekly-chart">
                        {weeks.map((w, idx) => {
                          const pnl = w.realizedPnlUsd;
                          const isNull = pnl === null || !Number.isFinite(pnl);
                          const isPos = !isNull && pnl >= 0;
                          const heightPct = isNull
                            ? 35
                            : Math.max(8, (Math.abs(pnl) / maxAbs) * 85);

                          return (
                            <div key={idx} className="pa-weekly-col">
                              <div
                                className={`pa-weekly-col-bar ${
                                  isNull ? "unavailable" : isPos ? "positive" : "negative"
                                }`}
                                style={{ height: `${heightPct}%` }}
                                title={`${w.weekStartDateWib} to ${w.weekEndDateWib}: ${
                                  isNull ? "PnL Unavailable" : formatUsd(pnl, true)
                                } (${w.closedPositionCount} positions)`}
                              />
                              <span className="pa-weekly-col-label">
                                {w.weekStartDateWib.slice(5)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div style={{ color: "var(--muted)", fontSize: "0.82rem", textAlign: "center", padding: "20px 0" }}>
                  No weekly realized position data available in this period
                </div>
              )}
            </div>
          </section>

          {/* ---------------------------------------------------- */}
          {/* SECTION E: TRADING BEHAVIOR */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Trading Behavior</h4>
                <p className="pa-section-subtitle">
                  Holding duration patterns, opening frequency, and WIB entry timing preferences
                </p>
              </div>
            </div>

            <div className="pa-grid-4">
              <div className="pa-card">
                <div className="pa-card-title">Average Holding Time</div>
                <div className="pa-card-value">
                  {formatDuration(metrics.tradingBehavior.avgHoldingTimeSeconds)}
                </div>
                <div className="pa-card-sub">Mean lifecycle duration</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Median Holding Time</div>
                <div className="pa-card-value">
                  {formatDuration(metrics.tradingBehavior.medianHoldingTimeSeconds)}
                </div>
                <div className="pa-card-sub">50th percentile holding duration</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Observed Entries / Day</div>
                <div className="pa-card-value">
                  {metrics.tradingBehavior.observedEntriesPerDay !== null
                    ? metrics.tradingBehavior.observedEntriesPerDay.toFixed(1)
                    : "—"}
                </div>
                <div className="pa-card-sub">Among analyzed closed positions</div>
              </div>

              <div className="pa-card">
                <div className="pa-card-title">Active Entry Days</div>
                <div className="pa-card-value">
                  {metrics.tradingBehavior.activeEntryDays}
                </div>
                <div className="pa-card-sub">
                  Coverage: {formatPct(metrics.tradingBehavior.openingTimeCoverage?.coveragePct)}
                </div>
              </div>
            </div>

            {/* Trading Behavior Charts */}
            <div className="pa-grid-3">
              {/* Hourly Activity (WIB) */}
              <div className="pa-chart-card">
                <div className="pa-chart-header">
                  <span className="pa-chart-title">Entry Activity by Hour (WIB)</span>
                </div>
                <div className="pa-bars-container" style={{ maxHeight: "280px", overflowY: "auto" }}>
                  {metrics.tradingBehavior.entryActivityByHourWib?.length > 0 ? (
                    metrics.tradingBehavior.entryActivityByHourWib
                      .filter((h) => h.count > 0)
                      .map((h) => (
                        <div key={h.hourWib} className="pa-bar-row">
                          <span className="pa-bar-label" style={{ width: "70px" }}>
                            {String(h.hourWib).padStart(2, "0")}:00
                          </span>
                          <div className="pa-bar-track">
                            <div
                              className="pa-bar-fill primary"
                              style={{ width: `${Math.min(100, Math.max(3, h.pct))}%` }}
                            />
                          </div>
                          <span className="pa-bar-value" style={{ width: "75px" }}>
                            {h.count} ({h.pct.toFixed(0)}%)
                          </span>
                        </div>
                      ))
                  ) : (
                    <div style={{ color: "var(--muted)", fontSize: "0.82rem", textAlign: "center" }}>
                      No hourly activity observed
                    </div>
                  )}
                </div>
              </div>

              {/* Weekday Activity (WIB) */}
              <div className="pa-chart-card">
                <div className="pa-chart-header">
                  <span className="pa-chart-title">Entry Activity by Weekday (WIB)</span>
                </div>
                <div className="pa-bars-container">
                  {metrics.tradingBehavior.entryActivityByWeekdayWib?.length > 0 ? (
                    metrics.tradingBehavior.entryActivityByWeekdayWib.map((w) => (
                      <div key={w.weekdayWib} className="pa-bar-row">
                        <span className="pa-bar-label" style={{ width: "85px" }}>
                          {w.weekdayWib}
                        </span>
                        <div className="pa-bar-track">
                          <div
                            className="pa-bar-fill primary"
                            style={{ width: `${Math.min(100, Math.max(3, w.pct))}%` }}
                          />
                        </div>
                        <span className="pa-bar-value">
                          {w.count} ({w.pct.toFixed(0)}%)
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "var(--muted)", fontSize: "0.82rem", textAlign: "center" }}>
                      No weekday activity observed
                    </div>
                  )}
                </div>
              </div>

              {/* Holding Time Distribution */}
              <div className="pa-chart-card">
                <div className="pa-chart-header">
                  <span className="pa-chart-title">Holding Duration</span>
                </div>
                <div className="pa-bars-container">
                  {metrics.tradingBehavior.holdingTimeDistribution?.length > 0 ? (
                    metrics.tradingBehavior.holdingTimeDistribution.map((b) => (
                      <div key={b.label} className="pa-bar-row">
                        <span className="pa-bar-label" style={{ width: "85px" }} title={b.label}>
                          {b.label}
                        </span>
                        <div className="pa-bar-track">
                          <div
                            className="pa-bar-fill primary"
                            style={{ width: `${Math.min(100, Math.max(3, b.pct))}%` }}
                          />
                        </div>
                        <span className="pa-bar-value">
                          {b.count} ({b.pct.toFixed(0)}%)
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "var(--muted)", fontSize: "0.82rem", textAlign: "center" }}>
                      No holding time buckets available
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------- */}
          {/* SECTION F: TOKEN / PAIR BREAKDOWN */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Token / Pair Breakdown</h4>
                <p className="pa-section-subtitle">
                  Aggregated performance per pair with drilldown into underlying DLMM pools
                </p>
              </div>
            </div>

            <div className="pa-table-card">
              <div className="pa-table-responsive">
                <table className="pa-table">
                  <thead>
                    <tr>
                      <th style={{ width: "40px" }}></th>
                      <th>Pair</th>
                      <th>Positions</th>
                      <th>Sample PnL USD</th>
                      <th>Win Rate</th>
                      <th>Median PnL %</th>
                      <th>Median Entry</th>
                      <th>Avg Hold Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.pairBreakdown?.length > 0 ? (
                      metrics.pairBreakdown.map((pair) => {
                        const isExpanded = expandedPairs.has(pair.pairKey);
                        const matchedPools = (metrics.poolBreakdown || []).filter(
                          (pool) =>
                            pair.pools.includes(pool.poolAddress) ||
                            (pool.pairName && pair.pairSymbol && pool.pairName === pair.pairSymbol)
                        );

                        return (
                          <div key={pair.pairKey} style={{ display: "contents" }}>
                            <tr
                              onClick={() => handleTogglePair(pair.pairKey)}
                              style={{ cursor: "pointer" }}
                              className={isExpanded ? "expanded-row" : ""}
                            >
                              <td>
                                {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              </td>
                              <td>
                                <strong>{pair.pairSymbol || pair.pairKey}</strong>
                                <span style={{ color: "var(--muted)", fontSize: "0.75rem", marginLeft: "6px" }}>
                                  ({pair.pools.length} {pair.pools.length === 1 ? "pool" : "pools"})
                                </span>
                              </td>
                              <td>{pair.closedPositionCount}</td>
                              <td
                                className={
                                  (pair.samplePnlUsd ?? 0) >= 0 ? "pa-card-value positive" : "pa-card-value negative"
                                }
                                style={{ fontSize: "0.85rem" }}
                              >
                                {formatUsd(pair.samplePnlUsd, true)}
                              </td>
                              <td>{formatPct(pair.winRate)}</td>
                              <td
                                className={
                                  (pair.medianPositionPnlPct ?? 0) >= 0 ? "positive" : "negative"
                                }
                              >
                                {formatPct(pair.medianPositionPnlPct, true)}
                              </td>
                              <td>{formatUsd(pair.medianInitialEntryUsd)}</td>
                              <td>{formatDuration(pair.avgHoldingDurationSeconds)}</td>
                            </tr>

                            {/* Per-pool drilldown when pair row expanded */}
                            {isExpanded && matchedPools.length > 0 ? (
                              <tr>
                                <td colSpan={8} style={{ padding: "0 0 12px 0" }}>
                                  <div
                                    style={{
                                      background: "rgba(0, 0, 0, 0.25)",
                                      borderLeft: "3px solid var(--green)",
                                      margin: "6px 16px",
                                      padding: "10px 14px",
                                      borderRadius: "0 6px 6px 0",
                                    }}
                                  >
                                    <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--muted)", marginBottom: "8px" }}>
                                      Pools belonging to {pair.pairSymbol || pair.pairKey}:
                                    </div>
                                    <table className="pa-table" style={{ fontSize: "0.78rem" }}>
                                      <thead>
                                        <tr>
                                          <th>Pool Address</th>
                                          <th>Positions</th>
                                          <th>PnL USD</th>
                                          <th>Win Rate</th>
                                          <th>Median PnL %</th>
                                          <th>Median Entry</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {matchedPools.map((pool) => (
                                          <tr key={pool.poolAddress}>
                                            <td style={{ fontFamily: "ui-monospace, monospace" }}>
                                              {shortAddress(pool.poolAddress)}
                                            </td>
                                            <td>{pool.closedPositionCount}</td>
                                            <td className={(pool.samplePnlUsd ?? 0) >= 0 ? "positive" : "negative"}>
                                              {formatUsd(pool.samplePnlUsd, true)}
                                            </td>
                                            <td>{formatPct(pool.winRate)}</td>
                                            <td className={(pool.medianPositionPnlPct ?? 0) >= 0 ? "positive" : "negative"}>
                                              {formatPct(pool.medianPositionPnlPct, true)}
                                            </td>
                                            <td>{formatUsd(pool.medianInitialEntryUsd)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={8} style={{ textAlign: "center", color: "var(--muted)", padding: "24px" }}>
                          No pair breakdown available
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------- */}
          {/* SECTION G: POSITIONS EXPLORER */}
          {/* ---------------------------------------------------- */}
          <section className="pa-section">
            <div className="pa-section-header">
              <div>
                <h4 className="pa-section-title">Positions Explorer</h4>
                <p className="pa-section-subtitle">
                  Inspect up to 1,000 analyzed closed positions with verifiable lifecycle event history
                </p>
              </div>
            </div>

            <div className="pa-table-card">
              {/* Explorer Toolbar: Search, Filters, Page Size */}
              <div className="pa-table-toolbar">
                <div className="pa-table-search">
                  <Search size={14} color="var(--muted)" />
                  <input
                    type="text"
                    placeholder="Search by ID, pool, pair..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>

                <div className="pa-table-filters">
                  <select
                    className="pa-select"
                    value={pairFilter}
                    onChange={(e) => {
                      setPairFilter(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="ALL">All Pairs</option>
                    {availablePairs.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>

                  <select
                    className="pa-select"
                    value={winLossFilter}
                    onChange={(e) => {
                      setWinLossFilter(e.target.value as any);
                      setPage(1);
                    }}
                  >
                    <option value="ALL">All Outcomes</option>
                    <option value="WIN">WIN</option>
                    <option value="LOSS">LOSS</option>
                    <option value="BREAKEVEN">BREAKEVEN</option>
                    <option value="UNKNOWN">UNKNOWN</option>
                  </select>

                  <select
                    className="pa-select"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={10}>10 rows</option>
                    <option value={25}>25 rows</option>
                    <option value={50}>50 rows</option>
                    <option value={100}>100 rows</option>
                  </select>
                </div>
              </div>

              {/* Explorer Table */}
              <div className="pa-table-responsive">
                <table className="pa-table">
                  <thead>
                    <tr>
                      <th style={{ width: "32px" }}></th>
                      <th onClick={() => handleSort("positionId")}>
                        Position ID {sortField === "positionId" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("pairName")}>
                        Pool / Pair {sortField === "pairName" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("openedAt")}>
                        Opened At {sortField === "openedAt" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("closedAt")}>
                        Closed At {sortField === "closedAt" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("initialEntryUsd")}>
                        Initial Entry {sortField === "initialEntryUsd" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("totalDepositsUsd")}>
                        Total Deposits {sortField === "totalDepositsUsd" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("pnlUsd")}>
                        PnL USD {sortField === "pnlUsd" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("pnlPct")}>
                        PnL % {sortField === "pnlPct" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("holdDurationSeconds")}>
                        Hold Time {sortField === "holdDurationSeconds" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                      <th onClick={() => handleSort("winLoss")}>
                        Outcome {sortField === "winLoss" ? (sortAsc ? "↑" : "↓") : ""}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedPositions.length > 0 ? (
                      paginatedPositions.map((pos) => {
                        const posKey = getPositionKey(pos.poolAddress, pos.positionId);
                        const isExpanded = expandedPositionKey === posKey;
                        const detail = positionDetails[posKey];
                        const isLoadingDetail = loadingDetailKey === posKey;

                        return (
                          <div key={posKey} style={{ display: "contents" }}>
                            <tr
                              onClick={() => handleToggleExpandPosition(pos)}
                              style={{ cursor: "pointer" }}
                              className={isExpanded ? "expanded-row" : ""}
                            >
                              <td>
                                {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              </td>
                              <td style={{ fontFamily: "ui-monospace, monospace" }}>
                                {shortAddress(pos.positionId)}
                              </td>
                              <td>
                                <strong>{pos.pairName || "Unknown"}</strong>
                              </td>
                              <td style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                                {formatWibDate(pos.openedAt)}
                              </td>
                              <td style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                                {formatWibDate(pos.closedAt)}
                              </td>
                              <td>{formatUsd(pos.initialEntryUsd)}</td>
                              <td>{formatUsd(pos.totalDepositsUsd)}</td>
                              <td
                                className={
                                  (pos.pnlUsd ?? 0) >= 0 ? "positive" : "negative"
                                }
                                style={{ fontWeight: 600 }}
                              >
                                {formatUsd(pos.pnlUsd, true)}
                              </td>
                              <td
                                className={
                                  (pos.pnlPct ?? 0) >= 0 ? "positive" : "negative"
                                }
                                style={{ fontWeight: 600 }}
                              >
                                {formatPct(pos.pnlPct, true)}
                              </td>
                              <td>{formatDuration(pos.holdDurationSeconds)}</td>
                              <td>
                                <span className={`pa-badge ${pos.winLoss.toLowerCase()}`}>
                                  {pos.winLoss}
                                </span>
                              </td>
                            </tr>

                            {/* Expanded Lifecycle Details Row */}
                            {isExpanded ? (
                              <tr>
                                <td colSpan={11} style={{ padding: 0 }}>
                                  <div className="pa-expanded-content">
                                    {isLoadingDetail ? (
                                      <div style={{ padding: "16px", color: "var(--muted)" }}>
                                        Loading lifecycle events...
                                      </div>
                                    ) : (
                                      <>
                                        <div className="pa-detail-grid">
                                          <div className="pa-detail-item">
                                            <span className="pa-detail-label">Full Position Address</span>
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                              <span className="pa-detail-val">{pos.positionId}</span>
                                              <button
                                                className="pa-btn pa-btn-secondary"
                                                style={{ padding: "2px 6px" }}
                                                onClick={() => copyToClipboard(`pos-${pos.positionId}`, pos.positionId)}
                                                title="Copy position address"
                                              >
                                                {copiedKey === `pos-${pos.positionId}` ? (
                                                  <Check size={12} color="var(--green)" />
                                                ) : (
                                                  <Copy size={12} />
                                                )}
                                              </button>
                                            </div>
                                          </div>

                                          <div className="pa-detail-item">
                                            <span className="pa-detail-label">Pool Address</span>
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                              <span className="pa-detail-val">{pos.poolAddress}</span>
                                              <button
                                                className="pa-btn pa-btn-secondary"
                                                style={{ padding: "2px 6px" }}
                                                onClick={() => copyToClipboard(`pool-${pos.poolAddress}`, pos.poolAddress)}
                                                title="Copy pool address"
                                              >
                                                {copiedKey === `pool-${pos.poolAddress}` ? (
                                                  <Check size={12} color="var(--green)" />
                                                ) : (
                                                  <Copy size={12} />
                                                )}
                                              </button>
                                            </div>
                                          </div>

                                          <div className="pa-detail-item">
                                            <span className="pa-detail-label">Verified Initial Entry Status</span>
                                            <span className="pa-detail-val" style={{ color: "var(--green)" }}>
                                              {pos.dataQuality.initialEntryStatus}
                                            </span>
                                          </div>

                                          <div className="pa-detail-item">
                                            <span className="pa-detail-label">Additional Liquidity USD</span>
                                            <span className="pa-detail-val">{formatUsd(pos.additionalLiquidityUsd)}</span>
                                          </div>

                                          <div className="pa-detail-item">
                                            <span className="pa-detail-label">Total Withdrawals USD</span>
                                            <span className="pa-detail-val">{formatUsd(pos.totalWithdrawalsUsd)}</span>
                                          </div>

                                          <div className="pa-detail-item">
                                            <span className="pa-detail-label">Claimed Fees USD</span>
                                            <span className="pa-detail-val">{formatUsd(pos.claimedFeesUsd)}</span>
                                          </div>
                                        </div>

                                        {pos.dataQuality.warnings?.length > 0 ? (
                                          <div className="pa-notice-banner warning">
                                            <AlertTriangle size={14} />
                                            <div>
                                              <strong>Data Warnings:</strong> {pos.dataQuality.warnings.join("; ")}
                                            </div>
                                          </div>
                                        ) : null}

                                        {/* Lifecycle Events Table */}
                                        <div>
                                          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--muted)", marginBottom: "4px" }}>
                                            Lifecycle Events History ({detail?.lifecycle?.events?.length ?? pos.lifecycleMeta.eventCount} events):
                                          </div>
                                          {detail?.lifecycle?.events && detail.lifecycle.events.length > 0 ? (
                                            <table className="pa-events-table">
                                              <thead>
                                                <tr>
                                                  <th>Type</th>
                                                  <th>Category</th>
                                                  <th>Timestamp (WIB)</th>
                                                  <th>Total In USD</th>
                                                  <th>Token Amounts</th>
                                                  <th>Signature</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {detail.lifecycle.events.map((evt, eIdx) => (
                                                  <tr key={evt.rawId || eIdx}>
                                                    <td>
                                                      <span className="pa-badge breakeven" style={{ fontSize: "0.72rem" }}>
                                                        {evt.rawType}
                                                      </span>
                                                    </td>
                                                    <td>{evt.category}</td>
                                                    <td>{formatWibDate(evt.createdAt)}</td>
                                                    <td>{formatUsd(evt.totalInUsd)}</td>
                                                    <td style={{ color: "var(--muted)" }}>
                                                      {evt.tokenXAmount !== null ? `${evt.tokenXAmount.toFixed(4)} X` : ""}
                                                      {evt.tokenYAmount !== null ? ` / ${evt.tokenYAmount.toFixed(4)} Y` : ""}
                                                    </td>
                                                    <td style={{ fontFamily: "ui-monospace, monospace" }}>
                                                      {shortAddress(evt.signature)}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          ) : (
                                            <div style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                                              Opening event observed: {pos.lifecycleMeta.openingEventObserved ? "Yes" : "No"} ·{" "}
                                              Closing event observed: {pos.lifecycleMeta.closingEventObserved ? "Yes" : "No"}
                                            </div>
                                          )}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={11} style={{ textAlign: "center", color: "var(--muted)", padding: "32px" }}>
                          No positions match the current filter or search criteria.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              <div className="pa-pagination">
                <div>
                  Showing {Math.min(sortedPositions.length, (page - 1) * pageSize + 1)}–
                  {Math.min(sortedPositions.length, page * pageSize)} of {sortedPositions.length} positions
                </div>
                <div className="pa-pagination-controls">
                  <button
                    className="pa-page-btn"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    Previous
                  </button>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <button
                    className="pa-page-btn"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
