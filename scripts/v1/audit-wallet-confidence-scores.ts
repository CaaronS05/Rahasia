import fs from "node:fs";
import path from "node:path";
import { buildConfidenceScores, CONFIDENCE_FORMULA } from "./build-wallet-confidence-scores.ts";

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

interface ConfidenceExample {
    rank: number;
    wallet: string;
    confidenceScore: number;
    closedPositionCount: number;
    historySpanDays: number;
    positionSampleScore: number;
    historySpanScore: number;
    earliestRelevantTimestamp: string | null;
    latestRelevantTimestamp: string | null;
}

interface SampleSizeCheckpoint {
    n: number;
    expectedScore: number;
}

export interface V1ConfidenceScoreAuditReport {
    generatedAt: string;
    scoresPath: string;
    datasetPath: string;
    status: "PASS" | "FAIL";
    populationAudit: {
        sourceValidWalletCount: number;
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
        invalidTimestampCount: number;
        negativeHistorySpanCount: number;
        historySpanExceedsWindowCount: number;
        componentBoundsViolationsCount: number;
        scoreBoundsViolationsCount: number;
        formulaMismatchCount: number;
        violations: string[];
    };
    distribution: DistributionStats;
    examples: {
        highest: ConfidenceExample | null;
        lowest: ConfidenceExample | null;
    };
    sampleSizeCheckpoints: SampleSizeCheckpoint[];
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let scoresPath = path.resolve("data/v1/wallet-confidence-scores.json");
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-confidence-scores-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--scores" && args[i + 1]) {
            scoresPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--scores=")) {
            scoresPath = path.resolve(arg.slice(9));
        } else if ((arg === "--dataset" || arg === "--input") && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=") || arg.startsWith("--input=")) {
            datasetPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(args[i + 1]);
        }
    }

    if (!fs.existsSync(datasetPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-screening-dataset.json");
        if (fs.existsSync(alt)) datasetPath = alt;
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

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

export function auditConfidenceScores(
    scoresData: any,
    datasetData: any,
    scoresPath: string,
    datasetPath: string
): V1ConfidenceScoreAuditReport {
    const violations: string[] = [];

    // 1. Source valid wallets
    const datasetWallets: any[] = Array.isArray(datasetData?.wallets) ? datasetData.wallets : [];
    const validDatasetWallets = datasetWallets.filter((w) => w?.valid === true);
    const validWalletSet = new Set<string>(validDatasetWallets.map((w) => String(w.wallet).trim()));

    // 2. Output scored wallets
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
            violations.push(`Valid wallet missing from confidence scores: ${w}`);
        }
    }

    const extraWallets: string[] = [];
    for (const [w] of scoredWalletMap.entries()) {
        if (!validWalletSet.has(w)) {
            extraWallets.push(w);
            violations.push(`Extra wallet in confidence scores not present in valid dataset: ${w}`);
        }
    }

    const duplicateWallets: string[] = [];
    for (const [w, count] of scoredWalletMap.entries()) {
        if (count > 1) {
            duplicateWallets.push(w);
            violations.push(`Duplicate wallet in confidence scores: ${w} (${count} occurrences)`);
        }
    }

    // 3. Numerical & bounds integrity
    let nanOrInfinityCount = 0;
    let invalidTimestampCount = 0;
    let negativeHistorySpanCount = 0;
    let historySpanExceedsWindowCount = 0;
    let componentBoundsViolationsCount = 0;
    let scoreBoundsViolationsCount = 0;
    let formulaMismatchCount = 0;

    const scoresList: number[] = [];

    for (const sw of scoredWallets) {
        const w = sw.wallet;
        const cScore = sw.confidenceScore;

        if (typeof cScore !== "number" || !Number.isFinite(cScore) || Number.isNaN(cScore)) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} has non-finite confidenceScore: ${cScore}`);
            continue;
        }

        scoresList.push(cScore);

        if (cScore < 0 || cScore > 100) {
            scoreBoundsViolationsCount++;
            violations.push(`Wallet ${w} confidenceScore out of bounds [0, 100]: ${cScore}`);
        }

        const comp = sw.components;
        if (!comp) {
            violations.push(`Wallet ${w} missing components object`);
            continue;
        }

        // Check component 1: positionSampleScore
        const sampleScore = comp.positionSampleScore;
        if (typeof sampleScore !== "number" || !Number.isFinite(sampleScore) || Number.isNaN(sampleScore)) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} positionSampleScore is non-finite: ${sampleScore}`);
        } else if (sampleScore < 0 || sampleScore > 100) {
            componentBoundsViolationsCount++;
            violations.push(`Wallet ${w} positionSampleScore out of bounds [0, 100]: ${sampleScore}`);
        }

        // Check component 2: historySpanScore
        const spanScore = comp.historySpanScore;
        if (typeof spanScore !== "number" || !Number.isFinite(spanScore) || Number.isNaN(spanScore)) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} historySpanScore is non-finite: ${spanScore}`);
        } else if (spanScore < 0 || spanScore > 100) {
            componentBoundsViolationsCount++;
            violations.push(`Wallet ${w} historySpanScore out of bounds [0, 100]: ${spanScore}`);
        }

        // Check raw metrics
        const raw = sw.raw;
        if (!raw) {
            violations.push(`Wallet ${w} missing raw object`);
            continue;
        }

        if (typeof raw.closedPositionCount !== "number" || !Number.isFinite(raw.closedPositionCount) || raw.closedPositionCount < 0) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} invalid closedPositionCount: ${raw.closedPositionCount}`);
        }

        if (typeof raw.historySpanDays !== "number" || !Number.isFinite(raw.historySpanDays) || Number.isNaN(raw.historySpanDays)) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} historySpanDays is non-finite: ${raw.historySpanDays}`);
        } else {
            if (raw.historySpanDays < 0) {
                negativeHistorySpanCount++;
                violations.push(`Wallet ${w} has negative historySpanDays: ${raw.historySpanDays}`);
            }
            if (raw.historySpanDays > CONFIDENCE_FORMULA.historyWindowDays + 1e-4) {
                historySpanExceedsWindowCount++;
                violations.push(`Wallet ${w} historySpanDays exceeds 30-day window: ${raw.historySpanDays}`);
            }
        }

        // Check timestamps format
        if (raw.earliestRelevantTimestamp !== null) {
            const parsed = Date.parse(raw.earliestRelevantTimestamp);
            if (!Number.isFinite(parsed)) {
                invalidTimestampCount++;
                violations.push(`Wallet ${w} has invalid earliestRelevantTimestamp: ${raw.earliestRelevantTimestamp}`);
            }
        }

        if (raw.latestRelevantTimestamp !== null) {
            const parsed = Date.parse(raw.latestRelevantTimestamp);
            if (!Number.isFinite(parsed)) {
                invalidTimestampCount++;
                violations.push(`Wallet ${w} has invalid latestRelevantTimestamp: ${raw.latestRelevantTimestamp}`);
            }
        }

        // Formula recomputation check
        const expectedScore = Number(
            (
                sampleScore * CONFIDENCE_FORMULA.positionSampleScore +
                spanScore * CONFIDENCE_FORMULA.historySpanScore
            ).toFixed(2)
        );

        if (Math.abs(cScore - expectedScore) > 0.015) {
            formulaMismatchCount++;
            violations.push(
                `Wallet ${w} formula mismatch: reported ${cScore} vs recomputed ${expectedScore}`
            );
        }
    }

    // 4. Distribution stats
    scoresList.sort((a, b) => a - b);
    const count = scoresList.length;
    const distribution: DistributionStats = {
        count,
        min: count > 0 ? Number(scoresList[0].toFixed(2)) : 0,
        p10: count > 0 ? Number(computePercentile(scoresList, 10).toFixed(2)) : 0,
        p25: count > 0 ? Number(computePercentile(scoresList, 25).toFixed(2)) : 0,
        median: count > 0 ? Number(computePercentile(scoresList, 50).toFixed(2)) : 0,
        p75: count > 0 ? Number(computePercentile(scoresList, 75).toFixed(2)) : 0,
        p90: count > 0 ? Number(computePercentile(scoresList, 90).toFixed(2)) : 0,
        max: count > 0 ? Number(scoresList[count - 1].toFixed(2)) : 0,
    };

    // 5. Extremes inspection
    let highest: ConfidenceExample | null = null;
    let lowest: ConfidenceExample | null = null;

    if (scoredWallets.length > 0) {
        let maxWallet = scoredWallets[0];
        let minWallet = scoredWallets[0];

        for (const sw of scoredWallets) {
            if (sw.confidenceScore > maxWallet.confidenceScore) {
                maxWallet = sw;
            }
            if (sw.confidenceScore < minWallet.confidenceScore) {
                minWallet = sw;
            }
        }

        highest = {
            rank: 1,
            wallet: maxWallet.wallet,
            confidenceScore: maxWallet.confidenceScore,
            closedPositionCount: maxWallet.raw.closedPositionCount,
            historySpanDays: maxWallet.raw.historySpanDays,
            positionSampleScore: maxWallet.components.positionSampleScore,
            historySpanScore: maxWallet.components.historySpanScore,
            earliestRelevantTimestamp: maxWallet.raw.earliestRelevantTimestamp,
            latestRelevantTimestamp: maxWallet.raw.latestRelevantTimestamp,
        };

        lowest = {
            rank: count,
            wallet: minWallet.wallet,
            confidenceScore: minWallet.confidenceScore,
            closedPositionCount: minWallet.raw.closedPositionCount,
            historySpanDays: minWallet.raw.historySpanDays,
            positionSampleScore: minWallet.components.positionSampleScore,
            historySpanScore: minWallet.components.historySpanScore,
            earliestRelevantTimestamp: minWallet.raw.earliestRelevantTimestamp,
            latestRelevantTimestamp: minWallet.raw.latestRelevantTimestamp,
        };
    }

    // 6. Sample size checkpoints
    const checkpointNs = [2, 10, 50, 100, 150, 200];
    const sampleSizeCheckpoints: SampleSizeCheckpoint[] = checkpointNs.map((n) => ({
        n,
        expectedScore: Number((Math.min(100, Math.sqrt(n / 200) * 100)).toFixed(2)),
    }));

    const status: "PASS" | "FAIL" =
        missingWallets.length === 0 &&
        extraWallets.length === 0 &&
        duplicateWallets.length === 0 &&
        nanOrInfinityCount === 0 &&
        invalidTimestampCount === 0 &&
        negativeHistorySpanCount === 0 &&
        historySpanExceedsWindowCount === 0 &&
        componentBoundsViolationsCount === 0 &&
        scoreBoundsViolationsCount === 0 &&
        formulaMismatchCount === 0 &&
        count > 0
            ? "PASS"
            : "FAIL";

    return {
        generatedAt: new Date().toISOString(),
        scoresPath,
        datasetPath,
        status,
        populationAudit: {
            sourceValidWalletCount: validDatasetWallets.length,
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
            invalidTimestampCount,
            negativeHistorySpanCount,
            historySpanExceedsWindowCount,
            componentBoundsViolationsCount,
            scoreBoundsViolationsCount,
            formulaMismatchCount,
            violations,
        },
        distribution,
        examples: {
            highest,
            lowest,
        },
        sampleSizeCheckpoints,
    };
}

function printAuditReport(report: V1ConfidenceScoreAuditReport): void {
    console.log("==================================================");
    console.log("V1 — WALLET CONFIDENCE SCORE AUDIT");
    console.log("==================================================");
    console.log(`Input Screening Dataset : ${report.datasetPath}`);
    console.log(`Output Confidence Scores: ${report.scoresPath}\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Source Valid Wallets  : ${report.populationAudit.sourceValidWalletCount}`);
    console.log(`Output Wallets (Scores): ${report.populationAudit.outputWalletCount}`);
    console.log(`Missing Wallets       : ${report.populationAudit.missingWalletsCount}`);
    console.log(`Extra Wallets         : ${report.populationAudit.extraWalletsCount}`);
    console.log(`Duplicate Wallets     : ${report.populationAudit.duplicateWalletsCount}\n`);

    console.log("2. NUMERICAL & BOUNDS INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`NaN / Infinity Violations : ${report.integrityAudit.nanOrInfinityCount}`);
    console.log(`Invalid Timestamps        : ${report.integrityAudit.invalidTimestampCount}`);
    console.log(`Negative History Spans    : ${report.integrityAudit.negativeHistorySpanCount}`);
    console.log(`History Span > 30 Days    : ${report.integrityAudit.historySpanExceedsWindowCount}`);
    console.log(`Component Bounds [0-100]  : ${report.integrityAudit.componentBoundsViolationsCount}`);
    console.log(`Score Bounds [0-100]      : ${report.integrityAudit.scoreBoundsViolationsCount}`);
    console.log(`Formula Mismatches        : ${report.integrityAudit.formulaMismatchCount}`);
    if (report.integrityAudit.violations.length > 0) {
        console.log("\nSample Violations:");
        for (const v of report.integrityAudit.violations.slice(0, 10)) {
            console.log(`  - ${v}`);
        }
    } else {
        console.log("  All components and final scores satisfy mathematical constraints.\n");
    }

    console.log(`3. CONFIDENCE SCORE DISTRIBUTION (N=${report.distribution.count})`);
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
        console.log(`HIGHEST CONFIDENCE SCORE (Rank 1):`);
        console.log(`  Wallet              : ${h.wallet}`);
        console.log(`  Confidence Score    : ${h.confidenceScore}`);
        console.log(`  closedPositionCount : ${h.closedPositionCount}`);
        console.log(`  historySpanDays     : ${h.historySpanDays} days`);
        console.log(`  positionSampleScore : ${h.positionSampleScore}`);
        console.log(`  historySpanScore    : ${h.historySpanScore}\n`);
    }

    if (report.examples.lowest) {
        const l = report.examples.lowest;
        console.log(`LOWEST CONFIDENCE SCORE (Rank ${report.populationAudit.outputWalletCount}):`);
        console.log(`  Wallet              : ${l.wallet}`);
        console.log(`  Confidence Score    : ${l.confidenceScore}`);
        console.log(`  closedPositionCount : ${l.closedPositionCount}`);
        console.log(`  historySpanDays     : ${l.historySpanDays} days`);
        console.log(`  positionSampleScore : ${l.positionSampleScore}`);
        console.log(`  historySpanScore    : ${l.historySpanScore}\n`);
    }

    console.log("5. SAMPLE SIZE FORMULA CHECKPOINTS");
    console.log("--------------------------------------------------");
    for (const cp of report.sampleSizeCheckpoints) {
        console.log(`  n = ${String(cp.n).padStart(3)} positions -> positionSampleScore = ${cp.expectedScore.toFixed(2)}`);
    }
    console.log("");

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
        console.log(`Confidence scores artifact not found at: ${cli.scoresPath}`);
        console.log(`Auto-building from ${cli.datasetPath}...`);
        const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
        const generated = buildConfidenceScores(datasetRaw);
        atomicWriteJson(cli.scoresPath, generated);
        console.log(`Generated ${cli.scoresPath} successfully.\n`);
    }

    const scoresRaw = JSON.parse(fs.readFileSync(cli.scoresPath, "utf8"));
    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));

    const report = auditConfidenceScores(scoresRaw, datasetRaw, cli.scoresPath, cli.datasetPath);

    atomicWriteJson(cli.outputPath, report);

    printAuditReport(report);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-confidence-scores.ts") ||
        process.argv[1].endsWith("audit-wallet-confidence-scores.js") ||
        process.argv[1].includes("audit-wallet-confidence-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Confidence scores audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
