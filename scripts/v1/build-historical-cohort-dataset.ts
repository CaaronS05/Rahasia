import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    fabriqFetch,
    isFabriqDlmmPool,
    closeFabriqConnection,
} from "../discovery/core/fabriq-position-history.ts";

const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_MAX_CLOSED_POSITIONS = 300;
const DEFAULT_WORKERS = 5;
const DEFAULT_TARGET_VALID_WALLETS = 50;
const POOL_ELIGIBILITY_RULE = "FABRIQ_DLMM" as const;

export interface V1Contract {
    version: "v1";
    historyDays: number;
    poolEligibilityRule: "FABRIQ_DLMM";
    maxClosedPositions: number;
    alchemyRequired: false;
}

export interface V1PositionRecord {
    wallet: string;
    positionId: string;
    pool: string;
    openedAt: string | null;
    closedAt: string | null;
    holdDuration: number | null; // seconds
    holdDurationHours: number | null; // hours
    deposit: number; // totalAddUsd
    withdrawal: number; // totalRemoveUsd
    claimedFees: number; // totalFeeUsd
    pnl: number; // totalPnlUsd
    pnlPct: number | null; // totalPnlPctUsd / ROI
    winLoss: "WIN" | "LOSS" | "BREAKEVEN";
}

export interface V1DailyRecord {
    date: string;
    pnlUsd: number;
    feesUsd?: number;
    positions?: number;
    winRateUsd?: number | null;
    feeWinRateUsd?: number | null;
    [key: string]: any;
}

export interface V1WalletMetrics {
    closedPositionCount: number;
    uniqueDlmmPools: number;

    totalPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number | null;

    positionWinRate: number;

    medianPositionPnlPct: number | null;
    meanPositionPnlPct: number | null;

    medianHoldHours: number | null;
    meanHoldHours: number | null;

    totalDeposits: number;
    totalWithdrawals: number;
    totalFees: number;

    pnlConcentrationTop1: number | null;
    pnlConcentrationTop3: number | null;
}

export interface V1WalletRecord {
    wallet: string;
    valid: boolean;
    reason?: string | null;
    metrics: V1WalletMetrics | null;
    daily: V1DailyRecord[];
    positions: V1PositionRecord[];
}

export interface V1ScreeningSourceMetadata {
    type: "wallets-master";
    path: string;
    selectionMode: "full_master" | "single_wallet" | "limit";
    masterRows: number;
    uniqueValidAddresses: number;
    duplicateAddresses: number;
    invalidAddressRows: number;
    selectedCandidates: number;
}

export interface V1ScreeningSession {
    version: "v1";
    sessionId: string;
    status: "in_progress" | "completed";
    startedAt: string;
    completedAt?: string;
    referenceEndTime: string;
    candidateFingerprint: string;
    candidateCount: number;
    config: {
        historyDays: number;
        maxClosedPositions: number;
        poolEligibilityRule: "FABRIQ_DLMM";
    };
}

export interface V1ScreeningCheckpoint {
    sessionId: string;
    wallet: string;
    updatedAt: string;
    config: {
        version: "v1";
        historyDays: number;
        poolEligibilityRule: "FABRIQ_DLMM";
        maxClosedPositions: number;
    };
    valid: boolean;
    reason: string | null;
    metrics: V1WalletMetrics | null;
    daily: V1DailyRecord[];
    positions: V1PositionRecord[];
}

export interface V1ScreeningDatasetOutput {
    generatedAt: string;
    source: V1ScreeningSourceMetadata;
    contract: V1Contract;
    population: {
        candidateWallets: number;
        validWallets: number;
        invalidWallets: number;
        closedPositions: number;
        uniquePools: number;
    };
    wallets: V1WalletRecord[];
}

