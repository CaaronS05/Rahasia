import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    WatchlistStore,
    WatchlistCorruptError,
    isValidSolanaAddress,
} from "../../scripts/alerts/watchlist-store.ts";

const ADDR_1 = "11111111111111111111111111111111";
const ADDR_2 = "So11111111111111111111111111111111111111112";
const ADDR_3 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ADDR_4 = "ComputeBudget111111111111111111111111111111";
const ADDR_5 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

describe("WatchlistStore Unit & Regression Suite", () => {
    let tempDir: string;
    let storeFile: string;
    let store: WatchlistStore;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchlist-store-test-"));
        storeFile = path.join(tempDir, "watchlist.json");
        store = new WatchlistStore(storeFile);
    });

    afterEach(() => {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch {
            // ignore cleanup failure
        }
    });

    describe("1. Address Validation", () => {
        it("accepts valid Solana base58 public keys", () => {
            assert.equal(isValidSolanaAddress(ADDR_1), true);
            assert.equal(isValidSolanaAddress(ADDR_2), true);
            assert.equal(isValidSolanaAddress(ADDR_3), true);
            assert.equal(isValidSolanaAddress(ADDR_4), true);
            assert.equal(isValidSolanaAddress(ADDR_5), true);
        });

        it("rejects invalid Solana addresses", () => {
            assert.equal(isValidSolanaAddress(""), false);
            assert.equal(isValidSolanaAddress("invalid"), false);
            assert.equal(isValidSolanaAddress("111111"), false);
            assert.equal(isValidSolanaAddress("00000000000000000000000000000000"), false); // invalid base58 char '0'
            assert.equal(isValidSolanaAddress(null), false);
            assert.equal(isValidSolanaAddress(undefined), false);
            assert.equal(isValidSolanaAddress(12345), false);
        });

        it("fails when adding an invalid address", async () => {
            await assert.rejects(
                () => store.addWallet("not-a-solana-address"),
                /Invalid Solana wallet address/
            );
        });
    });

    describe("2. Default State and Enrolment Isolation", () => {
        it("returns an empty list when store file does not exist", async () => {
            const wallets = await store.listWallets();
            assert.deepEqual(wallets, []);
            assert.equal(fs.existsSync(storeFile), false);
        });

        it("does not auto-enroll any master wallets or existing datasets", async () => {
            const wallets = await store.listWallets();
            assert.equal(wallets.length, 0);
        });
    });

    describe("3. Add, Get, List Operations & Default Disabled Status", () => {
        it("new wallets default to enabled: false", async () => {
            const entryWithAlias = await store.addWallet(ADDR_1, "System Program");
            assert.equal(entryWithAlias.address, ADDR_1);
            assert.equal(entryWithAlias.alias, "System Program");
            assert.equal(entryWithAlias.enabled, false);

            const entryWithoutAlias = await store.addWallet(ADDR_2);
            assert.equal(entryWithoutAlias.address, ADDR_2);
            assert.equal(entryWithoutAlias.alias, undefined);
            assert.equal(entryWithoutAlias.enabled, false);

            const list = await store.listWallets();
            assert.equal(list.length, 2);
            assert.equal(list[0]?.enabled, false);
            assert.equal(list[1]?.enabled, false);
        });

        it("retrieves a wallet by address", async () => {
            await store.addWallet(ADDR_1, "Alpha");
            const found = await store.getWallet(ADDR_1);
            assert.notEqual(found, null);
            assert.equal(found?.address, ADDR_1);
            assert.equal(found?.alias, "Alpha");
            assert.equal(found?.enabled, false);

            const notFound = await store.getWallet(ADDR_2);
            assert.equal(notFound, null);
        });

        it("checks presence via hasWallet", async () => {
            await store.addWallet(ADDR_1);
            assert.equal(await store.hasWallet(ADDR_1), true);
            assert.equal(await store.hasWallet(ADDR_2), false);
        });

        it("rejects duplicate wallet additions", async () => {
            await store.addWallet(ADDR_1, "First");
            await assert.rejects(
                () => store.addWallet(ADDR_1, "Duplicate"),
                /Wallet already in watchlist/
            );
        });

        it("returns isolated copies of entries to prevent external mutation", async () => {
            await store.addWallet(ADDR_1, "Original");
            const list = await store.listWallets();
            list[0]!.alias = "Mutated Externally";

            const fresh = await store.getWallet(ADDR_1);
            assert.equal(fresh?.alias, "Original");
        });
    });

    describe("4. Update, Enable, Disable, and Remove Operations", () => {
        it("updates alias and enabled status", async () => {
            await store.addWallet(ADDR_1, "Old Alias");

            const updatedAlias = await store.updateWallet(ADDR_1, { alias: "New Alias" });
            assert.equal(updatedAlias.alias, "New Alias");
            assert.equal(updatedAlias.enabled, false);

            const updatedEnabled = await store.updateWallet(ADDR_1, { enabled: true });
            assert.equal(updatedEnabled.enabled, true);
            assert.equal(updatedEnabled.alias, "New Alias");

            const clearedAlias = await store.updateWallet(ADDR_1, { alias: null });
            assert.equal(clearedAlias.alias, undefined);
            assert.equal(clearedAlias.enabled, true);
        });

        it("enables and disables wallet via helper methods", async () => {
            await store.addWallet(ADDR_1);
            const enabled = await store.enableWallet(ADDR_1);
            assert.equal(enabled.enabled, true);

            const disabled = await store.disableWallet(ADDR_1);
            assert.equal(disabled.enabled, false);
        });

        it("fails update when wallet does not exist", async () => {
            await assert.rejects(
                () => store.updateWallet(ADDR_1, { enabled: true }),
                /Wallet not found in watchlist/
            );
        });

        it("removes wallet correctly", async () => {
            await store.addWallet(ADDR_1);
            await store.addWallet(ADDR_2);

            const removed = await store.removeWallet(ADDR_1);
            assert.equal(removed, true);

            const list = await store.listWallets();
            assert.equal(list.length, 1);
            assert.equal(list[0]?.address, ADDR_2);

            const removedAgain = await store.removeWallet(ADDR_1);
            assert.equal(removedAgain, false);
        });
    });

    describe("5. Application Restart & Persistence", () => {
        it("survives restart across distinct store instances", async () => {
            await store.addWallet(ADDR_1, "Persisted 1");
            await store.enableWallet(ADDR_1);
            await store.addWallet(ADDR_2, "Persisted 2");

            // Simulate restart by creating new instance with same file
            const restartedStore = new WatchlistStore(storeFile);
            const wallets = await restartedStore.listWallets();

            assert.equal(wallets.length, 2);
            assert.deepEqual(wallets[0], {
                address: ADDR_1,
                alias: "Persisted 1",
                enabled: true,
            });
            assert.deepEqual(wallets[1], {
                address: ADDR_2,
                alias: "Persisted 2",
                enabled: false,
            });
        });
    });

    describe("6. Concurrency & Serialized Atomic Writes", () => {
        it("handles concurrent add operations without lost updates", async () => {
            const addPromises = [
                store.addWallet(ADDR_1, "Wallet 1"),
                store.addWallet(ADDR_2, "Wallet 2"),
                store.addWallet(ADDR_3, "Wallet 3"),
                store.addWallet(ADDR_4, "Wallet 4"),
                store.addWallet(ADDR_5, "Wallet 5"),
            ];

            const results = await Promise.all(addPromises);
            assert.equal(results.length, 5);

            const finalWallets = await store.listWallets();
            assert.equal(finalWallets.length, 5);
            const storedAddresses = finalWallets.map((w) => w.address);
            assert.ok(storedAddresses.includes(ADDR_1));
            assert.ok(storedAddresses.includes(ADDR_2));
            assert.ok(storedAddresses.includes(ADDR_3));
            assert.ok(storedAddresses.includes(ADDR_4));
            assert.ok(storedAddresses.includes(ADDR_5));
        });

        it("handles concurrent mix of add, update, enable operations", async () => {
            await store.addWallet(ADDR_1);

            await Promise.all([
                store.enableWallet(ADDR_1),
                store.addWallet(ADDR_2, "Concurrent 2"),
                store.updateWallet(ADDR_1, { alias: "Concurrent Alias" }),
                store.addWallet(ADDR_3, "Concurrent 3"),
            ]);

            const list = await store.listWallets();
            assert.equal(list.length, 3);

            const w1 = await store.getWallet(ADDR_1);
            assert.equal(w1?.enabled, true);
            assert.equal(w1?.alias, "Concurrent Alias");
        });
    });

    describe("7. Safe Failure on Corrupt JSON (No Silent Overwrite)", () => {
        it("throws WatchlistCorruptError on syntax error and leaves corrupt file untouched", async () => {
            fs.mkdirSync(tempDir, { recursive: true });
            const corruptPayload = "{\"wallets\": [broken_json_syntax";
            fs.writeFileSync(storeFile, corruptPayload, "utf8");

            await assert.rejects(
                () => store.listWallets(),
                WatchlistCorruptError
            );

            // Attempting to add a wallet must also fail and NEVER overwrite the corrupt file
            await assert.rejects(
                () => store.addWallet(ADDR_1),
                WatchlistCorruptError
            );

            // Verify content on disk remains unchanged
            const contentAfter = fs.readFileSync(storeFile, "utf8");
            assert.equal(contentAfter, corruptPayload);
        });

        it("throws WatchlistCorruptError on 0-byte file and leaves it untouched", async () => {
            fs.mkdirSync(tempDir, { recursive: true });
            fs.writeFileSync(storeFile, "", "utf8");

            await assert.rejects(
                () => store.listWallets(),
                WatchlistCorruptError
            );
            await assert.rejects(
                () => store.addWallet(ADDR_1),
                WatchlistCorruptError
            );

            assert.equal(fs.readFileSync(storeFile, "utf8"), "");
        });

        it("throws WatchlistCorruptError on invalid schema and preserves file", async () => {
            fs.mkdirSync(tempDir, { recursive: true });
            const invalidSchema = JSON.stringify({ wallets: "not-an-array" });
            fs.writeFileSync(storeFile, invalidSchema, "utf8");

            await assert.rejects(
                () => store.listWallets(),
                WatchlistCorruptError
            );

            assert.equal(fs.readFileSync(storeFile, "utf8"), invalidSchema);
        });

        it("throws WatchlistCorruptError when entries contain invalid Solana addresses", async () => {
            fs.mkdirSync(tempDir, { recursive: true });
            const badEntryJson = JSON.stringify({
                wallets: [{ address: "invalid-address", enabled: false }],
            });
            fs.writeFileSync(storeFile, badEntryJson, "utf8");

            await assert.rejects(
                () => store.listWallets(),
                WatchlistCorruptError
            );

            assert.equal(fs.readFileSync(storeFile, "utf8"), badEntryJson);
        });

        it("throws WatchlistCorruptError when file has duplicate addresses", async () => {
            fs.mkdirSync(tempDir, { recursive: true });
            const duplicateEntryJson = JSON.stringify({
                wallets: [
                    { address: ADDR_1, enabled: false },
                    { address: ADDR_1, enabled: true },
                ],
            });
            fs.writeFileSync(storeFile, duplicateEntryJson, "utf8");

            await assert.rejects(
                () => store.listWallets(),
                WatchlistCorruptError
            );

            assert.equal(fs.readFileSync(storeFile, "utf8"), duplicateEntryJson);
        });
    });
});
