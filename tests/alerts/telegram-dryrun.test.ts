import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DlmmAlertEvent } from "../../scripts/alerts/alerts-engine.ts";
import {
    TelegramDryRunAdapter,
    formatTelegramPreview,
    deriveVerifiedWalletRole,
} from "../../scripts/alerts/telegram-dryrun.ts";

function createDummyEvent(overrides: Partial<DlmmAlertEvent> = {}): DlmmAlertEvent {
    return {
        id: "tx123:0:POSITION_OPENED",
        eventType: "POSITION_OPENED",
        walletAddress: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
        positionAddress: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
        poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
        signature: "5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h",
        slot: 245100200,
        blockTime: 1728892173,
        instructionIndex: 0,
        source: "top-level",
        signer: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
        feePayer: "ComputeBudget111111111111111111111111111111",
        operator: null,
        instructionName: "initialize_position",
        detectedAt: 1728892174000,
        ...overrides,
    };
}

describe("Telegram Dry-run Adapter Suite", () => {
    describe("1. Deterministic Message Formatting Across All 5 Event Types", () => {
        const eventTypes: Array<DlmmAlertEvent["eventType"]> = [
            "POSITION_OPENED",
            "LIQUIDITY_ADDED",
            "LIQUIDITY_REMOVED",
            "POSITION_CLOSED",
            "FEES_CLAIMED",
        ];

        for (const evt of eventTypes) {
            it(`formats ${evt} with all mandatory preview fields and valid explorer link`, () => {
                const event = createDummyEvent({
                    id: `sig_${evt}:1:${evt}`,
                    eventType: evt,
                    instructionName: evt.toLowerCase(),
                });
                const preview = formatTelegramPreview(event, "Alpha Whale");

                assert.strictEqual(preview.eventType, evt);
                assert.strictEqual(preview.status, "PREVIEW_ONLY");
                assert.notStrictEqual(preview.status, "SENT");
                assert.strictEqual(preview.commitment, "finalized");
                assert.strictEqual(preview.walletAlias, "Alpha Whale");
                assert.strictEqual(preview.walletAddress, event.walletAddress);
                assert.strictEqual(preview.positionAddress, event.positionAddress);
                assert.strictEqual(preview.poolAddress, event.poolAddress);
                assert.strictEqual(preview.signature, event.signature);
                assert.strictEqual(preview.slot, 245100200);
                assert.strictEqual(preview.explorerUrl, `https://explorer.solana.com/tx/${event.signature}`);

                // Check message text formatting
                assert.match(preview.messageText, /\[DRY-RUN PREVIEW\] DLMM Alert:/);
                assert.match(preview.messageText, new RegExp(evt));
                assert.match(preview.messageText, /Alpha Whale/);
                assert.match(preview.messageText, /Status: Finalized \(Slot 245100200\)/);
                assert.match(preview.messageText, new RegExp(`Explorer: https://explorer.solana.com/tx/${event.signature}`));
            });
        }
    });

    describe("2. Wallet Role & Ownership Verification", () => {
        it("identifies owner when wallet is direct signer", () => {
            const event = createDummyEvent({
                walletAddress: "WalletA111111111111111111111111111111111111",
                signer: "WalletA111111111111111111111111111111111111",
                operator: null,
            });
            assert.strictEqual(deriveVerifiedWalletRole(event), "owner (signer)");
        });

        it("identifies operator when instruction has delegated operator signer", () => {
            const event = createDummyEvent({
                walletAddress: "WalletA111111111111111111111111111111111111",
                signer: "OperatorB1111111111111111111111111111111111",
                operator: "OperatorB1111111111111111111111111111111111",
            });
            assert.strictEqual(deriveVerifiedWalletRole(event), "owner (operator: OperatorB1111111111111111111111111111111111)");
        });

        it("never attributes ownership to fee payer", () => {
            const event = createDummyEvent({
                walletAddress: "WalletA111111111111111111111111111111111111",
                signer: "DifferentSigner111111111111111111111111111",
                feePayer: "RelayerPayer111111111111111111111111111111",
                operator: null,
            });
            assert.strictEqual(deriveVerifiedWalletRole(event), "owner");
        });
    });

    describe("3. Verified Amounts Integrity (Never Fabricate or Coerce Missing)", () => {
        it("omits amounts section when amounts are not verified", () => {
            const event = createDummyEvent();
            const preview = formatTelegramPreview(event, null, null);
            assert.strictEqual(preview.amounts, null);
            assert.strictEqual(preview.messageText.includes("Amounts:"), false);
        });

        it("omits amounts when verified flag is false", () => {
            const event = createDummyEvent();
            const preview = formatTelegramPreview(event, null, {
                tokenA: { amount: "100.5", symbol: "USDC" },
                verified: false,
            });
            assert.strictEqual(preview.amounts, null);
            assert.strictEqual(preview.messageText.includes("Amounts:"), false);
        });

        it("includes amounts only when verified flag is explicitly true", () => {
            const event = createDummyEvent();
            const preview = formatTelegramPreview(event, null, {
                tokenA: { amount: "10.5", symbol: "SOL" },
                tokenB: { amount: "1500.0", symbol: "USDC" },
                verified: true,
            });
            assert.notStrictEqual(preview.amounts, null);
            assert.match(preview.messageText, /Amounts: 10\.5 SOL \+ 1500\.0 USDC/);
        });
    });

    describe("4. In-Memory Bounded Buffer & Deduplication", () => {
        it("deduplicates identical event IDs within session", async () => {
            const adapter = new TelegramDryRunAdapter({ maxPreviews: 10 });
            const event = createDummyEvent({ id: "evt_duplicate_check" });

            const first = await adapter.processEvent(event);
            assert.notStrictEqual(first, null);
            assert.strictEqual(adapter.getCount(), 1);

            const second = await adapter.processEvent(event);
            assert.strictEqual(second, null);
            assert.strictEqual(adapter.getCount(), 1);
        });

        it("enforces maxPreviews FIFO bounding in RAM", async () => {
            const adapter = new TelegramDryRunAdapter({ maxPreviews: 3 });

            for (let i = 0; i < 5; i++) {
                await adapter.processEvent(
                    createDummyEvent({
                        id: `evt_cap_${i}`,
                        signature: `sig_${i}`,
                    })
                );
            }

            assert.strictEqual(adapter.getCount(), 3);
            const previews = adapter.getPreviews();
            // Newest is first
            assert.strictEqual(previews[0].signature, "sig_4");
            assert.strictEqual(previews[1].signature, "sig_3");
            assert.strictEqual(previews[2].signature, "sig_2");
        });

        it("filters previews by wallet and eventType", async () => {
            const adapter = new TelegramDryRunAdapter({ maxPreviews: 10 });
            const wallet1 = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
            const wallet2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

            await adapter.processEvent(createDummyEvent({ id: "e1", walletAddress: wallet1, eventType: "POSITION_OPENED" }));
            await adapter.processEvent(createDummyEvent({ id: "e2", walletAddress: wallet2, eventType: "LIQUIDITY_ADDED" }));
            await adapter.processEvent(createDummyEvent({ id: "e3", walletAddress: wallet1, eventType: "POSITION_CLOSED" }));

            assert.strictEqual(adapter.getPreviews({ wallet: wallet1 }).length, 2);
            assert.strictEqual(adapter.getPreviews({ wallet: wallet2 }).length, 1);
            assert.strictEqual(adapter.getPreviews({ eventType: "POSITION_OPENED" }).length, 1);
            assert.strictEqual(adapter.getPreviews({ limit: 1 }).length, 1);
        });

        it("clears memory on demand", async () => {
            const adapter = new TelegramDryRunAdapter({ maxPreviews: 10 });
            await adapter.processEvent(createDummyEvent({ id: "to_clear" }));
            assert.strictEqual(adapter.getCount(), 1);

            adapter.clear();
            assert.strictEqual(adapter.getCount(), 0);
            assert.deepStrictEqual(adapter.getPreviews(), []);
        });
    });

    describe("5. Blockchain blockTime vs ISO Timestamp Derivation and Fallback Consistency", () => {
        it("derives ISO timestamp accurately from blockchain blockTime (seconds to ms)", () => {
            const blockTime = 1728892173; // 2024-10-14T07:49:33.000Z
            const event = createDummyEvent({
                blockTime,
                detectedAt: 1728892174000,
            });
            const preview = formatTelegramPreview(event);

            assert.strictEqual(preview.blockTime, blockTime);
            assert.strictEqual(preview.timestamp, "2024-10-14T07:49:33.000Z");
            assert.match(preview.messageText, /Time: 2024-10-14T07:49:33\.000Z/);
            // Guarantees no 1970 epoch-seconds vs ms mismatch bug
            assert.doesNotMatch(preview.timestamp, /^1970/);
        });

        it("falls back to detectedAt (epoch ms) when blockTime is 0 or unavailable", () => {
            const detectedAt = 1728893000000; // 2024-10-14T08:03:20.000Z
            const event = createDummyEvent({
                blockTime: 0,
                detectedAt,
            });
            const preview = formatTelegramPreview(event);

            assert.strictEqual(preview.blockTime, 0);
            assert.strictEqual(preview.timestamp, new Date(detectedAt).toISOString());
            assert.strictEqual(preview.timestamp, "2024-10-14T08:03:20.000Z");
            assert.match(preview.messageText, /Time: 2024-10-14T08:03:20\.000Z/);
            assert.doesNotMatch(preview.timestamp, /^1970/);
        });

        it("falls back to detectedAt when blockTime is negative", () => {
            const detectedAt = 1728894000000;
            const event = createDummyEvent({
                blockTime: -1,
                detectedAt,
            });
            const preview = formatTelegramPreview(event);
            assert.strictEqual(preview.timestamp, new Date(detectedAt).toISOString());
        });
    });
});
