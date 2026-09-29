import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    behaviourFile: string;
    confidenceFile: string;
    discoveryDir: string;
    outputFile: string;
}

type ProfitFactorState =
    | "VALID"
    | "NO_POSITIVE_PROFIT"
    | "NO_NEGATIVE_PROFIT"
    | "ZERO_GROSS_ACTIVITY"
    | "SOURCE_MISSING";

type ConcentrationState =
    | "VALID"
    | "NO_POSITIVE_PROFIT"
    | "SOURCE_MISSING"
    | "UNKNOWN";

interface WalletRawSignals {
    medianPositionPnlPct: number | null;
    positionDerivedProfitFactor: number | null;
    positionWinRatePct: number | null;
    top1PositiveProfitSharePct: number | null;
}

interface WalletSignalStates {
    positionDerivedProfitFactor: ProfitFactorState;
    pnlConcentrationTop1: ConcentrationState;
}

interface WalletNormalizedSignals {
    medianPositionPnlPct: number | null;
    positionDerivedProfitFactor: number | null;
    positionWinRate: number | null;
    pnlConcentrationTop1: number | null;
}

interface WalletNormalizationSources {
    medianPositionPnlPct: "cohort_percentile" | null;
    positionDerivedProfitFactor:
        | "cohort_percentile"
        | "domain_policy_no_positive_profit"
        | "domain_policy_no_negative_profit"
        | null;
    positionWinRate: "cohort_percentile" | null;
    pnlConcentrationTop1:
        | "cohort_percentile"
        | "domain_policy_no_positive_profit"
        | null;
}

interface WalletWeightedContributions {
    medianPositionPnlPct: number | null;
    positionDerivedProfitFactor: number | null;
    positionWinRate: number | null;
    pnlConcentrationTop1: number | null;
}

interface WalletConfidenceJoin {
    generalPct: number | null;
    performancePct: number | null;
}

interface WalletAlignedSkillRecord {
    wallet: string;
    scoreVersion: "v1.2-provisional";
    provisional: true;
    scoreStatus: "COMPLETE" | "INCOMPLETE_SIGNALS";
    skillScoreV1_2: number | null;
    population: {
        closedPositions: number;
        populationContract: "same_closed_position_population";
    };
    rawSignals: WalletRawSignals;
    signalStates: WalletSignalStates;
    normalizedSignals: WalletNormalizedSignals;
    normalizationSources: WalletNormalizationSources;
    weightedContributions: WalletWeightedContributions;
    confidence: WalletConfidenceJoin;
    missingSignals: string[];
}

