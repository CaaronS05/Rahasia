import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    inputFile: string;
    outputFile: string;
}

interface DistributionMetricSummary {
    count: number;
    missingCount: number;
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
    p10: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p90: number | null;
}

interface WalletObservation {
    wallet: string;
    closedPositions: number;
    uniquePools: number;

    // Range / Placement
    medianRangeWidthPct: number | null;
    medianPlacementFraction: number | null;
    rangeCoveragePct: number | null;
    positionsWithRange: number | null;
    positionsWithoutRange: number | null;
    noLiquidityPositions: number | null;

    // Rebalance
    totalTrueRebalances: number;
    meanTrueRebalancesPerPosition: number;
    trueRebalancePositionPct: number;

    // Performance
    winRatePct: number | null;
    medianPnlUsd: number | null;
    meanPnlUsd: number | null;
    top1PositiveProfitSharePct: number | null;
    top3PositiveProfitSharePct: number | null;
    totalPnlUsdDescriptive: number | null;

    // Holding
    medianDurationHours: number | null;
    meanDurationHours: number | null;

    // Capital / Fee
    medianDepositUsd: number | null;
    meanDepositUsd: number | null;
    feeToDepositPct: number | null;
    totalFeesUsdDescriptive: number | null;

    // Coverage
    strategyCoveragePct: number;
}

interface CohortDistributionOutput {
    generatedAt: string;
    walletCount: number;
    closedPositionCount: number;
    uniquePoolCount: number;
    methodology: {
        observationUnit: "wallet";
        walletWeighting: "equal";
        missingValuePolicy: "exclude_from_metric_distribution";
        percentileMethod: "linear_interpolation_between_closest_ranks";
        scoring: false;
        ranking: false;
    };
    metrics: Record<string, DistributionMetricSummary>;
    wallets: WalletObservation[];
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
            options.dataset ||
            options["input-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/cohort-distribution.json"),
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

function percentile(sorted: number[], p: number): number {
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

function calculateDistribution(
    values: (number | null | undefined)[],
    totalWallets: number
): DistributionMetricSummary {
    const valid = values.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v)
    );

    if (valid.length === 0) {
        return {
            count: 0,
            missingCount: totalWallets,
            mean: null,
            median: null,
            min: null,
            max: null,
            p10: null,
            p25: null,
            p50: null,
            p75: null,
            p90: null,
        };
    }

    valid.sort((a, b) => a - b);
    const sum = valid.reduce((acc, v) => acc + v, 0);
    const mean = sum / valid.length;
    const min = valid[0];
    const max = valid[valid.length - 1];

    return {
        count: valid.length,
        missingCount: totalWallets - valid.length,
        mean,
        median: percentile(valid, 50),
        min,
        max,
        p10: percentile(valid, 10),
        p25: percentile(valid, 25),
        p50: percentile(valid, 50),
        p75: percentile(valid, 75),
        p90: percentile(valid, 90),
    };
}

function formatVal(v: number | null, decimals = 2, suffix = ""): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return "N/A";
    return `${v.toFixed(decimals)}${suffix}`;
}

