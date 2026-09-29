import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    fetchFabriqClosedPositionHistory,
    closeFabriqConnection,
    type FabriqClosedPositionHistoryResult,
} from "./core/fabriq-position-history.ts";
import {
    buildFabriqPositionHistory,
    type PositionLifecycleRecord,
} from "./core/build-position-history.ts";

const DEFAULT_WALLET = "Hg9WqUWiXMqdv2NoTRVNY9j282QTSV1fsbm64GcFv8Rk";
const REFERENCE_POOL = "Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf";

function parseCliArgs() {
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

    return options;
}

function getDirectoryFingerprint(dirPath: string): string | null {
    if (!fs.existsSync(dirPath)) return null;
    const hash = crypto.createHash("sha256");

    function walk(current: string) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            hash.update(path.relative(dirPath, fullPath));
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const content = fs.readFileSync(fullPath);
                hash.update(content);
            }
        }
    }

    walk(dirPath);
    return hash.digest("hex");
}

function getFileFingerprint(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
        return getDirectoryFingerprint(filePath);
    }
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
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

async function main() {
    try {
        const args = parseCliArgs();

    const walletAddress =
        args.wallet ||
        process.env.WALLET_ADDRESS ||
        DEFAULT_WALLET;

    const maxPools = args["max-pools"] ? Number(args["max-pools"]) : undefined;
    const positionBatchSize = args["position-batch-size"]
        ? Number(args["position-batch-size"])
        : 20;
    const canonicalPoolsPath = args["canonical-pools"] || undefined;

    console.log("========================================");
    console.log("WALDISC-2 — FABRIQ CLOSED-POSITION PROOF");
    console.log("========================================");
    console.log(`Wallet Address      : ${walletAddress}`);
    if (maxPools !== undefined) {
        console.log(`Max Pools Limit     : ${maxPools}`);
    }
    console.log(`Position Batch Size : ${positionBatchSize}`);
    console.log("----------------------------------------");

    // 1. Baseline fingerprint checks before run (Safety verification)
    const baselineMaster = getFileFingerprint("data/master/wallets-master.json");
    const baselineFrontend = getFileFingerprint("frontend/public/data/wallets-14d.json");
    const baselineRawFabriq = getFileFingerprint("data/raw/fabriq");
    const baselinePoolScanner = getFileFingerprint("scripts/pool-scanner-v1.mjs");

    // 2. Fetch Fabriq closed position history
    const fabriqResult: FabriqClosedPositionHistoryResult =
        await fetchFabriqClosedPositionHistory(walletAddress, {
            maxPools,
            positionBatchSize,
            canonicalPoolsPath,
            onLog: (msg) => console.log(msg),
        });

    // 3. Build position lifecycle records
    const positionHistoryResult = buildFabriqPositionHistory(
        walletAddress,
        fabriqResult.positions,
        fabriqResult.events
    );

    const positions = positionHistoryResult.positions;

    // 4. Comparison against WALDISC-1 reference
    let expectedPositions: string[] = [];
    const refPath = path.resolve(
        `data/discovery/waldisc-1/${REFERENCE_POOL}/wallets.json`
    );

    let referenceFileFound = false;
    if (fs.existsSync(refPath)) {
        try {
            const refWallets = JSON.parse(fs.readFileSync(refPath, "utf8"));
            if (Array.isArray(refWallets)) {
                referenceFileFound = true;
                const match = refWallets.find((w: any) => w.owner === walletAddress);
                if (match && Array.isArray(match.positions)) {
                    expectedPositions = match.positions.slice().sort();
                }
            }
        } catch (err) {
            console.error(`Warning: failed to read reference wallets.json: ${err}`);
        }
    }

    const hasReferencePool = fabriqResult.pools.some(
        (p) => p.pool_id === REFERENCE_POOL
    );

    const fabriqPositionsForRefPool = Array.from(
        new Set(
            positions
                .filter((p) => p.pool === REFERENCE_POOL)
                .map((p) => p.position)
        )
    ).sort();

    const expectedSet = new Set(expectedPositions);
    const fabriqSet = new Set(fabriqPositionsForRefPool);

    const matchedPositions = expectedPositions.filter((p) => fabriqSet.has(p));
    const missingPositions = expectedPositions.filter((p) => !fabriqSet.has(p));
    const extraPositions = fabriqPositionsForRefPool.filter(
        (p) => !expectedSet.has(p)
    );

    const expectedCount = expectedPositions.length;
    const fabriqCount = fabriqPositionsForRefPool.length;
    const matchedCount = matchedPositions.length;

    const expectedCoveragePct =
        expectedCount === 0 ? 0 : (matchedCount / expectedCount) * 100;

    const expectedCoverageComplete =
        expectedCount > 0 && missingPositions.length === 0;

    const comparison = {
        referencePool: REFERENCE_POOL,
        comparisonMode: "expected_subset_of_fabriq",
        expectedPositions,
        fabriqPositions: fabriqPositionsForRefPool,
        matchedPositions,
        missingPositions,
        extraPositions,
        expectedCount,
        fabriqCount,
        matchedCount,
        expectedCoveragePct,
        expectedCoverageComplete,
    };

    // 5. Output directory & files
    const outDir = path.resolve(`data/discovery/waldisc-2/${walletAddress}`);

    // Read previous closed position addresses before overwriting positions.json
    const previousPositionsPath = path.join(outDir, "positions.json");
    let previousClosedPositionAddresses: Set<string> | null = null;

    if (fs.existsSync(previousPositionsPath)) {
        try {
            const prevContent = fs.readFileSync(previousPositionsPath, "utf8");
            const prevData = JSON.parse(prevContent);
            if (Array.isArray(prevData)) {
                const prevSet = new Set<string>();
                for (const p of prevData) {
                    const status = String(p?.status || "").trim().toUpperCase();
                    if (status === "CLOSED") {
                        const addr = String(p?.position || p?.id || "").trim();
                        if (addr) prevSet.add(addr);
                    }
                }
                previousClosedPositionAddresses = prevSet;
            }
        } catch {
            previousClosedPositionAddresses = null;
        }
    }

    // Build the canonical current CLOSED position set from newly generated positions
    const currentClosedPositions = positions.filter(
        (p) => String(p.status || "").trim().toUpperCase() === "CLOSED"
    );
    const currentClosedPositionAddresses = new Set(
        currentClosedPositions
            .map((p) => String(p.position || "").trim())
            .filter((addr) => addr.length > 0)
    );

    // Detect position set change
    let positionSetChanged = false;
    if (previousClosedPositionAddresses === null) {
        positionSetChanged = true;
    } else if (
        previousClosedPositionAddresses.size !== currentClosedPositionAddresses.size
    ) {
        positionSetChanged = true;
    } else {
        for (const addr of previousClosedPositionAddresses) {
            if (!currentClosedPositionAddresses.has(addr)) {
                positionSetChanged = true;
                break;
            }
        }
    }

    const summary = {
        wallet: walletAddress,
        generatedAt: new Date().toISOString(),
        source: "fabriq",
        scope: {
            protocol: "meteora_dlmm",
            poolUniverse: "legacy_dlmm",
            canonicalPoolFilterApplied: true,
            fabriqPoolsDiscovered: fabriqResult.scope.fabriqPoolsDiscovered,
            eligibleLegacyPools: fabriqResult.scope.eligibleLegacyPools,
            excludedNonLegacyPools: fabriqResult.scope.excludedNonLegacyPools,
            ...(fabriqResult.scope.eligibleLegacyPoolsAfterLimit !== undefined
                ? {
                      eligibleLegacyPoolsAfterLimit:
                          fabriqResult.scope.eligibleLegacyPoolsAfterLimit,
                  }
                : {}),
        },
        lifecycleScope: "closed_positions_only",

        poolPagesFetched: fabriqResult.poolPagesFetched,
        poolsFetched: fabriqResult.poolsFetched,
        positionsFetched: fabriqResult.positionsFetched,
        transactionEventsFetched: fabriqResult.transactionEventsFetched,
        uniquePositions: fabriqResult.uniquePositions,
        uniquePools: fabriqResult.uniquePools,

        eventTypeCounts: fabriqResult.eventTypeCounts,
        unknownTypes: fabriqResult.unknownTypes,

        positionsClosed: positionHistoryResult.positionsClosed,
        positionsPartialHistory: positionHistoryResult.positionsPartialHistory,

        walletSourcePositions: fabriqResult.walletSourcePositions,
        hawkfiSourcePositions: fabriqResult.hawkfiSourcePositions,

        referenceExpectedCount: expectedCount,
        referenceMatchedCount: matchedCount,
        referenceMissingCount: missingPositions.length,
        referenceCoveragePct: expectedCoveragePct,
        referenceCoverageComplete: expectedCoverageComplete,
    };

    atomicWriteJson(path.join(outDir, "summary.json"), summary);
    atomicWriteJson(path.join(outDir, "pools.json"), fabriqResult.pools);
    atomicWriteJson(path.join(outDir, "fabriq-positions.json"), fabriqResult.positions);
    atomicWriteJson(path.join(outDir, "events.json"), fabriqResult.events);
    atomicWriteJson(path.join(outDir, "positions.json"), positions);
    atomicWriteJson(path.join(outDir, "comparison.json"), comparison);

    // 6. Stale downstream artifact cleanup
    let removedVerificationCount = 0;
    const verificationDir = path.join(outDir, "verification");
    if (fs.existsSync(verificationDir)) {
        const files = fs.readdirSync(verificationDir);
        for (const file of files) {
            if (!file.endsWith(".json")) continue;
            const posAddr = file.slice(0, -5);
            if (!currentClosedPositionAddresses.has(posAddr)) {
                try {
                    fs.unlinkSync(path.join(verificationDir, file));
                    removedVerificationCount++;
                } catch (err: any) {
                    console.warn(
                        `[STALE] Warning: failed to delete ${file}: ${err.message}`
                    );
                }
            }
        }
    }

    let removedStrategyCount = 0;
    const strategyDirs = [
        path.join(outDir, "strategy"),
        path.join(outDir, "strategy-decoded"),
        path.join(outDir, "strategy-derived"),
        path.join(outDir, "strategy-normalized"),
    ];

    for (const dir of strategyDirs) {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (!file.endsWith(".json")) continue;
                const posAddr = file.slice(0, -5);
                if (!currentClosedPositionAddresses.has(posAddr)) {
                    try {
                        fs.unlinkSync(path.join(dir, file));
                        removedStrategyCount++;
                    } catch (err: any) {
                        console.warn(
                            `[STALE] Warning: failed to delete ${file}: ${err.message}`
                        );
                    }
                }
            }
        }
    }

    let invalidatedAggregatesCount = 0;
    if (positionSetChanged || currentClosedPositionAddresses.size === 0) {
        const aggregateFiles = [
            path.join(outDir, "strategy-batch-summary.json"),
            path.join(outDir, "wallet-behaviour.json"),
        ];

        for (const aggFile of aggregateFiles) {
            if (fs.existsSync(aggFile)) {
                try {
                    fs.unlinkSync(aggFile);
                    invalidatedAggregatesCount++;
                } catch (err: any) {
                    console.warn(
                        `[STALE] Warning: failed to remove aggregate ${path.basename(aggFile)}: ${err.message}`
                    );
                }
            }
        }
    }

    console.log(`\n[OUTPUT] Written to: ${outDir}`);

    const prevCountStr =
        previousClosedPositionAddresses !== null
            ? String(previousClosedPositionAddresses.size)
            : "0";
    console.log(`[STALE] Previous closed positions: ${prevCountStr}`);
    console.log(
        `[STALE] Current canonical closed positions: ${currentClosedPositionAddresses.size}`
    );
    console.log(`[STALE] Position set changed: ${positionSetChanged ? "YES" : "NO"}`);

    const hasStale =
        removedVerificationCount > 0 ||
        removedStrategyCount > 0 ||
        invalidatedAggregatesCount > 0;

    if (hasStale) {
        console.log(
            `[STALE] Removed stale verification artifacts: ${removedVerificationCount}`
        );
        console.log(
            `[STALE] Removed stale strategy artifacts: ${removedStrategyCount}`
        );
        console.log(
            `[STALE] Invalidated wallet-level aggregates: ${invalidatedAggregatesCount}`
        );
    } else {
        console.log(`[STALE] No stale downstream artifacts found`);
    }

    // 7. Post-scan fingerprint checks & output directory safety
    const afterMaster = getFileFingerprint("data/master/wallets-master.json");
    const afterFrontend = getFileFingerprint("frontend/public/data/wallets-14d.json");
    const afterRawFabriq = getFileFingerprint("data/raw/fabriq");
    const afterPoolScanner = getFileFingerprint("scripts/pool-scanner-v1.mjs");

    const noMasterMutation =
        baselineMaster === afterMaster &&
        baselineFrontend === afterFrontend &&
        baselineRawFabriq === afterRawFabriq &&
        baselinePoolScanner === afterPoolScanner;

    const allowedDiscoveryFileNames = new Set([
        "summary.json",
        "pools.json",
        "fabriq-positions.json",
        "events.json",
        "positions.json",
        "comparison.json",
    ]);

    const allowedDownstreamDirs = new Set([
        "verification",
        "strategy",
        "strategy-decoded",
        "strategy-derived",
        "strategy-normalized",
    ]);

    let outputSafetyPass = true;
    const rootEntries = fs.readdirSync(outDir, { withFileTypes: true });

    for (const entry of rootEntries) {
        if (entry.isFile()) {
            if (allowedDiscoveryFileNames.has(entry.name)) {
                continue;
            }
            if (
                (entry.name === "strategy-batch-summary.json" ||
                    entry.name === "wallet-behaviour.json") &&
                !positionSetChanged &&
                currentClosedPositionAddresses.size > 0
            ) {
                continue;
            }
            outputSafetyPass = false;
        } else if (entry.isDirectory()) {
            if (!allowedDownstreamDirs.has(entry.name)) {
                outputSafetyPass = false;
                continue;
            }
            const subDir = path.join(outDir, entry.name);
            const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
            for (const subEntry of subEntries) {
                if (subEntry.isFile() && subEntry.name.endsWith(".json")) {
                    const pos = subEntry.name.slice(0, -5);
                    if (currentClosedPositionAddresses.has(pos)) {
                        continue;
                    }
                }
                outputSafetyPass = false;
            }
        }
    }

    // Summary tables
    console.log("\n========================================");
    console.log("FABRIQ CLOSED POOLS SAMPLE (UP TO 5)");
    console.log("========================================");
    console.table(
        fabriqResult.pools.slice(0, 5).map((p) => ({
            poolId: `${p.pool_id.slice(0, 8)}...`,
            positions: p.position_count,
            walletPos: p.position_count_wallet,
            hawkfiPos: p.position_count_hawkfi,
            pnlUsd: p.total_pnl_usd?.toFixed?.(2) ?? p.total_pnl_usd,
            pnlSol: p.total_pnl_sol?.toFixed?.(4) ?? p.total_pnl_sol,
            binStep: p.parsedParams?.binStep ?? "-",
        }))
    );

    console.log("\n========================================");
    console.log("FABRIQ RECONSTRUCTED POSITIONS SAMPLE (UP TO 5)");
    console.log("========================================");
    console.table(
        positions.slice(0, 5).map((p) => ({
            position: `${p.position.slice(0, 8)}...`,
            pool: `${p.pool.slice(0, 8)}...`,
            status: p.status,
            source: p.source,
            events: p.eventCount,
            init: p.lifecycle.initializeCount,
            add: p.lifecycle.addCount,
            rem: p.lifecycle.removeCount,
            fee: p.lifecycle.claimFeeCount,
            close: p.lifecycle.closeCount,
            unknown: p.lifecycle.unknownCount,
            firstSeen: p.firstSeenAt,
            closedAt: p.closedAt ?? "-",
        }))
    );

    console.log("\n========================================");
    console.log("EVENT TYPE BREAKDOWN");
    console.log("========================================");
    console.table(
        Object.entries(fabriqResult.eventTypeCounts).map(([type, count]) => ({
            type,
            count,
        }))
    );

    if (Object.keys(fabriqResult.unknownTypes).length > 0) {
        console.log("\n[WARNING] UNKNOWN EVENT TYPES OBSERVED:");
        console.table(
            Object.entries(fabriqResult.unknownTypes).map(([type, count]) => ({
                unknownType: type,
                count,
            }))
        );
    }

    console.log("\n========================================");
    console.log("REFERENCE COMPARISON (WALDISC-1 vs FABRIQ)");
    console.log("========================================");
    console.log(`Reference Pool        : ${REFERENCE_POOL}`);
    console.log(`Comparison Mode       : ${comparison.comparisonMode}`);
    console.log(`Pool Found in Fabriq  : ${hasReferencePool ? "YES" : "NO"}`);
    if (!hasReferencePool) {
        console.log(`[COMPARISON] Reference pool ${REFERENCE_POOL} NOT found in Fabriq closed positions for this wallet.`);
    }
    console.log(`Expected Positions    : ${expectedCount} (${expectedPositions.join(", ") || "none"})`);
    console.log(`Fabriq Positions      : ${fabriqCount}`);
    console.log(`Matched Positions     : ${matchedCount} (${matchedPositions.join(", ") || "none"})`);
    console.log(`Missing Positions     : ${missingPositions.length} (${missingPositions.join(", ") || "none"})`);
    console.log(`Extra Positions       : ${extraPositions.length}`);
    console.log(`Coverage Pct          : ${expectedCoveragePct.toFixed(1)}%`);
    console.log(`Coverage Complete     : ${expectedCoverageComplete ? "YES" : "NO"}`);

    console.log("\n========================================");
    console.log("DISCOVERY PROOF SUMMARY");
    console.log("========================================");
    console.log(`Pools Fetched         : ${fabriqResult.poolsFetched} across ${fabriqResult.poolPagesFetched} page(s)`);
    console.log(`Positions Discovered  : ${fabriqResult.positionsFetched} (Wallet: ${fabriqResult.walletSourcePositions}, HawkFi: ${fabriqResult.hawkfiSourcePositions})`);
    console.log(`Events Fetched        : ${fabriqResult.transactionEventsFetched}`);
    console.log(`Positions Closed      : ${positionHistoryResult.positionsClosed}`);
    console.log(`Positions Partial Hist: ${positionHistoryResult.positionsPartialHistory}`);
    console.log(`Master File Safety    : ${noMasterMutation ? "PASS (unchanged)" : "FAIL (mutated)"}`);
    console.log(`Output Directory Only : ${outputSafetyPass ? "PASS" : "FAIL"}`);
    console.log("========================================");

        if (!noMasterMutation || !outputSafetyPass) {
            process.exitCode = 1;
        }
    } finally {
        await closeFabriqConnection();
    }
}

main().catch((err) => {
    console.error("WALDISC-2 execution failed:", err);
    process.exit(1);
});
