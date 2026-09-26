import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Layers3,
  Loader2,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  WalletCards,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPoolScannerStatus,
  startPoolScanner,
  stopPoolScanner,
  type PoolScannerStage,
  type PoolScannerState,
  type PoolScannerStatus,
} from "../lib/poolScannerControl";
import "../pool-scanner-page.css";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface PoolScannerPageProps {
  onDatasetRefreshed?: () => void;
}

type StepStatus = "pending" | "running" | "completed" | "stopped" | "error";

interface StageItem {
  num: string;
  name: string;
  description: string;
  status: StepStatus;
}

const STAGE_LABELS: Record<string, string> = {
  idle: "Idle",
  discovery: "01 — Discover Pools",
  fabriq: "02 — Enrich Wallets",
  master_upsert: "03 — Master Upsert",
  publish: "04 — Publish Dataset",
  completed: "Completed",
  stopped: "Stopped",
  error: "Error",
};

function formatDate(value: string | null | undefined): string {
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
    second: "2-digit",
  }).format(date);
}

function computePipelineProgress(
  stage: PoolScannerStage | undefined,
  status: PoolScannerStatus | undefined,
  logs: string[],
  lastActiveStepRef: React.MutableRefObject<number>
): { stages: StageItem[]; progressPercent: number } {
  if (!status || status === "idle") {
    return {
      progressPercent: 0,
      stages: [
        {
          num: "01",
          name: "Discover Pools",
          description: "Meteora Data API · TOKEN/SOL",
          status: "pending",
        },
        {
          num: "02",
          name: "Enrich Wallets",
          description: "Top LPers · Fabriq analytics",
          status: "pending",
        },
        {
          num: "03",
          name: "Master Upsert",
          description: "Merge into master dataset",
          status: "pending",
        },
        {
          num: "04",
          name: "Publish Dataset",
          description: "Export frontend dataset",
          status: "pending",
        },
      ],
    };
  }

  let activeStep = 1;
  if (stage === "discovery") activeStep = 1;
  else if (stage === "fabriq") activeStep = 2;
  else if (stage === "master_upsert") activeStep = 3;
  else if (stage === "publish") activeStep = 4;
  else if (stage === "completed" || status === "completed") {
    activeStep = 5;
  } else {
    activeStep = lastActiveStepRef.current || 1;
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i];
      if (line.includes("[STAGE 4/4]")) {
        activeStep = 4;
        break;
      }
      if (line.includes("[STAGE 3/4]")) {
        activeStep = 3;
        break;
      }
      if (line.includes("[STAGE 2/4]")) {
        activeStep = 2;
        break;
      }
      if (line.includes("[STAGE 1/4]")) {
        activeStep = 1;
        break;
      }
    }
  }

  if (activeStep >= 1 && activeStep <= 4) {
    lastActiveStepRef.current = activeStep;
  }

  const stepPercentMap: Record<number, number> = {
    1: 25,
    2: 50,
    3: 75,
    4: 90,
    5: 100,
  };

  const progressPercent = stepPercentMap[activeStep] ?? 0;
  const isCompleted = status === "completed" || stage === "completed";
  const isStopped = status === "stopped" || stage === "stopped";
  const isError = status === "error" || stage === "error";

  function getStepStatus(stepNum: number): StepStatus {
    if (isCompleted) {
      return "completed";
    }

    if (isStopped) {
      if (stepNum < activeStep) return "completed";
      if (stepNum === activeStep) return "stopped";
      return "pending";
    }

    if (isError) {
      if (stepNum < activeStep) return "completed";
      if (stepNum === activeStep) return "error";
      return "pending";
    }

    if (stepNum < activeStep) return "completed";
    if (stepNum === activeStep) return "running";
    return "pending";
  }

  return {
    progressPercent: isCompleted ? 100 : progressPercent,
    stages: [
      {
        num: "01",
        name: "Discover Pools",
        description: "Meteora Data API · TOKEN/SOL",
        status: getStepStatus(1),
      },
      {
        num: "02",
        name: "Enrich Wallets",
        description: "Top LPers · Fabriq analytics",
        status: getStepStatus(2),
      },
      {
        num: "03",
        name: "Master Upsert",
        description: "Merge into master dataset",
        status: getStepStatus(3),
      },
      {
        num: "04",
        name: "Publish Dataset",
        description: "Export frontend dataset",
        status: getStepStatus(4),
      },
    ],
  };
}

