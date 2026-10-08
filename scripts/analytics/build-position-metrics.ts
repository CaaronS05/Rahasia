import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
    type AnalyticsPeriod,
    type PositionMetricsResult,
} from "./position-analytics-types.ts";
import {
    loadPositionAnalyticsDataset,
    getDatasetFilePath,
    loadPositionMetrics,
    savePositionMetrics,
    DEFAULT_ANALYTICS_STORAGE_BASE,
    DEFAULT_METRICS_STORAGE_BASE,
} from "./position-analytics-storage.ts";
import { computePositionAnalyticsMetrics } from "./position-analytics-engine.ts";
import { isValidSolanaAddress } from "../v1/single-wallet-intelligence.ts";

export interface BuildPositionMetricsOptions {
    wallet: string;
    period?: AnalyticsPeriod;
    force?: boolean;
    dryRun?: boolean;
    positionsBaseDir?: string;
    metricsBaseDir?: string;
    onLog?: (msg: string) => void;
}

export interface BuildPositionMetricsResult {
    success: boolean;
    metrics: PositionMetricsResult | null;
    persistedPath: string | null;
    fromCache: boolean;
    error?: string;
}

/**
 * Execute position analytics metrics calculation from an existing Step 1 snapshot.
 * Pure computation engine: never triggers Fabriq network calls.
 */
export async function executeBuildPositionMetrics(
    options: BuildPositionMetricsOptions
): Promise<BuildPositionMetricsResult> {
    const t0 = Date.now();
    const log = options.onLog ?? ((msg: string) => console.log(msg));
    const wallet = options.wallet?.trim();
    const period: AnalyticsPeriod = options.period ?? "30D";
    const force = Boolean(options.force);
    const dryRun = Boolean(options.dryRun);
    const positionsBaseDir = options.positionsBaseDir ?? DEFAULT_ANALYTICS_STORAGE_BASE;
    const metricsBaseDir = options.metricsBaseDir ?? DEFAULT_METRICS_STORAGE_BASE;

    if (!wallet || !isValidSolanaAddress(wallet)) {
        throw new Error(`INVALID_WALLET: "${wallet}" is not a valid Solana address.`);
    }

    if (period !== "30D" && period !== "90D" && period !== "ALL_AVAILABLE") {
        throw new Error(`INVALID_PERIOD: Period must be "30D", "90D", or "ALL_AVAILABLE". Received "${period}".`);
    }

    log(`=======================================================`);
    log(`[POSITION-METRICS] Starting calculation for: ${wallet}`);
    log(`[POSITION-METRICS] Period: ${period} | Force: ${force}`);
    log(`=======================================================`);

    // 1. Load Step 1 Position Analytics Dataset snapshot
    const expectedDatasetPath = getDatasetFilePath(wallet, period, positionsBaseDir);
    log(`[POSITION-METRICS] Loading Step 1 dataset from: ${expectedDatasetPath}`);

    const dataset = loadPositionAnalyticsDataset(wallet, period, positionsBaseDir);
    if (!dataset) {
        const errMessage = `MISSING_DATASET: Step 1 position dataset not found for wallet ${wallet} (${period}) at "${expectedDatasetPath}". Please run build-position-dataset.ts first.`;
        log(`[POSITION-METRICS] Error: ${errMessage}`);
        throw new Error(errMessage);
    }

    log(`[POSITION-METRICS] Successfully loaded ${dataset.positions.length} positions.`);

    // 2. Check existing cached metrics snapshot if force is not requested
    if (!force) {
        const cachedMetrics = loadPositionMetrics(wallet, period, metricsBaseDir, dataset.fetchedAt);
        if (cachedMetrics) {
            log(`[POSITION-METRICS] Found valid metrics snapshot matching source dataset fetchedAt (${dataset.fetchedAt}). Returning cached result.`);
            return {
                success: true,
                metrics: cachedMetrics,
                persistedPath: null,
                fromCache: true,
            };
        }
        log(`[POSITION-METRICS] Cached metrics are stale or missing for source dataset (${dataset.fetchedAt}). Recomputing metrics...`);
    } else {
        log(`[POSITION-METRICS] Force flag enabled. Recomputing metrics...`);
    }
    log(`[POSITION-METRICS] Computing pure analytical metrics...`);

    // 3. Compute metrics via pure engine (no side effects)
    const metrics = computePositionAnalyticsMetrics(dataset);

    // 4. Atomically persist metrics output
    let persistedPath: string | null = null;
    if (!dryRun) {
        persistedPath = savePositionMetrics(metrics, metricsBaseDir);
        log(`[POSITION-METRICS] Persisted metrics result to: ${persistedPath}`);
    } else {
        log(`[POSITION-METRICS] (Dry-run mode: skipping filesystem persistence)`);
    }

    const elapsedMs = Date.now() - t0;
    log(`=======================================================`);
    log(`[POSITION-METRICS] Build completed in ${elapsedMs}ms`);
    log(`Total Analyzed Positions : ${metrics.metricCoverage.analyzedPositions}`);
    log(`Verified Initial Entries : ${metrics.metricCoverage.initialEntryObservations} (${metrics.metricCoverage.initialEntryCoveragePct}%)`);
    log(`Win Rate                 : ${metrics.profitability.positionWinRate ?? "N/A"}%`);
    log(`Sample Total PnL         : $${metrics.profitability.sampleTotalPnlUsd ?? "N/A"}`);
    log(`Max Realized Drawdown    : $${metrics.riskAndConsistency.sampleRealizedPnlDrawdown.maxDrawdownUsd}`);
    log(`=======================================================\n`);

    return {
        success: true,
        metrics,
        persistedPath,
        fromCache: false,
    };
}

