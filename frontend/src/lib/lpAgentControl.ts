export const LPAGENT_API_BASE = "http://127.0.0.1:8787";

export type LpAgentStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "error";

export type LpAgentStage =
  | "idle"
  | "scrape"
  | "merge_wallets"
  | "fabriq_enrich"
  | "fabriq_merge"
  | "publish"
  | "completed"
  | "stopped"
  | "error";

export interface LpAgentState {
  status: LpAgentStatus;
  stage: LpAgentStage;

  concurrency: number;
  fabriqConcurrency: number;

  startedAt: string | null;
  finishedAt: string | null;

  exitCode: number | null;
  error: string | null;

  completedPages: number;
  totalPages: number;
  wallets: number;
  progressPercent: number;

  inputRows: number;
  uniqueIncoming: number;
  updatedExisting: number;
  addedNew: number;
  masterWallets: number;

  fabriqTotal: number;
  fabriqCompleted: number;
  fabriqSuccess: number;
  fabriqFailed: number;
  fabriqSkipped: number;

  runtimeSeconds: number;

  logs: string[];
  running: boolean;
}

export async function getLpAgentStatus(): Promise<LpAgentState> {
  const response = await fetch(`${LPAGENT_API_BASE}/api/lpagent/status`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch LP Agent status (${response.status})`);
  }
  return response.json();
}

export async function startLpAgentRefresh(params: {
  concurrency: number;
  fabriqConcurrency: number;
}): Promise<LpAgentState> {
  const response = await fetch(`${LPAGENT_API_BASE}/api/lpagent/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      concurrency: Math.max(1, Math.floor(params.concurrency)),
      fabriqConcurrency: Math.max(1, Math.floor(params.fabriqConcurrency)),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `LP Agent refresh failed with status ${response.status}`);
  }
  return payload;
}

export async function stopLpAgentRefresh(): Promise<LpAgentState> {
  const response = await fetch(`${LPAGENT_API_BASE}/api/lpagent/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const payload = await response.json();
  if (!response.ok && response.status !== 409) {
    throw new Error(payload.error || `Stop failed with status ${response.status}`);
  }
  return payload;
}
