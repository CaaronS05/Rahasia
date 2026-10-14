import type { DlmmAlertEvent, DlmmEventType } from "./alerts-engine.ts";
import { WatchlistStore } from "./watchlist-store.ts";

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

export interface TelegramDryRunOptions {
    maxPreviews?: number;
    maxDedupKeys?: number;
    watchlistStore?: WatchlistStore;
}

/**
 * Resolves verified wallet role from event data.
 * Does NOT guess or infer ownership from fee payer.
 */
export function deriveVerifiedWalletRole(event: DlmmAlertEvent): string {
    if (event.walletAddress === event.signer) {
        return "owner (signer)";
    }
    if (event.operator && event.operator === event.signer) {
        return `owner (operator: ${event.operator})`;
    }
    return "owner";
}

/**
 * Deterministically formats a DLMM event into a Telegram preview message.
 * Strict invariants:
 * - Status is always PREVIEW_ONLY, never SENT.
 * - Commitment is finalized.
 * - Amounts are only included if verified is true; missing amounts are never converted to 0.
 * - Explorer URL is always valid Solana Explorer.
 */
export function formatTelegramPreview(
    event: DlmmAlertEvent,
    walletAlias?: string | null,
    amounts?: VerifiedAmounts | null
): TelegramPreview {
    const timestamp =
        event.blockTime > 0
            ? new Date(event.blockTime * 1000).toISOString()
            : new Date(event.detectedAt).toISOString();

    const explorerUrl = `https://explorer.solana.com/tx/${event.signature}`;
    const walletRole = deriveVerifiedWalletRole(event);
    const aliasDisplay = walletAlias && walletAlias.trim() ? ` (${walletAlias.trim()})` : "";

    const lines: string[] = [
        `[DRY-RUN PREVIEW] DLMM Alert: ${event.eventType}`,
        `Wallet: ${event.walletAddress}${aliasDisplay}`,
        `Role: ${walletRole}`,
        `Pool: ${event.poolAddress}`,
        `Position: ${event.positionAddress}`,
        `Signature: ${event.signature}`,
        `Status: Finalized (Slot ${event.slot})`,
        `Time: ${timestamp}`,
        `Explorer: ${explorerUrl}`,
    ];

    if (amounts && amounts.verified) {
        const parts: string[] = [];
        if (amounts.tokenA?.amount) {
            parts.push(`${amounts.tokenA.amount}${amounts.tokenA.symbol ? ` ${amounts.tokenA.symbol}` : ""}`);
        }
        if (amounts.tokenB?.amount) {
            parts.push(`${amounts.tokenB.amount}${amounts.tokenB.symbol ? ` ${amounts.tokenB.symbol}` : ""}`);
        }
        if (parts.length > 0) {
            lines.push(`Amounts: ${parts.join(" + ")}`);
        }
    }

    const messageText = lines.join("\n");

    return {
        id: event.id,
        eventId: event.id,
        eventType: event.eventType,
        walletAddress: event.walletAddress,
        walletAlias: walletAlias ? walletAlias.trim() : null,
        poolAddress: event.poolAddress,
        positionAddress: event.positionAddress,
        walletRole,
        signature: event.signature,
        slot: event.slot,
        blockTime: event.blockTime,
        timestamp,
        commitment: "finalized",
        explorerUrl,
        amounts: amounts && amounts.verified ? amounts : null,
        messageText,
        status: "PREVIEW_ONLY",
        generatedAt: Date.now(),
    };
}

/**
 * In-memory Telegram Dry-run message adapter.
 * Maintains bounded FIFO preview buffer and deduplicates events per session.
 * Never performs network requests to Telegram.
 */
export class TelegramDryRunAdapter {
    private readonly maxPreviews: number;
    private readonly maxDedupKeys: number;
    private readonly watchlistStore?: WatchlistStore;

    private readonly previews: TelegramPreview[] = [];
    private readonly seenEventIds = new Set<string>();
    private readonly dedupOrder: string[] = [];

    constructor(options?: TelegramDryRunOptions) {
        this.maxPreviews = Math.max(1, options?.maxPreviews ?? 100);
        this.maxDedupKeys = Math.max(10, options?.maxDedupKeys ?? 5000);
        this.watchlistStore = options?.watchlistStore;
    }

    /**
     * Process an alert event into an in-memory preview.
     * Deduplicates across session: returns null if event was already processed.
     */
    public async processEvent(
        event: DlmmAlertEvent,
        walletAlias?: string | null,
        amounts?: VerifiedAmounts | null
    ): Promise<TelegramPreview | null> {
        if (this.seenEventIds.has(event.id)) {
            return null;
        }

        this.seenEventIds.add(event.id);
        this.dedupOrder.push(event.id);
        if (this.dedupOrder.length > this.maxDedupKeys) {
            const oldest = this.dedupOrder.shift();
            if (oldest) this.seenEventIds.delete(oldest);
        }

        let resolvedAlias = walletAlias;
        if (resolvedAlias === undefined && this.watchlistStore) {
            try {
                const entry = await this.watchlistStore.getWallet(event.walletAddress);
                resolvedAlias = entry?.alias ?? null;
            } catch {
                resolvedAlias = null;
            }
        }

        const preview = formatTelegramPreview(event, resolvedAlias, amounts);

        // Bounded FIFO buffer (newest first)
        this.previews.unshift(preview);
        if (this.previews.length > this.maxPreviews) {
            this.previews.pop();
        }

        return preview;
    }

    public getPreviews(options?: {
        limit?: number;
        wallet?: string;
        eventType?: DlmmEventType;
    }): TelegramPreview[] {
        let result = this.previews;
        if (options?.wallet) {
            result = result.filter((p) => p.walletAddress === options.wallet);
        }
        if (options?.eventType) {
            result = result.filter((p) => p.eventType === options.eventType);
        }
        if (options?.limit && options.limit > 0) {
            result = result.slice(0, options.limit);
        }
        return [...result];
    }

    public getCount(): number {
        return this.previews.length;
    }

    public clear(): void {
        this.previews.length = 0;
        this.seenEventIds.clear();
        this.dedupOrder.length = 0;
    }
}
