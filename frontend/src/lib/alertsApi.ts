export const ALERTS_API_BASE = "http://127.0.0.1:8787";

export type EngineStatus =
  | "IDLE"
  | "INITIALIZING"
  | "RUNNING"
  | "PAUSED"
  | "STOPPED"
  | "DEGRADED"
  | "OFFLINE";

export interface CoverageGap {
  walletAddress: string;
  reason: string;
  signature?: string;
  timestamp: number;
}

export interface AlertsStatus {
  status: EngineStatus;
  isDegraded: boolean;
  sdkCompatible: boolean;
  monitoredWalletsCount: number;
  activePositionsCount: number;
  totalPolls: number;
  totalEventsEmitted: number;
  lastPollAt: number | null;
  retryCount: number;
  errorCount: number;
  coverageGaps: CoverageGap[];
  bufferedEventsCount: number;
  bufferedPreviewsCount: number;
  configuredPollIntervalMs?: number;
  effectivePollIntervalMs?: number | null;
  lastSuccessfulPollAt?: number | null;
  lastPollDurationMs?: number | null;
  rpcErrorCount?: number;
  http429Count?: number;
  totalPollsAttempted?: number;
  totalPollsSuccessful?: number;
  totalPollsPartial?: number;
  totalPollsFailed?: number;
  walletStatus?: Record<
    string,
    {
      isDegraded: boolean;
      hasCoverageGap: boolean;
      consecutiveErrors: number;
      lastPollAt: number | null;
      lastSignature: string | null;
    }
  >;
}

export interface WatchlistWallet {
  address: string;
  alias: string | null;
  enabled: boolean;
  addedAt: number;
  updatedAt: number;
}

export interface ActivePosition {
  positionAddress: string;
  owner: string;
  poolAddress: string;
  version: "V1" | "V2";
  hasLiquidity: boolean;
  discoveredAt: number;
  lastUpdatedAt: number;
}

export type DlmmEventType =
  | "POSITION_OPENED"
  | "LIQUIDITY_ADDED"
  | "LIQUIDITY_REMOVED"
  | "POSITION_CLOSED"
  | "FEES_CLAIMED";

export interface DlmmAlertEvent {
  id: string;
  eventType: DlmmEventType;
  walletAddress: string;
  positionAddress: string;
  poolAddress: string;
  signature: string;
  slot: number;
  blockTime: number;
  instructionIndex: number;
  source: "top-level" | "inner";
  signer: string;
  feePayer: string | null;
  operator: string | null;
  instructionName: string;
  detectedAt: number;
}

export interface VerifiedAmounts {
  tokenA?: { amount: string; symbol?: string };
  tokenB?: { amount: string; symbol?: string };
  verified: boolean;
}

export interface TelegramPreview {
  id: string;
  eventId: string;
  eventType: DlmmEventType;
  walletAddress: string;
  walletAlias: string | null;
  poolAddress: string;
  positionAddress: string;
  walletRole: string;
  signature: string;
  slot: number;
  blockTime: number;
  timestamp: string;
  commitment: "finalized";
  explorerUrl: string;
  amounts: VerifiedAmounts | null;
  messageText: string;
  status: "PREVIEW_ONLY";
  generatedAt: number;
}

export function isValidSolanaAddress(address: string | undefined | null): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(options?.headers || {}),
    },
  });

  const contentType = res.headers.get("content-type") || "";
  let data: unknown = null;
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    let errorMessage = `Request failed with HTTP status ${res.status}`;
    if (data && typeof data === "object" && "error" in data) {
      const candidate = data.error;
      if (typeof candidate === "string" && candidate.trim()) {
        errorMessage = candidate;
      }
    }
    throw new Error(errorMessage);
  }

  return data as T;
}

export async function fetchAlertsStatus(): Promise<AlertsStatus> {
  return requestJson<AlertsStatus>(`${ALERTS_API_BASE}/api/alerts/status`);
}

