import fs from "node:fs";
import path from "node:path";
import type {
    AnalyticsPeriod,
    PositionAnalyticsDataset,
    PositionMetricsResult,
} from "./position-analytics-types.ts";
import type { RawEventInput } from "./position-lifecycle-extractor.ts";

export const DEFAULT_ANALYTICS_STORAGE_BASE = "data/analytics/positions";
export const DEFAULT_CHECKPOINT_STORAGE_BASE = "data/analytics/checkpoints";
export const DEFAULT_METRICS_STORAGE_BASE = "data/analytics/metrics";
export const DEFAULT_BUNDLES_STORAGE_BASE = "data/analytics/bundles";

export interface PositionAnalyticsBundle {
    schemaVersion: "v1";
    wallet: string;
    period: AnalyticsPeriod;
    publishedAt: string;
    dataset: PositionAnalyticsDataset;
    metrics: PositionMetricsResult;
}

export interface PublishPositionAnalyticsPairOptions {
    wallet: string;
    period: AnalyticsPeriod;
    dataset: PositionAnalyticsDataset;
    metrics: PositionMetricsResult;
    bundlesBaseDir?: string;
    _beforeCommitHook?: () => void;
}

export interface PublishedPositionPair {
    dataset: PositionAnalyticsDataset | null;
    metrics: PositionMetricsResult | null;
    publishedAt: string | null;
    isBundle: boolean;
}

/**
 * Get the standardized path for a wallet period published bundle.
 */
export function getBundleFilePath(
    wallet: string,
    period: AnalyticsPeriod,
    baseDir = DEFAULT_BUNDLES_STORAGE_BASE
): string {
    return path.resolve(baseDir, wallet.trim(), `${period}.json`);
}
/**
 * Get the standardized path for a wallet period dataset.
 */
export function getDatasetFilePath(
    wallet: string,
    period: AnalyticsPeriod,
    baseDir = DEFAULT_ANALYTICS_STORAGE_BASE
): string {
    return path.resolve(baseDir, wallet.trim(), `${period}.json`);
}

/**
 * Atomically write a JSON file to disk via temporary file rename.
 */
export function atomicWriteJsonFile(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, filePath);
}

/**
 * Load an existing dataset snapshot if available.
 */
export function loadPositionAnalyticsDataset(
    wallet: string,
    period: AnalyticsPeriod,
    baseDir = DEFAULT_ANALYTICS_STORAGE_BASE
): PositionAnalyticsDataset | null {
    const targetPath = getDatasetFilePath(wallet, period, baseDir);
    if (fs.existsSync(targetPath)) {
        try {
            const raw = fs.readFileSync(targetPath, "utf8");
            const parsed = JSON.parse(raw);
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.schemaVersion === "v1" &&
                parsed.wallet === wallet.trim() &&
                parsed.period === period &&
                Array.isArray(parsed.positions)
            ) {
                return parsed as PositionAnalyticsDataset;
            }
        } catch {
            return null;
        }
    }

    // Fallback: check published bundle when querying default analytics storage
    if (path.resolve(baseDir) === path.resolve(DEFAULT_ANALYTICS_STORAGE_BASE)) {
        const pair = loadPublishedPositionPair(wallet, period);
        if (pair?.dataset) {
            return pair.dataset;
        }
    }

    return null;
}

/**
 * Persist position analytics dataset atomically.
 */
export function savePositionAnalyticsDataset(
    dataset: PositionAnalyticsDataset,
    baseDir = DEFAULT_ANALYTICS_STORAGE_BASE
): string {
    const targetPath = getDatasetFilePath(dataset.wallet, dataset.period, baseDir);
    atomicWriteJsonFile(targetPath, dataset);
    return targetPath;
}

/**
 * Get the standardized path for wallet period metrics output.
 */
export function getMetricsFilePath(
    wallet: string,
    period: AnalyticsPeriod,
    baseDir = DEFAULT_METRICS_STORAGE_BASE
): string {
    return path.resolve(baseDir, wallet.trim(), `${period}.json`);
}

/**
 * Load existing position metrics result if available and valid.
 * If expectedFetchedAt is specified, validates that the cached metrics match
 * the source dataset snapshot provenance.
 */
export function loadPositionMetrics(
    wallet: string,
    period: AnalyticsPeriod,
    baseDir = DEFAULT_METRICS_STORAGE_BASE,
    expectedFetchedAt?: string
): PositionMetricsResult | null {
    const filePath = getMetricsFilePath(wallet, period, baseDir);
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.schemaVersion === "v1" &&
                parsed.wallet?.toLowerCase() === wallet.trim().toLowerCase() &&
                parsed.period === period &&
                parsed.capital &&
                parsed.profitability
            ) {
                if (expectedFetchedAt && parsed.sourceDatasetFetchedAt !== expectedFetchedAt) {
                    return null;
                }
                return parsed as PositionMetricsResult;
            }
        } catch {
            return null;
        }
    }

    // Fallback: check published bundle when querying default metrics storage
    if (path.resolve(baseDir) === path.resolve(DEFAULT_METRICS_STORAGE_BASE)) {
        const pair = loadPublishedPositionPair(wallet, period);
        if (pair?.metrics) {
            if (expectedFetchedAt && pair.metrics.sourceDatasetFetchedAt !== expectedFetchedAt) {
                return null;
            }
            return pair.metrics;
        }
    }

    return null;
}

