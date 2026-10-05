import fs from "fs";
import path from "path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FABRIQ_API_BASE = "https://apinew.fabriq.trade";
const CDP_URL = "http://127.0.0.1:9222";
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let cdpBrowser: Browser | null = null;
let fabriqPage: Page | null = null;
let token: string | null = null;
let tokenExpiresAt = 0;
let tokenRefreshPromise: Promise<string> | null = null;

function decodeJwtExpiry(tokenStr: string): number {
    try {
        const payload = tokenStr.split(".")[1];
        if (!payload) {
            return 0;
        }

        const json = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8")
        );

        if (!json.exp) {
            return 0;
        }

        return json.exp * 1000;
    } catch {
        return 0;
    }
}

async function getFabriqPage(log?: (msg: string) => void): Promise<Page> {
    if (fabriqPage && !fabriqPage.isClosed()) {
        return fabriqPage;
    }

    if (!cdpBrowser) {
        log?.("[BOOT] Connecting to Brave via CDP (http://127.0.0.1:9222)...");
        cdpBrowser = await chromium.connectOverCDP(CDP_URL, {
            timeout: 120_000,
        });
    }

    const context = cdpBrowser.contexts()[0];
    if (!context) {
        throw new Error(
            "No Brave context found. Start Brave with remote debugging enabled."
        );
    }

    const page =
        context.pages().find((p) => p.url().includes("fabriq.trade")) ?? null;

    if (!page) {
        throw new Error(
            "Fabriq tab not found. Open https://fabriq.trade in Brave first."
        );
    }

    fabriqPage = page;
    log?.(`[BOOT] Fabriq page: ${page.url()}`);
    return fabriqPage;
}

async function refreshTokenFromBrowser(log?: (msg: string) => void): Promise<string> {
    const page = await getFabriqPage(log);

    while (true) {
        const result = await page.evaluate(async () => {
            const response = await fetch("/auth/verify", {
                credentials: "include",
                cache: "no-store",
            });

            return {
                status: response.status,
                text: await response.text(),
            };
        });

        if (result.status === 403) {
            (log || console.log)(
                "[AUTH WAIT] /auth/verify blocked by Cloudflare (403) — retrying in 5s"
            );
            await sleep(5000);
            continue;
        }

        if (result.status !== 200) {
            throw new Error(
                `/auth/verify failed: ${result.status} ${result.text.slice(0, 200)}`
            );
        }

        const json = JSON.parse(result.text);

        if (!json.token) {
            throw new Error("JWT missing from /auth/verify");
        }

        token = String(json.token);
        tokenExpiresAt = decodeJwtExpiry(token) || Date.now() + 45_000;

        const secondsLeft = Math.max(
            0,
            Math.floor((tokenExpiresAt - Date.now()) / 1000)
        );

        log?.(`[AUTH] JWT refreshed (${secondsLeft}s)`);
        return token;
    }
}

async function getToken(
    forceRefresh = false,
    log?: (msg: string) => void
): Promise<string> {
    if (!forceRefresh && token && Date.now() < tokenExpiresAt - 10_000) {
        return token;
    }

    if (!tokenRefreshPromise) {
        tokenRefreshPromise = refreshTokenFromBrowser(log).finally(() => {
            tokenRefreshPromise = null;
        });
    }

    return tokenRefreshPromise;
}

export async function closeFabriqConnection(): Promise<void> {
    if (cdpBrowser) {
        try {
            await cdpBrowser.close();
        } catch {
            // Ignore error on CDP disconnect
        } finally {
            cdpBrowser = null;
            fabriqPage = null;
        }
    }
}

export const cleanupFabriqConnection = closeFabriqConnection;

export function isFabriqDlmmPool(rowOrPool: any): boolean {
    if (!rowOrPool) return false;
    const pool = rowOrPool.pool || rowOrPool;
    const dex = String(pool?.dex || rowOrPool?.dex || "").trim().toUpperCase();
    return dex === "METEORA_DLMM" || dex === "DLMM" || dex.includes("DLMM");
}