export async function fetchWatchlist(): Promise<WatchlistWallet[]> {
  const data = await requestJson<{ wallets: WatchlistWallet[]; totalCount: number }>(
    `${ALERTS_API_BASE}/api/alerts/wallets`
  );
  return data.wallets || [];
}

export async function addWatchlistWallet(
  address: string,
  alias?: string
): Promise<WatchlistWallet> {
  const payload: { address: string; alias?: string; enabled: boolean } = {
    address: address.trim(),
    enabled: false,
  };
  if (alias && alias.trim()) {
    payload.alias = alias.trim();
  }

  const data = await requestJson<{ success: boolean; wallet: WatchlistWallet }>(
    `${ALERTS_API_BASE}/api/alerts/wallets`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  return data.wallet;
}

export async function startWalletMonitoring(
  address: string
): Promise<{ success: boolean; wallet: WatchlistWallet; engineStatus: string }> {
  return requestJson<{ success: boolean; wallet: WatchlistWallet; engineStatus: string }>(
    `${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(address)}/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function pauseWalletMonitoring(
  address: string
): Promise<{ success: boolean; wallet: WatchlistWallet; status: string }> {
  return requestJson<{ success: boolean; wallet: WatchlistWallet; status: string }>(
    `${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(address)}/pause`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function resumeWalletMonitoring(
  address: string
): Promise<{ success: boolean; wallet: WatchlistWallet; engineStatus: string }> {
  return requestJson<{ success: boolean; wallet: WatchlistWallet; engineStatus: string }>(
    `${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(address)}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function removeWatchlistWallet(
  address: string
): Promise<{ success: boolean; removed: string }> {
  return requestJson<{ success: boolean; removed: string }>(
    `${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(address)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function updateWatchlistWallet(
  address: string,
  patch: { alias?: string | null; enabled?: boolean }
): Promise<{ success: boolean; wallet: WatchlistWallet }> {
  return requestJson<{ success: boolean; wallet: WatchlistWallet }>(
    `${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(address)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
}

export async function fetchActivePositions(wallet?: string): Promise<ActivePosition[]> {
  const url = new URL(`${ALERTS_API_BASE}/api/alerts/positions`);
  if (wallet && wallet.trim()) {
    url.searchParams.set("wallet", wallet.trim());
  }
  const data = await requestJson<{ positions: ActivePosition[]; totalCount: number }>(
    url.toString()
  );
  return data.positions || [];
}

export async function fetchAlertEvents(params?: {
  limit?: number;
  wallet?: string;
  eventType?: string;
}): Promise<DlmmAlertEvent[]> {
  const url = new URL(`${ALERTS_API_BASE}/api/alerts/events`);
  if (params?.limit) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params?.wallet && params.wallet.trim()) {
    url.searchParams.set("wallet", params.wallet.trim());
  }
  if (params?.eventType && params.eventType.trim()) {
    url.searchParams.set("eventType", params.eventType.trim());
  }
  const data = await requestJson<{ events: DlmmAlertEvent[]; totalCount: number }>(
    url.toString()
  );
  return data.events || [];
}

export async function fetchTelegramPreviews(params?: {
  limit?: number;
  wallet?: string;
  eventType?: string;
}): Promise<TelegramPreview[]> {
  const url = new URL(`${ALERTS_API_BASE}/api/alerts/previews`);
  if (params?.limit) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params?.wallet && params.wallet.trim()) {
    url.searchParams.set("wallet", params.wallet.trim());
  }
  if (params?.eventType && params.eventType.trim()) {
    url.searchParams.set("eventType", params.eventType.trim());
  }
  const data = await requestJson<{ previews: TelegramPreview[]; totalCount: number }>(
    url.toString()
  );
  return data.previews || [];
}

export async function startAlertsEngine(): Promise<{ success: boolean; status: string }> {
  return requestJson<{ success: boolean; status: string }>(
    `${ALERTS_API_BASE}/api/alerts/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function pauseAlertsEngine(): Promise<{ success: boolean; status: string }> {
  return requestJson<{ success: boolean; status: string }>(
    `${ALERTS_API_BASE}/api/alerts/pause`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function resumeAlertsEngine(): Promise<{ success: boolean; status: string }> {
  return requestJson<{ success: boolean; status: string }>(
    `${ALERTS_API_BASE}/api/alerts/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
}

export function isPollingStale(
  status: AlertsStatus | null | undefined,
  now = Date.now()
): boolean {
  if (!status) return false;
  const effectiveStatus = status.status;
  if (effectiveStatus !== "RUNNING" && effectiveStatus !== "DEGRADED") {
    return false;
  }

  const cadence = status.configuredPollIntervalMs ?? 5000;
  const threshold = Math.max(cadence * 3, 15000);

  const lastSuccessful = status.lastSuccessfulPollAt;
  if (typeof lastSuccessful === "number" && lastSuccessful > 0) {
    return now - lastSuccessful > threshold;
  }

  const lastAttempt = status.lastPollAt;
  if (typeof lastAttempt === "number" && lastAttempt > 0) {
    return now - lastAttempt > threshold;
  }

  if ((status.totalPolls > 0 || (status.totalPollsAttempted ?? 0) > 0) && !lastSuccessful && !lastAttempt) {
    return true;
  }

  return false;
}

export function getRpcHealthPresentation(
  effectiveStatus: EngineStatus,
  status: AlertsStatus | null,
  now = Date.now()
): { label: string; color: string } {
  if (!status || effectiveStatus === "OFFLINE") {
    return { label: "Offline", color: "var(--red, #f44336)" };
  }
  if (effectiveStatus === "PAUSED") {
    return { label: "Monitoring Paused", color: "var(--amber, #f1c84d)" };
  }
  if (effectiveStatus === "DEGRADED") {
    if (isPollingStale(status, now)) {
      return { label: "Degraded (Stale)", color: "var(--amber, #f1c84d)" };
    }
    const errorCount = status.rpcErrorCount ?? 0;
    return {
      label: errorCount > 0 ? `Degraded (${errorCount} errors)` : "Degraded Polling",
      color: "var(--amber, #f1c84d)",
    };
  }
  if (effectiveStatus === "RUNNING") {
    if (isPollingStale(status, now)) {
      return { label: "Stale Polling", color: "var(--amber, #f1c84d)" };
    }
    const errorCount = status.rpcErrorCount ?? 0;
    const rateLimitCount = status.http429Count ?? 0;
    if (errorCount === 0 && rateLimitCount === 0) {
      return { label: "100% Operational", color: "var(--green, #55d69d)" };
    }
    return { label: "Operational (Past Errors)", color: "var(--green, #55d69d)" };
  }
  if (effectiveStatus === "INITIALIZING") {
    return { label: "Initializing", color: "var(--blue, #5ba4e6)" };
  }
  if (effectiveStatus === "STOPPED") {
    return { label: "Engine Stopped", color: "var(--muted, #8c8882)" };
  }
  return { label: "Idle", color: "var(--muted, #8c8882)" };
}

export function getProtocolIndicator(
  status: AlertsStatus | null
): { label: string; color: string } {
  if (!status) return { label: "—", color: "var(--muted, #8c8882)" };
  if ((status as any)?.sdkVerified) {
    return { label: "DLMM SDK v2 (Verified)", color: "var(--green, #55d69d)" };
  }
  if (status.sdkCompatible) {
    return { label: "DLMM SDK v2 (Compatible)", color: "var(--green, #55d69d)" };
  }
  return { label: "Meteora IDL Core", color: "var(--muted, #8c8882)" };
}

export function formatWib(timestamp: number | null | undefined): string {
  if (!timestamp || timestamp <= 0) return "—";
  const d = new Date(timestamp);
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

export function formatLastSuccessfulPoll(
  statusOrTimestamp: AlertsStatus | number | null | undefined
): string {
  const ts =
    typeof statusOrTimestamp === "number"
      ? statusOrTimestamp
      : statusOrTimestamp?.lastSuccessfulPollAt;
  if (typeof ts === "number" && ts > 0) {
    return formatWib(ts);
  }
  return "Awaiting First Successful Poll";
}
