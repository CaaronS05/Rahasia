import { PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { WatchlistStore, type WatchlistEntry } from "./watchlist-store.ts";
import { loadMeteoraIdl, type MeteoraIdlBundle } from "../discovery/core/meteora-idl.ts";
import {
    normalizeTransactionInstructions,
    type NormalizedInstruction,
} from "../discovery/core/transaction-normalizer.ts";
import {
    decodeLpInstruction,
    classifyInstructionCategory,
    type DecodedLpInstruction,
} from "../discovery/core/lp-instruction-decoder.ts";
import { rpcCall, sleep } from "../discovery/core/rpc.ts";
import { loadDiscoveryConfig } from "../discovery/core/config.ts";

export type DlmmEventType =
    | "POSITION_OPENED"
    | "LIQUIDITY_ADDED"
    | "LIQUIDITY_REMOVED"
    | "POSITION_CLOSED"
    | "FEES_CLAIMED";

export interface ActivePosition {
    positionAddress: string;
    owner: string;
    poolAddress: string;
    version: "V1" | "V2";
    hasLiquidity: boolean;
    discoveredAt: number;
    lastUpdatedAt: number;
}

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
    parentIndex?: number | null;
    source: "outer" | "inner" | "top-level";
    subEventIndex?: number;
    signer: string;
    feePayer: string | null;
    operator: string | null;
    instructionName: string;
    detectedAt: number;
}

export interface SessionCursor {
    walletAddress: string;
    lastSignature: string | null;
    lastSlot: number | null;
    lastPollAt: number | null;
    isDegraded: boolean;
    consecutiveErrors: number;
}

export type EngineStatus =
    | "IDLE"
    | "INITIALIZING"
    | "RUNNING"
    | "PAUSED"
    | "STOPPED"
    | "DEGRADED";

export interface CoverageGap {
    walletAddress: string;
    reason: string;
    signature?: string;
    timestamp: number;
}

export interface EngineHealth {
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
    configuredPollIntervalMs: number;
    effectivePollIntervalMs: number | null;
    lastSuccessfulPollAt: number | null;
    lastPollDurationMs: number | null;
    rpcErrorCount: number;
    http429Count: number;
    totalPollsAttempted: number;
    totalPollsSuccessful: number;
    totalPollsPartial: number;
    totalPollsFailed: number;
    walletStatus: Record<
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

export interface SignatureItem {
    signature: string;
    slot: number;
    err: unknown;
    blockTime?: number;
}

export interface AlertsRpcClient {
    getSignaturesForAddress(
        address: string,
        options?: { limit?: number; before?: string; until?: string; commitment?: string }
    ): Promise<SignatureItem[]>;
    getTransaction(
        signature: string,
        options?: { encoding?: string; commitment?: string; maxSupportedTransactionVersion?: number }
    ): Promise<unknown>;
    getProgramAccounts?(
        programId: string,
        config?: {
            commitment?: string;
            encoding?: string;
            filters?: Array<{ memcmp: { offset: number; bytes: string } }>;
            dataSlice?: { offset: number; length: number };
        }
    ): Promise<Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>>;
    rpcCall?<T>(method: string, params: unknown[]): Promise<T>;
}

export const ALERTS_POLL_INTERVAL_MS = 5000;

export interface AlertsEngineConfig {
    watchlistStore?: WatchlistStore;
    watchlistPath?: string;
    rpcUrl?: string;
    meteoraDlmmProgramId?: string;
    pollIntervalMs?: number;
    commitment?: "finalized" | "confirmed";
    maxRetries?: number;
    retryDelayMs?: number;
    getTxConcurrency?: number;
    maxRecentActivity?: number;
    requestTimeoutMs?: number;
    rpcClient?: AlertsRpcClient;
    autoStart?: boolean;
}

// Discriminator constants
export const POSITION_V2_DISCRIMINATOR_BS58 = "LgkNAEYaVX3"; // [117, 176, 212, 199, 245, 180, 133, 182]
export const POSITION_V1_DISCRIMINATOR_BS58 = "VZMoMoKgZQb"; // [170, 188, 143, 228, 122, 64, 247, 208]
export const POSITION_V2_DISCRIMINATOR_BYTES = Buffer.from([117, 176, 212, 199, 245, 180, 133, 182]);
export const POSITION_V1_DISCRIMINATOR_BYTES = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

export class DefaultAlertsRpcClient implements AlertsRpcClient {
    private rpcUrl: string;
    private maxRetries: number;
    private commitment: string;
    private requestTimeoutMs: number;
    public http429Count = 0;
    public rpcErrorCount = 0;

    constructor(rpcUrl: string, maxRetries = 3, commitment = "finalized", requestTimeoutMs = 15_000) {
        if (commitment !== "finalized") {
            throw new Error(`Commitment must be strictly finalized, got: ${commitment}`);
        }
        this.rpcUrl = rpcUrl;
        this.maxRetries = Math.max(0, maxRetries);
        this.commitment = "finalized";
        this.requestTimeoutMs = Math.max(100, requestTimeoutMs);
    }

    public getStats(): { http429Count: number; rpcErrorCount: number } {
        return {
            http429Count: this.http429Count,
            rpcErrorCount: this.rpcErrorCount,
        };
    }

