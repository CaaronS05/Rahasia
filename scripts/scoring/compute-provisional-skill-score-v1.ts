import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    designFile: string;
    behaviourFile: string;
    confidenceFile: string;
    masterFile: string;
    outputFile: string;
}

interface WalletRawSignals {
    roiAvgInflow: number | null;
    profitFactor: number | null;
    positionWinRatePct: number | null;
    top1PositiveProfitSharePct: number | null;
}

interface WalletConcentrationInfo {
    state: "VALID" | "NO_POSITIVE_PROFIT" | "SOURCE_MISSING" | "UNKNOWN";
    rawTop1PositiveProfitSharePct: number | null;
    positiveProfitTotalUsd: number | null;
}

interface WalletNormalizedSignals {
    roiAvgInflow: number | null;
    profitFactor: number | null;
    positionWinRate: number | null;
    pnlConcentrationTop1: number | null;
}

interface WalletNormalizationSources {
    roiAvgInflow: "cohort_percentile" | null;
    profitFactor: "cohort_percentile" | null;
    positionWinRate: "cohort_percentile" | null;
    pnlConcentrationTop1: "cohort_percentile" | "domain_policy_no_positive_profit" | null;
}

interface WalletWeightedContributions {
    roiAvgInflow: number | null;
    profitFactor: number | null;
    positionWinRate: number | null;
    pnlConcentrationTop1: number | null;
}

interface WalletConfidenceJoin {
    generalPct: number | null;
    performancePct: number | null;
}

interface WalletSkillScoreRecord {
    wallet: string;
    scoreVersion: "v1.1-provisional";
    provisional: true;
    scoreStatus: "COMPLETE" | "INCOMPLETE_SIGNALS";
    skillScoreV1: number | null;
    rawSignals: WalletRawSignals;
    concentration: WalletConcentrationInfo;
    normalizedSignals: WalletNormalizedSignals;
    normalizationSources: WalletNormalizationSources;
    weightedContributions: WalletWeightedContributions;
    confidence: WalletConfidenceJoin;
    missingSignals: string[];
}

interface ProvisionalSkillScoreOutput {
    generatedAt: string;
    scoreVersion: "v1.1-provisional";
    provisional: true;
    walletCount: number;
    scoredWalletCount: number;
    incompleteWalletCount: number;
    methodology: {
        normalization: "cohort_percentile_average_rank";
        domainPolicyNoPositiveProfit: "normalized_concentration_zero";
        confidenceIncludedInSkill: false;
        missingSignalPolicy: "require_all_four_or_domain_policy";
        weights: {
            roiAvgInflow: number;
            profitFactor: number;
            positionWinRate: number;
            pnlConcentrationTop1: number;
        };
    };
    wallets: WalletSkillScoreRecord[];
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
        designFile:
            options.design ||
            options["design-file"] ||
            path.resolve("data/discovery/waldisc-2/skill-signal-design.json"),
        behaviourFile:
            options.behaviour ||
            options.dataset ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        confidenceFile:
            options.confidence ||
            options["confidence-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-confidence.json"),
        masterFile:
            options.master ||
            options["master-file"] ||
            path.resolve("data/master/wallets-master.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/provisional-skill-score-v1.json"),
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
 * Computes deterministic percentile ranks with average rank for ties.
 * For a metric with N valid observations:
 *   percentile = (avgRank - 1) / (N - 1)
 * where ascending rank starts at 1.
 *
 * For higher_is_better:
 *   normalized = percentile
 * For lower_is_better:
 *   normalized = 1 - percentile
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

    // Sort ascending by value
    const sorted = [...observations].sort((a, b) => a.value - b.value);

    // Verify cohort variation (min !== max)
    if (sorted[0].value === sorted[N - 1].value) {
        throw new Error(
            `Signal "${signalName}" has zero variation across all ${N} valid observations (${sorted[0].value}). Signal contract unusable.`
        );
    }

    const resultMap = new Map<string, number>();

    let i = 0;
    while (i < N) {
        let j = i;
        while (j < N && sorted[j].value === sorted[i].value) {
            j++;
        }
        // Indices from i to j - 1 share the exact same value.
        // 1-based ranks are (i + 1) to j.
        // Average rank = ((i + 1) + j) / 2
        const avgRank = (i + 1 + j) / 2;
        const percentile = (avgRank - 1) / (N - 1);

        let normalized =
            direction === "higher_is_better" ? percentile : 1 - percentile;

        // Clamp to [0, 1] for numerical safety
        normalized = Math.max(0, Math.min(1, normalized));

        for (let k = i; k < j; k++) {
            resultMap.set(sorted[k].wallet, normalized);
        }

        i = j;
    }

    return resultMap;
}

