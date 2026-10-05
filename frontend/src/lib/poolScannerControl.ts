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
  | "extract"
  | "extract_completed"
  | "fabriq"
  | "master_upsert"
  | "publish"
  | "completed"
  | "error"
  | "stopped";

export interface CurrentPoolInfo {
  pair: string;
  binStep: number | null;
  baseFeePct: number | null;
  poolAddress: string;
}

export interface PoolScannerState {
  status: PoolScannerStatus;
  stage: PoolScannerStage;
  tokenCa: string | null;
  fabriqWorkers?: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  running: boolean;
  resumable?: boolean;
  resumableTokenCa?: string | null;
  stage1Complete?: boolean;
  stage2Complete?: boolean;
  pipelineComplete?: boolean;
  selectedPools?: string[];
  selectedPoolCount?: number;
  completedPoolCount?: number;
  uniqueWallets?: number;
  currentPool?: CurrentPoolInfo | null;
}

export interface PoolDiscoveryItem {
  poolAddress: string;
  pair: string;
  tokenMint: string;
  solMint: string;
  tokenX: string;
  tokenY: string;
  binStep: number | null;
  baseFeePct: number | null;
}

export interface PoolDiscoveryResponse {
  tokenMint: string;
  solMint: string;
  pairRule: string;
  discoveredAt: string;
  poolCount: number;
  pools: PoolDiscoveryItem[];
}

export async function discoverTokenPools(
  tokenCa: string
): Promise<PoolDiscoveryResponse> {
  const response = await fetch(`${POOL_SCANNER_API_BASE}/api/pool-scanner/discover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tokenCa: tokenCa.trim(),
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Pool discovery failed with status ${response.status}`
    );
  }
  return payload;
}

export async function getPoolScannerStatus(tokenCa?: string): Promise<PoolScannerState> {
  const url = tokenCa
    ? `${POOL_SCANNER_API_BASE}/api/pool-scanner/status?token=${encodeURIComponent(tokenCa)}`
    : `${POOL_SCANNER_API_BASE}/api/pool-scanner/status`;
  const response = await fetch(url, {
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

export async function startPoolScanner(
  tokenCa: string,
  fabriqWorkers = 2
): Promise<PoolScannerState> {
  const response = await fetch(`${POOL_SCANNER_API_BASE}/api/pool-scanner/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tokenCa: tokenCa.trim(),
      fabriqWorkers,
    }),
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

export async function scanSelectedPools(
  tokenCa: string,
  poolAddresses: string[]
): Promise<PoolScannerState> {
  const response = await fetch(`${POOL_SCANNER_API_BASE}/api/pool-scanner/scan-selected`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tokenCa: tokenCa.trim(),
      poolAddresses,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Scan Selected Pools failed with status ${response.status}`
    );
  }
  return payload;
}

