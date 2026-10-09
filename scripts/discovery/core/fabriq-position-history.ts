import fs from "fs";
import path from "path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FABRIQ_API_BASE = "https://apinew.fabriq.trade";
const CDP_URL = "http://127.0.0.1:9222";
const MAX_RETRIES = 3;
const MAX_CDP_RETRIES = 2;
const CDP_INIT_TIMEOUT_MS = 15_000;

export type CdpErrorCode =
    | "CDP_UNREACHABLE"
    | "CDP_PROTOCOL_TIMEOUT"
    | "CDP_SESSION_DISCONNECTED"
    | "FABRIQ_TAB_MISSING"
    | "AUTH_SESSION_ERROR"
    | "CLOUDFLARE_WAITING"
    | "FABRIQ_API_ERROR"
    | "RATE_LIMITED";

export function stripAnsi(str: string): string {
    if (typeof str !== "string") return String(str ?? "");
    return str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

export class FabriqCdpError extends Error {
    code: CdpErrorCode;
    stageNumber: number;
    stageName: string;
    retriesAttempted: number;
    elapsedMs: number;
    recommendedAction: string;
    underlyingError: string;

    constructor(options: {
        code: CdpErrorCode;
        stageNumber: number;
        stageName: string;
        message: string;
        retriesAttempted?: number;
        elapsedMs?: number;
        recommendedAction: string;
        underlyingError?: unknown;
    }) {
        const cleanMsg = stripAnsi(options.message);
        super(cleanMsg);
        this.name = "FabriqCdpError";
        this.code = options.code;
        this.stageNumber = options.stageNumber;
        this.stageName = options.stageName;
        this.retriesAttempted = options.retriesAttempted ?? 0;
        this.elapsedMs = options.elapsedMs ?? 0;
        this.recommendedAction = options.recommendedAction;
        this.underlyingError = stripAnsi(
            options.underlyingError instanceof Error
                ? options.underlyingError.message
                : String(options.underlyingError || cleanMsg)
        );
    }

    formatUserMessage(): string {
        return (
            `[${this.code}] Stage ${this.stageNumber} (${this.stageName}) failed. ` +
            `Error: ${this.underlyingError}. ` +
            `Retries: ${this.retriesAttempted}. Elapsed: ${(this.elapsedMs / 1000).toFixed(1)}s. ` +
            `Action: ${this.recommendedAction}`
        );
    }
}

export function logStage(
    stageNumber: number,
    stageName: string,
    message: string,
    log?: (msg: string) => void
) {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] [STAGE ${stageNumber}/10: ${stageName}] ${message}`;
    if (log) {
        log(formatted);
    } else {
        console.log(formatted);
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error("Operation aborted"));
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Operation aborted"));
    };
    timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
}

let cdpBrowser: Browser | null = null;
let fabriqPage: Page | null = null;
let token: string | null = null;
let tokenExpiresAt = 0;
let tokenRefreshPromise: Promise<string> | null = null;
export function setFabriqTokenForTesting(testToken: string | null, expiresAtMs = Date.now() + 3600_000): void {
    token = testToken;
    tokenExpiresAt = expiresAtMs;
}


function decodeJwtExpiry(tokenStr: string): number {
    try {
        const payload = tokenStr.split(".")[1];
        if (!payload) {
            return 0;
        }

        const json = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8")
        );

        if (!json.exp) {
            return 0;
        }

        return json.exp * 1000;
    } catch {
        return 0;
    }
}

async function probeCdpHttpEndpoint(): Promise<{ webSocketDebuggerUrl?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
        const res = await fetch(`${CDP_URL}/json/version`, {
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        return data as { webSocketDebuggerUrl?: string };
    } finally {
        clearTimeout(timeout);
    }
}

async function probeWebSocketUrl(wsUrl: string): Promise<void> {
    if (!wsUrl) return;
    return new Promise((resolve, reject) => {
        let done = false;
        let ws: any = null;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try { ws?.close(); } catch {}
            reject(new Error("WebSocket handshake timed out (2.5s)"));
        }, 2500);

        try {
            ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { ws.close(); } catch {}
                resolve();
            };
            ws.onerror = (err: any) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error("WebSocket connection error"));
            };
        } catch (err: any) {
            clearTimeout(timer);
            reject(err);
        }
    });
}

export async function getFabriqPage(log?: (msg: string) => void): Promise<Page> {
    const t0 = Date.now();

    // Reuse existing page if healthy
    if (cdpBrowser && cdpBrowser.isConnected() && fabriqPage && !fabriqPage.isClosed()) {
        return fabriqPage;
    }

    // If browser disconnected, clean up stale references
    if (cdpBrowser && !cdpBrowser.isConnected()) {
        try { await cdpBrowser.close(); } catch {}
        cdpBrowser = null;
        fabriqPage = null;
    }

    let wsUrl: string | undefined;

    // STAGE 1: CDP HTTP endpoint availability
    logStage(1, "CDP_ENDPOINT", `Checking CDP HTTP endpoint at ${CDP_URL}/json/version`, log);
    try {
        const versionInfo = await probeCdpHttpEndpoint();
        wsUrl = versionInfo.webSocketDebuggerUrl;
        logStage(1, "CDP_ENDPOINT", "CDP HTTP endpoint responded successfully", log);
    } catch (err: any) {
        throw new FabriqCdpError({
            code: "CDP_UNREACHABLE",
            stageNumber: 1,
            stageName: "CDP HTTP endpoint availability",
            message: `Brave remote debugging endpoint is unreachable on port 9222: ${err?.message || err}`,
            elapsedMs: Date.now() - t0,
            recommendedAction: "Start Brave browser with '--remote-debugging-port=9222' enabled.",
            underlyingError: err,
        });
    }

    // STAGE 2: Browser WebSocket connection
    if (wsUrl) {
        logStage(2, "BROWSER_WS", "Verifying browser WebSocket connection...", log);
        try {
            await probeWebSocketUrl(wsUrl);
            logStage(2, "BROWSER_WS", "Browser WebSocket connection verified", log);
        } catch (err: any) {
            logStage(2, "BROWSER_WS", `WebSocket probe non-fatal warning: ${err?.message || err}. Proceeding with CDP attach...`, log);
        }
    }

    // STAGE 3: CDP protocol initialization (Bounded with retries)
    logStage(3, "CDP_PROTOCOL", `Initializing CDP protocol session (timeout: ${CDP_INIT_TIMEOUT_MS / 1000}s, max retries: ${MAX_CDP_RETRIES})...`, log);
    let connectionAttempt = 0;
    let lastCdpError: any = null;

    while (connectionAttempt <= MAX_CDP_RETRIES) {
        connectionAttempt++;
        try {
            cdpBrowser = await chromium.connectOverCDP(CDP_URL, {
                timeout: CDP_INIT_TIMEOUT_MS,
            });
            logStage(3, "CDP_PROTOCOL", `CDP protocol initialized successfully (attempt ${connectionAttempt})`, log);
            break;
        } catch (err: any) {
            lastCdpError = err;
            const isTimeout = String(err?.message || "").includes("Timeout");
            logStage(
                3,
                "CDP_PROTOCOL",
                `CDP connection attempt ${connectionAttempt}/${MAX_CDP_RETRIES + 1} failed: ${err?.message || err}`,
                log
            );

            // Safe cleanup of partial connection
            if (cdpBrowser) {
                try { await cdpBrowser.close(); } catch {}
                cdpBrowser = null;
            }

            if (connectionAttempt <= MAX_CDP_RETRIES) {
                await sleep(1500);
            } else {
                throw new FabriqCdpError({
                    code: isTimeout ? "CDP_PROTOCOL_TIMEOUT" : "CDP_SESSION_DISCONNECTED",
                    stageNumber: 3,
                    stageName: "CDP protocol initialization",
                    message: `CDP protocol initialization failed after ${connectionAttempt} attempts: ${lastCdpError?.message || lastCdpError}`,
                    retriesAttempted: connectionAttempt - 1,
                    elapsedMs: Date.now() - t0,
                    recommendedAction: isTimeout
                        ? "Brave CDP protocol stalled. Close any hung Cloudflare challenge tabs, DevTools inspector tabs, or background tabs in Brave."
                        : "Ensure Brave remains open and accessible.",
                    underlyingError: lastCdpError,
                });
            }
        }
    }

    if (!cdpBrowser) {
        throw new FabriqCdpError({
            code: "CDP_SESSION_DISCONNECTED",
            stageNumber: 3,
            stageName: "CDP protocol initialization",
            message: "CDP browser instance was not established.",
            elapsedMs: Date.now() - t0,
            recommendedAction: "Check Brave browser status.",
        });
    }

    // STAGE 4: Browser context discovery
    logStage(4, "BROWSER_CONTEXT", "Discovering browser contexts...", log);
    const contexts = cdpBrowser.contexts();
    const context = contexts[0];
    if (!context) {
        throw new FabriqCdpError({
            code: "CDP_SESSION_DISCONNECTED",
            stageNumber: 4,
            stageName: "Browser context discovery",
            message: "No active Brave context found. Brave has no open window.",
            elapsedMs: Date.now() - t0,
            recommendedAction: "Ensure at least one Brave window is open.",
        });
    }
    logStage(4, "BROWSER_CONTEXT", `Discovered browser context with ${context.pages().length} open pages`, log);

    // STAGE 5: Fabriq tab discovery
    logStage(5, "FABRIQ_TAB", "Locating open Fabriq tab (fabriq.trade)...", log);
    let page = context.pages().find((p) => p.url().includes("fabriq.trade")) ?? null;

    if (!page) {
        // Give up to 1.5s for tab URL state to settle if newly opened
        await sleep(1500);
        page = context.pages().find((p) => p.url().includes("fabriq.trade")) ?? null;
    }

    if (!page) {
        throw new FabriqCdpError({
            code: "FABRIQ_TAB_MISSING",
            stageNumber: 5,
            stageName: "Fabriq tab discovery",
            message: "No tab with URL matching 'fabriq.trade' was found in Brave.",
            elapsedMs: Date.now() - t0,
            recommendedAction: "Open https://fabriq.trade in Brave and keep the tab open.",
        });
    }

    fabriqPage = page;
    logStage(5, "FABRIQ_TAB", `Fabriq page located: ${page.url()}`, log);
    return fabriqPage;
}

async function refreshTokenFromBrowser(log?: (msg: string) => void): Promise<string> {
    const t0 = Date.now();
    const page = await getFabriqPage(log);

    // STAGE 6: /auth/verify request
    logStage(6, "AUTH_VERIFY", "Sending /auth/verify request in Fabriq tab...", log);

    while (true) {
        if (page.isClosed()) {
            fabriqPage = null;
            throw new FabriqCdpError({
                code: "CDP_SESSION_DISCONNECTED",
                stageNumber: 6,
                stageName: "/auth/verify request",
                message: "Fabriq tab was closed during authentication.",
                elapsedMs: Date.now() - t0,
                recommendedAction: "Re-open https://fabriq.trade in Brave and keep it open.",
            });
        }

        let result: { status: number; text: string };
        try {
            result = await page.evaluate(async () => {
                const response = await fetch("/auth/verify", {
                    credentials: "include",
                    cache: "no-store",
                });
                return {
                    status: response.status,
                    text: await response.text(),
                };
            });
        } catch (evalErr: any) {
            fabriqPage = null;
            throw new FabriqCdpError({
                code: "AUTH_SESSION_ERROR",
                stageNumber: 6,
                stageName: "/auth/verify request",
                message: `Failed to evaluate /auth/verify in Fabriq tab: ${evalErr?.message || evalErr}`,
                elapsedMs: Date.now() - t0,
                recommendedAction: "Check Fabriq tab state in Brave.",
                underlyingError: evalErr,
            });
        }

        if (result.status === 403) {
            logStage(
                6,
                "AUTH_VERIFY",
                "[CLOUDFLARE_WAITING] /auth/verify blocked by Cloudflare (403) — waiting 5s and retrying...",
                log
            );
            await sleep(5000);
            continue;
        }

        if (result.status !== 200) {
            throw new FabriqCdpError({
                code: "AUTH_SESSION_ERROR",
                stageNumber: 6,
                stageName: "/auth/verify request",
                message: `/auth/verify returned HTTP ${result.status}: ${result.text.slice(0, 150)}`,
                elapsedMs: Date.now() - t0,
                recommendedAction: "Refresh https://fabriq.trade in Brave and ensure you are logged in.",
            });
        }

        // STAGE 7: JWT authentication
        logStage(7, "JWT_AUTH", "Extracting and validating session JWT from /auth/verify response...", log);
        let json: any;
        try {
            json = JSON.parse(result.text);
        } catch (parseErr: any) {
            throw new FabriqCdpError({
                code: "AUTH_SESSION_ERROR",
                stageNumber: 7,
                stageName: "JWT authentication",
                message: "Failed to parse JSON response from /auth/verify",
                elapsedMs: Date.now() - t0,
                recommendedAction: "Log into Fabriq in Brave.",
                underlyingError: parseErr,
            });
        }

        if (!json.token) {
            throw new FabriqCdpError({
                code: "AUTH_SESSION_ERROR",
                stageNumber: 7,
                stageName: "JWT authentication",
                message: "JWT missing from /auth/verify response.",
                elapsedMs: Date.now() - t0,
                recommendedAction: "Log into https://fabriq.trade in Brave to generate a session token.",
            });
        }

        token = String(json.token);
        tokenExpiresAt = decodeJwtExpiry(token) || Date.now() + 45_000;

        const secondsLeft = Math.max(
            0,
            Math.floor((tokenExpiresAt - Date.now()) / 1000)
        );

        logStage(7, "JWT_AUTH", `JWT validated successfully (expires in ${secondsLeft}s)`, log);
        return token;
    }
}

export async function getToken(
    forceRefresh = false,
    log?: (msg: string) => void
): Promise<string> {
    if (!forceRefresh && token && Date.now() < tokenExpiresAt - 10_000) {
        return token;
    }

    if (!tokenRefreshPromise) {
        tokenRefreshPromise = refreshTokenFromBrowser(log).finally(() => {
            tokenRefreshPromise = null;
        });
    }

    return tokenRefreshPromise;
}


export async function closeFabriqConnection(): Promise<void> {
    if (cdpBrowser) {
        try {
            await cdpBrowser.close();
        } catch {
            // Ignore error on CDP disconnect
        } finally {
            cdpBrowser = null;
            fabriqPage = null;
        }
    }
}

export const cleanupFabriqConnection = closeFabriqConnection;

export function isFabriqDlmmPool(rowOrPool: any): boolean {
    if (!rowOrPool) return false;
    const pool = rowOrPool.pool || rowOrPool;
    const dex = String(pool?.dex || rowOrPool?.dex || "").trim().toUpperCase();
    return dex === "METEORA_DLMM" || dex === "DLMM" || dex.includes("DLMM");
}

export interface FabriqPoolMetadata {
    binStep?: number | null;
    [key: string]: any;
}

export interface FabriqPoolRecord {
    pool_id: string;
    position_count?: number;
    position_count_wallet?: number;
    position_count_hawkfi?: number;
    total_add_usd?: number;
    total_add_sol?: number;
    total_rem_usd?: number;
    total_rem_sol?: number;
    total_fee_usd?: number;
    total_fee_sol?: number;
    total_pnl_usd?: number;
    total_pnl_sol?: number;
    total_pnl_pct_usd?: number;
    total_pnl_pct_sol?: number;
    latest_close_ts?: string | number | null;
    earliest_open_ts?: string | number | null;
    duration?: number | null;
    pool?: any;
    parsedParams?: FabriqPoolMetadata | null;
}

export interface FabriqPositionRecord {
    id: string;
    pool_id: string;
    source: string;
    total_add_usd: number;
    total_add_sol: number;
    total_rem_usd: number;
    total_rem_sol: number;
    total_fee_usd: number;
    total_fee_sol: number;
    total_pnl_usd: number;
    total_pnl_sol: number;
    total_pnl_pct_usd: number;
    total_pnl_pct_sol: number;
    latest_close_ts: string | null;
    opened_at: string | null;
    raw?: any;
}

export interface FabriqTransactionEvent {
    rawId: string;
    rawType: string;
    category: "initialize" | "add" | "remove" | "claim_fee" | "close" | "unknown";
    positionId: string;
    poolId: string;
    createdAt: string;
    signature: string;
    source: string;
    tokenXAmount: number;
    tokenYAmount: number;
    tokenXAmountUsd: number;
    tokenYAmountUsd: number;
    tokenXAmountSol: number;
    tokenYAmountSol: number;
    totalInUsd: number;
    totalInSol: number;
    raw?: any;
}

export interface FabriqClosedPositionHistoryScope {
    protocol: "meteora_dlmm";
    poolUniverse: "legacy_dlmm" | "fabriq_dlmm";
    canonicalPoolFilterApplied: boolean;
    fabriqPoolsDiscovered: number;
    eligibleLegacyPools: number;
    excludedNonLegacyPools: number;
    eligibleLegacyPoolsAfterLimit?: number;
}

export interface FetchFabriqHistoryOptions {
    maxPools?: number;
    positionBatchSize?: number;
    canonicalPoolsPath?: string;
    onLog?: (msg: string) => void;
}

export interface FabriqClosedPositionHistoryResult {
    wallet: string;
    pools: FabriqPoolRecord[];
    positions: FabriqPositionRecord[];
    events: FabriqTransactionEvent[];
    poolPagesFetched: number;
    poolsFetched: number;
    positionsFetched: number;
    transactionEventsFetched: number;
    uniquePositions: number;
    uniquePools: number;
    eventTypeCounts: Record<string, number>;
    unknownTypes: Record<string, number>;
    walletSourcePositions: number;
    hawkfiSourcePositions: number;
    scope: FabriqClosedPositionHistoryScope;
}

export function loadCanonicalLegacyDlmmPoolAddresses(
    customPath?: string
): Set<string> {
    const primaryPath = customPath
        ? path.resolve(customPath)
        : path.resolve("data/pools/legacy-dlmm-pools.json");

    if (!fs.existsSync(primaryPath)) {
        throw new Error(
            `[FAIL CLOSED] Canonical Legacy DLMM pools file not found: ${primaryPath}`
        );
    }

    let parsed: any;
    try {
        const raw = fs.readFileSync(primaryPath, "utf8");
        parsed = JSON.parse(raw);
    } catch (err: any) {
        throw new Error(
            `[FAIL CLOSED] Failed to read or parse canonical Legacy DLMM pools file (${primaryPath}): ${err?.message || err}`
        );
    }

    const poolList = Array.isArray(parsed?.pools) ? parsed.pools : null;
    if (!poolList || poolList.length === 0) {
        throw new Error(
            `[FAIL CLOSED] Canonical pools list missing or empty in: ${primaryPath}`
        );
    }

    const addresses = new Set<string>();
    for (const pool of poolList) {
        if (!pool || typeof pool !== "object") continue;

        // Preserve project rule: pairType === 0
        if (pool.pairType !== undefined && pool.pairType !== 0) {
            continue;
        }

        const addr =
            typeof pool.address === "string" && pool.address.trim().length > 0
                ? pool.address.trim()
                : typeof pool.id === "string" && pool.id.trim().length > 0
                ? pool.id.trim()
                : null;

        if (addr) {
            addresses.add(addr);
        }
    }

    if (addresses.size === 0) {
        throw new Error(
            `[FAIL CLOSED] Canonical pool address field cannot be determined or no eligible pools found in: ${primaryPath}`
        );
    }

    return addresses;
}

export function parseRetryAfterHeader(headerValue: string | null | undefined, defaultSeconds = 5): number {
    if (!headerValue) return defaultSeconds;
    const trimmed = headerValue.trim();
    if (!trimmed) return defaultSeconds;
    const delta = Number(trimmed);
    if (Number.isFinite(delta) && delta >= 0) {
        return Math.ceil(delta);
    }
    const parsedDateMs = Date.parse(trimmed);
    if (!Number.isNaN(parsedDateMs)) {
        const diffSeconds = (parsedDateMs - Date.now()) / 1000;
        return Math.max(1, Math.ceil(diffSeconds));
    }
    return defaultSeconds;
}

export function calculateBoundedJitter(maxJitterMs = 500): number {
    if (maxJitterMs <= 0) return 0;
    return Math.floor(Math.random() * maxJitterMs);
}

export interface FabriqFetchCooldownCoordinator {
    record429(cooldownMs: number): void;
    waitForCooldown(signal?: AbortSignal): Promise<void>;
    getRemainingCooldownMs(): number;
    reset(): void;
}

export class SharedCooldownCoordinator implements FabriqFetchCooldownCoordinator {
    private cooldownUntilMs = 0;
    private log?: (msg: string) => void;

    constructor(log?: (msg: string) => void) {
        this.log = log;
    }

    record429(cooldownMs: number): void {
        const candidate = Date.now() + Math.max(0, cooldownMs);
        if (candidate > this.cooldownUntilMs) {
            this.cooldownUntilMs = candidate;
        }
    }

    async waitForCooldown(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw signal.reason ?? new Error("Operation aborted");
        }
        const waitMs = this.cooldownUntilMs - Date.now();
        if (waitMs > 0) {
            this.log?.(`[COOLDOWN] Pausing for ${Math.round(waitMs)}ms due to active 429 rate limit cooldown across concurrent requests...`);
            await sleep(waitMs, signal);
        }
    }

    getRemainingCooldownMs(): number {
        return Math.max(0, this.cooldownUntilMs - Date.now());
    }

    reset(): void {
        this.cooldownUntilMs = 0;
    }
}

export interface FabriqFetchOptions {
    onLog?: (msg: string) => void;
    maxRetries?: number;
    retryDelayMs?: number;
    max404Retries?: number;
    delay404Ms?: number;
    startTimeMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    cooldownCoordinator?: FabriqFetchCooldownCoordinator;
    jitterMs?: number;
    onRetry?: (info: { status?: number; attempt: number; delayMs: number; error?: unknown }) => void;
}

export async function fabriqFetch<T>(
    endpoint: string,
    params?: URLSearchParams,
    options?: FabriqFetchOptions,
    attempt = 1,
    attempt404 = 0
): Promise<T> {
    const maxRetries = options?.maxRetries ?? MAX_RETRIES;
    const queryString = params?.toString() ? `?${params.toString()}` : "";
    const url = `${FABRIQ_API_BASE}${endpoint}${queryString}`;
    const log = options?.onLog;

    logStage(8, "FABRIQ_API", `Fetching endpoint ${endpoint} (attempt ${attempt}/${maxRetries})...`, log);
    if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error("Operation aborted");
    }

    if (options?.cooldownCoordinator) {
        await options.cooldownCoordinator.waitForCooldown(options.signal);
    }

    try {
        const jwt = await getToken(false, log);

        let timeoutId: NodeJS.Timeout | undefined;
        let fetchSignal: AbortSignal | undefined = options?.signal;
        let timeoutController: AbortController | undefined;

        if (options?.timeoutMs && options.timeoutMs > 0) {
            timeoutController = new AbortController();
            timeoutId = setTimeout(() => {
                timeoutController?.abort(new Error(`Request timed out after ${options.timeoutMs}ms`));
            }, options.timeoutMs);

            if (options.signal) {
                fetchSignal = AbortSignal.any([options.signal, timeoutController.signal]);
            } else {
                fetchSignal = timeoutController.signal;
            }
        }

        let response: Response;
        try {
            response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: "application/json",
                },
                signal: fetchSignal,
            });
        } finally {
            clearTimeout(timeoutId);
        }

        // --------------------------------
        // JWT expired/rejected (401)
        // --------------------------------
        if (response.status === 401) {
            if (attempt >= maxRetries) {
                throw new FabriqCdpError({
                    code: "AUTH_SESSION_ERROR",
                    stageNumber: 8,
                    stageName: "Fabriq history API request",
                    message: "401 Unauthorized after JWT refresh retries.",
                    retriesAttempted: attempt,
                    recommendedAction: "Refresh session in Brave by visiting https://fabriq.trade.",
                });
            }
            options?.onRetry?.({ status: 401, attempt, delayMs: 0 });
            log?.("[AUTH] 401 → refreshing JWT");
            await getToken(true, log);

            return fabriqFetch<T>(endpoint, params, options, attempt + 1, attempt404);
        }

        // --------------------------------
        // Cloudflare / forbidden (403)
        // --------------------------------
        if (response.status === 403) {
            throw new FabriqCdpError({
                code: "FABRIQ_API_ERROR",
                stageNumber: 8,
                stageName: "Fabriq history API request",
                message: "403 Forbidden on direct Fabriq API. Session is invalid or blocked.",
                retriesAttempted: attempt - 1,
                recommendedAction: "Verify your Fabriq session permissions at https://fabriq.trade in Brave.",
            });
        }

        // --------------------------------
        // Data not ready (404)
        // --------------------------------
        if (response.status === 404) {
            const max404 = options?.max404Retries;
            const delay = options?.delay404Ms ?? 5000;
            const startTime = options?.startTimeMs ?? Date.now();
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

            if (typeof max404 === "number" && attempt404 >= max404) {
                logStage(
                    8,
                    "FABRIQ_API",
                    `[FABRIQ] 404 Not Found for ${endpoint} after ${attempt404} retries (${elapsedSec}s elapsed). Bounded retry limit reached.`,
                    log
                );
                throw new FabriqCdpError({
                    code: "DATA_NOT_FOUND",
                    stageNumber: 8,
                    stageName: "Fabriq history API request",
                    message: `HTTP 404 Not Found from Fabriq API for ${endpoint} after ${attempt404} retries (${elapsedSec}s elapsed).`,
                    retriesAttempted: attempt404,
                    elapsedMs: Date.now() - startTime,
                    recommendedAction: "Wallet has no indexed history on Fabriq or endpoint is unavailable.",
                });
            }

            const nextAttempt404 = attempt404 + 1;
            const limitStr = typeof max404 === "number" ? ` (attempt ${nextAttempt404}/${max404}, elapsed ${elapsedSec}s)` : "";
            logStage(8, "FABRIQ_API", `[FABRIQ] 404 data not ready for ${endpoint}${limitStr}; waiting ${Math.round(delay / 1000)}s and retrying...`, log);
            options?.onRetry?.({ status: 404, attempt: nextAttempt404, delayMs: delay });
            await sleep(delay, options?.signal);
            return fabriqFetch<T>(
                endpoint,
                params,
                { ...options, startTimeMs: startTime },
                typeof max404 === "number" ? attempt : 1,
                nextAttempt404
            );
        }

        // --------------------------------
        // Rate limit (429)
        // --------------------------------
        if (response.status === 429) {
            const retryAfterSec = parseRetryAfterHeader(response.headers.get("retry-after"), 5);
            const jitterMs = calculateBoundedJitter(options?.jitterMs ?? 500);
            const cooldownMs = retryAfterSec * 1000 + jitterMs;

            if (options?.cooldownCoordinator) {
                options.cooldownCoordinator.record429(cooldownMs);
            }

            if (attempt >= maxRetries) {
                throw new FabriqCdpError({
                    code: "RATE_LIMITED",
                    stageNumber: 8,
                    stageName: "Fabriq history API request",
                    message: `429 Too Many Requests after ${attempt} retries.`,
                    retriesAttempted: attempt,
                    recommendedAction: `Wait ${retryAfterSec} seconds before requesting Fabriq API again.`,
                });
            }

            logStage(8, "FABRIQ_API", `[RATE_LIMITED] Waiting ${retryAfterSec}s (attempt ${attempt}/${maxRetries})...`, log);
            await sleep(cooldownMs, options?.signal);

            return fabriqFetch<T>(endpoint, params, options, attempt + 1, attempt404);
        }

        // --------------------------------
        // Server error (5xx)
        // --------------------------------
        if (response.status >= 500) {
            if (attempt >= maxRetries) {
                throw new FabriqCdpError({
                    code: "FABRIQ_API_ERROR",
                    stageNumber: 8,
                    stageName: "Fabriq history API request",
                    message: `Server error ${response.status} from Fabriq API`,
                    retriesAttempted: attempt,
                    recommendedAction: "Fabriq backend service is temporarily encountering errors. Try again shortly.",
                });
            }

            const jitterMs = calculateBoundedJitter(options?.jitterMs ?? 500);
            const delay = options?.retryDelayMs !== undefined ? options.retryDelayMs : (attempt * 2000 + jitterMs);
            options?.onRetry?.({ status: response.status, attempt, delayMs: delay });
            logStage(8, "FABRIQ_API", `[RETRY] Server ${response.status}, waiting ${delay}ms...`, log);
            await sleep(delay, options?.signal);

            return fabriqFetch<T>(endpoint, params, options, attempt + 1, attempt404);
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
        }

        return (await response.json()) as T;
    } catch (error: unknown) {
        if (options?.signal?.aborted) {
            throw options.signal.reason ?? error;
        }

        if (error instanceof FabriqCdpError) {
            throw error;
        }

        const msg = error instanceof Error ? error.message : String(error ?? "");
        if (
            msg.includes("403 Forbidden") ||
            msg.includes("No Brave context found") ||
            msg.includes("Fabriq tab not found") ||
            msg.includes("/auth/verify failed") ||
            msg.includes("JWT missing") ||
            attempt >= maxRetries
        ) {
            throw error;
        }

        const jitterMs = calculateBoundedJitter(options?.jitterMs ?? 500);
        const delay = options?.retryDelayMs !== undefined ? options.retryDelayMs : (attempt * 2000 + jitterMs);
        options?.onRetry?.({ attempt, delayMs: delay, error });
        logStage(8, "FABRIQ_API", `[RETRY] Attempt ${attempt} failed: ${msg}, waiting ${delay}ms...`, log);
        await sleep(delay, options?.signal);
        return fabriqFetch<T>(endpoint, params, options, attempt + 1, attempt404);
    }
}

function parsePoolParamsDefensively(params: any): FabriqPoolMetadata | null {
    if (!params) return null;
    let parsed: any = null;

    if (typeof params === "object") {
        parsed = params;
    } else if (typeof params === "string") {
        try {
            parsed = JSON.parse(params);
        } catch {
            return null;
        }
    }

    if (!parsed || typeof parsed !== "object") return null;

    const binStep =
        parsed.bin_step !== undefined
            ? Number(parsed.bin_step)
            : parsed.binStep !== undefined
            ? Number(parsed.binStep)
            : null;

    return {
        ...parsed,
        binStep,
    };
}

export async function fetchFabriqClosedPositionHistory(
    wallet: string,
    options?: FetchFabriqHistoryOptions
): Promise<FabriqClosedPositionHistoryResult> {
    const log = options?.onLog || ((msg: string) => console.log(msg));
    const maxPools = options?.maxPools ?? 0;
    const positionBatchSize = Math.max(1, options?.positionBatchSize ?? 20);

    log(`[FABRIQ-DISC] Starting closed-position discovery for wallet: ${wallet}`);

    // Pre-flight check: load canonical Legacy DLMM pool set only if custom path explicitly provided
    let canonicalLegacyPoolAddresses: Set<string> | null = null;
    if (options?.canonicalPoolsPath) {
        canonicalLegacyPoolAddresses = loadCanonicalLegacyDlmmPoolAddresses(
            options.canonicalPoolsPath
        );
    }

    // 1. Fetch all closed pool rows via GET /history/<WALLET>/pnl-by-pool
    const rawFabriqPools: FabriqPoolRecord[] = [];
    let poolPagesFetched = 0;
    let page = 1;

    while (true) {
        poolPagesFetched++;
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", "100");
        params.set("sortBy", "latest_close_ts");
        params.set("sortOrder", "desc");
        params.set("pnlCurrency", "USD");
        params.set("timezone", "Asia/Jakarta");
        params.append("sources", "wallet");
        params.append("sources", "hawkfi");
        params.set("pnlScope", "pool");
        params.set("lastCloseScope", "pool");
        params.set("durationScope", "pool");
        params.set("depositsScope", "pool");
        params.set("withdrawalsScope", "pool");
        params.set("feesScope", "pool");

        log(`[FABRIQ-DISC] Fetching pool history page ${page}...`);
        const resJson = await fabriqFetch<any>(
            `/history/${wallet}/pnl-by-pool`,
            params,
            { onLog: log }
        );

        const dataNode = resJson?.data ?? resJson;
        const pageItems: any[] = Array.isArray(dataNode)
            ? dataNode
            : Array.isArray(dataNode?.items)
            ? dataNode.items
            : Array.isArray(dataNode?.pools)
            ? dataNode.pools
            : Array.isArray(dataNode?.data)
            ? dataNode.data
            : [];

        if (pageItems.length === 0) {
            break;
        }

        for (const row of pageItems) {
            const poolId =
                row.pool_id ||
                row.poolId ||
                row.pool?.id ||
                row.pool?.address ||
                row.id;

            if (!poolId) continue;

            const parsedParams = parsePoolParamsDefensively(row.pool?.params);

            rawFabriqPools.push({
                pool_id: String(poolId),
                position_count: Number(row.position_count ?? 0),
                position_count_wallet: Number(row.position_count_wallet ?? 0),
                position_count_hawkfi: Number(row.position_count_hawkfi ?? 0),
                total_add_usd: Number(row.total_add_usd ?? 0),
                total_add_sol: Number(row.total_add_sol ?? 0),
                total_rem_usd: Number(row.total_rem_usd ?? 0),
                total_rem_sol: Number(row.total_rem_sol ?? 0),
                total_fee_usd: Number(row.total_fee_usd ?? 0),
                total_fee_sol: Number(row.total_fee_sol ?? 0),
                total_pnl_usd: Number(row.total_pnl_usd ?? 0),
                total_pnl_sol: Number(row.total_pnl_sol ?? 0),
                total_pnl_pct_usd: Number(row.total_pnl_pct_usd ?? 0),
                total_pnl_pct_sol: Number(row.total_pnl_pct_sol ?? 0),
                latest_close_ts: row.latest_close_ts ?? null,
                earliest_open_ts: row.earliest_open_ts ?? null,
                duration: row.duration !== undefined ? Number(row.duration) : null,
                pool: row.pool,
                parsedParams,
            });
        }

        log(
            `[FABRIQ-DISC] Page ${page}: fetched ${pageItems.length} pools (total: ${rawFabriqPools.length})`
        );

        if (pageItems.length < 100) {
            break;
        }

        page++;
    }

    // Deduplicate raw Fabriq pools by pool_id
    const seenRawPoolIds = new Set<string>();
    const deduplicatedRawPools: FabriqPoolRecord[] = [];
    for (const p of rawFabriqPools) {
        if (!seenRawPoolIds.has(p.pool_id)) {
            seenRawPoolIds.add(p.pool_id);
            deduplicatedRawPools.push(p);
        }
    }

    const fabriqPoolsDiscovered = deduplicatedRawPools.length;

    // 2. Filter Fabriq pool records explicitly classified as DLMM
    const dlmmMatches = deduplicatedRawPools.filter((p) => {
        if (canonicalLegacyPoolAddresses) {
            return canonicalLegacyPoolAddresses.has(p.pool_id);
        }
        return isFabriqDlmmPool(p);
    });
    const excludedCount = fabriqPoolsDiscovered - dlmmMatches.length;

    log(`[FABRIQ-DISC] Fabriq pools discovered: ${fabriqPoolsDiscovered}`);
    log(`[FABRIQ-DISC] Fabriq DLMM matches: ${dlmmMatches.length}`);
    log(`[FABRIQ-DISC] Non-DLMM pools excluded: ${excludedCount}`);

    // Apply maxPools AFTER DLMM filtering
    let pools = dlmmMatches;
    if (maxPools > 0) {
        pools = dlmmMatches.slice(0, maxPools);
        log(`[FABRIQ-DISC] Eligible DLMM pools after limit: ${pools.length}`);
    }

    const eligibleLegacyPools = dlmmMatches.length;
    const scope: FabriqClosedPositionHistoryScope = {
        protocol: "meteora_dlmm",
        poolUniverse: canonicalLegacyPoolAddresses ? "legacy_dlmm" : "fabriq_dlmm",
        canonicalPoolFilterApplied: Boolean(canonicalLegacyPoolAddresses),
        fabriqPoolsDiscovered,
        eligibleLegacyPools: dlmmMatches.length,
        excludedNonLegacyPools: excludedCount,
        ...(maxPools > 0 ? { eligibleLegacyPoolsAfterLimit: pools.length } : {}),
    };

    // 3. Discover individual position IDs via GET /history/<WALLET>/positions-by-pool
    const positions: FabriqPositionRecord[] = [];
    const poolIds = pools.map((p) => p.pool_id);
    const allowedPoolIds = new Set(poolIds);

    const poolBatchSize = 25;
    for (let i = 0; i < poolIds.length; i += poolBatchSize) {
        const batch = poolIds.slice(i, i + poolBatchSize);
        const params = new URLSearchParams();
        params.set("poolIds", batch.join(","));
        params.append("sources", "wallet");
        params.append("sources", "hawkfi");
        params.set("timezone", "Asia/Jakarta");
        params.set("pnlCurrency", "USD");
        params.set("pnlScope", "pool");
        params.set("lastCloseScope", "pool");
        params.set("durationScope", "pool");
        params.set("depositsScope", "pool");
        params.set("withdrawalsScope", "pool");
        params.set("feesScope", "pool");

        log(
            `[FABRIQ-DISC] Fetching positions for pool batch ${Math.floor(i / poolBatchSize) + 1}/${Math.ceil(poolIds.length / poolBatchSize)} (${batch.length} pools)...`
        );

        const posRes = await fabriqFetch<any>(
            `/history/${wallet}/positions-by-pool`,
            params,
            { onLog: log }
        );

        const resData = posRes?.data ?? posRes;

        if (resData && typeof resData === "object" && !Array.isArray(resData)) {
            for (const [poolId, posList] of Object.entries(resData)) {
                if (!allowedPoolIds.has(String(poolId))) continue;
                if (Array.isArray(posList)) {
                    for (const pos of posList) {
                        if (!pos?.id) continue;
                        positions.push({
                            id: String(pos.id),
                            pool_id: String(poolId),
                            source: String(pos.source ?? "wallet"),
                            total_add_usd: Number(pos.total_add_usd ?? 0),
                            total_add_sol: Number(pos.total_add_sol ?? 0),
                            total_rem_usd: Number(pos.total_rem_usd ?? 0),
                            total_rem_sol: Number(pos.total_rem_sol ?? 0),
                            total_fee_usd: Number(pos.total_fee_usd ?? 0),
                            total_fee_sol: Number(pos.total_fee_sol ?? 0),
                            total_pnl_usd: Number(pos.total_pnl_usd ?? 0),
                            total_pnl_sol: Number(pos.total_pnl_sol ?? 0),
                            total_pnl_pct_usd: Number(pos.total_pnl_pct_usd ?? 0),
                            total_pnl_pct_sol: Number(pos.total_pnl_pct_sol ?? 0),
                            latest_close_ts: pos.latest_close_ts
                                ? String(pos.latest_close_ts)
                                : null,
                            opened_at: pos.opened_at ? String(pos.opened_at) : null,
                            raw: pos,
                        });
                    }
                }
            }
        } else if (Array.isArray(resData)) {
            for (const pos of resData) {
                if (!pos?.id) continue;
                const poolId = String(pos.pool_id || pos.poolId || "");
                if (poolId && !allowedPoolIds.has(poolId)) continue;
                positions.push({
                    id: String(pos.id),
                    pool_id: poolId,
                    source: String(pos.source ?? "wallet"),
                    total_add_usd: Number(pos.total_add_usd ?? 0),
                    total_add_sol: Number(pos.total_add_sol ?? 0),
                    total_rem_usd: Number(pos.total_rem_usd ?? 0),
                    total_rem_sol: Number(pos.total_rem_sol ?? 0),
                    total_fee_usd: Number(pos.total_fee_usd ?? 0),
                    total_fee_sol: Number(pos.total_fee_sol ?? 0),
                    total_pnl_usd: Number(pos.total_pnl_usd ?? 0),
                    total_pnl_sol: Number(pos.total_pnl_sol ?? 0),
                    total_pnl_pct_usd: Number(pos.total_pnl_pct_usd ?? 0),
                    total_pnl_pct_sol: Number(pos.total_pnl_pct_sol ?? 0),
                    latest_close_ts: pos.latest_close_ts
                        ? String(pos.latest_close_ts)
                        : null,
                    opened_at: pos.opened_at ? String(pos.opened_at) : null,
                    raw: pos,
                });
            }
        }
    }

    log(`[FABRIQ-DISC] Total positions discovered across pools: ${positions.length}`);

    // Deduplicate positions by position ID
    const uniquePositionsMap = new Map<string, FabriqPositionRecord>();
    for (const pos of positions) {
        if (!uniquePositionsMap.has(pos.id)) {
            uniquePositionsMap.set(pos.id, pos);
        }
    }
    const deduplicatedPositions = Array.from(uniquePositionsMap.values());

    // 3. Fetch lifecycle transaction records via GET /history/transactions?positionIds=...
    const allPositionIds = deduplicatedPositions.map((p) => p.id);
    const events: FabriqTransactionEvent[] = [];
    const eventTypeCounts: Record<string, number> = {};
    const unknownTypes: Record<string, number> = {};

    const positionToPoolMap = new Map<string, string>();
    for (const pos of deduplicatedPositions) {
        positionToPoolMap.set(pos.id, pos.pool_id);
    }

    for (let i = 0; i < allPositionIds.length; i += positionBatchSize) {
        const batch = allPositionIds.slice(i, i + positionBatchSize);
        const params = new URLSearchParams();
        params.set("positionIds", batch.join(","));

        log(
            `[FABRIQ-DISC] Fetching transactions for position batch ${Math.floor(i / positionBatchSize) + 1}/${Math.ceil(allPositionIds.length / positionBatchSize)} (${batch.length} positions)...`
        );

        const txRes = await fabriqFetch<any>(`/history/transactions`, params, {
            onLog: log,
        });

        const txData = txRes?.data ?? txRes;

        const rawEventList: any[] = [];

        if (txData && typeof txData === "object" && !Array.isArray(txData)) {
            for (const [posId, list] of Object.entries(txData)) {
                if (Array.isArray(list)) {
                    for (const item of list) {
                        rawEventList.push({
                            ...item,
                            position_id: item.position_id || item.positionId || posId,
                        });
                    }
                }
            }
        } else if (Array.isArray(txData)) {
            rawEventList.push(...txData);
        }

        for (const tx of rawEventList) {
            const rawType = String(tx.type || tx.rawType || tx.action || "UNKNOWN");
            eventTypeCounts[rawType] = (eventTypeCounts[rawType] || 0) + 1;

            let category: "initialize" | "add" | "remove" | "claim_fee" | "close" | "unknown";
            if (rawType === "POSITION_OPEN") {
                category = "initialize";
            } else if (rawType === "ADD_LIQUIDITY") {
                category = "add";
            } else if (rawType === "REMOVE_LIQUIDITY") {
                category = "remove";
            } else if (rawType === "FEE_CLAIM") {
                category = "claim_fee";
            } else if (rawType === "POSITION_CLOSE") {
                category = "close";
            } else {
                category = "unknown";
                unknownTypes[rawType] = (unknownTypes[rawType] || 0) + 1;
            }

            const positionId = String(
                tx.position_id || tx.positionId || tx.position || ""
            );
            const poolId =
                tx.pool_id ||
                tx.poolId ||
                positionToPoolMap.get(positionId) ||
                "";

            const rawId = String(tx.id || tx._id || "");
            const createdAt = String(
                tx.created_at || tx.createdAt || tx.timestamp || ""
            );
            const signature = String(
                tx.signature || tx.tx_hash || tx.txHash || ""
            );
            const source = String(tx.source || "");

            events.push({
                rawId,
                rawType,
                category,
                positionId,
                poolId,
                createdAt,
                signature,
                source,
                tokenXAmount: Number(tx.token_x_amount ?? tx.tokenXAmount ?? 0),
                tokenYAmount: Number(tx.token_y_amount ?? tx.tokenYAmount ?? 0),
                tokenXAmountUsd: Number(
                    tx.token_x_amount_usd ?? tx.tokenXAmountUsd ?? 0
                ),
                tokenYAmountUsd: Number(
                    tx.token_y_amount_usd ?? tx.tokenYAmountUsd ?? 0
                ),
                tokenXAmountSol: Number(
                    tx.token_x_amount_sol ?? tx.tokenXAmountSol ?? 0
                ),
                tokenYAmountSol: Number(
                    tx.token_y_amount_sol ?? tx.tokenYAmountSol ?? 0
                ),
                totalInUsd: Number(
                    tx.total_in_usd ?? tx.totalInUsd ?? tx.total_usd ?? 0
                ),
                totalInSol: Number(
                    tx.total_in_sol ?? tx.totalInSol ?? tx.total_sol ?? 0
                ),
                raw: tx,
            });
        }
    }

    log(`[FABRIQ-DISC] Total transaction events fetched: ${events.length}`);

    let walletSourcePositions = 0;
    let hawkfiSourcePositions = 0;

    for (const pos of deduplicatedPositions) {
        if (pos.source === "hawkfi") {
            hawkfiSourcePositions++;
        } else {
            walletSourcePositions++;
        }
    }

    const uniquePoolsSet = new Set(pools.map((p) => p.pool_id));

    return {
        wallet,
        pools,
        positions: deduplicatedPositions,
        events,
        poolPagesFetched,
        poolsFetched: pools.length,
        positionsFetched: deduplicatedPositions.length,
        transactionEventsFetched: events.length,
        uniquePositions: deduplicatedPositions.length,
        uniquePools: uniquePoolsSet.size,
        eventTypeCounts,
        unknownTypes,
        walletSourcePositions,
        hawkfiSourcePositions,
        scope,
    };
}
