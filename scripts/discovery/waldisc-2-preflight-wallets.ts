import fs from "node:fs";
import path from "node:path";
import {
    fabriqFetch,
    isFabriqDlmmPool,
    closeFabriqConnection,
} from "./core/fabriq-position-history.ts";

const DEFAULT_WORKERS = 5;
const DEFAULT_MAX_CLOSED_POSITIONS = 100;
const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_NEW_ELIGIBLE_TARGET = 30;

const KNOWN_EXCLUDED_WALLETS: Record<
    string,
    { role: string; reason: string }
> = {};

const KNOWN_VALIDATED_WALLETS = new Set<string>([
    "12xt4kpUmWMGY7rRenFZXLGtQFcpDFJigFXzQx6FTGyZ",
    "2B1NJ7wNSjJLLCAYKZoJbmaD9Bj6KzcA4NRuABuJd3s4",
    "2GRztQR3YUBhB6bHwpDqTk35XLRMCxifij2JmHz7kkoa",
    "2MzqqSFqg17GhJirQwYzxWY1BquKCQgS3U8XLdnNQrjZ",
    "391RABKxTNJTsBm5As212n74RCvkVVj5bScBHxLsbjPW",
    "3bv2BLABbZ7Qi9LRHohknFbiB1cKWBDRcbXKntmNBSpA",
    "47a7Z4Jk5XX4rVWx6UMk7zEof3aJgz9PFdaKBxUQdWtN",
    "4NRVFcJmh9N53kHm12PJ5hzMRHsJwYXW1aY79ESZPCWH",
    "4pEhSid6oETEJUoNaxTK3yVmXDBnxKWVgf9nrgQqJZ4c",
    "4tNE6wAxeCJVfuJYEhjRqobfgnB9b8Ww4xctAPK4gtB5",
    "4VY2BAdqqvKef6X26gs1cJAZ7575CDBw9hqs2E5o5etD",
    "5dKiqJ1BYsxSyWRfQcyQxXr5oMtCdjDnY72vujw5pQPn",
    "5q8HZeR9ZnTyAvqUdtZtvZksL31HzbfNCS9LSqFE8wJ9",
    "6sHCkP1iDcfWKu2QS12u6yyw1Dowf9vfwTdXzS6bjLn8",
    "7h179sMa8yWZ6HaMmqHdAj48S4A6bug5AEHQuE7mshMe",
    "8FZWoB4AbNUi3tahgSCKEiihgnD5ANVgLmhrC2EEzabj",
    "8pi1WiPDQmFc4uq9WHF7jHXRJEcAPNcpTMsLmckoabZS",
    "9Ej2xDy9CnAsMtHhTnnmKM5T53dt7KAb94gHbdMsyEBj",
    "AKiQ6v5DsWTNuTLZAFxK1gtwv8G3dysthfvEqGvgLrTA",
    "ANvsEBu7b3ehFnGbTkL8gDaaXs2MdyXtg7HRNUAEg3Ur",
    "BabhFegb7dE9VZWQXzW1AAMwTt2uSY5q1tZCfECYpX1B",
    "BbrLGW9C1y6KJFt2sGm8ZV6MV5w2M9RAsD9pt3geqXkH",
    "BioKurBAHQbLmKStQZJR93J5EBzqJeVpWJ1hGvaxsqvH",
    "BKp5fXwS6tYakw8stQ7si73avzKkNLKZVULoBA9PSrkP",
    "CE7xfE6puLP6G1pN4NeCR5zK5P1L2xSqbmKR3FjJHz66",
    "CHZVYWZWsDt17J2d2huasZXrMk7FyaHHYksJ8HN4qtin",
    "CMRAqyVDTYbUtpMCA7UeAL4z91nsfEtvRtHwXGX59884",
    "DfjSTRECcfUqeTQoS11XwXxiJDstDorbvmMxBbwktauJ",
    "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
    "DR2TThuNJHiKseXJL2yXnbTjWEwBtjbLrjS2FB5MN51y",
]);

export interface PreflightWalletRecord {
    wallet: string;
    status: "completed" | "error";
    fabriqPoolCount: number;
    dlmmPoolCount: number;
    dlmmPools: string[];
    legacyDlmmPoolCount?: number;
    legacyDlmmPools?: string[];
    closedPositionCount?: number;
    historyDays?: number;
    eligible: boolean | null;
    pagesFetched: number;
    checkedAt: string;
    error: string | null;
    reason?: string | null;
}

