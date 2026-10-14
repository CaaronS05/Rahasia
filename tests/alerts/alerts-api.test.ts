import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const TEST_PORT = 8792;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ROOT = path.resolve(import.meta.dirname, "../..");

const VALID_WALLET_1 = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const VALID_WALLET_2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const INVALID_WALLET = "NotAValidSolanaAddress123";

let serverProcess: ChildProcess | null = null;
let testDir: string;
let watchlistPath: string;

function waitForServerReady(proc: ChildProcess): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    const onData = (chunk: Buffer | string) => {
        const text = String(chunk);
        if (text.includes("Fabriq Control Server running")) {
            proc.stdout?.off("data", onData);
            resolve();
        }
    };

    proc.stdout?.on("data", onData);
    proc.once("error", reject);
    proc.once("exit", (code) => {
        reject(new Error(`Server exited unexpectedly with code ${code}`));
    });

    return promise;
}

describe("DLLM Alerts Control Server API Integration Suite", () => {
    before(async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts-api-test-"));
        watchlistPath = path.join(testDir, "watchlist.json");
        fs.writeFileSync(watchlistPath, JSON.stringify({ wallets: [] }));

        serverProcess = spawn(process.execPath, ["scripts/control/server.mjs"], {
            cwd: ROOT,
            env: {
                ...process.env,
                CONTROL_SERVER_PORT: String(TEST_PORT),
                PORT: String(TEST_PORT),
                WATCHLIST_PATH: watchlistPath,
            },
            stdio: "pipe",
        });

        await waitForServerReady(serverProcess);
    });

    after(async () => {
        if (serverProcess) {
            const { promise, resolve } = Promise.withResolvers<void>();
            serverProcess.once("exit", () => resolve());
            serverProcess.kill("SIGTERM");
            await promise;
            serverProcess = null;
        }

        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    describe("1. Engine Status & Opt-in Invariant", () => {
        it("GET /api/alerts/status reports initial IDLE health and zero active wallets", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/status`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();

            // Monitoring is strictly opt-in; never auto-starts on server boot
            assert.strictEqual(data.status, "IDLE");
            assert.strictEqual(data.isDegraded, false);
            assert.strictEqual(typeof data.sdkCompatible, "boolean");
            assert.strictEqual(data.monitoredWalletsCount, 0);
            assert.strictEqual(data.activePositionsCount, 0);
            assert.strictEqual(data.totalPolls, 0);
            assert.strictEqual(data.totalEventsEmitted, 0);
            assert.strictEqual(data.bufferedEventsCount, 0);
            assert.strictEqual(data.bufferedPreviewsCount, 0);
            assert.deepStrictEqual(data.coverageGaps, []);

            // Security: credentials and secrets are NEVER exposed
            assert.strictEqual(data.rpcUrl, undefined);
            assert.strictEqual(data.botToken, undefined);
            assert.strictEqual(data.apiKey, undefined);
        });
    });

    describe("2. Watchlist CRUD & Validation Endpoints", () => {
        it("GET /api/alerts/wallets returns empty array initially", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(Array.isArray(data.wallets), true);
            assert.strictEqual(data.wallets.length, 0);
            assert.strictEqual(data.totalCount, 0);
        });

        it("POST /api/alerts/wallets rejects invalid Solana address with 400", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: INVALID_WALLET }),
            });
            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.match(data.error, /Invalid Solana wallet address/i);
        });

        it("POST /api/alerts/wallets rejects non-string alias and non-boolean enabled with 400", async () => {
            const res1 = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: VALID_WALLET_1, alias: 12345 }),
            });
            assert.strictEqual(res1.status, 400);

            const res2 = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: VALID_WALLET_1, enabled: "true" }),
            });
            assert.strictEqual(res2.status, 400);
        });

        it("POST /api/alerts/wallets adds wallet with default enabled: false", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: VALID_WALLET_1, alias: "Alpha Fund" }),
            });
            assert.strictEqual(res.status, 201);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.wallet.address, VALID_WALLET_1);
            assert.strictEqual(data.wallet.alias, "Alpha Fund");
            assert.strictEqual(data.wallet.enabled, false);
        });

        it("POST /api/alerts/wallets rejects duplicate wallet additions with 409 Conflict", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: VALID_WALLET_1, alias: "Alpha Fund 2" }),
            });
            assert.strictEqual(res.status, 409);
            const data = await res.json();
            assert.match(data.error, /already exists in watchlist/i);
        });

        it("GET /api/alerts/wallets/:id retrieves single wallet", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_1}`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.wallet.address, VALID_WALLET_1);
            assert.strictEqual(data.wallet.alias, "Alpha Fund");
        });

        it("PATCH /api/alerts/wallets/:id updates alias and enabled state", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_1}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ alias: "Alpha Fund Prime", enabled: true }),
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.wallet.alias, "Alpha Fund Prime");
            assert.strictEqual(data.wallet.enabled, true);
        });

        it("PATCH /api/alerts/wallets/:id rejects update for non-existent wallet with 404", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_2}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ alias: "Ghost Wallet" }),
            });
            assert.strictEqual(res.status, 404);
        });
    });

    describe("3. Lifecycle Endpoints (Start, Pause, Resume, Delete)", () => {
        it("POST /api/alerts/wallets/:id/pause pauses wallet monitoring", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_1}/pause`, {
                method: "POST",
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.wallet.enabled, false);
            assert.strictEqual(data.status, "PAUSED");
        });

        it("POST /api/alerts/wallets/:id/resume executes fresh resume", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_1}/resume`, {
                method: "POST",
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.wallet.enabled, true);
        });

        it("POST /api/alerts/wallets/:id/start on non-existent wallet returns 404", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_2}/start`, {
                method: "POST",
            });
            assert.strictEqual(res.status, 404);
        });

        it("DELETE /api/alerts/wallets/:id removes wallet from watchlist", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_1}`, {
                method: "DELETE",
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.removed, VALID_WALLET_1);

            // Confirm deletion
            const getRes = await fetch(`${BASE_URL}/api/alerts/wallets/${VALID_WALLET_1}`);
            assert.strictEqual(getRes.status, 404);
        });
    });

    describe("4. Inspection Endpoints (Positions, Events, Previews)", () => {
        it("GET /api/alerts/positions returns tracked positions list and rejects bad address", async () => {
            const resBad = await fetch(`${BASE_URL}/api/alerts/positions?wallet=${INVALID_WALLET}`);
            assert.strictEqual(resBad.status, 400);

            const resOk = await fetch(`${BASE_URL}/api/alerts/positions`);
            assert.strictEqual(resOk.status, 200);
            const data = await resOk.json();
            assert.strictEqual(Array.isArray(data.positions), true);
            assert.strictEqual(typeof data.totalCount, "number");
        });

        it("GET /api/alerts/events returns recent activity list and rejects bad address", async () => {
            const resBad = await fetch(`${BASE_URL}/api/alerts/events?wallet=${INVALID_WALLET}`);
            assert.strictEqual(resBad.status, 400);

            const resOk = await fetch(`${BASE_URL}/api/alerts/events?limit=10`);
            assert.strictEqual(resOk.status, 200);
            const data = await resOk.json();
            assert.strictEqual(Array.isArray(data.events), true);
            assert.strictEqual(typeof data.totalCount, "number");
        });

        it("GET /api/alerts/previews returns recent previews and rejects bad address", async () => {
            const resBad = await fetch(`${BASE_URL}/api/alerts/previews?wallet=${INVALID_WALLET}`);
            assert.strictEqual(resBad.status, 400);

            const resOk = await fetch(`${BASE_URL}/api/alerts/previews`);
            assert.strictEqual(resOk.status, 200);
            const data = await resOk.json();
            assert.strictEqual(Array.isArray(data.previews), true);
            assert.strictEqual(typeof data.totalCount, "number");
        });
    });

    describe("5. Security, Origin Protection & CORS Headers", () => {
        it("blocks state mutation from unauthorized browser origin with 403 Forbidden", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Origin: "http://malicious-site.com",
                },
                body: JSON.stringify({ address: VALID_WALLET_2 }),
            });
            assert.strictEqual(res.status, 403);
            const data = await res.json();
            assert.match(data.error, /Unauthorized origin/i);
        });

        it("allows state mutation from authorized browser origin (http://localhost:5173)", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Origin: "http://localhost:5173",
                },
                body: JSON.stringify({ address: VALID_WALLET_2, alias: "Allowed Whale" }),
            });
            assert.strictEqual(res.status, 201);
            const data = await res.json();
            assert.strictEqual(data.success, true);
        });

        it("handles OPTIONS preflight with PATCH and DELETE in allowed methods", async () => {
            const res = await fetch(`${BASE_URL}/api/alerts/wallets`, {
                method: "OPTIONS",
                headers: { Origin: "http://localhost:5173" },
            });
            assert.strictEqual(res.status, 204);
            const allowedMethods = res.headers.get("Access-Control-Allow-Methods");
            assert.notStrictEqual(allowedMethods, null);
            assert.match(allowedMethods!, /PATCH/);
            assert.match(allowedMethods!, /DELETE/);
        });
    });
});
