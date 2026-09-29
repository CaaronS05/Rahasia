import fs from "node:fs";
import path from "node:path";
import {
    buildStyleReadiness,
    type WalletStyleReadinessOutput,
    type DistributionStats,
} from "./build-wallet-style-readiness.ts";

interface CliOptions {
    styleReadinessPath: string;
    datasetPath: string;
    poolCreationPath: string;
    outputPath: string;
}

export interface V1StyleReadinessAuditReport {
    generatedAt: string;
    styleReadinessPath: string;
    datasetPath: string;
    poolCreationPath: string;
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
        negativeEntryDelayCount: number;
        coverageMathMismatchesCount: number;
        poolCacheIntegrityViolationsCount: number;
        violations: string[];
    };
    coverageSummary: {
        uniquePools: number;
        poolCreationAvailable: number;
        poolCreationUnavailable: number;
        poolCreationCoveragePct: number;
        totalClosedPositions: number;
        positionsWithEntryDelay: number;
        entryDelayCoveragePct: number;
        walletsWithHighCoverage: number;
        walletsWithLowCoverage: number;
        negativeEntryDelays: number;
    };
    styleReadiness: {
        sniperStyleReadiness: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
        farmerStyleReadiness: "READY";
        overallReadiness: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
        notes: string;
    };
    cohortDistributions: {
        medianEntryDelayHours: DistributionStats;
        medianHoldHours: DistributionStats;
        positionsPerPool: DistributionStats;
        uniqueDlmmPools: DistributionStats;
        feesToDepositsPct: DistributionStats;
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let styleReadinessPath = path.resolve("data/v1/wallet-style-readiness.json");
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let poolCreationPath = path.resolve("data/v1/pool-creation-times.json");
    let outputPath = path.resolve("data/v1/wallet-style-readiness-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--readiness" && args[i + 1]) {
            styleReadinessPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--readiness=")) {
            styleReadinessPath = path.resolve(arg.slice(12));
        } else if ((arg === "--dataset" || arg === "--input") && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=") || arg.startsWith("--input=")) {
            datasetPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--pools" && args[i + 1]) {
            poolCreationPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--pools=")) {
            poolCreationPath = path.resolve(arg.split("=")[1]);
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

    return { styleReadinessPath, datasetPath, poolCreationPath, outputPath };
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

export function auditStyleReadiness(
    styleData: WalletStyleReadinessOutput,
    datasetData: any,
    poolCreationData: any,
    styleReadinessPath: string,
    datasetPath: string,
    poolCreationPath: string
): V1StyleReadinessAuditReport {
    const violations: string[] = [];

    // 1. Population check
    const datasetWallets: any[] = Array.isArray(datasetData?.wallets) ? datasetData.wallets : [];
    const validDatasetWallets = datasetWallets.filter((w) => w?.valid === true);
    const validWalletSet = new Set<string>(validDatasetWallets.map((w) => String(w.wallet).trim()));

    const styleWallets: any[] = Array.isArray(styleData?.wallets) ? styleData.wallets : [];
    const scoredWalletMap = new Map<string, number>();

    for (const sw of styleWallets) {
        const addr = String(sw.wallet || "").trim();
        if (addr) {
            scoredWalletMap.set(addr, (scoredWalletMap.get(addr) ?? 0) + 1);
        }
    }

    const missingWallets: string[] = [];
    for (const w of validWalletSet) {
        if (!scoredWalletMap.has(w)) {
            missingWallets.push(w);
            violations.push(`Valid wallet missing from style readiness: ${w}`);
        }
    }

    const extraWallets: string[] = [];
    for (const [w] of scoredWalletMap.entries()) {
        if (!validWalletSet.has(w)) {
            extraWallets.push(w);
            violations.push(`Extra wallet in style readiness not present in valid dataset: ${w}`);
        }
    }

    const duplicateWallets: string[] = [];
    for (const [w, count] of scoredWalletMap.entries()) {
        if (count > 1) {
            duplicateWallets.push(w);
            violations.push(`Duplicate wallet in style readiness: ${w} (${count} occurrences)`);
        }
    }

    // 2. Numerical & Math Integrity
    let nanOrInfinityCount = 0;
    let invalidTimestampCount = 0;
    let negativeEntryDelayCount = 0;
    let coverageMathMismatchesCount = 0;
    let poolCacheIntegrityViolationsCount = 0;

    for (const sw of styleWallets) {
        const w = sw.wallet;

        // Check entryDelay fields
        const ed = sw.entryDelay;
        if (!ed) {
            violations.push(`Wallet ${w} missing entryDelay object`);
            continue;
        }

        if (ed.negativeEntryDelayCount > 0) {
            negativeEntryDelayCount += ed.negativeEntryDelayCount;
            // Negative delays are flagged as data quality issues
            violations.push(`Wallet ${w} has ${ed.negativeEntryDelayCount} negative entry delays`);
        }

        if (ed.totalClosedPositions > 0) {
            const expectedCovPct = Number(((ed.positionsWithEntryDelay / ed.totalClosedPositions) * 100).toFixed(2));
            if (Math.abs(ed.entryDelayCoveragePct - expectedCovPct) > 0.05) {
                coverageMathMismatchesCount++;
                violations.push(
                    `Wallet ${w} entryDelayCoveragePct mismatch: reported ${ed.entryDelayCoveragePct}% vs calculated ${expectedCovPct}%`
                );
            }
        }

        // Check for non-finite numeric fields
        const numericChecks: Array<{ name: string; val: any }> = [
            { name: "positionsWithEntryDelay", val: ed.positionsWithEntryDelay },
            { name: "totalClosedPositions", val: ed.totalClosedPositions },
            { name: "entryDelayCoveragePct", val: ed.entryDelayCoveragePct },
            { name: "holding.medianHoldHours", val: sw.holding?.medianHoldHours },
            { name: "holding.meanHoldHours", val: sw.holding?.meanHoldHours },
            { name: "farmer.closedPositionCount", val: sw.farmer?.closedPositionCount },
            { name: "farmer.uniqueDlmmPools", val: sw.farmer?.uniqueDlmmPools },
            { name: "farmer.positionsPerPool", val: sw.farmer?.positionsPerPool },
            { name: "farmer.feesToDepositsPct", val: sw.farmer?.feesToDepositsPct },
        ];

        for (const nc of numericChecks) {
            if (nc.val !== null && (typeof nc.val !== "number" || !Number.isFinite(nc.val) || Number.isNaN(nc.val))) {
                nanOrInfinityCount++;
                violations.push(`Wallet ${w} field ${nc.name} is non-finite: ${nc.val}`);
            }
        }
    }

    // 3. Pool Creation Cache Integrity
    const poolList: any[] = Array.isArray(poolCreationData)
        ? poolCreationData
        : Array.isArray(poolCreationData?.pools)
        ? poolCreationData.pools
        : [];

    const poolMap = new Map<string, any>();
    for (const p of poolList) {
        if (!p || !p.pool) continue;
        poolMap.set(String(p.pool).trim(), p);
        if (p.status === "AVAILABLE" && p.createdAt) {
            const parsed = Date.parse(p.createdAt);
            if (!Number.isFinite(parsed)) {
                invalidTimestampCount++;
                poolCacheIntegrityViolationsCount++;
                violations.push(`Pool ${p.pool} has invalid createdAt: ${p.createdAt}`);
            }
        }
    }

    const status: "PASS" | "FAIL" =
        missingWallets.length === 0 &&
        extraWallets.length === 0 &&
        duplicateWallets.length === 0 &&
        nanOrInfinityCount === 0 &&
        coverageMathMismatchesCount === 0 &&
        poolCacheIntegrityViolationsCount === 0 &&
        styleWallets.length > 0
            ? "PASS"
            : "FAIL";

    return {
        generatedAt: new Date().toISOString(),
        styleReadinessPath,
        datasetPath,
        poolCreationPath,
        status,
        populationAudit: {
            sourceValidWalletCount: validDatasetWallets.length,
            outputWalletCount: styleWallets.length,
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
            negativeEntryDelayCount,
            coverageMathMismatchesCount,
            poolCacheIntegrityViolationsCount,
            violations,
        },
        coverageSummary: {
            uniquePools: styleData.poolCoverage.uniquePools,
            poolCreationAvailable: styleData.poolCoverage.poolCreationAvailable,
            poolCreationUnavailable: styleData.poolCoverage.poolCreationUnavailable,
            poolCreationCoveragePct: styleData.poolCoverage.poolCreationCoveragePct,
            totalClosedPositions: styleData.positionCoverage.totalClosedPositions,
            positionsWithEntryDelay: styleData.positionCoverage.positionsWithEntryDelay,
            entryDelayCoveragePct: styleData.positionCoverage.entryDelayCoveragePct,
            walletsWithHighCoverage: styleData.positionCoverage.walletsWithHighCoverage,
            walletsWithLowCoverage: styleData.positionCoverage.walletsWithLowCoverage,
            negativeEntryDelays: styleData.positionCoverage.negativeEntryDelays,
        },
        styleReadiness: styleData.assessment,
        cohortDistributions: styleData.cohortDistributions,
    };
}

function printAuditReport(report: V1StyleReadinessAuditReport, rawOutput: WalletStyleReadinessOutput): void {
    console.log("==================================================");
    console.log("V1 — WALLET STYLE READINESS AUDIT");
    console.log("==================================================");
    console.log(`Input Screening Dataset : ${report.datasetPath}`);
    console.log(`Pool Creation Times     : ${report.poolCreationPath}`);
    console.log(`Style Readiness Output  : ${report.styleReadinessPath}\n`);

    console.log("COVERAGE AUDIT");
    console.log("--------------------------------------------------");
    console.log(`Unique Pools                : ${report.coverageSummary.uniquePools}`);
    console.log(`Pool Creation Available     : ${report.coverageSummary.poolCreationAvailable}`);
    console.log(`Pool Creation Unavailable   : ${report.coverageSummary.poolCreationUnavailable}`);
    console.log(`Pool Creation Coverage %    : ${report.coverageSummary.poolCreationCoveragePct}%\n`);

    console.log(`Positions                   : ${report.coverageSummary.totalClosedPositions}`);
    console.log(`Positions With Entry Delay  : ${report.coverageSummary.positionsWithEntryDelay}`);
    console.log(`Entry Delay Coverage %      : ${report.coverageSummary.entryDelayCoveragePct}%\n`);

    console.log(`Wallets With >=90% Entry Delay Coverage : ${report.coverageSummary.walletsWithHighCoverage}`);
    console.log(`Wallets With <90% Entry Delay Coverage  : ${report.coverageSummary.walletsWithLowCoverage}`);
    console.log(`Negative Entry Delays                   : ${report.coverageSummary.negativeEntryDelays}\n`);

    console.log("STYLE READINESS ASSESSMENT");
    console.log("--------------------------------------------------");
    console.log(`SNIPER Style Readiness : ${report.styleReadiness.sniperStyleReadiness}`);
    console.log(`FARMER Style Readiness : ${report.styleReadiness.farmerStyleReadiness}`);
    console.log(`OVERALL Readiness      : ${report.styleReadiness.overallReadiness}`);
    console.log(`Notes                  : ${report.styleReadiness.notes}\n`);

    console.log("COHORT DISTRIBUTIONS (N=65)");
    console.log("--------------------------------------------------");
    const metrics: Array<{ key: keyof typeof report.cohortDistributions; label: string; unit: string }> = [
        { key: "medianEntryDelayHours", label: "medianEntryDelayHours", unit: "h" },
        { key: "medianHoldHours", label: "medianHoldHours      ", unit: "h" },
        { key: "positionsPerPool", label: "positionsPerPool     ", unit: "" },
        { key: "uniqueDlmmPools", label: "uniqueDlmmPools      ", unit: "" },
        { key: "feesToDepositsPct", label: "feesToDepositsPct    ", unit: "%" },
    ];

    console.log("Metric                  |    Min |    P10 |    P25 | Median |    P75 |    P90 |    Max");
    console.log("-----------------------------------------------------------------------------------------");
    for (const m of metrics) {
        const d = report.cohortDistributions[m.key];
        console.log(
            `${m.label} | ${String(d.min).padStart(6)} | ${String(d.p10).padStart(6)} | ${String(d.p25).padStart(6)} | ${String(d.median).padStart(6)} | ${String(d.p75).padStart(6)} | ${String(d.p90).padStart(6)} | ${String(d.max).padStart(6)} ${m.unit}`
        );
    }
    console.log("");

    console.log("SNIPER SUPPORT GRID (CANDIDATE COUNTS)");
    console.log("--------------------------------------------------");
    console.log("Entry Delay \\ Hold  |  <= 1h Hold  |  <= 6h Hold  | <= 24h Hold  | <= 72h Hold");
    console.log("-----------------------------------------------------------------------------");
    const entryLabels = ["<= 1h", "<= 6h", "<= 24h", "<= 72h", "<= 7d"];
    const holdLabels = ["<= 1h", "<= 6h", "<= 24h", "<= 72h"];

    for (const el of entryLabels) {
        const rowCells = holdLabels.map((hl) => {
            const cell = rawOutput.sniperSupportGrid.find(
                (c) => c.entryDelayLabel === el && c.holdLabel === hl
            );
            const count = cell ? cell.candidateWalletCount : 0;
            const pct = cell ? cell.walletPct : 0;
            return `${String(count).padStart(3)} (${String(pct).padStart(5)}%)`;
        });
        console.log(`${el.padEnd(20)}|  ${rowCells.join("  |  ")}`);
    }
    console.log("");

    console.log("FARMER SUPPORT GRID (COHORT PERCENTILE CANDIDATES)");
    console.log("--------------------------------------------------");
    const fg = rawOutput.farmerSupportGrid;
    console.log(`Cohort Reference Thresholds:`);
    console.log(`  P75 medianHoldHours      : >= ${fg.cohortP75HoldHours}h`);
    console.log(`  P25 uniqueDlmmPools      : <= ${fg.cohortP25UniquePools} pools`);
    console.log(`  P75 positionsPerPool     : >= ${fg.cohortP75PositionsPerPool} pos/pool\n`);

    console.log(`Combination A (Long hold only)                         : ${fg.counts.longHoldOnly} wallets (${((fg.counts.longHoldOnly / 65) * 100).toFixed(1)}%)`);
    console.log(`Combination B (Long hold + low unique pools)           : ${fg.counts.longHoldLowUniquePools} wallets (${((fg.counts.longHoldLowUniquePools / 65) * 100).toFixed(1)}%)`);
    console.log(`Combination C (Long hold + high positionsPerPool)      : ${fg.counts.longHoldHighPositionsPerPool} wallets (${((fg.counts.longHoldHighPositionsPerPool / 65) * 100).toFixed(1)}%)`);
    console.log(`Combination D (Long hold + low pools + high pos/pool)  : ${fg.counts.longHoldLowUniquePoolsHighPositionsPerPool} wallets (${((fg.counts.longHoldLowUniquePoolsHighPositionsPerPool / 65) * 100).toFixed(1)}%)\n`);

    console.log("==================================================");
    console.log(`AUDIT VERDICT: ${report.status}`);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset file not found: ${cli.datasetPath}`);
    }

    if (!fs.existsSync(cli.styleReadinessPath) || !fs.existsSync(cli.poolCreationPath)) {
        console.log(`Style readiness artifacts not found. Auto-building from ${cli.datasetPath}...`);
        const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
        const generated = await buildStyleReadiness(datasetRaw, cli.poolCreationPath);
        atomicWriteJson(cli.styleReadinessPath, generated);
        console.log(`Generated ${cli.styleReadinessPath} successfully.\n`);
    }

    const styleRaw = JSON.parse(fs.readFileSync(cli.styleReadinessPath, "utf8"));
    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    let poolCreationRaw: any = null;
    if (fs.existsSync(cli.poolCreationPath)) {
        poolCreationRaw = JSON.parse(fs.readFileSync(cli.poolCreationPath, "utf8"));
    }

    const report = auditStyleReadiness(
        styleRaw,
        datasetRaw,
        poolCreationRaw,
        cli.styleReadinessPath,
        cli.datasetPath,
        cli.poolCreationPath
    );

    atomicWriteJson(cli.outputPath, report);

    printAuditReport(report, styleRaw);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-style-readiness.ts") ||
        process.argv[1].endsWith("audit-wallet-style-readiness.js") ||
        process.argv[1].includes("audit-wallet-style-readiness"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Style readiness audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