export interface PreflightOutput {
    generatedAt: string;
    config: {
        historyDays: number;
        maxClosedPositions: number;
        poolEligibilityRule: "FABRIQ_DLMM";
    };
    candidateCount: number;
    completedCount: number;
    eligibleCount: number;
    ineligibleCount: number;
    errorCount: number;
    knownValidatedWallets: string[];
    knownExcludedWallets: Array<{
        wallet: string;
        role: string;
        reason: string;
    }>;
    eligibleWallets: string[];
    results: PreflightWalletRecord[];
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidSolanaAddress(address: string): boolean {
    if (typeof address !== "string") return false;
    const trimmed = address.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

function parseTimestampMs(ts: string | number | null | undefined): number | null {
    if (ts === null || ts === undefined || ts === "") return null;
    if (typeof ts === "number") {
        return ts > 1e11 ? ts : ts * 1000;
    }
    const str = String(ts).trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) {
        const num = Number(str);
        return num > 1e11 ? num : num * 1000;
    }
    const isoStr = str.includes("T") ? str : str.replace(" ", "T") + (str.endsWith("Z") ? "" : "Z");
    const parsed = Date.parse(isoStr);
    return Number.isFinite(parsed) ? parsed : null;
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function parseCliArgs(): {
    workers: number;
    target: number;
    historyDays: number;
    maxClosedPositions: number;
    limit?: number;
    wallet?: string;
    force: boolean;
} {
    const args = process.argv.slice(2);
    let workers = DEFAULT_WORKERS;
    let target = DEFAULT_NEW_ELIGIBLE_TARGET;
    let historyDays = DEFAULT_HISTORY_DAYS;
    let maxClosedPositions = DEFAULT_MAX_CLOSED_POSITIONS;
    let limit: number | undefined = undefined;
    let wallet: string | undefined = undefined;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--workers" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed >= 1) workers = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--workers=")) {
            const parsed = Number(arg.split("=")[1]);
            if (Number.isFinite(parsed) && parsed >= 1) workers = Math.floor(parsed);
        } else if ((arg === "--target" || arg === "--target-new") && args[i + 1]) {
            target = Number(args[i + 1]);
            i++;
        } else if (arg.startsWith("--target=") || arg.startsWith("--target-new=")) {
            target = Number(arg.split("=")[1]);
        } else if (arg === "--history-days" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed > 0) historyDays = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--history-days=")) {
            const parsed = Number(arg.split("=")[1]);
            if (Number.isFinite(parsed) && parsed > 0) historyDays = Math.floor(parsed);
        } else if (arg === "--max-closed-positions" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed > 0) maxClosedPositions = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--max-closed-positions=")) {
            const parsed = Number(arg.split("=")[1]);
            if (Number.isFinite(parsed) && parsed > 0) maxClosedPositions = Math.floor(parsed);
        } else if (arg === "--limit" && args[i + 1]) {
            limit = Number(args[i + 1]);
            i++;
        } else if (arg.startsWith("--limit=")) {
            limit = Number(arg.split("=")[1]);
        } else if (arg === "--wallet" && args[i + 1]) {
            wallet = args[i + 1].trim();
            i++;
        } else if (arg.startsWith("--wallet=")) {
            wallet = arg.split("=")[1].trim();
        } else if (arg === "--force") {
            force = true;
        }
    }

    if (wallet) {
        workers = 1;
    }

    return { workers, target, historyDays, maxClosedPositions, limit, wallet, force };
}

function loadKnownValidatedAndGuardSets(cliConfig: {
    historyDays: number;
    maxClosedPositions: number;
}): {
    validatedSet: Set<string>;
    guardSet: Set<string>;
} {
    const validatedSet = new Set<string>(KNOWN_VALIDATED_WALLETS);
    const guardSet = new Set<string>();

    const behaviourPath = path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json");
    if (fs.existsSync(behaviourPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(behaviourPath, "utf8"));
            if (Array.isArray(raw?.wallets)) {
                for (const item of raw.wallets) {
                    const w = String(item?.wallet || item?.owner || item || "").trim();
                    if (isValidSolanaAddress(w)) {
                        validatedSet.add(w);
                    }
                }
            }
        } catch {}
    }

    const expansionPath = path.resolve("data/discovery/waldisc-2/cohort-expansion.json");
    if (fs.existsSync(expansionPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(expansionPath, "utf8"));
            const checkpointConfig = raw?.config;
            const isCompatible =
                checkpointConfig &&
                checkpointConfig.poolEligibilityRule === "FABRIQ_DLMM" &&
                checkpointConfig.historyDays === cliConfig.historyDays &&
                checkpointConfig.maxClosedPositions === cliConfig.maxClosedPositions;

            if (Array.isArray(raw?.results)) {
                for (const item of raw.results) {
                    const w = String(item?.wallet || "").trim();
                    if (!isValidSolanaAddress(w)) continue;
                    if (item.status === "VALIDATED" || item.status === "ALREADY_VALIDATED") {
                        validatedSet.add(w);
                    } else if (item.status === "WORKLOAD_GUARD" && isCompatible) {
                        guardSet.add(w);
                    }
                }
            }
        } catch {}
    }

    return { validatedSet, guardSet };
}

