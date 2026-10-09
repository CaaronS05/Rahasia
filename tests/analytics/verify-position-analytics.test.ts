import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    runVerificationCli,
    parseVerificationCliArgs,
} from "../../scripts/analytics/verify-position-analytics.ts";
import {
    loadPublishedPositionPair,
    getBundleFilePath,
} from "../../scripts/analytics/position-analytics-storage.ts";

const TEST_VERIFICATION_DIR = "data/test-analytics-verification-cli";
const KNOWN_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const KNOWN_POSITIONS = [
    "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
    "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1",
    "2EHE8MFF2DFjS76RWiMpHHRmpMNzuSzzg6U4jty492c2",
];

describe("Meteora Verification CLI Runner Suite", () => {
    // -------------------------------------------------------------------------
    // 1. CLI ARGUMENT PARSER
    // -------------------------------------------------------------------------
    it("1. CLI Argument parser: correctly parses repeated and comma-separated flags", () => {
        const args = [
            "--wallet", KNOWN_WALLET,
            "--period", "90D",
            "--position", KNOWN_POSITIONS[0],
            "--position", `${KNOWN_POSITIONS[1]},${KNOWN_POSITIONS[2]}`,
            "--max-attempts", "5",
        ];
        const parsed = parseVerificationCliArgs(args);
        assert.equal(parsed.wallet, KNOWN_WALLET);
        assert.equal(parsed.period, "90D");
        assert.equal(parsed.positions.length, 3);
        assert.equal(parsed.positions[0], KNOWN_POSITIONS[0]);
        assert.equal(parsed.positions[1], KNOWN_POSITIONS[1]);
        assert.equal(parsed.positions[2], KNOWN_POSITIONS[2]);
        assert.equal(parsed.maxAttempts, 5);
    });

    // -------------------------------------------------------------------------
    // 2. INVALID INPUT VALIDATION
    // -------------------------------------------------------------------------
    it("2. Validation: rejects invalid wallet, period, and position inputs", async () => {
        // Invalid wallet
        const resWallet = await runVerificationCli({
            wallet: "invalid-wallet-address",
            positions: [KNOWN_POSITIONS[0]],
        });
        assert.equal(resWallet.success, false);
        assert.ok(resWallet.error?.includes("INVALID_WALLET"));

        // Invalid period
        const resPeriod = await runVerificationCli({
            wallet: KNOWN_WALLET,
            period: "INVALID_PERIOD" as unknown as AnalyticsPeriod,
            positions: [KNOWN_POSITIONS[0]],
        });
        assert.equal(resPeriod.success, false);
        assert.ok(resPeriod.error?.includes("INVALID_PERIOD"));

        // Missing positions (explicit selection required)
        const resEmptyPos = await runVerificationCli({
            wallet: KNOWN_WALLET,
            positions: [],
        });
        assert.equal(resEmptyPos.success, false);
        assert.ok(resEmptyPos.error?.includes("EXPLICIT_POSITION_REQUIRED"));

        // Invalid position address
        const resInvalidPos = await runVerificationCli({
            wallet: KNOWN_WALLET,
            positions: ["not-a-valid-solana-address"],
        });
        assert.equal(resInvalidPos.success, false);
        assert.ok(resInvalidPos.error?.includes("INVALID_POSITION"));
    });

    // -------------------------------------------------------------------------
    // 3. SELECTION LIMIT: MAXIMUM 3 POSITIONS
    // -------------------------------------------------------------------------
    it("3. Position limit: enforces hard cap of maximum 3 positions per run", async () => {
        const fourPositions = [
            KNOWN_POSITIONS[0],
            KNOWN_POSITIONS[1],
            KNOWN_POSITIONS[2],
            "KdV4adnqoAxMvp1nPCUP35jn5WwjQJ1g8MiNmcMGU6z",
        ];
        const res = await runVerificationCli({
            wallet: KNOWN_WALLET,
            positions: fourPositions,
        });
        assert.equal(res.success, false);
        assert.ok(res.error?.includes("POSITION_LIMIT_EXCEEDED"));
    });

    // -------------------------------------------------------------------------
    // 4. MISSING PUBLISHED DATASET
    // -------------------------------------------------------------------------
    it("4. Dataset existence: returns error when published dataset is absent", async () => {
        const unknownWallet = "11111111111111111111111111111111";
        const res = await runVerificationCli({
            wallet: unknownWallet,
            positions: [KNOWN_POSITIONS[0]],
        });
        assert.equal(res.success, false);
        assert.ok(res.error?.includes("DATASET_NOT_FOUND"));
    });

    // -------------------------------------------------------------------------
    // 5. UNKNOWN POSITION ID NOT IN DATASET
    // -------------------------------------------------------------------------
    it("5. Dataset alignment: rejects position IDs absent from published bundle", async () => {
        const absentValidPos = "So11111111111111111111111111111111111111112";
        const res = await runVerificationCli({
            wallet: KNOWN_WALLET,
            positions: [absentValidPos],
        });
        assert.equal(res.success, false);
        assert.ok(res.error?.includes("POSITION_NOT_IN_DATASET"));
        assert.ok(res.error?.includes(absentValidPos));
    });

    // -------------------------------------------------------------------------
    // 6. SUCCESSFUL 3-POSITION VERIFICATION RUN
    // -------------------------------------------------------------------------
    it("6. Successful 3-position verification: verifies all 3 positions against mocked Meteora API", async () => {
        let httpCallCount = 0;

        const mockFetch = async (url: string) => {
            httpCallCount++;
            const u = new URL(url);

            // Mock closed positions matching the requested positions
            const positionsPayload = [
                {
                    positionAddress: KNOWN_POSITIONS[0],
                    poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
                    userAddress: KNOWN_WALLET,
                    isClosed: true,
                    createdAt: 1789507841,
                    closedAt: 1789508926,
                    pnlUsd: "30.565",
                    tokenX: "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR",
                    tokenY: "So11111111111111111111111111111111111111112",
                    allTimeDeposits: { total: { usd: "19347.056" } },
                    allTimeWithdrawals: { total: { usd: "19377.477" } },
                    allTimeFees: { total: { usd: "0.144" } },
                },
                {
                    positionAddress: KNOWN_POSITIONS[1],
                    poolAddress: "zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX",
                    userAddress: KNOWN_WALLET,
                    isClosed: true,
                    createdAt: 1789507544,
                    closedAt: 1789508883,
                    pnlUsd: "-13.064",
                    allTimeDeposits: { total: { usd: "500.00" } },
                    allTimeWithdrawals: { total: { usd: "486.936" } },
                },
                {
                    positionAddress: KNOWN_POSITIONS[2],
                    poolAddress: "zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX",
                    userAddress: KNOWN_WALLET,
                    isClosed: true,
                    createdAt: 1789446842,
                    closedAt: 1789506049,
                    pnlUsd: "-268.811",
                    allTimeDeposits: { total: { usd: "1000.00" } },
                    allTimeWithdrawals: { total: { usd: "731.189" } },
                },
            ];

            return new Response(JSON.stringify({
                positions: positionsPayload,
                hasNext: false,
                total: positionsPayload.length,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };

        const res = await runVerificationCli({
            wallet: KNOWN_WALLET,
            period: "30D",
            positions: KNOWN_POSITIONS,
            verificationBaseDir: TEST_VERIFICATION_DIR,
            fetchFn: mockFetch,
        });

        assert.equal(res.success, true);
        assert.ok(res.report);
        assert.ok(res.savedPath);
        assert.equal(res.report.summary.totalPositionsEvaluated, 3);
        assert.equal(res.report.positions.length, 3);
        assert.ok(httpCallCount > 0, "Network requests must be executed");

        // Verify report file on disk
        assert.ok(fs.existsSync(res.savedPath));
        const savedData = JSON.parse(fs.readFileSync(res.savedPath, "utf8"));
        assert.equal(savedData.targetWallet, KNOWN_WALLET);
        assert.equal(savedData.summary.totalPositionsEvaluated, 3);

        // Cleanup
        if (fs.existsSync(TEST_VERIFICATION_DIR)) {
            fs.rmSync(TEST_VERIFICATION_DIR, { recursive: true, force: true });
        }
    });

    // -------------------------------------------------------------------------
    // 7. INCOMPLETE PAGINATION: EXITS WITH FAILURE AND NEVER SAVES REPORT
    // -------------------------------------------------------------------------
    it("7. Incomplete pagination handling: exits nonzero and prevents saving incomplete reports", async () => {
        // Mock API that hits page cap with hasNext=true
        const mockFetchIncomplete = async () => {
            return new Response(JSON.stringify({
                positions: [{ positionAddress: "other-pos", isClosed: true }],
                hasNext: true,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };

        const res = await runVerificationCli({
            wallet: KNOWN_WALLET,
            period: "30D",
            positions: [KNOWN_POSITIONS[0]],
            verificationBaseDir: TEST_VERIFICATION_DIR,
            fetchFn: mockFetchIncomplete,
        });

        assert.equal(res.success, false);
        assert.ok(res.error?.includes("INCOMPLETE_PAGINATION"));
        assert.equal(res.savedPath, undefined);

        // Verify no report was written to disk
        const expectedReportPath = path.resolve(TEST_VERIFICATION_DIR, KNOWN_WALLET, "30D.json");
        assert.equal(fs.existsSync(expectedReportPath), false, "Incomplete report must NEVER be persisted");
    });

    // -------------------------------------------------------------------------
    // 8. TERMINAL HTTP 403 / 404 HALTS EXECUTION
    // -------------------------------------------------------------------------
    it("8. Terminal network errors: halts execution on HTTP 403/404 and does not save report", async () => {
        let attempts = 0;
        const mockFetch403 = async () => {
            attempts++;
            return new Response(JSON.stringify({ message: "Access forbidden" }), {
                status: 403,
                statusText: "Forbidden",
            });
        };

        const res = await runVerificationCli({
            wallet: KNOWN_WALLET,
            positions: [KNOWN_POSITIONS[0]],
            verificationBaseDir: TEST_VERIFICATION_DIR,
            fetchFn: mockFetch403,
        });

        assert.equal(res.success, false);
        assert.ok(res.error?.includes("VERIFICATION_FAILED"));
        assert.ok(res.error?.includes("403"));
        assert.equal(attempts, 1, "Must fail on attempt 1 without retry");
        assert.equal(res.savedPath, undefined);
    });

    // -------------------------------------------------------------------------
    // 9. REPORT ISOLATION & BUNDLE IMMUTABILITY
    // -------------------------------------------------------------------------
    it("9. Immutability guarantee: published bundle file is byte-for-byte unmodified after run", async () => {
        const bundlePath = getBundleFilePath(KNOWN_WALLET, "30D");
        assert.ok(fs.existsSync(bundlePath), `Existing bundle must exist at ${bundlePath}`);

        const bundleBytesBefore = fs.readFileSync(bundlePath);
        const hashBefore = crypto.createHash("sha256").update(bundleBytesBefore).digest("hex");

        const mockFetch = async () => {
            return new Response(JSON.stringify({
                positions: [
                    {
                        positionAddress: KNOWN_POSITIONS[0],
                        poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
                        userAddress: KNOWN_WALLET,
                        isClosed: true,
                        pnlUsd: "30.565",
                    },
                ],
                hasNext: false,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };

        const res = await runVerificationCli({
            wallet: KNOWN_WALLET,
            period: "30D",
            positions: [KNOWN_POSITIONS[0]],
            verificationBaseDir: TEST_VERIFICATION_DIR,
            fetchFn: mockFetch,
        });

        assert.equal(res.success, true);

        // Check bundle immutability
        const bundleBytesAfter = fs.readFileSync(bundlePath);
        const hashAfter = crypto.createHash("sha256").update(bundleBytesAfter).digest("hex");
        assert.equal(hashAfter, hashBefore, "Published bundle SHA-256 must remain identical");

        // Cleanup
        if (fs.existsSync(TEST_VERIFICATION_DIR)) {
            fs.rmSync(TEST_VERIFICATION_DIR, { recursive: true, force: true });
        }
    });
});