export interface FabriqPoolMetadata {
    binStep?: number | null;
    [key: string]: any;
}

export interface FabriqPoolRecord {
    pool_id: string;
    position_count?: number;
    position_count_wallet?: number;
    position_count_hawkfi?: number;
    total_add_usd?: number;
    total_add_sol?: number;
    total_rem_usd?: number;
    total_rem_sol?: number;
    total_fee_usd?: number;
    total_fee_sol?: number;
    total_pnl_usd?: number;
    total_pnl_sol?: number;
    total_pnl_pct_usd?: number;
    total_pnl_pct_sol?: number;
    latest_close_ts?: string | number | null;
    earliest_open_ts?: string | number | null;
    duration?: number | null;
    pool?: any;
    parsedParams?: FabriqPoolMetadata | null;
}

export interface FabriqPositionRecord {
    id: string;
    pool_id: string;
    source: string;
    total_add_usd: number;
    total_add_sol: number;
    total_rem_usd: number;
    total_rem_sol: number;
    total_fee_usd: number;
    total_fee_sol: number;
    total_pnl_usd: number;
    total_pnl_sol: number;
    total_pnl_pct_usd: number;
    total_pnl_pct_sol: number;
    latest_close_ts: string | null;
    opened_at: string | null;
    raw?: any;
}

export interface FabriqTransactionEvent {
    rawId: string;
    rawType: string;
    category: "initialize" | "add" | "remove" | "claim_fee" | "close" | "unknown";
    positionId: string;
    poolId: string;
    createdAt: string;
    signature: string;
    source: string;
    tokenXAmount: number;
    tokenYAmount: number;
    tokenXAmountUsd: number;
    tokenYAmountUsd: number;
    tokenXAmountSol: number;
    tokenYAmountSol: number;
    totalInUsd: number;
    totalInSol: number;
    raw?: any;
}

export interface FabriqClosedPositionHistoryScope {
    protocol: "meteora_dlmm";
    poolUniverse: "legacy_dlmm" | "fabriq_dlmm";
    canonicalPoolFilterApplied: boolean;
    fabriqPoolsDiscovered: number;
    eligibleLegacyPools: number;
    excludedNonLegacyPools: number;
    eligibleLegacyPoolsAfterLimit?: number;
}

export interface FetchFabriqHistoryOptions {
    maxPools?: number;
    positionBatchSize?: number;
    canonicalPoolsPath?: string;
    onLog?: (msg: string) => void;
}

export interface FabriqClosedPositionHistoryResult {
    wallet: string;
    pools: FabriqPoolRecord[];
    positions: FabriqPositionRecord[];
    events: FabriqTransactionEvent[];
    poolPagesFetched: number;
    poolsFetched: number;
    positionsFetched: number;
    transactionEventsFetched: number;
    uniquePositions: number;
    uniquePools: number;
    eventTypeCounts: Record<string, number>;
    unknownTypes: Record<string, number>;
    walletSourcePositions: number;
    hawkfiSourcePositions: number;
    scope: FabriqClosedPositionHistoryScope;
}