function loadCandidateWallets(): string[] {
    const masterPath = path.resolve("data/master/wallets-master.json");
    if (!fs.existsSync(masterPath)) {
        throw new Error(`Master wallets database not found: ${masterPath}`);
    }

    const fabriqPath = path.resolve("data/master/wallets-fabriq.json");
    if (!fs.existsSync(fabriqPath)) {
        throw new Error(`Canonical Fabriq database not found: ${fabriqPath}`);
    }

    let masterData: any;
    try {
        masterData = JSON.parse(fs.readFileSync(masterPath, "utf8"));
    } catch (err: any) {
        throw new Error(`Failed to parse master wallets file: ${err?.message || err}`);
    }

    let fabriqData: any;
    try {
        fabriqData = JSON.parse(fs.readFileSync(fabriqPath, "utf8"));
    } catch (err: any) {
        throw new Error(`Failed to parse canonical Fabriq file: ${err?.message || err}`);
    }

    const masterWallets = Array.isArray(masterData?.wallets) ? masterData.wallets : [];

    const canonicalWallets = Array.isArray(fabriqData?.wallets) ? fabriqData.wallets : [];
    const canonicalFabriqByOwner = new Map<string, any>();
    for (const fw of canonicalWallets) {
        const fOwner = String(fw?.owner || "").trim();
        if (fOwner && fw?.fabriq) {
            canonicalFabriqByOwner.set(fOwner, fw.fabriq);
        }
    }

    interface EligibleCandidate {
        owner: string;
        activeDaysCount: number;
    }

    const seenOwners = new Set<string>();
    const eligible: EligibleCandidate[] = [];

    for (const w of masterWallets) {
        const owner = String(w?.owner || "").trim();

        if (!isValidSolanaAddress(owner)) continue;
        if (KNOWN_EXCLUDED_WALLETS[owner]) continue;
        if (seenOwners.has(owner)) continue;
        seenOwners.add(owner);

        const fabriqRecord = canonicalFabriqByOwner.get(owner);
        const fabriqStats = fabriqRecord?.stats;
        if (!fabriqStats || typeof fabriqStats !== "object") continue;

        const totalPositions = Number(fabriqStats.totalPositions);
        const netPnlUsd = Number(fabriqStats.netPnlUsd);
        const totalDepositsUsd = Number(fabriqStats.totalDepositsUsd);

        if (!Number.isFinite(totalPositions) || totalPositions < 10) continue;
        if (!Number.isFinite(netPnlUsd)) continue;
        if (!Number.isFinite(totalDepositsUsd) || totalDepositsUsd <= 0) continue;

        const firstActivity = String(w?.first_activity || "").trim();
        const lastActivity = String(w?.last_activity || "").trim();
        if (!firstActivity || !lastActivity) continue;

        let activeDaysCount = 0;
        if (fabriqRecord?.calendar && typeof fabriqRecord.calendar === "object") {
            activeDaysCount = Object.keys(fabriqRecord.calendar).length;
        }
        if (Array.isArray(w?.pnl_chart)) {
            activeDaysCount = Math.max(activeDaysCount, w.pnl_chart.length);
        }

        eligible.push({
            owner,
            activeDaysCount,
        });
    }

    eligible.sort((a, b) => {
        if (b.activeDaysCount !== a.activeDaysCount) {
            return b.activeDaysCount - a.activeDaysCount;
        }
        return a.owner.localeCompare(b.owner);
    });

    return eligible.map((e) => e.owner);
}

// ----------------------------------------------------
// Global 429 Rate Limit Coordinator
// ----------------------------------------------------
class GlobalRateLimitCoordinator {
    private cooldownUntil = 0;
    private backoffStepIndex = 0;
    private backoffSchedule = [5000, 10000, 20000, 30000, 60000];

    async waitForCooldown(): Promise<void> {
        while (Date.now() < this.cooldownUntil) {
            const remaining = this.cooldownUntil - Date.now();
            if (remaining > 0) {
                await sleep(remaining);
            }
        }
    }

    onSuccess(): void {
        this.backoffStepIndex = 0;
    }

    async trigger429Cooldown(workerLabel: string): Promise<void> {
        const step = Math.min(this.backoffStepIndex, this.backoffSchedule.length - 1);
        const cooldownMs = this.backoffSchedule[step];
        this.backoffStepIndex++;

        const newCooldownUntil = Date.now() + cooldownMs;
        if (newCooldownUntil > this.cooldownUntil) {
            this.cooldownUntil = newCooldownUntil;
            console.log(`[429 RATE LIMIT] [${workerLabel}] Global cooldown activated: pausing all workers for ${cooldownMs / 1000}s`);
        }

        await sleep(cooldownMs);
    }
}

// ----------------------------------------------------
// Shared Auth Refresh Lock
// ----------------------------------------------------
class SharedAuthRefreshLock {
    private refreshInProgress: Promise<void> | null = null;
    private lastRefreshedAt = 0;

