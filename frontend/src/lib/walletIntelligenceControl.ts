const API_BASE = "http://127.0.0.1:8787";

export const INTELLIGENCE_STAGES = [
  { key: "historical_cohort", label: "Historical Cohort" },
  { key: "quality", label: "Quality" },
  { key: "risk_metrics", label: "Risk Metrics" },
  { key: "risk_score", label: "Risk Score" },
  { key: "confidence", label: "Confidence" },
  { key: "style_readiness", label: "Style Readiness" },
  { key: "style", label: "Style Classification" },
  { key: "shortlist", label: "Shortlist" },
  { key: "publish", label: "Publish" },
  { key: "audit", label: "Audit" },
] as const;

export type IntelligenceStageKey = typeof INTELLIGENCE_STAGES[number]["key"];
export type IntelligenceStageStatus = "pending" | "running" | "completed" | "error" | "stopped";
export type WalletIntelligenceStatus = "idle" | "running" | "stopping" | "completed" | "error" | "stopped";
export interface WalletIntelligenceState {
  status: WalletIntelligenceStatus;
  stage: IntelligenceStageKey | "idle" | "completed" | "error" | "stopped";
  stageStates: Record<IntelligenceStageKey, IntelligenceStageStatus>;
  startedAt: string | null;
  finishedAt: string | null;
  lastPublishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  runtimeSeconds: number;
  running: boolean;
}

async function requestState(endpoint: string, method = "GET"): Promise<WalletIntelligenceState> {
  const response = await fetch(`${API_BASE}/api/wallet-intelligence/${endpoint}`, {
    method,
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Wallet Intelligence request failed (${response.status})`);
  return payload;
}

export const getWalletIntelligenceStatus = () => requestState("status");
export const startWalletIntelligence = () => requestState("start", "POST");
export const stopWalletIntelligence = () => requestState("stop", "POST");
