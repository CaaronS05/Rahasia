import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    discoveryDir: string;
    outputFile: string;
}

interface ValidationResult {
    valid: boolean;
    reason?: string;
}

interface CohortMetricStats {
    count: number;
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
}

interface DatasetWalletRecord {
    wallet: string;
    closedPositions: number;
    uniquePools: number;

    rangeBehaviour: any;
    placementBehaviour: any;
    rebalanceBehaviour: any;
    performance: any;
    capitalBehaviour: any;
    holdingBehaviour: any;

    sourceFile: string;
}

interface InvalidWalletRecord {
    wallet: string;
    sourceFile: string;
    reason: string;
}

interface BehaviourDataset {
    generatedAt: string;
    datasetVersion: number;

    walletCount: number;
    totalClosedPositions: number;
    uniquePoolsAcrossWallets: number;

    wallets: DatasetWalletRecord[];
    datasetSummary: Record<string, CohortMetricStats>;
    invalidWallets: InvalidWalletRecord[];
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
        discoveryDir: options["discovery-dir"] || path.resolve("data/discovery/waldisc-2"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
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

function validateWalletBehaviour(data: any): ValidationResult {
    if (!data || typeof data !== "object") {
        return { valid: false, reason: "Root is not an object or is null" };
    }

    if (typeof data.wallet !== "string" || data.wallet.trim().length === 0) {
        return { valid: false, reason: "Missing or invalid 'wallet' string" };
    }

    if (!data.coverage || typeof data.coverage !== "object") {
        return { valid: false, reason: "Missing or invalid 'coverage' object" };
    }

    if (
        typeof data.coverage.totalClosedPositions !== "number" ||
        !Number.isFinite(data.coverage.totalClosedPositions) ||
        data.coverage.totalClosedPositions <= 0
    ) {
        return {
            valid: false,
            reason: `coverage.totalClosedPositions must be a positive number (${data.coverage.totalClosedPositions})`,
        };
    }

    if (data.coverage.completeStrategyCoverage !== true) {
        return {
            valid: false,
            reason: `coverage.completeStrategyCoverage is not true (${data.coverage.completeStrategyCoverage})`,
        };
    }

    if (
        typeof data.coverage.strategyCoveragePct !== "number" ||
        data.coverage.strategyCoveragePct < 100
    ) {
        return {
            valid: false,
            reason: `strategy coverage is incomplete (strategyCoveragePct: ${data.coverage.strategyCoveragePct})`,
        };
    }

    if (!Array.isArray(data.positions)) {
        return { valid: false, reason: "Missing 'positions' array" };
    }

    if (data.positions.length !== data.coverage.totalClosedPositions) {
        return {
            valid: false,
            reason: `positions array length (${data.positions.length}) does not match coverage.totalClosedPositions (${data.coverage.totalClosedPositions})`,
        };
    }

    const requiredSections = [
        "rangeBehaviour",
        "placementBehaviour",
        "rebalanceBehaviour",
        "performance",
        "capitalBehaviour",
        "holdingBehaviour",
    ];

    for (const section of requiredSections) {
        if (!data[section] || typeof data[section] !== "object") {
            return {
                valid: false,
                reason: `Missing or invalid required section '${section}'`,
            };
        }
    }

    return { valid: true };
}

function calculateMetricStats(values: (number | null | undefined)[]): CohortMetricStats {
    const valid = values.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v)
    );

    if (valid.length === 0) {
        return {
            count: 0,
            mean: null,
            median: null,
            min: null,
            max: null,
        };
    }

    valid.sort((a, b) => a - b);
    const sum = valid.reduce((acc, v) => acc + v, 0);
    const mean = sum / valid.length;
    const min = valid[0];
    const max = valid[valid.length - 1];

    let median: number;
    const mid = Math.floor(valid.length / 2);
    if (valid.length % 2 === 1) {
        median = valid[mid];
    } else {
        median = (valid[mid - 1] + valid[mid]) / 2;
    }

    return {
        count: valid.length,
        mean,
        median,
        min,
        max,
    };
}

