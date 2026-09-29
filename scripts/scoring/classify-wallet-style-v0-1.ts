import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    behaviourFile: string;
    cohortDistFile: string;
    readinessFile: string;
    outputFile: string;
}

type StyleTag = "farmer" | "mixed_unclassified";
type StyleStatus = "CLASSIFIED" | "INSUFFICIENT_STYLE_DATA";

interface WalletStyleEvidence {
    medianHoldDurationHours: number | null;
    uniquePools: number | null;
    farmerHoldThresholdHours: number;
    farmerPoolThreshold: number;
}

interface FarmerRuleEvaluation {
    holdCondition: boolean;
    poolCondition: boolean;
    matched: boolean;
}

interface DisabledRuleEvaluation {
    evaluated: false;
    reason: string;
}

interface WalletStyleRecord {
    wallet: string;
    styleTag: StyleTag;
    styleStatus: StyleStatus;
    evidence: WalletStyleEvidence;
    ruleEvaluation: {
        farmer: FarmerRuleEvaluation;
        sniper: DisabledRuleEvaluation;
        activeRangeTrader: DisabledRuleEvaluation;
    };
}

interface StyleClassificationOutput {
    generatedAt: string;
    styleVersion: "v0.1-provisional";
    provisional: true;
    walletCount: number;
    methodology: {
        classification: "rule_based_cohort_relative";
        skillUsed: false;
        confidenceUsed: false;
        farmer: {
            holdThresholdSource: "cohort_p75";
            poolThresholdSource: "cohort_p25";
            resolvedMedianHoldHoursThreshold: number;
            resolvedUniquePoolsThreshold: number;
        };
        disabledRules: {
            sniper: "ENTRY_TIMING_UNAVAILABLE";
            active_range_trader: "TRUE_REBALANCE_LOW_VARIATION";
        };
    };
    wallets: WalletStyleRecord[];
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
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        cohortDistFile:
            options["cohort-dist"] ||
            options["cohort-distribution"] ||
            path.resolve("data/discovery/waldisc-2/cohort-distribution.json"),
        readinessFile:
            options.readiness ||
            options["readiness-file"] ||
            path.resolve("data/discovery/waldisc-2/style-classification-readiness.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-style-v0-1.json"),
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

function computePercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[sorted.length - 1];

    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (lower === upper) {
        return sorted[lower];
    }
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

async function main() {
    const { behaviourFile, cohortDistFile, outputFile } = parseCliArgs();

    if (!fs.existsSync(behaviourFile)) {
        throw new Error(`Behaviour dataset not found: ${behaviourFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid behaviour dataset: ${behaviourFile}`);
    }

    const wallets: any[] = behaviourData.wallets;
    const walletCount = wallets.length;

    // Resolve Farmer thresholds dynamically from cohort distribution
    const cohortDist = tryReadJson(cohortDistFile);

    let holdHoursP75: number;
    let uniquePoolsP25: number;

    if (
        cohortDist?.metrics?.medianDurationHours?.p75 !== undefined &&
        cohortDist?.metrics?.uniquePoolCount?.p25 !== undefined
    ) {
        holdHoursP75 = cohortDist.metrics.medianDurationHours.p75;
        uniquePoolsP25 = cohortDist.metrics.uniquePoolCount.p25;
    } else {
        // Fallback: calculate dynamically directly from behaviour records
        const allHolds: number[] = [];
        const allPools: number[] = [];

        for (const w of wallets) {
            const h = w?.holdingBehaviour?.medianDurationHours;
            const p = w?.uniquePools;
            if (typeof h === "number" && Number.isFinite(h)) allHolds.push(h);
            if (typeof p === "number" && Number.isFinite(p)) allPools.push(p);
        }

        allHolds.sort((a, b) => a - b);
        allPools.sort((a, b) => a - b);

        holdHoursP75 = computePercentile(allHolds, 75);
        uniquePoolsP25 = computePercentile(allPools, 25);
    }

    const walletRecords: WalletStyleRecord[] = [];
    let farmerCount = 0;
    let mixedCount = 0;

    for (const w of wallets) {
        const walletAddress = w.wallet;
        const rawHold = w?.holdingBehaviour?.medianDurationHours;
        const rawPools = w?.uniquePools;

        const hasValidHold = typeof rawHold === "number" && Number.isFinite(rawHold);
        const hasValidPools = typeof rawPools === "number" && Number.isFinite(rawPools);

        const holdDuration = hasValidHold ? rawHold : null;
        const poolCount = hasValidPools ? rawPools : null;

        const evidence: WalletStyleEvidence = {
            medianHoldDurationHours: holdDuration,
            uniquePools: poolCount,
            farmerHoldThresholdHours: holdHoursP75,
            farmerPoolThreshold: uniquePoolsP25,
        };

        if (!hasValidHold || !hasValidPools) {
            mixedCount++;
            walletRecords.push({
                wallet: walletAddress,
                styleTag: "mixed_unclassified",
                styleStatus: "INSUFFICIENT_STYLE_DATA",
                evidence,
                ruleEvaluation: {
                    farmer: {
                        holdCondition: false,
                        poolCondition: false,
                        matched: false,
                    },
                    sniper: {
                        evaluated: false,
                        reason: "ENTRY_TIMING_UNAVAILABLE",
                    },
                    activeRangeTrader: {
                        evaluated: false,
                        reason: "TRUE_REBALANCE_LOW_VARIATION",
                    },
                },
            });
            continue;
        }

        // Evaluate Farmer rule
        const holdCondition = holdDuration! >= holdHoursP75;
        const poolCondition = poolCount! <= uniquePoolsP25;
        const isFarmer = holdCondition && poolCondition;

        const styleTag: StyleTag = isFarmer ? "farmer" : "mixed_unclassified";

        if (isFarmer) {
            farmerCount++;
        } else {
            mixedCount++;
        }

        walletRecords.push({
            wallet: walletAddress,
            styleTag,
            styleStatus: "CLASSIFIED",
            evidence,
            ruleEvaluation: {
                farmer: {
                    holdCondition,
                    poolCondition,
                    matched: isFarmer,
                },
                sniper: {
                    evaluated: false,
                    reason: "ENTRY_TIMING_UNAVAILABLE",
                },
                activeRangeTrader: {
                    evaluated: false,
                    reason: "TRUE_REBALANCE_LOW_VARIATION",
                },
            },
        });
    }

    const output: StyleClassificationOutput = {
        generatedAt: new Date().toISOString(),
        styleVersion: "v0.1-provisional",
        provisional: true,
        walletCount,
        methodology: {
            classification: "rule_based_cohort_relative",
            skillUsed: false,
            confidenceUsed: false,
            farmer: {
                holdThresholdSource: "cohort_p75",
                poolThresholdSource: "cohort_p25",
                resolvedMedianHoldHoursThreshold: holdHoursP75,
                resolvedUniquePoolsThreshold: uniquePoolsP25,
            },
            disabledRules: {
                sniper: "ENTRY_TIMING_UNAVAILABLE",
                active_range_trader: "TRUE_REBALANCE_LOW_VARIATION",
            },
        },
        wallets: walletRecords,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 — WALLET STYLE V0.1\n");
    console.log(`Wallets             : ${walletCount}`);
    console.log(`Style Version       : v0.1-provisional\n`);

    console.log("Farmer Thresholds:");
    console.log(`Median Hold >= P75  : ${holdHoursP75.toFixed(2)} hours`);
    console.log(`Unique Pools <= P25 : ${uniquePoolsP25} pools\n`);

    const colWallet = "Wallet".padEnd(46);
    const colHold = "Hold(h)".padStart(10);
    const colPools = "Pools".padStart(8);
    const colStyle = "Style".padStart(22);

    console.log(`${colWallet}${colHold}${colPools}${colStyle}`);
    console.log("-".repeat(86));

    for (const r of walletRecords) {
        const wStr = r.wallet.padEnd(46);
        const holdStr =
            r.evidence.medianHoldDurationHours !== null
                ? r.evidence.medianHoldDurationHours.toFixed(2).padStart(10)
                : "N/A".padStart(10);
        const poolsStr =
            r.evidence.uniquePools !== null
                ? String(r.evidence.uniquePools).padStart(8)
                : "N/A".padStart(8);
        const styleStr = r.styleTag.padStart(22);

        console.log(`${wStr}${holdStr}${poolsStr}${styleStr}`);
    }

    console.log("-".repeat(86));
    console.log("\nStyle Counts:");
    console.log(`Farmer               : ${farmerCount}`);
    console.log(`Mixed / Unclassified : ${mixedCount}\n`);

    console.log("Disabled:");
    console.log("Sniper               : ENTRY_TIMING_UNAVAILABLE");
    console.log("Active Range Trader  : TRUE_REBALANCE_LOW_VARIATION\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Style classification failed: ${err.message}`);
    process.exit(1);
});
