export const POOL_SCANNER_API_BASE = "http://127.0.0.1:8787";

export type PoolScannerStatus =
  | "idle"
  | "running"
  | "completed"
  | "error"
  | "stopped";

export type PoolScannerStage =
  | "idle"
  | "discovery"
  | "fabriq"
  | "master_upsert"
  | "publish"
  | "completed"
  | "error"
  | "stopped";

export interface PoolScannerState {
  status: PoolScannerStatus;
  stage: PoolScannerStage;
  tokenCa: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  running: boolean;
}

export async function getPoolScannerStatus(): Promise<PoolScannerState> {
  const response = await fetch(`${POOL_SCANNER_API_BASE}/api/pool-scanner/status`, {
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Failed to fetch Pool Scanner status (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function startPoolScanner(tokenCa: string): Promise<PoolScannerState> {
  const response = await fetch(`${POOL_SCANNER_API_BASE}/api/pool-scanner/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tokenCa: tokenCa.trim() }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Pool Scanner start failed with status ${response.status}`
    );
  }
  return payload;
}

export async function stopPoolScanner(): Promise<PoolScannerState> {
  const response = await fetch(`${POOL_SCANNER_API_BASE}/api/pool-scanner/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Failed to stop Pool Scanner (${response.status})`
    );
  }
  return payload;
}