    public async call<T>(method: string, params: unknown[]): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
            try {
                const response = await fetch(this.rpcUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: Math.floor(Math.random() * 1_000_000),
                        method,
                        params,
                    }),
                    signal: controller.signal,
                });

                if (response.status === 429) {
                    this.http429Count++;
                    const retryAfterHeader = response.headers.get("retry-after");
                    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
                    const backoff = retryAfterMs && Number.isFinite(retryAfterMs)
                        ? retryAfterMs
                        : Math.min(500 * Math.pow(2, attempt), 8000);
                    if (attempt < this.maxRetries) {
                        await sleep(backoff);
                        continue;
                    }
                    throw new Error(`HTTP 429 Too Many Requests`);
                }

                if (response.status >= 500) {
                    this.rpcErrorCount++;
                    if (attempt < this.maxRetries) {
                        await sleep(Math.min(500 * Math.pow(2, attempt), 8000));
                        continue;
                    }
                    throw new Error(`HTTP ${response.status}`);
                }

                if (!response.ok) {
                    this.rpcErrorCount++;
                    throw new Error(`HTTP ${response.status}`);
                }

                const json = (await response.json()) as {
                    result?: T;
                    error?: { code?: number; message?: string; data?: unknown };
                };

                if (json.error) {
                    if (json.error.code === 429 || json.error.code === -32005) {
                        this.http429Count++;
                    } else {
                        this.rpcErrorCount++;
                    }
                    throw new Error(json.error.message || `RPC ${method} error`);
                }

                return json.result as T;
            } catch (err: any) {
                lastError = err;
                if (err.name === "AbortError" || err.message?.includes("aborted")) {
                    this.rpcErrorCount++;
                    if (attempt < this.maxRetries) {
                        await sleep(Math.min(500 * Math.pow(2, attempt), 8000));
                        continue;
                    }
                    throw new Error(`RPC request timeout after ${this.requestTimeoutMs}ms`);
                }
                if (attempt < this.maxRetries) {
                    await sleep(Math.min(500 * Math.pow(2, attempt), 8000));
                    continue;
                }
            } finally {
                clearTimeout(timeoutId);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    async getSignaturesForAddress(
        address: string,
        options?: { limit?: number; before?: string; until?: string; commitment?: string }
    ): Promise<SignatureItem[]> {
        const opts: Record<string, unknown> = {
            limit: options?.limit ?? 100,
            commitment: "finalized",
        };
        if (options?.before) opts.before = options.before;
        if (options?.until) opts.until = options.until;

        const result = await this.call<SignatureItem[]>("getSignaturesForAddress", [address, opts]);
        return result || [];
    }

    async getTransaction(
        signature: string,
        options?: { encoding?: string; commitment?: string; maxSupportedTransactionVersion?: number }
    ): Promise<unknown> {
        const opts = {
            encoding: options?.encoding ?? "json",
            commitment: "finalized",
            maxSupportedTransactionVersion: options?.maxSupportedTransactionVersion ?? 1,
        };
        return this.call<unknown>("getTransaction", [signature, opts]);
    }

    async getProgramAccounts(
        programId: string,
        config?: {
            commitment?: string;
            encoding?: string;
            filters?: Array<{ memcmp: { offset: number; bytes: string } }>;
            dataSlice?: { offset: number; length: number };
        }
    ): Promise<Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>> {
        const opts: Record<string, unknown> = {
            encoding: config?.encoding ?? "base64",
            commitment: "finalized",
        };
        if (config?.filters) opts.filters = config.filters;
        if (config?.dataSlice) opts.dataSlice = config.dataSlice;

        const result = await this.call<Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>>(
            "getProgramAccounts",
            [programId, opts]
        );
        return result || [];
    }
}

export function verifyDlmmSdk(): boolean {
    try {
        const require = createRequire(import.meta.url);
        const dlmmModule = require("@meteora-ag/dlmm");
        const DLMM = dlmmModule.default ?? dlmmModule;
        return typeof DLMM.getAllLbPairPositionsByUser === "function" || typeof dlmmModule.wrapPosition === "function";
    } catch {
        return false;
    }
}

export class AlertsEngine {
    public readonly watchlistStore: WatchlistStore;
    private readonly rpcClient: AlertsRpcClient;
    private readonly meteoraDlmmProgramId: string;
    private readonly pollIntervalMs: number;
    private readonly commitment: "finalized" | "confirmed";
    private readonly maxRetries: number;
    private readonly retryDelayMs: number;
    private readonly getTxConcurrency: number;
    private readonly maxRecentActivity: number;
    private readonly requestTimeoutMs: number;

    private status: EngineStatus = "IDLE";
    private pollTimeout: NodeJS.Timeout | null = null;
    private idlBundle: MeteoraIdlBundle | null = null;
    private readonly sdkCompatible: boolean;

    // Session fencing generations
    private globalGeneration = 1;
    private readonly walletGenerations = new Map<string, number>();

    // In-memory structures
    private readonly activePositions = new Map<string, ActivePosition>(); // positionAddress -> ActivePosition
    private readonly sessionCursors = new Map<string, SessionCursor>(); // walletAddress -> SessionCursor
    private readonly deduplicatedEvents = new Set<string>(); // dedup key ring buffer
    private readonly dedupKeysOrder: string[] = [];
    private readonly MAX_DEDUP_KEYS = 5000;

    private readonly recentActivity: DlmmAlertEvent[] = [];
    private readonly coverageGaps: CoverageGap[] = [];
    private readonly MAX_COVERAGE_GAPS = 50;

