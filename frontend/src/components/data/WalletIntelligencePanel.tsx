import {
  Check,
  Copy,
  Cpu,
  Funnel,
  Info,
  Play,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Square,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  INTELLIGENCE_STAGES,
  startWalletIntelligence,
  stopWalletIntelligence,
  type WalletIntelligenceState,
} from "../../lib/walletIntelligenceControl";

export function dataTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));
}

export interface WalletIntelligenceBuildConfig {
  workers: number;
  historyWindowDays: number;
  maxClosedPositions: number;
  candidateMode: "full_master" | "limit";
  candidateLimit: number;
  qualityMinPercentile: "P50" | "P60" | "P70" | "P75" | "P80" | "P90" | "P95";
  riskMaxPercentile: "P5" | "P10" | "P20" | "P25" | "P30" | "P40" | "P50";
  confidenceMin: number;
  forceNewSession: boolean;
}

const STORAGE_KEY = "wallet-intelligence-build-config-v1";

const DEFAULT_BUILD_CONFIG: WalletIntelligenceBuildConfig = {
  workers: 5,
  historyWindowDays: 30,
  maxClosedPositions: 300,
  candidateMode: "full_master",
  candidateLimit: 100,
  qualityMinPercentile: "P75",
  riskMaxPercentile: "P25",
  confidenceMin: 80,
  forceNewSession: false,
};

function loadStoredBuildConfig(): WalletIntelligenceBuildConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BUILD_CONFIG;
    const parsed = JSON.parse(raw);
    const validQuality = ["P50", "P60", "P70", "P75", "P80", "P90", "P95"];
    const validRisk = ["P5", "P10", "P20", "P25", "P30", "P40", "P50"];
    const validHistory = [7, 14, 30, 60, 90];
    return {
      workers: typeof parsed.workers === "number" && parsed.workers >= 1 && parsed.workers <= 20
        ? parsed.workers
        : DEFAULT_BUILD_CONFIG.workers,
      historyWindowDays: validHistory.includes(Number(parsed.historyWindowDays))
        ? Number(parsed.historyWindowDays)
        : DEFAULT_BUILD_CONFIG.historyWindowDays,
      maxClosedPositions: typeof parsed.maxClosedPositions === "number" && parsed.maxClosedPositions >= 1
        ? parsed.maxClosedPositions
        : DEFAULT_BUILD_CONFIG.maxClosedPositions,
      candidateMode: parsed.candidateMode === "limit" ? "limit" : "full_master",
      candidateLimit: typeof parsed.candidateLimit === "number" && parsed.candidateLimit >= 1
        ? parsed.candidateLimit
        : DEFAULT_BUILD_CONFIG.candidateLimit,
      qualityMinPercentile: validQuality.includes(parsed.qualityMinPercentile)
        ? parsed.qualityMinPercentile
        : DEFAULT_BUILD_CONFIG.qualityMinPercentile,
      riskMaxPercentile: validRisk.includes(parsed.riskMaxPercentile)
        ? parsed.riskMaxPercentile
        : DEFAULT_BUILD_CONFIG.riskMaxPercentile,
      confidenceMin: typeof parsed.confidenceMin === "number" && parsed.confidenceMin >= 0 && parsed.confidenceMin <= 100
        ? parsed.confidenceMin
        : DEFAULT_BUILD_CONFIG.confidenceMin,
      forceNewSession: Boolean(parsed.forceNewSession),
    };
  } catch {
    return DEFAULT_BUILD_CONFIG;
  }
}

