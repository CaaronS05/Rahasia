import {
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

interface SelectionPool {
    poolAddress: string;
    pair?: string;
    binStep?: number;
    baseFeePct?: number;
    [key: string]: unknown;
}

interface SelectionArtifact {
    version?: string;
    tokenMint?: string;
    selectionFingerprint?: string;
    createdAt?: string;
    selectedPoolCount?: number;
    pools?: SelectionPool[];
    [key: string]: unknown;
}

interface ScanStateArtifact {
    version?: string;
    tokenMint?: string;
    selectionFingerprint?: string;
    status?: string;
    selectedPoolCount?: number;
    completedPoolCount?: number;
    pendingPoolCount?: number;
    selectedPoolAddresses?: string[];
    completedPoolAddresses?: string[];
    startedAt?: string;
    updatedAt?: string;
    completedAt?: string;
    [key: string]: unknown;
}

interface PoolWalletEntry {
    wallet: string;
    pnlUsd?: number | null;
    winRate?: number | null;
    positions?: number | null;
    [key: string]: unknown;
}

interface PoolWalletsPool {
    poolAddress: string;
    pair?: string;
    binStep?: number;
    baseFeePct?: number;
    status?: string;
    walletCount?: number;
    wallets?: PoolWalletEntry[];
    [key: string]: unknown;
}

interface PoolWalletsArtifact {
    version?: string;
    tokenMint?: string;
    updatedAt?: string;
    pools?: PoolWalletsPool[];
    [key: string]: unknown;
}

interface TradeHistoryItem {
    positionId: string;
    openedAt?: string | null;
    closedAt?: string | null;
    durationSeconds?: number | null;
    pnlUsd?: number | null;
    pnlPct?: number | null;
    [key: string]: unknown;
}

interface TradeHistoryWallet {
    wallet: string;
    tradeCount?: number;
    trades?: TradeHistoryItem[];
    [key: string]: unknown;
}

interface TradeHistoryPool {
    poolAddress: string;
    membershipWalletCount?: number;
    processedWalletCount?: number;
    tradeCount?: number;
    wallets?: TradeHistoryWallet[];
    [key: string]: unknown;
}

interface PoolTradeHistoryArtifact {
    version?: string;
    tokenMint?: string;
    selectionFingerprint?: string;
    generatedAt?: string;
    runScope?: string;
    isFullDataset?: boolean;
    membershipWalletCount?: number;
    processedWalletCount?: number;
    requestedWallet?: string | null;
    limit?: number | null;
    poolCount?: number;
    tradeCount?: number;
    pools?: TradeHistoryPool[];
    [key: string]: unknown;
}

interface ScannedPoolRecord {
    poolAddress: string;
    tokenMint: string;
    pair: string;
    binStep: number;
    baseFeePct: number;
    selectionFingerprint: string;
    walletCount: number;
    tradeCount: number;
    firstScannedAt: string;
    lastScannedAt: string;
}

interface ScannedPoolsFile {
    version: "v1";
    updatedAt: string;
    pools: ScannedPoolRecord[];
}

interface PoolWalletMembershipRecord {
    poolAddress: string;
    wallet: string;
    pnlUsd: number | null;
    winRate: number | null;
    positions: number | null;
    tradeCount: number;
    selectionFingerprint: string;
    updatedAt: string;
}

interface PoolWalletMembershipFile {
    version: "v1";
    updatedAt: string;
    memberships: PoolWalletMembershipRecord[];
}

interface PoolTradeHistoryRecord {
    poolAddress: string;
    wallet: string;
    positionId: string;
    openedAt: string | null;
    closedAt: string | null;
    durationSeconds: number | null;
    pnlUsd: number | null;
    pnlPct: number | null;
    selectionFingerprint: string;
}

interface PoolTradeHistoryFile {
    version: "v1";
    updatedAt: string;
    trades: PoolTradeHistoryRecord[];
}

interface ParsedCliArgs {
    token: string;
    targetPool: string | null;
    dryRun: boolean;
}

function parseCliArgs(): ParsedCliArgs {
    const args = process.argv.slice(2);
    let token = "";
    let targetPool: string | null = null;
    let dryRun = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--token") {
            token = args[i + 1] ?? "";
            i++;
        } else if (arg.startsWith("--token=")) {
            token = arg.slice("--token=".length);
        } else if (arg === "--pool") {
            targetPool = args[i + 1] ?? null;
            i++;
        } else if (arg.startsWith("--pool=")) {
            targetPool = arg.slice("--pool=".length);
        } else if (arg === "--dry-run") {
            dryRun = true;
        }
    }

    if (!token) {
        throw new Error(
            "Missing required argument: --token <TOKEN_CA>\nUsage: node --experimental-strip-types scripts/pipeline/persist-pool-scanner.ts --token <TOKEN_CA> [--pool <POOL_ADDRESS>] [--dry-run]"
        );
    }

    return { token, targetPool: targetPool ? targetPool.trim() : null, dryRun };
}
function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

