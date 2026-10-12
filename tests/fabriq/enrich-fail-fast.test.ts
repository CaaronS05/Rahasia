import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    isFatalError,
    executeWalletWorkers,
} from "../../scripts/fabriq/enrich-wallets.mjs";

describe("Fabriq Global Fail-Fast & Dispatch Abort Suite", () => {
    it("1. isFatalError classifies unrecoverable auth and persistent rate limits as fatal", () => {
        assert.equal(isFatalError(new Error("403 Forbidden. Check the existing Fabriq browser session.")), true);
        assert.equal(isFatalError(new Error("429 Too Many Requests")), true);
        assert.equal(isFatalError(new Error("401 Unauthorized after retries")), true);
    });

    it("2. isFatalError classifies transient or wallet-specific errors as non-fatal", () => {
        assert.equal(isFatalError(new Error("404 Not Found after retries")), false);
        assert.equal(isFatalError(new Error("Server error 500")), false);
        assert.equal(isFatalError(new Error("fetch failed")), false);
        assert.equal(isFatalError(new Error("socket hang up")), false);
    });

    it("3. HTTP 403 halts new wallet dispatch promptly across workers", async () => {
        const wallets = Array.from({ length: 10 }, (_, i) => `Wallet_${i + 1}`);
        const dispatchedWallets: string[] = [];
        const checkpoint = new Map<string, unknown>();
        const savedFailures: unknown[] = [];

        const mockFetchWallet = async (wallet: string) => {
            dispatchedWallets.push(wallet);
            if (wallet === "Wallet_1") {
                throw new Error("403 Forbidden. Check the existing Fabriq browser session.");
            }
            return {
                owner: wallet,
                status: "ok",
                fabriq: { stats: { totalPositions: 5 }, calendars: {} },
            };
        };

        const result = await executeWalletWorkers({
            wallets,
            concurrency: 2,
            fetchWallet: mockFetchWallet,
            checkpoint,
            saveCheckpoint: async (record) => {
                savedFailures.push(record);
            },
            isFabriqFresh: () => false,
            hasRequiredCalendars: () => false,
            delayMs: 0,
        });

        assert.equal(Boolean(result.fatalError), true);
        assert.ok(result.fatalError?.message.includes("403 Forbidden"));
        // With concurrency 2, only the active initial workers could run (at most 2), never all 10
        assert.ok(
            dispatchedWallets.length <= 2,
            `Dispatched ${dispatchedWallets.length} wallets; expected <= 2 due to prompt fail-fast abort`
        );
        assert.ok(dispatchedWallets.length < wallets.length);
    });

    it("4. Persistent HTTP 429 halts new wallet dispatch promptly", async () => {
        const wallets = Array.from({ length: 10 }, (_, i) => `Wallet_429_${i + 1}`);
        const dispatchedWallets: string[] = [];
        const checkpoint = new Map();

        const mockFetchWallet = async (wallet: string) => {
            dispatchedWallets.push(wallet);
            if (wallet === "Wallet_429_1") {
                throw new Error("429 Too Many Requests");
            }
            return {
                owner: wallet,
                status: "ok",
                fabriq: { stats: { totalPositions: 10 }, calendars: {} },
            };
        };

        const result = await executeWalletWorkers({
            wallets,
            concurrency: 2,
            fetchWallet: mockFetchWallet,
            checkpoint,
            saveCheckpoint: async () => {},
            isFabriqFresh: () => false,
            hasRequiredCalendars: () => false,
            delayMs: 0,
        });

        assert.equal(Boolean(result.fatalError), true);
        assert.ok(result.fatalError?.message.includes("429 Too Many Requests"));
        assert.ok(
            dispatchedWallets.length <= 2,
            `Dispatched ${dispatchedWallets.length} wallets; expected <= 2`
        );
    });

    it("5. Bounded 404 (non-fatal) does not abort batch and processes subsequent wallets", async () => {
        const wallets = ["Wallet_404", "Wallet_Success_1", "Wallet_Success_2"];
        const dispatchedWallets: string[] = [];
        const checkpoint = new Map();

        const mockFetchWallet = async (wallet: string) => {
            dispatchedWallets.push(wallet);
            if (wallet === "Wallet_404") {
                throw new Error("404 Not Found after retries");
            }
            return {
                owner: wallet,
                status: "ok",
                fabriq: { stats: { totalPositions: 2 }, calendars: {} },
            };
        };

        const result = await executeWalletWorkers({
            wallets,
            concurrency: 2,
            fetchWallet: mockFetchWallet,
            checkpoint,
            saveCheckpoint: async () => {},
            isFabriqFresh: () => false,
            hasRequiredCalendars: () => false,
            delayMs: 0,
        });

        assert.equal(result.fatalError, null);
        assert.equal(result.failed, 1);
        assert.equal(result.success, 2);
        assert.equal(dispatchedWallets.length, 3);
    });
});
