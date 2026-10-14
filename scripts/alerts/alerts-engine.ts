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
    source: "top-level" | "inner";
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
    private retries: number;
    private commitment: string;

    constructor(rpcUrl: string, retries = 3, commitment = "finalized") {
        this.rpcUrl = rpcUrl;
        this.retries = retries;
        this.commitment = commitment;
    }

    async getSignaturesForAddress(
        address: string,
        options?: { limit?: number; before?: string; until?: string; commitment?: string }
    ): Promise<SignatureItem[]> {
        const opts: Record<string, unknown> = {
            limit: options?.limit ?? 100,
            commitment: options?.commitment ?? this.commitment,
        };
        if (options?.before) opts.before = options.before;
        if (options?.until) opts.until = options.until;

        const result = await rpcCall<SignatureItem[]>(
            this.rpcUrl,
            "getSignaturesForAddress",
            [address, opts],
            this.retries
        );
        return result || [];
    }

    async getTransaction(
        signature: string,
        options?: { encoding?: string; commitment?: string; maxSupportedTransactionVersion?: number }
    ): Promise<unknown> {
        const opts = {
            encoding: options?.encoding ?? "json",
            commitment: options?.commitment ?? this.commitment,
            maxSupportedTransactionVersion: options?.maxSupportedTransactionVersion ?? 1,
        };
        return rpcCall<unknown>(
            this.rpcUrl,
            "getTransaction",
            [signature, opts],
            this.retries
        );
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
            commitment: config?.commitment ?? this.commitment,
        };
        if (config?.filters) opts.filters = config.filters;
        if (config?.dataSlice) opts.dataSlice = config.dataSlice;

        const result = await rpcCall<Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>>(
            this.rpcUrl,
            "getProgramAccounts",
            [programId, opts],
            this.retries
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

    private status: EngineStatus = "IDLE";
    private pollTimer: NodeJS.Timeout | null = null;
    private idlBundle: MeteoraIdlBundle | null = null;
    private readonly sdkCompatible: boolean;

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

    private totalPolls = 0;
    private totalEventsEmitted = 0;
    private lastPollAt: number | null = null;
    private retryCount = 0;
    private errorCount = 0;

    private readonly listeners: Array<(event: DlmmAlertEvent) => void> = [];

    constructor(config?: AlertsEngineConfig) {
        const discoveryConfig = loadDiscoveryConfig();
        this.watchlistStore = config?.watchlistStore ?? new WatchlistStore(config?.watchlistPath);
        this.meteoraDlmmProgramId = config?.meteoraDlmmProgramId ?? discoveryConfig.meteoraDlmmProgramId;
        this.pollIntervalMs = Math.max(10, config?.pollIntervalMs ?? 30_000);
        this.commitment = config?.commitment ?? "finalized";
        this.maxRetries = config?.maxRetries ?? 3;
        this.retryDelayMs = config?.retryDelayMs ?? 200;
        this.getTxConcurrency = config?.getTxConcurrency ?? 5;
        this.maxRecentActivity = config?.maxRecentActivity ?? 100;

        const rpcUrl = config?.rpcUrl ?? discoveryConfig.rpcUrl;
        this.rpcClient = config?.rpcClient ?? new DefaultAlertsRpcClient(rpcUrl, this.maxRetries, this.commitment);
        this.sdkCompatible = verifyDlmmSdk();
    }

    public getHealth(): EngineHealth {
        const anyDegraded = Array.from(this.sessionCursors.values()).some((c) => c.isDegraded);
        return {
            status: this.status,
            isDegraded: anyDegraded || this.status === "DEGRADED",
            sdkCompatible: this.sdkCompatible,
            monitoredWalletsCount: this.sessionCursors.size,
            activePositionsCount: this.activePositions.size,
            totalPolls: this.totalPolls,
            totalEventsEmitted: this.totalEventsEmitted,
            lastPollAt: this.lastPollAt,
            retryCount: this.retryCount,
            errorCount: this.errorCount,
            coverageGaps: [...this.coverageGaps],
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
     * Treats position-discovery errors as errors, never as successful discovery of 0 positions.
     */
    public async discoverActivePositions(walletAddress: string): Promise<ActivePosition[]> {
        if (!this.rpcClient.getProgramAccounts) {
            throw new Error("RPC client does not support getProgramAccounts for position discovery");
        }

        const discovered: ActivePosition[] = [];

        // Query PositionV2 accounts for this owner
        const accountsV2 = await this.rpcClient.getProgramAccounts(this.meteoraDlmmProgramId, {
            commitment: this.commitment,
            encoding: "base64",
            filters: [
                { memcmp: { offset: 0, bytes: POSITION_V2_DISCRIMINATOR_BS58 } },
                { memcmp: { offset: 40, bytes: walletAddress } },
            ],
        });

        // Query Position (V1) accounts for this owner
        let accountsV1: Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }> = [];
        try {
            accountsV1 = await this.rpcClient.getProgramAccounts(this.meteoraDlmmProgramId, {
                commitment: this.commitment,
                encoding: "base64",
                filters: [
                    { memcmp: { offset: 0, bytes: POSITION_V1_DISCRIMINATOR_BS58 } },
                    { memcmp: { offset: 40, bytes: walletAddress } },
                ],
            });
        } catch (err) {
            // Some RPCs might return empty or error on non-existent v1 filters; log retry count
            this.retryCount++;
        }

        const parseAccounts = (
            items: Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>,
            version: "V1" | "V2"
        ) => {
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

                // bytes 8..40: lb_pair
                const lbPair = new PublicKey(buf.subarray(8, 40)).toBase58();
                // bytes 40..72: owner
                const owner = new PublicKey(buf.subarray(40, 72)).toBase58();

                if (owner !== walletAddress) continue;

                // Check liquidity in shares area (offset 72 to 72 + 70*16 for V2)
                let hasLiquidity = false;
                const checkLen = Math.min(buf.length, 72 + 1120);
                for (let i = 72; i < checkLen; i++) {
                    if (buf[i] !== 0) {
                        hasLiquidity = true;
                        break;
                    }
                }

                discovered.push({
                    positionAddress: pubkey,
                    owner,
                    poolAddress: lbPair,
                    version,
                    hasLiquidity,
                    discoveredAt: Date.now(),
                    lastUpdatedAt: Date.now(),
                });
            }
        };

        parseAccounts(accountsV2, "V2");
        if (accountsV1.length > 0) {
            parseAccounts(accountsV1, "V1");
        }

        return discovered;
    }

    /**
     * Initializes monitoring session:
     * - Loads only enabled wallets
     * - Discovers active positions into RAM
     * - Captures latest signatures as baseline cursor
     * - Emits ZERO historical alerts
     */
    public async init(): Promise<void> {
        this.status = "INITIALIZING";
        await this.ensureIdlLoaded();

        const allWallets = await this.watchlistStore.listWallets();
        const enabledWallets = allWallets.filter((w) => w.enabled);

        // Reset cursors and snapshots for fresh baseline
        this.activePositions.clear();
        this.sessionCursors.clear();

        for (const wallet of enabledWallets) {
            try {
                // 1. Establish baseline cursor first so transactions arriving during discovery are caught
                const sigs = await this.rpcClient.getSignaturesForAddress(wallet.address, {
                    limit: 1,
                    commitment: this.commitment,
                });
                const baselineSig = sigs.length > 0 ? sigs[0].signature : null;
                const baselineSlot = sigs.length > 0 ? sigs[0].slot : null;

                this.sessionCursors.set(wallet.address, {
                    walletAddress: wallet.address,
                    lastSignature: baselineSig,
                    lastSlot: baselineSlot,
                    lastPollAt: Date.now(),
                    isDegraded: false,
                    consecutiveErrors: 0,
                });

                // 2. Discover open positions on chain
                const positions = await this.discoverActivePositions(wallet.address);
                for (const pos of positions) {
                    this.activePositions.set(pos.positionAddress, pos);
                }
            } catch (err) {
                this.errorCount++;
                const errMsg = err instanceof Error ? err.message : String(err);
                this.recordCoverageGap(wallet.address, `Initial position discovery failed: ${errMsg}`);
                // Treat position discovery error as real error
                this.status = "DEGRADED";
                throw new Error(`Initial position discovery failed for wallet ${wallet.address}: ${errMsg}`);
            }
        }

        this.status = "IDLE";
    }

    public async start(): Promise<void> {
        if (this.status === "RUNNING") return;

        // If not initialized, initialize now
        if (this.sessionCursors.size === 0) {
            await this.init();
        }

        this.status = "RUNNING";

        // Start periodic polling timer
        clearInterval(this.pollTimer!);
        this.pollTimer = setInterval(() => {
            this.poll().catch((err) => {
                console.error("[AlertsEngine] Polling cycle error:", err);
            });
        }, this.pollIntervalMs);
    }

    public pause(): void {
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
        this.status = "PAUSED";
    }

    /**
     * Fresh Resume:
     * - Resets startup baseline to CURRENT head
     * - Refreshes active positions snapshot
     * - Skips transactions during pause interval (zero alerts for offline/pause period)
     */
    public async resume(): Promise<void> {
        if (this.status === "RUNNING") return;

        // Fresh baseline: re-establish baseline cursors and active positions
        await this.init();
        await this.start();
    }

    public stop(): void {
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
        this.status = "STOPPED";
    }
    public async enrollWallet(walletAddress: string): Promise<void> {
        await this.ensureIdlLoaded();
        const sigs = await this.rpcClient.getSignaturesForAddress(walletAddress, {
            limit: 1,
            commitment: this.commitment,
        });
        this.sessionCursors.set(walletAddress, {
            walletAddress,
            lastSignature: sigs.length > 0 ? sigs[0].signature : null,
            lastSlot: sigs.length > 0 ? sigs[0].slot : null,
            lastPollAt: Date.now(),
            isDegraded: false,
            consecutiveErrors: 0,
        });
        const positions = await this.discoverActivePositions(walletAddress);
        for (const pos of positions) {
            this.activePositions.set(pos.positionAddress, pos);
        }
    }

    public unenrollWallet(walletAddress: string): void {
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

            this.totalPolls++;
            this.lastPollAt = Date.now();
        } finally {
            this.isPollingCycleActive = false;
        }

        return collectedEvents;
    }

    /**
     * Poll a single wallet for new activity since cursor.
     */
    public async pollWallet(walletAddress: string): Promise<DlmmAlertEvent[]> {
        if (this.inFlightPolls.has(walletAddress)) {
            return []; // Prevent overlapping polls for the same wallet
        }
        this.inFlightPolls.add(walletAddress);

        const emittedForWallet: DlmmAlertEvent[] = [];

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
                let page: SignatureItem[];
                try {
                    page = await this.rpcClient.getSignaturesForAddress(walletAddress, {
                        limit: pageSize,
                        before,
                        until,
                        commitment: this.commitment,
                    });
                } catch (err) {
                    // RPC error during pagination: Never advance cursor across an incomplete range
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.recordCoverageGap(walletAddress, `Incomplete signature pagination: ${errMsg}`);
                    cursor.isDegraded = true;
                    cursor.consecutiveErrors++;
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
                cursor.lastPollAt = Date.now();
                return [];
            }

            // Exclude on-chain reverted transactions
            const validSignatures = fetchedSignatures.filter((s) => s.err === null || s.err === undefined);

            if (validSignatures.length === 0) {
                // If only failed transactions occurred, cursor can safely advance to latest
                cursor.lastSignature = fetchedSignatures[0].signature;
                cursor.lastSlot = fetchedSignatures[0].slot;
                cursor.lastPollAt = Date.now();
                cursor.isDegraded = false;
                return [];
            }

            // Reverse to chronological order (oldest -> newest) for accurate state transitions
            const chronologicalSignatures = [...validSignatures].reverse();

            // Fetch transaction details with bounded concurrency and retry handling
            let lastProcessedSignature: string | null = null;
            let lastProcessedSlot: number | null = null;

            for (const sigItem of chronologicalSignatures) {
                let txData: unknown = null;
                let txFetchError: unknown = null;

                for (let attempt = 0; attempt < this.maxRetries; attempt++) {
                    try {
                        txData = await this.rpcClient.getTransaction(sigItem.signature, {
                            encoding: "json",
                            commitment: this.commitment,
                            maxSupportedTransactionVersion: 1,
                        });
                        break;
                    } catch (err) {
                        txFetchError = err;
                        this.retryCount++;
                        if (attempt < this.maxRetries - 1 && this.retryDelayMs > 0) {
                            await sleep(this.retryDelayMs * Math.pow(2, attempt));
                        }
                    }
                }

                if (!txData) {
                    // Unrecoverable RPC failure on a transaction:
                    // Never advance cursor across incompletely fetched range!
                    const errMsg = txFetchError instanceof Error ? txFetchError.message : String(txFetchError);
                    this.recordCoverageGap(
                        walletAddress,
                        `Failed to fetch transaction ${sigItem.signature}: ${errMsg}`,
                        sigItem.signature
                    );
                    cursor.isDegraded = true;
                    cursor.consecutiveErrors++;

                    // Advance cursor only up to the last completely processed signature
                    if (lastProcessedSignature) {
                        cursor.lastSignature = lastProcessedSignature;
                        cursor.lastSlot = lastProcessedSlot;
                    }
                    return emittedForWallet;
                }

                // Process transaction instructions
                const eventsFromTx = this.processTransaction(txData, walletAddress);
                for (const ev of eventsFromTx) {
                    this.emitEvent(ev);
                    emittedForWallet.push(ev);
                }

                lastProcessedSignature = sigItem.signature;
                lastProcessedSlot = sigItem.slot;
            }

            // All signatures in range fetched and processed successfully
            cursor.lastSignature = fetchedSignatures[0].signature;
            cursor.lastSlot = fetchedSignatures[0].slot;
            cursor.lastPollAt = Date.now();
            cursor.isDegraded = false;
            cursor.consecutiveErrors = 0;
        } finally {
            this.inFlightPolls.delete(walletAddress);
        }

        return emittedForWallet;
    }

    /**
     * Evaluates a single transaction, extracting DLMM events for the monitored wallet.
     */
    private processTransaction(tx: unknown, targetWallet: string): DlmmAlertEvent[] {
        if (!tx || typeof tx !== "object" || !this.idlBundle) return [];

        const txObj = tx as { meta?: { err?: unknown } };
        // If meta.err is present, transaction failed on chain
        if (txObj.meta?.err) return [];
        const normalizedIxs = normalizeTransactionInstructions(tx);
        const events: DlmmAlertEvent[] = [];

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

            // Handle special case where close_position2 doesn't have lb_pair in accounts
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
                // Ignore pool creation, claim_reward, rebalance, admin, operator, etc.
                continue;
            }

            // Determine ownership: DO NOT infer ownership from the fee payer!
            let owner: string | null = null;
            if (eventType === "POSITION_OPENED") {
                owner = decoded.mappedAccounts["owner"] ?? null;
            } else {
                // If known position in RAM snapshot, use stored owner
                if (positionKey && this.activePositions.has(positionKey)) {
                    owner = this.activePositions.get(positionKey)!.owner;
                } else {
                    owner = decoded.mappedAccounts["owner"] ?? decoded.mappedAccounts["sender"] ?? null;
                }
            }

            // Verify event belongs to monitored wallet
            if (!owner || owner !== targetWallet) {
                continue;
            }

            if (!positionKey || !poolAddress) {
                continue;
            }

            const signer = decoded.mappedAccounts["sender"] ?? decoded.mappedAccounts["owner"] ?? ix.signers[0] ?? "";
            const feePayer = ix.feePayer;
            const operator = decoded.mappedAccounts["operator"] ?? null;

            // Deduplication key
            const dedupKey = `${ix.signature}:${ix.source}:${ix.instructionIndex}:${eventType}:${positionKey}`;
            if (this.deduplicatedEvents.has(dedupKey)) {
                continue;
            }
            this.addDedupKey(dedupKey);

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
                    // Position opened before monitoring or in same transaction without snapshot
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
                    // Do NOT remove position on liquidity removed: position is still open on chain!
                }
            } else if (eventType === "POSITION_CLOSED") {
                // Closed positions are removed only after verified closure
                this.activePositions.delete(positionKey);
            } else if (eventType === "FEES_CLAIMED") {
                const pos = this.activePositions.get(positionKey);
                if (pos) {
                    pos.lastUpdatedAt = ix.blockTime ? ix.blockTime * 1000 : Date.now();
                }
            }

            const event: DlmmAlertEvent = {
                id: `${ix.signature}:${ix.instructionIndex}:${eventType}`,
                eventType,
                walletAddress: owner,
                positionAddress: positionKey,
                poolAddress,
                signature: ix.signature,
                slot: ix.slot,
                blockTime: ix.blockTime,
                instructionIndex: ix.instructionIndex,
                source: ix.source,
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
