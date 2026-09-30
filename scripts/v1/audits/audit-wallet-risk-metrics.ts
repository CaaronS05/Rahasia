import fs from "node:fs";
import path from "node:path";
import { buildRiskMetrics } from "../build-wallet-risk-metrics.ts";

interface CliOptions {
    riskPath: string;
    datasetPath: string;
    outputPath: string;
}

interface DistributionStats {
    metric: string;
    count: number;
    min: number;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
}

export interface V1RiskAuditReport {
    generatedAt: string;
    riskPath: string;
    datasetPath: string;
    status: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
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
        rateBoundsViolationsCount: number;
        cvarSanityViolationsCount: number;
        chronologyViolationsCount: number;
        drawdownSanityViolationsCount: number;
        violations: string[];
    };
    distributions: DistributionStats[];
    scoringReadiness: {
        verdict: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
        recommendedScoreCandidates: Array<{
            metric: string;
            scope: "POSITION" | "DAILY";
            type: "RATE" | "PERCENTAGE";
            rationale: string;
        }>;
        excludedOrContextualMetrics: Array<{
            metric: string;
            scope: "POSITION" | "DAILY" | "CONTEXT";
            reason: string;
        }>;
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let riskPath = path.resolve("data/v1/wallet-risk-metrics.json");
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-risk-metrics-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--risk" && args[i + 1]) {
            riskPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--risk=")) {
            riskPath = path.resolve(arg.slice(7));
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

    return { riskPath, datasetPath, outputPath };
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

function calculateDistribution(metricName: string, rawValues: Array<number | null | undefined>): DistributionStats | null {
    const valid = rawValues.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (valid.length === 0) return null;
    const sorted = [...valid].sort((a, b) => a - b);
    return {
        metric: metricName,
        count: sorted.length,
        min: sorted[0],
        p10: computePercentile(sorted, 10),
        p25: computePercentile(sorted, 25),
        median: computePercentile(sorted, 50),
        p75: computePercentile(sorted, 75),
        p90: computePercentile(sorted, 90),
        max: sorted[sorted.length - 1],
    };
}

export function auditRiskMetrics(riskData: any, datasetData: any, riskPath: string, datasetPath: string): V1RiskAuditReport {
    const violations: string[] = [];

    // 1. Population check
    const datasetWallets: any[] = Array.isArray(datasetData?.wallets) ? datasetData.wallets : [];
    const validDatasetWallets = datasetWallets.filter((w) => w?.valid === true);
    const validWalletSet = new Set<string>(validDatasetWallets.map((w) => String(w.wallet).trim()));

    const riskWallets: any[] = Array.isArray(riskData?.wallets) ? riskData.wallets : [];
    const riskWalletMap = new Map<string, number>();

    for (const rw of riskWallets) {
        const addr = String(rw.wallet || "").trim();
        if (addr) {
            riskWalletMap.set(addr, (riskWalletMap.get(addr) ?? 0) + 1);
        }
    }

    const missingWallets: string[] = [];
    for (const w of validWalletSet) {
        if (!riskWalletMap.has(w)) {
            missingWallets.push(w);
            violations.push(`Valid wallet missing from risk metrics: ${w}`);
        }
    }

    const extraWallets: string[] = [];
    for (const [w] of riskWalletMap.entries()) {
        if (!validWalletSet.has(w)) {
            extraWallets.push(w);
            violations.push(`Extra wallet in risk metrics not in valid dataset: ${w}`);
        }
    }

    const duplicateWallets: string[] = [];
    for (const [w, count] of riskWalletMap.entries()) {
        if (count > 1) {
            duplicateWallets.push(w);
            violations.push(`Duplicate wallet in risk metrics: ${w} (${count} occurrences)`);
        }
    }

    // 2. Numerical & Integrity audit
    let nanOrInfinityCount = 0;
    let rateBoundsViolationsCount = 0;
    let cvarSanityViolationsCount = 0;
    let chronologyViolationsCount = 0;
    let drawdownSanityViolationsCount = 0;

    for (const rw of riskWallets) {
        const w = rw.wallet;
        const posRisk = rw.positionRisk;
        const dailyRisk = rw.dailyRisk;

        if (!posRisk || !dailyRisk) {
            violations.push(`Wallet ${w} missing positionRisk or dailyRisk`);
            continue;
        }

        // Check NaN/Infinity in positionRisk
        for (const [k, v] of Object.entries(posRisk)) {
            if (v !== null && typeof v === "number" && (!Number.isFinite(v) || Number.isNaN(v))) {
                nanOrInfinityCount++;
                violations.push(`Wallet ${w} positionRisk.${k} is non-finite: ${v}`);
            }
        }

        // Check NaN/Infinity in dailyRisk
        for (const [k, v] of Object.entries(dailyRisk)) {
            if (v !== null && typeof v === "number" && (!Number.isFinite(v) || Number.isNaN(v))) {
                nanOrInfinityCount++;
                violations.push(`Wallet ${w} dailyRisk.${k} is non-finite: ${v}`);
            }
        }

        // Rate bounds [0, 100]
        if (posRisk.lossPositionRate < 0 || posRisk.lossPositionRate > 100) {
            rateBoundsViolationsCount++;
            violations.push(`Wallet ${w} lossPositionRate out of [0, 100]: ${posRisk.lossPositionRate}%`);
        }
        if (dailyRisk.negativeDayRate < 0 || dailyRisk.negativeDayRate > 100) {
            rateBoundsViolationsCount++;
            violations.push(`Wallet ${w} negativeDayRate out of [0, 100]: ${dailyRisk.negativeDayRate}%`);
        }
        if (dailyRisk.positiveDayRate < 0 || dailyRisk.positiveDayRate > 100) {
            rateBoundsViolationsCount++;
            violations.push(`Wallet ${w} positiveDayRate out of [0, 100]: ${dailyRisk.positiveDayRate}%`);
        }

        // CVaR sanity: cvar10 <= p10 (within floating point precision 1e-4)
        if (posRisk.cvar10PositionPnlPct > posRisk.p10PositionPnlPct + 1e-4) {
            cvarSanityViolationsCount++;
            violations.push(
                `Wallet ${w} CVaR10 (${posRisk.cvar10PositionPnlPct}%) is greater than P10 (${posRisk.p10PositionPnlPct}%)`
            );
        }

        if (posRisk.worstPositionPnlPct > posRisk.p10PositionPnlPct + 1e-4) {
            cvarSanityViolationsCount++;
            violations.push(
                `Wallet ${w} worst position (${posRisk.worstPositionPnlPct}%) is greater than P10 (${posRisk.p10PositionPnlPct}%)`
            );
        }

        // Drawdown sanity: maxCumulativePnlDrawdownUsd must be <= 0
        if (dailyRisk.maxCumulativePnlDrawdownUsd > 1e-6) {
            drawdownSanityViolationsCount++;
            violations.push(
                `Wallet ${w} maxCumulativePnlDrawdownUsd is positive: ${dailyRisk.maxCumulativePnlDrawdownUsd}`
            );
        }

        // Chronology check in source dataset for this wallet
        const matchingDatasetWallet = validDatasetWallets.find((dw) => dw.wallet === w);
        if (matchingDatasetWallet && Array.isArray(matchingDatasetWallet.daily)) {
            const dailyArr = matchingDatasetWallet.daily;
            for (let idx = 1; idx < dailyArr.length; idx++) {
                if (String(dailyArr[idx].date || "") < String(dailyArr[idx - 1].date || "")) {
                    chronologyViolationsCount++;
                    violations.push(`Wallet ${w} daily dates not chronological at index ${idx}`);
                    break;
                }
            }
        }
    }

    // 3. Distributions
    const distConfigs: Array<{ name: string; extractor: (rw: any) => number | null | undefined }> = [
        { name: "worstPositionPnlPct", extractor: (rw) => rw.positionRisk.worstPositionPnlPct },
        { name: "p10PositionPnlPct", extractor: (rw) => rw.positionRisk.p10PositionPnlPct },
        { name: "cvar10PositionPnlPct", extractor: (rw) => rw.positionRisk.cvar10PositionPnlPct },
        { name: "downsideDeviationPositionPct", extractor: (rw) => rw.positionRisk.downsideDeviationPositionPct },
        { name: "positionPnlPctStdDev", extractor: (rw) => rw.positionRisk.positionPnlPctStdDev },
        { name: "medianLosingPositionPnlPct", extractor: (rw) => rw.positionRisk.medianLosingPositionPnlPct },
        { name: "lossPositionRate", extractor: (rw) => rw.positionRisk.lossPositionRate },
        { name: "worstDayPnlUsd", extractor: (rw) => rw.dailyRisk.worstDayPnlUsd },
        { name: "dailyPnlStdDevUsd", extractor: (rw) => rw.dailyRisk.dailyPnlStdDevUsd },
        { name: "negativeDayRate", extractor: (rw) => rw.dailyRisk.negativeDayRate },
        { name: "maxCumulativePnlDrawdownUsd", extractor: (rw) => rw.dailyRisk.maxCumulativePnlDrawdownUsd },
    ];

    const distributions: DistributionStats[] = [];
    for (const dc of distConfigs) {
        const values = riskWallets.map(dc.extractor);
        const dist = calculateDistribution(dc.name, values);
        if (dist) distributions.push(dist);
    }

    // 4. Overall status
    let status: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
    if (
        missingWallets.length > 0 ||
        duplicateWallets.length > 0 ||
        nanOrInfinityCount > 0 ||
        rateBoundsViolationsCount > 0 ||
        cvarSanityViolationsCount > 0 ||
        drawdownSanityViolationsCount > 0
    ) {
        status = "NOT_READY";
    } else if (violations.length > 0) {
        status = "READY_WITH_LIMITATIONS";
    } else {
        status = "READY";
    }

    return {
        generatedAt: new Date().toISOString(),
        riskPath,
        datasetPath,
        status,
        populationAudit: {
            inputValidWalletCount: validWalletSet.size,
            outputWalletCount: riskWallets.length,
            missingWalletsCount: missingWallets.length,
            missingWallets,
            extraWalletsCount: extraWallets.length,
            extraWallets,
            duplicateWalletsCount: duplicateWallets.length,
            duplicateWallets,
        },
        integrityAudit: {
            nanOrInfinityCount,
            rateBoundsViolationsCount,
            cvarSanityViolationsCount,
            chronologyViolationsCount,
            drawdownSanityViolationsCount,
            violations: violations.slice(0, 50),
        },
        distributions,
        scoringReadiness: {
            verdict: status,
            recommendedScoreCandidates: [
                {
                    metric: "downsideDeviationPositionPct",
                    scope: "POSITION",
                    type: "PERCENTAGE",
                    rationale: "Scale-free measure of negative PnL dispersion; penalizes large downside volatility directly.",
                },
                {
                    metric: "lossPositionRate",
                    scope: "POSITION",
                    type: "RATE",
                    rationale: "Percentage of losing positions; direct counterpart to position win rate.",
                },
                {
                    metric: "cvar10PositionPnlPct",
                    scope: "POSITION",
                    type: "PERCENTAGE",
                    rationale: "Measures severity of the worst 10% tail outcomes; highlights catastrophic loss potential.",
                },
                {
                    metric: "p10PositionPnlPct",
                    scope: "POSITION",
                    type: "PERCENTAGE",
                    rationale: "10th percentile loss boundary; robust value-at-risk estimate across cohort.",
                },
                {
                    metric: "negativeDayRate",
                    scope: "DAILY",
                    type: "RATE",
                    rationale: "Frequency of negative PnL calendar days; scale-independent daily consistency check.",
                },
                {
                    metric: "medianLosingPositionPnlPct",
                    scope: "POSITION",
                    type: "PERCENTAGE",
                    rationale: "Typical loss magnitude when a position loses; independent of capital scale.",
                },
            ],
            excludedOrContextualMetrics: [
                {
                    metric: "worstDayPnlUsd",
                    scope: "DAILY",
                    reason: "Absolute USD metric; dominated by capital size ($1k vs $500k wallet) and not comparable across cohort.",
                },
                {
                    metric: "dailyPnlStdDevUsd",
                    scope: "DAILY",
                    reason: "Absolute USD volatility; naturally larger for larger capital pools without indicating higher risk.",
                },
                {
                    metric: "maxCumulativePnlDrawdownUsd",
                    scope: "DAILY",
                    reason: "Absolute USD drawdown; reflects portfolio magnitude rather than relative risk tolerance.",
                },
                {
                    metric: "worstDayPnlToDepositsPct / maxDrawdownToDepositsPct",
                    scope: "CONTEXT",
                    reason: "Capital-flow proxy diagnostics only; total deposits do not equal active equity, so this is not a true drawdown %.",
                },
            ],
        },
    };
}

function printAuditReport(report: V1RiskAuditReport): void {
    console.log("==================================================");
    console.log("V1 — WALLET RISK METRICS AUDIT REPORT");
    console.log("==================================================");
    console.log(`Generated At            : ${report.generatedAt}`);
    console.log(`Risk Metrics Path       : ${report.riskPath}`);
    console.log(`Source Dataset Path     : ${report.datasetPath}`);
    console.log(`Risk Score Readiness    : ${report.status}\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Input Valid Wallets     : ${report.populationAudit.inputValidWalletCount}`);
    console.log(`Output Scored Wallets   : ${report.populationAudit.outputWalletCount}`);
    console.log(`Missing Wallets         : ${report.populationAudit.missingWalletsCount}`);
    console.log(`Extra Wallets           : ${report.populationAudit.extraWalletsCount}`);
    console.log(`Duplicate Wallets       : ${report.populationAudit.duplicateWalletsCount}\n`);

    console.log("2. NUMERICAL & INTEGRITY AUDIT");
    console.log("--------------------------------------------------");
    console.log(`NaN / Infinity Violations: ${report.integrityAudit.nanOrInfinityCount}`);
    console.log(`Rate Bounds [0-100] Viol : ${report.integrityAudit.rateBoundsViolationsCount}`);
    console.log(`CVaR / Percentile Viol   : ${report.integrityAudit.cvarSanityViolationsCount}`);
    console.log(`Chronology Violations    : ${report.integrityAudit.chronologyViolationsCount}`);
    console.log(`Drawdown <= 0 Violations : ${report.integrityAudit.drawdownSanityViolationsCount}`);
    if (report.integrityAudit.violations.length > 0) {
        console.log("\nSample Violations:");
        for (const v of report.integrityAudit.violations.slice(0, 10)) {
            console.log(`  - ${v}`);
        }
    } else {
        console.log("  All position and daily risk metrics satisfy mathematical consistency constraints.\n");
    }

    console.log("3. RISK METRIC DISTRIBUTIONS (N=65)");
    console.log("--------------------------------------------------");
    console.log(
        "Metric".padEnd(30) +
        "Min".padStart(11) +
        "P10".padStart(11) +
        "P25".padStart(11) +
        "Median".padStart(11) +
        "P75".padStart(11) +
        "P90".padStart(11) +
        "Max".padStart(13)
    );
    console.log("-".repeat(109));
    for (const d of report.distributions) {
        console.log(
            d.metric.padEnd(30) +
            String(d.min).padStart(11) +
            String(d.p10).padStart(11) +
            String(d.p25).padStart(11) +
            String(d.median).padStart(11) +
            String(d.p75).padStart(11) +
            String(d.p90).padStart(11) +
            String(d.max).padStart(13)
        );
    }
    console.log("");

    console.log("4. FUTURE RISK SCORE CANDIDATE ANALYSIS");
    console.log("--------------------------------------------------");
    console.log("Recommended Cross-Wallet Risk Score Candidates (Scale-Free):");
    for (const c of report.scoringReadiness.recommendedScoreCandidates) {
        console.log(`  - ${c.metric} [${c.scope} | ${c.type}]`);
        console.log(`      ${c.rationale}`);
    }

    console.log("\nExcluded From Cross-Wallet Scoring (Capital-Scale Dependent / Diagnostics):");
    for (const ex of report.scoringReadiness.excludedOrContextualMetrics) {
        console.log(`  - ${ex.metric} [${ex.scope}]`);
        console.log(`      ${ex.reason}`);
    }

    console.log("\n==================================================");
    console.log(`AUDIT VERDICT: ${report.status}`);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset file not found: ${cli.datasetPath}`);
    }

    if (!fs.existsSync(cli.riskPath)) {
        console.log(`Risk metrics artifact not found at: ${cli.riskPath}`);
        console.log(`Auto-building from ${cli.datasetPath}...`);
        const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
        const generated = buildRiskMetrics(datasetRaw);
        const dir = path.dirname(cli.riskPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cli.riskPath, JSON.stringify(generated, null, 2), "utf8");
        console.log(`Generated ${cli.riskPath} successfully.\n`);
    }

    const riskRaw = JSON.parse(fs.readFileSync(cli.riskPath, "utf8"));
    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));

    const report = auditRiskMetrics(riskRaw, datasetRaw, cli.riskPath, cli.datasetPath);

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
    (process.argv[1].endsWith("audit-wallet-risk-metrics.ts") ||
        process.argv[1].endsWith("audit-wallet-risk-metrics.js") ||
        process.argv[1].includes("audit-wallet-risk-metrics"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Risk metrics audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