export function WalletIntelligencePanel({ state, startDisabled, onStateChanged }: {
  state: WalletIntelligenceState | null;
  startDisabled: boolean;
  onStateChanged: () => Promise<void>;
}) {
  const [config, setConfig] = useState<WalletIntelligenceBuildConfig>(loadStoredBuildConfig);
  const [action, setAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const running = Boolean(state?.running);
  const stageLabel = INTELLIGENCE_STAGES.find((stage) => stage.key === state?.stage)?.label ?? state?.stage ?? "—";
  const status = state?.status === "idle" ? "ready" : state?.status ?? "unavailable";

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Ignore localStorage write failures
    }
  }, [config]);

  useEffect(() => {
    if (logsExpanded && running && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logsExpanded, running, state?.logs]);

  function updateConfig<K extends keyof WalletIntelligenceBuildConfig>(
    key: K,
    value: WalletIntelligenceBuildConfig[K],
  ) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function resetToDefaults() {
    setConfig(DEFAULT_BUILD_CONFIG);
  }

  async function runAction(stop: boolean) {
    if (action || (!stop && startDisabled)) return;
    setAction(true);
    setError(null);
    try {
      await (stop ? stopWalletIntelligence() : startWalletIntelligence());
      await onStateChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setAction(false); }
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(state?.logs.join("\n") ?? "");
      setCopied(true);
    } catch { setError("Unable to copy logs. Select the log text to copy it manually."); }
  }

  return (
    <section className="data-panel" aria-label="Wallet Intelligence V1 controls">
      <div className="data-panel-heading">
        <div><h2>WALLET INTELLIGENCE V1</h2><p>Build historical screening data, separate scores, style classifications, and shortlist.</p></div>
        <span className={`data-status status-${status}`}>{status.toUpperCase()}</span>
      </div>
      {(error || state?.error) && <div className="state-card error" role="alert">{error || state?.error}</div>}
      <ol className="intelligence-stages" aria-label="Pipeline stages">
        {INTELLIGENCE_STAGES.map((stage, index) => {
          const stageStatus = state?.stageStates[stage.key];
          return <li key={stage.key} className={`intelligence-stage stage-${stageStatus ?? "pending"}`}>
            <span className="intelligence-stage-number">{stageStatus === "completed" ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span>
            <strong>{stage.label}</strong><small>{stageStatus ?? "—"}</small>
          </li>;
        })}
      </ol>
      <dl className="data-details">
        <div><dt>Started</dt><dd>{dataTimestamp(state?.startedAt)}</dd></div>
        <div><dt>Runtime</dt><dd>{state?.startedAt ? `${Math.floor(state.runtimeSeconds / 60)}m ${state.runtimeSeconds % 60}s` : "—"}</dd></div>
        <div><dt>Current stage</dt><dd>{stageLabel}</dd></div>
        <div><dt>Last result</dt><dd>{state?.finishedAt ? `${state.status.toUpperCase()} · ${dataTimestamp(state.finishedAt)}` : "—"}</dd></div>
      </dl>

      {/* BUILD CONFIGURATION (Applies to next build) */}
      <section className="intelligence-config-section" aria-label="Build configuration">
        <div className="intelligence-config-header">
          <div>
            <div className="config-section-tag">
              <SlidersHorizontal size={14} />
              <h3>BUILD CONFIGURATION</h3>
            </div>
            <p className="config-section-subtitle">Configuration applies to the next build.</p>
          </div>
          <div className="config-header-badges">
            {running && (
              <span className="config-running-pill">
                Active build running · Next build draft
              </span>
            )}
            <button
              type="button"
              className="config-reset-btn"
              onClick={resetToDefaults}
              title="Reset all settings to default values"
            >
              <RotateCcw size={12} /> Reset defaults
            </button>
          </div>
        </div>

        <div className="config-groups-grid">
          {/* GROUP 1: EXECUTION */}
          <div className="config-group-card">
            <div className="config-group-heading">
              <Cpu size={14} />
              <h4>EXECUTION</h4>
            </div>

            {/* Workers */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-workers" className="config-field-label">Workers</label>
                <span className="config-field-helper">Parallel wallets processed through Fabriq.</span>
              </div>
              <div className="config-field-input-wrap">
                <input
                  id="cfg-workers"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={config.workers}
                  onChange={(e) => {
                    const val = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(val)) {
                      updateConfig("workers", Math.min(20, Math.max(1, val)));
                    }
                  }}
                  className="config-number-input"
                />
              </div>
            </div>

            {/* History Window */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-history-window" className="config-field-label">History Window</label>
                <span className="config-field-helper">Lookback period for closed positions screening.</span>
              </div>
              <div className="config-field-input-wrap">
                <select
                  id="cfg-history-window"
                  value={config.historyWindowDays}
                  onChange={(e) => updateConfig("historyWindowDays", Number(e.target.value))}
                  className="config-select"
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>
            </div>

            {/* Max Closed Positions */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-max-positions" className="config-field-label">Max Closed Positions</label>
                <span className="config-field-helper">Wallets above this position count are excluded by workload guard.</span>
              </div>
              <div className="config-field-input-wrap">
                <input
                  id="cfg-max-positions"
                  type="number"
                  min={1}
                  step={1}
                  value={config.maxClosedPositions}
                  onChange={(e) => {
                    const val = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(val)) {
                      updateConfig("maxClosedPositions", Math.max(1, val));
                    }
                  }}
                  className="config-number-input"
                />
              </div>
            </div>

            {/* Candidate Mode */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-candidate-mode" className="config-field-label">Candidate Mode</label>
                <span className="config-field-helper">
                  {config.candidateMode === "full_master"
                    ? "All wallets from wallets-master.json"
                    : "Process candidate wallets up to limit"}
                </span>
              </div>
              <div className="config-field-input-wrap">
                <select
                  id="cfg-candidate-mode"
                  value={config.candidateMode}
                  onChange={(e) => updateConfig("candidateMode", e.target.value as "full_master" | "limit")}
                  className="config-select"
                >
                  <option value="full_master">Full Master</option>
                  <option value="limit">Limit</option>
                </select>
              </div>
            </div>

            {/* Candidate Limit (only if limit selected) */}
            {config.candidateMode === "limit" && (
              <div className="config-field config-subfield">
                <div className="config-field-info">
                  <label htmlFor="cfg-candidate-limit" className="config-field-label">Candidate Limit</label>
                  <span className="config-field-helper">Maximum candidate wallets to evaluate in this run.</span>
                </div>
                <div className="config-field-input-wrap">
                  <input
                    id="cfg-candidate-limit"
                    type="number"
                    min={1}
                    step={1}
                    value={config.candidateLimit}
                    onChange={(e) => {
                      const val = Number.parseInt(e.target.value, 10);
                      if (Number.isFinite(val)) {
                        updateConfig("candidateLimit", Math.max(1, val));
                      }
                    }}
                    className="config-number-input"
                  />
                </div>
              </div>
            )}
          </div>

          {/* GROUP 2: SHORTLIST FILTERS */}
          <div className="config-group-card">
            <div className="config-group-heading">
              <Funnel size={14} />
              <h4>SHORTLIST FILTERS</h4>
            </div>

            {/* Quality Minimum */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-quality-min" className="config-field-label">Quality Minimum</label>
                <span className="config-field-helper">Minimum quality percentile threshold.</span>
              </div>
              <div className="config-field-input-wrap">
                <select
                  id="cfg-quality-min"
                  value={config.qualityMinPercentile}
                  onChange={(e) => updateConfig("qualityMinPercentile", e.target.value as WalletIntelligenceBuildConfig["qualityMinPercentile"])}
                  className="config-select"
                >
                  <option value="P50">P50</option>
                  <option value="P60">P60</option>
                  <option value="P70">P70</option>
                  <option value="P75">P75</option>
                  <option value="P80">P80</option>
                  <option value="P90">P90</option>
                  <option value="P95">P95</option>
                </select>
              </div>
            </div>

            {/* Risk Maximum */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-risk-max" className="config-field-label">Risk Maximum</label>
                <span className="config-field-helper">Maximum allowed risk percentile threshold.</span>
              </div>
              <div className="config-field-input-wrap">
                <select
                  id="cfg-risk-max"
                  value={config.riskMaxPercentile}
                  onChange={(e) => updateConfig("riskMaxPercentile", e.target.value as WalletIntelligenceBuildConfig["riskMaxPercentile"])}
                  className="config-select"
                >
                  <option value="P5">P5</option>
                  <option value="P10">P10</option>
                  <option value="P20">P20</option>
                  <option value="P25">P25</option>
                  <option value="P30">P30</option>
                  <option value="P40">P40</option>
                  <option value="P50">P50</option>
                </select>
              </div>
            </div>

            {/* Confidence Minimum */}
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-confidence-min" className="config-field-label">Confidence Minimum</label>
                <span className="config-field-helper">Range 0–100 threshold for statistical robustness.</span>
              </div>
              <div className="config-field-input-wrap config-slider-wrap">
                <input
                  id="cfg-confidence-slider"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={config.confidenceMin}
                  onChange={(e) => updateConfig("confidenceMin", Number(e.target.value))}
                  className="config-range-input"
                  aria-label="Confidence Minimum Slider"
                />
                <input
                  id="cfg-confidence-min"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={config.confidenceMin}
                  onChange={(e) => {
                    const val = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(val)) {
                      updateConfig("confidenceMin", Math.min(100, Math.max(0, val)));
                    }
                  }}
                  className="config-number-input"
                  aria-label="Confidence Minimum Value"
                />
              </div>
            </div>

            {/* Locked formula note */}
            <div className="config-locked-formula-note">
              <Info size={13} />
              <span>Score formulas remain fixed. These settings only control cohort execution and shortlist thresholds.</span>
            </div>
          </div>
        </div>

        {/* ADVANCED SECTION */}
        <details className="config-advanced-details">
          <summary className="config-advanced-summary">
            <div className="config-advanced-title">
              <Settings2 size={13} />
              <span>Advanced</span>
            </div>
            <span className="config-advanced-badge">
              Force New Session: {config.forceNewSession ? "ON" : "OFF"}
            </span>
          </summary>
          <div className="config-advanced-content">
            <div className="config-field">
              <div className="config-field-info">
                <label htmlFor="cfg-force-new-session" className="config-field-label">Force New Session</label>
                <span className="config-field-helper">
                  Start a fresh historical session instead of resuming a compatible unfinished session.
                </span>
              </div>
              <div className="config-field-input-wrap">
                <button
                  id="cfg-force-new-session"
                  type="button"
                  role="switch"
                  aria-checked={config.forceNewSession}
                  className={`config-toggle-switch ${config.forceNewSession ? "active" : ""}`}
                  onClick={() => updateConfig("forceNewSession", !config.forceNewSession)}
                >
                  <span className="config-toggle-indicator" />
                  <span className="config-toggle-text">{config.forceNewSession ? "ON" : "OFF"}</span>
                </button>
              </div>
            </div>
          </div>
        </details>
      </section>

      <div className="data-actions">
        {running ? <button className="fabriq-btn btn-danger" disabled={action || state?.status === "stopping"} onClick={() => void runAction(true)}><Square size={14} />{state?.status === "stopping" ? "Stopping…" : "Stop"}</button>
          : <button className="fabriq-btn btn-primary" disabled={action || startDisabled} onClick={() => void runAction(false)}><Play size={14} />{action ? "Starting…" : "Build Wallet Intelligence"}</button>}
        <span className="data-muted">Success requires the final end-to-end audit to pass.</span>
      </div>
      <details className="data-logs" onToggle={(event) => setLogsExpanded(event.currentTarget.open)}>
        <summary><Terminal size={14} /> Pipeline logs <span>{state?.logs.length ?? "—"} lines</span></summary>
        <button className="secondary-button" disabled={!state?.logs.length} onClick={() => void copyLogs()}><Copy size={13} />{copied ? "Copied" : "Copy logs"}</button>
        <pre ref={logRef}>{state?.logs.length ? state.logs.join("\n") : "No logs available."}</pre>
      </details>
    </section>
  );
}
