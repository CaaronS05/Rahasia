import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    skillFile: string;
    confidenceFile: string;
    styleFile: string;
    behaviourFile: string;
    outputFile: string;
}

interface WalletScoreItem {
    wallet: string;
    skill: {
        score: number | null;
        version: "v1.2-provisional";
        provisional: true;
    };
    confidence: {
        generalPct: number | null;
        performancePct: number | null;
        rangePct: number | null;
    };
    style: {
        tag: "farmer" | "mixed_unclassified";
        version: "v0.1-provisional";
        provisional: true;
    };
    metrics: {
        winRatePosition: number | null;
        pnlConcentrationTop1Pct: number | null;
        medianHoldDurationHours: number | null;
        trueRebalanceFrequency: number | null;
        sampleSize: number;
        uniquePools: number;
    };
}

interface WalletScoresMasterOutput {
    generatedAt: string;
    status: "PROVISIONAL";
    versions: {
        skill: "v1.2-provisional";
        style: "v0.1-provisional";
    };
    walletCount: number;
    methodology: {
        skillConfidenceSeparated: true;
        skillTemporalContract: "same_closed_position_population";
        styleClassification: "partial_rule_based";
        frontendPublished: false;
    };
    scores: WalletScoreItem[];
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
        skillFile:
            options.skill ||
            options["skill-file"] ||
            path.resolve("data/discovery/waldisc-2/aligned-skill-score-v1-2.json"),
        confidenceFile:
            options.confidence ||
            options["confidence-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-confidence.json"),
        styleFile:
            options.style ||
            options["style-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-style-v0-1.json"),
        behaviourFile:
            options.behaviour ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/master/wallet-scores.json"),
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
    const { skillFile, confidenceFile, styleFile, behaviourFile, outputFile } =
        parseCliArgs();

    // 1. Load all required source inputs
    const skillData = tryReadJson(skillFile);
    if (!skillData || !Array.isArray(skillData.wallets)) {
        throw new Error(`Invalid or missing skill source file: ${skillFile}`);
    }

    const confidenceData = tryReadJson(confidenceFile);
    if (!confidenceData || !Array.isArray(confidenceData.wallets)) {
        throw new Error(`Invalid or missing confidence source file: ${confidenceFile}`);
    }

    const styleData = tryReadJson(styleFile);
    if (!styleData || !Array.isArray(styleData.wallets)) {
        throw new Error(`Invalid or missing style source file: ${styleFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid or missing behaviour source file: ${behaviourFile}`);
    }

    // Build lookup maps
    const skillMap = new Map<string, any>();
    for (const w of skillData.wallets) {
        if (w && w.wallet) skillMap.set(w.wallet, w);
    }

    const confidenceMap = new Map<string, any>();
    for (const w of confidenceData.wallets) {
        if (w && w.wallet) confidenceMap.set(w.wallet, w);
    }

    const styleMap = new Map<string, any>();
    for (const w of styleData.wallets) {
        if (w && w.wallet) styleMap.set(w.wallet, w);
    }

    const behaviourWallets: any[] = behaviourData.wallets;
    const baseAddresses = behaviourWallets.map((w) => w.wallet);
    const walletCount = baseAddresses.length;

    // 2. Validate Join Integrity
    const missingInSkill: string[] = [];
    const missingInConfidence: string[] = [];
    const missingInStyle: string[] = [];

    for (const addr of baseAddresses) {
        if (!skillMap.has(addr)) missingInSkill.push(addr);
        if (!confidenceMap.has(addr)) missingInConfidence.push(addr);
        if (!styleMap.has(addr)) missingInStyle.push(addr);
    }

    const duplicates = baseAddresses.filter(
        (addr, idx) => baseAddresses.indexOf(addr) !== idx
    );

    const joinErrors: string[] = [];
    if (duplicates.length > 0) {
        joinErrors.push(`Duplicate wallets found in base cohort: ${duplicates.join(", ")}`);
    }
    if (missingInSkill.length > 0) {
        joinErrors.push(`Wallets missing in skill source: ${missingInSkill.join(", ")}`);
    }
    if (missingInConfidence.length > 0) {
        joinErrors.push(`Wallets missing in confidence source: ${missingInConfidence.join(", ")}`);
    }
    if (missingInStyle.length > 0) {
        joinErrors.push(`Wallets missing in style source: ${missingInStyle.join(", ")}`);
    }

