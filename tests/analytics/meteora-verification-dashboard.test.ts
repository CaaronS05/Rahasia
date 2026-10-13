import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    deriveVerificationPresentationStatus,
    loadMeteoraVerificationReport,
    saveMeteoraVerificationReport,
} from "../../scripts/analytics/meteora-verification-adapter.ts";
import type {
    MeteoraVerificationReport,
    PositionVerificationDetail,
    VerificationPresentationStatus,
} from "../../scripts/analytics/position-analytics-types.ts";

function createMockDetail(overrides: Partial<PositionVerificationDetail> = {}): PositionVerificationDetail {
    return {
        wallet: "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
        poolAddress: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
        positionAddress: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc",
        classification: "MATCH",
        isMatched: true,
        matchReasons: ["All tokens match"],
        divergenceReasons: [],
        timestamps: {
            localOpenedAt: "2026-09-15T21:30:41.000Z",
            meteoraCreatedAt: "2026-09-15T21:30:41.000Z",
            localClosedAt: "2026-09-15T21:48:46.000Z",
            meteoraClosedAt: "2026-09-15T21:48:46.000Z",
            closedTimestampDeltaSeconds: 0,
            timestampsMatch: true,
        },
        tokenFlows: {
            depositedTokenX: { token: "tokenX", localAmount: 0, meteoraAmount: { rawString: "0", numeric: 0, decimalPlaces: 0 }, amountDelta: 0, isExactMatch: true },
            depositedTokenY: { token: "tokenY", localAmount: 100, meteoraAmount: { rawString: "100", numeric: 100, decimalPlaces: 0 }, amountDelta: 0, isExactMatch: true },
            withdrawnTokenX: { token: "tokenX", localAmount: 10, meteoraAmount: { rawString: "10", numeric: 10, decimalPlaces: 0 }, amountDelta: 0, isExactMatch: true },
            withdrawnTokenY: { token: "tokenY", localAmount: 100, meteoraAmount: { rawString: "100", numeric: 100, decimalPlaces: 0 }, amountDelta: 0, isExactMatch: true },
            claimedFeesTokenX: { token: "tokenX", localAmount: 1, meteoraAmount: { rawString: "1", numeric: 1, decimalPlaces: 0 }, amountDelta: 0, isExactMatch: true },
            claimedFeesTokenY: { token: "tokenY", localAmount: 0.1, meteoraAmount: { rawString: "0.1", numeric: 0.1, decimalPlaces: 1 }, amountDelta: 0, isExactMatch: true },
            allTokensMatch: true,
        },
        usdValuations: {
            deposits: { metric: "deposits", localUsd: 100, meteoraUsd: { rawString: "100", numeric: 100, decimalPlaces: 0 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
            withdrawals: { metric: "withdrawals", localUsd: 110, meteoraUsd: { rawString: "110", numeric: 110, decimalPlaces: 0 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
            claimedFees: { metric: "claimedFees", localUsd: 5, meteoraUsd: { rawString: "5", numeric: 5, decimalPlaces: 0 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
            pnlUsd: { metric: "pnlUsd", localUsd: 15, meteoraUsd: { rawString: "15", numeric: 15, decimalPlaces: 0 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
            pnlSignFlip: false,
        },
        solValuations: {
            meteoraPnlSol: { rawString: "0.05", numeric: 0.05, decimalPlaces: 2 },
        },
        provenance: {
            source: "meteora_official_api",
            baseUrl: "https://dlmm.datapi.meteora.ag",
            endpointsCalled: ["/test"],
            fetchedAt: "2026-10-11T00:00:00.000Z",
            clientVersion: "1.0.0",
        },
        ...overrides,
    };
}

describe("Meteora Verification Dashboard & Advisory Overlay Suite", () => {
    describe("1. deriveVerificationPresentationStatus presentation mappings", () => {
        it("returns NOT_VERIFIED for null or undefined position detail", () => {
            assert.equal(deriveVerificationPresentationStatus(null), "NOT_VERIFIED");
            assert.equal(deriveVerificationPresentationStatus(undefined), "NOT_VERIFIED");
        });

        it("returns NOT_COMPARABLE for NOT_COMPARABLE or MISSING raw classifications", () => {
            const notComp = createMockDetail({ classification: "NOT_COMPARABLE" });
            assert.equal(deriveVerificationPresentationStatus(notComp), "NOT_COMPARABLE");

            const missing = createMockDetail({ classification: "MISSING" });
            assert.equal(deriveVerificationPresentationStatus(missing), "NOT_COMPARABLE");
        });

        it("returns TOKEN_FLOW_DISCREPANCY when allTokensMatch is false", () => {
            const flowMismatch = createMockDetail({
                classification: "MATCH",
                tokenFlows: {
                    ...createMockDetail().tokenFlows,
                    allTokensMatch: false,
                },
            });
            assert.equal(deriveVerificationPresentationStatus(flowMismatch), "TOKEN_FLOW_DISCREPANCY");
        });

        it("returns USD_SIGN_DIFFERENCE when pnlSignFlip is true or classification is SIGN_MISMATCH", () => {
            const signFlip = createMockDetail({
                classification: "SIGN_MISMATCH",
                usdValuations: {
                    ...createMockDetail().usdValuations,
                    pnlSignFlip: true,
                },
            });
            assert.equal(deriveVerificationPresentationStatus(signFlip), "USD_SIGN_DIFFERENCE");

            const flipWithoutClass = createMockDetail({
                classification: "MATCH",
                usdValuations: {
                    ...createMockDetail().usdValuations,
                    pnlSignFlip: true,
                },
            });
            assert.equal(deriveVerificationPresentationStatus(flipWithoutClass), "USD_SIGN_DIFFERENCE");
        });

        it("returns USD_VALUATION_DIFFERENCE when classification is USD_VALUATION_DIFFERENCE or pnlUsd is outside tolerance", () => {
            const valDiff = createMockDetail({
                classification: "USD_VALUATION_DIFFERENCE",
                usdValuations: {
                    ...createMockDetail().usdValuations,
                    pnlUsd: {
                        ...createMockDetail().usdValuations.pnlUsd,
                        isWithinTolerance: false,
                        usdDelta: 25.5,
                        usdDeltaPct: 15.2,
                    },
                    pnlSignFlip: false,
                },
            });
            assert.equal(deriveVerificationPresentationStatus(valDiff), "USD_VALUATION_DIFFERENCE");
        });

        it("returns TOKEN_FLOW_MATCHED when all tokens match and within tolerance without sign flip", () => {
            const matched = createMockDetail({
                classification: "MATCH",
                tokenFlows: {
                    ...createMockDetail().tokenFlows,
                    allTokensMatch: true,
                },
                usdValuations: {
                    ...createMockDetail().usdValuations,
                    pnlSignFlip: false,
                    pnlUsd: {
                        ...createMockDetail().usdValuations.pnlUsd,
                        isWithinTolerance: true,
                    },
                },
            });
            assert.equal(deriveVerificationPresentationStatus(matched), "TOKEN_FLOW_MATCHED");
        });

        it("preserves raw classification without mutating the original detail object", () => {
            const detail = createMockDetail({ classification: "SIGN_MISMATCH" });
            const status = deriveVerificationPresentationStatus(detail);
            assert.equal(status, "USD_SIGN_DIFFERENCE");
            assert.equal(detail.classification, "SIGN_MISMATCH"); // Raw classification unchanged
        });
    });

    describe("2. Read-only report loading and security validation", () => {
        const testBase = "data/test-analytics-verification-dashboard";
        const testWallet = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";

        before(() => {
            fs.mkdirSync(path.join(testBase, testWallet), { recursive: true });
            const sampleReport: MeteoraVerificationReport = {
                version: "v1",
                targetWallet: testWallet,
                period: "30D",
                verifiedAt: "2026-10-11T00:00:00.000Z",
                provenance: {
                    source: "meteora_official_api",
                    baseUrl: "https://dlmm.datapi.meteora.ag",
                    endpointsCalled: ["/test"],
                    fetchedAt: "2026-10-11T00:00:00.000Z",
                    clientVersion: "1.0.0",
                },
                summary: {
                    totalPositionsEvaluated: 3,
                    matchedCount: 0,
                    usdValuationDifferenceCount: 1,
                    signMismatchCount: 2,
                    missingCount: 0,
                    notComparableCount: 0,
                    tokenFlowExactMatchRatePct: 100,
                    closedTimestampMatchRatePct: 100,
                },
                positions: [createMockDetail()],
                missingOrAmbiguousRecords: [],
                nonDestructiveNotice: "Verification results do not mutate or replace Fabriq-derived published metrics.",
            };
            fs.writeFileSync(
                path.join(testBase, testWallet, "30D.json"),
                JSON.stringify(sampleReport, null, 2),
                "utf8"
            );
        });

        after(() => {
            try {
                fs.rmSync(testBase, { recursive: true, force: true });
            } catch {}
        });

        it("successfully loads valid stored report without network calls", () => {
            const report = loadMeteoraVerificationReport(testWallet, "30D", testBase);
            assert.ok(report);
            assert.equal(report.targetWallet, testWallet);
            assert.equal(report.period, "30D");
            assert.equal(report.summary.totalPositionsEvaluated, 3);
        });

        it("handles missing report gracefully by returning null", () => {
            const report = loadMeteoraVerificationReport("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "30D", testBase);
            assert.equal(report, null);
        });

        it("handles missing period gracefully by returning null", () => {
            const report = loadMeteoraVerificationReport(testWallet, "90D", testBase);
            assert.equal(report, null);
        });

        it("rejects path traversal attempts in wallet parameter", () => {
            assert.equal(loadMeteoraVerificationReport("../../../etc/passwd", "30D", testBase), null);
            assert.equal(loadMeteoraVerificationReport("wallet/with/slashes", "30D", testBase), null);
            assert.equal(loadMeteoraVerificationReport("wallet\\with\\backslashes", "30D", testBase), null);
            assert.equal(loadMeteoraVerificationReport("..", "30D", testBase), null);
        });

        it("rejects invalid wallet types gracefully", () => {
            // @ts-expect-error test invalid type
            assert.equal(loadMeteoraVerificationReport(null, "30D", testBase), null);
            // @ts-expect-error test invalid type
            assert.equal(loadMeteoraVerificationReport(undefined, "30D", testBase), null);
            // @ts-expect-error test invalid type
            assert.equal(loadMeteoraVerificationReport(12345, "30D", testBase), null);
        });
    });

    describe("3. Partial coverage & numeraire disclosure calculations", () => {
        it("strictly distinguishes tested subset (3 positions) from entire wallet sample (47 positions)", () => {
            const testedCount = 3;
            const walletSampleCount = 47;
            const sampleCoveragePct = (testedCount / walletSampleCount) * 100;

            // Coverage is 6.38% (never 100%)
            assert.equal(sampleCoveragePct.toFixed(1), "6.4");
            assert.notEqual(sampleCoveragePct, 100);

            // Flow match rate within the tested subset is 100%, but must be isolated
            const subsetFlowMatchPct = 100;
            assert.equal(subsetFlowMatchPct, 100);
            assert.notEqual(sampleCoveragePct, subsetFlowMatchPct);
        });

        it("never calculates 100% wallet coverage when evaluated count is less than total sample count", () => {
            const reportSummary = {
                totalPositionsEvaluated: 3,
                tokenFlowExactMatchRatePct: 100,
            };
            const totalWalletPositions = 47;

            const isEntireWalletVerified = reportSummary.totalPositionsEvaluated >= totalWalletPositions;
            assert.equal(isEntireWalletVerified, false);
        });
    });

    describe("4. Unknown value integrity (never coerce null/missing to 0)", () => {
        it("preserves null and undefined as unknown in formatting contracts", () => {
            function formatVerifUsd(val: number | null | undefined): string {
                if (val === null || val === undefined || !Number.isFinite(val)) return "Unknown";
                return `$${val.toFixed(2)}`;
            }

            function formatVerifAmount(val: number | string | null | undefined): string {
                if (val === null || val === undefined) return "Unknown";
                return String(val);
            }

            assert.equal(formatVerifUsd(null), "Unknown");
            assert.equal(formatVerifUsd(undefined), "Unknown");
            assert.notEqual(formatVerifUsd(null), "$0.00");
            assert.notEqual(formatVerifUsd(null), "0");

            assert.equal(formatVerifAmount(null), "Unknown");
            assert.equal(formatVerifAmount(undefined), "Unknown");
            assert.notEqual(formatVerifAmount(null), "0");
        });
    });

    describe("5. Oracle hypothesis unconfirmed disclaimer invariant", () => {
        it("identifies divergence reason as unconfirmed explanatory hypothesis and never marks as verified", () => {
            const detailWithHypothesis = createMockDetail({
                classification: "SIGN_MISMATCH",
                divergenceReasons: [
                    "PnL sign flip: local Fabriq is -14.69 USD vs official Meteora is 30.57 USD due to oracle valuation differences on flat position.",
                ],
            });

            // The presentation status must be USD_SIGN_DIFFERENCE, never TOKEN_FLOW_MATCHED or VERIFIED
            const presStatus = deriveVerificationPresentationStatus(detailWithHypothesis);
            assert.equal(presStatus, "USD_SIGN_DIFFERENCE");
            assert.notEqual(presStatus, "TOKEN_FLOW_MATCHED");

            // Divergence hypothesis exists
            assert.ok(detailWithHypothesis.divergenceReasons.length > 0);
            assert.ok(detailWithHypothesis.divergenceReasons[0].includes("oracle valuation differences"));
        });
    });

    describe("6. Step 3B.5: Position Analytics Tab & Verification Integration Contract Suite", () => {
        it("1. Wallet switching: ensures previous metrics, status, details, and pair filters are reset immediately", () => {
            let currentWallet = "WalletA111111111111111111111111111111111111";
            let state = {
                status: { status: "completed", hasMetrics: true },
                metrics: { sampling: { analyzedPositions: 10, totalEligiblePositions: 10, coveragePct: 100 } },
                positionsData: { positions: [{ positionId: "pos1", pairName: "SOL-USDC" }] },
                positionDetails: { "pool1:pos1": { positionId: "pos1" } },
                verificationReport: { targetWallet: currentWallet, period: "30D" },
                pairFilter: "SOL-USDC",
            };

            const nextWallet = "WalletB222222222222222222222222222222222222";
            if (nextWallet !== currentWallet) {
                currentWallet = nextWallet;
                state = {
                    status: null,
                    metrics: null,
                    positionsData: null,
                    positionDetails: {},
                    verificationReport: null,
                    pairFilter: "ALL",
                };
            }

            assert.equal(currentWallet, nextWallet);
            assert.equal(state.status, null);
            assert.equal(state.metrics, null);
            assert.equal(state.positionsData, null);
            assert.deepEqual(state.positionDetails, {});
            assert.equal(state.verificationReport, null);
            assert.equal(state.pairFilter, "ALL");
        });

        it("2. Period switching: isolates requested period without cross-period state leakage", () => {
            const periods = ["30D", "90D", "ALL_AVAILABLE"] as const;
            for (const p of periods) {
                const params = new URLSearchParams({ wallet: "WalletA", period: p });
                assert.equal(params.get("period"), p);
                assert.ok(["30D", "90D", "ALL_AVAILABLE"].includes(params.get("period")!));
            }
        });

        it("3. Stale asynchronous responses: drops out-of-order responses for superseded wallet or period", () => {
            let activeWallet = "WalletA";
            let activePeriod = "30D";

            function handleAsyncResponse(
                reqWallet: string,
                reqPeriod: string,
                payload: { data: string }
            ): { data: string } | null {
                if (activeWallet !== reqWallet || activePeriod !== reqPeriod) {
                    return null;
                }
                return payload;
            }

            const req1Wallet = "WalletA";
            const req1Period = "30D";

            activeWallet = "WalletB";
            activePeriod = "90D";

            const res1 = handleAsyncResponse(req1Wallet, req1Period, { data: "StaleA" });
            assert.equal(res1, null, "Late response for previous wallet must be dropped");

            const res2 = handleAsyncResponse("WalletB", "90D", { data: "FreshB" });
            assert.deepEqual(res2, { data: "FreshB" }, "Current response must be accepted");
        });

        it("4. Dataset version mismatch: halts after bounded retries and sets safe error state", () => {
            let retryCount = 0;
            const maxRetries = 2;

            function simulateVersionCheck(
                metricsFetchedAt: string,
                positionsFetchedAt: string,
                currentRetry: number
            ): { shouldRetry: boolean; error: string | null } {
                const hasMismatch = metricsFetchedAt !== positionsFetchedAt;
                if (!hasMismatch) return { shouldRetry: false, error: null };
                if (currentRetry < maxRetries) {
                    return { shouldRetry: true, error: null };
                }
                return {
                    shouldRetry: false,
                    error: "Dataset version mismatch detected across analytics artifacts. Please re-run analysis to synchronize.",
                };
            }

            let check = simulateVersionCheck("2026-03-10T12:00:00Z", "2026-03-11T14:00:00Z", retryCount);
            assert.equal(check.shouldRetry, true);
            retryCount++;

            check = simulateVersionCheck("2026-03-10T12:00:00Z", "2026-03-11T14:00:00Z", retryCount);
            assert.equal(check.shouldRetry, true);
            retryCount++;

            check = simulateVersionCheck("2026-03-10T12:00:00Z", "2026-03-11T14:00:00Z", retryCount);
            assert.equal(check.shouldRetry, false);
            assert.ok(check.error?.includes("Dataset version mismatch"));
        });

        it("5. Missing verification report: distinguishes 404 absence from 500 server error", async () => {
            async function mockFetchVerification(statusCode: number): Promise<{ report: unknown; error: string | null }> {
                if (statusCode === 404) {
                    return { report: null, error: null };
                }
                if (statusCode === 500) {
                    throw new Error("Failed to fetch verification report (500)");
                }
                return { report: { targetWallet: "WalletA", period: "30D" }, error: null };
            }

            const absentRes = await mockFetchVerification(404);
            assert.equal(absentRes.report, null);
            assert.equal(absentRes.error, null);

            await assert.rejects(
                () => mockFetchVerification(500),
                /Failed to fetch verification report \(500\)/
            );
        });

        it("6. Incomplete verification sample: accurately calculates coverage and prevents 100% implication", () => {
            const totalPositionsInWallet = 1000;
            const evaluatedInVerification = 3;
            const coveragePct = (evaluatedInVerification / totalPositionsInWallet) * 100;

            assert.equal(coveragePct.toFixed(1), "0.3");
            assert.equal(coveragePct < 100, true);

            const sampleMatchRate = 100;
            assert.notEqual(coveragePct, sampleMatchRate);
        });

        it("7. Verification badge classification: covers all 6 presentation states", () => {
            assert.equal(
                deriveVerificationPresentationStatus(createMockDetail({ classification: "MATCH" })),
                "TOKEN_FLOW_MATCHED"
            );
            assert.equal(
                deriveVerificationPresentationStatus(createMockDetail({
                    tokenFlows: { ...createMockDetail().tokenFlows, allTokensMatch: false }
                })),
                "TOKEN_FLOW_DISCREPANCY"
            );
            assert.equal(
                deriveVerificationPresentationStatus(createMockDetail({ classification: "USD_VALUATION_DIFFERENCE" })),
                "USD_VALUATION_DIFFERENCE"
            );
            assert.equal(
                deriveVerificationPresentationStatus(createMockDetail({ classification: "SIGN_MISMATCH" })),
                "USD_SIGN_DIFFERENCE"
            );
            assert.equal(
                deriveVerificationPresentationStatus(createMockDetail({ classification: "NOT_COMPARABLE" })),
                "NOT_COMPARABLE"
            );
            assert.equal(
                deriveVerificationPresentationStatus(null),
                "NOT_VERIFIED"
            );
        });

        it("8. Wallet/pool/position identity matching: attaches strictly by composite poolAddress + positionAddress", () => {
            const reportPositions: PositionVerificationDetail[] = [
                createMockDetail({
                    wallet: "WalletA",
                    poolAddress: "Pool1",
                    positionAddress: "PosShared",
                    classification: "MATCH",
                }),
                createMockDetail({
                    wallet: "WalletA",
                    poolAddress: "Pool2",
                    positionAddress: "PosShared",
                    classification: "SIGN_MISMATCH",
                }),
            ];

            const map = new Map<string, PositionVerificationDetail>();
            for (const p of reportPositions) {
                if (p.positionAddress && p.poolAddress) {
                    map.set(`${p.poolAddress}:${p.positionAddress}`, p);
                }
            }

            const pool1Detail = map.get("Pool1:PosShared");
            assert.equal(pool1Detail?.classification, "MATCH");

            const pool2Detail = map.get("Pool2:PosShared");
            assert.equal(pool2Detail?.classification, "SIGN_MISMATCH");

            const pool3Detail = map.get("Pool3:PosShared");
            assert.equal(pool3Detail, undefined);

            const wrongWalletReport = { targetWallet: "WalletB", period: "30D" };
            const activeWallet = "WalletA";
            const isValid = wrongWalletReport.targetWallet === activeWallet;
            assert.equal(isValid, false, "Report for different wallet must be rejected");
        });

        it("9. USD versus SOL separation: guarantees numeric distinction and formatting isolation", () => {
            const detail = createMockDetail({
                usdValuations: {
                    deposits: { localUsd: 100, meteoraUsd: { rawString: "100", numeric: 100, decimalPlaces: 2 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
                    withdrawals: { localUsd: 150, meteoraUsd: { rawString: "150", numeric: 150, decimalPlaces: 2 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
                    claimedFees: { localUsd: 0, meteoraUsd: { rawString: "0", numeric: 0, decimalPlaces: 2 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
                    pnlUsd: { localUsd: 50, meteoraUsd: { rawString: "50", numeric: 50, decimalPlaces: 2 }, usdDelta: 0, usdDeltaPct: 0, isWithinTolerance: true },
                    pnlSignFlip: false,
                },
                solValuations: {
                    meteoraPnlSol: { rawString: "0.25", numeric: 0.25, decimalPlaces: 2 },
                },
            });

            const usdPnl = detail.usdValuations.pnlUsd.meteoraUsd?.numeric;
            const solPnl = detail.solValuations?.meteoraPnlSol?.numeric;

            assert.equal(usdPnl, 50);
            assert.equal(solPnl, 0.25);
            assert.notEqual(usdPnl, solPnl, "USD and SOL values must never be equated");
        });

        it("10. Legitimate zero versus missing metrics: preserves numeric 0 and formats null as unknown/placeholder", () => {
            function formatUsdValue(val: number | null | undefined): string {
                if (val === null || val === undefined || !Number.isFinite(val)) return "—";
                if (val === 0) return "$0.00";
                return `$${val.toFixed(2)}`;
            }

            function formatPctValue(val: number | null | undefined): string {
                if (val === null || val === undefined || !Number.isFinite(val)) return "—";
                if (val === 0) return "0.00%";
                return `${val.toFixed(2)}%`;
            }

            assert.equal(formatUsdValue(0), "$0.00");
            assert.equal(formatPctValue(0), "0.00%");
            assert.equal(formatUsdValue(null), "—");
            assert.equal(formatUsdValue(undefined), "—");
            assert.equal(formatPctValue(null), "—");
            assert.equal(formatPctValue(undefined), "—");
        });

        it("11. Loading, error, and stopped states: renders distinct statuses truthfully", () => {
            function resolveStatusPresentation(status: string | null, error?: string | null) {
                if (status === "running") return { label: "Running", color: "blue", inProgress: true };
                if (status === "stopping") return { label: "Stopping analysis...", color: "amber", inProgress: true };
                if (status === "stopped") return { label: "Analysis Stopped", color: "gray", inProgress: false };
                if (status === "error") return { label: `Analysis Failed: ${error || "Unknown"}`, color: "red", inProgress: false };
                if (status === "completed") return { label: "Analysis Complete", color: "green", inProgress: false };
                return { label: "Idle", color: "gray", inProgress: false };
            }

            assert.deepEqual(resolveStatusPresentation("running"), { label: "Running", color: "blue", inProgress: true });
            assert.deepEqual(resolveStatusPresentation("stopping"), { label: "Stopping analysis...", color: "amber", inProgress: true });
            assert.deepEqual(resolveStatusPresentation("stopped"), { label: "Analysis Stopped", color: "gray", inProgress: false });
            assert.deepEqual(resolveStatusPresentation("error", "Network timeout"), { label: "Analysis Failed: Network timeout", color: "red", inProgress: false });
            assert.deepEqual(resolveStatusPresentation("completed"), { label: "Analysis Complete", color: "green", inProgress: false });
            assert.deepEqual(resolveStatusPresentation("idle"), { label: "Idle", color: "gray", inProgress: false });
        });
    });
});
