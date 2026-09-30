import fs from "node:fs";
import path from "node:path";
import { buildQualityScores } from "../build-wallet-quality-scores.ts";

interface CliOptions {
    scoresPath: string;
    datasetPath: string;
    outputPath: string;
}

interface DistributionStats {
    count: number;
    min: number;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
}

interface ScoreExample {
    rank: number;
    wallet: string;
    qualityScore: number;
    raw: {
        medianPositionPnlPct: number;
        profitFactor: number;
        positionWinRate: number;
        pnlConcentrationTop1: number;
        totalPnl: number;
        closedPositionCount: number;
    };
    components: {
        medianPositionPnlPctPercentile: number;
        profitFactorPercentile: number;
        positionWinRatePercentile: number;
        inverseConcentrationPercentile: number;
    };
}

export interface V1QualityScoreAuditReport {
    generatedAt: string;
    scoresPath: string;
    datasetPath: string;
    status: "PASS" | "FAIL";
    populationAudit: {
        inputValidWalletCount: number;
        outputWalletCount: number;
        missingWalletsCount: number;
        missingWallets: string[];
        extraWalletsCount: number;
        extraWallets: string[];
        duplicateWalletsCount: number;
        duplicateWallets: string[];
    };
    integrityAudit: {
        nanOrInfinityCount: number;
        componentBoundsViolationsCount: number;
        scoreBoundsViolationsCount: number;
        formulaMismatchCount: number;
        violations: string[];
    };
    distribution: DistributionStats;
    examples: {
        highest: ScoreExample | null;
        lowest: ScoreExample | null;
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let scoresPath = path.resolve("data/v1/wallet-quality-scores.json");
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-quality-scores-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--scores" && args[i + 1]) {
            scoresPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--scores=")) {
            scoresPath = path.resolve(arg.slice(9));
        } else if (arg === "--dataset" && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=")) {
            datasetPath = path.resolve(arg.slice(10));
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    return { scoresPath, datasetPath, outputPath };
}

function computePercentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const rank = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    if (lower === upper) return sortedValues[lower];
    return Number((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight).toFixed(4));
}