export function PoolScannerPage({ onDatasetRefreshed }: PoolScannerPageProps) {
  const [tokenCa, setTokenCa] = useState("");
  const [state, setState] = useState<PoolScannerState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [stopModalError, setStopModalError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const prevRunningRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActiveStepRef = useRef(1);

  const cleanedToken = tokenCa.trim();

  const tokenLooksValid = useMemo(
    () => cleanedToken.length >= 32 && cleanedToken.length <= 50,
    [cleanedToken]
  );

  const isRunning = Boolean(state?.running || submitting);
  const isCompleted = state?.status === "completed" && !isRunning;
  const isStopped = state?.status === "stopped" && !isRunning;
  const isError = (state?.status === "error" || Boolean(apiError)) && !isRunning;

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getPoolScannerStatus();
      setState(s);
      setApiError(null);
      return s;
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    let mounted = true;

    async function initialLoad() {
      const s = await fetchStatus();
      if (mounted && s?.tokenCa) {
        setTokenCa((prev) => (prev ? prev : s.tokenCa!));
      }
    }

    initialLoad();

    return () => {
      mounted = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [fetchStatus]);

  // Polling loop while running
  useEffect(() => {
    if (!state?.running) {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    const timer = setTimeout(async () => {
      await fetchStatus();
    }, 1500);

    pollTimerRef.current = timer;

    return () => {
      clearTimeout(timer);
    };
  }, [state?.running, state?.logs?.length, fetchStatus]);

  // Call onDatasetRefreshed exactly once when transitioning running -> completed
  useEffect(() => {
    const runningNow = Boolean(state?.running);
    if (prevRunningRef.current && !runningNow && state?.status === "completed") {
      onDatasetRefreshed?.();
    }
    prevRunningRef.current = runningNow;
  }, [state?.running, state?.status, onDatasetRefreshed]);

  // Auto-scroll logs to bottom while running and logs are expanded
  useEffect(() => {
    if (state?.running && logsExpanded && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [state?.logs, state?.running, logsExpanded]);

  // Handle Escape key to close stop confirmation modal
  useEffect(() => {
    if (!showStopModal) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !stopping) {
        setShowStopModal(false);
        setStopModalError(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showStopModal, stopping]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tokenLooksValid || isRunning || submitting) {
      return;
    }

    setSubmitting(true);
    setApiError(null);
    lastActiveStepRef.current = 1;

    try {
      const s = await startPoolScanner(cleanedToken);
      setState(s);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenStopModal() {
    if (!isRunning || stopping) return;
    setStopModalError(null);
    setShowStopModal(true);
  }

  function handleCloseStopModal() {
    if (stopping) return;
    setShowStopModal(false);
    setStopModalError(null);
  }

  async function handleConfirmStop() {
    if (stopping) return;
    setStopping(true);
    setStopModalError(null);

    try {
      const s = await stopPoolScanner();
      setState(s);
      setShowStopModal(false);
    } catch (err) {
      setStopModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  function handleCopyLogs() {
    if (!state?.logs?.length) return;
    navigator.clipboard.writeText(state.logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const { stages, progressPercent } = useMemo(
    () =>
      computePipelineProgress(
        state?.stage,
        state?.status,
        state?.logs || [],
        lastActiveStepRef
      ),
    [state?.stage, state?.status, state?.logs]
  );

  let heroBadgeText = "Scanner ready";
  let heroBadgeClass = "pool-scanner-hero-badge";
  if (isRunning) {
    heroBadgeText = "Scanner running";
    heroBadgeClass = "pool-scanner-hero-badge running";
  } else if (isCompleted) {
    heroBadgeText = "Scan completed";
    heroBadgeClass = "pool-scanner-hero-badge completed";
  } else if (isStopped) {
    heroBadgeText = "Scan stopped";
    heroBadgeClass = "pool-scanner-hero-badge stopped";
  } else if (isError) {
    heroBadgeText = "Scan failed";
    heroBadgeClass = "pool-scanner-hero-badge error";
  }

  let statusUi: "Ready" | "Running" | "Completed" | "Stopped" | "Error" = "Ready";
  if (isRunning) {
    statusUi = "Running";
  } else if (state?.status === "completed") {
    statusUi = "Completed";
  } else if (state?.status === "stopped") {
    statusUi = "Stopped";
  } else if (state?.status === "error" || Boolean(apiError)) {
    statusUi = "Error";
  } else {
    statusUi = "Ready";
  }

  const activeTokenCa = state?.tokenCa || (isRunning ? cleanedToken : null);

  return (
    <div className="pool-scanner-page">
      <section className="pool-scanner-hero">
        <div>
          <div className="pool-scanner-kicker">
            <Radar size={13} />
            METEORA DLMM DISCOVERY
          </div>
          <h1>Pool Scanner</h1>
          <p>
            Discover every TOKEN/SOL Meteora pool, collect Top LPers, enrich
            wallets, and prepare them for the main scanner dataset.
          </p>
        </div>

        <div className={heroBadgeClass}>
          {isRunning ? (
            <span className="pool-scanner-live-dot pulse" />
          ) : isCompleted ? (
            <CheckCircle2 size={13} className="hero-badge-icon success" />
          ) : isStopped ? (
            <Square size={13} className="hero-badge-icon stopped" />
          ) : isError ? (
            <XCircle size={13} className="hero-badge-icon error" />
          ) : (
            <span className="pool-scanner-live-dot" />
          )}
          {heroBadgeText}
        </div>
      </section>

      <div className="pool-scanner-layout">
        <section className="pool-scanner-main-card">
          <div className="pool-scanner-card-head">
            <div className="pool-scanner-icon-box">
              <ScanSearch size={20} />
            </div>
            <div>
              <h2>Scan a token</h2>
              <p>Enter a Solana token contract address to begin discovery.</p>
            </div>
          </div>

          <form className="pool-scanner-form" onSubmit={handleSubmit}>
            <label htmlFor="pool-scanner-token">TOKEN CONTRACT ADDRESS</label>
            <div
              className={`pool-scanner-input-wrap ${tokenLooksValid ? "valid" : ""} ${
                isRunning ? "disabled" : ""
              }`}
            >
              <input
                id="pool-scanner-token"
                value={tokenCa}
                onChange={(event) => setTokenCa(event.target.value)}
                placeholder="Enter token CA..."
                spellCheck={false}
                autoComplete="off"
                disabled={isRunning}
              />
              {cleanedToken && !isRunning ? (
                <button
                  type="button"
                  className="pool-scanner-clear"
                  onClick={() => setTokenCa("")}
                >
                  Clear
                </button>
              ) : null}
            </div>

            <div className="pool-scanner-input-meta">
              <span>
                Pair filter: <strong>TOKEN / SOL only</strong>
              </span>
              <span className="pool-scanner-sol-mint" title={SOL_MINT}>
                SOL mint verified
              </span>
            </div>

            <button
              type="submit"
              className="pool-scanner-start"
              disabled={!tokenLooksValid || isRunning}
            >
              {isRunning ? (
                <>
                  <Loader2 size={17} className="spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <ScanSearch size={17} />
                  Start Pool Scan
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {apiError || (state?.status === "error" && state.error) ? (
            <div className="pool-scanner-error-banner">
              <AlertCircle size={16} />
              <div>
                <strong>Pipeline Error</strong>
                <span>{apiError || state?.error}</span>
              </div>
            </div>
          ) : null}

          <div className="pool-scanner-note">
            <ShieldCheck size={16} />
            <div>
              <strong>Exact mint filtering</strong>
              <span>
                Only pools whose token mints exactly match TOKEN ↔ native SOL
                are accepted. USDC, swSOL, and token/token pools are excluded.
              </span>
            </div>
          </div>
        </section>

        <aside className="pool-scanner-side-card">
          <div className="pool-scanner-side-head">
            <span>PIPELINE</span>
            <strong>Discovery flow</strong>
          </div>

          <div className="pool-scanner-flow">
            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">01</span>
              <div className="pool-scanner-flow-icon">
                <Layers3 size={16} />
              </div>
              <div>
                <strong>Discover pools</strong>
                <span>Meteora Data API</span>
              </div>
            </div>

            <div className="pool-scanner-flow-line" />

            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">02</span>
              <div className="pool-scanner-flow-icon">
                <WalletCards size={16} />
              </div>
              <div>
                <strong>Collect Top LPers</strong>
                <span>LP Agent · owner only</span>
              </div>
            </div>

            <div className="pool-scanner-flow-line" />

            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">03</span>
              <div className="pool-scanner-flow-icon">
                <Sparkles size={16} />
              </div>
              <div>
                <strong>Enrich wallets</strong>
                <span>Fabriq analytics</span>
              </div>
            </div>

            <div className="pool-scanner-flow-line" />

            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">04</span>
              <div className="pool-scanner-flow-icon">
                <Database size={16} />
              </div>
              <div>
                <strong>Publish dataset</strong>
                <span>Master DB → frontend</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Primary Pipeline Progress Section */}
      <section className="pool-scanner-progress-section">
        {/* Compact Status Summary Bar */}
        <div className="pool-scanner-meta-bar">
          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">STATUS</span>
            <div className="status-with-actions">
              <span className={`pool-scanner-status-pill ${statusUi.toLowerCase()}`}>
                {isRunning && <span className="status-pill-dot" />}
                {statusUi}
              </span>
              {isRunning ? (
                <button
                  type="button"
                  className="pool-scanner-stop-btn"
                  onClick={handleOpenStopModal}
                  disabled={stopping}
                  title="Stop the current Pool Scanner pipeline"
                >
                  <Square size={11} fill="currentColor" />
                  Stop Scan
                </button>
              ) : null}
            </div>
          </div>

          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">TOKEN</span>
            <span
              className="pool-scanner-meta-value mono"
              title={activeTokenCa || ""}
            >
              {activeTokenCa
                ? `${activeTokenCa.slice(0, 8)}...${activeTokenCa.slice(-8)}`
                : "—"}
            </span>
          </div>

          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">STARTED</span>
            <span className="pool-scanner-meta-value">
              {formatDate(state?.startedAt)}
            </span>
          </div>

          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">FINISHED</span>
            <span className="pool-scanner-meta-value">
              {state?.finishedAt ? formatDate(state.finishedAt) : "—"}
            </span>
          </div>
        </div>

        {/* Primary Stage Progress Display */}
        <div className="pool-scanner-progress-card">
          <div className="pool-scanner-progress-header">
            <div className="progress-header-title">
              <Layers3 size={15} />
              <span>PIPELINE PROGRESS</span>
            </div>
            <div className="progress-header-stage">
              Current stage:{" "}
              <strong>
                {isCompleted
                  ? "Completed"
                  : isStopped
                  ? "Stopped"
                  : isError
                  ? "Error"
                  : isRunning
                  ? state?.stage || "Running"
                  : "Ready"}
              </strong>
            </div>
          </div>

          {/* Horizontal Overall Progress Bar */}
          <div className="pool-scanner-overall-progress">
            <div className="progress-bar-meta">
              <span className="progress-bar-label">OVERALL COMPLETION</span>
              <span className="progress-bar-value">{progressPercent}%</span>
            </div>
            <div className="progress-bar-track">
              <div
                className={`progress-bar-fill ${statusUi.toLowerCase()}`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* 4 Pipeline Stages */}
          <div className="pool-scanner-stages-grid">
            {stages.map((st) => (
              <div
                key={st.num}
                className={`pool-scanner-stage-card ${st.status}`}
              >
                <div className="stage-card-top">
                  <span className="stage-card-num">{st.num}</span>
                  <div className={`stage-state-badge ${st.status}`}>
                    {st.status === "completed" ? (
                      <>
                        <CheckCircle2 size={12} />
                        <span>Completed</span>
                      </>
                    ) : st.status === "running" ? (
                      <>
                        <Loader2 size={12} className="spin" />
                        <span>Running</span>
                      </>
                    ) : st.status === "stopped" ? (
                      <>
                        <Square size={10} fill="currentColor" />
                        <span>Stopped</span>
                      </>
                    ) : st.status === "error" ? (
                      <>
                        <XCircle size={12} />
                        <span>Error</span>
                      </>
                    ) : (
                      <>
                        <Clock size={12} />
                        <span>Pending</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="stage-card-body">
                  <strong>{st.name}</strong>
                  <p>{st.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Collapsible Live Logs Section */}
        <div className="pool-scanner-logs-section">
          <div className="pool-scanner-logs-toggle-row">
            <button
              type="button"
              className="pool-scanner-logs-toggle-btn"
              onClick={() => setLogsExpanded((v) => !v)}
            >
              <Terminal size={14} />
              <span>{logsExpanded ? "Hide Live Logs" : "Show Live Logs"}</span>
              <span className="logs-count-badge">
                {state?.logs?.length || 0} lines
              </span>
              {isRunning ? (
                <span className="logs-live-badge">
                  <span className="pool-scanner-live-dot pulse" />
                  LIVE
                </span>
              ) : null}
            </button>
          </div>

          {logsExpanded ? (
            <div className="pool-scanner-terminal-card">
              <div className="pool-scanner-terminal-header">
                <div className="terminal-header-title">
                  <Terminal size={15} />
                  <span>LIVE PIPELINE LOGS</span>
                  <span className="terminal-log-count">
                    {state?.logs?.length || 0} lines
                  </span>
                </div>

                {state?.logs && state.logs.length > 0 ? (
                  <button
                    type="button"
                    className="terminal-copy-btn"
                    onClick={handleCopyLogs}
                    title="Copy all logs"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "Copied" : "Copy logs"}
                  </button>
                ) : null}
              </div>

              <div
                className="pool-scanner-terminal-body"
                ref={logsContainerRef}
              >
                {state?.logs && state.logs.length > 0 ? (
                  state.logs.map((log, index) => {
                    let lineClass = "pool-scanner-log-line";
                    if (
                      log.includes("[FAIL]") ||
                      log.includes("FAILED") ||
                      log.includes("Error:") ||
                      log.includes("error:")
                    ) {
                      lineClass += " log-error";
                    } else if (
                      log.includes("[OK]") ||
                      log.includes("COMPLETE") ||
                      log.includes("Success")
                    ) {
                      lineClass += " log-success";
                    } else if (
                      log.includes("[STAGE") ||
                      log.includes("POOL ")
                    ) {
                      lineClass += " log-stage";
                    }

                    return (
                      <div key={index} className={lineClass}>
                        <span className="log-line-num">
                          {String(index + 1).padStart(3, "0")}
                        </span>
                        <span className="log-line-text">{log}</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="pool-scanner-terminal-empty">
                    <Terminal size={20} />
                    <span>No logs available yet.</span>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="pool-scanner-info-grid">
        <article>
          <span className="pool-scanner-info-label">POOL POLICY</span>
          <strong>Exact TOKEN ↔ SOL</strong>
          <p>Pool matching is based on mint addresses, never token symbols.</p>
        </article>

        <article>
          <span className="pool-scanner-info-label">WALLET SOURCE</span>
          <strong>Top LPers</strong>
          <p>Only <code>data[].owner</code> is retained from LP Agent.</p>
        </article>

        <article>
          <span className="pool-scanner-info-label">DEDUPLICATION</span>
          <strong>Global across pools</strong>
          <p>The same wallet discovered in multiple pools is stored once.</p>
        </article>

        <article>
          <span className="pool-scanner-info-label">OUTPUT</span>
          <strong>Scanner dataset</strong>
          <p>Enriched wallets are merged into master data and published.</p>
        </article>
      </section>

      {/* Custom Stop Confirmation Modal */}
      {showStopModal ? (
        <div className="pool-scanner-modal-overlay" onClick={handleCloseStopModal}>
          <div
            className="pool-scanner-modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="stop-modal-title"
          >
            <div className="pool-scanner-modal-header">
              <div className="pool-scanner-modal-icon-box">
                <AlertCircle size={18} />
              </div>
              <div>
                <h3 id="stop-modal-title">Stop Pool Scanner?</h3>
                <p className="pool-scanner-modal-desc">
                  Stopping now will terminate the current pipeline. Any
                  unfinished stages will not continue.
                </p>
              </div>
            </div>

            <div className="pool-scanner-modal-meta">
              <span className="pool-scanner-modal-meta-label">CURRENT STAGE</span>
              <span className="pool-scanner-modal-meta-value">
                {STAGE_LABELS[state?.stage || ""] || state?.stage || "Running"}
              </span>
            </div>

            {stopModalError ? (
              <div className="pool-scanner-modal-error">
                <AlertCircle size={14} />
                <span>{stopModalError}</span>
              </div>
            ) : null}

            <div className="pool-scanner-modal-actions">
              <button
                type="button"
                className="pool-scanner-modal-btn cancel"
                onClick={handleCloseStopModal}
                disabled={stopping}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pool-scanner-modal-btn danger"
                onClick={handleConfirmStop}
                disabled={stopping}
              >
                {stopping ? (
                  <>
                    <Loader2 size={13} className="spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square size={11} fill="currentColor" />
                    Stop Scan
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