/**
 * Publish dataset and metrics pair in a single atomic commit.
 * Guarantees that a failed or interrupted publication cannot leave mismatched versions.
 */
export function publishPositionAnalyticsPair(
    options: PublishPositionAnalyticsPairOptions
): { bundlePath: string; publishedAt: string } {
    const {
        wallet,
        period,
        dataset,
        metrics,
        bundlesBaseDir = DEFAULT_BUNDLES_STORAGE_BASE,
        _beforeCommitHook,
    } = options;

    const normWallet = wallet.trim();

    if (!dataset || !metrics) {
        throw new Error("Cannot publish position analytics: both dataset and metrics are required.");
    }

    // Invariant: metrics.sourceDatasetFetchedAt === positions.fetchedAt
    if (metrics.sourceDatasetFetchedAt !== dataset.fetchedAt) {
        throw new Error(
            `Publication invariant violation: metrics.sourceDatasetFetchedAt (${metrics.sourceDatasetFetchedAt}) !== positions.fetchedAt (${dataset.fetchedAt})`
        );
    }

    if (dataset.wallet.toLowerCase() !== normWallet.toLowerCase()) {
        throw new Error(`Dataset wallet (${dataset.wallet}) does not match target wallet (${normWallet})`);
    }
    if (metrics.wallet.toLowerCase() !== normWallet.toLowerCase()) {
        throw new Error(`Metrics wallet (${metrics.wallet}) does not match target wallet (${normWallet})`);
    }
    if (dataset.period !== period || metrics.period !== period) {
        throw new Error(`Dataset/metrics period mismatch with target period (${period})`);
    }

    const bundlePath = getBundleFilePath(normWallet, period, bundlesBaseDir);
    const bundleDir = path.dirname(bundlePath);
    if (!fs.existsSync(bundleDir)) {
        fs.mkdirSync(bundleDir, { recursive: true });
    }

    const publishedAt = new Date().toISOString();
    const bundle: PositionAnalyticsBundle = {
        schemaVersion: "v1",
        wallet: normWallet,
        period,
        publishedAt,
        dataset,
        metrics,
    };

    // Stage temporary file in destination directory for atomic same-filesystem rename
    const tempPath = `${bundlePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");

    try {
        if (_beforeCommitHook) {
            _beforeCommitHook();
        }
        // Atomic single-commit rename
        fs.renameSync(tempPath, bundlePath);
    } catch (err) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // Ignore temp file cleanup error
        }
        throw err;
    }

    return { bundlePath, publishedAt };
}

/**
 * Load a published dataset+metrics pair.
 * Consumes atomic bundle first; falls back to legacy separate snapshots if bundle is absent.
 * Rejects legacy pairs if versions do not match (metrics.sourceDatasetFetchedAt !== positions.fetchedAt).
 */
export function loadPublishedPositionPair(
    wallet: string,
    period: AnalyticsPeriod,
    options?: {
        bundlesBaseDir?: string;
        positionsBaseDir?: string;
        metricsBaseDir?: string;
    }
): PublishedPositionPair | null {
    const norm = wallet.trim();
    const bundlesBase = options?.bundlesBaseDir ?? DEFAULT_BUNDLES_STORAGE_BASE;
    const positionsBase = options?.positionsBaseDir ?? DEFAULT_ANALYTICS_STORAGE_BASE;
    const metricsBase = options?.metricsBaseDir ?? DEFAULT_METRICS_STORAGE_BASE;

    // 1. Try atomic bundle first
    const bundlePath = getBundleFilePath(norm, period, bundlesBase);
    if (fs.existsSync(bundlePath)) {
        try {
            const raw = fs.readFileSync(bundlePath, "utf8");
            const bundle = JSON.parse(raw);
            if (
                bundle &&
                typeof bundle === "object" &&
                bundle.schemaVersion === "v1" &&
                bundle.wallet?.toLowerCase() === norm.toLowerCase() &&
                bundle.period === period &&
                bundle.dataset &&
                bundle.metrics
            ) {
                if (
                    bundle.dataset.fetchedAt &&
                    bundle.metrics.sourceDatasetFetchedAt === bundle.dataset.fetchedAt
                ) {
                    return {
                        dataset: bundle.dataset as PositionAnalyticsDataset,
                        metrics: bundle.metrics as PositionMetricsResult,
                        publishedAt: bundle.publishedAt || bundle.metrics.generatedAt || bundle.dataset.fetchedAt,
                        isBundle: true,
                    };
                }
            }
        } catch {
            // Unreadable bundle, fall through
        }
    }

    // 2. Legacy fallback: check separate files
    const datasetPath = getDatasetFilePath(norm, period, positionsBase);
    const metricsPath = getMetricsFilePath(norm, period, metricsBase);
    const hasDataset = fs.existsSync(datasetPath);
    const hasMetrics = fs.existsSync(metricsPath);

    if (!hasDataset && !hasMetrics) {
        return null;
    }

    let dataset: PositionAnalyticsDataset | null = null;
    let metrics: PositionMetricsResult | null = null;

    if (hasDataset) {
        try {
            const raw = fs.readFileSync(datasetPath, "utf8");
            const parsed = JSON.parse(raw);
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.schemaVersion === "v1" &&
                parsed.wallet?.toLowerCase() === norm.toLowerCase() &&
                parsed.period === period
            ) {
                dataset = parsed as PositionAnalyticsDataset;
            }
        } catch {}
    }

    if (hasMetrics) {
        try {
            const raw = fs.readFileSync(metricsPath, "utf8");
            const parsed = JSON.parse(raw);
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.schemaVersion === "v1" &&
                parsed.wallet?.toLowerCase() === norm.toLowerCase() &&
                parsed.period === period
            ) {
                metrics = parsed as PositionMetricsResult;
            }
        } catch {}
    }

    // Invariant check on legacy snapshot: verify fetchedAt alignment if both exist
    if (dataset && metrics) {
        if (
            metrics.sourceDatasetFetchedAt &&
            dataset.fetchedAt &&
            metrics.sourceDatasetFetchedAt !== dataset.fetchedAt
        ) {
            // Mismatched legacy versions: reject to avoid exposing inconsistent data
            return null;
        }
    }

    if (!dataset && !metrics) {
        return null;
    }

    return {
        dataset,
        metrics,
        publishedAt: metrics?.generatedAt || metrics?.sourceDatasetFetchedAt || dataset?.fetchedAt || null,
        isBundle: false,
    };
}

/**
 * Persist position metrics result atomically.
 */
export function savePositionMetrics(
    metrics: PositionMetricsResult,
    baseDir = DEFAULT_METRICS_STORAGE_BASE
): string {
    const targetPath = getMetricsFilePath(metrics.wallet, metrics.period, baseDir);
    atomicWriteJsonFile(targetPath, metrics);
    return targetPath;
}

export interface TransactionCheckpoint {
    wallet: string;
    savedAt: string;
    positionIds: string[];
    events: RawEventInput[];
}

/**
 * Get checkpoint path for transactions.
 */
export function getTransactionCheckpointPath(
    wallet: string,
    baseDir = DEFAULT_CHECKPOINT_STORAGE_BASE
): string {
    return path.resolve(baseDir, `${wallet.trim()}-tx-events.json`);
}

/**
 * Load transaction checkpoint if available and freshness is within maxAgeMs (default: 4 hours).
 */
export function loadTransactionCheckpoint(
    wallet: string,
    positionIds: string[],
    options?: { maxAgeMs?: number; baseDir?: string }
): RawEventInput[] | null {
    const baseDir = options?.baseDir ?? DEFAULT_CHECKPOINT_STORAGE_BASE;
    const maxAgeMs = options?.maxAgeMs ?? 4 * 60 * 60 * 1000;
    const cpPath = getTransactionCheckpointPath(wallet, baseDir);

    if (!fs.existsSync(cpPath)) return null;

    try {
        const raw = fs.readFileSync(cpPath, "utf8");
        const cp = JSON.parse(raw) as TransactionCheckpoint;

        if (!cp || cp.wallet !== wallet.trim() || !Array.isArray(cp.events)) {
            return null;
        }

        const age = Date.now() - new Date(cp.savedAt).getTime();
        if (age > maxAgeMs) {
            return null; // Expired
        }

        // Check if all requested positionIds are covered in the checkpoint
        const covered = new Set(cp.positionIds || []);
        const allCovered = positionIds.every((id) => covered.has(id));
        if (!allCovered) {
            return null; // Partial coverage, need fresh
        }

        return cp.events;
    } catch {
        return null;
    }
}

/**
 * Save transaction checkpoint atomically.
 */
export function saveTransactionCheckpoint(
    wallet: string,
    positionIds: string[],
    events: RawEventInput[],
    baseDir = DEFAULT_CHECKPOINT_STORAGE_BASE
): void {
    const cpPath = getTransactionCheckpointPath(wallet, baseDir);
    const cp: TransactionCheckpoint = {
        wallet: wallet.trim(),
        savedAt: new Date().toISOString(),
        positionIds,
        events,
    };
    atomicWriteJsonFile(cpPath, cp);
}
