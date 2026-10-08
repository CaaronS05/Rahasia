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

export interface SingleWalletIntelligenceStatus {
  wallet: string;
  status: "idle" | "running" | "completed" | "error" | "reference_required";
  stage: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  hasResult: boolean;
}

export interface SingleWalletPerformance {
  totalPnl: number;
  profitFactor: number;
  medianPositionPnlPct: number;
  positionWinRate: number;
  closedPositionCount: number;
  pnlConcentrationTop1: number;
}

export interface SingleWalletIntelligenceResult {
  wallet: string;
  analyzedAt: string;
  referenceCohort: {
    version: "v1";
    generatedAt: string;
    validWallets: number;
    qualityThresholdP75: number;
    riskThresholdP25: number;
  };
  qualityScore: number;
  riskScore: number;
  confidenceScore: number;
  style: "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";
  shortlisted: boolean;
  performance: SingleWalletPerformance;
  shortlistReasons: {
    qualityPass: boolean;
    riskPass: boolean;
    confidencePass: boolean;
    profitabilityGuardrailsPass: boolean;
  };
  rawMetrics: {
    medianPositionPnlPct: number;
    profitFactor: number;
    positionWinRate: number;
    pnlConcentrationTop1: number;
    cvar10PositionPnlPct: number;
    negativeDayRate: number;
    medianLosingPositionPnlPct: number;
    closedPositionCount: number;
    totalPnl: number;
    historySpanDays: number;
  };
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

// ======================================================
// SINGLE WALLET INTELLIGENCE CLIENT API
// ======================================================

export async function getSingleWalletStatus(address: string): Promise<SingleWalletIntelligenceStatus> {
  const response = await fetch(`${API_BASE}/api/wallet-intelligence/single/${encodeURIComponent(address)}/status`, {
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Failed to get wallet status (${response.status})`);
  return payload;
}

export async function startSingleWalletAnalysis(
  address: string,
  force = false
): Promise<SingleWalletIntelligenceStatus> {
  const response = await fetch(`${API_BASE}/api/wallet-intelligence/single/${encodeURIComponent(address)}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Failed to start wallet analysis (${response.status})`);
  return payload;
}

export async function getSingleWalletResult(
  address: string
): Promise<SingleWalletIntelligenceResult | null> {
  const response = await fetch(`${API_BASE}/api/wallet-intelligence/single/${encodeURIComponent(address)}/result`, {
    cache: "no-store",
  });
  if (response.status === 404) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Failed to get wallet result (${response.status})`);
  return payload;
}
