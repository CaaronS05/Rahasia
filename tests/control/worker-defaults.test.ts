import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = process.cwd();

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

function stopServer(proc: ChildProcess | null): Promise<void> {
    if (!proc || proc.killed) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
    return promise;
}

describe("Worker Defaults and Overrides Regression Suite", () => {
    describe("1. Script Source Invariants & Parsing Contracts", () => {
        it("LP Agent scrape script defaults concurrency to 8", () => {
            const scriptPath = path.join(ROOT, "scripts/lpagent/scrape-smart-lp.mjs");
            const content = fs.readFileSync(scriptPath, "utf8");
            assert.match(
                content,
                /process\.env\.LPAGENT_CONCURRENCY\s*\?\?\s*["']8["']/
            );
        });

        it("Fabriq wallet enrichment script defaults concurrency to 8", () => {
            const scriptPath = path.join(ROOT, "scripts/fabriq/enrich-wallets.mjs");
            const content = fs.readFileSync(scriptPath, "utf8");
            assert.match(
                content,
                /process\.env\.FABRIQ_CONCURRENCY\s*\?\?\s*["']8["']/
            );
        });

        it("Frontend WalletDataControlPanel defaults worker states to 8", () => {
            const uiPath = path.join(ROOT, "frontend/src/components/data/WalletDataControlPanel.tsx");
            const content = fs.readFileSync(uiPath, "utf8");
            assert.match(
                content,
                /const\s*\[concurrency,\s*setConcurrency\]\s*=\s*useState<number>\(8\);/
            );
            assert.match(
                content,
                /const\s*\[lpConcurrency,\s*setLpConcurrency\]\s*=\s*useState<number>\(8\);/
            );
            assert.match(
                content,
                /const\s*\[lpFabriqConcurrency,\s*setLpFabriqConcurrency\]\s*=\s*useState<number>\(8\);/
            );
            assert.match(
                content,
                /state\?\.concurrency\s*\?\?\s*8/
            );
        });

        it("Frontend control clients default fallbacks to 8", () => {
            const fabriqClientPath = path.join(ROOT, "frontend/src/lib/fabriqControl.ts");
            const fabriqContent = fs.readFileSync(fabriqClientPath, "utf8");
            assert.match(
                fabriqContent,
                /concurrency:\s*params\.concurrency\s*\?\?\s*8/
            );
            assert.match(
                fabriqContent,
                /concurrency:\s*params\?\.concurrency\s*\?\?\s*8/
            );

            const lpClientPath = path.join(ROOT, "frontend/src/lib/lpAgentControl.ts");
            const lpContent = fs.readFileSync(lpClientPath, "utf8");
            assert.match(
                lpContent,
                /concurrency:\s*Math\.max\(1,\s*Math\.floor\(params\?\.concurrency\s*\?\?\s*8\)\)/
            );
            assert.match(
                lpContent,
                /fabriqConcurrency:\s*Math\.max\(1,\s*Math\.floor\(params\?\.fabriqConcurrency\s*\?\?\s*8\)\)/
            );
        });
    });

    describe("2. Control Server Default Baseline (No Environment Overrides)", () => {
        const TEST_PORT = 8994;
        let server: ChildProcess | null = null;

        before(async () => {
            const cleanEnv = { ...process.env };
            delete cleanEnv.FABRIQ_CONCURRENCY;
            delete cleanEnv.LPAGENT_CONCURRENCY;
            cleanEnv.CONTROL_SERVER_PORT = String(TEST_PORT);
            cleanEnv.PORT = String(TEST_PORT);

            server = spawn(process.execPath, ["scripts/control/server.mjs"], {
                cwd: ROOT,
                env: cleanEnv,
                stdio: "pipe",
            });
            await waitForServerReady(server);
        });

        after(async () => {
            await stopServer(server);
            server = null;
        });

        it("GET /api/fabriq/status returns default concurrency of 8", async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fabriq/status`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.concurrency, 8);
        });

        it("GET /api/lpagent/status returns default concurrency 8 and fabriqConcurrency 8", async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/lpagent/status`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.concurrency, 8);
            assert.equal(data.fabriqConcurrency, 8);
        });
    });

    describe("3. Control Server Environment Overrides", () => {
        const TEST_PORT = 8995;
        let server: ChildProcess | null = null;

        before(async () => {
            const envWithOverrides = {
                ...process.env,
                FABRIQ_CONCURRENCY: "14",
                LPAGENT_CONCURRENCY: "6",
                CONTROL_SERVER_PORT: String(TEST_PORT),
                PORT: String(TEST_PORT),
            };

            server = spawn(process.execPath, ["scripts/control/server.mjs"], {
                cwd: ROOT,
                env: envWithOverrides,
                stdio: "pipe",
            });
            await waitForServerReady(server);
        });

        after(async () => {
            await stopServer(server);
            server = null;
        });

        it("GET /api/fabriq/status reflects FABRIQ_CONCURRENCY env override of 14", async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fabriq/status`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.concurrency, 14);
        });

        it("GET /api/lpagent/status reflects LPAGENT_CONCURRENCY env (6) and FABRIQ_CONCURRENCY env (14)", async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/lpagent/status`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.concurrency, 6);
            assert.equal(data.fabriqConcurrency, 14);
        });
    });

    describe("4. Control Server Invalid Environment Fallback", () => {
        const TEST_PORT = 8996;
        let server: ChildProcess | null = null;

        before(async () => {
            const envWithInvalid = {
                ...process.env,
                FABRIQ_CONCURRENCY: "invalid_string",
                LPAGENT_CONCURRENCY: "-10",
                CONTROL_SERVER_PORT: String(TEST_PORT),
                PORT: String(TEST_PORT),
            };

            server = spawn(process.execPath, ["scripts/control/server.mjs"], {
                cwd: ROOT,
                env: envWithInvalid,
                stdio: "pipe",
            });
            await waitForServerReady(server);
        });

        after(async () => {
            await stopServer(server);
            server = null;
        });

        it("Invalid FABRIQ_CONCURRENCY safely falls back to default 8", async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fabriq/status`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.concurrency, 8);
        });

        it("Invalid LPAGENT_CONCURRENCY safely falls back to default 8", async () => {
            const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/lpagent/status`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.concurrency, 8);
            assert.equal(data.fabriqConcurrency, 8);
        });
    });

    describe("5. Concurrency Sanitization Logic Invariants", () => {
        function sanitizeConcurrency(value: unknown, fallback = 8): number {
            const parsed = Number.parseInt(String(value), 10);
            if (!Number.isFinite(parsed) || parsed < 1) {
                return fallback;
            }
            return parsed;
        }

        it("Preserves valid explicit integer overrides", () => {
            assert.equal(sanitizeConcurrency(1), 1);
            assert.equal(sanitizeConcurrency(4), 4);
            assert.equal(sanitizeConcurrency(8), 8);
            assert.equal(sanitizeConcurrency(16), 16);
            assert.equal(sanitizeConcurrency(32), 32);
        });

        it("Parses valid numeric string overrides", () => {
            assert.equal(sanitizeConcurrency("12"), 12);
            assert.equal(sanitizeConcurrency(" 24 "), 24);
        });

        it("Truncates float string or numbers to integer", () => {
            assert.equal(sanitizeConcurrency(6.8), 6);
            assert.equal(sanitizeConcurrency("10.5"), 10);
        });

        it("Falls back to default 8 for invalid, non-positive, or missing inputs", () => {
            assert.equal(sanitizeConcurrency(undefined), 8);
            assert.equal(sanitizeConcurrency(null), 8);
            assert.equal(sanitizeConcurrency(""), 8);
            assert.equal(sanitizeConcurrency("not-a-number"), 8);
            assert.equal(sanitizeConcurrency(0), 8);
            assert.equal(sanitizeConcurrency(-5), 8);
        });

        it("Supports custom fallback when supplied", () => {
            assert.equal(sanitizeConcurrency("invalid", 12), 12);
            assert.equal(sanitizeConcurrency(-1, 4), 4);
        });
    });
});
