import { fileURLToPath } from "node:url";
import {
    type AnalyticsPeriod,
    type PositionAnalyticsDataset,
} from "./position-analytics-types.ts";
import {
    buildPositionAnalyticsDataset,
    loadPoolMetadataCache,
} from "./position-lifecycle-extractor.ts";
import {
    discoverWalletDlmmPools,
    fetchWalletPositionsForPools,
    fetchTransactionsForPositions,
} from "./fabriq-analytics-client.ts";
import {
    savePositionAnalyticsDataset,
    loadPositionAnalyticsDataset,
    loadTransactionCheckpoint,
    saveTransactionCheckpoint,
} from "./position-analytics-storage.ts";
import { isValidSolanaAddress } from "../v1/single-wallet-intelligence.ts";

export interface BuildPositionDatasetOptions {
    wallet: string;
    period?: AnalyticsPeriod;
    force?: boolean;
    dryRun?: boolean;
    storageBaseDir?: string;
    onLog?: (msg: string) => void;
    signal?: AbortSignal;
    positionsConcurrency?: number;
    transactionsConcurrency?: number;
    requestTimeoutMs?: number;
}
export interface BuildPositionDatasetResult {
    success: boolean;
    dataset: PositionAnalyticsDataset | null;
    persistedPath: string | null;
    fromCache: boolean;
    error?: string;
}

/**
 * Execute the end-to-end position analytics dataset build.
 */
export async function executeBuildPositionDataset(
    options: BuildPositionDatasetOptions
): Promise<BuildPositionDatasetResult> {
    const t0 = Date.now();
    const log = options.onLog ?? ((msg: string) => console.log(msg));
    const wallet = options.wallet?.trim();
    const period: AnalyticsPeriod = options.period ?? "30D";
    const force = Boolean(options.force);
    const dryRun = Boolean(options.dryRun);

    if (!wallet || !isValidSolanaAddress(wallet)) {
        throw new Error(`INVALID_WALLET: "${wallet}" is not a valid Solana address.`);
    }

    if (period !== "30D" && period !== "90D" && period !== "ALL_AVAILABLE") {
        throw new Error(`INVALID_PERIOD: Period must be "30D", "90D", or "ALL_AVAILABLE". Received "${period}".`);
    }

    log(`=======================================================`);
    log(`[POSITION-ANALYTICS] Starting build for wallet: ${wallet}`);
    log(`[POSITION-ANALYTICS] Requested period: ${period} | Force: ${force}`);
    log(`=======================================================`);

    // 0. Check existing persistent snapshot if not forced
    if (!force) {
        const existing = loadPositionAnalyticsDataset(wallet, period, options.storageBaseDir);
        if (existing) {
            log(`[POSITION-ANALYTICS] Found valid cached dataset for ${wallet} (${period}). Returning cached snapshot.`);
            return {
                success: true,
                dataset: existing,
                persistedPath: null,
                fromCache: true,
            };
        }
    }

    // 1. STAGE: Pool discovery
    log(`[STAGE 1/7] Discovering DLMM pools...`);
    const poolDiscovery = await discoverWalletDlmmPools(wallet, {
        onLog: log,
        signal: options.signal,
        timeoutMs: options.requestTimeoutMs,
    });
    const dlmmPoolIds = poolDiscovery.dlmmPools.map((p) => p.poolId);

    if (dlmmPoolIds.length === 0) {
        log(`[WARN] No DLMM pools discovered for wallet: ${wallet}. Generating empty dataset.`);
        const emptyDataset = buildPositionAnalyticsDataset({
            wallet,
            period,
            rawPositions: [],
            rawEvents: [],
            fabriqPoolsDiscovered: poolDiscovery.allDiscoveredPools.length,
            dlmmPoolsMatched: 0,
            diagnostics: {
                executionMs: Date.now() - t0,
                poolPagesFetched: poolDiscovery.pagesFetched,
            },
        });

        let savedPath: string | null = null;
        if (!dryRun) {
            savedPath = savePositionAnalyticsDataset(emptyDataset, options.storageBaseDir);
        }

        return {
            success: true,
            dataset: emptyDataset,
            persistedPath: savedPath,
            fromCache: false,
        };
    }

    // 2. STAGE: Position extraction
    log(`[STAGE 2/7] Fetching closed positions across ${dlmmPoolIds.length} DLMM pools...`);
    const positionsResult = await fetchWalletPositionsForPools(wallet, dlmmPoolIds, {
        onLog: log,
        signal: options.signal,
        concurrency: options.positionsConcurrency,
        timeoutMs: options.requestTimeoutMs,
    });
    log(`[STAGE 2/7] Fetched ${positionsResult.positions.length} raw positions.`);

    // 3. STAGE: Deduplication & 4. STAGE: Latest-1000 selection
    log(`[STAGE 3/7] Deduplicating and sampling latest 1000 closed positions...`);
    // Pre-filter and sample positions to discover exact required position IDs for transactions
    const preDataset = buildPositionAnalyticsDataset({
        wallet,
        period,
        rawPositions: positionsResult.positions,
        rawEvents: [],
        fabriqPoolsDiscovered: poolDiscovery.allDiscoveredPools.length,
        dlmmPoolsMatched: dlmmPoolIds.length,
    });

    const selectedPositions = preDataset.positions;
    const selectedPositionIds = selectedPositions.map((p) => p.positionId);
    log(`[STAGE 4/7] Selected ${selectedPositions.length} positions (eligible: ${preDataset.sampling.totalEligiblePositions}, coverage: ${preDataset.sampling.coveragePct}%).`);

    // 5. STAGE: Transaction extraction
    log(`[STAGE 5/7] Fetching lifecycle transactions for ${selectedPositionIds.length} selected positions...`);
    const positionToPoolMap = new Map<string, string>();
    for (const p of selectedPositions) {
        positionToPoolMap.set(p.positionId, p.poolAddress);
    }

    let rawEvents = loadTransactionCheckpoint(wallet, selectedPositionIds);
    let txBatchesFetched = 0;
    let txRetries = 0;

    if (!rawEvents || force) {
        if (selectedPositionIds.length > 0) {
            const txResult = await fetchTransactionsForPositions(wallet, selectedPositionIds, positionToPoolMap, {
                onLog: log,
                signal: options.signal,
                concurrency: options.transactionsConcurrency,
                timeoutMs: options.requestTimeoutMs,
            });
            rawEvents = txResult.events;
            txBatchesFetched = txResult.batchesFetched;
            txRetries = txResult.retryCount ?? 0;
            saveTransactionCheckpoint(wallet, selectedPositionIds, rawEvents);
        } else {
            rawEvents = [];
        }
    } else {
        log(`[STAGE 5/7] Reused ${rawEvents.length} transactions from checkpoint.`);
    }

    // 6. STAGE: Initial entry validation & Metadata enrichment
    log(`[STAGE 6/7] Reconstructing lifecycle, verifying initial entries, and enriching metadata...`);
    const metadataCache = loadPoolMetadataCache();
    const finalDataset = buildPositionAnalyticsDataset({
        wallet,
        period,
        snapshotTimestampMs: t0,
        rawPositions: positionsResult.positions,
        rawEvents,
        fabriqPoolsDiscovered: poolDiscovery.allDiscoveredPools.length,
        dlmmPoolsMatched: dlmmPoolIds.length,
        metadataCache,
        diagnostics: {
            executionMs: Date.now() - t0,
            poolPagesFetched: poolDiscovery.pagesFetched,
            positionBatchesFetched: positionsResult.batchesFetched,
            transactionBatchesFetched: txBatchesFetched,
            requestRetries: (positionsResult.retryCount ?? 0) + txRetries,
        },
    });

    // 7. STAGE: Persistence
    log(`[STAGE 7/7] Persisting normalized dataset...`);
    let persistedPath: string | null = null;
    if (!dryRun) {
        persistedPath = savePositionAnalyticsDataset(finalDataset, options.storageBaseDir);
        log(`[POSITION-ANALYTICS] Dataset successfully written to: ${persistedPath}`);
    }

    // Print final summary
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
    log(`\n================ FINAL EXTRACTION SUMMARY ================`);
    log(`Wallet:                     ${finalDataset.wallet}`);
    log(`Period:                     ${finalDataset.period}`);
    log(`DLMM Pools Discovered:      ${finalDataset.sourceCoverage.dlmmPoolsMatched}`);
    log(`Total Positions Found:      ${finalDataset.sourceCoverage.totalPositionsFound}`);
    log(`Total Eligible Positions:   ${finalDataset.sampling.totalEligiblePositions}`);
    log(`Analyzed Positions:         ${finalDataset.sampling.analyzedPositions}`);
    log(`Excluded Older Positions:   ${finalDataset.sampling.excludedPositions}`);
    log(`Position Coverage:          ${finalDataset.sampling.coveragePct}%`);
    log(`Initial Entries Verified:   ${finalDataset.dataQuality.initialEntriesVerified}`);
    log(`First Observed Add Only:    ${finalDataset.dataQuality.firstObservedAddOnly}`);
    log(`Initial Entries Unavail:    ${finalDataset.dataQuality.initialEntriesUnavailable}`);
    log(`Initial Entry Coverage:     ${finalDataset.dataQuality.initialEntryCoveragePct}%`);
    log(`Full Lifecycle Positions:   ${finalDataset.dataQuality.fullLifecycleCoveragePositions}`);
    log(`Execution Duration:         ${elapsedSec}s`);
    log(`Output File:                ${persistedPath ?? "(dry-run)"}`);
    log(`==========================================================\n`);

    return {
        success: true,
        dataset: finalDataset,
        persistedPath,
        fromCache: false,
    };
}

