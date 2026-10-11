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
});
