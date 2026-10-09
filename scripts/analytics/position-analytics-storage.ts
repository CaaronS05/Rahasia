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

export interface CheckpointBatchRecord {
    batchIndex: number;
    positionIds: string[];
    eventCount: number;
    completedAt: string;
    events?: RawEventInput[];
}

export interface TransactionCheckpointCoverage {
    totalSelectedPositions: number;
    completedPositionsCount: number;
    totalBatches: number;
    completedBatchesCount: number;
    isComplete: boolean;
}

export interface TransactionCheckpoint {
    schemaVersion: "v2";
    wallet: string;
    savedAt: string;
    period?: AnalyticsPeriod;
    selectedPositionIds: string[];
    completedPositionIds: string[];
    completedBatchIndices: number[];
    batchRecords?: CheckpointBatchRecord[];
    events: RawEventInput[];
    isComplete: boolean;
    coverage: TransactionCheckpointCoverage;
    positionIds?: string[];
}

export interface LoadTransactionCheckpointOptions {
    maxAgeMs?: number;
    baseDir?: string;
    period?: AnalyticsPeriod;
}

/**
 * Get checkpoint path for transactions.
 */
export function getTransactionCheckpointPath(
    wallet: string,
    baseDir = DEFAULT_CHECKPOINT_STORAGE_BASE,
    period?: AnalyticsPeriod
): string {
    const filename = period ? `${wallet.trim()}-${period}-tx-events.json` : `${wallet.trim()}-tx-events.json`;
    return path.resolve(baseDir, filename);
}

/**
 * Load raw transaction checkpoint record if available, fresh, and matching selection identity.
 * Validates freshness and selection identity so that stale or different checkpoints are rejected.
 */
export function loadTransactionCheckpointRecord(
    wallet: string,
    selectedPositionIds: string[],
    options?: LoadTransactionCheckpointOptions
): TransactionCheckpoint | null {
    const baseDir = options?.baseDir ?? DEFAULT_CHECKPOINT_STORAGE_BASE;
    const maxAgeMs = options?.maxAgeMs ?? 4 * 60 * 60 * 1000;
    const normWallet = wallet.trim();

    let cpPath = options?.period
        ? getTransactionCheckpointPath(normWallet, baseDir, options.period)
        : getTransactionCheckpointPath(normWallet, baseDir);

    if (!fs.existsSync(cpPath)) {
        if (options?.period) {
            const fallbackPath = getTransactionCheckpointPath(normWallet, baseDir);
            if (fs.existsSync(fallbackPath)) {
                cpPath = fallbackPath;
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    try {
        const raw = fs.readFileSync(cpPath, "utf8");
        const cp = JSON.parse(raw) as any;

        if (!cp || typeof cp !== "object") return null;
        if (typeof cp.wallet !== "string" || cp.wallet.trim() !== normWallet) return null;
        if (!Array.isArray(cp.events)) return null;

        // Freshness validation
        const savedTime = new Date(cp.savedAt).getTime();
        if (!Number.isFinite(savedTime)) return null;
        const age = Date.now() - savedTime;
        if (age < 0 || age > maxAgeMs) {
            return null; // Expired
        }

        // Period validation if specified on both sides
        if (options?.period && cp.period && cp.period !== options.period) {
            return null; // Period mismatch
        }

        // Selection identity validation:
        // The checkpoint's selectedPositionIds MUST match selectedPositionIds exactly.
        const cpSelected: string[] = Array.isArray(cp.selectedPositionIds)
            ? cp.selectedPositionIds
            : Array.isArray(cp.positionIds)
            ? cp.positionIds
            : [];

        if (cpSelected.length !== selectedPositionIds.length) {
            return null; // Different position selection count
        }

        for (let i = 0; i < selectedPositionIds.length; i++) {
            if (cpSelected[i] !== selectedPositionIds[i]) {
                return null; // Selection content or order differs
            }
        }

        const completedIds: string[] = Array.isArray(cp.completedPositionIds)
            ? cp.completedPositionIds
            : Array.isArray(cp.positionIds)
            ? cp.positionIds
            : [];

        const isComplete = Boolean(cp.isComplete ?? (completedIds.length === selectedPositionIds.length));

        const completedIndices: number[] = Array.isArray(cp.completedBatchIndices)
            ? cp.completedBatchIndices
            : [];

        const coverage: TransactionCheckpointCoverage = cp.coverage && typeof cp.coverage === "object"
            ? cp.coverage
            : {
                totalSelectedPositions: selectedPositionIds.length,
                completedPositionsCount: completedIds.length,
                totalBatches: completedIndices.length || 1,
                completedBatchesCount: completedIndices.length || (isComplete ? 1 : 0),
                isComplete,
            };

        return {
            schemaVersion: "v2",
            wallet: normWallet,
            savedAt: cp.savedAt,
            period: cp.period ?? options?.period,
            selectedPositionIds,
            completedPositionIds: completedIds,
            completedBatchIndices: completedIndices,
            batchRecords: Array.isArray(cp.batchRecords) ? cp.batchRecords : undefined,
            events: cp.events,
            isComplete,
            coverage,
            positionIds: completedIds,
        };
    } catch {
        return null;
    }
}

/**
 * Load completed transaction checkpoint events if available, fresh, matching selection,
 * and completely finished.
 * Never returns events for an incomplete / partial checkpoint.
 */
export function loadTransactionCheckpoint(
    wallet: string,
    positionIds: string[],
    options?: LoadTransactionCheckpointOptions
): RawEventInput[] | null {
    const cp = loadTransactionCheckpointRecord(wallet, positionIds, options);
    if (!cp || !cp.isComplete) {
        return null;
    }
    const covered = new Set(cp.completedPositionIds);
    const allCovered = positionIds.every((id) => covered.has(id));
    if (!allCovered) {
        return null;
    }
    return cp.events;
}

/**
 * Save transaction checkpoint atomically.
 */
export function saveTransactionCheckpointRecord(
    checkpoint: TransactionCheckpoint,
    options?: { baseDir?: string; period?: AnalyticsPeriod }
): string {
    const baseDir = options?.baseDir ?? DEFAULT_CHECKPOINT_STORAGE_BASE;
    const period = options?.period ?? checkpoint.period;
    const cpPath = getTransactionCheckpointPath(checkpoint.wallet, baseDir, period);
    atomicWriteJsonFile(cpPath, checkpoint);
    return cpPath;
}

/**
 * Save transaction checkpoint atomically (backwards-compatible wrapper).
 */
export function saveTransactionCheckpoint(
    wallet: string,
    positionIds: string[],
    events: RawEventInput[],
    baseDir = DEFAULT_CHECKPOINT_STORAGE_BASE,
    period?: AnalyticsPeriod
): void {
    const checkpoint: TransactionCheckpoint = {
        schemaVersion: "v2",
        wallet: wallet.trim(),
        savedAt: new Date().toISOString(),
        period,
        selectedPositionIds: positionIds,
        completedPositionIds: positionIds,
        completedBatchIndices: [0],
        events,
        isComplete: true,
        coverage: {
            totalSelectedPositions: positionIds.length,
            completedPositionsCount: positionIds.length,
            totalBatches: 1,
            completedBatchesCount: 1,
            isComplete: true,
        },
        positionIds,
    };
    saveTransactionCheckpointRecord(checkpoint, { baseDir, period });
}