function parseCliArgs(): {
    wallet: string | null;
    period: AnalyticsPeriod;
    force: boolean;
    dryRun: boolean;
    storageBaseDir?: string;
} {
    const args = process.argv.slice(2);
    let wallet: string | null = null;
    let period: AnalyticsPeriod = "30D";
    let force = false;
    let dryRun = false;
    let storageBaseDir: string | undefined = undefined;
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
        } else if (arg === "--storage-base-dir" && args[i + 1]) {
            storageBaseDir = args[i + 1].trim();
            i++;
        } else if (arg.startsWith("--storage-base-dir=")) {
            storageBaseDir = arg.slice(19).trim();
        }
    }
    return { wallet, period, force, dryRun, storageBaseDir };
}

// CLI Execution Entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const { wallet, period, force, dryRun, storageBaseDir } = parseCliArgs();

    if (!wallet) {
        console.error("Usage: node --experimental-strip-types scripts/analytics/build-position-dataset.ts --wallet <ADDRESS> [--period <30D|90D|ALL_AVAILABLE>] [--force] [--dry-run] [--storage-base-dir <DIR>]");
        process.exit(1);
    }

    executeBuildPositionDataset({
        wallet,
        period,
        force,
        dryRun,
        storageBaseDir,
    })
        .then((res) => {
            if (!res.success) {
                console.error(`ERROR: ${res.error || "Dataset build failed"}`);
                process.exit(1);
            }
        })
        .catch((err) => {
            console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        });
}