    if (joinErrors.length > 0) {
        console.error("\n[JOIN INTEGRITY ERROR] Cannot build master artifact due to join mismatch:");
        for (const err of joinErrors) {
            console.error(`  • ${err}`);
        }
        process.exit(1);
    }

    // 3. Construct Consolidated Records (strictly preserve existing validated sources)
    const joinedScores: WalletScoreItem[] = [];

    for (const bw of behaviourWallets) {
        const addr = bw.wallet;
        const sw = skillMap.get(addr);
        const cw = confidenceMap.get(addr);
        const stw = styleMap.get(addr);

        const skillScore = sw.skillScoreV1_2;
        const styleTag = stw.styleTag as "farmer" | "mixed_unclassified";

        const generalPct =
            typeof cw?.confidence?.generalPct === "number"
                ? cw.confidence.generalPct
                : null;
        const performancePct =
            typeof cw?.confidence?.performancePct === "number"
                ? cw.confidence.performancePct
                : null;
        const rangePct =
            typeof cw?.confidence?.rangePct === "number"
                ? cw.confidence.rangePct
                : null;

        const winRate =
            typeof bw?.performance?.winRatePct === "number"
                ? bw.performance.winRatePct
                : null;
        const concTop1 =
            typeof bw?.performance?.top1PositiveProfitSharePct === "number"
                ? bw.performance.top1PositiveProfitSharePct
                : null;
        const holdHours =
            typeof bw?.holdingBehaviour?.medianDurationHours === "number"
                ? bw.holdingBehaviour.medianDurationHours
                : null;
        const trueRebal =
            typeof bw?.rebalanceBehaviour?.trueRebalancePositionPct === "number"
                ? bw.rebalanceBehaviour.trueRebalancePositionPct
                : null;

        const sampleSize = bw.closedPositions;
        const uniquePools = bw.uniquePools;

        joinedScores.push({
            wallet: addr,
            skill: {
                score: skillScore,
                version: "v1.2-provisional",
                provisional: true,
            },
            confidence: {
                generalPct,
                performancePct,
                rangePct,
            },
            style: {
                tag: styleTag,
                version: "v0.1-provisional",
                provisional: true,
            },
            metrics: {
                winRatePosition: winRate,
                pnlConcentrationTop1Pct: concTop1,
                medianHoldDurationHours: holdHours,
                trueRebalanceFrequency: trueRebal,
                sampleSize,
                uniquePools,
            },
        });
    }

    const output: WalletScoresMasterOutput = {
        generatedAt: new Date().toISOString(),
        status: "PROVISIONAL",
        versions: {
            skill: "v1.2-provisional",
            style: "v0.1-provisional",
        },
        walletCount,
        methodology: {
            skillConfidenceSeparated: true,
            skillTemporalContract: "same_closed_position_population",
            styleClassification: "partial_rule_based",
            frontendPublished: false,
        },
        scores: joinedScores,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 7.1 — WALLET SCORES MASTER ARTIFACT\n");
    console.log(`Wallets Joined       : ${walletCount}`);
    console.log("Skill Version        : v1.2-provisional");
    console.log("Style Version        : v0.1-provisional");
    console.log("Join Integrity       : PASS\n");

    const colWallet = "Wallet".padEnd(46);
    const colSkill = "Skill".padStart(8);
    const colConf = "GeneralConf".padStart(14);
    const colStyle = "Style".padStart(22);

    console.log(`${colWallet}${colSkill}${colConf}${colStyle}`);
    console.log("-".repeat(90));

    for (const r of joinedScores) {
        const wStr = r.wallet.padEnd(46);
        const skillStr =
            r.skill.score !== null ? r.skill.score.toFixed(2).padStart(8) : "N/A".padStart(8);
        const confStr =
            r.confidence.generalPct !== null
                ? `${r.confidence.generalPct.toFixed(1)}%`.padStart(14)
                : "N/A".padStart(14);
        const styleStr = r.style.tag.padStart(22);

        console.log(`${wStr}${skillStr}${confStr}${styleStr}`);
    }

    console.log("-".repeat(90));
    console.log("\nOutput File:");
    console.log(outputFile);
    console.log("\nFrontend Published:");
    console.log("NO\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Failed to build wallet scores master artifact: ${err.message}`);
    process.exit(1);
});
