import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const DEFAULT_SNAPSHOT_PATH = path.resolve(
    "frontend/public/data/wallets-14d.json"
);

export const DEFAULT_TARGET_MANIFEST_PATH = path.resolve(
    "data/checkpoints/fabriq-targets.json"
);

/**
 * Validates whether a given string is a valid Solana wallet address.
 */
export function validateSolanaAddress(address) {
    if (typeof address !== "string") {
        return false;
    }
    const trimmed = address.trim();
    return SOLANA_ADDRESS_REGEX.test(trimmed);
}

/**
 * Computes a SHA-256 hash of a file or string.
 */
export function computeSha256(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Extracts and deduplicates all valid Solana wallet owners from a published snapshot.
 * Rejects empty, invalid, or corrupt source datasets.
 * Reports population count and source breakdown.
 */
export function extractSnapshotTargets(snapshotSource) {
    let raw = snapshotSource;
    let sourcePath = null;
    let contentHash = null;

    if (typeof snapshotSource === "string") {
        sourcePath = path.resolve(snapshotSource);
        if (!fsSync.existsSync(sourcePath)) {
            throw new Error(`Snapshot file not found: ${sourcePath}`);
        }
        const fileContent = fsSync.readFileSync(sourcePath, "utf8");
        if (!fileContent || !fileContent.trim()) {
            throw new Error(`Snapshot file is empty: ${sourcePath}`);
        }
        try {
            raw = JSON.parse(fileContent);
        } catch (err) {
            throw new Error(
                `Snapshot file contains corrupt or invalid JSON: ${sourcePath} (${err.message})`
            );
        }
        contentHash = computeSha256(fileContent);
    }

    if (!raw || typeof raw !== "object") {
        throw new Error(
            "Invalid snapshot dataset: root must be an object or array"
        );
    }

    let rows = null;
    if (Array.isArray(raw)) {
        rows = raw;
    } else if (Array.isArray(raw.wallets)) {
        rows = raw.wallets;
    } else if (Array.isArray(raw.data)) {
        rows = raw.data;
    }

    if (!rows || !Array.isArray(rows)) {
        throw new Error(
            "Invalid snapshot dataset: missing 'wallets' array"
        );
    }

    if (rows.length === 0) {
        throw new Error(
            "Invalid snapshot dataset: wallets array is empty"
        );
    }

    const seenOwners = new Set();
    const targets = [];
    let lpAgentCount = 0;
    let poolScannerCount = 0;

    for (const row of rows) {
        if (!row || typeof row !== "object") {
            continue;
        }

        const owner = (
            row.owner ??
            row.wallet ??
            row.wallet_address ??
            ""
        ).trim();

        if (!validateSolanaAddress(owner)) {
            continue;
        }

        if (seenOwners.has(owner)) {
            // Deduplicate: same owner appearing multiple times counts as exactly ONE target
            continue;
        }

        seenOwners.add(owner);
        targets.push(owner);

        // Detect provenance source
        const source = (
            row.source ??
            (row.scannedPoolCount && !row.smart_lp ? "pool-scanner" : "lpagent")
        );

        if (source === "pool-scanner") {
            poolScannerCount++;
        } else {
            lpAgentCount++;
        }
    }

    if (targets.length === 0) {
        throw new Error(
            "Invalid snapshot dataset: no valid Solana wallet addresses found"
        );
    }

    return {
        total: targets.length,
        lpAgentCount,
        poolScannerCount,
        targets,
        metadata: {
            snapshotPath: sourcePath,
            snapshotHash: contentHash,
            extractedAt: new Date().toISOString(),
        },
    };
}

/**
 * Gets or freezes the snapshot target list.
 * Preserves the target list across Stop & Save Progress and Resume.
 * If resuming and snapshot identity changes on disk, safely preserves the frozen target list.
 */
export async function getOrFreezeSnapshotTargets({
    snapshotPath = DEFAULT_SNAPSHOT_PATH,
    manifestPath = DEFAULT_TARGET_MANIFEST_PATH,
    isResume = false,
    mode = null,
} = {}) {
    const resolvedSnapshot = path.resolve(snapshotPath);
    const resolvedManifest = path.resolve(manifestPath);

    if (isResume && fsSync.existsSync(resolvedManifest)) {
        try {
            const manifestContent = await fs.readFile(resolvedManifest, "utf8");
            const frozen = JSON.parse(manifestContent);
            if (
                frozen &&
                Array.isArray(frozen.targets) &&
                frozen.targets.length > 0
            ) {
                // Check if snapshot file identity changed on disk
                let currentHash = null;
                if (fsSync.existsSync(resolvedSnapshot)) {
                    const currentContent = await fs.readFile(resolvedSnapshot, "utf8");
                    currentHash = computeSha256(currentContent);
                }

                const hashChanged =
                    Boolean(frozen.snapshotHash && currentHash && frozen.snapshotHash !== currentHash);

                return {
                    total: frozen.targets.length,
                    lpAgentCount: frozen.lpAgentCount ?? 0,
                    poolScannerCount: frozen.poolScannerCount ?? 0,
                    targets: frozen.targets,
                    isResumed: true,
                    hashChanged,
                    metadata: {
                        snapshotPath: frozen.snapshotPath ?? resolvedSnapshot,
                        snapshotHash: frozen.snapshotHash,
                        resumedAt: new Date().toISOString(),
                    },
                };
            }
        } catch (err) {
            console.warn(
                `[SNAPSHOT] Failed to read frozen manifest ${resolvedManifest}: ${err.message}. Falling back to fresh snapshot extraction.`
            );
        }
    }

    // New run (or resume fallback when manifest was missing): extract fresh from snapshot
    const extracted = extractSnapshotTargets(resolvedSnapshot);

    // Save frozen manifest
    await fs.mkdir(path.dirname(resolvedManifest), { recursive: true });
    const manifestPayload = {
        snapshotPath: resolvedSnapshot,
        snapshotHash: extracted.metadata.snapshotHash,
        total: extracted.total,
        lpAgentCount: extracted.lpAgentCount,
        poolScannerCount: extracted.poolScannerCount,
        targets: extracted.targets,
        mode,
        createdAt: new Date().toISOString(),
    };

    await fs.writeFile(
        resolvedManifest,
        JSON.stringify(manifestPayload, null, 2),
        "utf8"
    );

    return {
        ...extracted,
        isResumed: false,
        hashChanged: false,
    };
}

/**
 * Discards frozen target manifest.
 */
export function discardFrozenTargets(manifestPath = DEFAULT_TARGET_MANIFEST_PATH) {
    try {
        const resolvedManifest = path.resolve(manifestPath);
        if (fsSync.existsSync(resolvedManifest)) {
            fsSync.unlinkSync(resolvedManifest);
        }
    } catch (err) {
        console.error("Failed to discard frozen targets:", err);
    }
}

/**
 * Quick summary of current published snapshot without freezing.
 */
export function getSnapshotTargetSummary(snapshotPath = DEFAULT_SNAPSHOT_PATH) {
    try {
        const resolved = path.resolve(snapshotPath);
        if (!fsSync.existsSync(resolved)) {
            return null;
        }
        return extractSnapshotTargets(resolved);
    } catch {
        return null;
    }
}