export function auditQualityScores(scoresData: any, datasetData: any, scoresPath: string, datasetPath: string): V1QualityScoreAuditReport {
    const violations: string[] = [];

    // 1. Dataset valid wallets
    const datasetWallets: any[] = Array.isArray(datasetData?.wallets) ? datasetData.wallets : [];
    const validDatasetWallets = datasetWallets.filter((w) => w?.valid === true);
    const validWalletSet = new Set<string>(validDatasetWallets.map((w) => String(w.wallet).trim()));

    // 2. Scores output wallets
    const scoredWallets: any[] = Array.isArray(scoresData?.wallets) ? scoresData.wallets : [];
    const scoredWalletMap = new Map<string, number>();

    for (const sw of scoredWallets) {
        const addr = String(sw.wallet || "").trim();
        if (addr) {
            scoredWalletMap.set(addr, (scoredWalletMap.get(addr) ?? 0) + 1);
        }
    }

    const missingWallets: string[] = [];
    for (const w of validWalletSet) {
        if (!scoredWalletMap.has(w)) {
            missingWallets.push(w);
            violations.push(`Valid wallet missing from quality scores: ${w}`);
        }
    }

    const extraWallets: string[] = [];
    for (const [w] of scoredWalletMap.entries()) {
        if (!validWalletSet.has(w)) {
            extraWallets.push(w);
            violations.push(`Extra wallet in quality scores not present in valid dataset: ${w}`);
        }
    }

    const duplicateWallets: string[] = [];
    for (const [w, count] of scoredWalletMap.entries()) {
        if (count > 1) {
            duplicateWallets.push(w);
            violations.push(`Duplicate wallet in quality scores: ${w} (${count} occurrences)`);
        }
    }

    // 3. Numerical & bounds integrity
    let nanOrInfinityCount = 0;
    let componentBoundsViolationsCount = 0;
    let scoreBoundsViolationsCount = 0;
    let formulaMismatchCount = 0;

    const scoresList: number[] = [];

    for (const sw of scoredWallets) {
        const w = sw.wallet;
        const qScore = sw.qualityScore;

        if (typeof qScore !== "number" || !Number.isFinite(qScore) || Number.isNaN(qScore)) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} has non-finite qualityScore: ${qScore}`);
            continue;
        }

        scoresList.push(qScore);

        if (qScore < 0 || qScore > 100) {
            scoreBoundsViolationsCount++;
            violations.push(`Wallet ${w} qualityScore out of bounds [0, 100]: ${qScore}`);
        }

        const comp = sw.components;
        if (!comp) {
            violations.push(`Wallet ${w} missing components object`);
            continue;
        }

        const compFields = [
            "medianPositionPnlPctPercentile",
            "profitFactorPercentile",
            "positionWinRatePercentile",
            "inverseConcentrationPercentile",
        ];

        for (const cf of compFields) {
            const v = comp[cf];
            if (typeof v !== "number" || !Number.isFinite(v) || Number.isNaN(v)) {
                nanOrInfinityCount++;
                violations.push(`Wallet ${w} component ${cf} is non-finite: ${v}`);
            } else if (v < 0 || v > 100) {
                componentBoundsViolationsCount++;
                violations.push(`Wallet ${w} component ${cf} out of bounds [0, 100]: ${v}`);
            }
        }

        // Formula verification: 35% / 25% / 20% / 20%
        const expectedScore = Number(
            (
                (comp.medianPositionPnlPctPercentile ?? 0) * 0.35 +
                (comp.profitFactorPercentile ?? 0) * 0.25 +
                (comp.positionWinRatePercentile ?? 0) * 0.20 +
                (comp.inverseConcentrationPercentile ?? 0) * 0.20
            ).toFixed(2)
        );

        if (Math.abs(expectedScore - qScore) > 0.02) {
            formulaMismatchCount++;
            violations.push(
                `Wallet ${w} formula mismatch: stored=${qScore}, expected=${expectedScore} (diff=${Math.abs(expectedScore - qScore)})`
            );
        }
    }

    // 4. Distribution stats
    scoresList.sort((a, b) => a - b);
    const distribution: DistributionStats = {
        count: scoresList.length,
        min: scoresList.length > 0 ? scoresList[0] : 0,
        p10: computePercentile(scoresList, 10),
        p25: computePercentile(scoresList, 25),
        median: computePercentile(scoresList, 50),
        p75: computePercentile(scoresList, 75),
        p90: computePercentile(scoresList, 90),
        max: scoresList.length > 0 ? scoresList[scoresList.length - 1] : 0,
    };

    // 5. Examples (Highest and Lowest)
    let highestExample: ScoreExample | null = null;
    let lowestExample: ScoreExample | null = null;

    if (scoredWallets.length > 0) {
        // Find highest score
        let best = scoredWallets[0];
        let worst = scoredWallets[0];

        for (const sw of scoredWallets) {
            if (sw.qualityScore > best.qualityScore) best = sw;
            if (sw.qualityScore < worst.qualityScore) worst = sw;
        }

        highestExample = {
            rank: 1,
            wallet: best.wallet,
            qualityScore: best.qualityScore,
            raw: best.raw,
            components: best.components,
        };

        lowestExample = {
            rank: scoredWallets.length,
            wallet: worst.wallet,
            qualityScore: worst.qualityScore,
            raw: worst.raw,
            components: worst.components,
        };
    }

    const status: "PASS" | "FAIL" = violations.length === 0 ? "PASS" : "FAIL";

    return {
        generatedAt: new Date().toISOString(),
        scoresPath,
        datasetPath,
        status,
        populationAudit: {
            inputValidWalletCount: validWalletSet.size,
            outputWalletCount: scoredWallets.length,
            missingWalletsCount: missingWallets.length,
            missingWallets,
            extraWalletsCount: extraWallets.length,
            extraWallets,
            duplicateWalletsCount: duplicateWallets.length,
            duplicateWallets,
        },
        integrityAudit: {
            nanOrInfinityCount,
            componentBoundsViolationsCount,
            scoreBoundsViolationsCount,
            formulaMismatchCount,
            violations: violations.slice(0, 50),
        },
        distribution,
        examples: {
            highest: highestExample,
            lowest: lowestExample,
        },
    };
}

function printAuditReport(report: V1QualityScoreAuditReport): void {
    console.log("==================================================");
    console.log("V1 — WALLET QUALITY SCORE AUDIT REPORT");
    console.log("==================================================");
    console.log(`Generated At            : ${report.generatedAt}`);
    console.log(`Quality Scores Path     : ${report.scoresPath}`);
    console.log(`Source Dataset Path     : ${report.datasetPath}`);
    console.log(`Audit Status            : ${report.status}\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Input Valid Wallets     : ${report.populationAudit.inputValidWalletCount}`);
    console.log(`Output Scored Wallets   : ${report.populationAudit.outputWalletCount}`);
    console.log(`Missing Wallets         : ${report.populationAudit.missingWalletsCount}`);
    console.log(`Extra Wallets           : ${report.populationAudit.extraWalletsCount}`);
    console.log(`Duplicate Wallets       : ${report.populationAudit.duplicateWalletsCount}\n`);

    console.log("2. SCORE & COMPONENT INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`NaN / Infinity Violations: ${report.integrityAudit.nanOrInfinityCount}`);
    console.log(`Component Bounds [0-100]: ${report.integrityAudit.componentBoundsViolationsCount}`);
    console.log(`Score Bounds [0-100]    : ${report.integrityAudit.scoreBoundsViolationsCount}`);
    console.log(`Formula Mismatches      : ${report.integrityAudit.formulaMismatchCount}`);
    if (report.integrityAudit.violations.length > 0) {
        console.log("\nSample Violations:");
        for (const v of report.integrityAudit.violations.slice(0, 10)) {
            console.log(`  - ${v}`);
        }
    } else {
        console.log("  All components and final scores satisfy mathematical constraints.\n");
    }

    console.log("3. QUALITY SCORE DISTRIBUTION (N=65)");
    console.log("--------------------------------------------------");
    console.log(`Min    : ${report.distribution.min}`);
    console.log(`P10    : ${report.distribution.p10}`);
    console.log(`P25    : ${report.distribution.p25}`);
    console.log(`Median : ${report.distribution.median}`);
    console.log(`P75    : ${report.distribution.p75}`);
    console.log(`P90    : ${report.distribution.p90}`);
    console.log(`Max    : ${report.distribution.max}\n`);

    console.log("4. COHORT SCORE EXTREMES (INSPECTION)");
    console.log("--------------------------------------------------");
    if (report.examples.highest) {
        const h = report.examples.highest;
        console.log(`HIGHEST QUALITY SCORE (Rank 1):`);
        console.log(`  Wallet           : ${h.wallet}`);
        console.log(`  Quality Score    : ${h.qualityScore}`);
        console.log(`  Raw Metrics:`);
        console.log(`    medianPositionPnlPct : ${h.raw.medianPositionPnlPct}%`);
        console.log(`    profitFactor         : ${h.raw.profitFactor}`);
        console.log(`    positionWinRate      : ${h.raw.positionWinRate}%`);
        console.log(`    pnlConcentrationTop1 : ${h.raw.pnlConcentrationTop1}%`);
        console.log(`    totalPnl (context)   : $${h.raw.totalPnl}`);
        console.log(`    closedPositions (ctx): ${h.raw.closedPositionCount}`);
        console.log(`  Percentile Components:`);
        console.log(`    medianPnlPctPctile   : ${h.components.medianPositionPnlPctPercentile}`);
        console.log(`    profitFactorPctile   : ${h.components.profitFactorPercentile}`);
        console.log(`    winRatePctile        : ${h.components.positionWinRatePercentile}`);
        console.log(`    inverseConcPctile    : ${h.components.inverseConcentrationPercentile}\n`);
    }

    if (report.examples.lowest) {
        const l = report.examples.lowest;
        console.log(`LOWEST QUALITY SCORE (Rank ${l.rank}):`);
        console.log(`  Wallet           : ${l.wallet}`);
        console.log(`  Quality Score    : ${l.qualityScore}`);
        console.log(`  Raw Metrics:`);
        console.log(`    medianPositionPnlPct : ${l.raw.medianPositionPnlPct}%`);
        console.log(`    profitFactor         : ${l.raw.profitFactor}`);
        console.log(`    positionWinRate      : ${l.raw.positionWinRate}%`);
        console.log(`    pnlConcentrationTop1 : ${l.raw.pnlConcentrationTop1}%`);
        console.log(`    totalPnl (context)   : $${l.raw.totalPnl}`);
        console.log(`    closedPositions (ctx): ${l.raw.closedPositionCount}`);
        console.log(`  Percentile Components:`);
        console.log(`    medianPnlPctPctile   : ${l.components.medianPositionPnlPctPercentile}`);
        console.log(`    profitFactorPctile   : ${l.components.profitFactorPercentile}`);
        console.log(`    winRatePctile        : ${l.components.positionWinRatePercentile}`);
        console.log(`    inverseConcPctile    : ${l.components.inverseConcentrationPercentile}\n`);
    }

    console.log("==================================================");
    console.log(`AUDIT VERDICT: ${report.status}`);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset file not found: ${cli.datasetPath}`);
    }

    if (!fs.existsSync(cli.scoresPath)) {
        console.log(`Quality scores artifact not found at: ${cli.scoresPath}`);
        console.log(`Auto-building from ${cli.datasetPath}...`);
        const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
        const generated = buildQualityScores(datasetRaw);
        const dir = path.dirname(cli.scoresPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cli.scoresPath, JSON.stringify(generated, null, 2), "utf8");
        console.log(`Generated ${cli.scoresPath} successfully.\n`);
    }

    const scoresRaw = JSON.parse(fs.readFileSync(cli.scoresPath, "utf8"));
    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));

    const report = auditQualityScores(scoresRaw, datasetRaw, cli.scoresPath, cli.datasetPath);

    const outDir = path.dirname(cli.outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(cli.outputPath, JSON.stringify(report, null, 2), "utf8");

    printAuditReport(report);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-quality-scores.ts") ||
        process.argv[1].endsWith("audit-wallet-quality-scores.js") ||
        process.argv[1].includes("audit-wallet-quality-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Quality scores audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