export function loadCanonicalLegacyDlmmPoolAddresses(
    customPath?: string
): Set<string> {
    const primaryPath = customPath
        ? path.resolve(customPath)
        : path.resolve("data/pools/legacy-dlmm-pools.json");

    if (!fs.existsSync(primaryPath)) {
        throw new Error(
            `[FAIL CLOSED] Canonical Legacy DLMM pools file not found: ${primaryPath}`
        );
    }

    let parsed: any;
    try {
        const raw = fs.readFileSync(primaryPath, "utf8");
        parsed = JSON.parse(raw);
    } catch (err: any) {
        throw new Error(
            `[FAIL CLOSED] Failed to read or parse canonical Legacy DLMM pools file (${primaryPath}): ${err?.message || err}`
        );
    }

    const poolList = Array.isArray(parsed?.pools) ? parsed.pools : null;
    if (!poolList || poolList.length === 0) {
        throw new Error(
            `[FAIL CLOSED] Canonical pools list missing or empty in: ${primaryPath}`
        );
    }

    const addresses = new Set<string>();
    for (const pool of poolList) {
        if (!pool || typeof pool !== "object") continue;

        // Preserve project rule: pairType === 0
        if (pool.pairType !== undefined && pool.pairType !== 0) {
            continue;
        }

        const addr =
            typeof pool.address === "string" && pool.address.trim().length > 0
                ? pool.address.trim()
                : typeof pool.id === "string" && pool.id.trim().length > 0
                ? pool.id.trim()
                : null;

        if (addr) {
            addresses.add(addr);
        }
    }

    if (addresses.size === 0) {
        throw new Error(
            `[FAIL CLOSED] Canonical pool address field cannot be determined or no eligible pools found in: ${primaryPath}`
        );
    }

    return addresses;
}

export async function fabriqFetch<T>(
    endpoint: string,
    params?: URLSearchParams,
    options?: { onLog?: (msg: string) => void },
    attempt = 1
): Promise<T> {
    const queryString = params?.toString() ? `?${params.toString()}` : "";
    const url = `${FABRIQ_API_BASE}${endpoint}${queryString}`;
    const log = options?.onLog;

    try {
        const jwt = await getToken(false, log);

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: "application/json",
            },
        });

        // --------------------------------
        // JWT expired/rejected (401)
        // --------------------------------
        if (response.status === 401) {
            if (attempt >= MAX_RETRIES) {
                throw new Error("401 Unauthorized after retries");
            }

            log?.("[AUTH] 401 → refreshing JWT");
            await getToken(true, log);

            return fabriqFetch<T>(endpoint, params, options, attempt + 1);
        }

        // --------------------------------
        // Cloudflare / forbidden (403)
        // --------------------------------
        if (response.status === 403) {
            throw new Error(
                "403 Forbidden. Check the existing Fabriq browser session."
            );
        }

        // --------------------------------
        // Data not ready (404)
        // --------------------------------
        if (response.status === 404) {
            log?.("[FABRIQ] 404 data not ready; waiting 5s and retrying...");
            await sleep(5000);
            return fabriqFetch<T>(endpoint, params, options, 1);
        }

        // --------------------------------
        // Rate limit (429)
        // --------------------------------
        if (response.status === 429) {
            if (attempt >= MAX_RETRIES) {
                throw new Error("429 Too Many Requests");
            }

            const retryAfter =
                Number(response.headers.get("retry-after")) || 5;

            log?.(`[RATE LIMIT] waiting ${retryAfter}s`);
            await sleep(retryAfter * 1000);

            return fabriqFetch<T>(endpoint, params, options, attempt + 1);
        }

        // --------------------------------
        // Server error (5xx)
        // --------------------------------
        if (response.status >= 500) {
            if (attempt >= MAX_RETRIES) {
                throw new Error(`Server error ${response.status}`);
            }

            const delay = attempt * 2000;
            log?.(`[RETRY] server ${response.status}, waiting ${delay}ms`);
            await sleep(delay);

            return fabriqFetch<T>(endpoint, params, options, attempt + 1);
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
        }

        return (await response.json()) as T;
    } catch (error: any) {
        const msg = String(error?.message || "");
        if (
            msg.includes("403 Forbidden") ||
            msg.includes("No Brave context found") ||
            msg.includes("Fabriq tab not found") ||
            msg.includes("/auth/verify failed") ||
            msg.includes("JWT missing") ||
            attempt >= MAX_RETRIES
        ) {
            throw error;
        }

        const delay = attempt * 2000;
        await sleep(delay);
        return fabriqFetch<T>(endpoint, params, options, attempt + 1);
    }
}

