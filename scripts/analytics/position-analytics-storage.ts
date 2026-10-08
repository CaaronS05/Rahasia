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
    if (!fs.existsSync(targetPath)) {
        return null;
    }

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
    if (!fs.existsSync(filePath)) {
        return null;
    }

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

    return null;
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