function parseCliArgs(): {
    wallet: string | null;
    period: AnalyticsPeriod;
    force: boolean;
    dryRun: boolean;
    positionsBaseDir?: string;
    metricsBaseDir?: string;
} {
    const args = process.argv.slice(2);
    let wallet: string | null = null;
    let period: AnalyticsPeriod = "30D";
    let force = false;
    let dryRun = false;
    let positionsBaseDir: string | undefined = undefined;
    let metricsBaseDir: string | undefined = undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--wallet" && args[i + 1]) {
            wallet = args[i + 1].trim();
            i++;
        } else if (arg.startsWith("--wallet=")) {
            wallet = arg.slice(9).trim();
        } else if (arg === "--period" && args[i + 1]) {
            period = args[i + 1].trim() as AnalyticsPeriod;
            i++;
        } else if (arg.startsWith("--period=")) {
            period = arg.slice(9).trim() as AnalyticsPeriod;
        } else if (arg === "--force") {
            force = true;
        } else if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "--positions-base-dir" && args[i + 1]) {
            positionsBaseDir = args[i + 1].trim();
            i++;
        } else if (arg.startsWith("--positions-base-dir=")) {
            positionsBaseDir = arg.slice(21).trim();
        } else if (arg === "--metrics-base-dir" && args[i + 1]) {
            metricsBaseDir = args[i + 1].trim();
            i++;
        } else if (arg.startsWith("--metrics-base-dir=")) {
            metricsBaseDir = arg.slice(19).trim();
        }
    }

    return { wallet, period, force, dryRun, positionsBaseDir, metricsBaseDir };
}

// CLI Execution Entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const { wallet, period, force, dryRun, positionsBaseDir, metricsBaseDir } = parseCliArgs();

    if (!wallet) {
        console.error("Usage: node --experimental-strip-types scripts/analytics/build-position-metrics.ts --wallet <ADDRESS> [--period <30D|90D|ALL_AVAILABLE>] [--force] [--dry-run] [--positions-base-dir <DIR>] [--metrics-base-dir <DIR>]");
        process.exit(1);
    }

    executeBuildPositionMetrics({
        wallet,
        period,
        force,
        dryRun,
        positionsBaseDir,
        metricsBaseDir,
    })
        .then((res) => {
            if (!res.success) {
                console.error(`ERROR: ${res.error || "Position metrics build failed"}`);
                process.exit(1);
            }
        })
        .catch((err) => {
            console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        });
}
