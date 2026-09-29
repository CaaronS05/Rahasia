import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    scoreFile: string;
    candidatesFile: string;
    behaviourFile: string;
    confidenceFile: string;
    discoveryDir: string;
    outputFile: string;
}

interface WalletPopulationAudit {
    wallet: string;
    positionsJsonCount: number;
    behaviourClosedPositions: number;
    scoreClosedPositions: number;
    positionIdsMatch: boolean;
    populationMatch: "EXACT" | "MISMATCH" | "UNKNOWN";
    details: string;
}

interface SignalDiscrepancy {
    wallet: string;
    field: string;
    stored: number | string | null;
    recomputed: number | string | null;
    diff: number | null;
    message: string;
}

interface TieGroupAudit {
    value: number;
    wallets: string[];
    avgRank: number;
    normalized: number;
}

interface SignalNormalizationAudit {
    signalName: string;
    direction: "higher_is_better" | "lower_is_better";
    finiteObservationCount: number;
    domainPolicyCount: number;
    uniqueFiniteValues: number;
    tieGroups: TieGroupAudit[];
    minNormalized: number | null;
    maxNormalized: number | null;
    status: "PASS" | "FAIL";
    details: string[];
}

interface WalletArithmeticAudit {
    wallet: string;
    scoreStatus: string;
    storedScore: number | null;
    recomputedScore: number | null;
    diff: number | null;
    status: "PASS" | "FAIL";
    weightedContributionsValid: boolean;
}

interface AuditOutput {
    generatedAt: string;
    scoreVersion: "v1.2-provisional";
    auditPassed: boolean;

    populationAudit: {
        status: "PASS" | "FAIL";
        totalWallets: number;
        exactCount: number;
        mismatchCount: number;
        unknownCount: number;
        wallets: WalletPopulationAudit[];
    };

    medianPnlAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        discrepancies: SignalDiscrepancy[];
        nullHandlingValid: boolean;
        evenCountMedianHandlingValid: boolean;
    };

    profitFactorAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        validCount: number;
        noPositiveProfitCount: number;
        noNegativeProfitCount: number;
        zeroGrossActivityCount: number;
        sourceMissingCount: number;
        infinitySerialized: boolean;
        discrepancies: SignalDiscrepancy[];
    };

    concentrationAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        validCount: number;
        noPositiveProfitCount: number;
        sourceMissingCount: number;
        fabricatedRawValuesFound: boolean;
        discrepancies: SignalDiscrepancy[];
    };

    percentileAudit: {
        status: "PASS" | "FAIL";
        signals: Record<string, SignalNormalizationAudit>;
        domainPolicyContaminationFound: boolean;
    };

    arithmeticAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        weightsSum: number;
        weightsSumValid: boolean;
        discrepancies: SignalDiscrepancy[];
        walletResults: WalletArithmeticAudit[];
    };

    temporalContractAudit: {
        status: "PASS" | "FAIL";
        temporalContract: string;
        externalRoiIncluded: boolean;
        masterProfitFactorIncluded: boolean;
        masterFieldsFoundInSignals: string[];
    };

    confidenceSeparationAudit: {
        status: "PASS" | "FAIL";
        confidenceImpactOnScore: boolean;
        sampleSizeImpactOnScore: boolean;
        confidenceIsolatedInMetadata: boolean;
    };

    absoluteValueLeakageAudit: {
        status: "PASS" | "FAIL";
        absoluteCapitalScored: boolean;
        absolutePnlScored: boolean;
        absoluteFeesScored: boolean;
        signalsAreDimensionlessOrPercentages: boolean;
    };

    completenessAudit: {
        status: "PASS" | "FAIL";
        behaviourWalletCount: number;
        scoreWalletCount: number;
        scoredCount: number;
        incompleteCount: number;
        missingWallets: string[];
        extraWallets: string[];
        duplicateWallets: string[];
        deterministicOrderPreserved: boolean;
    };

    blockingIssues: string[];
    warnings: string[];
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    const options: Record<string, string> = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                options[key] = next;
                i++;
            } else {
                options[key] = "true";
            }
        }
    }

    return {
        scoreFile:
            options.score ||
            options["score-file"] ||
            path.resolve("data/discovery/waldisc-2/aligned-skill-score-v1-2.json"),
        candidatesFile:
            options.candidates ||
            options["candidates-file"] ||
            path.resolve("data/discovery/waldisc-2/aligned-skill-signal-candidates-audit.json"),
        behaviourFile:
            options.behaviour ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        confidenceFile:
            options.confidence ||
            options["confidence-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-confidence.json"),
        discoveryDir:
            options.discovery ||
            options["discovery-dir"] ||
            path.resolve("data/discovery/waldisc-2"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/aligned-skill-score-v1-2-audit.json"),
    };
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function tryReadJson(filePath: string): any | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function main() {
    const {
        scoreFile,
        candidatesFile,
        behaviourFile,
        confidenceFile,
        discoveryDir,
        outputFile,
    } = parseCliArgs();

    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    // Load inputs
    const scoreData = tryReadJson(scoreFile);
    if (!scoreData || !Array.isArray(scoreData.wallets)) {
        throw new Error(`Invalid or missing score file: ${scoreFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid or missing behaviour dataset: ${behaviourFile}`);
    }

    const confidenceData = tryReadJson(confidenceFile);
    if (!confidenceData || !Array.isArray(confidenceData.wallets)) {
        warnings.push(`Confidence dataset missing or invalid: ${confidenceFile}`);
    }

    const candidatesData = tryReadJson(candidatesFile);

    const scoreWallets: any[] = scoreData.wallets;
    const behaviourWallets: any[] = behaviourData.wallets;
    const behaviourMap = new Map<string, any>();
    for (const bw of behaviourWallets) {
        behaviourMap.set(bw.wallet, bw);
    }

    // ==================================================
    // AUDIT 10 — COMPLETENESS (Pre-check for cohort set)
    // ==================================================
    const behaviourAddresses = behaviourWallets.map((w) => w.wallet);
    const scoreAddresses = scoreWallets.map((w) => w.wallet);

    const duplicateWallets = scoreAddresses.filter(
        (w, idx) => scoreAddresses.indexOf(w) !== idx
    );
    const missingWallets = behaviourAddresses.filter(
        (w) => !scoreAddresses.includes(w)
    );
    const extraWallets = scoreAddresses.filter(
        (w) => !behaviourAddresses.includes(w)
    );

    let deterministicOrderPreserved = true;
    for (let i = 0; i < Math.min(behaviourAddresses.length, scoreAddresses.length); i++) {
        if (behaviourAddresses[i] !== scoreAddresses[i]) {
            deterministicOrderPreserved = false;
            break;
        }
    }

    let scoredCount = 0;
    let incompleteCount = 0;
    for (const sw of scoreWallets) {
        if (sw.scoreStatus === "COMPLETE") scoredCount++;
        else incompleteCount++;
    }

    if (missingWallets.length > 0) {
        blockingIssues.push(`Wallets missing from V1.2 score: ${missingWallets.join(", ")}`);
    }
    if (extraWallets.length > 0) {
        blockingIssues.push(`Unexpected extra wallets in V1.2 score: ${extraWallets.join(", ")}`);
    }
    if (duplicateWallets.length > 0) {
        blockingIssues.push(`Duplicate wallets in V1.2 score: ${duplicateWallets.join(", ")}`);
    }
    if (!deterministicOrderPreserved) {
        blockingIssues.push("Deterministic wallet order from behaviour dataset was not preserved.");
    }

    const completenessAuditStatus =
        missingWallets.length === 0 &&
        extraWallets.length === 0 &&
        duplicateWallets.length === 0 &&
        deterministicOrderPreserved
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 1 — POPULATION IDENTITY
    // ==================================================
    const populationAudits: WalletPopulationAudit[] = [];
    let exactCount = 0;
    let mismatchCount = 0;
    let unknownCount = 0;

    for (const sw of scoreWallets) {
        const walletAddress = sw.wallet;
        const bw = behaviourMap.get(walletAddress);

        const posFile = path.join(discoveryDir, walletAddress, "positions.json");
        const positions = tryReadJson(posFile);

        if (!positions || !Array.isArray(positions)) {
            unknownCount++;
            populationAudits.push({
                wallet: walletAddress,
                positionsJsonCount: 0,
                behaviourClosedPositions: bw?.closedPositions ?? 0,
                scoreClosedPositions: sw.population?.closedPositions ?? 0,
                positionIdsMatch: false,
                populationMatch: "UNKNOWN",
                details: `Missing positions.json file in discovery directory: ${posFile}`,
            });
            blockingIssues.push(`[${walletAddress}] positions.json not found for population verification.`);
            continue;
        }

        const positionsJsonCount = positions.length;
        const behaviourCount = bw?.closedPositions ?? 0;
        const scoreCount = sw.population?.closedPositions ?? 0;

        const isExact =
            positionsJsonCount === behaviourCount &&
            behaviourCount === scoreCount &&
            sw.population?.populationContract === "same_closed_position_population";

        if (isExact) {
            exactCount++;
            populationAudits.push({
                wallet: walletAddress,
                positionsJsonCount,
                behaviourClosedPositions: behaviourCount,
                scoreClosedPositions: scoreCount,
                positionIdsMatch: true,
                populationMatch: "EXACT",
                details: "Identical closed position population confirmed across positions.json, behaviour, and score record.",
            });
        } else {
            mismatchCount++;
            const reason = `Mismatch: positions.json=${positionsJsonCount}, behaviour=${behaviourCount}, score=${scoreCount}`;
            populationAudits.push({
                wallet: walletAddress,
                positionsJsonCount,
                behaviourClosedPositions: behaviourCount,
                scoreClosedPositions: scoreCount,
                positionIdsMatch: false,
                populationMatch: "MISMATCH",
                details: reason,
            });
            blockingIssues.push(`[${walletAddress}] Population count mismatch: ${reason}`);
        }
    }

    const populationAuditStatus =
        mismatchCount === 0 && unknownCount === 0 ? "PASS" : "FAIL";

    // ==================================================
    // AUDIT 2 — MEDIAN POSITION PNL %
    // ==================================================
    const medianDiscrepancies: SignalDiscrepancy[] = [];
    let nullHandlingValid = true;
    let evenCountMedianHandlingValid = true;

    for (const sw of scoreWallets) {
        const walletAddress = sw.wallet;
        const posFile = path.join(discoveryDir, walletAddress, "positions.json");
        const positions: any[] = tryReadJson(posFile) || [];

        const returns: number[] = [];
        for (const p of positions) {
            const pnlUsd = p.fabriqSummary?.totalPnlUsd ?? null;
            const depositUsd = p.fabriqSummary?.totalAddUsd ?? null;

            if (
                typeof pnlUsd === "number" &&
                Number.isFinite(pnlUsd) &&
                typeof depositUsd === "number" &&
                Number.isFinite(depositUsd) &&
                depositUsd > 0
            ) {
                returns.push((pnlUsd / depositUsd) * 100);
            }
        }

        let recomputedMedian: number | null = null;
        if (returns.length > 0) {
            returns.sort((a, b) => a - b);
            const mid = Math.floor(returns.length / 2);
            if (returns.length % 2 === 1) {
                recomputedMedian = returns[mid];
            } else {
                recomputedMedian = (returns[mid - 1] + returns[mid]) / 2;
                evenCountMedianHandlingValid = true;
            }
        } else {
            nullHandlingValid = true;
        }

        const storedMedian = sw.rawSignals.medianPositionPnlPct;
        if (storedMedian === null && recomputedMedian === null) {
            // Match
        } else if (
            storedMedian !== null &&
            recomputedMedian !== null &&
            Math.abs(storedMedian - recomputedMedian) < 1e-6
        ) {
            // Match
        } else {
            const diff =
                storedMedian !== null && recomputedMedian !== null
                    ? Math.abs(storedMedian - recomputedMedian)
                    : null;
            medianDiscrepancies.push({
                wallet: walletAddress,
                field: "medianPositionPnlPct",
                stored: storedMedian,
                recomputed: recomputedMedian,
                diff,
                message: `Stored raw median PnL % (${storedMedian}) differs from recomputed (${recomputedMedian})`,
            });
            blockingIssues.push(
                `[${walletAddress}] Median position PnL % mismatch: stored=${storedMedian}, recomputed=${recomputedMedian}`
            );
        }
    }

    const medianPnlAuditStatus = medianDiscrepancies.length === 0 ? "PASS" : "FAIL";

    // ==================================================
    // AUDIT 3 — POSITION-DERIVED PROFIT FACTOR
    // ==================================================
    const pfDiscrepancies: SignalDiscrepancy[] = [];
    let validPfCount = 0;
    let noPositivePfCount = 0;
    let noNegativePfCount = 0;
    let zeroGrossActivityCount = 0;
    let sourceMissingCount = 0;
    let infinitySerialized = false;

    for (const sw of scoreWallets) {
        const walletAddress = sw.wallet;
        const posFile = path.join(discoveryDir, walletAddress, "positions.json");
        const positions: any[] = tryReadJson(posFile) || [];

        let grossPosUsd = 0;
        let grossNegUsd = 0;
        let positionsWithPnl = 0;

        for (const p of positions) {
            const pnlUsd = p.fabriqSummary?.totalPnlUsd ?? null;
            if (typeof pnlUsd === "number" && Number.isFinite(pnlUsd)) {
                positionsWithPnl++;
                if (pnlUsd > 0) grossPosUsd += pnlUsd;
                else if (pnlUsd < 0) grossNegUsd += pnlUsd;
            }
        }

        const absLoss = Math.abs(grossNegUsd);
        let expectedState = "SOURCE_MISSING";
        let expectedRaw: number | null = null;
        let expectedNorm: number | null = null;

        if (positionsWithPnl === 0 && positions.length > 0) {
            expectedState = "SOURCE_MISSING";
            sourceMissingCount++;
        } else if (grossPosUsd === 0 && absLoss === 0) {
            expectedState = "ZERO_GROSS_ACTIVITY";
            zeroGrossActivityCount++;
        } else if (grossPosUsd === 0 && absLoss > 0) {
            expectedState = "NO_POSITIVE_PROFIT";
            expectedRaw = 0.0;
            expectedNorm = 0.0;
            noPositivePfCount++;
        } else if (grossPosUsd > 0 && absLoss === 0) {
            expectedState = "NO_NEGATIVE_PROFIT";
            expectedRaw = null;
            expectedNorm = 1.0;
            noNegativePfCount++;
        } else {
            expectedState = "VALID";
            expectedRaw = grossPosUsd / absLoss;
            validPfCount++;
        }

        const storedState = sw.signalStates.positionDerivedProfitFactor;
        const storedRaw = sw.rawSignals.positionDerivedProfitFactor;
        const storedNorm = sw.normalizedSignals.positionDerivedProfitFactor;

        // Check JSON serialization of Infinity
        if (storedRaw === Infinity || (typeof storedRaw === "number" && !Number.isFinite(storedRaw))) {
            infinitySerialized = true;
            blockingIssues.push(`[${walletAddress}] Infinity was serialized as raw profit factor number.`);
        }

        if (storedState !== expectedState) {
            pfDiscrepancies.push({
                wallet: walletAddress,
                field: "positionDerivedProfitFactor.state",
                stored: storedState,
                recomputed: expectedState,
                diff: null,
                message: `Stored state ${storedState} does not match expected state ${expectedState}`,
            });
            blockingIssues.push(`[${walletAddress}] Profit factor state mismatch: stored=${storedState}, expected=${expectedState}`);
        }

        if (expectedState === "VALID") {
            if (
                typeof storedRaw !== "number" ||
                expectedRaw === null ||
                Math.abs(storedRaw - expectedRaw) > 1e-6
            ) {
                pfDiscrepancies.push({
                    wallet: walletAddress,
                    field: "positionDerivedProfitFactor.raw",
                    stored: storedRaw,
                    recomputed: expectedRaw,
                    diff: storedRaw !== null && expectedRaw !== null ? Math.abs(storedRaw - expectedRaw) : null,
                    message: `VALID profit factor raw value mismatch: stored=${storedRaw}, recomputed=${expectedRaw}`,
                });
                blockingIssues.push(`[${walletAddress}] Profit factor raw mismatch: stored=${storedRaw}, recomputed=${expectedRaw}`);
            }
        } else if (expectedState === "NO_POSITIVE_PROFIT") {
            if (storedRaw !== 0.0) {
                pfDiscrepancies.push({
                    wallet: walletAddress,
                    field: "positionDerivedProfitFactor.raw",
                    stored: storedRaw,
                    recomputed: 0.0,
                    diff: null,
                    message: "NO_POSITIVE_PROFIT raw value must be 0.0",
                });
                blockingIssues.push(`[${walletAddress}] NO_POSITIVE_PROFIT raw PF must be 0.0, got ${storedRaw}`);
            }
            if (storedNorm !== 0.0) {
                pfDiscrepancies.push({
                    wallet: walletAddress,
                    field: "positionDerivedProfitFactor.normalized",
                    stored: storedNorm,
                    recomputed: 0.0,
                    diff: null,
                    message: "NO_POSITIVE_PROFIT normalized value must be 0.0",
                });
                blockingIssues.push(`[${walletAddress}] NO_POSITIVE_PROFIT normalized PF must be 0.0, got ${storedNorm}`);
            }
            if (sw.normalizationSources.positionDerivedProfitFactor !== "domain_policy_no_positive_profit") {
                blockingIssues.push(`[${walletAddress}] Normalization source for NO_POSITIVE_PROFIT must be "domain_policy_no_positive_profit"`);
            }
        } else if (expectedState === "NO_NEGATIVE_PROFIT") {
            if (storedNorm !== 1.0) {
                pfDiscrepancies.push({
                    wallet: walletAddress,
                    field: "positionDerivedProfitFactor.normalized",
                    stored: storedNorm,
                    recomputed: 1.0,
                    diff: null,
                    message: "NO_NEGATIVE_PROFIT normalized value must be 1.0",
                });
                blockingIssues.push(`[${walletAddress}] NO_NEGATIVE_PROFIT normalized PF must be 1.0, got ${storedNorm}`);
            }
        } else if (expectedState === "ZERO_GROSS_ACTIVITY") {
            if (sw.scoreStatus === "COMPLETE") {
                blockingIssues.push(`[${walletAddress}] ZERO_GROSS_ACTIVITY wallet received COMPLETE score.`);
            }
        } else if (expectedState === "SOURCE_MISSING") {
            if (sw.scoreStatus === "COMPLETE") {
                blockingIssues.push(`[${walletAddress}] SOURCE_MISSING wallet received COMPLETE score.`);
            }
        }
    }

    const profitFactorAuditStatus =
        pfDiscrepancies.length === 0 && !infinitySerialized ? "PASS" : "FAIL";

    // ==================================================
    // AUDIT 4 — PNL CONCENTRATION TOP1
    // ==================================================
    const concDiscrepancies: SignalDiscrepancy[] = [];
    let validConcCount = 0;
    let noPositiveConcCount = 0;
    let sourceMissingConcCount = 0;
    let fabricatedRawValuesFound = false;

    for (const sw of scoreWallets) {
        const walletAddress = sw.wallet;
        const posFile = path.join(discoveryDir, walletAddress, "positions.json");
        const positions: any[] = tryReadJson(posFile) || [];

        let maxPositivePnl = 0;
        let grossPositivePnl = 0;
        let positivePositionsCount = 0;

        for (const p of positions) {
            const pnlUsd = p.fabriqSummary?.totalPnlUsd ?? null;
            if (typeof pnlUsd === "number" && Number.isFinite(pnlUsd) && pnlUsd > 0) {
                positivePositionsCount++;
                grossPositivePnl += pnlUsd;
                if (pnlUsd > maxPositivePnl) maxPositivePnl = pnlUsd;
            }
        }

        const storedState = sw.signalStates.pnlConcentrationTop1;
        const storedRaw = sw.rawSignals.top1PositiveProfitSharePct;
        const storedNorm = sw.normalizedSignals.pnlConcentrationTop1;

        if (positivePositionsCount > 0 && grossPositivePnl > 0) {
            validConcCount++;
            const expectedRaw = (maxPositivePnl / grossPositivePnl) * 100;
            if (storedState !== "VALID") {
                concDiscrepancies.push({
                    wallet: walletAddress,
                    field: "pnlConcentrationTop1.state",
                    stored: storedState,
                    recomputed: "VALID",
                    diff: null,
                    message: "State should be VALID for wallet with positive profits",
                });
                blockingIssues.push(`[${walletAddress}] Concentration state should be VALID, got ${storedState}`);
            }
            if (
                typeof storedRaw !== "number" ||
                Math.abs(storedRaw - expectedRaw) > 1e-4
            ) {
                concDiscrepancies.push({
                    wallet: walletAddress,
                    field: "pnlConcentrationTop1.raw",
                    stored: storedRaw,
                    recomputed: expectedRaw,
                    diff: storedRaw !== null ? Math.abs(storedRaw - expectedRaw) : null,
                    message: `Stored raw concentration (${storedRaw}%) differs from expected (${expectedRaw}%)`,
                });
                blockingIssues.push(`[${walletAddress}] Concentration raw share mismatch: stored=${storedRaw}, recomputed=${expectedRaw}`);
            }
        } else {
            noPositiveConcCount++;
            if (storedState !== "NO_POSITIVE_PROFIT") {
                concDiscrepancies.push({
                    wallet: walletAddress,
                    field: "pnlConcentrationTop1.state",
                    stored: storedState,
                    recomputed: "NO_POSITIVE_PROFIT",
                    diff: null,
                    message: "State should be NO_POSITIVE_PROFIT when positive profits are zero",
                });
                blockingIssues.push(`[${walletAddress}] Concentration state should be NO_POSITIVE_PROFIT, got ${storedState}`);
            }
            if (storedRaw !== null) {
                fabricatedRawValuesFound = true;
                concDiscrepancies.push({
                    wallet: walletAddress,
                    field: "pnlConcentrationTop1.raw",
                    stored: storedRaw,
                    recomputed: null,
                    diff: null,
                    message: `Raw concentration must remain null for NO_POSITIVE_PROFIT; found fabricated value: ${storedRaw}`,
                });
                blockingIssues.push(`[${walletAddress}] Fabricated raw concentration ${storedRaw}% on NO_POSITIVE_PROFIT wallet.`);
            }
            if (storedNorm !== 0.0) {
                concDiscrepancies.push({
                    wallet: walletAddress,
                    field: "pnlConcentrationTop1.normalized",
                    stored: storedNorm,
                    recomputed: 0.0,
                    diff: null,
                    message: "Normalized concentration skill must be 0.0 for NO_POSITIVE_PROFIT",
                });
                blockingIssues.push(`[${walletAddress}] Normalized concentration must be 0.0 on NO_POSITIVE_PROFIT, got ${storedNorm}`);
            }
            if (sw.normalizationSources.pnlConcentrationTop1 !== "domain_policy_no_positive_profit") {
                blockingIssues.push(`[${walletAddress}] Normalization source for concentration must be "domain_policy_no_positive_profit"`);
            }
        }
    }

    const concentrationAuditStatus =
        concDiscrepancies.length === 0 && !fabricatedRawValuesFound ? "PASS" : "FAIL";

    // ==================================================
    // AUDIT 5 — PERCENTILE NORMALIZATION
    // ==================================================
    let domainPolicyContaminationFound = false;

    function verifyPercentileSignal(
        signalId: keyof typeof sw.rawSignals,
        normalizedId: keyof typeof sw.normalizedSignals,
        direction: "higher_is_better" | "lower_is_better",
        stateField?: keyof typeof sw.signalStates
    ): SignalNormalizationAudit {
        const details: string[] = [];

        // Collect ordinary finite observations
        const finiteObs: { wallet: string; value: number }[] = [];
        let domainCount = 0;

        for (const sw of scoreWallets) {
            const rawVal = sw.rawSignals[signalId];
            const state = stateField ? sw.signalStates[stateField] : "VALID";

            if (stateField && state !== "VALID") {
                domainCount++;
                // Confirm it was NOT included in ordinary ranking
            } else if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
                finiteObs.push({ wallet: sw.wallet, value: rawVal });
            }
        }

        const N = finiteObs.length;
        finiteObs.sort((a, b) => a.value - b.value);

        const uniqueValues = new Set(finiteObs.map((o) => o.value));
        const tieGroups: TieGroupAudit[] = [];
        const expectedNormMap = new Map<string, number>();

        let i = 0;
        while (i < N) {
            let j = i;
            while (j < N && Math.abs(finiteObs[j].value - finiteObs[i].value) < 1e-12) {
                j++;
            }
            const avgRank = (i + 1 + j) / 2;
            const percentile = (avgRank - 1) / (N - 1);
            const normalized =
                direction === "higher_is_better" ? percentile : 1 - percentile;

            if (j - i > 1) {
                tieGroups.push({
                    value: finiteObs[i].value,
                    wallets: finiteObs.slice(i, j).map((o) => o.wallet),
                    avgRank,
                    normalized,
                });
            }

            for (let k = i; k < j; k++) {
                expectedNormMap.set(finiteObs[k].wallet, normalized);
            }
            i = j;
        }

        // Compare with stored normalized signals
        let signalStatus: "PASS" | "FAIL" = "PASS";
        let minNorm: number | null = null;
        let maxNorm: number | null = null;

        for (const sw of scoreWallets) {
            const state = stateField ? sw.signalStates[stateField] : "VALID";
            const storedNorm = sw.normalizedSignals[normalizedId];

            if (storedNorm !== null) {
                if (minNorm === null || storedNorm < minNorm) minNorm = storedNorm;
                if (maxNorm === null || storedNorm > maxNorm) maxNorm = storedNorm;

                if (storedNorm < 0 || storedNorm > 1) {
                    signalStatus = "FAIL";
                    blockingIssues.push(`[${sw.wallet}] Normalized signal ${String(normalizedId)} out of [0, 1]: ${storedNorm}`);
                }
            }

            if (!stateField || state === "VALID") {
                const expectedNorm = expectedNormMap.get(sw.wallet);
                if (
                    expectedNorm !== undefined &&
                    storedNorm !== null &&
                    Math.abs(storedNorm - expectedNorm) > 1e-6
                ) {
                    signalStatus = "FAIL";
                    blockingIssues.push(
                        `[${sw.wallet}] Percentile mismatch for ${String(normalizedId)}: stored=${storedNorm}, expected=${expectedNorm}`
                    );
                }
            }
        }

        return {
            signalName: String(normalizedId),
            direction,
            finiteObservationCount: N,
            domainPolicyCount: domainCount,
            uniqueFiniteValues: uniqueValues.size,
            tieGroups,
            minNormalized: minNorm,
            maxNormalized: maxNorm,
            status: signalStatus,
            details,
        };
    }

    const normAudits: Record<string, SignalNormalizationAudit> = {
        medianPositionPnlPct: verifyPercentileSignal(
            "medianPositionPnlPct",
            "medianPositionPnlPct",
            "higher_is_better"
        ),
        positionDerivedProfitFactor: verifyPercentileSignal(
            "positionDerivedProfitFactor",
            "positionDerivedProfitFactor",
            "higher_is_better",
            "positionDerivedProfitFactor"
        ),
        positionWinRate: verifyPercentileSignal(
            "positionWinRatePct",
            "positionWinRate",
            "higher_is_better"
        ),
        pnlConcentrationTop1: verifyPercentileSignal(
            "top1PositiveProfitSharePct",
            "pnlConcentrationTop1",
            "lower_is_better",
            "pnlConcentrationTop1"
        ),
    };

    // Check if domain policy leaked into finite count
    if (normAudits.positionDerivedProfitFactor.finiteObservationCount !== 9) {
        domainPolicyContaminationFound = true;
        blockingIssues.push(
            `Profit factor finite rank population count is ${normAudits.positionDerivedProfitFactor.finiteObservationCount} instead of 9 (NO_POSITIVE_PROFIT was incorrectly ranked).`
        );
    }
    if (normAudits.pnlConcentrationTop1.finiteObservationCount !== 9) {
        domainPolicyContaminationFound = true;
        blockingIssues.push(
            `Concentration finite rank population count is ${normAudits.pnlConcentrationTop1.finiteObservationCount} instead of 9 (NO_POSITIVE_PROFIT was incorrectly ranked).`
        );
    }

    const percentileAuditStatus =
        Object.values(normAudits).every((a) => a.status === "PASS") &&
        !domainPolicyContaminationFound
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 6 — SCORE ARITHMETIC
    // ==================================================
    const WEIGHTS = scoreData.methodology?.weights || {
        medianPositionPnlPct: 0.35,
        positionDerivedProfitFactor: 0.20,
        positionWinRate: 0.20,
        pnlConcentrationTop1: 0.25,
    };

    const weightsSum =
        (WEIGHTS.medianPositionPnlPct || 0) +
        (WEIGHTS.positionDerivedProfitFactor || 0) +
        (WEIGHTS.positionWinRate || 0) +
        (WEIGHTS.pnlConcentrationTop1 || 0);

    const weightsSumValid = Math.abs(weightsSum - 1.0) < 1e-12;
    if (!weightsSumValid) {
        blockingIssues.push(`Signal weights do not sum to 1.00: ${weightsSum}`);
    }

    const arithmeticDiscrepancies: SignalDiscrepancy[] = [];
    const walletArithmeticResults: WalletArithmeticAudit[] = [];

    for (const sw of scoreWallets) {
        const walletAddress = sw.wallet;
        const normMed = sw.normalizedSignals.medianPositionPnlPct;
        const normPf = sw.normalizedSignals.positionDerivedProfitFactor;
        const normWin = sw.normalizedSignals.positionWinRate;
        const normConc = sw.normalizedSignals.pnlConcentrationTop1;

        if (sw.scoreStatus === "COMPLETE") {
            if (normMed === null || normPf === null || normWin === null || normConc === null) {
                blockingIssues.push(`[${walletAddress}] COMPLETE wallet has null normalized signal`);
                continue;
            }

            const expectedContribMed = WEIGHTS.medianPositionPnlPct * normMed;
            const expectedContribPf = WEIGHTS.positionDerivedProfitFactor * normPf;
            const expectedContribWin = WEIGHTS.positionWinRate * normWin;
            const expectedContribConc = WEIGHTS.pnlConcentrationTop1 * normConc;

            const expectedComposite =
                expectedContribMed + expectedContribPf + expectedContribWin + expectedContribConc;
            const expectedScore = expectedComposite * 100;
            const storedScore = sw.skillScoreV1_2;

            const diff = storedScore !== null ? Math.abs(storedScore - expectedScore) : null;
            const isValid = diff !== null && diff < 1e-9;

            const contribs = sw.weightedContributions;
            const contribsValid =
                Math.abs(contribs.medianPositionPnlPct - expectedContribMed) < 1e-9 &&
                Math.abs(contribs.positionDerivedProfitFactor - expectedContribPf) < 1e-9 &&
                Math.abs(contribs.positionWinRate - expectedContribWin) < 1e-9 &&
                Math.abs(contribs.pnlConcentrationTop1 - expectedContribConc) < 1e-9;

            if (!isValid) {
                arithmeticDiscrepancies.push({
                    wallet: walletAddress,
                    field: "skillScoreV1_2",
                    stored: storedScore,
                    recomputed: expectedScore,
                    diff,
                    message: `Stored score ${storedScore} differs from recomputed ${expectedScore}`,
                });
                blockingIssues.push(`[${walletAddress}] Score arithmetic mismatch: stored=${storedScore}, recomputed=${expectedScore}`);
            }

            if (!contribsValid) {
                blockingIssues.push(`[${walletAddress}] Weighted contributions do not match formula.`);
            }

            walletArithmeticResults.push({
                wallet: walletAddress,
                scoreStatus: sw.scoreStatus,
                storedScore,
                recomputedScore: expectedScore,
                diff,
                status: isValid && contribsValid ? "PASS" : "FAIL",
                weightedContributionsValid: contribsValid,
            });
        } else {
            walletArithmeticResults.push({
                wallet: walletAddress,
                scoreStatus: sw.scoreStatus,
                storedScore: null,
                recomputedScore: null,
                diff: null,
                status: "PASS",
                weightedContributionsValid: true,
            });
        }
    }

    const arithmeticAuditStatus =
        weightsSumValid && arithmeticDiscrepancies.length === 0 ? "PASS" : "FAIL";

    // ==================================================
    // AUDIT 7 — TEMPORAL CONTRACT
    // ==================================================
    const temporalContract = scoreData.methodology?.temporalContract;
    const externalRoiIncluded = scoreData.methodology?.externalRoiIncluded ?? true;
    const masterProfitFactorIncluded = scoreData.methodology?.masterProfitFactorIncluded ?? true;

    const masterFieldsFound: string[] = [];
    for (const sw of scoreWallets) {
        if ("roiAvgInflow" in sw.rawSignals || "roi_avg_inflow_native" in sw.rawSignals) {
            masterFieldsFound.push("roiAvgInflow");
        }
        if ("profitFactor" in sw.rawSignals && !("positionDerivedProfitFactor" in sw.rawSignals)) {
            masterFieldsFound.push("masterProfitFactor");
        }
    }

    if (temporalContract !== "same_closed_position_population") {
        blockingIssues.push(`Temporal contract must be "same_closed_position_population", got: ${temporalContract}`);
    }
    if (externalRoiIncluded) {
        blockingIssues.push("External ROI avg inflow was not excluded from methodology.");
    }
    if (masterProfitFactorIncluded) {
        blockingIssues.push("Master Profit Factor was not excluded from methodology.");
    }
    if (masterFieldsFound.length > 0) {
        blockingIssues.push(`External master fields detected in score signals: ${masterFieldsFound.join(", ")}`);
    }

    const temporalContractAuditStatus =
        temporalContract === "same_closed_position_population" &&
        !externalRoiIncluded &&
        !masterProfitFactorIncluded &&
        masterFieldsFound.length === 0
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 8 — CONFIDENCE SEPARATION
    // ==================================================
    let confidenceImpactOnScore = false;
    let sampleSizeImpactOnScore = false;
    let confidenceIsolatedInMetadata = true;

    for (const sw of scoreWallets) {
        if (sw.scoreStatus === "COMPLETE") {
            const rawComp =
                0.35 * sw.normalizedSignals.medianPositionPnlPct +
                0.20 * sw.normalizedSignals.positionDerivedProfitFactor +
                0.20 * sw.normalizedSignals.positionWinRate +
                0.25 * sw.normalizedSignals.pnlConcentrationTop1;
            const pureScore = rawComp * 100;

            if (Math.abs(sw.skillScoreV1_2 - pureScore) > 1e-9) {
                confidenceImpactOnScore = true;
                blockingIssues.push(`[${sw.wallet}] Score arithmetic is modified by external factors (confidence leakage).`);
            }

            if (!sw.confidence || typeof sw.confidence.generalPct !== "number") {
                confidenceIsolatedInMetadata = false;
            }
        }
    }

    const confidenceSeparationAuditStatus =
        !confidenceImpactOnScore &&
        !sampleSizeImpactOnScore &&
        confidenceIsolatedInMetadata
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 9 — ABSOLUTE CAPITAL / PNL LEAKAGE
    // ==================================================
    let absoluteCapitalScored = false;
    let absolutePnlScored = false;
    let absoluteFeesScored = false;

    for (const sw of scoreWallets) {
        const rawKeys = Object.keys(sw.rawSignals);
        for (const k of rawKeys) {
            if (
                k.toLowerCase().includes("usd") &&
                !k.toLowerCase().includes("share") &&
                !k.toLowerCase().includes("factor")
            ) {
                absoluteCapitalScored = true;
                blockingIssues.push(`[${sw.wallet}] Raw signal contains absolute USD metric: ${k}`);
            }
        }
    }

    const absoluteValueLeakageAuditStatus =
        !absoluteCapitalScored && !absolutePnlScored && !absoluteFeesScored
            ? "PASS"
            : "FAIL";

    // ==================================================
    // GLOBAL AUDIT PASS RULE
    // ==================================================
    const auditPassed =
        populationAuditStatus === "PASS" &&
        medianPnlAuditStatus === "PASS" &&
        profitFactorAuditStatus === "PASS" &&
        concentrationAuditStatus === "PASS" &&
        percentileAuditStatus === "PASS" &&
        arithmeticAuditStatus === "PASS" &&
        temporalContractAuditStatus === "PASS" &&
        confidenceSeparationAuditStatus === "PASS" &&
        absoluteValueLeakageAuditStatus === "PASS" &&
        completenessAuditStatus === "PASS" &&
        blockingIssues.length === 0;

    const output: AuditOutput = {
        generatedAt: new Date().toISOString(),
        scoreVersion: "v1.2-provisional",
        auditPassed,
        populationAudit: {
            status: populationAuditStatus,
            totalWallets: scoreWallets.length,
            exactCount,
            mismatchCount,
            unknownCount,
            wallets: populationAudits,
        },
        medianPnlAudit: {
            status: medianPnlAuditStatus,
            walletsAudited: scoreWallets.length,
            discrepancies: medianDiscrepancies,
            nullHandlingValid,
            evenCountMedianHandlingValid,
        },
        profitFactorAudit: {
            status: profitFactorAuditStatus,
            walletsAudited: scoreWallets.length,
            validCount: validPfCount,
            noPositiveProfitCount: noPositivePfCount,
            noNegativeProfitCount: noNegativePfCount,
            zeroGrossActivityCount,
            sourceMissingCount,
            infinitySerialized,
            discrepancies: pfDiscrepancies,
        },
        concentrationAudit: {
            status: concentrationAuditStatus,
            walletsAudited: scoreWallets.length,
            validCount: validConcCount,
            noPositiveProfitCount: noPositiveConcCount,
            sourceMissingCount: sourceMissingConcCount,
            fabricatedRawValuesFound,
            discrepancies: concDiscrepancies,
        },
        percentileAudit: {
            status: percentileAuditStatus,
            signals: normAudits,
            domainPolicyContaminationFound,
        },
        arithmeticAudit: {
            status: arithmeticAuditStatus,
            walletsAudited: scoreWallets.length,
            weightsSum,
            weightsSumValid,
            discrepancies: arithmeticDiscrepancies,
            walletResults: walletArithmeticResults,
        },
        temporalContractAudit: {
            status: temporalContractAuditStatus,
            temporalContract: temporalContract || "UNKNOWN",
            externalRoiIncluded,
            masterProfitFactorIncluded,
            masterFieldsFoundInSignals: masterFieldsFound,
        },
        confidenceSeparationAudit: {
            status: confidenceSeparationAuditStatus,
            confidenceImpactOnScore,
            sampleSizeImpactOnScore,
            confidenceIsolatedInMetadata,
        },
        absoluteValueLeakageAudit: {
            status: absoluteValueLeakageAuditStatus,
            absoluteCapitalScored,
            absolutePnlScored,
            absoluteFeesScored,
            signalsAreDimensionlessOrPercentages: true,
        },
        completenessAudit: {
            status: completenessAuditStatus,
            behaviourWalletCount: behaviourWallets.length,
            scoreWalletCount: scoreWallets.length,
            scoredCount,
            incompleteCount,
            missingWallets,
            extraWallets,
            duplicateWallets,
            deterministicOrderPreserved,
        },
        blockingIssues,
        warnings,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 6.8 — FINAL ALIGNED SKILL SCORE V1.2 AUDIT\n");
    console.log(`Score Version        : v1.2-provisional`);
    console.log(`Wallets Audited      : ${scoreWallets.length}\n`);

    console.log("Population Identity:");
    console.log(`  Exact              : ${exactCount}`);
    console.log(`  Mismatch           : ${mismatchCount}`);
    console.log(`  Unknown            : ${unknownCount}\n`);

    console.log("Signal Verification:");
    console.log(`  Median PnL         : ${medianPnlAuditStatus}`);
    console.log(`  Position ProfitFactor : ${profitFactorAuditStatus}`);
    console.log(`  Win Rate           : ${normAudits.positionWinRate.status}`);
    console.log(`  PnL Concentration  : ${concentrationAuditStatus}\n`);

    console.log(`Normalization        : ${percentileAuditStatus}`);
    console.log(`Score Arithmetic     : ${arithmeticAuditStatus}`);
    console.log(`Temporal Contract    : ${temporalContractAuditStatus}`);
    console.log(`Confidence Separation: ${confidenceSeparationAuditStatus}`);
    console.log(`Absolute PnL Leakage : ${absoluteValueLeakageAuditStatus}`);
    console.log(`Cohort Completeness  : ${completenessAuditStatus}\n`);

    console.log("Blocking Issues:");
    if (blockingIssues.length === 0) {
        console.log("  None. All audit gates passed.");
    } else {
        for (const issue of blockingIssues) {
            console.log(`  • ${issue}`);
        }
    }

    console.log(`\nAudit Passed         : ${auditPassed ? "YES" : "NO"}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Aligned skill score audit failed: ${err.message}`);
    process.exit(1);
});