interface AlignedSkillScoreOutput {
    generatedAt: string;
    scoreVersion: "v1.2-provisional";
    provisional: true;
    walletCount: number;
    scoredWalletCount: number;
    incompleteWalletCount: number;
    methodology: {
        temporalContract: "same_closed_position_population";
        normalization: "cohort_percentile_average_rank";
        confidenceIncludedInSkill: false;
        missingSignalPolicy: "require_all_four";
        externalRoiIncluded: false;
        masterProfitFactorIncluded: false;
        weights: {
            medianPositionPnlPct: number;
            positionDerivedProfitFactor: number;
            positionWinRate: number;
            pnlConcentrationTop1: number;
        };
    };
    wallets: WalletAlignedSkillRecord[];
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
        behaviourFile:
            options.behaviour ||
            options.dataset ||
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
            path.resolve("data/discovery/waldisc-2/aligned-skill-score-v1-2.json"),
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

/**
 * Deterministic percentile rank with average ranks for ties.
 * For finite ordinary observations:
 *   percentile = (avgRank - 1) / (N - 1)
 */
function computePercentileNormalization(
    observations: { wallet: string; value: number }[],
    direction: "higher_is_better" | "lower_is_better",
    signalName: string
): Map<string, number> {
    const N = observations.length;
    if (N < 2) {
        throw new Error(
            `Signal "${signalName}" has fewer than 2 valid observations (N=${N}). Cannot compute percentile ranking.`
        );
    }

    const sorted = [...observations].sort((a, b) => a.value - b.value);

    if (sorted[0].value === sorted[N - 1].value) {
        throw new Error(
            `Signal "${signalName}" has zero variation across all ${N} valid observations (${sorted[0].value}).`
        );
    }

    const resultMap = new Map<string, number>();

    let i = 0;
    while (i < N) {
        let j = i;
        while (j < N && Math.abs(sorted[j].value - sorted[i].value) < 1e-12) {
            j++;
        }
        const avgRank = (i + 1 + j) / 2;
        const percentile = (avgRank - 1) / (N - 1);

        let normalized =
            direction === "higher_is_better" ? percentile : 1 - percentile;

        normalized = Math.max(0, Math.min(1, normalized));

        for (let k = i; k < j; k++) {
            resultMap.set(sorted[k].wallet, normalized);
        }

        i = j;
    }

    return resultMap;
}

async function main() {
    const { behaviourFile, confidenceFile, discoveryDir, outputFile } =
        parseCliArgs();

    // Signal weights defined by Step 6.7 spec (sum to exactly 1.00)
    const WEIGHTS = {
        medianPositionPnlPct: 0.35,
        positionDerivedProfitFactor: 0.20,
        positionWinRate: 0.20,
        pnlConcentrationTop1: 0.25,
    };

    // Sanity check weights
    const weightSum =
        WEIGHTS.medianPositionPnlPct +
        WEIGHTS.positionDerivedProfitFactor +
        WEIGHTS.positionWinRate +
        WEIGHTS.pnlConcentrationTop1;
    if (Math.abs(weightSum - 1.0) > 1e-12) {
        throw new Error(`Signal weights must sum to exactly 1.00. Current sum: ${weightSum}`);
    }

    if (!fs.existsSync(behaviourFile)) {
        throw new Error(`Behaviour dataset not found: ${behaviourFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid behaviour dataset schema in: ${behaviourFile}`);
    }

    const confidenceData = tryReadJson(confidenceFile);
    const confidenceMap = new Map<string, any>();
    if (confidenceData && Array.isArray(confidenceData.wallets)) {
        for (const cw of confidenceData.wallets) {
            if (cw && cw.wallet) {
                confidenceMap.set(cw.wallet, cw);
            }
        }
    }

    const cohortWallets: any[] = behaviourData.wallets;
    const walletCount = cohortWallets.length;

    // 1. Extract signals and states from the same closed position population
    interface ExtractedWallet {
        wallet: string;
        closedPositions: number;
        raw: WalletRawSignals;
        states: WalletSignalStates;
        conf: WalletConfidenceJoin;
    }

    const extractedList: ExtractedWallet[] = [];
    const medReturnObs: { wallet: string; value: number }[] = [];
    const posPfObs: { wallet: string; value: number }[] = [];
    const winRateObs: { wallet: string; value: number }[] = [];
    const concObs: { wallet: string; value: number }[] = [];

    for (const bw of cohortWallets) {
        const walletAddress = bw.wallet;
        const totalClosedPositions = bw.closedPositions;

        // Verify position population directly from positions.json
        const posFile = path.join(discoveryDir, walletAddress, "positions.json");
        const positions: any[] = tryReadJson(posFile) || [];

        let grossPosUsd = 0;
        let grossNegUsd = 0;
        let positionsWithPnlCount = 0;

        for (const p of positions) {
            const pnlUsd = p.fabriqSummary?.totalPnlUsd ?? null;
            if (typeof pnlUsd === "number" && Number.isFinite(pnlUsd)) {
                positionsWithPnlCount++;
                if (pnlUsd > 0) {
                    grossPosUsd += pnlUsd;
                } else if (pnlUsd < 0) {
                    grossNegUsd += pnlUsd;
                }
            }
        }

        // 1. Median Position PnL %
        const rawMedReturn =
            typeof bw?.performance?.pnlPct?.median === "number" &&
            Number.isFinite(bw.performance.pnlPct.median)
                ? bw.performance.pnlPct.median
                : null;

        // 2. Position-Derived Profit Factor
        let rawPf: number | null = null;
        let pfState: ProfitFactorState = "SOURCE_MISSING";
        const absLoss = Math.abs(grossNegUsd);

        if (positionsWithPnlCount === 0 && totalClosedPositions > 0) {
            pfState = "SOURCE_MISSING";
        } else if (grossPosUsd === 0 && absLoss === 0) {
            pfState = "ZERO_GROSS_ACTIVITY";
        } else if (grossPosUsd === 0 && absLoss > 0) {
            pfState = "NO_POSITIVE_PROFIT";
            rawPf = 0.0;
        } else if (grossPosUsd > 0 && absLoss === 0) {
            pfState = "NO_NEGATIVE_PROFIT";
            rawPf = null; // Do NOT serialize Infinity as JSON number
        } else {
            pfState = "VALID";
            rawPf = grossPosUsd / absLoss;
        }

        // 3. Position Win Rate
        const rawWin =
            typeof bw?.performance?.winRatePct === "number" &&
            Number.isFinite(bw.performance.winRatePct)
                ? bw.performance.winRatePct
                : null;

        // 4. PnL Concentration Top1
        const rawConc =
            typeof bw?.performance?.top1PositiveProfitSharePct === "number" &&
            Number.isFinite(bw.performance.top1PositiveProfitSharePct)
                ? bw.performance.top1PositiveProfitSharePct
                : null;

        const posWithPnl = bw?.performance?.positionsWithPnl ?? positionsWithPnlCount;
        const posMissingPnl = bw?.performance?.positionsMissingPnl ?? 0;
        const winningPositions = bw?.performance?.winningPositions ?? 0;
        const positiveProfitTotal = bw?.performance?.positiveProfitTotalUsd ?? grossPosUsd;

        let concState: ConcentrationState = "UNKNOWN";
        if (rawConc !== null && (positiveProfitTotal ?? 0) > 0) {
            concState = "VALID";
        } else if (
            posWithPnl > 0 &&
            posMissingPnl === 0 &&
            (winningPositions === 0 || positiveProfitTotal === null || positiveProfitTotal <= 0)
        ) {
            concState = "NO_POSITIVE_PROFIT";
        } else if (posMissingPnl > 0 && posWithPnl === 0) {
            concState = "SOURCE_MISSING";
        } else {
            concState = "UNKNOWN";
        }

        // Collect valid observations for cohort percentile ranking
        if (rawMedReturn !== null) medReturnObs.push({ wallet: walletAddress, value: rawMedReturn });
        if (rawPf !== null && pfState === "VALID") posPfObs.push({ wallet: walletAddress, value: rawPf });
        if (rawWin !== null) winRateObs.push({ wallet: walletAddress, value: rawWin });
        if (rawConc !== null && concState === "VALID") concObs.push({ wallet: walletAddress, value: rawConc });

        const cw = confidenceMap.get(walletAddress);
        const generalPct =
            typeof cw?.confidence?.generalPct === "number"
                ? cw.confidence.generalPct
                : null;
        const performancePct =
            typeof cw?.confidence?.performancePct === "number"
                ? cw.confidence.performancePct
                : null;

        extractedList.push({
            wallet: walletAddress,
            closedPositions: totalClosedPositions,
            raw: {
                medianPositionPnlPct: rawMedReturn,
                positionDerivedProfitFactor: rawPf,
                positionWinRatePct: rawWin,
                top1PositiveProfitSharePct: rawConc,
            },
            states: {
                positionDerivedProfitFactor: pfState,
                pnlConcentrationTop1: concState,
            },
            conf: {
                generalPct,
                performancePct,
            },
        });
    }

    // 2. Compute cohort percentile ranks
    const normMedMap = computePercentileNormalization(
        medReturnObs,
        "higher_is_better",
        "medianPositionPnlPct"
    );
    const normPfMap = computePercentileNormalization(
        posPfObs,
        "higher_is_better",
        "positionDerivedProfitFactor"
    );
    const normWinMap = computePercentileNormalization(
        winRateObs,
        "higher_is_better",
        "positionWinRate"
    );
    const normConcMap = computePercentileNormalization(
        concObs,
        "lower_is_better",
        "pnlConcentrationTop1"
    );

    // 3. Score each wallet using aligned signals and domain policies
    const scoredRecords: WalletAlignedSkillRecord[] = [];
    let scoredCount = 0;
    let incompleteCount = 0;

    for (const item of extractedList) {
        const w = item.wallet;
        const missingSignals: string[] = [];

        // Check required signals
        if (item.raw.medianPositionPnlPct === null) missingSignals.push("medianPositionPnlPct");
        if (item.raw.positionWinRatePct === null) missingSignals.push("positionWinRate");

        // Profit Factor domain policy normalization
        let normPf: number | null = null;
        let pfNormSource: WalletNormalizationSources["positionDerivedProfitFactor"] = null;

        if (item.states.positionDerivedProfitFactor === "VALID") {
            normPf = normPfMap.has(w) ? normPfMap.get(w)! : null;
            pfNormSource = normPf !== null ? "cohort_percentile" : null;
            if (normPf === null) missingSignals.push("positionDerivedProfitFactor");
        } else if (item.states.positionDerivedProfitFactor === "NO_POSITIVE_PROFIT") {
            normPf = 0.0;
            pfNormSource = "domain_policy_no_positive_profit";
        } else if (item.states.positionDerivedProfitFactor === "NO_NEGATIVE_PROFIT") {
            normPf = 1.0;
            pfNormSource = "domain_policy_no_negative_profit";
        } else {
            missingSignals.push("positionDerivedProfitFactor");
        }

        // Concentration domain policy normalization
        let normConc: number | null = null;
        let concNormSource: WalletNormalizationSources["pnlConcentrationTop1"] = null;

        if (item.states.pnlConcentrationTop1 === "VALID") {
            normConc = normConcMap.has(w) ? normConcMap.get(w)! : null;
            concNormSource = normConc !== null ? "cohort_percentile" : null;
            if (normConc === null) missingSignals.push("pnlConcentrationTop1");
        } else if (item.states.pnlConcentrationTop1 === "NO_POSITIVE_PROFIT") {
            normConc = 0.0;
            concNormSource = "domain_policy_no_positive_profit";
        } else {
            missingSignals.push("pnlConcentrationTop1");
        }

        const normMed = normMedMap.has(w) ? normMedMap.get(w)! : null;
        const normWin = normWinMap.has(w) ? normWinMap.get(w)! : null;

        const normalizedSignals: WalletNormalizedSignals = {
            medianPositionPnlPct: normMed,
            positionDerivedProfitFactor: normPf,
            positionWinRate: normWin,
            pnlConcentrationTop1: normConc,
        };

        const normalizationSources: WalletNormalizationSources = {
            medianPositionPnlPct: normMed !== null ? "cohort_percentile" : null,
            positionDerivedProfitFactor: pfNormSource,
            positionWinRate: normWin !== null ? "cohort_percentile" : null,
            pnlConcentrationTop1: concNormSource,
        };

        if (
            missingSignals.length === 0 &&
            normMed !== null &&
            normPf !== null &&
            normWin !== null &&
            normConc !== null
        ) {
            const weightedMed = WEIGHTS.medianPositionPnlPct * normMed;
            const weightedPf = WEIGHTS.positionDerivedProfitFactor * normPf;
            const weightedWin = WEIGHTS.positionWinRate * normWin;
            const weightedConc = WEIGHTS.pnlConcentrationTop1 * normConc;

            const rawComposite = weightedMed + weightedPf + weightedWin + weightedConc;
            const skillScoreV1_2 = rawComposite * 100;

            // Sanity assertion
            if (skillScoreV1_2 < 0 || skillScoreV1_2 > 100) {
                throw new Error(`Sanity check failed: skillScoreV1_2 out of bounds [0, 100]: ${skillScoreV1_2}`);
            }

            scoredCount++;
            scoredRecords.push({
                wallet: w,
                scoreVersion: "v1.2-provisional",
                provisional: true,
                scoreStatus: "COMPLETE",
                skillScoreV1_2,
                population: {
                    closedPositions: item.closedPositions,
                    populationContract: "same_closed_position_population",
                },
                rawSignals: item.raw,
                signalStates: item.states,
                normalizedSignals,
                normalizationSources,
                weightedContributions: {
                    medianPositionPnlPct: weightedMed,
                    positionDerivedProfitFactor: weightedPf,
                    positionWinRate: weightedWin,
                    pnlConcentrationTop1: weightedConc,
                },
                confidence: item.conf,
                missingSignals: [],
            });
        } else {
            incompleteCount++;
            scoredRecords.push({
                wallet: w,
                scoreVersion: "v1.2-provisional",
                provisional: true,
                scoreStatus: "INCOMPLETE_SIGNALS",
                skillScoreV1_2: null,
                population: {
                    closedPositions: item.closedPositions,
                    populationContract: "same_closed_position_population",
                },
                rawSignals: item.raw,
                signalStates: item.states,
                normalizedSignals,
                normalizationSources,
                weightedContributions: {
                    medianPositionPnlPct: normMed !== null ? WEIGHTS.medianPositionPnlPct * normMed : null,
                    positionDerivedProfitFactor: normPf !== null ? WEIGHTS.positionDerivedProfitFactor * normPf : null,
                    positionWinRate: normWin !== null ? WEIGHTS.positionWinRate * normWin : null,
                    pnlConcentrationTop1: normConc !== null ? WEIGHTS.pnlConcentrationTop1 * normConc : null,
                },
                confidence: item.conf,
                missingSignals,
            });
        }
    }

    const output: AlignedSkillScoreOutput = {
        generatedAt: new Date().toISOString(),
        scoreVersion: "v1.2-provisional",
        provisional: true,
        walletCount,
        scoredWalletCount: scoredCount,
        incompleteWalletCount: incompleteCount,
        methodology: {
            temporalContract: "same_closed_position_population",
            normalization: "cohort_percentile_average_rank",
            confidenceIncludedInSkill: false,
            missingSignalPolicy: "require_all_four",
            externalRoiIncluded: false,
            masterProfitFactorIncluded: false,
            weights: WEIGHTS,
        },
        wallets: scoredRecords,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 6.7 — ALIGNED SKILL SCORE V1.2\n");

    const colWallet = "Wallet".padEnd(46);
    const colMed = "MedPnL%".padStart(10);
    const colPf = "PosPF%".padStart(10);
    const colWin = "Win%".padStart(10);
    const colConc = "Conc%".padStart(10);
    const colSkill = "SkillV1.2".padStart(12);
    const colConf = "Conf".padStart(8);
    const colStatus = "Status".padStart(16);

    console.log(
        `${colWallet}${colMed}${colPf}${colWin}${colConc}${colSkill}${colConf}${colStatus}`
    );
    console.log("-".repeat(122));

    for (const r of scoredRecords) {
        const wStr = r.wallet.padEnd(46);
        const medStr =
            r.normalizedSignals.medianPositionPnlPct !== null
                ? `${(r.normalizedSignals.medianPositionPnlPct * 100).toFixed(1)}%`.padStart(10)
                : "N/A".padStart(10);
        const pfStr =
            r.normalizedSignals.positionDerivedProfitFactor !== null
                ? `${(r.normalizedSignals.positionDerivedProfitFactor * 100).toFixed(1)}%`.padStart(10)
                : "N/A".padStart(10);
        const winStr =
            r.normalizedSignals.positionWinRate !== null
                ? `${(r.normalizedSignals.positionWinRate * 100).toFixed(1)}%`.padStart(10)
                : "N/A".padStart(10);
        const concStr =
            r.normalizedSignals.pnlConcentrationTop1 !== null
                ? `${(r.normalizedSignals.pnlConcentrationTop1 * 100).toFixed(1)}%`.padStart(10)
                : "N/A".padStart(10);
        const skillStr =
            r.skillScoreV1_2 !== null
                ? r.skillScoreV1_2.toFixed(2).padStart(12)
                : "null".padStart(12);
        const confStr =
            r.confidence.generalPct !== null
                ? `${r.confidence.generalPct.toFixed(1)}%`.padStart(8)
                : "N/A".padStart(8);
        const statusStr = r.scoreStatus.padStart(16);

        console.log(
            `${wStr}${medStr}${pfStr}${winStr}${concStr}${skillStr}${confStr}${statusStr}`
        );
    }

    console.log("-".repeat(122));
    console.log(`\nScored Wallets      : ${scoredCount} / ${walletCount}`);
    console.log(`Incomplete Wallets  : ${incompleteCount}`);
    console.log("Temporal Contract   : SAME CLOSED-POSITION POPULATION");
    console.log("Score Version       : v1.2-provisional");
    console.log("\nMethodology Notes:");
    console.log("  • Primary Return    : Median Position PnL % (robust against single-position outliers)");
    console.log("  • Profit Factor     : Derived directly from trusted closed-position PnL (grossProfit / abs(grossLoss))");
    console.log("  • Consistency       : Position Win Rate (same closed-position set)");
    console.log("  • Concentration     : PnL Concentration Top1 (same closed-position set; domain policy NO_POSITIVE_PROFIT=0)");
    console.log("  • Excluded Master   : External ROI and master single-month Profit Factor excluded due to temporal incompatibility");
    console.log(`\nOutput File         : ${outputFile}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Aligned skill score calculation failed: ${err.message}`);
    process.exit(1);
});