async function main() {
    const { discoveryDir, outputFile } = parseCliArgs();

    if (!fs.existsSync(discoveryDir)) {
        throw new Error(`Discovery directory does not exist: ${discoveryDir}`);
    }

    const entries = fs.readdirSync(discoveryDir, { withFileTypes: true });
    const dirEntries = entries.filter((e) => e.isDirectory());

    const validWallets: DatasetWalletRecord[] = [];
    const invalidWallets: InvalidWalletRecord[] = [];
    const allPools = new Set<string>();

    for (const dir of dirEntries) {
        const walletBehaviourPath = path.join(discoveryDir, dir.name, "wallet-behaviour.json");

        if (!fs.existsSync(walletBehaviourPath)) {
            // Incomplete discovery folder without wallet-behaviour.json
            continue;
        }

        let rawContent: string;
        try {
            rawContent = fs.readFileSync(walletBehaviourPath, "utf8");
        } catch (err: any) {
            invalidWallets.push({
                wallet: dir.name,
                sourceFile: path.relative(process.cwd(), walletBehaviourPath),
                reason: `Failed to read file: ${err.message}`,
            });
            continue;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(rawContent);
        } catch (err: any) {
            invalidWallets.push({
                wallet: dir.name,
                sourceFile: path.relative(process.cwd(), walletBehaviourPath),
                reason: `Malformed JSON: ${err.message}`,
            });
            continue;
        }

        const validation = validateWalletBehaviour(parsed);
        if (!validation.valid) {
            invalidWallets.push({
                wallet: parsed.wallet || dir.name,
                sourceFile: path.relative(process.cwd(), walletBehaviourPath),
                reason: validation.reason || "Validation failed",
            });
            continue;
        }

        const walletAddress = parsed.wallet;
        const closedPositions = parsed.coverage.totalClosedPositions;

        // Collect pools for this wallet and globally
        const walletPools = new Set<string>();
        if (Array.isArray(parsed.positions)) {
            for (const p of parsed.positions) {
                if (typeof p.pool === "string" && p.pool.trim()) {
                    walletPools.add(p.pool.trim());
                    allPools.add(p.pool.trim());
                }
            }
        }
        if (Array.isArray(parsed.poolDistribution)) {
            for (const item of parsed.poolDistribution) {
                if (typeof item.pool === "string" && item.pool.trim()) {
                    walletPools.add(item.pool.trim());
                    allPools.add(item.pool.trim());
                }
            }
        }

        const uniquePools =
            typeof parsed.coverage.uniquePoolCount === "number" &&
            Number.isFinite(parsed.coverage.uniquePoolCount)
                ? parsed.coverage.uniquePoolCount
                : walletPools.size;

        const relativeSourceFile = path.relative(process.cwd(), walletBehaviourPath);

        validWallets.push({
            wallet: walletAddress,
            closedPositions,
            uniquePools,

            rangeBehaviour: parsed.rangeBehaviour,
            placementBehaviour: parsed.placementBehaviour,
            rebalanceBehaviour: parsed.rebalanceBehaviour,
            performance: parsed.performance,
            capitalBehaviour: parsed.capitalBehaviour,
            holdingBehaviour: parsed.holdingBehaviour,

            sourceFile: relativeSourceFile,
        });
    }

    // Sort valid wallets deterministically by wallet address
    validWallets.sort((a, b) => a.wallet.localeCompare(b.wallet));

    const totalClosedPositions = validWallets.reduce(
        (sum, w) => sum + w.closedPositions,
        0
    );
    const uniquePoolsAcrossWallets = allPools.size;

    // Calculate cohort statistics across included wallets (1 observation per wallet)
    const datasetSummary: Record<string, CohortMetricStats> = {
        medianRangeWidthPct: calculateMetricStats(
            validWallets.map((w) => w.rangeBehaviour?.rangeWidthPct?.median)
        ),
        medianPlacementFraction: calculateMetricStats(
            validWallets.map((w) => w.placementBehaviour?.placementFraction?.median)
        ),
        trueRebalancePositionPct: calculateMetricStats(
            validWallets.map((w) => w.rebalanceBehaviour?.trueRebalancePositionPct)
        ),
        winRatePct: calculateMetricStats(
            validWallets.map((w) => w.performance?.winRatePct)
        ),
        totalPnlUsd: calculateMetricStats(
            validWallets.map((w) => w.performance?.totalPnlUsd)
        ),
        medianPnlUsd: calculateMetricStats(
            validWallets.map((w) => w.performance?.medianPnlUsd)
        ),
        medianDurationHours: calculateMetricStats(
            validWallets.map((w) => w.holdingBehaviour?.medianDurationHours)
        ),
        totalFeesUsd: calculateMetricStats(
            validWallets.map((w) => w.capitalBehaviour?.totalFeesUsd)
        ),
        closedPositionCount: calculateMetricStats(
            validWallets.map((w) => w.closedPositions)
        ),
        uniquePoolCount: calculateMetricStats(
            validWallets.map((w) => w.uniquePools)
        ),
    };

    const dataset: BehaviourDataset = {
        generatedAt: new Date().toISOString(),
        datasetVersion: 1,

        walletCount: validWallets.length,
        totalClosedPositions,
        uniquePoolsAcrossWallets,

        wallets: validWallets,
        datasetSummary,
        invalidWallets,
    };

    atomicWriteJson(outputFile, dataset);

    // Terminal Output
    console.log("========================================");
    console.log("WALDISC-2 STEP 1F.2 — BEHAVIOUR DATASET");
    console.log("========================================");
    console.log(`Valid Wallets        : ${validWallets.length}`);
    console.log(`Invalid Wallets      : ${invalidWallets.length}`);
    console.log(`Closed Positions     : ${totalClosedPositions}`);
    console.log(`Unique Pools         : ${uniquePoolsAcrossWallets}`);
    console.log("");
    console.log("Wallets:");
    validWallets.forEach((w, idx) => {
        console.log(
            `${idx + 1}. ${w.wallet} | positions=${w.closedPositions} | pools=${w.uniquePools}`
        );
    });
    console.log("");
    console.log(`Dataset File         : ${outputFile}`);
    console.log("========================================");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Dataset builder failed: ${err.message}`);
    process.exit(1);
});
