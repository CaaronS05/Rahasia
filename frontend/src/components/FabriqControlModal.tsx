import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Database,
  ExternalLink,
  Layers,
  Play,
  RefreshCw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type FabriqMode,
  type FabriqState,
  getFabriqStatus,
  resumeFabriqRefresh,
  startFabriqRefresh,
  stopFabriqRefresh,
  subscribeFabriqEvents,
} from "../lib/fabriqControl";
import {
  type LpAgentState,
  getLpAgentStatus,
  startLpAgentRefresh,
  stopLpAgentRefresh,
} from "../lib/lpAgentControl";

interface FabriqControlModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletCount: number;
  lastUpdated: string | null;
  onDatasetRefreshed: () => void;
}

function formatRuntime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatLastUpdatedDate(value: string | null): string {
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

export function FabriqControlModal({
  isOpen,
  onClose,
  walletCount,
  lastUpdated,
  onDatasetRefreshed,
}: FabriqControlModalProps) {
  // Fabriq State
  const [state, setState] = useState<FabriqState | null>(null);
  const [mode, setMode] = useState<FabriqMode>("stale");
  const [concurrency, setConcurrency] = useState<number>(10);

  // LP Agent State
  const [lpAgentState, setLpAgentState] = useState<LpAgentState | null>(null);
  const [lpConcurrency, setLpConcurrency] = useState<number>(5);
  const [lpFabriqConcurrency, setLpFabriqConcurrency] = useState<number>(10);

  // UI State
  const [showLogs, setShowLogs] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const prevFabriqStatusRef = useRef<string | null>(null);
  const prevLpStatusRef = useRef<string | null>(null);

  // 1. Subscribe to Fabriq SSE events & initial fetch
  useEffect(() => {
    let isMounted = true;

    getFabriqStatus()
      .then((initialState) => {
        if (isMounted) {
          setState(initialState);
          if (initialState.concurrency) {
            setConcurrency(initialState.concurrency);
          }
          if (initialState.mode) {
            setMode(initialState.mode);
          }
        }
      })
      .catch(() => {});

    const unsubscribe = subscribeFabriqEvents(
      (event) => {
        if (!isMounted) return;
        setState(event.state);

        if (
          event.state.status === "completed" &&
          prevFabriqStatusRef.current !== "completed"
        ) {
          onDatasetRefreshed();
        }
        prevFabriqStatusRef.current = event.state.status;
      },
      () => {
        getFabriqStatus()
          .then((s) => {
            if (isMounted) setState(s);
          })
          .catch(() => {});
      }
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [onDatasetRefreshed]);

  // 2. Poll LP Agent status
  useEffect(() => {
    let isMounted = true;

    const fetchLpStatus = () => {
      getLpAgentStatus()
        .then((s) => {
          if (!isMounted) return;
          setLpAgentState(s);

          if (
            s.status === "completed" &&
            prevLpStatusRef.current !== "completed"
          ) {
            onDatasetRefreshed();
          }
          prevLpStatusRef.current = s.status;
        })
        .catch(() => {});
    };

    fetchLpStatus();

    const interval = setInterval(fetchLpStatus, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [onDatasetRefreshed]);

  // 3. Auto-scroll logs
  const logsCount = (lpAgentState?.logs.length ?? 0) + (state?.logs.length ?? 0);
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollTop = logsEndRef.current.scrollHeight;
    }
  }, [showLogs, logsCount]);

  // Early return ONLY after all hooks
  if (!isOpen) {
    return null;
  }

  // Derived state for Fabriq
  const isFabriqRunning =
    state?.status === "running" || state?.status === "stopping";
  const isFabriqStopping = state?.status === "stopping";
  const isFabriqStopped = state?.status === "stopped";
  const isFabriqCompleted = state?.status === "completed";
  const isFabriqError = state?.status === "error";

  // Derived state for LP Agent
  const isLpRunning =
    lpAgentState?.status === "running" || lpAgentState?.status === "stopping";
  const isLpStopping = lpAgentState?.status === "stopping";
  const isLpStopped = lpAgentState?.status === "stopped";
  const isLpCompleted = lpAgentState?.status === "completed";
  const isLpError = lpAgentState?.status === "error";

  const isAnyRunning = isFabriqRunning || isLpRunning;

  // Active view determination
  let currentView: "idle" | "lp_running" | "lp_stopped" | "lp_completed" | "lp_error" | "fabriq_running" | "fabriq_stopped" | "fabriq_completed" | "fabriq_error" = "idle";

  if (isLpRunning) currentView = "lp_running";
  else if (isLpStopping) currentView = "lp_running";
  else if (isLpStopped) currentView = "lp_stopped";
  else if (isLpCompleted) currentView = "lp_completed";
  else if (isLpError) currentView = "lp_error";
  else if (isFabriqRunning) currentView = "fabriq_running";
  else if (isFabriqStopping) currentView = "fabriq_running";
  else if (isFabriqStopped) currentView = "fabriq_stopped";
  else if (isFabriqCompleted) currentView = "fabriq_completed";
  else if (isFabriqError) currentView = "fabriq_error";

  // Header Title & Badge
  let modalTitle = "Update Wallet Data";
  let stageBadgeText = "Idle";

  if (isLpRunning) {
    modalTitle = "Updating Wallet List";
    if (isLpStopping) stageBadgeText = "Stopping LP Agent...";
    else if (lpAgentState?.stage === "scrape") stageBadgeText = "Scraping LP Agent...";
    else if (lpAgentState?.stage === "merge_wallets") stageBadgeText = "Merging Wallets...";
    else if (lpAgentState?.stage === "fabriq_enrich") stageBadgeText = "Enriching Fabriq...";
    else if (lpAgentState?.stage === "fabriq_merge") stageBadgeText = "Merging Fabriq...";
    else if (lpAgentState?.stage === "publish") stageBadgeText = "Publishing Frontend...";
    else stageBadgeText = "Running";
  } else if (isLpStopped) {
    modalTitle = "Update Wallet List";
    stageBadgeText = "Stopped";
  } else if (isLpCompleted) {
    modalTitle = "Wallet List Updated";
    stageBadgeText = "Completed";
  } else if (isLpError) {
    modalTitle = "Update Failed";
    stageBadgeText = "Failed";
  } else if (isFabriqRunning) {
    modalTitle = "Updating Fabriq";
    if (isFabriqStopping) stageBadgeText = "Stopping Fabriq...";
    else if (state?.stage === "enrich") stageBadgeText = "Enriching Wallets...";
    else if (state?.stage === "merge") stageBadgeText = "Merging Master...";
    else if (state?.stage === "publish") stageBadgeText = "Publishing...";
    else stageBadgeText = "Running";
  } else if (isFabriqStopped) {
    modalTitle = "Update Wallet Data";
    stageBadgeText = "Stopped";
  } else if (isFabriqCompleted) {
    modalTitle = "Update Completed";
    stageBadgeText = "Completed";
  } else if (isFabriqError) {
    modalTitle = "Update Failed";
    stageBadgeText = "Failed";
  }

  // Handlers for LP Agent
  const handleStartLp = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await startLpAgentRefresh({
        concurrency: lpConcurrency,
        fabriqConcurrency: lpFabriqConcurrency,
      });
      setLpAgentState(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopLp = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await stopLpAgentRefresh();
      setLpAgentState(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  // Handlers for Fabriq
  const handleStartFabriq = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const nextState = await startFabriqRefresh({
        mode,
        concurrency,
      });
      setState(nextState);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopFabriq = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const nextState = await stopFabriqRefresh();
      setState(nextState);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleResumeFabriq = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const nextState = await resumeFabriqRefresh({
        concurrency,
      });
      setState(nextState);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  // Active logs stream
  const activeLogs = isLpRunning || isLpStopped || isLpCompleted || isLpError
    ? (lpAgentState?.logs ?? [])
    : (state?.logs ?? []);

  // Fabriq progress calculation
  const fabriqTotal = state?.total || walletCount || 1458;
  const fabriqCompleted = state?.completed || 0;
  const fabriqProgressPercent = fabriqTotal > 0 ? Math.min(100, Math.round((fabriqCompleted / fabriqTotal) * 100)) : 0;

  return (
    <div className="fabriq-modal-backdrop" onClick={onClose}>
      <div
        className="fabriq-modal-dialog modal-wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Modal Header */}
        <div className="fabriq-modal-header">
          <div className="fabriq-modal-title-group">
            <div className="fabriq-brand-icon">
              <Database size={18} />
            </div>
            <div>
              <div className="fabriq-modal-title">{modalTitle}</div>
              <div className="fabriq-modal-subtitle">
                Automated LP Agent & Fabriq dataset update pipeline
              </div>
            </div>
          </div>

          <div className="fabriq-modal-header-actions">
            <span className={`fabriq-status-pill status-${isAnyRunning ? "running" : currentView.includes("stopped") ? "stopped" : currentView.includes("completed") ? "completed" : currentView.includes("error") ? "error" : "idle"}`}>
              {isAnyRunning && <span className="status-dot-pulse" />}
              {stageBadgeText}
            </span>

            <button
              className="fabriq-modal-close"
              onClick={onClose}
              title="Close modal (processes keep running in background)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="fabriq-modal-body">
          {actionError && (
            <div className="fabriq-alert-banner alert-error">
              <AlertCircle size={16} />
              <span>{actionError}</span>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: LP AGENT RUNNING                                    */}
          {/* ======================================================== */}
          {currentView === "lp_running" && (
            <div className="fabriq-running-section">
              {/* Stepper (5 stages) */}
              <div className="fabriq-stepper stepper-5">
                <div
                  className={`fabriq-step ${lpAgentState?.stage === "scrape" ? "active" : "done"}`}
                >
                  <span className="step-circle">
                    {lpAgentState?.stage === "scrape" ? <RefreshCw size={11} className="spin" /> : "1"}
                  </span>
                  <span className="step-label">LP Agent</span>
                </div>
                <div className="step-connector" />

                <div
                  className={`fabriq-step ${lpAgentState?.stage === "merge_wallets" ? "active" : lpAgentState?.stage === "scrape" ? "" : "done"}`}
                >
                  <span className="step-circle">
                    {lpAgentState?.stage === "merge_wallets" ? <RefreshCw size={11} className="spin" /> : "2"}
                  </span>
                  <span className="step-label">Merge Wallets</span>
                </div>
                <div className="step-connector" />

                <div
                  className={`fabriq-step ${lpAgentState?.stage === "fabriq_enrich" ? "active" : ["fabriq_merge", "publish", "completed"].includes(lpAgentState?.stage ?? "") ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {lpAgentState?.stage === "fabriq_enrich" ? <RefreshCw size={11} className="spin" /> : "3"}
                  </span>
                  <span className="step-label">Fabriq Enrich</span>
                </div>
                <div className="step-connector" />

                <div
                  className={`fabriq-step ${lpAgentState?.stage === "fabriq_merge" ? "active" : ["publish", "completed"].includes(lpAgentState?.stage ?? "") ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {lpAgentState?.stage === "fabriq_merge" ? <RefreshCw size={11} className="spin" /> : "4"}
                  </span>
                  <span className="step-label">Merge Fabriq</span>
                </div>
                <div className="step-connector" />

                <div
                  className={`fabriq-step ${lpAgentState?.stage === "publish" ? "active" : lpAgentState?.stage === "completed" ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {lpAgentState?.stage === "publish" ? <RefreshCw size={11} className="spin" /> : "5"}
                  </span>
                  <span className="step-label">Publish</span>
                </div>
              </div>

              {/* Stage-specific Progress */}
              {lpAgentState?.stage === "scrape" && (
                <>
                  <div className="fabriq-progress-header">
                    <div className="fabriq-progress-count">
                      {lpAgentState.totalPages > 0 ? (
                        <>
                          <strong>{lpAgentState.completedPages}</strong> / {lpAgentState.totalPages} pages captured
                        </>
                      ) : (
                        "Detecting pages from LP Agent..."
                      )}
                    </div>
                    <div className="fabriq-progress-percent">
                      {lpAgentState.totalPages > 0 ? `${lpAgentState.progressPercent}%` : "—"}
                    </div>
                  </div>

                  <div className="fabriq-progress-track">
                    <div
                      className={`fabriq-progress-fill ${lpAgentState.totalPages === 0 ? "indeterminate" : ""}`}
                      style={{ width: `${Math.max(5, lpAgentState.progressPercent)}%` }}
                    />
                  </div>

                  <div className="fabriq-stats-grid">
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Wallets Found</div>
                      <div className="stat-val text-green">
                        {(lpAgentState.wallets ?? 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="fabriq-stat-card">
                      <div className="stat-label">LP Workers</div>
                      <div className="stat-val text-amber">{lpAgentState.concurrency}</div>
                    </div>
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Runtime</div>
                      <div className="stat-val text-text">
                        {formatRuntime(lpAgentState.runtimeSeconds ?? 0)}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {lpAgentState?.stage === "merge_wallets" && (
                <>
                  <div className="fabriq-progress-header">
                    <div className="fabriq-progress-count">
                      Merging <strong>{(lpAgentState.wallets ?? 0).toLocaleString()}</strong> scanned wallets into master dataset...
                    </div>
                  </div>
                  <div className="fabriq-progress-track">
                    <div className="fabriq-progress-fill indeterminate" />
                  </div>
                  <div className="fabriq-stats-grid">
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Scanned Wallets</div>
                      <div className="stat-val text-green">{lpAgentState.wallets}</div>
                    </div>
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Runtime</div>
                      <div className="stat-val text-text">
                        {formatRuntime(lpAgentState.runtimeSeconds ?? 0)}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {lpAgentState?.stage === "fabriq_enrich" && (
                <>
                  <div className="fabriq-progress-header">
                    <div className="fabriq-progress-count">
                      Enriching missing & stale wallets with Fabriq...
                    </div>
                    <div className="fabriq-progress-percent">
                      {lpAgentState.fabriqTotal > 0
                        ? `${Math.min(100, Math.round((lpAgentState.fabriqCompleted / lpAgentState.fabriqTotal) * 100))}%`
                        : "—"}
                    </div>
                  </div>

                  <div className="fabriq-progress-track">
                    <div
                      className={`fabriq-progress-fill ${lpAgentState.fabriqTotal === 0 ? "indeterminate" : ""}`}
                      style={{
                        width: lpAgentState.fabriqTotal > 0
                          ? `${Math.max(5, Math.round((lpAgentState.fabriqCompleted / lpAgentState.fabriqTotal) * 100))}%`
                          : "30%",
                      }}
                    />
                  </div>

                  <div className="fabriq-stats-grid">
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Success</div>
                      <div className="stat-val text-green">{lpAgentState.fabriqSuccess}</div>
                    </div>
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Skipped</div>
                      <div className="stat-val text-muted">{lpAgentState.fabriqSkipped}</div>
                    </div>
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Failed</div>
                      <div className={`stat-val ${lpAgentState.fabriqFailed ? "text-red" : "text-muted"}`}>
                        {lpAgentState.fabriqFailed}
                      </div>
                    </div>
                    <div className="fabriq-stat-card">
                      <div className="stat-label">Fabriq Workers</div>
                      <div className="stat-val text-amber">{lpAgentState.fabriqConcurrency}</div>
                    </div>
                  </div>
                </>
              )}

              {lpAgentState?.stage === "fabriq_merge" && (
                <>
                  <div className="fabriq-progress-header">
                    <div className="fabriq-progress-count">
                      Merging Fabriq analytics into master dataset...
                    </div>
                  </div>
                  <div className="fabriq-progress-track">
                    <div className="fabriq-progress-fill indeterminate" />
                  </div>
                </>
              )}

              {lpAgentState?.stage === "publish" && (
                <>
                  <div className="fabriq-progress-header">
                    <div className="fabriq-progress-count">
                      Publishing frontend wallet dataset...
                    </div>
                  </div>
                  <div className="fabriq-progress-track">
                    <div className="fabriq-progress-fill indeterminate" />
                  </div>
                </>
              )}

              {/* Stop Button */}
              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-danger"
                  onClick={handleStopLp}
                  disabled={actionLoading || isLpStopping}
                >
                  {isLpStopping ? (
                    <>
                      <RefreshCw size={14} className="spin" /> Stopping Pipeline...
                    </>
                  ) : (
                    <>
                      <Square size={14} /> Stop Update
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: LP AGENT STOPPED                                   */}
          {/* ======================================================== */}
          {currentView === "lp_stopped" && (
            <div className="fabriq-stopped-section">
              <div className="fabriq-alert-banner alert-warning">
                <AlertCircle size={16} />
                <span>
                  Update stopped. LP Agent checkpoint is preserved. Starting Update Wallet List again
                  will automatically resume already completed scrape pages.
                </span>
              </div>

              <div className="fabriq-stats-grid">
                <div className="fabriq-stat-card">
                  <div className="stat-label">Completed Pages</div>
                  <div className="stat-val text-text">
                    {lpAgentState?.completedPages} / {lpAgentState?.totalPages || "?"}
                  </div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Wallets Scraped</div>
                  <div className="stat-val text-green">{lpAgentState?.wallets}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Runtime</div>
                  <div className="stat-val text-text">
                    {formatRuntime(lpAgentState?.runtimeSeconds ?? 0)}
                  </div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleStartLp}
                  disabled={actionLoading}
                >
                  <Play size={14} /> Resume / Start Update
                </button>
                <button className="fabriq-btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: LP AGENT COMPLETED                                 */}
          {/* ======================================================== */}
          {currentView === "lp_completed" && (
            <div className="fabriq-completed-section">
              <div className="fabriq-alert-banner alert-success">
                <CheckCircle2 size={18} />
                <div>
                  <strong>Wallet List Updated Successfully</strong>
                  <div>
                    Frontend dataset published. Scraped {(lpAgentState?.wallets ?? 0).toLocaleString()} wallets,
                    enriched with Fabriq and synced to master dataset.
                  </div>
                </div>
              </div>

              <div className="fabriq-stats-grid">
                <div className="fabriq-stat-card">
                  <div className="stat-label">Scanned Wallets</div>
                  <div className="stat-val text-green">{lpAgentState?.wallets}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Unique Incoming</div>
                  <div className="stat-val text-text">{lpAgentState?.uniqueIncoming}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Updated Existing</div>
                  <div className="stat-val text-amber">{lpAgentState?.updatedExisting}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Added New</div>
                  <div className="stat-val text-green">{lpAgentState?.addedNew}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Master Wallets</div>
                  <div className="stat-val text-text">{lpAgentState?.masterWallets}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Fabriq Success</div>
                  <div className="stat-val text-green">{lpAgentState?.fabriqSuccess}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Fabriq Failed</div>
                  <div className="stat-val text-muted">{lpAgentState?.fabriqFailed ?? 0}</div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-secondary"
                  onClick={() => {
                    setLpAgentState((prev) => (prev ? { ...prev, status: "idle", stage: "idle" } : null));
                  }}
                >
                  Configure New Run
                </button>
                <button className="fabriq-btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: LP AGENT ERROR                                     */}
          {/* ======================================================== */}
          {currentView === "lp_error" && (
            <div className="fabriq-error-section">
              <div className="fabriq-alert-banner alert-error">
                <AlertCircle size={18} />
                <div>
                  <strong>Update Failed at Stage: {lpAgentState?.stage ?? "unknown"}</strong>
                  <div>{lpAgentState?.error || "An error occurred during pipeline execution."}</div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleStartLp}
                  disabled={actionLoading}
                >
                  <RefreshCw size={14} /> Retry Update
                </button>
                <button className="fabriq-btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: FABRIQ RUNNING                                     */}
          {/* ======================================================== */}
          {currentView === "fabriq_running" && (
            <div className="fabriq-running-section">
              <div className="fabriq-progress-header">
                <div className="fabriq-progress-count">
                  {state?.total ? (
                    <>
                      <strong>{state.completed.toLocaleString()}</strong> / {state.total.toLocaleString()} wallets
                    </>
                  ) : (
                    "Preparing Fabriq update..."
                  )}
                </div>
                <div className="fabriq-progress-percent">
                  {state?.total ? `${fabriqProgressPercent}%` : "—"}
                </div>
              </div>

              <div className="fabriq-progress-track">
                <div
                  className={`fabriq-progress-fill ${!state?.total ? "indeterminate" : ""}`}
                  style={{ width: `${Math.max(5, fabriqProgressPercent)}%` }}
                />
              </div>

              <div className="fabriq-stepper">
                <div
                  className={`fabriq-step ${state?.stage === "enrich" ? "active" : ["merge", "publish", "completed"].includes(state?.stage ?? "") ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {state?.stage === "enrich" ? <RefreshCw size={11} className="spin" /> : "1"}
                  </span>
                  <span className="step-label">Enrich Fabriq</span>
                </div>
                <div className="step-connector" />

                <div
                  className={`fabriq-step ${state?.stage === "merge" ? "active" : ["publish", "completed"].includes(state?.stage ?? "") ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {state?.stage === "merge" ? <RefreshCw size={11} className="spin" /> : "2"}
                  </span>
                  <span className="step-label">Merge Master</span>
                </div>
                <div className="step-connector" />

                <div
                  className={`fabriq-step ${state?.stage === "publish" ? "active" : state?.stage === "completed" ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {state?.stage === "publish" ? <RefreshCw size={11} className="spin" /> : "3"}
                  </span>
                  <span className="step-label">Publish Wallets</span>
                </div>
              </div>

              <div className="fabriq-stats-grid">
                <div className="fabriq-stat-card">
                  <div className="stat-label">Success</div>
                  <div className="stat-val text-green">{(state?.success ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Skipped</div>
                  <div className="stat-val text-muted">{(state?.skipped ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Failed</div>
                  <div className={`stat-val ${state?.failed ? "text-red" : "text-muted"}`}>
                    {(state?.failed ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Workers</div>
                  <div className="stat-val text-amber">{state?.concurrency ?? 10}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Runtime</div>
                  <div className="stat-val text-text">
                    {formatRuntime(state?.runtimeSeconds ?? 0)}
                  </div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-danger"
                  onClick={handleStopFabriq}
                  disabled={actionLoading || isFabriqStopping}
                >
                  {isFabriqStopping ? (
                    <>
                      <RefreshCw size={14} className="spin" /> Stopping Workers...
                    </>
                  ) : (
                    <>
                      <Square size={14} /> Stop Update
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: FABRIQ STOPPED                                     */}
          {/* ======================================================== */}
          {currentView === "fabriq_stopped" && (
            <div className="fabriq-stopped-section">
              <div className="fabriq-alert-banner alert-warning">
                <AlertCircle size={16} />
                <span>
                  Update stopped. Progress saved in checkpoint. You can resume anytime without
                  losing completed wallets.
                </span>
              </div>

              <div className="fabriq-stats-grid">
                <div className="fabriq-stat-card">
                  <div className="stat-label">Completed</div>
                  <div className="stat-val text-text">{(state?.completed ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Success</div>
                  <div className="stat-val text-green">{(state?.success ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Skipped</div>
                  <div className="stat-val text-muted">{(state?.skipped ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Runtime</div>
                  <div className="stat-val text-text">
                    {formatRuntime(state?.runtimeSeconds ?? 0)}
                  </div>
                </div>
              </div>

              <div className="fabriq-config-group">
                <label className="config-label">Adjust Workers Before Resuming</label>
                <div className="worker-input-wrap">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={concurrency}
                    className="worker-number-input"
                    onChange={(e) => {
                      const v = e.currentTarget.valueAsNumber;
                      if (Number.isFinite(v)) setConcurrency(Math.max(1, Math.floor(v)));
                    }}
                  />
                  <span className="worker-limit-hint">Min 1 · No worker limit</span>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleResumeFabriq}
                  disabled={actionLoading}
                >
                  <Play size={14} /> Resume Update
                </button>
                <button className="fabriq-btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: FABRIQ COMPLETED                                   */}
          {/* ======================================================== */}
          {currentView === "fabriq_completed" && (
            <div className="fabriq-completed-section">
              <div className="fabriq-alert-banner alert-success">
                <CheckCircle2 size={18} />
                <div>
                  <strong>Fabriq Update Completed Successfully</strong>
                  <div>
                    Enriched {(state?.success ?? 0).toLocaleString()} wallets. Master dataset
                    merged and published to frontend.
                  </div>
                </div>
              </div>

              <div className="fabriq-stats-grid">
                <div className="fabriq-stat-card">
                  <div className="stat-label">Total Wallets</div>
                  <div className="stat-val text-text">
                    {(state?.total ?? walletCount).toLocaleString()}
                  </div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Success</div>
                  <div className="stat-val text-green">{(state?.success ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Skipped</div>
                  <div className="stat-val text-muted">{(state?.skipped ?? 0).toLocaleString()}</div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Runtime</div>
                  <div className="stat-val text-text">
                    {formatRuntime(state?.runtimeSeconds ?? 0)}
                  </div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-secondary"
                  onClick={() => {
                    setState((prev) => (prev ? { ...prev, status: "idle", stage: "idle" } : null));
                  }}
                >
                  Configure New Run
                </button>
                <button className="fabriq-btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: FABRIQ ERROR                                       */}
          {/* ======================================================== */}
          {currentView === "fabriq_error" && (
            <div className="fabriq-error-section">
              <div className="fabriq-alert-banner alert-error">
                <AlertCircle size={18} />
                <div>
                  <strong>Fabriq Update Failed at Stage: {state?.stage ?? "unknown"}</strong>
                  <div>{state?.error || "An unknown error occurred during process execution."}</div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleStartFabriq}
                  disabled={actionLoading}
                >
                  <RefreshCw size={14} /> Retry Update
                </button>
                <button className="fabriq-btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* VIEW: IDLE — DUA CONTROL CARD (Section 19)               */}
          {/* ======================================================== */}
          {currentView === "idle" && (
            <div className="fabriq-idle-section">
              {/* Global Metadata Banner */}
              <div className="fabriq-meta-card">
                <div className="meta-row">
                  <span className="meta-key">
                    <Layers size={14} /> Master Wallets
                  </span>
                  <span className="meta-val highlight">{walletCount.toLocaleString()}</span>
                </div>
                <div className="meta-row">
                  <span className="meta-key">
                    <Clock size={14} /> Last Published Dataset
                  </span>
                  <span className="meta-val">{formatLastUpdatedDate(lastUpdated)}</span>
                </div>
              </div>

              {/* Two Control Cards Grid */}
              <div className="update-cards-grid">
                {/* CARD 1: Wallet List (LP Agent) */}
                <div className="update-card">
                  <div className="update-card-header">
                    <div className="update-card-title">Wallet List</div>
                    <span className="source-tag source-lp">LP Agent Smart LP</span>
                  </div>

                  <div className="update-card-desc">
                    Pull the latest filtered Solana Smart LP wallets, merge them into the master dataset,
                    enrich missing Fabriq data, then publish the frontend dataset.
                  </div>

                  <div className="warning-callout">
                    <AlertTriangle size={14} />
                    <span>
                      Before updating: Open LP Agent in Brave and make sure the desired Solana filter/table is already active.
                    </span>
                  </div>

                  <div className="update-card-inputs">
                    <div className="worker-input-row">
                      <label className="input-row-label">
                        <Cpu size={13} /> LP Agent Workers
                      </label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={lpConcurrency}
                        className="worker-number-input"
                        onChange={(e) => {
                          const v = e.currentTarget.valueAsNumber;
                          if (Number.isFinite(v)) setLpConcurrency(Math.max(1, Math.floor(v)));
                        }}
                      />
                    </div>

                    <div className="worker-input-row">
                      <label className="input-row-label">
                        <Cpu size={13} /> Fabriq Workers
                      </label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={lpFabriqConcurrency}
                        className="worker-number-input"
                        onChange={(e) => {
                          const v = e.currentTarget.valueAsNumber;
                          if (Number.isFinite(v)) setLpFabriqConcurrency(Math.max(1, Math.floor(v)));
                        }}
                      />
                    </div>
                  </div>

                  <button
                    className="fabriq-btn btn-primary w-full"
                    onClick={handleStartLp}
                    disabled={actionLoading}
                  >
                    <Play size={14} /> Update Wallet List
                  </button>
                </div>

                {/* CARD 2: Fabriq Analytics */}
                <div className="update-card">
                  <div className="update-card-header">
                    <div className="update-card-title">Fabriq Analytics</div>
                    <span className="source-tag source-fabriq">Fabriq Portfolio</span>
                  </div>

                  <div className="update-card-desc">
                    Refresh portfolio performance metrics, PnL calendars, token holdings and trading stats
                    for all registered wallets in master database.
                  </div>

                  <div className="mode-options compact">
                    <label
                      className={`mode-option-card ${mode === "stale" ? "selected" : ""}`}
                      onClick={() => setMode("stale")}
                    >
                      <div className="mode-radio">
                        <div className={`radio-dot ${mode === "stale" ? "active" : ""}`} />
                      </div>
                      <div className="mode-text">
                        <div className="mode-title">Refresh Stale Wallets</div>
                        <div className="mode-desc">Only wallets missing Fabriq or older than 24h.</div>
                      </div>
                    </label>

                    <label
                      className={`mode-option-card ${mode === "full" ? "selected" : ""}`}
                      onClick={() => setMode("full")}
                    >
                      <div className="mode-radio">
                        <div className={`radio-dot ${mode === "full" ? "active" : ""}`} />
                      </div>
                      <div className="mode-text">
                        <div className="mode-title">Refresh All Wallets</div>
                        <div className="mode-desc">Forces full fresh scrape for all {walletCount.toLocaleString()} wallets.</div>
                      </div>
                    </label>
                  </div>

                  <div className="update-card-inputs">
                    <div className="worker-input-row">
                      <label className="input-row-label">
                        <Cpu size={13} /> Fabriq Workers
                      </label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={concurrency}
                        className="worker-number-input"
                        onChange={(e) => {
                          const v = e.currentTarget.valueAsNumber;
                          if (Number.isFinite(v)) setConcurrency(Math.max(1, Math.floor(v)));
                        }}
                      />
                    </div>
                  </div>

                  <button
                    className="fabriq-btn btn-secondary w-full"
                    onClick={handleStartFabriq}
                    disabled={actionLoading}
                  >
                    <Play size={14} /> Start Fabriq Update
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* COLLAPSIBLE LOGS TERMINAL (Section 27)                   */}
          {/* ======================================================== */}
          <div className="fabriq-logs-container">
            <button
              type="button"
              className="fabriq-logs-toggle"
              onClick={() => setShowLogs((prev) => !prev)}
            >
              <div className="toggle-left">
                <Terminal size={14} />
                <span>View Process Logs</span>
                {activeLogs.length > 0 && (
                  <span className="logs-count-badge">{activeLogs.length} lines</span>
                )}
              </div>
              {showLogs ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>

            {showLogs && (
              <div className="fabriq-logs-console" ref={logsEndRef}>
                {activeLogs.length > 0 ? (
                  activeLogs.map((line, idx) => (
                    <div key={idx} className="log-line">
                      {line}
                    </div>
                  ))
                ) : (
                  <div className="log-empty">No process logs available for this session.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