    private readonly inFlightPolls = new Set<string>(); // prevent overlapping polls per wallet
    private isPollingCycleActive = false;

    // Telemetry tracking
    private totalPollsAttempted = 0;
    private totalPollsSuccessful = 0;
    private totalPollsPartial = 0;
    private totalPollsFailed = 0;
    private totalEventsEmitted = 0;
    private lastPollAt: number | null = null;
    private lastSuccessfulPollAt: number | null = null;
    private lastPollDurationMs: number | null = null;
    private lastPollStartAt: number | null = null;
    private effectivePollIntervalMs: number | null = null;
    private retryCount = 0;
    private errorCount = 0;

    private readonly listeners: Array<(event: DlmmAlertEvent) => void> = [];

    constructor(config?: AlertsEngineConfig) {
        // Configuration validation: reject unsafe values
        if (config?.pollIntervalMs !== undefined) {
            if (typeof config.pollIntervalMs !== "number" || !Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
                throw new Error(`Invalid pollIntervalMs: ${config.pollIntervalMs}. Must be a positive finite number.`);
            }
        }
        if (config?.commitment !== undefined && config.commitment !== "finalized") {
            throw new Error(`Commitment must be strictly finalized, got: ${config.commitment}`);
        }
        if (config?.maxRetries !== undefined && (typeof config.maxRetries !== "number" || config.maxRetries < 0)) {
            throw new Error(`Invalid maxRetries: ${config.maxRetries}. Must be an integer >= 0.`);
        }
        if (config?.getTxConcurrency !== undefined && (typeof config.getTxConcurrency !== "number" || config.getTxConcurrency < 1)) {
            throw new Error(`Invalid getTxConcurrency: ${config.getTxConcurrency}. Must be >= 1.`);
        }
        if (config?.requestTimeoutMs !== undefined && (typeof config.requestTimeoutMs !== "number" || config.requestTimeoutMs <= 0)) {
            throw new Error(`Invalid requestTimeoutMs: ${config.requestTimeoutMs}. Must be positive number.`);
        }

        const discoveryConfig = loadDiscoveryConfig();
        this.watchlistStore = config?.watchlistStore ?? new WatchlistStore(config?.watchlistPath);
        this.meteoraDlmmProgramId = config?.meteoraDlmmProgramId ?? discoveryConfig.meteoraDlmmProgramId;
        this.pollIntervalMs = config?.pollIntervalMs ?? ALERTS_POLL_INTERVAL_MS;
        this.commitment = "finalized";
        this.maxRetries = config?.maxRetries ?? 3;
        this.retryDelayMs = config?.retryDelayMs ?? 200;
        this.getTxConcurrency = config?.getTxConcurrency ?? 5;
        this.maxRecentActivity = config?.maxRecentActivity ?? 100;
        this.requestTimeoutMs = config?.requestTimeoutMs ?? 15_000;

        const rpcUrl = config?.rpcUrl ?? discoveryConfig.rpcUrl;
        this.rpcClient = config?.rpcClient ?? new DefaultAlertsRpcClient(
            rpcUrl,
            this.maxRetries,
            "finalized",
            this.requestTimeoutMs
        );
        this.sdkCompatible = verifyDlmmSdk();
    }

    public getHealth(): EngineHealth {
        const anyDegraded = Array.from(this.sessionCursors.values()).some((c) => c.isDegraded);
        const rpcStats = (this.rpcClient as any).getStats?.() || {
            http429Count: (this.rpcClient as any).http429Count ?? 0,
            rpcErrorCount: (this.rpcClient as any).rpcErrorCount ?? 0,
        };

        const walletStatus: Record<
            string,
            {
                isDegraded: boolean;
                hasCoverageGap: boolean;
                consecutiveErrors: number;
                lastPollAt: number | null;
                lastSignature: string | null;
            }
        > = {};

        for (const [addr, cursor] of this.sessionCursors.entries()) {
            const hasGap = this.coverageGaps.some((g) => g.walletAddress === addr);
            walletStatus[addr] = {
                isDegraded: cursor.isDegraded,
                hasCoverageGap: hasGap,
                consecutiveErrors: cursor.consecutiveErrors,
                lastPollAt: cursor.lastPollAt,
                lastSignature: cursor.lastSignature,
            };
        }

        return {
            status: this.status,
            isDegraded: anyDegraded || this.status === "DEGRADED",
            sdkCompatible: this.sdkCompatible,
            monitoredWalletsCount: this.sessionCursors.size,
            activePositionsCount: this.activePositions.size,
            totalPolls: this.totalPollsAttempted,
            totalEventsEmitted: this.totalEventsEmitted,
            lastPollAt: this.lastPollAt,
            retryCount: this.retryCount,
            errorCount: this.errorCount,
            coverageGaps: [...this.coverageGaps],
            configuredPollIntervalMs: this.pollIntervalMs,
            effectivePollIntervalMs: this.effectivePollIntervalMs,
            lastSuccessfulPollAt: this.lastSuccessfulPollAt,
            lastPollDurationMs: this.lastPollDurationMs,
            rpcErrorCount: this.errorCount + rpcStats.rpcErrorCount,
            http429Count: rpcStats.http429Count,
            totalPollsAttempted: this.totalPollsAttempted,
            totalPollsSuccessful: this.totalPollsSuccessful,
            totalPollsPartial: this.totalPollsPartial,
            totalPollsFailed: this.totalPollsFailed,
            walletStatus,
        };
    }