    async handleAuthError(requestStartedAt: number, workerLabel: string): Promise<void> {
        if (requestStartedAt < this.lastRefreshedAt) {
            return;
        }

        if (this.refreshInProgress) {
            await this.refreshInProgress;
            return;
        }

        let resolvePromise!: () => void;
        this.refreshInProgress = new Promise<void>((resolve) => {
            resolvePromise = resolve;
        });

        try {
            console.log(`[AUTH] [${workerLabel}] Acquired auth refresh lock. Refreshing JWT...`);
            await fabriqFetch<any>("/user/me").catch(() => {});
            this.lastRefreshedAt = Date.now();
            console.log(`[AUTH] [${workerLabel}] Authentication refreshed successfully.`);
        } finally {
            this.refreshInProgress = null;
            resolvePromise();
        }
    }
}

async function fetchWalletDlmmPoolSummary(
    wallet: string,
    historyDays: number,
    workerLabel: string,
    rateLimiter: GlobalRateLimitCoordinator,
    authLock: SharedAuthRefreshLock
): Promise<{
    reachable: boolean;
    fabriqPoolCount: number;
    dlmmPoolCount: number;
    closedPositionCount: number;
    dlmmPools: string[];
    pagesFetched: number;
    error: string | null;
}> {
    let page = 1;
    let pagesFetched = 0;
    const allPoolIds = new Set<string>();
    const candidateDlmmPools: Array<{ poolId: string; posCountFallback: number }> = [];

    const cutoffMs = Date.now() - historyDays * 86400 * 1000;

    try {
        // Step 1: Discover pools via /history/<WALLET>/pnl-by-pool
        while (true) {
            pagesFetched++;
            const params = new URLSearchParams();
            params.set("page", String(page));
            params.set("limit", "100");
            params.set("sortBy", "latest_close_ts");
            params.set("sortOrder", "desc");
            params.set("pnlCurrency", "USD");
            params.set("timezone", "Asia/Jakarta");
            params.append("sources", "wallet");
            params.append("sources", "hawkfi");
            params.set("pnlScope", "pool");
            params.set("lastCloseScope", "pool");
            params.set("durationScope", "pool");
            params.set("depositsScope", "pool");
            params.set("withdrawalsScope", "pool");
            params.set("feesScope", "pool");

            let resJson: any;
            let transientRetries = 0;

            while (true) {
                await rateLimiter.waitForCooldown();
                const reqStartTime = Date.now();

                try {
                    resJson = await fabriqFetch<any>(
                        `/history/${wallet}/pnl-by-pool`,
                        params
                    );
                    rateLimiter.onSuccess();
                    break;
                } catch (err: any) {
                    const msg = String(err?.message || err);

                    if (msg.includes("404")) {
                        console.log(`[${workerLabel}] 404 data not ready for ${wallet}. Waiting 5s and retrying...`);
                        await sleep(5000);
                        continue;
                    }

                    if (msg.includes("401")) {
                        await authLock.handleAuthError(reqStartTime, workerLabel);
                        continue;
                    }

                    if (msg.includes("429")) {
                        await rateLimiter.trigger429Cooldown(workerLabel);
                        continue;
                    }

                    if (
                        msg.includes("500") ||
                        msg.includes("502") ||
                        msg.includes("503") ||
                        msg.includes("504") ||
                        msg.includes("ECONNRESET") ||
                        msg.includes("ETIMEDOUT") ||
                        msg.includes("fetch failed")
                    ) {
                        if (transientRetries < 3) {
                            transientRetries++;
                            console.log(`[${workerLabel}] Transient error on ${wallet} (${msg.slice(0, 50)}). Retry ${transientRetries}/3 in 2s...`);
                            await sleep(2000);
                            continue;
                        }
                    }

                    throw err;
                }
            }

            const dataNode = resJson?.data ?? resJson;
            const pageItems: any[] = Array.isArray(dataNode)
                ? dataNode
                : Array.isArray(dataNode?.items)
                ? dataNode.items
                : Array.isArray(dataNode?.pools)
                ? dataNode.pools
                : Array.isArray(dataNode?.data)
                ? dataNode.data
                : [];

            if (pageItems.length === 0) {
                break;
            }

            for (const row of pageItems) {
                const poolId =
                    row.pool_id ||
                    row.poolId ||
                    row.pool?.id ||
                    row.pool?.address ||
                    row.id;

                if (!poolId) continue;
                const poolIdStr = String(poolId).trim();
                allPoolIds.add(poolIdStr);

                // Authoritative Fabriq DLMM classification
                if (isFabriqDlmmPool(row)) {
                    // Check if the most recent close timestamp for this pool is within the history window
                    const poolCloseMs = parseTimestampMs(row.latest_close_ts);
                    if (poolCloseMs === null || poolCloseMs >= cutoffMs) {
                        const fallbackCount =
                            typeof row.position_count === "number"
                                ? row.position_count
                                : (Number(row.position_count_wallet ?? 0) + Number(row.position_count_hawkfi ?? 0)) || 0;
                        candidateDlmmPools.push({
                            poolId: poolIdStr,
                            posCountFallback: fallbackCount,
                        });
                    }
                }
            }

            if (pageItems.length < 100) {
                break;
            }

            page++;
        }

        // If no Fabriq-classified DLMM pools have activity in this history window, return 0 early
        if (candidateDlmmPools.length === 0) {
            return {
                reachable: true,
                fabriqPoolCount: allPoolIds.size,
                dlmmPoolCount: 0,
                closedPositionCount: 0,
                dlmmPools: [],
                pagesFetched,
                error: null,
            };
        }

        // Step 2: Fetch positions via /history/<WALLET>/positions-by-pool to count exact positions within history window
        const poolIdsToQuery = Array.from(new Set(candidateDlmmPools.map((c) => c.poolId)));
        const poolIdSet = new Set(poolIdsToQuery);
        const validPools = new Set<string>();
        let closedPositionCount = 0;

        const poolBatchSize = 25;
        for (let i = 0; i < poolIdsToQuery.length; i += poolBatchSize) {
            const batch = poolIdsToQuery.slice(i, i + poolBatchSize);
            const posParams = new URLSearchParams();
            posParams.set("poolIds", batch.join(","));
            posParams.append("sources", "wallet");
            posParams.append("sources", "hawkfi");
            posParams.set("timezone", "Asia/Jakarta");
            posParams.set("pnlCurrency", "USD");
            posParams.set("pnlScope", "pool");
            posParams.set("lastCloseScope", "pool");
            posParams.set("durationScope", "pool");
            posParams.set("depositsScope", "pool");
            posParams.set("withdrawalsScope", "pool");
            posParams.set("feesScope", "pool");

            let posResJson: any;
            let posRetries = 0;

            while (true) {
                await rateLimiter.waitForCooldown();
                const reqStartTime = Date.now();

                try {
                    posResJson = await fabriqFetch<any>(
                        `/history/${wallet}/positions-by-pool`,
                        posParams
                    );
                    rateLimiter.onSuccess();
                    break;
                } catch (err: any) {
                    const msg = String(err?.message || err);

                    if (msg.includes("404")) {
                        console.log(`[${workerLabel}] 404 data not ready for ${wallet}. Waiting 5s and retrying...`);
                        await sleep(5000);
                        continue;
                    }

                    if (msg.includes("401")) {
                        await authLock.handleAuthError(reqStartTime, workerLabel);
                        continue;
                    }

                    if (msg.includes("429")) {
                        await rateLimiter.trigger429Cooldown(workerLabel);
                        continue;
                    }

                    if (posRetries < 3) {
                        posRetries++;
                        await sleep(2000);
                        continue;
                    }

                    throw err;
                }
            }

            const resData = posResJson?.data ?? posResJson;
            if (resData && typeof resData === "object" && !Array.isArray(resData)) {
                for (const [pId, posList] of Object.entries(resData)) {
                    const poolKey = String(pId);
                    if (!poolIdSet.has(poolKey)) continue;

                    if (Array.isArray(posList)) {
                        for (const pos of posList) {
                            if (!pos?.id) continue;
                            const posCloseMs = parseTimestampMs(pos.latest_close_ts || pos.opened_at);
                            if (posCloseMs !== null && posCloseMs >= cutoffMs) {
                                closedPositionCount++;
                                validPools.add(poolKey);
                            }
                        }
                    }
                }
            }
        }

        const dlmmPools = Array.from(validPools).sort();
        const dlmmPoolCount = dlmmPools.length;

        return {
            reachable: true,
            fabriqPoolCount: allPoolIds.size,
            dlmmPoolCount,
            closedPositionCount,
            dlmmPools,
            pagesFetched,
            error: null,
        };
    } catch (err: any) {
        return {
            reachable: false,
            fabriqPoolCount: 0,
            dlmmPoolCount: 0,
            closedPositionCount: 0,
            dlmmPools: [],
            pagesFetched,
            error: String(err?.message || err),
        };
    }
}

