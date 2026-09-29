import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    inputFile: string;
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

interface FrontendWalletScoresOutput {
    publishedAt: string;
    source: string;
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
        frontendPublished: true;
        frontendIntegrated: false;
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
        inputFile:
            options.input ||
            options["input-file"] ||
            path.resolve("data/master/wallet-scores.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("frontend/public/data/wallet-scores.json"),
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
    const { inputFile, outputFile } = parseCliArgs();

    // 1. Verify source artifact exists
    if (!fs.existsSync(inputFile)) {
        throw new Error(`Master scoring source file not found: ${inputFile}`);
    }

    const sourceData = tryReadJson(inputFile);
    if (!sourceData || !Array.isArray(sourceData.scores)) {
        throw new Error(`Invalid schema in master scoring source: ${inputFile}`);
    }

    // 2. Validate source invariants before publishing
    const validationErrors: string[] = [];

    if (sourceData.status !== "PROVISIONAL") {
        validationErrors.push(`Expected status 'PROVISIONAL', got: '${sourceData.status}'`);
    }

    const skillVersion = sourceData.versions?.skill;
    if (skillVersion !== "v1.2-provisional") {
        validationErrors.push(`Expected skill version 'v1.2-provisional', got: '${skillVersion}'`);
    }

    const styleVersion = sourceData.versions?.style;
    if (styleVersion !== "v0.1-provisional") {
        validationErrors.push(`Expected style version 'v0.1-provisional', got: '${styleVersion}'`);
    }

    const sourceScores: WalletScoreItem[] = sourceData.scores;
    const sourceCount = sourceScores.length;

    const seenWallets = new Set<string>();
    const duplicateWallets: string[] = [];

    for (const item of sourceScores) {
        if (!item.wallet || typeof item.wallet !== "string" || item.wallet.trim() === "") {
            validationErrors.push("Empty or invalid wallet address found in source artifact.");
        }
        if (seenWallets.has(item.wallet)) {
            duplicateWallets.push(item.wallet);
        }
        seenWallets.add(item.wallet);

        if (item.skill?.version !== "v1.2-provisional") {
            validationErrors.push(`[${item.wallet}] Invalid skill version in record: ${item.skill?.version}`);
        }
        if (item.skill?.provisional !== true) {
            validationErrors.push(`[${item.wallet}] Skill provisional flag must be true.`);
        }
        if (item.style?.version !== "v0.1-provisional") {
            validationErrors.push(`[${item.wallet}] Invalid style version in record: ${item.style?.version}`);
        }
        if (item.style?.provisional !== true) {
            validationErrors.push(`[${item.wallet}] Style provisional flag must be true.`);
        }
        if (item.style?.tag !== "farmer" && item.style?.tag !== "mixed_unclassified") {
            validationErrors.push(`[${item.wallet}] Disallowed style tag in record: ${item.style?.tag}`);
        }
    }

    if (duplicateWallets.length > 0) {
        validationErrors.push(`Duplicate wallet addresses found: ${duplicateWallets.join(", ")}`);
    }

    if (validationErrors.length > 0) {
        console.error("\n[PUBLISH VALIDATION FAILED] Source artifact violates invariants:");
        for (const err of validationErrors) {
            console.error(`  • ${err}`);
        }
        process.exit(1);
    }

    // 3. Build frontend-safe publication artifact
    // Preserve deterministic ordering, exact scores, confidence, style, and metrics
    const publishedScores: WalletScoreItem[] = sourceScores.map((s) => ({
        wallet: s.wallet,
        skill: {
            score: s.skill.score,
            version: s.skill.version,
            provisional: s.skill.provisional,
        },
        confidence: {
            generalPct: s.confidence.generalPct,
            performancePct: s.confidence.performancePct,
            rangePct: s.confidence.rangePct,
        },
        style: {
            tag: s.style.tag,
            version: s.style.version,
            provisional: s.style.provisional,
        },
        metrics: {
            winRatePosition: s.metrics.winRatePosition,
            pnlConcentrationTop1Pct: s.metrics.pnlConcentrationTop1Pct,
            medianHoldDurationHours: s.metrics.medianHoldDurationHours,
            trueRebalanceFrequency: s.metrics.trueRebalanceFrequency,
            sampleSize: s.metrics.sampleSize,
            uniquePools: s.metrics.uniquePools,
        },
    }));

    // Post-publish validation: verify count and 1:1 match
    if (publishedScores.length !== sourceCount) {
        throw new Error(
            `Published wallet count (${publishedScores.length}) does not match source count (${sourceCount})`
        );
    }

    const output: FrontendWalletScoresOutput = {
        publishedAt: new Date().toISOString(),
        source: "data/master/wallet-scores.json",
        status: "PROVISIONAL",
        versions: {
            skill: "v1.2-provisional",
            style: "v0.1-provisional",
        },
        walletCount: publishedScores.length,
        methodology: {
            skillConfidenceSeparated: true,
            skillTemporalContract: "same_closed_position_population",
            styleClassification: "partial_rule_based",
            frontendPublished: true,
            frontendIntegrated: false,
        },
        scores: publishedScores,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 7.3 — PUBLISH WALLET SCORES\n");
    console.log(`Source Wallets       : ${sourceCount}`);
    console.log(`Published Wallets    : ${publishedScores.length}`);
    console.log(`Skill Version        : ${skillVersion}`);
    console.log(`Style Version        : ${styleVersion}`);
    console.log("Publish Integrity    : PASS\n");

    console.log("Source:");
    console.log(inputFile);
    console.log("\nPublished:");
    console.log(outputFile);
    console.log("\nFrontend UI Integrated:");
    console.log("NO\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Publishing wallet scores failed: ${err.message}`);
    process.exit(1);
});