    public getActivePositions(walletAddress?: string): ActivePosition[] {
        const positions = Array.from(this.activePositions.values());
        if (walletAddress) {
            return positions.filter((p) => p.owner === walletAddress);
        }
        return positions;
    }

    public getRecentActivity(limit?: number): DlmmAlertEvent[] {
        const lim = limit ? Math.min(limit, this.recentActivity.length) : this.recentActivity.length;
        return this.recentActivity.slice(0, lim);
    }

    public onEvent(listener: (event: DlmmAlertEvent) => void): () => void {
        this.listeners.push(listener);
        return () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        };
    }

    private emitEvent(event: DlmmAlertEvent): void {
        this.recentActivity.unshift(event);
        if (this.recentActivity.length > this.maxRecentActivity) {
            this.recentActivity.pop();
        }
        this.totalEventsEmitted++;
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error("[AlertsEngine] Event listener error:", err);
            }
        }
    }

    private recordCoverageGap(walletAddress: string, reason: string, signature?: string): void {
        const gap: CoverageGap = {
            walletAddress,
            reason,
            signature,
            timestamp: Date.now(),
        };
        this.coverageGaps.unshift(gap);
        if (this.coverageGaps.length > this.MAX_COVERAGE_GAPS) {
            this.coverageGaps.pop();
        }
        this.errorCount++;
    }

    private addDedupKey(key: string): void {
        this.deduplicatedEvents.add(key);
        this.dedupKeysOrder.push(key);
        if (this.dedupKeysOrder.length > this.MAX_DEDUP_KEYS) {
            const oldest = this.dedupKeysOrder.shift();
            if (oldest) this.deduplicatedEvents.delete(oldest);
        }
    }

    private async ensureIdlLoaded(): Promise<MeteoraIdlBundle> {
        if (!this.idlBundle) {
            this.idlBundle = await loadMeteoraIdl(this.meteoraDlmmProgramId);
        }
        return this.idlBundle;
    }

    /**
     * Discover open positions belonging to a single wallet.
     * Layout-verified decoding for V1 and V2 accounts.
     * Treats position-discovery errors as errors, never as successful discovery of 0 positions.
     */
    public async discoverActivePositions(walletAddress: string): Promise<ActivePosition[]> {
        if (!this.rpcClient.getProgramAccounts) {
            throw new Error("RPC client does not support getProgramAccounts for position discovery");
        }

        const discovered: ActivePosition[] = [];

        // 1. Query PositionV2 accounts for this owner
        const accountsV2 = await this.rpcClient.getProgramAccounts(this.meteoraDlmmProgramId, {
            commitment: this.commitment,
            encoding: "base64",
            filters: [
                { memcmp: { offset: 0, bytes: POSITION_V2_DISCRIMINATOR_BS58 } },
                { memcmp: { offset: 40, bytes: walletAddress } },
            ],
        });

        // 2. Query Position (V1) accounts for this owner
        // Treat V1 discovery failures as real errors; never silently convert to zero positions
        const accountsV1 = await this.rpcClient.getProgramAccounts(this.meteoraDlmmProgramId, {
            commitment: this.commitment,
            encoding: "base64",
            filters: [
                { memcmp: { offset: 0, bytes: POSITION_V1_DISCRIMINATOR_BS58 } },
                { memcmp: { offset: 40, bytes: walletAddress } },
            ],
        });

        const parseAccounts = (
            items: Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>,
            expectedVersion: "V1" | "V2"
        ) => {
            const expectedDisc = expectedVersion === "V2" ? POSITION_V2_DISCRIMINATOR_BYTES : POSITION_V1_DISCRIMINATOR_BYTES;
            for (const item of items) {
                const pubkey = item.pubkey;
                const rawData = item.account.data;
                const buf = Buffer.isBuffer(rawData)
                    ? rawData
                    : Buffer.from(
                          typeof rawData === "string"
                              ? rawData
                              : Array.isArray(rawData) && typeof rawData[0] === "string"
                              ? rawData[0]
                              : "",
                          "base64"
                      );
                if (buf.length < 72) continue;

                // Layout-verified discriminator check
                if (!buf.subarray(0, 8).equals(expectedDisc)) {
                    continue;
                }

                // bytes 8..40: lb_pair (Pubkey)
                const lbPair = new PublicKey(buf.subarray(8, 40)).toBase58();
                // bytes 40..72: owner (Pubkey)
                const owner = new PublicKey(buf.subarray(40, 72)).toBase58();

                if (owner !== walletAddress) continue;

                let hasLiquidity = false;
                if (expectedVersion === "V1") {
                    // V1 uses 70 u64 liquidity shares (8 bytes each) starting at offset 72
                    const shareCount = 70;
                    for (let i = 0; i < shareCount; i++) {
                        const off = 72 + i * 8;
                        if (off + 8 <= buf.length) {
                            const share = buf.readBigUInt64LE(off);
                            if (share > 0n) {
                                hasLiquidity = true;
                                break;
                            }
                        }
                    }
                } else {
                    // V2 uses 70 u128 liquidity shares (16 bytes each) starting at offset 72
                    const shareCount = 70;
                    for (let i = 0; i < shareCount; i++) {
                        const off = 72 + i * 16;
                        if (off + 16 <= buf.length) {
                            const low = buf.readBigUInt64LE(off);
                            const high = buf.readBigUInt64LE(off + 8);
                            if (low > 0n || high > 0n) {
                                hasLiquidity = true;
                                break;
                            }
                        }
                    }
                }

                // Note: Zero liquidity does not mean a position is closed.
                // Positions remain active on-chain and are tracked.
                discovered.push({
                    positionAddress: pubkey,
                    owner,
                    poolAddress: lbPair,
                    version: expectedVersion,
                    hasLiquidity,
                    discoveredAt: Date.now(),
                    lastUpdatedAt: Date.now(),
                });
            }
        };

        parseAccounts(accountsV2 || [], "V2");
        parseAccounts(accountsV1 || [], "V1");

        return discovered;
    }

    /**
     * Initializes monitoring session:
     * - Loads only enabled wallets
     * - Discovers active positions into RAM
     * - Captures latest signatures as baseline cursor
     * - Emits ZERO historical alerts
     * - Prevents partial initialization on failure
     */
    public async init(): Promise<void> {
        this.status = "INITIALIZING";
        this.globalGeneration++;
        await this.ensureIdlLoaded();

        const allWallets = await this.watchlistStore.listWallets();
        const enabledWallets = allWallets.filter((w) => w.enabled);

        // Reset cursors and snapshots for fresh baseline
        this.activePositions.clear();
        this.sessionCursors.clear();

        for (const wallet of enabledWallets) {
            const gen = (this.walletGenerations.get(wallet.address) ?? 0) + 1;
            this.walletGenerations.set(wallet.address, gen);
            try {
                // 1. Establish baseline cursor first so transactions arriving during discovery are caught
                const sigs = await this.rpcClient.getSignaturesForAddress(wallet.address, {
                    limit: 1,
                    commitment: this.commitment,
                });
                const baselineSig = sigs.length > 0 ? sigs[0].signature : null;
                const baselineSlot = sigs.length > 0 ? sigs[0].slot : null;

                // 2. Discover open positions on chain (fails startup if discovery fails)
                const positions = await this.discoverActivePositions(wallet.address);

                // 3. Atomically apply initialized state for this wallet
                this.sessionCursors.set(wallet.address, {
                    walletAddress: wallet.address,
                    lastSignature: baselineSig,
                    lastSlot: baselineSlot,
                    lastPollAt: Date.now(),
                    isDegraded: false,
                    consecutiveErrors: 0,
                });
                for (const pos of positions) {
                    this.activePositions.set(pos.positionAddress, pos);
                }
            } catch (err) {
                this.errorCount++;
                // Clean up partial state for this wallet
                this.sessionCursors.delete(wallet.address);
                for (const [k, v] of Array.from(this.activePositions.entries())) {
                    if (v.owner === wallet.address) {
                        this.activePositions.delete(k);
                    }
                }
                const errMsg = err instanceof Error ? err.message : String(err);
                this.recordCoverageGap(wallet.address, `Initial position discovery failed: ${errMsg}`);
                this.status = "DEGRADED";
                throw new Error(`Initial position discovery failed for wallet ${wallet.address}: ${errMsg}`);
            }
        }

        this.status = "IDLE";
    }

    public async start(): Promise<void> {
        if (this.status === "RUNNING") return;

        if (this.sessionCursors.size === 0) {
            await this.init();
        }

        this.status = "RUNNING";
        this.scheduleNextPoll(0);
    }

    private scheduleNextPoll(delayMs = 0): void {
        if (this.status !== "RUNNING") return;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        this.pollTimeout = setTimeout(() => {
            this.pollTimeout = null;
            if (this.status !== "RUNNING") return;
            this.runPollingCycle().catch((err) => {
                console.error("[AlertsEngine] Polling cycle uncaught error:", err);
            });
        }, Math.max(0, delayMs));
        this.pollTimeout.unref?.();
    }

    public async runPollingCycle(): Promise<DlmmAlertEvent[]> {
        if (this.status !== "RUNNING") return [];
        const startGlobalGen = this.globalGeneration;
        const events = await this.poll();

        if (this.status === "RUNNING" && this.globalGeneration === startGlobalGen) {
            const duration = this.lastPollDurationMs ?? 0;
            const nextDelay = Math.max(0, this.pollIntervalMs - duration);
            this.scheduleNextPoll(nextDelay);
        }
        return events;
    }

    public pause(): void {
        this.globalGeneration++;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        this.status = "PAUSED";
    }

    /**
     * Fresh Resume:
     * - Resets startup baseline to CURRENT head
     * - Refreshes active positions snapshot
     * - Skips transactions during pause interval (zero alerts for offline/pause period)
     * - Fences out any late RPC results from invalidated session
     */
    public async resume(): Promise<void> {
        if (this.status === "RUNNING") return;
        this.globalGeneration++;
        // Fresh baseline: re-establish baseline cursors and active positions
        await this.init();
        await this.start();
    }

    public stop(): void {
        this.globalGeneration++;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        this.status = "STOPPED";
    }

    public async enrollWallet(walletAddress: string): Promise<void> {
        const nextGen = (this.walletGenerations.get(walletAddress) ?? 0) + 1;
        this.walletGenerations.set(walletAddress, nextGen);
        await this.ensureIdlLoaded();

        const sigs = await this.rpcClient.getSignaturesForAddress(walletAddress, {
            limit: 1,
            commitment: this.commitment,
        });
        const positions = await this.discoverActivePositions(walletAddress);

        // Fencing check
        if ((this.walletGenerations.get(walletAddress) ?? 0) !== nextGen) {
            return;
        }

        this.sessionCursors.set(walletAddress, {
            walletAddress,
            lastSignature: sigs.length > 0 ? sigs[0].signature : null,
            lastSlot: sigs.length > 0 ? sigs[0].slot : null,
            lastPollAt: Date.now(),
            isDegraded: false,
            consecutiveErrors: 0,
        });
        for (const pos of positions) {
            this.activePositions.set(pos.positionAddress, pos);
        }
    }

    public pauseWallet(walletAddress: string): void {
        const nextGen = (this.walletGenerations.get(walletAddress) ?? 0) + 1;
        this.walletGenerations.set(walletAddress, nextGen);
        const cursor = this.sessionCursors.get(walletAddress);
        if (cursor) {
            cursor.isDegraded = false;
        }
    }

    public async resumeWallet(walletAddress: string): Promise<void> {
        const nextGen = (this.walletGenerations.get(walletAddress) ?? 0) + 1;
        this.walletGenerations.set(walletAddress, nextGen);

        await this.ensureIdlLoaded();
        const sigs = await this.rpcClient.getSignaturesForAddress(walletAddress, {
            limit: 1,
            commitment: this.commitment,
        });
        const positions = await this.discoverActivePositions(walletAddress);

        if ((this.walletGenerations.get(walletAddress) ?? 0) !== nextGen) {
            return;
        }

        this.sessionCursors.set(walletAddress, {
            walletAddress,
            lastSignature: sigs.length > 0 ? sigs[0].signature : null,
            lastSlot: sigs.length > 0 ? sigs[0].slot : null,
            lastPollAt: Date.now(),
            isDegraded: false,
            consecutiveErrors: 0,
        });
        for (const [posKey, pos] of Array.from(this.activePositions.entries())) {
            if (pos.owner === walletAddress) {
                this.activePositions.delete(posKey);
            }
        }
        for (const pos of positions) {
            this.activePositions.set(pos.positionAddress, pos);
        }
    }

    public unenrollWallet(walletAddress: string): void {
        const nextGen = (this.walletGenerations.get(walletAddress) ?? 0) + 1;
        this.walletGenerations.set(walletAddress, nextGen);
        this.sessionCursors.delete(walletAddress);
        for (const [posKey, pos] of Array.from(this.activePositions.entries())) {
            if (pos.owner === walletAddress) {
                this.activePositions.delete(posKey);
            }
        }
    }


    /**
     * Executes one complete polling cycle across all currently enabled watched wallets.
     */
    public async poll(): Promise<DlmmAlertEvent[]> {
        if (this.isPollingCycleActive) return [];
        this.isPollingCycleActive = true;
        this.totalPollsAttempted++;
        const cycleStart = Date.now();

        const collectedEvents: DlmmAlertEvent[] = [];

        try {
            await this.ensureIdlLoaded();

            // Check if any new wallets were enabled or disabled in the watchlist
            const currentWallets = await this.watchlistStore.listWallets();
            const enabledMap = new Map(currentWallets.filter((w) => w.enabled).map((w) => [w.address, w]));

            // Remove disabled or deleted wallets
            for (const addr of Array.from(this.sessionCursors.keys())) {
                if (!enabledMap.has(addr)) {
                    this.unenrollWallet(addr);
                }
            }

            // Enroll newly enabled wallets with fresh baseline
            for (const [addr, entry] of enabledMap.entries()) {
                if (!this.sessionCursors.has(addr)) {
                    try {
                        await this.enrollWallet(addr);
                    } catch (err) {
                        this.recordCoverageGap(addr, `Failed to enroll newly enabled wallet: ${(err as Error).message}`);
                    }
                }
            }

            // Poll active wallets
            for (const walletAddress of this.sessionCursors.keys()) {
                const events = await this.pollWallet(walletAddress);
                collectedEvents.push(...events);
            }

            const cycleDuration = Date.now() - cycleStart;
            this.lastPollDurationMs = cycleDuration;

            if (this.lastPollStartAt !== null) {
                const interval = cycleStart - this.lastPollStartAt;
                this.effectivePollIntervalMs = this.effectivePollIntervalMs !== null
                    ? Math.round(0.7 * this.effectivePollIntervalMs + 0.3 * interval)
                    : interval;
            } else {
                this.effectivePollIntervalMs = this.pollIntervalMs;
            }
            this.lastPollStartAt = cycleStart;

            const degradedWallets = Array.from(this.sessionCursors.values()).filter((c) => c.isDegraded);
            if (this.sessionCursors.size > 0 && degradedWallets.length === this.sessionCursors.size) {
                this.totalPollsFailed++;
            } else if (degradedWallets.length > 0) {
                this.totalPollsPartial++;
                this.lastSuccessfulPollAt = Date.now();
            } else {
                this.totalPollsSuccessful++;
                this.lastSuccessfulPollAt = Date.now();
            }

            this.totalPolls++;
            this.lastPollAt = Date.now();
        } catch (err) {
            this.totalPollsFailed++;
            this.errorCount++;
        } finally {
            this.isPollingCycleActive = false;
        }

        return collectedEvents;
    }

    /**
     * Poll a single wallet for new activity since cursor.
     */
    private isSessionInvalidated(startGlobalGen: number, walletAddress: string, startWalletGen: number): boolean {
        return (
            this.status === "PAUSED" ||
            this.status === "STOPPED" ||
            this.globalGeneration !== startGlobalGen ||
            (this.walletGenerations.get(walletAddress) ?? 0) !== startWalletGen
        );
    }
    public async pollWallet(walletAddress: string): Promise<DlmmAlertEvent[]> {
        if (this.inFlightPolls.has(walletAddress)) {
            return []; // Prevent overlapping polls for the same wallet
        }
        this.inFlightPolls.add(walletAddress);

        const emittedForWallet: DlmmAlertEvent[] = [];
        const startGlobalGen = this.globalGeneration;
        const startWalletGen = this.walletGenerations.get(walletAddress) ?? 0;

        try {
            const cursor = this.sessionCursors.get(walletAddress);
            if (!cursor) return [];

            const pageSize = 100;
            let before: string | undefined = undefined;
            const until: string | undefined = cursor.lastSignature ?? undefined;
            const fetchedSignatures: SignatureItem[] = [];
            let hasMore = true;

            // Safe pagination loop
            while (hasMore) {
                if (this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                    return [];
                }

                let page: SignatureItem[];
                try {
                    page = await this.rpcClient.getSignaturesForAddress(walletAddress, {
                        limit: pageSize,
                        before,
                        until,
                        commitment: this.commitment,
                    });
                } catch (err) {
                    if (this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                        return [];
                    }
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.recordCoverageGap(walletAddress, `Incomplete signature pagination: ${errMsg}`);
                    cursor.isDegraded = true;
                    cursor.consecutiveErrors++;
                    return [];
                }

                if (this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                    return [];
                }

                if (!page || page.length === 0) {
                    hasMore = false;
                    break;
                }

                fetchedSignatures.push(...page);

                if (page.length < pageSize) {
                    hasMore = false;
                } else {
                    before = page[page.length - 1].signature;
                }
            }

            if (fetchedSignatures.length === 0) {
                if (!this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                    cursor.lastPollAt = Date.now();
                    cursor.isDegraded = false;
                    cursor.consecutiveErrors = 0;
                }
                return [];
            }

            // Exclude on-chain reverted transactions
            const validSignatures = fetchedSignatures.filter((s) => s.err === null || s.err === undefined);

            if (validSignatures.length === 0) {
                if (!this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                    cursor.lastSignature = fetchedSignatures[0].signature;
                    cursor.lastSlot = fetchedSignatures[0].slot;
                    cursor.lastPollAt = Date.now();
                    cursor.isDegraded = false;
                    cursor.consecutiveErrors = 0;
                }
                return [];
            }

            // Reverse to chronological order (oldest -> newest) for accurate state transitions
            const chronologicalSignatures = [...validSignatures].reverse();

            let lastProcessedSignature: string | null = null;
            let lastProcessedSlot: number | null = null;

            for (const sigItem of chronologicalSignatures) {
                if (this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                    return [];
                }

                let txData: unknown = null;
                let txFetchError: unknown = null;

                try {
                    txData = await this.rpcClient.getTransaction(sigItem.signature, {
                        encoding: "json",
                        commitment: this.commitment,
                        maxSupportedTransactionVersion: 1,
                    });
                } catch (err) {
                    txFetchError = err;
                    this.retryCount++;
                }

                if (this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                    return [];
                }

                if (!txData) {
                    const errMsg = txFetchError instanceof Error ? txFetchError.message : String(txFetchError);
                    this.recordCoverageGap(
                        walletAddress,
                        `Failed to fetch transaction ${sigItem.signature}: ${errMsg}`,
                        sigItem.signature
                    );
                    cursor.isDegraded = true;
                    cursor.consecutiveErrors++;

                    if (lastProcessedSignature) {
                        cursor.lastSignature = lastProcessedSignature;
                        cursor.lastSlot = lastProcessedSlot;
                    }
                    return emittedForWallet;
                }

                // Process transaction instructions
                const eventsFromTx = this.processTransaction(txData, walletAddress, startGlobalGen, startWalletGen);
                for (const ev of eventsFromTx) {
                    this.emitEvent(ev);
                    emittedForWallet.push(ev);
                }

                lastProcessedSignature = sigItem.signature;
                lastProcessedSlot = sigItem.slot;
            }

            // Fencing check before advancing cursor to end of range
            if (!this.isSessionInvalidated(startGlobalGen, walletAddress, startWalletGen)) {
                cursor.lastSignature = fetchedSignatures[0].signature;
                cursor.lastSlot = fetchedSignatures[0].slot;
                cursor.lastPollAt = Date.now();
                cursor.isDegraded = false;
                cursor.consecutiveErrors = 0;
            }
        } finally {
            this.inFlightPolls.delete(walletAddress);
        }

        return emittedForWallet;
    }

    /**
     * Evaluates a single transaction, extracting DLMM events for the monitored wallet.
     * Incorporates deterministic event identity and fencing validation.
     */
    private processTransaction(
        tx: unknown,
        targetWallet: string,
        expectedGlobalGen = this.globalGeneration,
        expectedWalletGen = this.walletGenerations.get(targetWallet) ?? 0
    ): DlmmAlertEvent[] {
        if (!tx || typeof tx !== "object" || !this.idlBundle) return [];

        const txObj = tx as { meta?: { err?: unknown } };
        if (txObj.meta?.err) return [];
        const normalizedIxs = normalizeTransactionInstructions(tx);
        const events: DlmmAlertEvent[] = [];

        // Fencing check
        if (this.isSessionInvalidated(expectedGlobalGen, targetWallet, expectedWalletGen)) {
            return [];
        }

        for (const ix of normalizedIxs) {
            if (ix.programId !== this.meteoraDlmmProgramId) {
                continue;
            }

            const decoded = decodeLpInstruction(
                ix,
                null,
                this.meteoraDlmmProgramId,
                this.idlBundle.instructionMap,
                this.idlBundle.eventMap
            );

            let poolAddress: string | null = decoded.pool;
            const positionKey = decoded.mappedAccounts["position"] || decoded.mappedAccounts["position_v2"] || null;

            if (!poolAddress && decoded.category === "close" && positionKey) {
                const existing = this.activePositions.get(positionKey);
                if (existing) {
                    poolAddress = existing.poolAddress;
                }
            }

            if (decoded.status !== "ACCEPTED" && !(decoded.status === "NO_POOL_ACCOUNT" && poolAddress)) {
                continue;
            }

            const category = decoded.category;
            let eventType: DlmmEventType | null = null;

            if (category === "initialize") {
                eventType = "POSITION_OPENED";
            } else if (category === "add") {
                eventType = "LIQUIDITY_ADDED";
            } else if (category === "remove") {
                eventType = "LIQUIDITY_REMOVED";
            } else if (category === "close") {
                eventType = "POSITION_CLOSED";
            } else if (category === "claim_fee") {
                eventType = "FEES_CLAIMED";
            } else {
                continue;
            }

            let owner: string | null = null;
            if (eventType === "POSITION_OPENED") {
                owner = decoded.mappedAccounts["owner"] ?? null;
            } else {
                if (positionKey && this.activePositions.has(positionKey)) {
                    owner = this.activePositions.get(positionKey)!.owner;
                } else {
                    owner = decoded.mappedAccounts["owner"] ?? decoded.mappedAccounts["sender"] ?? null;
                }
            }

            if (!owner || owner !== targetWallet) {
                continue;
            }

            if (!positionKey || !poolAddress) {
                continue;
            }

            const signer = decoded.mappedAccounts["sender"] ?? decoded.mappedAccounts["owner"] ?? ix.signers[0] ?? "";
            const feePayer = ix.feePayer;
            const operator = decoded.mappedAccounts["operator"] ?? null;

            const source: "outer" | "inner" | "top-level" = ix.source;
            const idSource = ix.source === "inner" ? "inner" : "outer";
            const parentIndex = ix.parentIndex !== null && ix.parentIndex !== undefined ? ix.parentIndex : -1;
            const subEventIndex = 0;

            // Deterministic event identity:
            // signature : source : parentIndex : instructionIndex : positionAddress : eventType : subEventIndex
            const eventId = `${ix.signature}:${idSource}:${parentIndex}:${ix.instructionIndex}:${positionKey}:${eventType}:${subEventIndex}`;
            if (this.deduplicatedEvents.has(eventId)) {
                continue;
            }

            // Fencing check before modifying active position state
            if (this.isSessionInvalidated(expectedGlobalGen, targetWallet, expectedWalletGen)) {
                return [];
            }
            this.addDedupKey(eventId);
            // Update in-memory active position snapshot
            if (eventType === "POSITION_OPENED") {
                this.activePositions.set(positionKey, {
                    positionAddress: positionKey,
                    owner,
                    poolAddress,
                    version: "V2",
                    hasLiquidity: false,
                    discoveredAt: Date.now(),
                    lastUpdatedAt: ix.blockTime ? ix.blockTime * 1000 : Date.now(),
                });
            } else if (eventType === "LIQUIDITY_ADDED") {
                const pos = this.activePositions.get(positionKey);
                if (pos) {
                    pos.hasLiquidity = true;
                    pos.lastUpdatedAt = ix.blockTime ? ix.blockTime * 1000 : Date.now();
                } else {
                    this.activePositions.set(positionKey, {
                        positionAddress: positionKey,
                        owner,
                        poolAddress,
                        version: "V2",
                        hasLiquidity: true,
                        discoveredAt: Date.now(),
                        lastUpdatedAt: ix.blockTime ? ix.blockTime * 1000 : Date.now(),
                    });
                }
            } else if (eventType === "LIQUIDITY_REMOVED") {
                const pos = this.activePositions.get(positionKey);
                if (pos) {
                    pos.lastUpdatedAt = ix.blockTime ? ix.blockTime * 1000 : Date.now();
                }
            } else if (eventType === "POSITION_CLOSED") {
                this.activePositions.delete(positionKey);
            } else if (eventType === "FEES_CLAIMED") {
                const pos = this.activePositions.get(positionKey);
                if (pos) {
                    pos.lastUpdatedAt = ix.blockTime ? ix.blockTime * 1000 : Date.now();
                }
            }

            const event: DlmmAlertEvent = {
                id: eventId,
                eventType,
                walletAddress: owner,
                positionAddress: positionKey,
                poolAddress,
                signature: ix.signature,
                slot: ix.slot,
                blockTime: ix.blockTime,
                instructionIndex: ix.instructionIndex,
                parentIndex: ix.parentIndex ?? null,
                source,
                subEventIndex,
                signer,
                feePayer,
                operator,
                instructionName: decoded.instructionName ?? "",
                detectedAt: Date.now(),
            };

            events.push(event);
        }

        return events;
    }
}
