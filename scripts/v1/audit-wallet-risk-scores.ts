import fs from "node:fs";
import path from "node:path";
import { buildRiskScores, RISK_FORMULA_WEIGHTS } from "./build-wallet-risk-scores.ts";

interface CliOptions {
    scoresPath: string;
    riskMetricsPath: string;
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

interface RiskExample {
    rank: number;
    wallet: string;
    riskScore: number;
    raw: {
        cvar10PositionPnlPct: number;
        negativeDayRate: number;
        medianLosingPositionPnlPct: number;
    };
    components: {
        cvar10RiskPercentile: number;
        negativeDayRateRiskPercentile: number;
        medianLosingPnlRiskPercentile: number;
    };
}

export interface V1RiskScoreAuditReport {
    generatedAt: string;
    scoresPath: string;
    riskMetricsPath: string;
    status: "PASS" | "FAIL";
    populationAudit: {
        inputWalletCount: number;
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
        highest: RiskExample | null;
        lowest: RiskExample | null;
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let scoresPath = path.resolve("data/v1/wallet-risk-scores.json");
    let riskMetricsPath = path.resolve("data/v1/wallet-risk-metrics.json");
    let outputPath = path.resolve("data/v1/wallet-risk-scores-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--scores" && args[i + 1]) {
            scoresPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--scores=")) {
            scoresPath = path.resolve(arg.slice(9));
        } else if ((arg === "--risk" || arg === "--metrics" || arg === "--input") && args[i + 1]) {
            riskMetricsPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--risk=") || arg.startsWith("--metrics=") || arg.startsWith("--input=")) {
            riskMetricsPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    if (!fs.existsSync(riskMetricsPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-risk-metrics.json");
        if (fs.existsSync(alt)) riskMetricsPath = alt;
    }

    return { scoresPath, riskMetricsPath, outputPath };
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

export function auditRiskScores(
    scoresData: any,
    riskMetricsData: any,
    scoresPath: string,
    riskMetricsPath: string
): V1RiskScoreAuditReport {
    const violations: string[] = [];

    // 1. Input population
    const inputWallets: any[] = Array.isArray(riskMetricsData?.wallets) ? riskMetricsData.wallets : [];
    const inputWalletSet = new Set<string>(inputWallets.map((w) => String(w.wallet).trim()));

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
    for (const w of inputWalletSet) {
        if (!scoredWalletMap.has(w)) {
            missingWallets.push(w);
            violations.push(`Input wallet missing from risk scores: ${w}`);
        }
    }

    const extraWallets: string[] = [];
    for (const [w] of scoredWalletMap.entries()) {
        if (!inputWalletSet.has(w)) {
            extraWallets.push(w);
            violations.push(`Extra wallet in risk scores not present in input metrics: ${w}`);
        }
    }

    const duplicateWallets: string[] = [];
    for (const [w, count] of scoredWalletMap.entries()) {
        if (count > 1) {
            duplicateWallets.push(w);
            violations.push(`Duplicate wallet in risk scores: ${w} (${count} occurrences)`);
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
        const rScore = sw.riskScore;

        if (typeof rScore !== "number" || !Number.isFinite(rScore) || Number.isNaN(rScore)) {
            nanOrInfinityCount++;
            violations.push(`Wallet ${w} has non-finite riskScore: ${rScore}`);
            continue;
        }

        scoresList.push(rScore);

        if (rScore < 0 || rScore > 100) {
            scoreBoundsViolationsCount++;
            violations.push(`Wallet ${w} riskScore out of bounds [0, 100]: ${rScore}`);
        }

        const comp = sw.components;
        if (!comp) {
            violations.push(`Wallet ${w} missing components object`);
            continue;
        }

        const componentFields = [
            "cvar10RiskPercentile",
            "negativeDayRateRiskPercentile",
            "medianLosingPnlRiskPercentile",
        ];

        for (const cf of componentFields) {
            const val = comp[cf];
            if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
                nanOrInfinityCount++;
                violations.push(`Wallet ${w} component ${cf} is non-finite: ${val}`);
            } else if (val < 0 || val > 100) {
                componentBoundsViolationsCount++;
                violations.push(`Wallet ${w} component ${cf} out of bounds [0, 100]: ${val}`);
            }
        }

        const raw = sw.raw;
        if (!raw) {
            violations.push(`Wallet ${w} missing raw object`);
            continue;
        }

        const rawFields = [
            "cvar10PositionPnlPct",
            "negativeDayRate",
            "medianLosingPositionPnlPct",
        ];

        for (const rf of rawFields) {
            const val = raw[rf];
            if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
                nanOrInfinityCount++;
                violations.push(`Wallet ${w} raw ${rf} is non-finite: ${val}`);
            }
        }

        // Formula recomputation check
        const expectedScore = Number(
            (
                comp.cvar10RiskPercentile * RISK_FORMULA_WEIGHTS.cvar10PositionPnlPct +
                comp.negativeDayRateRiskPercentile * RISK_FORMULA_WEIGHTS.negativeDayRate +
                comp.medianLosingPnlRiskPercentile * RISK_FORMULA_WEIGHTS.medianLosingPositionPnlPct
            ).toFixed(2)
        );

        if (Math.abs(rScore - expectedScore) > 0.015) {
            formulaMismatchCount++;
            violations.push(
                `Wallet ${w} formula mismatch: reported ${rScore} vs recomputed ${expectedScore}`
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
    let highest: RiskExample | null = null;
    let lowest: RiskExample | null = null;

    if (scoredWallets.length > 0) {
        // Find wallet with max and min riskScore
        let maxWallet = scoredWallets[0];
        let minWallet = scoredWallets[0];

        for (const sw of scoredWallets) {
            if (sw.riskScore > maxWallet.riskScore) {
                maxWallet = sw;
            }
            if (sw.riskScore < minWallet.riskScore) {
                minWallet = sw;
            }
        }

        highest = {
            rank: 1,
            wallet: maxWallet.wallet,
            riskScore: maxWallet.riskScore,
            raw: {
                cvar10PositionPnlPct: maxWallet.raw.cvar10PositionPnlPct,
                negativeDayRate: maxWallet.raw.negativeDayRate,
                medianLosingPositionPnlPct: maxWallet.raw.medianLosingPositionPnlPct,
            },
            components: {
                cvar10RiskPercentile: maxWallet.components.cvar10RiskPercentile,
                negativeDayRateRiskPercentile: maxWallet.components.negativeDayRateRiskPercentile,
                medianLosingPnlRiskPercentile: maxWallet.components.medianLosingPnlRiskPercentile,
            },
        };

        lowest = {
            rank: count,
            wallet: minWallet.wallet,
            riskScore: minWallet.riskScore,
            raw: {
                cvar10PositionPnlPct: minWallet.raw.cvar10PositionPnlPct,
                negativeDayRate: minWallet.raw.negativeDayRate,
                medianLosingPositionPnlPct: minWallet.raw.medianLosingPositionPnlPct,
            },
            components: {
                cvar10RiskPercentile: minWallet.components.cvar10RiskPercentile,
                negativeDayRateRiskPercentile: minWallet.components.negativeDayRateRiskPercentile,
                medianLosingPnlRiskPercentile: minWallet.components.medianLosingPnlRiskPercentile,
            },
        };
    }

    const status: "PASS" | "FAIL" =
        missingWallets.length === 0 &&
        extraWallets.length === 0 &&
        duplicateWallets.length === 0 &&
        nanOrInfinityCount === 0 &&
        componentBoundsViolationsCount === 0 &&
        scoreBoundsViolationsCount === 0 &&
        formulaMismatchCount === 0 &&
        count > 0
            ? "PASS"
            : "FAIL";

    return {
        generatedAt: new Date().toISOString(),
        scoresPath,
        riskMetricsPath,
        status,
        populationAudit: {
            inputWalletCount: inputWallets.length,
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
            violations,
        },
        distribution,
        examples: {
            highest,
            lowest,
        },
    };
}

function printAuditReport(report: V1RiskScoreAuditReport): void {
    console.log("==================================================");
    console.log("V1 — WALLET RISK SCORE AUDIT");
    console.log("==================================================");
    console.log(`Input Risk Metrics  : ${report.riskMetricsPath}`);
    console.log(`Output Risk Scores  : ${report.scoresPath}\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Input Wallets (Metrics) : ${report.populationAudit.inputWalletCount}`);
    console.log(`Output Wallets (Scores) : ${report.populationAudit.outputWalletCount}`);
    console.log(`Missing Wallets         : ${report.populationAudit.missingWalletsCount}`);
    console.log(`Extra Wallets           : ${report.populationAudit.extraWalletsCount}`);
    console.log(`Duplicate Wallets       : ${report.populationAudit.duplicateWalletsCount}\n`);

    console.log("2. NUMERICAL & BOUNDS INTEGRITY");
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

    console.log(`3. RISK SCORE DISTRIBUTION (N=${report.distribution.count})`);
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
        console.log(`HIGHEST RISK SCORE (Rank 1):`);
        console.log(`  Wallet           : ${h.wallet}`);
        console.log(`  Risk Score       : ${h.riskScore}`);
        console.log(`  Raw Metrics:`);
        console.log(`    cvar10PositionPnlPct       : ${h.raw.cvar10PositionPnlPct}%`);
        console.log(`    negativeDayRate            : ${h.raw.negativeDayRate}%`);
        console.log(`    medianLosingPositionPnlPct : ${h.raw.medianLosingPositionPnlPct}%`);
        console.log(`  Component Risk Percentiles:`);
        console.log(`    cvar10RiskPercentile          : ${h.components.cvar10RiskPercentile}`);
        console.log(`    negativeDayRateRiskPercentile : ${h.components.negativeDayRateRiskPercentile}`);
        console.log(`    medianLosingPnlRiskPercentile : ${h.components.medianLosingPnlRiskPercentile}\n`);
    }

    if (report.examples.lowest) {
        const l = report.examples.lowest;
        console.log(`LOWEST RISK SCORE (Rank ${report.populationAudit.outputWalletCount}):`);
        console.log(`  Wallet           : ${l.wallet}`);
        console.log(`  Risk Score       : ${l.riskScore}`);
        console.log(`  Raw Metrics:`);
        console.log(`    cvar10PositionPnlPct       : ${l.raw.cvar10PositionPnlPct}%`);
        console.log(`    negativeDayRate            : ${l.raw.negativeDayRate}%`);
        console.log(`    medianLosingPositionPnlPct : ${l.raw.medianLosingPositionPnlPct}%`);
        console.log(`  Component Risk Percentiles:`);
        console.log(`    cvar10RiskPercentile          : ${l.components.cvar10RiskPercentile}`);
        console.log(`    negativeDayRateRiskPercentile : ${l.components.negativeDayRateRiskPercentile}`);
        console.log(`    medianLosingPnlRiskPercentile : ${l.components.medianLosingPnlRiskPercentile}\n`);
    }

    console.log("==================================================");
    console.log(`AUDIT VERDICT: ${report.status}`);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.riskMetricsPath)) {
        throw new Error(`Risk metrics file not found: ${cli.riskMetricsPath}`);
    }

    if (!fs.existsSync(cli.scoresPath)) {
        console.log(`Risk scores artifact not found at: ${cli.scoresPath}`);
        console.log(`Auto-building from ${cli.riskMetricsPath}...`);
        const riskMetricsRaw = JSON.parse(fs.readFileSync(cli.riskMetricsPath, "utf8"));
        const generated = buildRiskScores(riskMetricsRaw);
        atomicWriteJson(cli.scoresPath, generated);
        console.log(`Generated ${cli.scoresPath} successfully.\n`);
    }

    const scoresRaw = JSON.parse(fs.readFileSync(cli.scoresPath, "utf8"));
    const riskMetricsRaw = JSON.parse(fs.readFileSync(cli.riskMetricsPath, "utf8"));

    const report = auditRiskScores(scoresRaw, riskMetricsRaw, cli.scoresPath, cli.riskMetricsPath);

    atomicWriteJson(cli.outputPath, report);

    printAuditReport(report);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-risk-scores.ts") ||
        process.argv[1].endsWith("audit-wallet-risk-scores.js") ||
        process.argv[1].includes("audit-wallet-risk-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Risk scores audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
