import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Database,
  Layers,
  Play,
  RefreshCw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type FabriqMode,
  type FabriqState,
  getFabriqStatus,
  resumeFabriqRefresh,
  startFabriqRefresh,
  stopFabriqRefresh,
  subscribeFabriqEvents,
} from "../lib/fabriqControl";

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
  const [state, setState] = useState<FabriqState | null>(null);
  const [mode, setMode] = useState<FabriqMode>("stale");
  const [concurrency, setConcurrency] = useState<number>(10);
  const [showLogs, setShowLogs] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const previousStatusRef = useRef<string | null>(null);

  // Load initial status and subscribe to SSE events
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
      .catch((err) => {
        console.warn("Could not reach control server:", err);
      });

    const unsubscribe = subscribeFabriqEvents(
      (event) => {
        if (!isMounted) return;
        setState(event.state);

        // Auto trigger dataset reload when update completes
        if (
          event.state.status === "completed" &&
          previousStatusRef.current !== "completed"
        ) {
          onDatasetRefreshed();
        }
        previousStatusRef.current = event.state.status;
      },
      () => {
        // Fallback polling if SSE disconnects temporarily
        getFabriqStatus()
          .then((s) => {
            if (isMounted) setState(s);
          })
          .catch(() => {});
      },
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [onDatasetRefreshed]);

  // Auto-scroll logs when open and new logs arrive
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollTop = logsEndRef.current.scrollHeight;
    }
  }, [showLogs, state?.logs.length]);

  if (!isOpen) {
    return null;
  }

  const isRunning =
    state?.status === "running" || state?.status === "stopping";
  const isStopping = state?.status === "stopping";
  const isStopped = state?.status === "stopped";
  const isCompleted = state?.status === "completed";
  const isError = state?.status === "error";

  const total = state?.total || walletCount || 1458;
  const completed = state?.completed || 0;
  const progressPercent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  const handleStart = async () => {
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

  const handleStop = async () => {
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

  const handleResume = async () => {
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

  const stageBadgeText = useMemo(() => {
    if (!state) return "Idle";
    if (state.status === "stopping") return "Stopping Process...";
    if (state.status === "stopped") return "Update Paused";
    if (state.status === "completed") return "Completed";
    if (state.status === "error") return "Failed";

    if (state.stage === "enrich") return "Enriching Wallets...";
    if (state.stage === "merge") return "Merging Master Data...";
    if (state.stage === "publish") return "Publishing Frontend...";
    return "Running";
  }, [state]);

  return (
    <div className="fabriq-modal-backdrop" onClick={onClose}>
      <div
        className="fabriq-modal-dialog"
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
              <div className="fabriq-modal-title">
                {isRunning ? "Updating Fabriq" : "Update Wallet Data"}
              </div>
              <div className="fabriq-modal-subtitle">
                Automated enrichment, master merge & publish pipeline
              </div>
            </div>
          </div>

          <div className="fabriq-modal-header-actions">
            <span className={`fabriq-status-pill status-${state?.status ?? "idle"}`}>
              {isRunning && <span className="status-dot-pulse" />}
              {stageBadgeText}
            </span>

            <button
              className="fabriq-modal-close"
              onClick={onClose}
              title="Close modal (update keeps running in background)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Modal Content */}
        <div className="fabriq-modal-body">
          {actionError && (
            <div className="fabriq-alert-banner alert-error">
              <AlertCircle size={16} />
              <span>{actionError}</span>
            </div>
          )}

          {/* Running State */}
          {isRunning && (
            <div className="fabriq-running-section">
              <div className="fabriq-progress-header">
                <div className="fabriq-progress-count">
                  {state?.total ? (
                    <>
                      <strong>{state.completed.toLocaleString()}</strong> /{" "}
                      {state.total.toLocaleString()} wallets
                    </>
                  ) : (
                    "Preparing update pipeline..."
                  )}
                </div>
                <div className="fabriq-progress-percent">
                  {state?.total ? `${progressPercent}%` : "—"}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="fabriq-progress-track">
                <div
                  className={`fabriq-progress-fill ${!state?.total ? "indeterminate" : ""}`}
                  style={{ width: `${Math.max(5, progressPercent)}%` }}
                />
              </div>

              {/* Pipeline Stepper */}
              <div className="fabriq-stepper">
                <div
                  className={`fabriq-step ${state?.stage === "enrich" ? "active" : state?.stage === "merge" || state?.stage === "publish" || state?.stage === "completed" ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {state?.stage === "enrich" ? <RefreshCw size={12} className="spin" /> : "1"}
                  </span>
                  <span className="step-label">Enrich Fabriq</span>
                </div>

                <div className="step-connector" />

                <div
                  className={`fabriq-step ${state?.stage === "merge" ? "active" : state?.stage === "publish" || state?.stage === "completed" ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {state?.stage === "merge" ? <RefreshCw size={12} className="spin" /> : "2"}
                  </span>
                  <span className="step-label">Merge Data</span>
                </div>

                <div className="step-connector" />

                <div
                  className={`fabriq-step ${state?.stage === "publish" ? "active" : state?.stage === "completed" ? "done" : ""}`}
                >
                  <span className="step-circle">
                    {state?.stage === "publish" ? <RefreshCw size={12} className="spin" /> : "3"}
                  </span>
                  <span className="step-label">Publish Wallets</span>
                </div>
              </div>

              {/* Metric Counters Grid */}
              <div className="fabriq-stats-grid">
                <div className="fabriq-stat-card">
                  <div className="stat-label">Success</div>
                  <div className="stat-val text-green">
                    {(state?.success ?? 0).toLocaleString()}
                  </div>
                </div>

                <div className="fabriq-stat-card">
                  <div className="stat-label">Skipped</div>
                  <div className="stat-val text-muted">
                    {(state?.skipped ?? 0).toLocaleString()}
                  </div>
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

              {/* Stop Button */}
              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-danger"
                  onClick={handleStop}
                  disabled={actionLoading || isStopping}
                >
                  {isStopping ? (
                    <>
                      <RefreshCw size={15} className="spin" />
                      Stopping Workers...
                    </>
                  ) : (
                    <>
                      <Square size={14} />
                      Stop Update
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Stopped State */}
          {isStopped && (
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
                  <div className="stat-val text-text">
                    {(state?.completed ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Success</div>
                  <div className="stat-val text-green">
                    {(state?.success ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Skipped</div>
                  <div className="stat-val text-muted">
                    {(state?.skipped ?? 0).toLocaleString()}
                  </div>
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
                <div className="worker-buttons">
                  {[1, 2, 5, 10].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={`worker-btn ${concurrency === count ? "active" : ""}`}
                      onClick={() => setConcurrency(count)}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleResume}
                  disabled={actionLoading}
                >
                  <Play size={14} />
                  Resume Update
                </button>
                <button className="fabriq-btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Completed State */}
          {isCompleted && (
            <div className="fabriq-completed-section">
              <div className="fabriq-alert-banner alert-success">
                <CheckCircle2 size={18} />
                <div>
                  <strong>Update Completed Successfully</strong>
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
                  <div className="stat-val text-green">
                    {(state?.success ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="fabriq-stat-card">
                  <div className="stat-label">Skipped</div>
                  <div className="stat-val text-muted">
                    {(state?.skipped ?? 0).toLocaleString()}
                  </div>
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

          {/* Error State */}
          {isError && (
            <div className="fabriq-error-section">
              <div className="fabriq-alert-banner alert-error">
                <AlertCircle size={18} />
                <div>
                  <strong>Update Failed at Stage: {state?.stage ?? "unknown"}</strong>
                  <div>{state?.error || "An unknown error occurred during process execution."}</div>
                </div>
              </div>

              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleStart}
                  disabled={actionLoading}
                >
                  <RefreshCw size={14} />
                  Retry Update
                </button>
                <button className="fabriq-btn btn-secondary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Idle State */}
          {!isRunning && !isStopped && !isCompleted && !isError && (
            <div className="fabriq-idle-section">
              {/* Dataset Meta Information */}
              <div className="fabriq-meta-card">
                <div className="meta-row">
                  <span className="meta-key">
                    <Database size={14} /> Source
                  </span>
                  <span className="meta-val highlight">Fabriq Portfolio</span>
                </div>
                <div className="meta-row">
                  <span className="meta-key">
                    <Layers size={14} /> Total Wallets
                  </span>
                  <span className="meta-val">{walletCount.toLocaleString()}</span>
                </div>
                <div className="meta-row">
                  <span className="meta-key">
                    <Clock size={14} /> Last Updated
                  </span>
                  <span className="meta-val">{formatLastUpdatedDate(lastUpdated)}</span>
                </div>
              </div>

              {/* Mode Selection */}
              <div className="fabriq-config-group">
                <label className="config-label">Update Mode</label>
                <div className="mode-options">
                  <label
                    className={`mode-option-card ${mode === "stale" ? "selected" : ""}`}
                    onClick={() => setMode("stale")}
                  >
                    <div className="mode-radio">
                      <div className={`radio-dot ${mode === "stale" ? "active" : ""}`} />
                    </div>
                    <div className="mode-text">
                      <div className="mode-title">Refresh Stale Wallets</div>
                      <div className="mode-desc">
                        Only scrapes wallets missing Fabriq data or older than 24 hours. Fastest option.
                      </div>
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
                      <div className="mode-desc">
                        Sets fresh cutoff timestamp and scrapes all {walletCount.toLocaleString()} wallets.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Worker Count */}
              <div className="fabriq-config-group">
                <div className="config-label-row">
                  <label className="config-label">
                    <Cpu size={14} /> Worker Concurrency
                  </label>
                  <span className="config-hint">Simultaneous browser workers</span>
                </div>
                <div className="worker-buttons">
                  {[1, 2, 5, 10].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={`worker-btn ${concurrency === count ? "active" : ""}`}
                      onClick={() => setConcurrency(count)}
                    >
                      {count} {count === 10 ? "(Recommended)" : ""}
                    </button>
                  ))}
                </div>
              </div>

              {/* Action */}
              <div className="fabriq-modal-actions">
                <button
                  className="fabriq-btn btn-primary"
                  onClick={handleStart}
                  disabled={actionLoading}
                >
                  <Play size={14} />
                  Start Update
                </button>
              </div>
            </div>
          )}

          {/* Collapsible Logs Terminal */}
          <div className="fabriq-logs-container">
            <button
              type="button"
              className="fabriq-logs-toggle"
              onClick={() => setShowLogs((prev) => !prev)}
            >
              <div className="toggle-left">
                <Terminal size={14} />
                <span>View Process Logs</span>
                {state?.logs?.length ? (
                  <span className="logs-count-badge">{state.logs.length} lines</span>
                ) : null}
              </div>
              {showLogs ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>

            {showLogs && (
              <div className="fabriq-logs-console" ref={logsEndRef}>
                {state?.logs && state.logs.length > 0 ? (
                  state.logs.map((line, idx) => (
                    <div key={idx} className="log-line">
                      {line}
                    </div>
                  ))
                ) : (
                  <div className="log-empty">No process logs available.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
