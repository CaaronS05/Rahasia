import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
    fabriqFetch,
    saveCheckpoint,
    loadCheckpoint,
    MAX_404_RETRIES,
    RETRY_404_DELAY_MS,
} from "../../scripts/fabriq/enrich-wallets.mjs";

describe("Fabriq 404 Retry & Checkpoint Error Handling Suite", () => {
    it("1. Baseline defaults: MAX_404_RETRIES is 3 and RETRY_404_DELAY_MS is 5000", () => {
        assert.equal(MAX_404_RETRIES, 3);
        assert.equal(RETRY_404_DELAY_MS, 5000);
    });

    it("2. Repeated 404 stops after maximum 3 retries (4 total requests) with bounded delays", async () => {
        let fetchCallCount = 0;
        const requestedUrls: string[] = [];
        const sleepDelays: number[] = [];

        const mockFetch = async (url: string) => {
            fetchCallCount++;
            requestedUrls.push(url);
            return {
                status: 404,
                ok: false,
                statusText: "Not Found",
                headers: new Headers(),
                text: async () => "Not Found",
                json: async () => ({ error: "Not Found" }),
            } as unknown as Response;
        };

        const mockSleep = async (ms: number) => {
            sleepDelays.push(ms);
        };

        const mockMetrics = {
            totalRequests: 0,
            activeRequests: 0,
            peakActiveRequests: 0,
            networkRequestsInFlight: 0,
            peakNetworkRequests: 0,
            allLatencies: [],
            statsLatencies: [],
            calendarLatencies: [],
            http401Count: 0,
            http429Count: 0,
            http403Count: 0,
            http404Count: 0,
            http5xxCount: 0,
            networkErrorCount: 0,
            retryWaitTimeMs: 0,
        };

        const mockScheduler = {
            acquire: async () => {},
            release: () => {},
            onSuccess: () => {},
            onRateLimit: () => {},
            onServerError: () => {},
        };

        await assert.rejects(
            async () => {
                await fabriqFetch(
                    "https://apinew.fabriq.trade/portfolio/stats/MockWallet404",
                    1,
                    0,
                    {
                        fetchFn: mockFetch,
                        getTokenFn: async () => "mock.jwt.token",
                        sleepFn: mockSleep,
                        scheduler: mockScheduler,
                        metrics: mockMetrics,
                        max404Retries: 3,
                        retry404DelayMs: 25,
                    }
                );
            },
            {
                name: "Error",
                message: "404 Not Found after retries",
            }
        );

        // 1 initial request + 3 retries = exactly 4 attempts
        assert.equal(fetchCallCount, 4, "Must execute exactly 4 total attempts for 3 retries");
        // Exactly 3 delay pauses between attempts
        assert.deepEqual(sleepDelays, [25, 25, 25], "Must sleep exactly 3 times with bounded delay");
        // Metrics properly recorded
        assert.equal(mockMetrics.http404Count, 4, "Must record 4 404 responses in metrics");
        assert.equal(mockMetrics.retryWaitTimeMs, 75, "Must record total retry wait time");
    });

    it("3. Successful recovery: 404 on attempt 1 & 2 recovers on attempt 3 without throwing", async () => {
        let fetchCallCount = 0;
        const sleepDelays: number[] = [];

        const mockFetch = async () => {
            fetchCallCount++;
            if (fetchCallCount < 3) {
                return {
                    status: 404,
                    ok: false,
                    statusText: "Not Found",
                    headers: new Headers(),
                    text: async () => "Not Found",
                } as unknown as Response;
            }
            return {
                status: 200,
                ok: true,
                statusText: "OK",
                headers: new Headers(),
                json: async () => ({
                    success: true,
                    data: {
                        totalPositions: 10,
                        netPnlSol: 5.25,
                    },
                }),
            } as unknown as Response;
        };

        const mockSleep = async (ms: number) => {
            sleepDelays.push(ms);
        };

        const mockMetrics = {
            totalRequests: 0,
            activeRequests: 0,
            peakActiveRequests: 0,
            networkRequestsInFlight: 0,
            peakNetworkRequests: 0,
            allLatencies: [],
            statsLatencies: [],
            calendarLatencies: [],
            http401Count: 0,
            http429Count: 0,
            http403Count: 0,
            http404Count: 0,
            http5xxCount: 0,
            networkErrorCount: 0,
            retryWaitTimeMs: 0,
        };

        const mockScheduler = {
            acquire: async () => {},
            release: () => {},
            onSuccess: () => {},
            onRateLimit: () => {},
            onServerError: () => {},
        };

        const result = await fabriqFetch(
            "https://apinew.fabriq.trade/portfolio/stats/MockWalletRecover",
            1,
            0,
            {
                fetchFn: mockFetch,
                getTokenFn: async () => "mock.jwt.token",
                sleepFn: mockSleep,
                scheduler: mockScheduler,
                metrics: mockMetrics,
                max404Retries: 3,
                retry404DelayMs: 15,
            }
        );

        assert.equal(fetchCallCount, 3, "Attempt 1 (404), Attempt 2 (404), Attempt 3 (200 OK)");
        assert.deepEqual(sleepDelays, [15, 15], "Slept twice before recovering");
        assert.equal(mockMetrics.http404Count, 2, "Recorded 2 404 responses");
        assert.deepEqual(result, {
            success: true,
            data: {
                totalPositions: 10,
                netPnlSol: 5.25,
            },
        });
    });

    it("4. Checkpoint error handling: status 'error' is recorded, excluded from completed resume map, and retried", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabriq-ckpt-test-"));
        const tempCheckpointFile = path.join(tempDir, "checkpoint.jsonl");

        try {
            // Step 1: Save successful wallet A
            const walletA = {
                owner: "WalletA_Success",
                status: "ok",
                fabriq: {
                    fetchedAt: new Date().toISOString(),
                    stats: { totalPositions: 5 },
                    calendars: {
                        "2026-07": {},
                        "2026-08": {},
                        "2026-09": {},
                        "2026-10": {},
                    },
                },
            };
            await saveCheckpoint(walletA, tempCheckpointFile);

            // Step 2: Save failed wallet B (404 terminal failure)
            const walletB = {
                owner: "WalletB_Failed",
                status: "error",
                failedAt: new Date().toISOString(),
                error: "404 Not Found after retries",
            };
            await saveCheckpoint(walletB, tempCheckpointFile);

            // Step 3: Load checkpoint
            let map = await loadCheckpoint(null, tempCheckpointFile);

            // Verify: Wallet A is present and marked ok
            assert.ok(map.has("WalletA_Success"));
            assert.equal(map.get("WalletA_Success")?.status, "ok");

            // Verify: Wallet B with status 'error' MUST NEVER be present as completed in map
            assert.equal(
                map.has("WalletB_Failed"),
                false,
                "Errored wallet must not exist in completed checkpoint map"
            );

            // Step 4: Subsequent run succeeds for Wallet B -> appended to checkpoint
            const walletBRecovered = {
                owner: "WalletB_Failed",
                status: "ok",
                fabriq: {
                    fetchedAt: new Date().toISOString(),
                    stats: { totalPositions: 2 },
                    calendars: {
                        "2026-07": {},
                        "2026-08": {},
                        "2026-09": {},
                        "2026-10": {},
                    },
                },
            };
            await saveCheckpoint(walletBRecovered, tempCheckpointFile);

            // Step 5: Reload checkpoint -> Wallet B is now completed
            map = await loadCheckpoint(null, tempCheckpointFile);
            assert.ok(map.has("WalletB_Failed"));
            assert.equal(map.get("WalletB_Failed")?.status, "ok");

            // Step 6: If Wallet A subsequently encounters an error record, it gets purged from completed
            const walletAFailure = {
                owner: "WalletA_Success",
                status: "error",
                failedAt: new Date().toISOString(),
                error: "Network timeout",
            };
            await saveCheckpoint(walletAFailure, tempCheckpointFile);

            map = await loadCheckpoint(null, tempCheckpointFile);
            assert.equal(
                map.has("WalletA_Success"),
                false,
                "New error record for previously successful wallet must invalidate completed status"
            );
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