function parsePoolParamsDefensively(params: any): FabriqPoolMetadata | null {
    if (!params) return null;
    let parsed: any = null;

    if (typeof params === "object") {
        parsed = params;
    } else if (typeof params === "string") {
        try {
            parsed = JSON.parse(params);
        } catch {
            return null;
        }
    }

    if (!parsed || typeof parsed !== "object") return null;

    const binStep =
        parsed.bin_step !== undefined
            ? Number(parsed.bin_step)
            : parsed.binStep !== undefined
            ? Number(parsed.binStep)
            : null;

    return {
        ...parsed,
        binStep,
    };
}

export async function fetchFabriqClosedPositionHistory(
    wallet: string,
    options?: FetchFabriqHistoryOptions
): Promise<FabriqClosedPositionHistoryResult> {
    const log = options?.onLog || ((msg: string) => console.log(msg));
    const maxPools = options?.maxPools ?? 0;
    const positionBatchSize = Math.max(1, options?.positionBatchSize ?? 20);

    log(`[FABRIQ-DISC] Starting closed-position discovery for wallet: ${wallet}`);

    // Pre-flight check: load canonical Legacy DLMM pool set only if custom path explicitly provided
    let canonicalLegacyPoolAddresses: Set<string> | null = null;
    if (options?.canonicalPoolsPath) {
        canonicalLegacyPoolAddresses = loadCanonicalLegacyDlmmPoolAddresses(
            options.canonicalPoolsPath
        );
    }

    // 1. Fetch all closed pool rows via GET /history/<WALLET>/pnl-by-pool
    const rawFabriqPools: FabriqPoolRecord[] = [];
    let poolPagesFetched = 0;
    let page = 1;

    while (true) {
        poolPagesFetched++;
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

        log(`[FABRIQ-DISC] Fetching pool history page ${page}...`);
        const resJson = await fabriqFetch<any>(
            `/history/${wallet}/pnl-by-pool`,
            params,
            { onLog: log }
        );

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

            const parsedParams = parsePoolParamsDefensively(row.pool?.params);

            rawFabriqPools.push({
                pool_id: String(poolId),
                position_count: Number(row.position_count ?? 0),
                position_count_wallet: Number(row.position_count_wallet ?? 0),
                position_count_hawkfi: Number(row.position_count_hawkfi ?? 0),
                total_add_usd: Number(row.total_add_usd ?? 0),
                total_add_sol: Number(row.total_add_sol ?? 0),
                total_rem_usd: Number(row.total_rem_usd ?? 0),
                total_rem_sol: Number(row.total_rem_sol ?? 0),
                total_fee_usd: Number(row.total_fee_usd ?? 0),
                total_fee_sol: Number(row.total_fee_sol ?? 0),
                total_pnl_usd: Number(row.total_pnl_usd ?? 0),
                total_pnl_sol: Number(row.total_pnl_sol ?? 0),
                total_pnl_pct_usd: Number(row.total_pnl_pct_usd ?? 0),
                total_pnl_pct_sol: Number(row.total_pnl_pct_sol ?? 0),
                latest_close_ts: row.latest_close_ts ?? null,
                earliest_open_ts: row.earliest_open_ts ?? null,
                duration: row.duration !== undefined ? Number(row.duration) : null,
                pool: row.pool,
                parsedParams,
            });
        }

        log(
            `[FABRIQ-DISC] Page ${page}: fetched ${pageItems.length} pools (total: ${rawFabriqPools.length})`
        );

        if (pageItems.length < 100) {
            break;
        }

        page++;
    }

    // Deduplicate raw Fabriq pools by pool_id
    const seenRawPoolIds = new Set<string>();
    const deduplicatedRawPools: FabriqPoolRecord[] = [];
    for (const p of rawFabriqPools) {
        if (!seenRawPoolIds.has(p.pool_id)) {
            seenRawPoolIds.add(p.pool_id);
            deduplicatedRawPools.push(p);
        }
    }

    const fabriqPoolsDiscovered = deduplicatedRawPools.length;

    // 2. Filter Fabriq pool records explicitly classified as DLMM
    const dlmmMatches = deduplicatedRawPools.filter((p) => {
        if (canonicalLegacyPoolAddresses) {
            return canonicalLegacyPoolAddresses.has(p.pool_id);
        }
        return isFabriqDlmmPool(p);
    });
    const excludedCount = fabriqPoolsDiscovered - dlmmMatches.length;

    log(`[FABRIQ-DISC] Fabriq pools discovered: ${fabriqPoolsDiscovered}`);
    log(`[FABRIQ-DISC] Fabriq DLMM matches: ${dlmmMatches.length}`);
    log(`[FABRIQ-DISC] Non-DLMM pools excluded: ${excludedCount}`);

    // Apply maxPools AFTER DLMM filtering
    let pools = dlmmMatches;
    if (maxPools > 0) {
        pools = dlmmMatches.slice(0, maxPools);
        log(`[FABRIQ-DISC] Eligible DLMM pools after limit: ${pools.length}`);
    }

    const eligibleLegacyPools = dlmmMatches.length;
    const scope: FabriqClosedPositionHistoryScope = {
        protocol: "meteora_dlmm",
        poolUniverse: canonicalLegacyPoolAddresses ? "legacy_dlmm" : "fabriq_dlmm",
        canonicalPoolFilterApplied: Boolean(canonicalLegacyPoolAddresses),
        fabriqPoolsDiscovered,
        eligibleLegacyPools: dlmmMatches.length,
        excludedNonLegacyPools: excludedCount,
        ...(maxPools > 0 ? { eligibleLegacyPoolsAfterLimit: pools.length } : {}),
    };

    // 3. Discover individual position IDs via GET /history/<WALLET>/positions-by-pool
    const positions: FabriqPositionRecord[] = [];
    const poolIds = pools.map((p) => p.pool_id);
    const allowedPoolIds = new Set(poolIds);

    const poolBatchSize = 25;
    for (let i = 0; i < poolIds.length; i += poolBatchSize) {
        const batch = poolIds.slice(i, i + poolBatchSize);
        const params = new URLSearchParams();
        params.set("poolIds", batch.join(","));
        params.append("sources", "wallet");
        params.append("sources", "hawkfi");
        params.set("timezone", "Asia/Jakarta");
        params.set("pnlCurrency", "USD");
        params.set("pnlScope", "pool");
        params.set("lastCloseScope", "pool");
        params.set("durationScope", "pool");
        params.set("depositsScope", "pool");
        params.set("withdrawalsScope", "pool");
        params.set("feesScope", "pool");

        log(
            `[FABRIQ-DISC] Fetching positions for pool batch ${Math.floor(i / poolBatchSize) + 1}/${Math.ceil(poolIds.length / poolBatchSize)} (${batch.length} pools)...`
        );

        const posRes = await fabriqFetch<any>(
            `/history/${wallet}/positions-by-pool`,
            params,
            { onLog: log }
        );

        const resData = posRes?.data ?? posRes;

        if (resData && typeof resData === "object" && !Array.isArray(resData)) {
            for (const [poolId, posList] of Object.entries(resData)) {
                if (!allowedPoolIds.has(String(poolId))) continue;
                if (Array.isArray(posList)) {
                    for (const pos of posList) {
                        if (!pos?.id) continue;
                        positions.push({
                            id: String(pos.id),
                            pool_id: String(poolId),
                            source: String(pos.source ?? "wallet"),
                            total_add_usd: Number(pos.total_add_usd ?? 0),
                            total_add_sol: Number(pos.total_add_sol ?? 0),
                            total_rem_usd: Number(pos.total_rem_usd ?? 0),
                            total_rem_sol: Number(pos.total_rem_sol ?? 0),
                            total_fee_usd: Number(pos.total_fee_usd ?? 0),
                            total_fee_sol: Number(pos.total_fee_sol ?? 0),
                            total_pnl_usd: Number(pos.total_pnl_usd ?? 0),
                            total_pnl_sol: Number(pos.total_pnl_sol ?? 0),
                            total_pnl_pct_usd: Number(pos.total_pnl_pct_usd ?? 0),
                            total_pnl_pct_sol: Number(pos.total_pnl_pct_sol ?? 0),
                            latest_close_ts: pos.latest_close_ts
                                ? String(pos.latest_close_ts)
                                : null,
                            opened_at: pos.opened_at ? String(pos.opened_at) : null,
                            raw: pos,
                        });
                    }
                }
            }
        } else if (Array.isArray(resData)) {
            for (const pos of resData) {
                if (!pos?.id) continue;
                const poolId = String(pos.pool_id || pos.poolId || "");
                if (poolId && !allowedPoolIds.has(poolId)) continue;
                positions.push({
                    id: String(pos.id),
                    pool_id: poolId,
                    source: String(pos.source ?? "wallet"),
                    total_add_usd: Number(pos.total_add_usd ?? 0),
                    total_add_sol: Number(pos.total_add_sol ?? 0),
                    total_rem_usd: Number(pos.total_rem_usd ?? 0),
                    total_rem_sol: Number(pos.total_rem_sol ?? 0),
                    total_fee_usd: Number(pos.total_fee_usd ?? 0),
                    total_fee_sol: Number(pos.total_fee_sol ?? 0),
                    total_pnl_usd: Number(pos.total_pnl_usd ?? 0),
                    total_pnl_sol: Number(pos.total_pnl_sol ?? 0),
                    total_pnl_pct_usd: Number(pos.total_pnl_pct_usd ?? 0),
                    total_pnl_pct_sol: Number(pos.total_pnl_pct_sol ?? 0),
                    latest_close_ts: pos.latest_close_ts
                        ? String(pos.latest_close_ts)
                        : null,
                    opened_at: pos.opened_at ? String(pos.opened_at) : null,
                    raw: pos,
                });
            }
        }
    }

    log(`[FABRIQ-DISC] Total positions discovered across pools: ${positions.length}`);

    // Deduplicate positions by position ID
    const uniquePositionsMap = new Map<string, FabriqPositionRecord>();
    for (const pos of positions) {
        if (!uniquePositionsMap.has(pos.id)) {
            uniquePositionsMap.set(pos.id, pos);
        }
    }
    const deduplicatedPositions = Array.from(uniquePositionsMap.values());

    // 3. Fetch lifecycle transaction records via GET /history/transactions?positionIds=...
    const allPositionIds = deduplicatedPositions.map((p) => p.id);
    const events: FabriqTransactionEvent[] = [];
    const eventTypeCounts: Record<string, number> = {};
    const unknownTypes: Record<string, number> = {};

    const positionToPoolMap = new Map<string, string>();
    for (const pos of deduplicatedPositions) {
        positionToPoolMap.set(pos.id, pos.pool_id);
    }

    for (let i = 0; i < allPositionIds.length; i += positionBatchSize) {
        const batch = allPositionIds.slice(i, i + positionBatchSize);
        const params = new URLSearchParams();
        params.set("positionIds", batch.join(","));

        log(
            `[FABRIQ-DISC] Fetching transactions for position batch ${Math.floor(i / positionBatchSize) + 1}/${Math.ceil(allPositionIds.length / positionBatchSize)} (${batch.length} positions)...`
        );

        const txRes = await fabriqFetch<any>(`/history/transactions`, params, {
            onLog: log,
        });

        const txData = txRes?.data ?? txRes;

        const rawEventList: any[] = [];

        if (txData && typeof txData === "object" && !Array.isArray(txData)) {
            for (const [posId, list] of Object.entries(txData)) {
                if (Array.isArray(list)) {
                    for (const item of list) {
                        rawEventList.push({
                            ...item,
                            position_id: item.position_id || item.positionId || posId,
                        });
                    }
                }
            }
        } else if (Array.isArray(txData)) {
            rawEventList.push(...txData);
        }

        for (const tx of rawEventList) {
            const rawType = String(tx.type || tx.rawType || tx.action || "UNKNOWN");
            eventTypeCounts[rawType] = (eventTypeCounts[rawType] || 0) + 1;

            let category: "initialize" | "add" | "remove" | "claim_fee" | "close" | "unknown";
            if (rawType === "POSITION_OPEN") {
                category = "initialize";
            } else if (rawType === "ADD_LIQUIDITY") {
                category = "add";
            } else if (rawType === "REMOVE_LIQUIDITY") {
                category = "remove";
            } else if (rawType === "FEE_CLAIM") {
                category = "claim_fee";
            } else if (rawType === "POSITION_CLOSE") {
                category = "close";
            } else {
                category = "unknown";
                unknownTypes[rawType] = (unknownTypes[rawType] || 0) + 1;
            }

            const positionId = String(
                tx.position_id || tx.positionId || tx.position || ""
            );
            const poolId =
                tx.pool_id ||
                tx.poolId ||
                positionToPoolMap.get(positionId) ||
                "";

            const rawId = String(tx.id || tx._id || "");
            const createdAt = String(
                tx.created_at || tx.createdAt || tx.timestamp || ""
            );
            const signature = String(
                tx.signature || tx.tx_hash || tx.txHash || ""
            );
            const source = String(tx.source || "");

            events.push({
                rawId,
                rawType,
                category,
                positionId,
                poolId,
                createdAt,
                signature,
                source,
                tokenXAmount: Number(tx.token_x_amount ?? tx.tokenXAmount ?? 0),
                tokenYAmount: Number(tx.token_y_amount ?? tx.tokenYAmount ?? 0),
                tokenXAmountUsd: Number(
                    tx.token_x_amount_usd ?? tx.tokenXAmountUsd ?? 0
                ),
                tokenYAmountUsd: Number(
                    tx.token_y_amount_usd ?? tx.tokenYAmountUsd ?? 0
                ),
                tokenXAmountSol: Number(
                    tx.token_x_amount_sol ?? tx.tokenXAmountSol ?? 0
                ),
                tokenYAmountSol: Number(
                    tx.token_y_amount_sol ?? tx.tokenYAmountSol ?? 0
                ),
                totalInUsd: Number(
                    tx.total_in_usd ?? tx.totalInUsd ?? tx.total_usd ?? 0
                ),
                totalInSol: Number(
                    tx.total_in_sol ?? tx.totalInSol ?? tx.total_sol ?? 0
                ),
                raw: tx,
            });
        }
    }

    log(`[FABRIQ-DISC] Total transaction events fetched: ${events.length}`);

    let walletSourcePositions = 0;
    let hawkfiSourcePositions = 0;

    for (const pos of deduplicatedPositions) {
        if (pos.source === "hawkfi") {
            hawkfiSourcePositions++;
        } else {
            walletSourcePositions++;
        }
    }

    const uniquePoolsSet = new Set(pools.map((p) => p.pool_id));

    return {
        wallet,
        pools,
        positions: deduplicatedPositions,
        events,
        poolPagesFetched,
        poolsFetched: pools.length,
        positionsFetched: deduplicatedPositions.length,
        transactionEventsFetched: events.length,
        uniquePositions: deduplicatedPositions.length,
        uniquePools: uniquePoolsSet.size,
        eventTypeCounts,
        unknownTypes,
        walletSourcePositions,
        hawkfiSourcePositions,
        scope,
    };
}
