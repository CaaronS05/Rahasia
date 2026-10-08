import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Activity,
  Terminal,
  Search,
  RefreshCw,
  Copy,
  Download,
  FilterX,
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ChevronRight,
  Radio,
  Check,
} from "lucide-react";
import "../activity-logs.css";

const API_BASE = "http://127.0.0.1:8787";

export interface ActivityLogEvent {
  id: string;
  timestamp: string;
  runId: string | null;
  source: string;
  wallet: string | null;
  poolAddress: string | null;
  stage: string;
  level: "DEBUG" | "INFO" | "SUCCESS" | "WARN" | "ERROR";
  message: string;
  details?: unknown;
}

export interface ActivityRun {
  runId: string;
  source: string;
  wallet: string | null;
  poolAddress: string | null;
  status: "running" | "completed" | "error" | "stopped";
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  error: string | null;
  exitCode: number | null;
  logCount: number;
}

export interface ActiveProcess {
  runId: string;
  source: string;
  wallet: string | null;
  poolAddress: string | null;
  stage: string;
  startedAt: string;
  durationMs: number;
}

function formatJakartaTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "—";
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d) + " WIB"
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "0s";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

function formatSourceLabel(source: string): string {
  switch (source) {
    case "single_wallet":
      return "Single Wallet";
    case "pool_scanner":
      return "Pool Scanner";
    case "pool_refresh":
      return "Pool Refresh";
    case "fabriq_enrich":
      return "Fabriq Enrich";
    case "lpagent":
      return "LP Agent";
    case "wallet_intelligence":
      return "Wallet Intelligence";
    default:
      return source.replace(/_/g, " ");
  }
}