async function main() {
    const cli = parseCliArgs();

    const { validatedSet, guardSet } = loadKnownValidatedAndGuardSets(cli);

    const outFilePath = path.resolve("data/discovery/waldisc-2/legacy-preflight.json");
    const existingResultsMap = new Map<string, PreflightWalletRecord>();

    let isCheckpointCompatible = false;
    if (fs.existsSync(outFilePath)) {
        try {
            const rawCheckpoint = JSON.parse(fs.readFileSync(outFilePath, "utf8"));
            const checkpointConfig = rawCheckpoint?.config;

            if (
                checkpointConfig &&
                checkpointConfig.poolEligibilityRule === "FABRIQ_DLMM" &&
                checkpointConfig.historyDays === cli.historyDays &&
                checkpointConfig.maxClosedPositions === cli.maxClosedPositions
            ) {
                isCheckpointCompatible = true;
                if (Array.isArray(rawCheckpoint?.results)) {
                    for (const item of rawCheckpoint.results) {
                        if (item?.wallet) {
                            existingResultsMap.set(item.wallet, item);
                        }
                    }
                }
            } else if (rawCheckpoint) {
                console.log(
                    `[CONFIG MISMATCH] Existing preflight checkpoint (rule: ${checkpointConfig?.poolEligibilityRule ?? "CANONICAL_LEGACY"}, ${checkpointConfig?.historyDays ?? "legacy"}d, max ${checkpointConfig?.maxClosedPositions ?? "legacy"}) differs from requested (FABRIQ_DLMM, ${cli.historyDays}d, max ${cli.maxClosedPositions}).`
                );
                console.log(`[CONFIG MISMATCH] Candidates will be re-evaluated under new FABRIQ_DLMM configuration.\n`);
            }
        } catch {
            // Checkpoint read error; continue with clean map
        }
    }

    const allCandidateWallets = loadCandidateWallets();

    // ----------------------------------------------------
    // Serialized Checkpoint Writer
    // ----------------------------------------------------
    let writeChain: Promise<void> = Promise.resolve();

    function writePreflightOutputToDisk(): void {
        const allRecords = Array.from(existingResultsMap.values());

        const completedRecords = allRecords.filter(
            (r) => r.status === "completed"
        );
        const errorRecords = allRecords.filter((r) => r.status === "error");
        const eligibleRecords = completedRecords.filter(
            (r) => r.eligible === true
        );
        const ineligibleRecords = completedRecords.filter(
            (r) => r.eligible === false
        );

        const sortedEligible = [...eligibleRecords].sort((a, b) => {
            const bPools = b.dlmmPoolCount ?? b.legacyDlmmPoolCount ?? 0;
            const aPools = a.dlmmPoolCount ?? a.legacyDlmmPoolCount ?? 0;
            if (bPools !== aPools) {
                return bPools - aPools;
            }
            return a.wallet.localeCompare(b.wallet);
        });

        const sortedResults = [...allRecords].sort((a, b) => {
            if (a.status === "completed" && b.status !== "completed") return -1;
            if (b.status === "completed" && a.status !== "completed") return 1;
            const bPools = b.dlmmPoolCount ?? b.legacyDlmmPoolCount ?? 0;
            const aPools = a.dlmmPoolCount ?? a.legacyDlmmPoolCount ?? 0;
            if (bPools !== aPools) {
                return bPools - aPools;
            }
            return a.wallet.localeCompare(b.wallet);
        });

        const outputData: PreflightOutput = {
            generatedAt: new Date().toISOString(),
            config: {
                historyDays: cli.historyDays,
                maxClosedPositions: cli.maxClosedPositions,
                poolEligibilityRule: "FABRIQ_DLMM",
            },
            candidateCount: allCandidateWallets.length,
            completedCount: completedRecords.length,
            eligibleCount: eligibleRecords.length,
            ineligibleCount: ineligibleRecords.length,
            errorCount: errorRecords.length,
            knownValidatedWallets: Array.from(validatedSet).sort(),
            knownExcludedWallets: Object.entries(KNOWN_EXCLUDED_WALLETS).map(
                ([w, info]) => ({
                    wallet: w,
                    role: info.role,
                    reason: info.reason,
                })
            ),
            eligibleWallets: sortedEligible.map((r) => r.wallet),
            results: sortedResults,
        };

        atomicWriteJson(outFilePath, outputData);
    }

    function enqueueCheckpointWrite(record: PreflightWalletRecord): Promise<void> {
        existingResultsMap.set(record.wallet, record);
        writeChain = writeChain
            .then(async () => {
                writePreflightOutputToDisk();
            })
            .catch((err) => {
                console.error("[CHECKPOINT ERROR] Serialized write failed:", err?.message || err);
            });
        return writeChain;
    }

    // ----------------------------------------------------
    // Build Comprehensive Skip Set
    // ----------------------------------------------------
    const skipSet = new Set<string>();

    for (const w of validatedSet) skipSet.add(w);
    for (const w of guardSet) skipSet.add(w);
    for (const [w, rec] of existingResultsMap) {
        if (rec.status === "completed") {
            skipSet.add(w);
        }
    }
    for (const w of Object.keys(KNOWN_EXCLUDED_WALLETS)) skipSet.add(w);

    let untappedWallets: string[];
    if (cli.wallet) {
        if (!isValidSolanaAddress(cli.wallet)) {
            throw new Error(`Invalid Solana wallet address provided: ${cli.wallet}`);
        }
        untappedWallets = [cli.wallet];
    } else {
        untappedWallets = allCandidateWallets.filter((w) => !skipSet.has(w));
    }

    const workerCount = cli.workers;
    const targetNewEligible = cli.target;

    console.log(`History Window         : ${cli.historyDays} days`);
    console.log(`Max Closed Positions   : ${cli.maxClosedPositions}`);
    console.log(`Workers                : ${workerCount}`);
    console.log(`Untapped Candidates   : ${untappedWallets.length}`);
    console.log(`New Eligible Target   : ${targetNewEligible}\n`);

    // ----------------------------------------------------
    // Shared Counters & Queue State
    // ----------------------------------------------------
    const stats = {
        checkedThisRun: 0,
        eligibleNew: 0,
        ineligibleNew: 0,
        workloadGuardNew: 0,
        errors: 0,
    };

    let nextQueueIndex = 0;
    let totalAssigned = 0;

    function claimNextWallet(): { wallet: string; index: number; total: number } | null {
        if (stats.eligibleNew >= targetNewEligible) {
            return null;
        }
        if (cli.limit !== undefined && totalAssigned >= cli.limit) {
            return null;
        }
        if (nextQueueIndex >= untappedWallets.length) {
            return null;
        }

        const wallet = untappedWallets[nextQueueIndex];
        const index = nextQueueIndex + 1;
        nextQueueIndex++;
        totalAssigned++;

        return { wallet, index, total: untappedWallets.length };
    }

    function isTargetReached(): boolean {
        return stats.eligibleNew >= targetNewEligible;
    }

    const rateLimiter = new GlobalRateLimitCoordinator();
    const authLock = new SharedAuthRefreshLock();

    // Graceful interrupt handling to guarantee zero lost progress
    let isTerminating = false;
    const onExitSignal = async () => {
        if (isTerminating) return;
        isTerminating = true;
        console.log("\n[INTERRUPT] Exit signal caught. Awaiting pending writes before exit...");
        try {
            await writeChain;
            writePreflightOutputToDisk();
        } catch {}
        await closeFabriqConnection().catch(() => {});
        process.exit(130);
    };
    process.on("SIGINT", onExitSignal);
    process.on("SIGTERM", onExitSignal);

    // ----------------------------------------------------
    // Worker Implementation
    // ----------------------------------------------------
    async function runWorker(workerId: number): Promise<void> {
        const workerTag = `W${workerId}`;

        while (!isTargetReached()) {
            const claim = claimNextWallet();
            if (!claim) {
                break;
            }

            const { wallet } = claim;
            console.log(`[${workerTag}] Preflighting ${wallet}...`);

            try {
                const summary = await fetchWalletDlmmPoolSummary(
                    wallet,
                    cli.historyDays,
                    workerTag,
                    rateLimiter,
                    authLock
                );

                if (!summary.reachable) {
                    console.log(`[${workerTag}] ERROR | ${summary.error || "Unreachable"}`);
                    stats.errors++;
                    stats.checkedThisRun++;

                    await enqueueCheckpointWrite({
                        wallet,
                        status: "error",
                        fabriqPoolCount: 0,
                        dlmmPoolCount: 0,
                        dlmmPools: [],
                        legacyDlmmPoolCount: 0,
                        legacyDlmmPools: [],
                        closedPositionCount: 0,
                        historyDays: cli.historyDays,
                        eligible: null,
                        pagesFetched: summary.pagesFetched,
                        checkedAt: new Date().toISOString(),
                        error: summary.error,
                        reason: "RPC_OR_NETWORK_ERROR",
                    });
                    continue;
                }

                if (summary.dlmmPoolCount === 0) {
                    console.log(`[${workerTag}] INELIGIBLE | NO_DLMM_POOLS`);
                    stats.ineligibleNew++;
                    stats.checkedThisRun++;

                    await enqueueCheckpointWrite({
                        wallet,
                        status: "completed",
                        fabriqPoolCount: summary.fabriqPoolCount,
                        dlmmPoolCount: 0,
                        dlmmPools: [],
                        legacyDlmmPoolCount: 0,
                        legacyDlmmPools: [],
                        closedPositionCount: 0,
                        historyDays: cli.historyDays,
                        eligible: false,
                        pagesFetched: summary.pagesFetched,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        reason: "NO_DLMM_POOLS",
                    });
                } else if (summary.closedPositionCount === 0) {
                    console.log(`[${workerTag}] INELIGIBLE | 0_CLOSED_POSITIONS`);
                    stats.ineligibleNew++;
                    stats.checkedThisRun++;

                    await enqueueCheckpointWrite({
                        wallet,
                        status: "completed",
                        fabriqPoolCount: summary.fabriqPoolCount,
                        dlmmPoolCount: summary.dlmmPoolCount,
                        dlmmPools: summary.dlmmPools,
                        legacyDlmmPoolCount: summary.dlmmPoolCount,
                        legacyDlmmPools: summary.dlmmPools,
                        closedPositionCount: 0,
                        historyDays: cli.historyDays,
                        eligible: false,
                        pagesFetched: summary.pagesFetched,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        reason: "NO_CLOSED_POSITIONS_IN_DLMM_POOLS",
                    });
                } else if (summary.closedPositionCount > cli.maxClosedPositions) {
                    console.log(`[${workerTag}] WORKLOAD_GUARD | closed=${summary.closedPositionCount}`);
                    stats.workloadGuardNew++;
                    stats.checkedThisRun++;

                    await enqueueCheckpointWrite({
                        wallet,
                        status: "completed",
                        fabriqPoolCount: summary.fabriqPoolCount,
                        dlmmPoolCount: summary.dlmmPoolCount,
                        dlmmPools: summary.dlmmPools,
                        legacyDlmmPoolCount: summary.dlmmPoolCount,
                        legacyDlmmPools: summary.dlmmPools,
                        closedPositionCount: summary.closedPositionCount,
                        historyDays: cli.historyDays,
                        eligible: false,
                        pagesFetched: summary.pagesFetched,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        reason: `WORKLOAD_GUARD (${summary.closedPositionCount} > ${cli.maxClosedPositions})`,
                    });
                } else {
                    stats.eligibleNew++;
                    stats.checkedThisRun++;

                    console.log(
                        `[${workerTag}] ELIGIBLE | pools=${summary.dlmmPoolCount} | closed=${summary.closedPositionCount} | eligible=${stats.eligibleNew}/${targetNewEligible}`
                    );
                    console.log(`DLMM Pools             : ${summary.dlmmPoolCount}`);
                    console.log(`Closed Positions       : ${summary.closedPositionCount}`);
                    console.log(`History Window         : ${cli.historyDays} days\n`);

                    await enqueueCheckpointWrite({
                        wallet,
                        status: "completed",
                        fabriqPoolCount: summary.fabriqPoolCount,
                        dlmmPoolCount: summary.dlmmPoolCount,
                        dlmmPools: summary.dlmmPools,
                        legacyDlmmPoolCount: summary.dlmmPoolCount,
                        legacyDlmmPools: summary.dlmmPools,
                        closedPositionCount: summary.closedPositionCount,
                        historyDays: cli.historyDays,
                        eligible: true,
                        pagesFetched: summary.pagesFetched,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        reason: null,
                    });
                }
            } catch (err: any) {
                console.log(`[${workerTag}] ERROR | ${err?.message || err}`);
                stats.errors++;
                stats.checkedThisRun++;

                await enqueueCheckpointWrite({
                    wallet,
                    status: "error",
                    fabriqPoolCount: 0,
                    legacyDlmmPoolCount: 0,
                    legacyDlmmPools: [],
                    closedPositionCount: 0,
                    historyDays: cli.historyDays,
                    eligible: null,
                    pagesFetched: 0,
                    checkedAt: new Date().toISOString(),
                    error: String(err?.message || err),
                    reason: "UNHANDLED_EXCEPTION",
                });
            }
        }
    }

    try {
        const workerPromises: Promise<void>[] = [];
        for (let w = 1; w <= workerCount; w++) {
            workerPromises.push(runWorker(w));
        }
        await Promise.all(workerPromises);
    } finally {
        try {
            await writeChain;
            writePreflightOutputToDisk();
        } catch {}
        await closeFabriqConnection();
    }

    const untappedRemaining = Math.max(0, untappedWallets.length - stats.checkedThisRun);
    const assessment =
        stats.eligibleNew >= targetNewEligible || (stats.eligibleNew >= 20 && untappedRemaining === 0)
            ? "READY_FOR_NEXT_EXPANSION"
            : untappedRemaining === 0
            ? "SOURCE_EXHAUSTED"
            : stats.eligibleNew >= 20
            ? "READY_FOR_NEXT_EXPANSION"
            : "READY_FOR_NEXT_EXPANSION";

    console.log("\n==================================================");
    console.log("WALDISC-2 — LIVE PREFLIGHT EXPANSION\n");
    console.log(`History Window         : ${cli.historyDays} days`);
    console.log(`Max Closed Positions   : ${cli.maxClosedPositions}`);
    console.log(`Workers                : ${workerCount}`);
    console.log(`Current Validated       : ${validatedSet.size}`);
    console.log(`New Eligible Target     : ${targetNewEligible}\n`);
    console.log(`Checked This Run        : ${stats.checkedThisRun}`);
    console.log(`Eligible New            : ${stats.eligibleNew}`);
    console.log(`Ineligible New          : ${stats.ineligibleNew}`);
    console.log(`Workload Guard New      : ${stats.workloadGuardNew}`);
    console.log(`Errors                  : ${stats.errors}`);
    console.log(`Untapped Remaining      : ${untappedRemaining}\n`);
    console.log("Assessment:");
    console.log(assessment);
    console.log("==================================================");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("waldisc-2-preflight-wallets.ts") ||
        process.argv[1].endsWith("waldisc-2-preflight-wallets.js") ||
        process.argv[1].includes("waldisc-2-preflight-wallets"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Preflight scan failed: ${err.message}`);
        process.exit(1);
    });
}