async function main() {
    const { behaviourFile, confidenceFile, masterFile, outputFile } =
        parseCliArgs();

    // Signal weights defined by Step 6.1 spec (sum to exactly 1.00)
    const WEIGHTS = {
        roiAvgInflow: 0.35,
        profitFactor: 0.20,
        positionWinRate: 0.20,
        pnlConcentrationTop1: 0.25,
    };

    // Sanity check weights
    const weightSum =
        WEIGHTS.roiAvgInflow +
        WEIGHTS.profitFactor +
        WEIGHTS.positionWinRate +
        WEIGHTS.pnlConcentrationTop1;
    if (Math.abs(weightSum - 1.0) > 1e-12) {
        throw new Error(`Signal weights must sum to exactly 1.00. Current sum: ${weightSum}`);
    }

    if (!fs.existsSync(behaviourFile)) {
        throw new Error(`Wallet behaviour dataset not found: ${behaviourFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid behaviour dataset schema in: ${behaviourFile}`);
    }

    const masterData = tryReadJson(masterFile);
    const confidenceData = tryReadJson(confidenceFile);

    // Map master wallets by owner
    const masterMap = new Map<string, any>();
    if (masterData && Array.isArray(masterData.wallets)) {
        for (const mw of masterData.wallets) {
            if (mw && mw.owner) {
                masterMap.set(mw.owner, mw);
            }
        }
    }

    // Map confidence records by wallet
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

    // 1. Extract raw signals and concentration domain status for each wallet
    interface ExtractedWallet {
        wallet: string;
        raw: WalletRawSignals;
        concentration: WalletConcentrationInfo;
        conf: WalletConfidenceJoin;
    }

    const extractedList: ExtractedWallet[] = [];
    const roiObservations: { wallet: string; value: number }[] = [];
    const pfObservations: { wallet: string; value: number }[] = [];
    const winObservations: { wallet: string; value: number }[] = [];
    const concObservations: { wallet: string; value: number }[] = [];

    for (const bw of cohortWallets) {
        const walletAddress: string = bw.wallet;
        const mw = masterMap.get(walletAddress);
        const cw = confidenceMap.get(walletAddress);

        // 1. ROI Avg Inflow (roi_avg_inflow_native from master)
        const rawRoi =
            typeof mw?.roi_avg_inflow_native === "number" &&
            Number.isFinite(mw.roi_avg_inflow_native)
                ? mw.roi_avg_inflow_native
                : null;

        // 2. Profit Factor (fabriq.stats.profitFactorUsd.ratio from master)
        const rawPf =
            typeof mw?.fabriq?.stats?.profitFactorUsd?.ratio === "number" &&
            Number.isFinite(mw.fabriq.stats.profitFactorUsd.ratio)
                ? mw.fabriq.stats.profitFactorUsd.ratio
                : null;

        // 3. Position Win Rate (performance.winRatePct from behaviour dataset)
        const rawWin =
            typeof bw?.performance?.winRatePct === "number" &&
            Number.isFinite(bw.performance.winRatePct)
                ? bw.performance.winRatePct
                : null;

        // 4. PnL Concentration Top1 (performance.top1PositiveProfitSharePct from behaviour dataset)
        const rawConc =
            typeof bw?.performance?.top1PositiveProfitSharePct === "number" &&
            Number.isFinite(bw.performance.top1PositiveProfitSharePct)
                ? bw.performance.top1PositiveProfitSharePct
                : null;

        const posWithPnl = bw?.performance?.positionsWithPnl ?? 0;
        const posMissingPnl = bw?.performance?.positionsMissingPnl ?? 0;
        const winningPositions = bw?.performance?.winningPositions ?? 0;
        const positiveProfitTotal = bw?.performance?.positiveProfitTotalUsd ?? null;

        // Determine concentration domain status
        let concentrationState: WalletConcentrationInfo["state"] = "UNKNOWN";
        if (rawConc !== null && (positiveProfitTotal ?? 0) > 0) {
            concentrationState = "VALID";
        } else if (
            posWithPnl > 0 &&
            posMissingPnl === 0 &&
            (winningPositions === 0 || positiveProfitTotal === null || positiveProfitTotal <= 0)
        ) {
            concentrationState = "NO_POSITIVE_PROFIT";
        } else if (posMissingPnl > 0 && posWithPnl === 0) {
            concentrationState = "SOURCE_MISSING";
        } else {
            concentrationState = "UNKNOWN";
        }

        if (rawRoi !== null) roiObservations.push({ wallet: walletAddress, value: rawRoi });
        if (rawPf !== null) pfObservations.push({ wallet: walletAddress, value: rawPf });
        if (rawWin !== null) winObservations.push({ wallet: walletAddress, value: rawWin });

        // Cohort percentile ranking includes only VALID gross-positive profit observations
        if (rawConc !== null && concentrationState === "VALID") {
            concObservations.push({ wallet: walletAddress, value: rawConc });
        }

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
            raw: {
                roiAvgInflow: rawRoi,
                profitFactor: rawPf,
                positionWinRatePct: rawWin,
                top1PositiveProfitSharePct: rawConc,
            },
            concentration: {
                state: concentrationState,
                rawTop1PositiveProfitSharePct: rawConc,
                positiveProfitTotalUsd: positiveProfitTotal,
            },
            conf: {
                generalPct,
                performancePct,
            },
        });
    }

    // 2. Compute cohort percentile ranks
    const normRoiMap = computePercentileNormalization(
        roiObservations,
        "higher_is_better",
        "roi_avg_inflow_native"
    );
    const normPfMap = computePercentileNormalization(
        pfObservations,
        "higher_is_better",
        "profitFactorUsd.ratio"
    );
    const normWinMap = computePercentileNormalization(
        winObservations,
        "higher_is_better",
        "winRatePosition"
    );
    const normConcMap = computePercentileNormalization(
        concObservations,
        "lower_is_better",
        "top1PositiveProfitSharePct"
    );

    // 3. Score each wallet
    const scoredRecords: WalletSkillScoreRecord[] = [];
    let scoredCount = 0;
    let incompleteCount = 0;

    for (const item of extractedList) {
        const w = item.wallet;
        const missingSignals: string[] = [];

        if (item.raw.roiAvgInflow === null) missingSignals.push("roiAvgInflow");
        if (item.raw.profitFactor === null) missingSignals.push("profitFactor");
        if (item.raw.positionWinRatePct === null) missingSignals.push("positionWinRate");

        // Concentration is missing ONLY if it's neither VALID nor NO_POSITIVE_PROFIT
        if (
            item.concentration.state !== "VALID" &&
            item.concentration.state !== "NO_POSITIVE_PROFIT"
        ) {
            missingSignals.push("pnlConcentrationTop1");
        }

        const normRoi = normRoiMap.has(w) ? normRoiMap.get(w)! : null;
        const normPf = normPfMap.has(w) ? normPfMap.get(w)! : null;
        const normWin = normWinMap.has(w) ? normWinMap.get(w)! : null;

        let normConc: number | null = null;
        let concNormSource: WalletNormalizationSources["pnlConcentrationTop1"] = null;

        if (item.concentration.state === "VALID") {
            normConc = normConcMap.has(w) ? normConcMap.get(w)! : null;
            concNormSource = normConc !== null ? "cohort_percentile" : null;
        } else if (item.concentration.state === "NO_POSITIVE_PROFIT") {
            // Domain Policy: Wallets with 0 positive profit demonstrate 0 positive profit robustness
            normConc = 0;
            concNormSource = "domain_policy_no_positive_profit";
        } else {
            normConc = null;
            concNormSource = null;
        }

        const normalizedSignals: WalletNormalizedSignals = {
            roiAvgInflow: normRoi,
            profitFactor: normPf,
            positionWinRate: normWin,
            pnlConcentrationTop1: normConc,
        };

        const normalizationSources: WalletNormalizationSources = {
            roiAvgInflow: normRoi !== null ? "cohort_percentile" : null,
            profitFactor: normPf !== null ? "cohort_percentile" : null,
            positionWinRate: normWin !== null ? "cohort_percentile" : null,
            pnlConcentrationTop1: concNormSource,
        };

        if (missingSignals.length === 0 && normConc !== null) {
            // All 4 required signals are present or resolved via domain policy
            const weightedRoi = WEIGHTS.roiAvgInflow * normRoi!;
            const weightedPf = WEIGHTS.profitFactor * normPf!;
            const weightedWin = WEIGHTS.positionWinRate * normWin!;
            const weightedConc = WEIGHTS.pnlConcentrationTop1 * normConc;

            const rawComposite = weightedRoi + weightedPf + weightedWin + weightedConc;
            const skillScoreV1 = rawComposite * 100;

            // Sanity assertions
            if (skillScoreV1 < 0 || skillScoreV1 > 100) {
                throw new Error(`Sanity check failed: skillScoreV1 out of bounds [0, 100]: ${skillScoreV1}`);
            }

            scoredCount++;
            scoredRecords.push({
                wallet: w,
                scoreVersion: "v1.1-provisional",
                provisional: true,
                scoreStatus: "COMPLETE",
                skillScoreV1,
                rawSignals: item.raw,
                concentration: item.concentration,
                normalizedSignals,
                normalizationSources,
                weightedContributions: {
                    roiAvgInflow: weightedRoi,
                    profitFactor: weightedPf,
                    positionWinRate: weightedWin,
                    pnlConcentrationTop1: weightedConc,
                },
                confidence: item.conf,
                missingSignals: [],
            });
        } else {
            // Incomplete signals: skillScoreV1 MUST be null
            incompleteCount++;
            scoredRecords.push({
                wallet: w,
                scoreVersion: "v1.1-provisional",
                provisional: true,
                scoreStatus: "INCOMPLETE_SIGNALS",
                skillScoreV1: null,
                rawSignals: item.raw,
                concentration: item.concentration,
                normalizedSignals,
                normalizationSources,
                weightedContributions: {
                    roiAvgInflow: normRoi !== null ? WEIGHTS.roiAvgInflow * normRoi : null,
                    profitFactor: normPf !== null ? WEIGHTS.profitFactor * normPf : null,
                    positionWinRate: normWin !== null ? WEIGHTS.positionWinRate * normWin : null,
                    pnlConcentrationTop1: normConc !== null ? WEIGHTS.pnlConcentrationTop1 * normConc : null,
                },
                confidence: item.conf,
                missingSignals,
            });
        }
    }

    const output: ProvisionalSkillScoreOutput = {
        generatedAt: new Date().toISOString(),
        scoreVersion: "v1.1-provisional",
        provisional: true,
        walletCount,
        scoredWalletCount: scoredCount,
        incompleteWalletCount: incompleteCount,
        methodology: {
            normalization: "cohort_percentile_average_rank",
            domainPolicyNoPositiveProfit: "normalized_concentration_zero",
            confidenceIncludedInSkill: false,
            missingSignalPolicy: "require_all_four_or_domain_policy",
            weights: WEIGHTS,
        },
        wallets: scoredRecords,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 6.1 — PROVISIONAL SKILL SCORE V1.1 (CONCENTRATION FIX)\n");
    console.log(`Cohort Wallets Audited : ${walletCount}`);
    console.log(`Successfully Scored    : ${scoredCount}`);
    console.log(`Incomplete Wallets     : ${incompleteCount}\n`);

    const colWallet = "Wallet".padEnd(46);
    const colRoi = "ROI%".padStart(8);
    const colPf = "PF%".padStart(8);
    const colWin = "Win%".padStart(8);
    const colConc = "Conc%".padStart(8);
    const colSkill = "SkillV1".padStart(10);
    const colConf = "Conf".padStart(8);
    const colStatus = "Status".padStart(22);

    console.log(
        `${colWallet}${colRoi}${colPf}${colWin}${colConc}${colSkill}${colConf}${colStatus}`
    );
    console.log("-".repeat(118));

    for (const r of scoredRecords) {
        const wStr = r.wallet.padEnd(46);
        const roiStr =
            r.normalizedSignals.roiAvgInflow !== null
                ? `${(r.normalizedSignals.roiAvgInflow * 100).toFixed(1)}%`.padStart(8)
                : "N/A".padStart(8);
        const pfStr =
            r.normalizedSignals.profitFactor !== null
                ? `${(r.normalizedSignals.profitFactor * 100).toFixed(1)}%`.padStart(8)
                : "N/A".padStart(8);
        const winStr =
            r.normalizedSignals.positionWinRate !== null
                ? `${(r.normalizedSignals.positionWinRate * 100).toFixed(1)}%`.padStart(8)
                : "N/A".padStart(8);
        const concStr =
            r.normalizedSignals.pnlConcentrationTop1 !== null
                ? `${(r.normalizedSignals.pnlConcentrationTop1 * 100).toFixed(1)}%`.padStart(8)
                : "N/A".padStart(8);
        const skillStr =
            r.skillScoreV1 !== null
                ? r.skillScoreV1.toFixed(2).padStart(10)
                : "null".padStart(10);
        const confStr =
            r.confidence.generalPct !== null
                ? `${r.confidence.generalPct.toFixed(1)}%`.padStart(8)
                : "N/A".padStart(8);
        const statusStr = r.scoreStatus.padStart(22);

        console.log(
            `${wStr}${roiStr}${pfStr}${winStr}${concStr}${skillStr}${confStr}${statusStr}`
        );
    }

    console.log("-".repeat(118));
    console.log("\nMethodology Notes:");
    console.log("  • Score Version       : v1.1-provisional (Concentration-Domain Patched)");
    console.log("  • Normalization       : Cohort percentile with average rank for ties");
    console.log("  • Domain Policy       : NO_POSITIVE_PROFIT receives normalized concentration skill = 0");
    console.log("  • Weights             : ROI 0.35, Profit Factor 0.20, Win Rate 0.20, Top1 Conc 0.25");
    console.log("  • Missing Signal Rule : True missing source data produces null score; domain-defined zero-profit is scored");
    console.log("  • Evidence Confidence : Evaluated separately (NOT mixed into skill score)");
    console.log(`\nOutput File           : ${outputFile}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Provisional skill score calculation failed: ${err.message}`);
    process.exit(1);
});