interface CliArgs {
    workers: number;
    historyDays: number;
    maxClosedPositions: number;
    target: number;
    limit?: number;
    wallet?: string;
    force: boolean;
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

function computeMedian(arr: number[]): number | null {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return Number(sorted[mid].toFixed(4));
    }
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);
    let workers = DEFAULT_WORKERS;
    let historyDays = DEFAULT_HISTORY_DAYS;
    let maxClosedPositions = DEFAULT_MAX_CLOSED_POSITIONS;
    let target = DEFAULT_TARGET_VALID_WALLETS;
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
            const parsed = Number(arg.slice(10));
            if (Number.isFinite(parsed) && parsed >= 1) workers = Math.floor(parsed);
        } else if (arg === "--history-days" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed >= 1) historyDays = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--history-days=")) {
            const parsed = Number(arg.slice(15));
            if (Number.isFinite(parsed) && parsed >= 1) historyDays = Math.floor(parsed);
        } else if (arg === "--max-closed-positions" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed >= 1) maxClosedPositions = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--max-closed-positions=")) {
            const parsed = Number(arg.slice(23));
            if (Number.isFinite(parsed) && parsed >= 1) maxClosedPositions = Math.floor(parsed);
        } else if (arg === "--target" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed >= 1) target = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--target=")) {
            const parsed = Number(arg.slice(9));
            if (Number.isFinite(parsed) && parsed >= 1) target = Math.floor(parsed);
        } else if (arg === "--limit" && args[i + 1]) {
            const parsed = Number(args[i + 1]);
            if (Number.isFinite(parsed) && parsed >= 1) limit = Math.floor(parsed);
            i++;
        } else if (arg.startsWith("--limit=")) {
            const parsed = Number(arg.slice(8));
            if (Number.isFinite(parsed) && parsed >= 1) limit = Math.floor(parsed);
        } else if (arg === "--wallet" && args[i + 1]) {
            wallet = args[i + 1];
            i++;
        } else if (arg.startsWith("--wallet=")) {
            wallet = arg.slice(9);
        } else if (arg === "--force") {
            force = true;
        }
    }

    return { workers, historyDays, maxClosedPositions, target, limit, wallet, force };
}

// ----------------------------------------------------
// Global Rate Limit Coordinator
// ----------------------------------------------------
class GlobalRateLimitCoordinator {
    private cooldownUntil = 0;
    private backoffStepIndex = 0;
    private readonly backoffSchedule = [5000, 10000, 20000, 30000, 60000];

