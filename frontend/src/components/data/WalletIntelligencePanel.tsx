import { Check, Copy, Play, Square, Terminal } from "lucide-react";
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

export function WalletIntelligencePanel({ state, startDisabled, onStateChanged }: {
  state: WalletIntelligenceState | null;
  startDisabled: boolean;
  onStateChanged: () => Promise<void>;
}) {
  const [action, setAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const running = Boolean(state?.running);
  const stageLabel = INTELLIGENCE_STAGES.find((stage) => stage.key === state?.stage)?.label ?? state?.stage ?? "—";
  const status = state?.status === "idle" ? "ready" : state?.status ?? "unavailable";

  useEffect(() => {
    if (logsExpanded && running && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logsExpanded, running, state?.logs]);

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