async function loadExistingJsonOrDefault<T>(filePath: string, defaultVal: T): Promise<T> {
    try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content) as T;
    } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
            return defaultVal;
        }
        throw err;
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
            return false;
        }
    }
    return true;
}

async function main() {
    const { token, targetPool, dryRun } = parseCliArgs();

    const selectedScanDir = path.resolve(
        `data/discovery/pool-scanner/${token}/selected-scan`
    );

    const selectionPath = path.join(selectedScanDir, "selection.json");
    const scanStatePath = path.join(selectedScanDir, "scan-state.json");
    const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
    const poolTradeHistoryPath = path.join(selectedScanDir, "pool-trade-history.json");

    // ==================================================
    // 1-4. Validate artifact existence and load
    // ==================================================
    let selection: SelectionArtifact;
    let scanState: ScanStateArtifact;
    let poolWallets: PoolWalletsArtifact;
    let poolTradeHistory: PoolTradeHistoryArtifact;

    try {
        selection = JSON.parse(await readFile(selectionPath, "utf8")) as SelectionArtifact;
    } catch (err: unknown) {
        throw new Error(`Validation failed: selection.json does not exist or is invalid at ${selectionPath}: ${getErrorMessage(err)}`);
    }

    try {
        scanState = JSON.parse(await readFile(scanStatePath, "utf8")) as ScanStateArtifact;
    } catch (err: unknown) {
        throw new Error(`Validation failed: scan-state.json does not exist or is invalid at ${scanStatePath}: ${getErrorMessage(err)}`);
    }

    try {
        poolWallets = JSON.parse(await readFile(poolWalletsPath, "utf8")) as PoolWalletsArtifact;
    } catch (err: unknown) {
        throw new Error(`Validation failed: pool-wallets.json does not exist or is invalid at ${poolWalletsPath}: ${getErrorMessage(err)}`);
    }

    try {
        poolTradeHistory = JSON.parse(await readFile(poolTradeHistoryPath, "utf8")) as PoolTradeHistoryArtifact;
    } catch (err: unknown) {
        throw new Error(`Validation failed: pool-trade-history.json does not exist or is invalid at ${poolTradeHistoryPath}: ${getErrorMessage(err)}`);
    }

    // ==================================================
    // 5. tokenMint agrees across artifacts where present
    // ==================================================
    if (selection.tokenMint !== undefined && selection.tokenMint !== token) {
        throw new Error(`Validation failed: selection.json tokenMint (${selection.tokenMint}) does not match target token (${token})`);
    }
    if (scanState.tokenMint !== undefined && scanState.tokenMint !== token) {
        throw new Error(`Validation failed: scan-state.json tokenMint (${scanState.tokenMint}) does not match target token (${token})`);
    }
    if (poolWallets.tokenMint !== undefined && poolWallets.tokenMint !== token) {
        throw new Error(`Validation failed: pool-wallets.json tokenMint (${poolWallets.tokenMint}) does not match target token (${token})`);
    }
    if (poolTradeHistory.tokenMint !== undefined && poolTradeHistory.tokenMint !== token) {
        throw new Error(`Validation failed: pool-trade-history.json tokenMint (${poolTradeHistory.tokenMint}) does not match target token (${token})`);
    }

    // ==================================================
    // 6. selectionFingerprint agrees between selection.json and pool-trade-history.json
    // ==================================================
    if (!selection.selectionFingerprint) {
        throw new Error("Validation failed: selection.json is missing selectionFingerprint");
    }
    if (!poolTradeHistory.selectionFingerprint) {
        throw new Error("Validation failed: pool-trade-history.json is missing selectionFingerprint");
    }
    if (selection.selectionFingerprint !== poolTradeHistory.selectionFingerprint) {
        throw new Error(
            `Validation failed: selectionFingerprint mismatch between selection.json (${selection.selectionFingerprint}) and pool-trade-history.json (${poolTradeHistory.selectionFingerprint})`
        );
    }

    const fingerprint = selection.selectionFingerprint;

    // Optional consistency check on scanState fingerprint if present
    if (scanState.selectionFingerprint && scanState.selectionFingerprint !== fingerprint) {
        throw new Error(
            `Validation failed: selectionFingerprint mismatch in scan-state.json (${scanState.selectionFingerprint}) vs (${fingerprint})`
        );
    }

    // ==================================================
    // 7. pool-trade-history.json full run validation
    // ==================================================
    if (poolTradeHistory.runScope !== "full") {
        throw new Error(`Validation failed: pool-trade-history.json runScope must be "full", got "${poolTradeHistory.runScope}"`);
    }
    if (poolTradeHistory.isFullDataset !== true) {
        throw new Error(`Validation failed: pool-trade-history.json isFullDataset must be true, got ${poolTradeHistory.isFullDataset}`);
    }
    if (poolTradeHistory.requestedWallet !== null) {
        throw new Error(`Validation failed: pool-trade-history.json requestedWallet must be null, got ${JSON.stringify(poolTradeHistory.requestedWallet)}`);
    }
    if (poolTradeHistory.limit !== null) {
        throw new Error(`Validation failed: pool-trade-history.json limit must be null, got ${JSON.stringify(poolTradeHistory.limit)}`);
    }
    if (poolTradeHistory.membershipWalletCount !== poolTradeHistory.processedWalletCount) {
        throw new Error(
            `Validation failed: pool-trade-history.json membershipWalletCount (${poolTradeHistory.membershipWalletCount}) !== processedWalletCount (${poolTradeHistory.processedWalletCount})`
        );
    }

    // ==================================================
    // 8. Every selected pool must have completed LP Agent extraction
    // Use BOTH:
    // pool-wallets.json status
    // AND actual completed-pool info available in scan-state.json
    // ==================================================
    const selectedPoolsFromSelection = selection.pools ?? [];
    if (!Array.isArray(selectedPoolsFromSelection) || selectedPoolsFromSelection.length === 0) {
        throw new Error("Validation failed: selection.json has no pools defined");
    }

    if (targetPool) {
        const hasTarget = selectedPoolsFromSelection.some(p => p.poolAddress === targetPool);
        if (!hasTarget) {
            throw new Error(`Validation failed: Target pool ${targetPool} not found in selection.json`);
        }
    }
    const completedAddressesInScanState = new Set(scanState.completedPoolAddresses ?? []);

    // Also check scan-state overall status if present
    if (scanState.status !== "completed") {
        throw new Error(`Validation failed: scan-state.json status is "${scanState.status}", expected "completed"`);
    }

    const poolWalletsPools = poolWallets.pools ?? [];
    if (!Array.isArray(poolWalletsPools)) {
        throw new Error("Validation failed: pool-wallets.json pools is not an array");
    }
    const poolWalletsByAddress = new Map<string, PoolWalletsPool>();
    for (const p of poolWalletsPools) {
        if (!p.poolAddress) {
            throw new Error("Validation failed: pool-wallets.json pool entry missing poolAddress");
        }
        poolWalletsByAddress.set(p.poolAddress, p);
    }

    for (const selPool of selectedPoolsFromSelection) {
        const addr = selPool.poolAddress;
        if (!addr) {
            throw new Error("Validation failed: selection.json pool entry missing poolAddress");
        }
        if (!completedAddressesInScanState.has(addr)) {
            throw new Error(`Validation failed: selected pool ${addr} is not marked completed in scan-state.json completedPoolAddresses`);
        }
        const pwPool = poolWalletsByAddress.get(addr);
        if (!pwPool) {
            throw new Error(`Validation failed: selected pool ${addr} not found in pool-wallets.json`);
        }
        if (pwPool.status !== "completed") {
            throw new Error(`Validation failed: pool ${addr} status in pool-wallets.json is "${pwPool.status}", expected "completed"`);
        }
    }

    // ==================================================
    // 9. Pool set internally consistent between selection, pool-wallets, pool-trade-history
    // ==================================================
    const tradeHistoryPools = poolTradeHistory.pools ?? [];
    if (!Array.isArray(tradeHistoryPools)) {
        throw new Error("Validation failed: pool-trade-history.json pools is not an array");
    }
    const tradeHistoryByAddress = new Map<string, TradeHistoryPool>();
    for (const p of tradeHistoryPools) {
        if (!p.poolAddress) {
            throw new Error("Validation failed: pool-trade-history.json pool entry missing poolAddress");
        }
        tradeHistoryByAddress.set(p.poolAddress, p);
    }

    const selectionPoolAddresses = new Set(selectedPoolsFromSelection.map(p => p.poolAddress));
    const poolWalletsAddresses = new Set(poolWalletsPools.map(p => p.poolAddress));
    const tradeHistoryAddresses = new Set(tradeHistoryPools.map(p => p.poolAddress));

    if (selectionPoolAddresses.size !== poolWalletsAddresses.size ||
        [...selectionPoolAddresses].some(a => !poolWalletsAddresses.has(a))) {
        throw new Error(
            `Validation failed: Pool set mismatch between selection.json (${[...selectionPoolAddresses].join(",")}) and pool-wallets.json (${[...poolWalletsAddresses].join(",")})`
        );
    }

    if (selectionPoolAddresses.size !== tradeHistoryAddresses.size ||
        [...selectionPoolAddresses].some(a => !tradeHistoryAddresses.has(a))) {
        throw new Error(
            `Validation failed: Pool set mismatch between selection.json (${[...selectionPoolAddresses].join(",")}) and pool-trade-history.json (${[...tradeHistoryAddresses].join(",")})`
        );
    }

    // ==================================================
    // 10, 11, 12, 13: Membership and Trade details validation
    // ==================================================
    // 12. No duplicate (poolAddress, wallet) in pool membership
    const membershipWalletSetByPool = new Map<string, Set<string>>();
    for (const pwPool of poolWalletsPools) {
        const poolAddr = pwPool.poolAddress;
        const seenWallets = new Set<string>();
        const wallets = pwPool.wallets ?? [];
        for (const w of wallets) {
            if (!w.wallet) {
                throw new Error(`Validation failed: Empty wallet address in pool ${poolAddr} of pool-wallets.json`);
            }
            if (seenWallets.has(w.wallet)) {
                throw new Error(`Validation failed: Duplicate (poolAddress, wallet) found in pool-wallets.json for pool ${poolAddr}, wallet ${w.wallet}`);
            }
            seenWallets.add(w.wallet);
        }
        membershipWalletSetByPool.set(poolAddr, seenWallets);
    }

    // 11. Per-pool processedWalletCount must equal that pool's membership wallet count for a full dataset
    // 10. Every trade-history wallet for a pool must exist in that pool's pool-wallets membership
    // 13. No duplicate (poolAddress, wallet, positionId) in trade history
    const tradeHistoryKeySet = new Set<string>();
    // Also build a map of trade counts per (poolAddress, wallet)
    const walletTradeCountMap = new Map<string, number>();

    let sourceTradeCount = 0;
    let sourceMembershipCount = 0;

    for (const pwPool of poolWalletsPools) {
        sourceMembershipCount += (pwPool.wallets ?? []).length;
    }

    for (const thPool of tradeHistoryPools) {
        const poolAddr = thPool.poolAddress;
        const membershipSet = membershipWalletSetByPool.get(poolAddr);
        if (!membershipSet) {
            throw new Error(`Validation failed: Pool ${poolAddr} in trade history not in membership`);
        }

        const expectedMembershipCount = membershipSet.size;
        if (thPool.membershipWalletCount !== expectedMembershipCount) {
            throw new Error(
                `Validation failed: Pool ${poolAddr} trade history membershipWalletCount (${thPool.membershipWalletCount}) does not match pool-wallets count (${expectedMembershipCount})`
            );
        }
        if (thPool.processedWalletCount !== expectedMembershipCount) {
            throw new Error(
                `Validation failed: Pool ${poolAddr} trade history processedWalletCount (${thPool.processedWalletCount}) does not match membership count (${expectedMembershipCount})`
            );
        }

        const thWallets = thPool.wallets ?? [];
        for (const thWallet of thWallets) {
            const wAddr = thWallet.wallet;
            if (!membershipSet.has(wAddr)) {
                throw new Error(
                    `Validation failed: Trade history wallet ${wAddr} does not exist in pool ${poolAddr} pool-wallets membership`
                );
            }

            const trades = thWallet.trades ?? [];
            const key = `${poolAddr}::${wAddr}`;
            walletTradeCountMap.set(key, trades.length);
            sourceTradeCount += trades.length;

            for (const tr of trades) {
                if (!tr.positionId) {
                    throw new Error(`Validation failed: Trade in pool ${poolAddr}, wallet ${wAddr} missing positionId`);
                }
                const tradeKey = `${poolAddr}::${wAddr}::${tr.positionId}`;
                if (tradeHistoryKeySet.has(tradeKey)) {
                    throw new Error(`Validation failed: Duplicate (poolAddress, wallet, positionId) found in trade history: ${tradeKey}`);
                }
                tradeHistoryKeySet.add(tradeKey);
            }
        }
    }

    // ==================================================
    // Authoritative Timestamps
    // "update lastScannedAt using the authoritative scan artifact timestamp"
    // "Do NOT use Date.now() as the semantic scan timestamp if the completed scan artifact already provides an authoritative timestamp."
    // Authoritative completed scan timestamp: scanState.completedAt ?? scanState.updatedAt ?? poolWallets.updatedAt
    // ==================================================
    const scanArtifactTimestamp = scanState.completedAt || scanState.updatedAt || poolWallets.updatedAt;
    if (!scanArtifactTimestamp) {
        throw new Error("Validation failed: Unable to determine authoritative scan artifact timestamp");
    }

    // ==================================================
    // Load existing canonical files or initialize defaults
    // ==================================================
    const MASTER_DIR = path.resolve("data/master");
    const scannedPoolsPath = path.join(MASTER_DIR, "scanned-pools.json");
    const poolWalletMembershipPath = path.join(MASTER_DIR, "pool-wallet-membership.json");
    const canonicalPoolTradeHistoryPath = path.join(MASTER_DIR, "pool-trade-history.json");

    const existingScannedPools = await loadExistingJsonOrDefault<ScannedPoolsFile>(
        scannedPoolsPath,
        { version: "v1", updatedAt: scanArtifactTimestamp, pools: [] }
    );
    const existingMemberships = await loadExistingJsonOrDefault<PoolWalletMembershipFile>(
        poolWalletMembershipPath,
        { version: "v1", updatedAt: scanArtifactTimestamp, memberships: [] }
    );
    const existingTrades = await loadExistingJsonOrDefault<PoolTradeHistoryFile>(
        canonicalPoolTradeHistoryPath,
        { version: "v1", updatedAt: scanArtifactTimestamp, trades: [] }
    );

    // ==================================================
    // Prepare Canonical 1: scanned-pools.json
    // ==================================================
    const scannedPoolsMap = new Map<string, ScannedPoolRecord>();
    for (const p of existingScannedPools.pools || []) {
        scannedPoolsMap.set(p.poolAddress, p);
    }

    let scannedPoolsToAdd = 0;
    let scannedPoolsToUpdate = 0;

    for (const selPool of selectedPoolsFromSelection) {
        const poolAddr = selPool.poolAddress;
        const pwPool = poolWalletsByAddress.get(poolAddr)!;
        const thPool = tradeHistoryByAddress.get(poolAddr);

        const existing = scannedPoolsMap.get(poolAddr);
        const firstScannedAt = existing ? existing.firstScannedAt : scanArtifactTimestamp;
        const lastScannedAt = scanArtifactTimestamp;

        const walletCount = (pwPool.wallets ?? []).length;
        const tradeCount = thPool?.tradeCount ?? 0;

        const incomingRecord: ScannedPoolRecord = {
            poolAddress: poolAddr,
            tokenMint: token,
            pair: pwPool.pair || selPool.pair || "",
            binStep: pwPool.binStep ?? selPool.binStep ?? 0,
            baseFeePct: pwPool.baseFeePct ?? selPool.baseFeePct ?? 0,
            selectionFingerprint: fingerprint,
            walletCount,
            tradeCount,
            firstScannedAt,
            lastScannedAt,
        };

        if (existing) {
            if (!deepEqual(existing, incomingRecord)) {
                scannedPoolsToUpdate++;
                scannedPoolsMap.set(poolAddr, incomingRecord);
            }
        } else {
            scannedPoolsToAdd++;
            scannedPoolsMap.set(poolAddr, incomingRecord);
        }
    }

    const nextScannedPoolsList = Array.from(scannedPoolsMap.values()).sort((a, b) =>
        a.poolAddress.localeCompare(b.poolAddress)
    );

    // ==================================================
    // Prepare Canonical 2: pool-wallet-membership.json
    // ==================================================
    const membershipMap = new Map<string, PoolWalletMembershipRecord>();
    for (const m of existingMemberships.memberships || []) {
        membershipMap.set(`${m.poolAddress}::${m.wallet}`, m);
    }

    // When scoped to a target pool, remove previous membership records for that pool so disappearing wallets are purged
    if (targetPool) {
        for (const [key, m] of membershipMap.entries()) {
            if (m.poolAddress === targetPool) {
                membershipMap.delete(key);
            }
        }
    }
    let membershipsToAdd = 0;
    let membershipsToUpdate = 0;

    for (const pwPool of poolWalletsPools) {
        const poolAddr = pwPool.poolAddress;
        for (const w of pwPool.wallets || []) {
            const key = `${poolAddr}::${w.wallet}`;
            const existing = membershipMap.get(key);

            const tradeCount = walletTradeCountMap.get(key) ?? 0;

            const incomingRecord: PoolWalletMembershipRecord = {
                poolAddress: poolAddr,
                wallet: w.wallet,
                pnlUsd: w.pnlUsd !== undefined ? w.pnlUsd : null,
                winRate: w.winRate !== undefined ? w.winRate : null,
                positions: w.positions !== undefined ? w.positions : null,
                tradeCount,
                selectionFingerprint: fingerprint,
                updatedAt: scanArtifactTimestamp,
            };

            if (existing) {
                if (!deepEqual(existing, incomingRecord)) {
                    membershipsToUpdate++;
                    membershipMap.set(key, incomingRecord);
                }
            } else {
                membershipsToAdd++;
                membershipMap.set(key, incomingRecord);
            }
        }
    }
    const nextMembershipsList = Array.from(membershipMap.values()).sort((a, b) => {
        const poolComp = a.poolAddress.localeCompare(b.poolAddress);
        if (poolComp !== 0) return poolComp;
        return a.wallet.localeCompare(b.wallet);
    });

    // ==================================================
    // Prepare Canonical 3: pool-trade-history.json
    // ==================================================
    const tradesMap = new Map<string, PoolTradeHistoryRecord>();
    for (const t of existingTrades.trades || []) {
        tradesMap.set(`${t.poolAddress}::${t.wallet}::${t.positionId}`, t);
    }

    // When scoped to a target pool, remove previous trade records for that pool to replace with latest snapshot
    if (targetPool) {
        for (const [key, t] of tradesMap.entries()) {
            if (t.poolAddress === targetPool) {
                tradesMap.delete(key);
            }
        }
    }
    let tradesToAdd = 0;
    let tradesToUpdate = 0;

    for (const thPool of tradeHistoryPools) {
        const poolAddr = thPool.poolAddress;
        for (const w of thPool.wallets || []) {
            const wAddr = w.wallet;
            for (const tr of w.trades || []) {
                const key = `${poolAddr}::${wAddr}::${tr.positionId}`;
                const existing = tradesMap.get(key);

                const incomingRecord: PoolTradeHistoryRecord = {
                    poolAddress: poolAddr,
                    wallet: wAddr,
                    positionId: tr.positionId,
                    openedAt: tr.openedAt !== undefined ? tr.openedAt : null,
                    closedAt: tr.closedAt !== undefined ? tr.closedAt : null,
                    durationSeconds: tr.durationSeconds !== undefined ? tr.durationSeconds : null,
                    pnlUsd: tr.pnlUsd !== undefined ? tr.pnlUsd : null,
                    pnlPct: tr.pnlPct !== undefined ? tr.pnlPct : null,
                    selectionFingerprint: fingerprint,
                };

                if (existing) {
                    if (!deepEqual(existing, incomingRecord)) {
                        tradesToUpdate++;
                        tradesMap.set(key, incomingRecord);
                    }
                } else {
                    tradesToAdd++;
                    tradesMap.set(key, incomingRecord);
                }
            }
        }
    }
    const nextTradesList = Array.from(tradesMap.values()).sort((a, b) => {
        const poolComp = a.poolAddress.localeCompare(b.poolAddress);
        if (poolComp !== 0) return poolComp;

        const walletComp = a.wallet.localeCompare(b.wallet);
        if (walletComp !== 0) return walletComp;

        // closedAt descending; null closedAt deterministically after non-null
        if (a.closedAt === null && b.closedAt !== null) return 1;
        if (a.closedAt !== null && b.closedAt === null) return -1;
        if (a.closedAt !== null && b.closedAt !== null) {
            const closedComp = b.closedAt.localeCompare(a.closedAt);
            if (closedComp !== 0) return closedComp;
        }

        return a.positionId.localeCompare(b.positionId);
    });

    if (dryRun) {
        console.log("STEP 3D-A DRY RUN");
        console.log("");
        console.log("TOKEN:");
        console.log(token);
        console.log("");
        console.log("VALIDATION:");
        console.log("PASS");
        console.log("");
        console.log("SELECTED POOLS:");
        console.log(selectedPoolsFromSelection.length);
        console.log("");
        console.log("SCANNED POOLS TO ADD:");
        console.log(scannedPoolsToAdd);
        console.log("");
        console.log("SCANNED POOLS TO UPDATE:");
        console.log(scannedPoolsToUpdate);
        console.log("");
        console.log("MEMBERSHIPS TO ADD:");
        console.log(membershipsToAdd);
        console.log("");
        console.log("MEMBERSHIPS TO UPDATE:");
        console.log(membershipsToUpdate);
        console.log("");
        console.log("TRADES TO ADD:");
        console.log(tradesToAdd);
        console.log("");
        console.log("TRADES TO UPDATE:");
        console.log(tradesToUpdate);
        console.log("");
        console.log("SOURCE MEMBERSHIP COUNT:");
        console.log(sourceMembershipCount);
        console.log("");
        console.log("SOURCE TRADE COUNT:");
        console.log(sourceTradeCount);
        console.log("");
        console.log("CANONICAL FILES WRITTEN:");
        console.log("NONE");
        return;
    }

    // ==================================================
    // Non-dry-run Atomic Write Execution
    // 1. build all three complete outputs in memory
    // 2. validate the final outputs again
    // 3. write temporary files
    // 4. rename atomically
    // ==================================================
    const scannedPoolsChanged = scannedPoolsToAdd > 0 || scannedPoolsToUpdate > 0;
    const scannedPoolsRootUpdatedAt = scannedPoolsChanged
        ? scanArtifactTimestamp
        : (existingScannedPools.updatedAt || scanArtifactTimestamp);

    const membershipsChanged = membershipsToAdd > 0 || membershipsToUpdate > 0;
    const membershipsRootUpdatedAt = membershipsChanged
        ? scanArtifactTimestamp
        : (existingMemberships.updatedAt || scanArtifactTimestamp);

    const tradesChanged = tradesToAdd > 0 || tradesToUpdate > 0;
    const tradesRootUpdatedAt = tradesChanged
        ? scanArtifactTimestamp
        : (existingTrades.updatedAt || scanArtifactTimestamp);

    const finalScannedPoolsFile: ScannedPoolsFile = {
        version: "v1",
        updatedAt: scannedPoolsRootUpdatedAt,
        pools: nextScannedPoolsList,
    };

    const finalMembershipFile: PoolWalletMembershipFile = {
        version: "v1",
        updatedAt: membershipsRootUpdatedAt,
        memberships: nextMembershipsList,
    };

    const finalTradeHistoryFile: PoolTradeHistoryFile = {
        version: "v1",
        updatedAt: tradesRootUpdatedAt,
        trades: nextTradesList,
    };

    // 2. Validate final outputs again
    if (!Array.isArray(finalScannedPoolsFile.pools) || finalScannedPoolsFile.pools.length === 0) {
        throw new Error("Pre-write validation failed: final scanned pools array is empty or invalid");
    }
    if (!Array.isArray(finalMembershipFile.memberships) || finalMembershipFile.memberships.length === 0) {
        throw new Error("Pre-write validation failed: final membership array is empty or invalid");
    }
    if (!Array.isArray(finalTradeHistoryFile.trades)) {
        throw new Error("Pre-write validation failed: final trades array is invalid");
    }

    await mkdir(MASTER_DIR, { recursive: true });

    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpScannedPoolsPath = path.join(MASTER_DIR, `scanned-pools.${nonce}.tmp`);
    const tmpMembershipPath = path.join(MASTER_DIR, `pool-wallet-membership.${nonce}.tmp`);
    const tmpTradesPath = path.join(MASTER_DIR, `pool-trade-history.${nonce}.tmp`);

    const writtenTmpFiles: string[] = [];

    try {
        await writeFile(tmpScannedPoolsPath, JSON.stringify(finalScannedPoolsFile, null, 2), "utf8");
        writtenTmpFiles.push(tmpScannedPoolsPath);

        await writeFile(tmpMembershipPath, JSON.stringify(finalMembershipFile, null, 2), "utf8");
        writtenTmpFiles.push(tmpMembershipPath);

        await writeFile(tmpTradesPath, JSON.stringify(finalTradeHistoryFile, null, 2), "utf8");
        writtenTmpFiles.push(tmpTradesPath);

        // Atomic rename of all three
        await rename(tmpScannedPoolsPath, scannedPoolsPath);
        await rename(tmpMembershipPath, poolWalletMembershipPath);
        await rename(tmpTradesPath, canonicalPoolTradeHistoryPath);

        console.log("STEP 3D-A PERSISTENCE COMPLETE");
        console.log(`Token: ${token}`);
        console.log(`Scanned pools written: ${finalScannedPoolsFile.pools.length} (added: ${scannedPoolsToAdd}, updated: ${scannedPoolsToUpdate})`);
        console.log(`Memberships written: ${finalMembershipFile.memberships.length} (added: ${membershipsToAdd}, updated: ${membershipsToUpdate})`);
        console.log(`Trades written: ${finalTradeHistoryFile.trades.length} (added: ${tradesToAdd}, updated: ${tradesToUpdate})`);
    } catch (writeErr) {
        // Clean temporary files on failure
        for (const tmpFile of writtenTmpFiles) {
            try {
                await unlink(tmpFile);
            } catch {
                // Ignore cleanup error
            }
        }
        throw writeErr;
    }
}

main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