async function main() {
    const { inputFile, outputFile } = parseCliArgs();

    if (!fs.existsSync(inputFile)) {
        throw new Error(`Input dataset file not found: ${inputFile}`);
    }

    const dataset = tryReadJson(inputFile);
    if (!dataset || !Array.isArray(dataset.wallets)) {
        throw new Error(`Invalid behaviour dataset schema in ${inputFile}: 'wallets' array missing`);
    }

    const rawWallets: any[] = dataset.wallets;
    const totalWallets = rawWallets.length;

    if (totalWallets === 0) {
        throw new Error(`No wallets found in behaviour dataset: ${inputFile}`);
    }

    const observations: WalletObservation[] = [];
    const allPools = new Set<string>();
    let totalClosedPositions = 0;

    for (const w of rawWallets) {
        if (!w || typeof w.wallet !== "string") continue;

        const walletAddress = w.wallet;
        const closedPositions = typeof w.closedPositions === "number" ? w.closedPositions : 0;
        const uniquePools = typeof w.uniquePools === "number" ? w.uniquePools : 0;
        totalClosedPositions += closedPositions;

        // Try reading source wallet-behaviour.json to get coverage data if available
        let sourceData: any = null;
        if (typeof w.sourceFile === "string" && w.sourceFile.trim()) {
            const resolvedSourcePath = path.resolve(w.sourceFile);
            sourceData = tryReadJson(resolvedSourcePath);
        }

        // Coverage fields
        let positionsWithRange = sourceData?.coverage?.positionsWithRange;
        let positionsWithoutRange = sourceData?.coverage?.positionsWithoutRange;
        let noLiquidityPositions = sourceData?.coverage?.noLiquidityPositions;
        let rangeCoveragePct = sourceData?.coverage?.rangeCoveragePct;
        const strategyCoveragePct = sourceData?.coverage?.strategyCoveragePct ?? 100;

        if (typeof positionsWithRange !== "number" && Array.isArray(sourceData?.positions)) {
            positionsWithRange = sourceData.positions.filter(
                (p: any) => p && typeof p.lowerBin === "number" && typeof p.upperBin === "number"
            ).length;
            positionsWithoutRange = closedPositions - positionsWithRange;
            noLiquidityPositions = sourceData.positions.filter(
                (p: any) =>
                    p &&
                    (p.rangeAvailability === "NO_LIQUIDITY" ||
                        (p.lowerBin === null && p.upperBin === null))
            ).length;
            rangeCoveragePct =
                closedPositions > 0 ? (positionsWithRange / closedPositions) * 100 : null;
        } else if (typeof positionsWithRange !== "number") {
            if (
                w.rangeBehaviour?.rangeWidthPct?.median !== null &&
                w.rangeBehaviour?.rangeWidthPct?.median !== undefined
            ) {
                positionsWithRange = closedPositions;
                positionsWithoutRange = 0;
                noLiquidityPositions = 0;
                rangeCoveragePct = 100;
            } else {
                positionsWithRange = 0;
                positionsWithoutRange = closedPositions;
                noLiquidityPositions = closedPositions;
                rangeCoveragePct = 0;
            }
        }

        // Range / Placement
        const medianRangeWidthPct =
            typeof w.rangeBehaviour?.rangeWidthPct?.median === "number" &&
            Number.isFinite(w.rangeBehaviour.rangeWidthPct.median)
                ? w.rangeBehaviour.rangeWidthPct.median
                : null;

        const medianPlacementFraction =
            typeof w.placementBehaviour?.placementFraction?.median === "number" &&
            Number.isFinite(w.placementBehaviour.placementFraction.median)
                ? w.placementBehaviour.placementFraction.median
                : null;

        // Rebalance
        const totalTrueRebalances = Number(w.rebalanceBehaviour?.totalTrueRebalances ?? 0);
        const meanTrueRebalancesPerPosition = Number(
            w.rebalanceBehaviour?.meanTrueRebalancesPerPosition ?? 0
        );
        const trueRebalancePositionPct = Number(
            w.rebalanceBehaviour?.trueRebalancePositionPct ?? 0
        );

        // Performance
        const winRatePct =
            typeof w.performance?.winRatePct === "number" &&
            Number.isFinite(w.performance.winRatePct)
                ? w.performance.winRatePct
                : null;

        const medianPnlUsd =
            typeof w.performance?.medianPnlUsd === "number" &&
            Number.isFinite(w.performance.medianPnlUsd)
                ? w.performance.medianPnlUsd
                : null;

        const meanPnlUsd =
            typeof w.performance?.meanPnlUsd === "number" &&
            Number.isFinite(w.performance.meanPnlUsd)
                ? w.performance.meanPnlUsd
                : null;

        const top1PositiveProfitSharePct =
            typeof w.performance?.top1PositiveProfitSharePct === "number" &&
            Number.isFinite(w.performance.top1PositiveProfitSharePct)
                ? w.performance.top1PositiveProfitSharePct
                : null;

        const top3PositiveProfitSharePct =
            typeof w.performance?.top3PositiveProfitSharePct === "number" &&
            Number.isFinite(w.performance.top3PositiveProfitSharePct)
                ? w.performance.top3PositiveProfitSharePct
                : null;

        const totalPnlUsdDescriptive =
            typeof w.performance?.totalPnlUsd === "number" &&
            Number.isFinite(w.performance.totalPnlUsd)
                ? w.performance.totalPnlUsd
                : null;

        // Holding
        const medianDurationHours =
            typeof w.holdingBehaviour?.medianDurationHours === "number" &&
            Number.isFinite(w.holdingBehaviour.medianDurationHours)
                ? w.holdingBehaviour.medianDurationHours
                : null;

        const meanDurationHours =
            typeof w.holdingBehaviour?.meanDurationHours === "number" &&
            Number.isFinite(w.holdingBehaviour.meanDurationHours)
                ? w.holdingBehaviour.meanDurationHours
                : null;

        // Capital / Fee
        const medianDepositUsd =
            typeof w.capitalBehaviour?.medianDepositUsd === "number" &&
            Number.isFinite(w.capitalBehaviour.medianDepositUsd)
                ? w.capitalBehaviour.medianDepositUsd
                : null;

        const meanDepositUsd =
            typeof w.capitalBehaviour?.meanDepositUsd === "number" &&
            Number.isFinite(w.capitalBehaviour.meanDepositUsd)
                ? w.capitalBehaviour.meanDepositUsd
                : null;

        const feeToDepositPct =
            typeof w.capitalBehaviour?.feeToDepositPct === "number" &&
            Number.isFinite(w.capitalBehaviour.feeToDepositPct)
                ? w.capitalBehaviour.feeToDepositPct
                : null;

        const totalFeesUsdDescriptive =
            typeof w.capitalBehaviour?.totalFeesUsd === "number" &&
            Number.isFinite(w.capitalBehaviour.totalFeesUsd)
                ? w.capitalBehaviour.totalFeesUsd
                : null;

        observations.push({
            wallet: walletAddress,
            closedPositions,
            uniquePools,

            medianRangeWidthPct,
            medianPlacementFraction,
            rangeCoveragePct:
                typeof rangeCoveragePct === "number" && Number.isFinite(rangeCoveragePct)
                    ? rangeCoveragePct
                    : null,
            positionsWithRange:
                typeof positionsWithRange === "number" && Number.isFinite(positionsWithRange)
                    ? positionsWithRange
                    : null,
            positionsWithoutRange:
                typeof positionsWithoutRange === "number" &&
                Number.isFinite(positionsWithoutRange)
                    ? positionsWithoutRange
                    : null,
            noLiquidityPositions:
                typeof noLiquidityPositions === "number" &&
                Number.isFinite(noLiquidityPositions)
                    ? noLiquidityPositions
                    : null,

            totalTrueRebalances,
            meanTrueRebalancesPerPosition,
            trueRebalancePositionPct,

            winRatePct,
            medianPnlUsd,
            meanPnlUsd,
            top1PositiveProfitSharePct,
            top3PositiveProfitSharePct,
            totalPnlUsdDescriptive,

            medianDurationHours,
            meanDurationHours,

            medianDepositUsd,
            meanDepositUsd,
            feeToDepositPct,
            totalFeesUsdDescriptive,

            strategyCoveragePct,
        });
    }

    // Sort deterministically by wallet address
    observations.sort((a, b) => a.wallet.localeCompare(b.wallet));

    const uniquePoolCount =
        typeof dataset.uniquePoolsAcrossWallets === "number"
            ? dataset.uniquePoolsAcrossWallets
            : allPools.size;

    const closedPositionCount =
        typeof dataset.totalClosedPositions === "number"
            ? dataset.totalClosedPositions
            : totalClosedPositions;

    const walletCount = observations.length;

    // Calculate distributions for each numeric wallet-level metric
    const metrics: Record<string, DistributionMetricSummary> = {
        // Range / Placement
        medianRangeWidthPct: calculateDistribution(
            observations.map((o) => o.medianRangeWidthPct),
            walletCount
        ),
        medianPlacementFraction: calculateDistribution(
            observations.map((o) => o.medianPlacementFraction),
            walletCount
        ),
        rangeCoveragePct: calculateDistribution(
            observations.map((o) => o.rangeCoveragePct),
            walletCount
        ),
        positionsWithRange: calculateDistribution(
            observations.map((o) => o.positionsWithRange),
            walletCount
        ),
        positionsWithoutRange: calculateDistribution(
            observations.map((o) => o.positionsWithoutRange),
            walletCount
        ),
        noLiquidityPositions: calculateDistribution(
            observations.map((o) => o.noLiquidityPositions),
            walletCount
        ),

        // Rebalance
        totalTrueRebalances: calculateDistribution(
            observations.map((o) => o.totalTrueRebalances),
            walletCount
        ),
        meanTrueRebalancesPerPosition: calculateDistribution(
            observations.map((o) => o.meanTrueRebalancesPerPosition),
            walletCount
        ),
        trueRebalancePositionPct: calculateDistribution(
            observations.map((o) => o.trueRebalancePositionPct),
            walletCount
        ),

        // Performance
        winRatePct: calculateDistribution(
            observations.map((o) => o.winRatePct),
            walletCount
        ),
        medianPnlUsd: calculateDistribution(
            observations.map((o) => o.medianPnlUsd),
            walletCount
        ),
        meanPnlUsd: calculateDistribution(
            observations.map((o) => o.meanPnlUsd),
            walletCount
        ),
        top1PositiveProfitSharePct: calculateDistribution(
            observations.map((o) => o.top1PositiveProfitSharePct),
            walletCount
        ),
        top3PositiveProfitSharePct: calculateDistribution(
            observations.map((o) => o.top3PositiveProfitSharePct),
            walletCount
        ),
        totalPnlUsdDescriptive: calculateDistribution(
            observations.map((o) => o.totalPnlUsdDescriptive),
            walletCount
        ),

        // Holding
        medianDurationHours: calculateDistribution(
            observations.map((o) => o.medianDurationHours),
            walletCount
        ),
        meanDurationHours: calculateDistribution(
            observations.map((o) => o.meanDurationHours),
            walletCount
        ),

        // Capital / Fee
        medianDepositUsd: calculateDistribution(
            observations.map((o) => o.medianDepositUsd),
            walletCount
        ),
        meanDepositUsd: calculateDistribution(
            observations.map((o) => o.meanDepositUsd),
            walletCount
        ),
        feeToDepositPct: calculateDistribution(
            observations.map((o) => o.feeToDepositPct),
            walletCount
        ),
        totalFeesUsdDescriptive: calculateDistribution(
            observations.map((o) => o.totalFeesUsdDescriptive),
            walletCount
        ),

        // Sample / Coverage
        closedPositionCount: calculateDistribution(
            observations.map((o) => o.closedPositions),
            walletCount
        ),
        uniquePoolCount: calculateDistribution(
            observations.map((o) => o.uniquePools),
            walletCount
        ),
        strategyCoveragePct: calculateDistribution(
            observations.map((o) => o.strategyCoveragePct),
            walletCount
        ),
    };

    const output: CohortDistributionOutput = {
        generatedAt: new Date().toISOString(),
        walletCount,
        closedPositionCount,
        uniquePoolCount,
        methodology: {
            observationUnit: "wallet",
            walletWeighting: "equal",
            missingValuePolicy: "exclude_from_metric_distribution",
            percentileMethod: "linear_interpolation_between_closest_ranks",
            scoring: false,
            ranking: false,
        },
        metrics,
        wallets: observations,
    };

    atomicWriteJson(outputFile, output);

    // Terminal Summary Report
    console.log("==================================================");
    console.log("WALDISC-2 STEP 1G.1 — COHORT DISTRIBUTION");
    console.log("==================================================");
    console.log(`Wallets             : ${walletCount}`);
    console.log(`Closed Positions    : ${closedPositionCount}`);
    console.log(`Unique Pools        : ${uniquePoolCount}\n`);

    const colMetric = "Metric".padEnd(30);
    const colP25 = "P25".padStart(12);
    const colMed = "Median".padStart(12);
    const colP75 = "P75".padStart(12);

    console.log(`${colMetric}${colP25}${colMed}${colP75}`);
    console.log("-".repeat(66));

    const rows = [
        { label: "Range Width (%)", m: metrics.medianRangeWidthPct, suffix: "%" },
        { label: "Placement Fraction", m: metrics.medianPlacementFraction, suffix: "" },
        { label: "Win Rate (%)", m: metrics.winRatePct, suffix: "%" },
        { label: "Median Hold (h)", m: metrics.medianDurationHours, suffix: " h" },
        { label: "True Rebalance Pos (%)", m: metrics.trueRebalancePositionPct, suffix: "%" },
    ];

    for (const r of rows) {
        const lbl = r.label.padEnd(30);
        const p25 = formatVal(r.m.p25, 2, r.suffix).padStart(12);
        const med = formatVal(r.m.median, 2, r.suffix).padStart(12);
        const p75 = formatVal(r.m.p75, 2, r.suffix).padStart(12);
        console.log(`${lbl}${p25}${med}${p75}`);
    }

    console.log("\nRange Coverage:");
    console.log(
        `wallets with metric : ${metrics.medianRangeWidthPct.count}/${walletCount}`
    );
    console.log(`Output File         : ${outputFile}`);
    console.log("==================================================\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Cohort distribution builder failed: ${err.message}`);
    process.exit(1);
});