    async waitForCooldown(): Promise<void> {
        const now = Date.now();
        if (now < this.cooldownUntil) {
            const waitMs = this.cooldownUntil - now;
            await sleep(waitMs);
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
            console.log(`[429 RATE LIMIT] [${workerLabel}] Global cooldown activated: pausing for ${cooldownMs / 1000}s`);
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

// ----------------------------------------------------
// Candidate Discovery from Master Dataset
// ----------------------------------------------------
interface MasterCandidateResult {
    candidateWallets: string[];
    sourceMetadata: {
        masterRows: number;
        uniqueValidAddresses: number;
        duplicateAddresses: number;
        invalidAddressRows: number;
    };
}

function loadMasterCandidates(
    customMasterPath?: string
): MasterCandidateResult {
    const masterPath = customMasterPath
        ? path.resolve(customMasterPath)
        : path.resolve("data/master/wallets-master.json");

    if (!fs.existsSync(masterPath)) {
        throw new Error(`Master wallets dataset not found: ${masterPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(masterPath, "utf8"));
    const rows: any[] = Array.isArray(raw?.wallets) ? raw.wallets : [];

    const uniqueValidSet = new Set<string>();
    let duplicateAddresses = 0;
    let invalidAddressRows = 0;

    for (const r of rows) {
        const rawAddr = r?.owner ?? r?.wallet ?? r?.wallet_address;
        if (typeof rawAddr === "string") {
            const trimmed = rawAddr.trim();
            if (isValidSolanaAddress(trimmed)) {
                if (uniqueValidSet.has(trimmed)) {
                    duplicateAddresses++;
                } else {
                    uniqueValidSet.add(trimmed);
                }
            } else {
                invalidAddressRows++;
            }
        } else {
            invalidAddressRows++;
        }
    }

    const candidateWallets = Array.from(uniqueValidSet).sort((a, b) =>
        a.localeCompare(b)
    );

    return {
        candidateWallets,
        sourceMetadata: {
            masterRows: rows.length,
            uniqueValidAddresses: candidateWallets.length,
            duplicateAddresses,
            invalidAddressRows,
        },
    };
}

// ----------------------------------------------------
// Session Management & Fingerprint
// ----------------------------------------------------
function computeCandidateFingerprint(wallets: string[]): string {
    return crypto.createHash("sha256").update(wallets.join(",")).digest("hex");
}

function loadOrCreateScreeningSession(
    candidates: string[],
    config: {
        historyDays: number;
        maxClosedPositions: number;
        poolEligibilityRule: "FABRIQ_DLMM";
    },
    force: boolean
): { session: V1ScreeningSession; isResumed: boolean } {
    const sessionPath = path.resolve("data/v1/screening-session.json");
    const fingerprint = computeCandidateFingerprint(candidates);

    if (!force && fs.existsSync(sessionPath)) {
        try {
            const existing: V1ScreeningSession = JSON.parse(
                fs.readFileSync(sessionPath, "utf8")
            );
            if (
                existing &&
                existing.version === "v1" &&
                existing.status === "in_progress" &&
                existing.candidateFingerprint === fingerprint &&
                existing.candidateCount === candidates.length &&
                existing.config?.historyDays === config.historyDays &&
                existing.config?.maxClosedPositions === config.maxClosedPositions &&
                existing.config?.poolEligibilityRule === config.poolEligibilityRule &&
                typeof existing.sessionId === "string" &&
                typeof existing.referenceEndTime === "string"
            ) {
                return { session: existing, isResumed: true };
            }
        } catch {}
    }

    const now = new Date();
    const newSession: V1ScreeningSession = {
        version: "v1",
        sessionId: `session_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        status: "in_progress",
        startedAt: now.toISOString(),
        referenceEndTime: now.toISOString(),
        candidateFingerprint: fingerprint,
        candidateCount: candidates.length,
        config,
    };

    atomicWriteJson(sessionPath, newSession);
    return { session: newSession, isResumed: false };
}

// ----------------------------------------------------
// Checkpoint Helpers
// ----------------------------------------------------
function sanitizeDailyRecords(
    daily: any[],
    cutoffDateStr: string,
    referenceEndDateStr: string
): V1DailyRecord[] {
    if (!Array.isArray(daily)) return [];
    const dailyMap = new Map<string, V1DailyRecord>();
    for (const d of daily) {
        if (!d || !d.date) continue;
        const dateStr = String(d.date).slice(0, 10);
        if (dateStr >= cutoffDateStr && dateStr <= referenceEndDateStr) {
            if (!dailyMap.has(dateStr)) {
                dailyMap.set(dateStr, {
                    date: dateStr,
                    pnlUsd: Number(d.pnlUsd ?? 0),
                    feesUsd: d.feesUsd !== undefined ? Number(d.feesUsd) : undefined,
                    positions: d.positions !== undefined ? Number(d.positions) : undefined,
                    winRateUsd: typeof d.winRateUsd === "number" ? d.winRateUsd : null,
                    feeWinRateUsd: typeof d.feeWinRateUsd === "number" ? d.feeWinRateUsd : null,
                });
            }
        }
    }
    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function loadWalletCheckpoint(
    sessionId: string,
    wallet: string,
    historyDays: number,
    maxClosedPositions: number,
    cutoffDateStr?: string,
    referenceEndDateStr?: string
): V1WalletRecord | null {
    const cpFile = path.resolve("data/v1/checkpoints", `${wallet}.json`);
    if (!fs.existsSync(cpFile)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(cpFile, "utf8"));
        if (
            data &&
            data.sessionId === sessionId &&
            data.config &&
            data.config.historyDays === historyDays &&
            data.config.maxClosedPositions === maxClosedPositions &&
            data.config.poolEligibilityRule === POOL_ELIGIBILITY_RULE &&
            typeof data.valid === "boolean"
        ) {
            // Operational fetch failures must not permanently become a completed wallet checkpoint!
            if (
                data.reason &&
                typeof data.reason === "string" &&
                data.reason.startsWith("FETCH_FAILED")
            ) {
                return null;
            }

            const rawDaily = Array.isArray(data.daily) ? data.daily : [];
            const sanitizedDaily = cutoffDateStr && referenceEndDateStr
                ? sanitizeDailyRecords(rawDaily, cutoffDateStr, referenceEndDateStr)
                : rawDaily;

            return {
                wallet: data.wallet,
                valid: data.valid,
                reason: data.reason ?? null,
                metrics: data.metrics ?? null,
                daily: sanitizedDaily,
                positions: Array.isArray(data.positions) ? data.positions : [],
            };
        }
    } catch {}
    return null;
}

function saveWalletCheckpoint(
    sessionId: string,
    record: V1WalletRecord,
    historyDays: number,
    maxClosedPositions: number
): void {
    // Operational fetch failures must not permanently become a completed wallet checkpoint!
    if (record.reason && record.reason.startsWith("FETCH_FAILED")) {
        return;
    }

    const cpDir = path.resolve("data/v1/checkpoints");
    if (!fs.existsSync(cpDir)) {
        fs.mkdirSync(cpDir, { recursive: true });
    }
    const cpFile = path.join(cpDir, `${record.wallet}.json`);
    const cpData: V1ScreeningCheckpoint = {
        sessionId,
        wallet: record.wallet,
        updatedAt: new Date().toISOString(),
        config: {
            version: "v1",
            historyDays,
            poolEligibilityRule: POOL_ELIGIBILITY_RULE,
            maxClosedPositions,
        },
        valid: record.valid,
        reason: record.reason ?? null,
        metrics: record.metrics,
        daily: record.daily,
        positions: record.positions,
    };
    atomicWriteJson(cpFile, cpData);
}

// ----------------------------------------------------
// Fabriq Data Fetching for Single Wallet
// ----------------------------------------------------
async function fetchWalletDailyCalendar(
    wallet: string,
    historyDays: number,
    workerLabel: string,
    rateLimiter: GlobalRateLimitCoordinator,
    authLock: SharedAuthRefreshLock,
    referenceEndTimeMs: number = Date.now()
): Promise<V1DailyRecord[]> {
    const refEnd = new Date(referenceEndTimeMs);
    const cutoffMs = refEnd.getTime() - historyDays * 86400 * 1000;
    const cutoffDateStr = new Date(cutoffMs).toISOString().slice(0, 10);
    const referenceEndDateStr = refEnd.toISOString().slice(0, 10);

    const monthsSet = new Set<string>();
    const d = new Date(cutoffMs);
    while (d <= refEnd) {
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        monthsSet.add(ym);
        d.setUTCDate(d.getUTCDate() + 15);
    }
    const currentYm = `${refEnd.getUTCFullYear()}-${String(refEnd.getUTCMonth() + 1).padStart(2, "0")}`;
    monthsSet.add(currentYm);

    const dailyMap = new Map<string, V1DailyRecord>();

    for (const month of Array.from(monthsSet).sort()) {
        try {
            const params = new URLSearchParams();
            params.set("month", month);
            params.set("timezone", "Asia/Jakarta");
            params.append("sources", "wallet");
            params.append("sources", "hawkfi");

            await rateLimiter.waitForCooldown();
            const reqStartTime = Date.now();

            let calRes: any;
            try {
                calRes = await fabriqFetch<any>(
                    `/portfolio/calendar/${wallet}`,
                    params
                );
                rateLimiter.onSuccess();
            } catch (err: any) {
                const msg = String(err?.message || err);
                if (msg.includes("401")) {
                    await authLock.handleAuthError(reqStartTime, workerLabel);
                } else if (msg.includes("429")) {
                    await rateLimiter.trigger429Cooldown(workerLabel);
                }
                continue;
            }

            const data = calRes?.data;
            if (data && typeof data === "object") {
                for (const [dateStr, dayInfo] of Object.entries(data)) {
                    if (
                        dateStr >= cutoffDateStr &&
                        dateStr <= referenceEndDateStr &&
                        dayInfo &&
                        typeof dayInfo === "object"
                    ) {
                        const info = dayInfo as any;
                        if (!dailyMap.has(dateStr)) {
                            dailyMap.set(dateStr, {
                                date: dateStr,
                                pnlUsd: Number(info.pnlUsd ?? 0),
                                feesUsd: Number(info.feesUsd ?? 0),
                                positions: Number(info.positions ?? 0),
                                winRateUsd: typeof info.winRateUsd === "number" ? info.winRateUsd : null,
                                feeWinRateUsd: typeof info.feeWinRateUsd === "number" ? info.feeWinRateUsd : null,
                            });
                        }
                    }
                }
            }
        } catch {
            // Calendar is auxiliary; failure does not invalidate wallet
        }
    }

    const dailyRecords = Array.from(dailyMap.values());
    dailyRecords.sort((a, b) => a.date.localeCompare(b.date));
    return dailyRecords;
}

async function processWallet(
    wallet: string,
    historyDays: number,
    maxClosedPositions: number,
    workerLabel: string,
    rateLimiter: GlobalRateLimitCoordinator,
    authLock: SharedAuthRefreshLock,
    referenceEndTimeMs: number = Date.now()
): Promise<V1WalletRecord> {
    const cutoffMs = referenceEndTimeMs - historyDays * 86400 * 1000;

    let page = 1;
    const allDlmmPoolIds = new Set<string>();

    try {
        // Step 1: Discover pools via /history/<WALLET>/pnl-by-pool
        while (true) {
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

            if (pageItems.length === 0) break;

            for (const row of pageItems) {
                const poolId =
                    row.pool_id ||
                    row.poolId ||
                    row.pool?.id ||
                    row.pool?.address ||
                    row.id;

                if (!poolId) continue;
                const poolIdStr = String(poolId).trim();

                if (isFabriqDlmmPool(row)) {
                    allDlmmPoolIds.add(poolIdStr);
                }
            }

            if (pageItems.length < 100) break;
            page++;
        }

        if (allDlmmPoolIds.size === 0) {
            return {
                wallet,
                valid: false,
                reason: "NO_DLMM_POOLS",
                metrics: null,
                daily: [],
                positions: [],
            };
        }

        // Step 2: Fetch positions via /history/<WALLET>/positions-by-pool
        const poolIdsToQuery = Array.from(allDlmmPoolIds);
        const poolBatchSize = 25;
        const closedPositions: V1PositionRecord[] = [];

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
                    const poolKey = String(pId).trim();
                    if (!allDlmmPoolIds.has(poolKey)) continue;

                    if (Array.isArray(posList)) {
                        for (const pos of posList) {
                            if (!pos?.id) continue;
                            const closeTs = pos.latest_close_ts || pos.closed_at || pos.closedAt;
                            const closeMs = parseTimestampMs(closeTs);

                            if (closeMs !== null && closeMs >= cutoffMs) {
                                const openTs = pos.opened_at || pos.openedAt || null;
                                const openMs = parseTimestampMs(openTs);

                                let holdDurationSeconds: number | null = null;
                                if (typeof pos.duration === "number") {
                                    holdDurationSeconds = Math.round(pos.duration);
                                } else if (closeMs !== null && openMs !== null && closeMs >= openMs) {
                                    holdDurationSeconds = Math.round((closeMs - openMs) / 1000);
                                }

                                const holdDurationHours = holdDurationSeconds !== null
                                    ? Number((holdDurationSeconds / 3600).toFixed(4))
                                    : null;

                                const deposit = Number(pos.total_add_usd ?? pos.depositUsd ?? 0);
                                const withdrawal = Number(pos.total_rem_usd ?? pos.withdrawalUsd ?? 0);
                                const claimedFees = Number(pos.total_fee_usd ?? pos.feeUsd ?? 0);
                                const pnl = Number(pos.total_pnl_usd ?? pos.pnlUsd ?? 0);

                                let pnlPct: number | null = null;
                                if (pos.total_pnl_pct_usd !== undefined && pos.total_pnl_pct_usd !== null) {
                                    const parsed = Number(pos.total_pnl_pct_usd);
                                    if (Number.isFinite(parsed)) pnlPct = parsed;
                                } else if (deposit > 0) {
                                    pnlPct = Number(((pnl / deposit) * 100).toFixed(4));
                                }

                                let winLoss: "WIN" | "LOSS" | "BREAKEVEN";
                                if (pnl > 0) {
                                    winLoss = "WIN";
                                } else if (pnl < 0) {
                                    winLoss = "LOSS";
                                } else {
                                    winLoss = "BREAKEVEN";
                                }

                                closedPositions.push({
                                    wallet,
                                    positionId: String(pos.id),
                                    pool: poolKey,
                                    openedAt: openTs ? String(openTs) : null,
                                    closedAt: closeTs ? String(closeTs) : null,
                                    holdDuration: holdDurationSeconds,
                                    holdDurationHours,
                                    deposit,
                                    withdrawal,
                                    claimedFees,
                                    pnl,
                                    pnlPct,
                                    winLoss,
                                });
                            }
                        }
                    }
                }
            }
        }

        if (closedPositions.length === 0) {
            return {
                wallet,
                valid: false,
                reason: "0_CLOSED_POSITIONS",
                metrics: null,
                daily: [],
                positions: [],
            };
        }

        if (closedPositions.length > maxClosedPositions) {
            return {
                wallet,
                valid: false,
                reason: `WORKLOAD_GUARD (${closedPositions.length} > ${maxClosedPositions})`,
                metrics: null,
                daily: [],
                positions: closedPositions,
            };
        }

        // Step 3: Fetch Daily Calendar
        const daily = await fetchWalletDailyCalendar(
            wallet,
            historyDays,
            workerLabel,
            rateLimiter,
            authLock,
            referenceEndTimeMs
        );

        // Step 4: Calculate Descriptive Metrics
        const closedPositionCount = closedPositions.length;
        const uniqueDlmmPoolsSet = new Set(closedPositions.map((p) => p.pool).filter(Boolean));
        const uniqueDlmmPools = uniqueDlmmPoolsSet.size;

        const totalPnl = Number(closedPositions.reduce((sum, p) => sum + p.pnl, 0).toFixed(4));

        const winningPositions = closedPositions.filter((p) => p.winLoss === "WIN");
        const losingPositions = closedPositions.filter((p) => p.winLoss === "LOSS");

        const grossProfit = Number(winningPositions.reduce((sum, p) => sum + p.pnl, 0).toFixed(4));
        const grossLoss = Number(Math.abs(losingPositions.reduce((sum, p) => sum + p.pnl, 0)).toFixed(4));

        const profitFactor = grossLoss > 0
            ? Number((grossProfit / grossLoss).toFixed(4))
            : (grossProfit > 0 ? null : 0);

        const positionWinRate = Number(((winningPositions.length / closedPositionCount) * 100).toFixed(2));

        const pnlPcts = closedPositions
            .map((p) => p.pnlPct)
            .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

        const meanPositionPnlPct = pnlPcts.length > 0
            ? Number((pnlPcts.reduce((sum, v) => sum + v, 0) / pnlPcts.length).toFixed(4))
            : null;

        const medianPositionPnlPct = computeMedian(pnlPcts);

        const holdHours = closedPositions
            .map((p) => p.holdDurationHours)
            .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

        const meanHoldHours = holdHours.length > 0
            ? Number((holdHours.reduce((sum, v) => sum + v, 0) / holdHours.length).toFixed(4))
            : null;

        const medianHoldHours = computeMedian(holdHours);

        const totalDeposits = Number(closedPositions.reduce((sum, p) => sum + p.deposit, 0).toFixed(4));
        const totalWithdrawals = Number(closedPositions.reduce((sum, p) => sum + p.withdrawal, 0).toFixed(4));
        const totalFees = Number(closedPositions.reduce((sum, p) => sum + p.claimedFees, 0).toFixed(4));

        const positiveProfits = closedPositions
            .map((p) => p.pnl)
            .filter((p) => p > 0)
            .sort((a, b) => b - a);

        const positiveProfitTotal = positiveProfits.reduce((sum, v) => sum + v, 0);

        let pnlConcentrationTop1: number | null = null;
        let pnlConcentrationTop3: number | null = null;

        if (positiveProfitTotal > 0 && positiveProfits.length > 0) {
            const top1Sum = positiveProfits[0];
            const top3Sum = positiveProfits.slice(0, 3).reduce((sum, v) => sum + v, 0);
            pnlConcentrationTop1 = Number(((top1Sum / positiveProfitTotal) * 100).toFixed(2));
            pnlConcentrationTop3 = Number(((top3Sum / positiveProfitTotal) * 100).toFixed(2));
        }

        const metrics: V1WalletMetrics = {
            closedPositionCount,
            uniqueDlmmPools,
            totalPnl,
            grossProfit,
            grossLoss,
            profitFactor,
            positionWinRate,
            medianPositionPnlPct,
            meanPositionPnlPct,
            medianHoldHours,
            meanHoldHours,
            totalDeposits,
            totalWithdrawals,
            totalFees,
            pnlConcentrationTop1,
            pnlConcentrationTop3,
        };

        return {
            wallet,
            valid: true,
            reason: null,
            metrics,
            daily,
            positions: closedPositions,
        };
    } catch (err: any) {
        return {
            wallet,
            valid: false,
            reason: `FETCH_FAILED: ${String(err?.message || err)}`,
            metrics: null,
            daily: [],
            positions: [],
        };
    }
}

// ----------------------------------------------------
// Main Execution
// ----------------------------------------------------
export async function runHistoricalCohortScreening(): Promise<V1ScreeningDatasetOutput> {
    const cli = parseCliArgs();

    const masterResult = loadMasterCandidates();
    let candidateWallets = masterResult.candidateWallets;
    let selectionMode: "full_master" | "single_wallet" | "limit" = "full_master";

    if (cli.wallet) {
        selectionMode = "single_wallet";
        candidateWallets = [cli.wallet.trim()];
    } else if (cli.limit !== undefined) {
        selectionMode = "limit";
        candidateWallets = candidateWallets.slice(0, cli.limit);
    }

    const sourceMetadata: V1ScreeningSourceMetadata = {
        type: "wallets-master",
        path: "data/master/wallets-master.json",
        selectionMode,
        masterRows: masterResult.sourceMetadata.masterRows,
        uniqueValidAddresses: masterResult.sourceMetadata.uniqueValidAddresses,
        duplicateAddresses: masterResult.sourceMetadata.duplicateAddresses,
        invalidAddressRows: masterResult.sourceMetadata.invalidAddressRows,
        selectedCandidates: candidateWallets.length,
    };

    const sessionConfig = {
        historyDays: cli.historyDays,
        maxClosedPositions: cli.maxClosedPositions,
        poolEligibilityRule: POOL_ELIGIBILITY_RULE,
    };

    const { session: activeSession, isResumed } = loadOrCreateScreeningSession(
        candidateWallets,
        sessionConfig,
        cli.force
    );
    const sessionPath = path.resolve("data/v1/screening-session.json");

    const outDir = path.resolve("data/v1");
    const datasetPath = path.join(outDir, "wallet-screening-dataset.json");
    const checkpointIndexPath = path.resolve("data/v1/checkpoints/screening-checkpoint.json");

    const referenceEndTime = new Date(activeSession.referenceEndTime);
    const referenceEndTimeMs = referenceEndTime.getTime();
    const cutoffMs = referenceEndTimeMs - cli.historyDays * 86400 * 1000;
    const cutoffDateStr = new Date(cutoffMs).toISOString().slice(0, 10);
    const referenceEndDateStr = referenceEndTime.toISOString().slice(0, 10);

    const processedMap = new Map<string, V1WalletRecord>();
    const pendingWallets: string[] = [];

    // Check for existing valid checkpoints belonging to this active session
    for (const w of candidateWallets) {
        if (!cli.force) {
            const cp = loadWalletCheckpoint(
                activeSession.sessionId,
                w,
                cli.historyDays,
                cli.maxClosedPositions,
                cutoffDateStr,
                referenceEndDateStr
            );
            if (cp) {
                processedMap.set(w, cp);
                continue;
            }
        }
        pendingWallets.push(w);
    }

    console.log("==================================================");
    console.log("V1 — FABRIQ HISTORICAL SCREENING DATASET BUILDER");
    console.log("==================================================");
    console.log(`Session ID              : ${activeSession.sessionId} (${isResumed ? "RESUMED" : "NEW"})`);
    console.log(`Candidate Source        : data/master/wallets-master.json (${selectionMode})`);
    console.log(`History Window          : ${cli.historyDays} days`);
    console.log(`Pool Rule               : ${POOL_ELIGIBILITY_RULE}`);
    console.log(`Max Closed Positions    : ${cli.maxClosedPositions}`);
    console.log(`Alchemy                 : NOT USED`);
    console.log(`Reference Window        : [${cutoffDateStr} to ${referenceEndDateStr}]`);
    console.log(`Total Candidates        : ${candidateWallets.length}`);
    console.log(`Checkpointed Previously : ${processedMap.size}`);
    console.log(`Pending Fetch           : ${pendingWallets.length}`);
    console.log(`Workers                 : ${cli.workers}\n`);

    const rateLimiter = new GlobalRateLimitCoordinator();
    const authLock = new SharedAuthRefreshLock();

    let writeChain: Promise<void> = Promise.resolve();

    function persistDatasetAndIndex(): void {
        const records = Array.from(processedMap.values());
        const validRecords = records.filter((r) => r.valid);
        const invalidRecords = records.filter((r) => !r.valid);

        const totalClosedPositions = validRecords.reduce(
            (sum, r) => sum + (r.metrics?.closedPositionCount ?? r.positions.length),
            0
        );

        const allUniquePools = new Set<string>();
        for (const r of validRecords) {
            for (const p of r.positions) {
                if (p.pool) allUniquePools.add(p.pool);
            }
        }

        const outputData: V1ScreeningDatasetOutput = {
            generatedAt: referenceEndTime.toISOString(),
            source: sourceMetadata,
            contract: {
                version: "v1",
                historyDays: cli.historyDays,
                poolEligibilityRule: POOL_ELIGIBILITY_RULE,
                maxClosedPositions: cli.maxClosedPositions,
                alchemyRequired: false,
            },
            population: {
                candidateWallets: records.length,
                validWallets: validRecords.length,
                invalidWallets: invalidRecords.length,
                closedPositions: totalClosedPositions,
                uniquePools: allUniquePools.size,
            },
            wallets: records,
        };

        atomicWriteJson(datasetPath, outputData);
        atomicWriteJson(checkpointIndexPath, {
            generatedAt: referenceEndTime.toISOString(),
            sessionId: activeSession.sessionId,
            config: {
                version: "v1",
                historyDays: cli.historyDays,
                poolEligibilityRule: POOL_ELIGIBILITY_RULE,
                maxClosedPositions: cli.maxClosedPositions,
            },
            population: outputData.population,
            completedCount: records.length,
        });
    }

    function recordProcessed(record: V1WalletRecord): Promise<void> {
        processedMap.set(record.wallet, record);
        saveWalletCheckpoint(activeSession.sessionId, record, cli.historyDays, cli.maxClosedPositions);
        writeChain = writeChain.then(async () => {
            persistDatasetAndIndex();
        }).catch(() => {});
        return writeChain;
    }

    let isTerminating = false;
    const onExitSignal = async () => {
        if (isTerminating) return;
        isTerminating = true;
        console.log("\n[INTERRUPT] Exit signal caught. Flushing dataset state...");
        try {
            await writeChain;
            persistDatasetAndIndex();
            // Preserve session manifest in in_progress state
            atomicWriteJson(sessionPath, activeSession);
        } catch {}
        await closeFabriqConnection().catch(() => {});
        process.exit(130);
    };
    process.on("SIGINT", onExitSignal);
    process.on("SIGTERM", onExitSignal);

    let nextQueueIndex = 0;

    async function runWorker(workerId: number): Promise<void> {
        const workerTag = `W${workerId}`;

        while (true) {
            let walletToProcess: string | null = null;
            let currentIdx = 0;

            if (nextQueueIndex < pendingWallets.length) {
                walletToProcess = pendingWallets[nextQueueIndex];
                currentIdx = nextQueueIndex + 1;
                nextQueueIndex++;
            } else {
                break;
            }

            console.log(`[${workerTag}] [${currentIdx}/${pendingWallets.length}] Processing ${walletToProcess}...`);

            const result = await processWallet(
                walletToProcess,
                cli.historyDays,
                cli.maxClosedPositions,
                workerTag,
                rateLimiter,
                authLock,
                referenceEndTimeMs
            );

            if (result.valid) {
                console.log(
                    `[${workerTag}] VALID | positions=${result.metrics?.closedPositionCount} | pools=${result.metrics?.uniqueDlmmPools} | pnl=$${result.metrics?.totalPnl} | winRate=${result.metrics?.positionWinRate}%`
                );
            } else {
                console.log(`[${workerTag}] INVALID | ${result.reason}`);
            }

            await recordProcessed(result);
        }
    }

    if (pendingWallets.length > 0) {
        const activeWorkers = Math.min(cli.workers, pendingWallets.length);
        const workerPromises: Promise<void>[] = [];
        for (let i = 1; i <= activeWorkers; i++) {
            workerPromises.push(runWorker(i));
        }
        await Promise.all(workerPromises);
    }

    await writeChain;
    persistDatasetAndIndex();
    await closeFabriqConnection().catch(() => {});

    // Final Assembly & Terminal Report
    const allRecords = Array.from(processedMap.values());
    const validRecords = allRecords.filter((r) => r.valid);
    const invalidRecords = allRecords.filter((r) => !r.valid);
    const fetchFailedRecords = allRecords.filter(
        (r) => r.reason && r.reason.startsWith("FETCH_FAILED")
    );

    const totalClosedPositions = validRecords.reduce(
        (sum, r) => sum + (r.metrics?.closedPositionCount ?? r.positions.length),
        0
    );

    const allUniquePools = new Set<string>();
    for (const r of validRecords) {
        for (const p of r.positions) {
            if (p.pool) allUniquePools.add(p.pool);
        }
    }

    // Operational fetch failures must not allow Stage 1 to claim successful completion
    if (fetchFailedRecords.length > 0) {
        atomicWriteJson(sessionPath, activeSession);
        throw new Error(
            `Screening incomplete: ${fetchFailedRecords.length} wallet(s) failed with FETCH_FAILED. Session ${activeSession.sessionId} remains in_progress for resumption.`
        );
    }

    // Mark session as completed
    activeSession.status = "completed";
    activeSession.completedAt = new Date().toISOString();
    atomicWriteJson(sessionPath, activeSession);

    const finalResultStatus = validRecords.length >= cli.target
        ? "READY_FOR_V1_ANALYTICS"
        : "INSUFFICIENT_VALID_WALLETS";

    console.log("\n==================================================");
    console.log("V1 — FABRIQ HISTORICAL SCREENING DATASET");
    console.log("==================================================");
    console.log(`Session ID              : ${activeSession.sessionId} (COMPLETED)`);
    console.log(`History Window          : ${cli.historyDays} days`);
    console.log(`Pool Rule               : ${POOL_ELIGIBILITY_RULE}`);
    console.log(`Max Closed Positions    : ${cli.maxClosedPositions}`);
    console.log(`Alchemy                 : NOT USED\n`);
    console.log(`Candidate Wallets       : ${allRecords.length}`);
    console.log(`Valid Wallets           : ${validRecords.length}`);
    console.log(`Invalid Wallets         : ${invalidRecords.length}`);
    console.log(`Closed Positions        : ${totalClosedPositions}`);
    console.log(`Unique DLMM Pools       : ${allUniquePools.size}\n`);
    console.log("Result:");
    console.log(finalResultStatus);
    console.log("\nV1 minimum target:");
    console.log(`Valid Wallets >= ${cli.target}`);
    console.log("==================================================");
    console.log(`Dataset Path            : ${datasetPath}\n`);

    return {
        generatedAt: referenceEndTime.toISOString(),
        source: sourceMetadata,
        contract: {
            version: "v1",
            historyDays: cli.historyDays,
            poolEligibilityRule: POOL_ELIGIBILITY_RULE,
            maxClosedPositions: cli.maxClosedPositions,
            alchemyRequired: false,
        },
        population: {
            candidateWallets: allRecords.length,
            validWallets: validRecords.length,
            invalidWallets: invalidRecords.length,
            closedPositions: totalClosedPositions,
            uniquePools: allUniquePools.size,
        },
        wallets: allRecords,
    };
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-historical-cohort-dataset.ts") ||
        process.argv[1].endsWith("build-historical-cohort-dataset.js") ||
        process.argv[1].includes("build-historical-cohort-dataset"));

if (isMain) {
    runHistoricalCohortScreening().catch((err) => {
        console.error(`\n[FATAL ERROR] V1 historical screening failed: ${err?.message || err}`);
        process.exit(1);
    });
}