export function ActivityLogsPage() {
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const [logs, setLogs] = useState<ActivityLogEvent[]>([]);
  const [activeProcesses, setActiveProcesses] = useState<ActiveProcess[]>([]);
  const [connected, setConnected] = useState(false);

  // Filters
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("ALL");
  const [levelFilter, setLevelFilter] = useState<string>("ALL");
  const [walletFilter, setWalletFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());
  const [copyFeedback, setCopyFeedback] = useState(false);

  const streamRef = useRef<HTMLDivElement>(null);
  const initialLoadDone = useRef(false);

  // Initialize filters from URL parameters on first mount
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const params = new URLSearchParams(window.location.search);
    const urlRunId = params.get("runId");
    const urlWallet = params.get("wallet");
    const urlSource = params.get("source");

    if (urlRunId) setSelectedRunId(urlRunId);
    if (urlWallet) setWalletFilter(urlWallet);
    if (urlSource) setSourceFilter(urlSource);
  }, []);

  // Fetch runs list
  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/activity-runs?limit=80`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.runs)) {
        setRuns(data.runs);
      }
    } catch {
      // Ignore network errors on polling
    }
  }, []);

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("limit", "400");
      if (selectedRunId) params.set("runId", selectedRunId);
      if (sourceFilter !== "ALL") params.set("source", sourceFilter);
      if (levelFilter !== "ALL") params.set("level", levelFilter);
      if (walletFilter) params.set("wallet", walletFilter);
      if (searchQuery) params.set("search", searchQuery);

      const res = await fetch(`${API_BASE}/api/activity-logs?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.logs)) {
        setLogs(data.logs);
      }
      if (Array.isArray(data.activeProcesses)) {
        setActiveProcesses(data.activeProcesses);
      }
    } catch {
      // Ignore network errors
    }
  }, [selectedRunId, sourceFilter, levelFilter, walletFilter, searchQuery]);

  // Initial load
  useEffect(() => {
    void fetchRuns();
    void fetchLogs();
  }, [fetchRuns, fetchLogs]);

  // Setup SSE stream for real-time log delivery
  useEffect(() => {
    let evtSource: EventSource | null = null;
    let reconnectTimer: number | null = null;

    function connectSSE() {
      const streamUrl = new URL(`${API_BASE}/api/activity-logs/stream`);
      if (selectedRunId) streamUrl.searchParams.set("runId", selectedRunId);
      if (sourceFilter !== "ALL") streamUrl.searchParams.set("source", sourceFilter);
      if (walletFilter) streamUrl.searchParams.set("wallet", walletFilter);

      try {
        evtSource = new EventSource(streamUrl.toString());

        evtSource.onopen = () => {
          setConnected(true);
        };

        evtSource.onmessage = (msg) => {
          try {
            const event = JSON.parse(msg.data) as ActivityLogEvent;
            if (event && event.id) {
              setLogs((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                const next = [...prev, event];
                return next.length > 2000 ? next.slice(-2000) : next;
              });

              // Refresh runs when a completion or error event arrives
              if (
                event.level === "SUCCESS" ||
                event.level === "ERROR" ||
                event.stage === "completed" ||
                event.stage === "starting"
              ) {
                void fetchRuns();
              }
            }
          } catch {
            // Ignore parse errors on heartbeat
          }
        };

        evtSource.onerror = () => {
          setConnected(false);
          evtSource?.close();
          reconnectTimer = window.setTimeout(connectSSE, 3000);
        };
      } catch {
        setConnected(false);
      }
    }

    connectSSE();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      evtSource?.close();
    };
  }, [selectedRunId, sourceFilter, walletFilter, fetchRuns]);

  // Periodic active process ticker (ticks every 1s)
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveProcesses((prev) =>
        prev.map((p) => ({
          ...p,
          durationMs: p.startedAt ? Math.max(0, Date.now() - new Date(p.startedAt).getTime()) : 0,
        }))
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Auto-scroll log stream
  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Filter logs for local display
  const filteredLogs = useMemo(() => {
    let result = logs;
    if (selectedRunId) {
      result = result.filter((l) => l.runId === selectedRunId);
    }
    if (sourceFilter !== "ALL") {
      result = result.filter((l) => l.source === sourceFilter);
    }
    if (levelFilter !== "ALL") {
      result = result.filter((l) => l.level === levelFilter);
    }
    if (walletFilter.trim()) {
      const q = walletFilter.trim().toLowerCase();
      result = result.filter((l) => l.wallet && l.wallet.toLowerCase().includes(q));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (l) =>
          l.message.toLowerCase().includes(q) ||
          l.stage.toLowerCase().includes(q) ||
          (l.wallet && l.wallet.toLowerCase().includes(q))
      );
    }
    return result;
  }, [logs, selectedRunId, sourceFilter, levelFilter, walletFilter, searchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map(
        (l) =>
          `[${formatJakartaTime(l.timestamp)}] [${l.level}] [${l.stage}] ${l.message}`
      )
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1800);
    });
  };

  const handleDownloadLogs = () => {
    const text = filteredLogs
      .map(
        (l) =>
          `[${formatJakartaTime(l.timestamp)}] [${l.level}] [${l.source}/${l.stage}] ${l.message}`
      )
      .join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `activity-logs-${selectedRunId || "all"}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearAllFilters = () => {
    setSelectedRunId(null);
    setSourceFilter("ALL");
    setLevelFilter("ALL");
    setWalletFilter("");
    setSearchQuery("");
    window.history.replaceState({}, "", "/activity-logs");
  };

  return (
    <div className="activity-logs-page">
      {/* Top Header */}
      <header className="activity-header">
        <div className="activity-title">
          <h1>
            <Terminal size={20} color="var(--green, #22c55e)" />
            GLOBAL ACTIVITY LOGS
          </h1>
          <p>
            Centralized telemetry and real-time execution observability across all pipelines.
          </p>
        </div>

        <div className="activity-header-actions">
          <div className="activity-status-indicator">
            <span className={`activity-status-dot ${connected ? "" : "offline"}`} />
            <span>{connected ? "LIVE SSE STREAM" : "POLLING"}</span>
          </div>

          <button
            className={`activity-btn ${autoScroll ? "active" : ""}`}
            onClick={() => setAutoScroll((v) => !v)}
            title="Toggle auto-scroll to latest log event"
          >
            <Radio size={12} />
            <span>Auto-Scroll: {autoScroll ? "ON" : "OFF"}</span>
          </button>

          <button className="activity-btn" onClick={handleCopyLogs} title="Copy visible logs">
            {copyFeedback ? <Check size={12} color="var(--green, #22c55e)" /> : <Copy size={12} />}
            <span>{copyFeedback ? "Copied!" : "Copy Logs"}</span>
          </button>

          <button className="activity-btn" onClick={handleDownloadLogs} title="Download logs as text">
            <Download size={12} />
            <span>Export Text</span>
          </button>

          <button className="activity-btn" onClick={() => { void fetchRuns(); void fetchLogs(); }} title="Refresh">
            <RefreshCw size={12} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {/* Active Processes Banner */}
      {activeProcesses.length > 0 ? (
        <section className="active-processes-strip" aria-label="Active processes">
          <div className="active-strip-label">
            Active Pipelines ({activeProcesses.length})
          </div>
          <div className="active-processes-list">
            {activeProcesses.map((p) => (
              <div
                key={p.runId}
                className="active-process-card"
                onClick={() => setSelectedRunId(p.runId)}
                title="Click to view logs for this active process"
              >
                <Play size={12} color="var(--amber, #f59e0b)" />
                <strong>{formatSourceLabel(p.source)}</strong>
                {p.wallet ? (
                  <span style={{ fontFamily: "monospace" }}>
                    {p.wallet.slice(0, 4)}...{p.wallet.slice(-4)}
                  </span>
                ) : null}
                <span className="stage-chip">{p.stage}</span>
                <span className="duration">
                  <Clock size={11} style={{ verticalAlign: "middle", marginRight: "3px" }} />
                  {formatDuration(p.durationMs)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Main Workspace (2 columns: Runs & Logs) */}
      <div className="activity-workspace">
        {/* Left Column: Runs & Filters */}
        <aside className="activity-runs-panel">
          <div className="runs-panel-header">
            <div className="runs-search-box">
              <Search size={13} />
              <input
                type="text"
                placeholder="Search logs or stages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="runs-filter-row">
              <select
                className="activity-select"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
              >
                <option value="ALL">All Pipelines</option>
                <option value="single_wallet">Single Wallet</option>
                <option value="pool_scanner">Pool Scanner</option>
                <option value="pool_refresh">Pool Refresh</option>
                <option value="fabriq_enrich">Fabriq Enrich</option>
                <option value="lpagent">LP Agent</option>
                <option value="wallet_intelligence">Wallet Intelligence</option>
              </select>

              <select
                className="activity-select"
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
              >
                <option value="ALL">All Levels</option>
                <option value="ERROR">Error</option>
                <option value="WARN">Warn</option>
                <option value="SUCCESS">Success</option>
                <option value="INFO">Info</option>
                <option value="DEBUG">Debug</option>
              </select>
            </div>
          </div>

          <div className="runs-list">
            <div
              className={`run-card ${selectedRunId === null ? "selected" : ""}`}
              onClick={() => setSelectedRunId(null)}
            >
              <div className="run-card-top">
                <span className="run-source-badge">All Runs (Aggregated)</span>
                <span className="run-status-badge completed">Live</span>
              </div>
              <div className="run-card-bottom">
                <span>Displaying global telemetry stream</span>
                <span>{filteredLogs.length} events</span>
              </div>
            </div>

            {runs.map((r) => {
              const isSelected = selectedRunId === r.runId;
              return (
                <div
                  key={r.runId}
                  className={`run-card ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedRunId(r.runId)}
                >
                  <div className="run-card-top">
                    <span className="run-source-badge">{formatSourceLabel(r.source)}</span>
                    <span className={`run-status-badge ${r.status}`}>
                      {r.status}
                    </span>
                  </div>

                  <div className="run-card-mid">
                    {r.wallet ? (
                      <span>Wallet: {r.wallet.slice(0, 6)}...{r.wallet.slice(-6)}</span>
                    ) : r.poolAddress ? (
                      <span>Pool: {r.poolAddress.slice(0, 6)}...{r.poolAddress.slice(-6)}</span>
                    ) : (
                      <span>Stage: {r.stage}</span>
                    )}
                  </div>

                  {r.error ? (
                    <div className="run-card-error" title={r.error}>
                      {r.error}
                    </div>
                  ) : null}

                  <div className="run-card-bottom">
                    <span>{formatJakartaTime(r.startedAt)}</span>
                    <span>{formatDuration(r.durationMs)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right Column: Live Logs Stream */}
        <main className="activity-logs-panel">
          <div className="logs-panel-toolbar">
            <div className="logs-active-filters">
              {selectedRunId ? (
                <span className="filter-tag">
                  Run: {selectedRunId.slice(0, 16)}...
                  <button onClick={() => setSelectedRunId(null)}>×</button>
                </span>
              ) : null}

              {sourceFilter !== "ALL" ? (
                <span className="filter-tag">
                  Pipeline: {formatSourceLabel(sourceFilter)}
                  <button onClick={() => setSourceFilter("ALL")}>×</button>
                </span>
              ) : null}

              {levelFilter !== "ALL" ? (
                <span className="filter-tag">
                  Level: {levelFilter}
                  <button onClick={() => setLevelFilter("ALL")}>×</button>
                </span>
              ) : null}

              {walletFilter ? (
                <span className="filter-tag">
                  Wallet: {walletFilter.slice(0, 6)}...
                  <button onClick={() => setWalletFilter("")}>×</button>
                </span>
              ) : null}

              {searchQuery ? (
                <span className="filter-tag">
                  Query: {searchQuery}
                  <button onClick={() => setSearchQuery("")}>×</button>
                </span>
              ) : null}

              {selectedRunId || sourceFilter !== "ALL" || levelFilter !== "ALL" || walletFilter || searchQuery ? (
                <button
                  className="activity-btn"
                  style={{ padding: "3px 8px", fontSize: "10.5px" }}
                  onClick={clearAllFilters}
                >
                  <FilterX size={11} /> Clear Filters
                </button>
              ) : (
                <span style={{ color: "var(--muted, #9a968f)" }}>
                  Showing all telemetry events ({filteredLogs.length})
                </span>
              )}
            </div>

            <div className="logs-panel-controls">
              <span style={{ fontSize: "11px", color: "var(--muted, #9a968f)" }}>
                {filteredLogs.length} events
              </span>
            </div>
          </div>

          <div className="logs-stream-container" ref={streamRef}>
            {filteredLogs.length === 0 ? (
              <div className="log-empty">
                <Activity size={24} style={{ opacity: 0.4 }} />
                <span>No logs match the current filters.</span>
              </div>
            ) : (
              filteredLogs.map((log) => {
                const isExpanded = expandedLogIds.has(log.id);
                const isMultiLine = log.message.includes("\n") || log.message.length > 120;

                return (
                  <div key={log.id} className="log-entry-row">
                    <span className="log-ts">{formatJakartaTime(log.timestamp)}</span>
                    <span className={`log-badge ${log.level}`}>{log.level}</span>
                    <span className="log-stage-tag">{log.stage}</span>
                    <div
                      className={`log-text ${!isExpanded && isMultiLine ? "collapsed" : ""}`}
                      onClick={() => isMultiLine && toggleExpand(log.id)}
                      title={isMultiLine ? (isExpanded ? "Click to collapse" : "Click to expand") : undefined}
                    >
                      {log.message}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
