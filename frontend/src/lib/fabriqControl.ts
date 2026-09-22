export const FABRIQ_API_BASE = "http://127.0.0.1:8787";

export type FabriqStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "error";

export type FabriqStage =
  | "idle"
  | "enrich"
  | "merge"
  | "publish"
  | "completed"
  | "error";

export type FabriqMode = "stale" | "full";

export interface FabriqState {
  status: FabriqStatus;
  stage: FabriqStage;
  mode: FabriqMode | null;
  concurrency: number | null;
  refreshBefore: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  runtimeSeconds: number;
  logs: string[];
  running: boolean;
}

export interface FabriqEvent {
  type: "init" | "status" | "stage" | "progress" | "log" | "finish" | "error";
  state: FabriqState;
  log?: string;
}

export async function getFabriqStatus(): Promise<FabriqState> {
  const response = await fetch(`${FABRIQ_API_BASE}/api/fabriq/status`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Fabriq status (${response.status})`);
  }
  return response.json();
}

export async function startFabriqRefresh(params: {
  mode: FabriqMode;
  concurrency?: number;
}): Promise<FabriqState> {
  const response = await fetch(`${FABRIQ_API_BASE}/api/fabriq/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: params.mode,
      concurrency: params.concurrency ?? 10,
      resume: false,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Refresh failed with status ${response.status}`);
  }
  return payload;
}

export async function stopFabriqRefresh(): Promise<FabriqState> {
  const response = await fetch(`${FABRIQ_API_BASE}/api/fabriq/stop`, {
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

export async function resumeFabriqRefresh(params?: {
  concurrency?: number;
}): Promise<FabriqState> {
  const response = await fetch(`${FABRIQ_API_BASE}/api/fabriq/resume`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      concurrency: params?.concurrency ?? 10,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Resume failed with status ${response.status}`);
  }
  return payload;
}

export function subscribeFabriqEvents(
  onEvent: (event: FabriqEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const eventSource = new EventSource(`${FABRIQ_API_BASE}/api/fabriq/events`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onEvent(data);
    } catch (err) {
      console.error("Failed to parse Fabriq SSE event:", err);
    }
  };

  if (onError) {
    eventSource.onerror = (err) => {
      onError(err);
    };
  }

  return () => {
    eventSource.close();
  };
}
