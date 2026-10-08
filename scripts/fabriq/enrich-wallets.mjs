import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import path from "node:path";

// ======================================================
// CONFIG
// ======================================================

const DATASET =
    process.env.FABRIQ_DATASET
        ? path.resolve(process.env.FABRIQ_DATASET)
        : path.resolve(
            "data/master/wallets-master.json"
        );

const STATE_DATASET =
    process.env.FABRIQ_STATE_DATASET
        ? path.resolve(process.env.FABRIQ_STATE_DATASET)
        : DATASET;
const OUTPUT =
    process.env.FABRIQ_OUTPUT
        ? path.resolve(process.env.FABRIQ_OUTPUT)
        : path.resolve(
            "data/raw/fabriq/fabriq-enriched.json"
        );

const CHECKPOINT =
    process.env.FABRIQ_CHECKPOINT
        ? path.resolve(process.env.FABRIQ_CHECKPOINT)
        : path.resolve(
            "data/checkpoints/fabriq.jsonl"
        );

const CDP_URL = "http://127.0.0.1:9222";

const TIMEZONE = "Asia/Jakarta";

const DELAY_MS =
    process.env.FABRIQ_WALLET_DELAY_MS !== undefined
        ? Math.max(
            0,
            parseInt(
                process.env.FABRIQ_WALLET_DELAY_MS,
                10
            ) || 0
        )
        : 0;

const MAX_IN_FLIGHT =
    Math.max(
        1,
        parseInt(
            process.env.FABRIQ_MAX_IN_FLIGHT ??
            process.env.FABRIQ_HTTP_CONCURRENCY ??
            "12",
            10
        ) || 12
    );

const MIN_IN_FLIGHT =
    Math.max(
        1,
        parseInt(
            process.env.FABRIQ_MIN_IN_FLIGHT ?? "2",
            10
        ) || 2
    );

const MAX_RETRIES = 3;
const STALE_AFTER_HOURS = 24;
const RETRY_404_DELAY_MS = 5000;
const REFRESH_BEFORE =
    process.env.FABRIQ_REFRESH_BEFORE
        ? Date.parse(
            process.env.FABRIQ_REFRESH_BEFORE
        )
        : null;

const CONCURRENCY =
    Math.max(
        1,
        parseInt(
            process.env.FABRIQ_CONCURRENCY ?? "8",
            10
        ) || 8
    );

const LIMIT =
    Math.max(
        0,
        parseInt(
            process.env.FABRIQ_LIMIT ?? "0",
            10
        ) || 0
    );

// ======================================================
// HELPERS
// ======================================================

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

const metrics = {
    totalRequests: 0,
    activeRequests: 0,
    peakActiveRequests: 0,
    statsLatencies: [],
    calendarLatencies: [],
    allLatencies: [],
    walletTimesMs: [],
    http429Count: 0,
    http403Count: 0,
    http404Count: 0,
    http5xxCount: 0,
    networkErrorCount: 0,
    retryWaitTimeMs: 0,
    checkpointWriteTimeMs: 0,
    jwtRefreshTimeMs: 0,
    jwtRefreshCount: 0,
};

function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function average(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

class RequestScheduler {
    constructor({
        maxInFlight = 10,
        minInFlight = 2,
        initialInFlight = 8,
        minIntervalMs = 20,
    } = {}) {
        this.maxInFlight = maxInFlight;
        this.minInFlight = minInFlight;
        this.currentLimit = Math.min(
            maxInFlight,
            Math.max(minInFlight, initialInFlight)
        );
        this.activeInFlight = 0;
        this.minIntervalMs = minIntervalMs;
        this.lastDispatchTime = 0;
        this.queue = [];
        this.pausedUntil = 0;
        this.consecutiveSuccesses = 0;
        this.pumpScheduled = false;
    }

    acquire() {
        return new Promise((resolve) => {
            this.queue.push(resolve);
            this.pump();
        });
    }

    release() {
        if (this.activeInFlight > 0) {
            this.activeInFlight--;
        }
        this.pump();
    }

    onSuccess(latencyMs) {
        this.consecutiveSuccesses++;
        if (this.consecutiveSuccesses >= 20 && latencyMs < 2000) {
            if (this.currentLimit < this.maxInFlight) {
                this.currentLimit++;
            }
            this.consecutiveSuccesses = 0;
        }
    }

    onRateLimit(retryAfterSeconds) {
        this.consecutiveSuccesses = 0;
        this.currentLimit = Math.max(
            this.minInFlight,
            Math.floor(this.currentLimit * 0.7)
        );
        this.pausedUntil =
            Date.now() + (retryAfterSeconds * 1000);
        console.log(
            `[SCHEDULER] 429 backoff → limit=${this.currentLimit}, pause=${retryAfterSeconds}s`
        );
    }

    onServerError() {
        this.consecutiveSuccesses = 0;
        if (this.currentLimit > this.minInFlight) {
            this.currentLimit--;
            console.log(
                `[SCHEDULER] 5xx backoff → limit=${this.currentLimit}`
            );
        }
    }

    pump() {
        if (this.pumpScheduled) return;

        const now = Date.now();
        if (now < this.pausedUntil) {
            this.pumpScheduled = true;
            setTimeout(() => {
                this.pumpScheduled = false;
                this.pump();
            }, Math.max(10, this.pausedUntil - now));
            return;
        }

        while (
            this.queue.length > 0 &&
            this.activeInFlight < this.currentLimit
        ) {
            const elapsed =
                Date.now() - this.lastDispatchTime;
            if (elapsed < this.minIntervalMs) {
                this.pumpScheduled = true;
                setTimeout(() => {
                    this.pumpScheduled = false;
                    this.pump();
                }, this.minIntervalMs - elapsed);
                return;
            }

            this.activeInFlight++;
            this.lastDispatchTime = Date.now();
            const resolve = this.queue.shift();
            resolve();
        }
    }
}

const scheduler = new RequestScheduler({
    maxInFlight: MAX_IN_FLIGHT,
    minInFlight: MIN_IN_FLIGHT,
    initialInFlight: Math.min(MAX_IN_FLIGHT, 10),
    minIntervalMs: 20,
});

function getWalletOwner(row) {
    if (typeof row === "string") {
        return row;
    }

    return (
        row?.owner ??
        row?.wallet ??
        row?.wallet_address ??
        null
    );
}

function extractWalletRows(raw) {
    const candidates = [
        raw,
        raw?.wallets,
        raw?.smart_lp,
        raw?.data?.wallets,
        raw?.data?.smart_lp,
        raw?.data?.data,
        raw?.data,
    ];

    return candidates.find(Array.isArray) ?? [];
}

function getJakartaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;

    return {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        dateStr: `${year}-${month}-${day}`,
        monthStr: `${year}-${month}`,
    };
}

const RAW_START_MONTH = process.env.FABRIQ_START_MONTH
    ? process.env.FABRIQ_START_MONTH.trim()
    : null;

function getCalendarRange() {
    const today = getJakartaDateParts(new Date());

    if (RAW_START_MONTH) {
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(RAW_START_MONTH)) {
            throw new Error(
                `Invalid FABRIQ_START_MONTH: "${RAW_START_MONTH}". Expected format YYYY-MM.`
            );
        }

        if (RAW_START_MONTH > today.monthStr) {
            throw new Error(
                `FABRIQ_START_MONTH (${RAW_START_MONTH}) cannot be later than current month (${today.monthStr}).`
            );
        }

        const [startYear, startMonthNum] = RAW_START_MONTH.split("-").map(Number);
        const [curYear, curMonthNum] = today.monthStr.split("-").map(Number);

        const months = [];
        let y = startYear;
        let m = startMonthNum;

        while (y < curYear || (y === curYear && m <= curMonthNum)) {
            months.push(`${y}-${String(m).padStart(2, "0")}`);
            m++;
            if (m > 12) {
                m = 1;
                y++;
            }
        }

        return {
            mode: "custom",
            startMonth: RAW_START_MONTH,
            todayStr: today.dateStr,
            currentMonth: today.monthStr,
            months,
            datesSet: null,
        };
    }

    // Default: Rolling 90 days
    const dateStrings = [];
    const monthsSet = new Set();

    for (let i = 89; i >= 0; i--) {
        const d = new Date(Date.UTC(today.year, today.month - 1, today.day - i));
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dt = String(d.getUTCDate()).padStart(2, "0");
        const ymd = `${y}-${m}-${dt}`;
        dateStrings.push(ymd);
        monthsSet.add(`${y}-${m}`);
    }

    return {
        mode: "90d",
        startMonth: null,
        todayStr: today.dateStr,
        currentMonth: today.monthStr,
        startDate: dateStrings[0],
        endDate: dateStrings[dateStrings.length - 1],
        datesSet: new Set(dateStrings),
        months: Array.from(monthsSet).sort(),
    };
}

const CALENDAR_RANGE = getCalendarRange();
const CURRENT_MONTH = CALENDAR_RANGE.currentMonth;
const CALENDAR_MONTHS = CALENDAR_RANGE.months;
const ROLLING_90_DATES = CALENDAR_RANGE.datesSet;
const TODAY_STR = CALENDAR_RANGE.todayStr;
const IS_CUSTOM_RANGE = CALENDAR_RANGE.mode === "custom";

function getCurrentMonth() {
    return CURRENT_MONTH;
}

function hasRequiredCalendars(row) {
    const calendars =
        row?.fabriq?.calendars;

    if (
        !calendars ||
        typeof calendars !== "object"
    ) {
        return false;
    }

    return CALENDAR_MONTHS.every(
        (month) =>
            calendars[month] &&
            typeof calendars[month] === "object"
    );
}

function isFabriqFresh(row) {
    const fetchedAt =
        row?.fabriq?.fetchedAt;

    if (!fetchedAt) {
        return false;
    }

    if (!hasRequiredCalendars(row)) {
        return false;
    }

    const timestamp =
        Date.parse(fetchedAt);

    if (!Number.isFinite(timestamp)) {
        return false;
    }

    if (
        Number.isFinite(
            REFRESH_BEFORE
        ) &&
        timestamp <
        REFRESH_BEFORE
    ) {
        return false;
    }

    const ageMs =
        Date.now() - timestamp;

    const staleAfterMs =
        STALE_AFTER_HOURS *
        60 *
        60 *
        1000;

    return ageMs < staleAfterMs;
}

function decodeJwtExpiry(token) {
    try {
        const payload = token.split(".")[1];

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

// ======================================================
// CHECKPOINT
// ======================================================

let checkpointWriteQueue =
    Promise.resolve();

async function saveCheckpoint(row) {
    const t0 = performance.now();
    const line =
        JSON.stringify(row) + "\n";

    checkpointWriteQueue =
        checkpointWriteQueue.then(
            () =>
                fs.appendFile(
                    CHECKPOINT,
                    line
                )
        );

    await checkpointWriteQueue;
    metrics.checkpointWriteTimeMs += performance.now() - t0;
}

async function loadCheckpoint(targetWallets = null) {
    const map = new Map();

    try {
        const text = await fs.readFile(
            CHECKPOINT,
            "utf8"
        );

        const lines = text
            .split("\n")
            .filter(Boolean);

        for (const line of lines) {
            try {
                const row = JSON.parse(line);

                if (row.owner) {
                    if (row.status === "ok") {
                        // last successful checkpoint for the wallet wins
                        map.set(row.owner, row);
                    } else if (row.status === "error") {
                        // Wallets with status "error" must NEVER be treated as completed.
                        // On the next run/resume they must automatically be processed again.
                        map.delete(row.owner);
                    }
                }
            } catch {
                // ignore broken line
            }
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    // Cross-pool cache reuse gate
    if (
        REFRESH_BEFORE === null &&
        process.env.FABRIQ_CROSS_POOL_CACHE !== "0" &&
        Array.isArray(targetWallets) &&
        targetWallets.length > 0
    ) {
        const needed = new Set(
            targetWallets.filter((wallet) => {
                const row = map.get(wallet);
                return !(
                    row?.status === "ok" &&
                    row?.fabriq?.stats &&
                    typeof row.fabriq.stats === "object" &&
                    hasRequiredCalendars(row) &&
                    isFabriqFresh(row)
                );
            })
        );

        if (needed.size > 0) {
            let reusedCount = 0;
            const discoveryBase = path.resolve("data/discovery/pool-scanner");
            const currentCheckpointResolved = path.resolve(CHECKPOINT);

            try {
                const entries = await fs.readdir(discoveryBase, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    if (needed.size === 0) break;

                    const siblingCheckpoint = path.join(
                        discoveryBase,
                        entry.name,
                        "selected-scan",
                        "fabriq-checkpoint.jsonl"
                    );

                    if (path.resolve(siblingCheckpoint) === currentCheckpointResolved) {
                        continue;
                    }

                    let siblingText;
                    try {
                        siblingText = await fs.readFile(siblingCheckpoint, "utf8");
                    } catch {
                        continue;
                    }

                    const siblingLines = siblingText.split("\n").filter(Boolean);
                    for (const sLine of siblingLines) {
                        if (needed.size === 0) break;
                        try {
                            const row = JSON.parse(sLine);
                            if (!row?.owner || !needed.has(row.owner)) continue;

                            if (
                                row.status === "ok" &&
                                row.fabriq?.stats &&
                                typeof row.fabriq.stats === "object" &&
                                hasRequiredCalendars(row) &&
                                isFabriqFresh(row)
                            ) {
                                map.set(row.owner, row);
                                needed.delete(row.owner);
                                await saveCheckpoint(row);
                                reusedCount++;
                            }
                        } catch {
                            // ignore malformed lines
                        }
                    }
                }
            } catch (err) {
                console.warn(
                    `[CROSS_POOL_CACHE] Warning: could not scan sibling checkpoints: ${err.message}`
                );
            }

            if (reusedCount > 0) {
                console.log(
                    `[CROSS_POOL_CACHE] Reused ${reusedCount} fresh wallet(s) from sibling pool checkpoints`
                );
            }
        }
    }

    return map;
}

// ======================================================
// CONNECT TO BRAVE
// ======================================================

console.log("[BOOT] Connecting to Brave...");

const browser = await chromium.connectOverCDP(
    CDP_URL,
    {
        timeout: 120_000,
    }
);

const context = browser.contexts()[0];

if (!context) {
    throw new Error(
        "No Brave context found. Start Brave with remote debugging."
    );
}

const page =
    context.pages().find((p) =>
        p.url().includes("fabriq.trade")
    ) ?? null;

if (!page) {
    throw new Error(
        "Fabriq tab not found. Open https://fabriq.trade in Brave first."
    );
}

console.log(
    `[BOOT] Fabriq page: ${page.url()}`
);

// ======================================================
// AUTH
// ======================================================

let token = null;
let tokenExpiresAt = 0;

let tokenRefreshPromise =
    null;

async function refreshTokenFromBrowser() {
    const t0 = performance.now();
    try {
        while (true) {
            const result =
                await page.evaluate(
                    async () => {
                        const response =
                            await fetch(
                                "/auth/verify",
                                {
                                    credentials:
                                        "include",

                                    cache:
                                        "no-store",
                                }
                            );

                        return {
                            status:
                                response.status,

                            text:
                                await response.text(),
                        };
                    }
                );

            if (result.status === 403) {
                console.log(
                    "[AUTH WAIT] /auth/verify blocked by Cloudflare (403) — retrying in 5s"
                );
                await sleep(5000);
                continue;
            }

            if (result.status !== 200) {
                throw new Error(
                    `/auth/verify failed: ${result.status} ${result.text.slice(
                        0,
                        200
                    )}`
                );
            }

            const json =
                JSON.parse(
                    result.text
                );

            if (!json.token) {
                throw new Error(
                    "JWT missing from /auth/verify"
                );
            }

            token =
                json.token;

            tokenExpiresAt =
                decodeJwtExpiry(token) ||
                Date.now() + 45_000;

            const secondsLeft =
                Math.max(
                    0,
                    Math.floor(
                        (
                            tokenExpiresAt -
                            Date.now()
                        ) / 1000
                    )
                );

            metrics.jwtRefreshCount++;
            metrics.jwtRefreshTimeMs += performance.now() - t0;

            console.log(
                `[AUTH] JWT refreshed (${secondsLeft}s)`
            );

            return token;
        }
    } catch (err) {
        metrics.jwtRefreshTimeMs += performance.now() - t0;
        throw err;
    }
}

async function getToken(
    forceRefresh = false
) {
    if (
        !forceRefresh &&
        token &&
        Date.now() <
        tokenExpiresAt - 10_000
    ) {
        return token;
    }

    if (!tokenRefreshPromise) {
        tokenRefreshPromise =
            refreshTokenFromBrowser()
                .finally(
                    () => {
                        tokenRefreshPromise =
                            null;
                    }
                );
    }

    return tokenRefreshPromise;
}



// ======================================================
// FABRIQ API
// ======================================================

async function fabriqFetch(
    url,
    initialAttempt = 1
) {
    let attempt = initialAttempt;
    const isStats = url.includes("/portfolio/stats/");

    while (true) {
        let slotHeld = false;
        await scheduler.acquire();
        slotHeld = true;
        const releaseSlot = () => {
            if (slotHeld) {
                slotHeld = false;
                scheduler.release();
            }
        };

        metrics.totalRequests++;
        metrics.activeRequests++;
        if (metrics.activeRequests > metrics.peakActiveRequests) {
            metrics.peakActiveRequests = metrics.activeRequests;
        }
        const reqT0 = performance.now();

        try {
            const jwt = await getToken();

            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: "application/json",
                },
            });

            const reqDur = performance.now() - reqT0;
            metrics.allLatencies.push(reqDur);
            if (isStats) {
                metrics.statsLatencies.push(reqDur);
            } else {
                metrics.calendarLatencies.push(reqDur);
            }

            // --------------------------------
            // JWT expired/rejected
            // --------------------------------

            if (response.status === 401) {
                releaseSlot();
                if (attempt >= MAX_RETRIES) {
                    throw new Error(
                        "401 Unauthorized after retries"
                    );
                }

                console.log(
                    "[AUTH] 401 → refreshing JWT"
                );

                await getToken(true);

                attempt++;
                continue;
            }

            // --------------------------------
            // Rate limit
            // --------------------------------

            if (response.status === 429) {
                metrics.http429Count++;
                const retryAfter =
                    Number(
                        response.headers.get(
                            "retry-after"
                        )
                    ) || 5;

                scheduler.onRateLimit(retryAfter);
                releaseSlot();

                if (attempt >= MAX_RETRIES) {
                    throw new Error(
                        "429 Too Many Requests"
                    );
                }

                console.log(
                    `[RATE LIMIT] waiting ${retryAfter}s`
                );

                metrics.retryWaitTimeMs += retryAfter * 1000;
                await sleep(
                    retryAfter * 1000
                );

                attempt++;
                continue;
            }

            // --------------------------------
            // Cloudflare / forbidden
            // --------------------------------

            if (response.status === 403) {
                metrics.http403Count++;
                releaseSlot();
                throw new Error(
                    "403 Forbidden. Check the existing Fabriq browser session."
                );
            }

            // --------------------------------
            // 404 Not Found — data not ready
            // --------------------------------

            if (response.status === 404) {
                metrics.http404Count++;
                releaseSlot();
                console.log(
                    "[WAIT] 404 Not Found — wallet data not ready, retrying in 5000ms"
                );

                metrics.retryWaitTimeMs += RETRY_404_DELAY_MS;
                await sleep(
                    RETRY_404_DELAY_MS
                );

                attempt = 1;
                continue;
            }

            // --------------------------------
            // Server error
            // --------------------------------

            if (response.status >= 500) {
                metrics.http5xxCount++;
                scheduler.onServerError();
                releaseSlot();
                if (attempt >= MAX_RETRIES) {
                    throw new Error(
                        `Server error ${response.status}`
                    );
                }

                const delay =
                    attempt * 2000;

                console.log(
                    `[RETRY] server ${response.status}, waiting ${delay}ms`
                );

                metrics.retryWaitTimeMs += delay;
                await sleep(delay);

                attempt++;
                continue;
            }

            if (!response.ok) {
                releaseSlot();
                throw new Error(
                    `${response.status} ${response.statusText}`
                );
            }

            const data = await response.json();
            scheduler.onSuccess(reqDur);
            releaseSlot();
            return data;
        } catch (error) {
            releaseSlot();
            // network error
            if (
                attempt < MAX_RETRIES &&
                !String(error.message).includes(
                    "403 Forbidden"
                ) &&
                !String(error.message).includes(
                    "401 Unauthorized after retries"
                ) &&
                !String(error.message).includes(
                    "429 Too Many Requests"
                ) &&
                !String(error.message).startsWith(
                    "Server error"
                )
            ) {
                metrics.networkErrorCount++;
                const delay =
                    attempt * 2000;

                console.log(
                    `[RETRY] ${error.message} → ${delay}ms`
                );

                metrics.retryWaitTimeMs += delay;
                await sleep(delay);

                attempt++;
                continue;
            }

            throw error;
        } finally {
            releaseSlot();
            metrics.activeRequests--;
        }
    }
}

// ======================================================
// WALLET FETCH
// ======================================================

async function fetchWallet(wallet) {
    const statsUrl =
        `https://apinew.fabriq.trade/portfolio/stats/${wallet}` +
        `?timezone=${encodeURIComponent(TIMEZONE)}` +
        `&sources=wallet&sources=hawkfi`;

    const statsPromise = fabriqFetch(statsUrl);

    const calendarPromises = CALENDAR_MONTHS.map(async (month) => {
        const calendarUrl =
            `https://apinew.fabriq.trade/portfolio/calendar/${wallet}` +
            `?month=${month}` +
            `&timezone=${encodeURIComponent(TIMEZONE)}` +
            `&sources=wallet&sources=hawkfi`;

        const resp = await fabriqFetch(calendarUrl);
        return { month, resp };
    });

    const [statsResponse, ...calendarResults] = await Promise.all([
        statsPromise,
        ...calendarPromises,
    ]);

    if (
        statsResponse?.success !== true ||
        !statsResponse?.data
    ) {
        throw new Error(
            "Invalid Fabriq stats response"
        );
    }

    const calendars = {};

    for (const { month, resp } of calendarResults) {
        if (
            resp?.success !== true ||
            resp?.data === undefined
        ) {
            throw new Error(
                `Invalid Fabriq calendar response for ${month}`
            );
        }

        const rawMonthData =
            resp.data && typeof resp.data === "object"
                ? resp.data
                : {};

        calendars[month] =
            Object.fromEntries(
                Object.entries(
                    rawMonthData
                ).filter(
                    ([date]) =>
                        date.startsWith(
                            `${month}-`
                        ) &&
                        (IS_CUSTOM_RANGE
                            ? date <= TODAY_STR
                            : ROLLING_90_DATES.has(date))
                )
            );
    }

    return {
        owner: wallet,

        status: "ok",

        fabriq: {
            fetchedAt:
                new Date().toISOString(),

            stats:
                statsResponse.data,

            calendars,

            // compatibility UI lama
            month:
                CURRENT_MONTH,

            calendar:
                calendars[
                    CURRENT_MONTH
                ] || {},
        },
    };
}

// ======================================================
// LOAD LP AGENT DATASET
// ======================================================

const raw = JSON.parse(
    await fs.readFile(
        DATASET,
        "utf8"
    )
);

const rows =
    extractWalletRows(raw);

const allWallets = [
    ...new Set(
        rows
            .map(getWalletOwner)
            .filter(Boolean)
    ),
];

if (!allWallets.length) {
    throw new Error(
        "No wallets found in dataset"
    );
}
let stateByOwner = null;
if (STATE_DATASET !== DATASET) {
    const stateRaw = JSON.parse(
        await fs.readFile(
            STATE_DATASET,
            "utf8"
        )
    );
    const stateRows = extractWalletRows(stateRaw);
    stateByOwner = new Map();
    for (const r of stateRows) {
        const owner = getWalletOwner(r);
        if (owner && r?.fabriq) {
            stateByOwner.set(owner, r.fabriq);
        }
    }
} else {
    stateByOwner = new Map();
    for (const r of rows) {
        const owner = getWalletOwner(r);
        if (owner && r?.fabriq && !stateByOwner.has(owner)) {
            stateByOwner.set(owner, r.fabriq);
        }
    }
}

const walletsNeedingRefresh =
    allWallets
        .filter((owner) => {
            if (!owner) {
                return false;
            }

            const fabriq = stateByOwner.get(owner);
            return !isFabriqFresh({ fabriq });
        });

const refreshCandidates = [
    ...new Set(
        walletsNeedingRefresh
    ),
];

const wallets =
    LIMIT > 0
        ? refreshCandidates.slice(
            0,
            LIMIT
        )
        : refreshCandidates;

const freshWallets =
    allWallets.length -
    refreshCandidates.length;

console.log(
    `\n[DATASET] ${allWallets.length} total wallets`
);

console.log(
    `[FRESH] ${freshWallets} wallets`
);

console.log(
    `[STALE/MISSING] ${refreshCandidates.length} wallets need Fabriq`
);

if (LIMIT > 0) {
    console.log(
        `[RUN LIMIT] ${wallets.length}/${refreshCandidates.length} wallets`
    );
}

console.log(
    `[WORKERS] ${CONCURRENCY}`
);

if (IS_CUSTOM_RANGE) {
    console.log(
        `[CALENDAR] mode=custom start=${CALENDAR_RANGE.startMonth} months=${CALENDAR_MONTHS.join(", ")}`
    );
} else {
    console.log(
        `[CALENDAR] mode=90d months=${CALENDAR_MONTHS.join(", ")}`
    );
}

// ======================================================
// LOAD OLD PROGRESS
// ======================================================

await fs.mkdir(path.dirname(CHECKPOINT), { recursive: true });
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });

const checkpoint =
    await loadCheckpoint(allWallets);

const alreadyDone =
    wallets.filter((wallet) => {
        const row =
            checkpoint.get(wallet);

        return (
            row?.status === "ok" &&
            row?.fabriq?.stats &&
            hasRequiredCalendars(row) &&
            isFabriqFresh(row)
        );
    }).length;

console.log(
    `[RESUME] ${alreadyDone}/${wallets.length} already completed\n`
);

// ======================================================
// SCRAPE
// ======================================================

let success = alreadyDone;
let failed = 0;
let skipped = 0;

const startedAt =
    Date.now();

let nextIndex = 0;

async function runWorker(
    workerId
) {
    while (true) {
        const i =
            nextIndex++;

        if (
            i >= wallets.length
        ) {
            return;
        }

        const wallet =
            wallets[i];

        const existing =
            checkpoint.get(
                wallet
            );

        if (
            existing?.status ===
            "ok" &&
            existing?.fabriq?.stats &&
            hasRequiredCalendars(
                existing
            ) &&
            isFabriqFresh(
                existing
            )
        ) {
            skipped++;

            console.log(
                `[W${workerId}] [${i + 1}/${wallets.length}] SKIP ${wallet}`
            );

            continue;
        }

        console.log(
            `\n[W${workerId}] [${i + 1}/${wallets.length}] ${wallet}`
        );

        const walletT0 = performance.now();
        try {
            const result =
                await fetchWallet(
                    wallet
                );
            metrics.walletTimesMs.push(performance.now() - walletT0);

            checkpoint.set(
                wallet,
                result
            );

            await saveCheckpoint(
                result
            );

            success++;

            console.log(
                `[W${workerId}] [OK]` +
                ` positions=${result.fabriq.stats.totalPositions ?? "?"}` +
                ` pnlSOL=${result.fabriq.stats.netPnlSol?.toFixed?.(4) ?? "?"}` +
                ` days=${Object.values(
                    result.fabriq.calendars
                ).reduce(
                    (
                        total,
                        calendar
                    ) =>
                        total +
                        Object.keys(
                            calendar
                        ).length,
                    0
                )}`
            );
        } catch (error) {
            failed++;

            const failure = {
                owner:
                    wallet,

                status:
                    "error",

                failedAt:
                    new Date()
                        .toISOString(),

                error:
                    error.message,
            };

            checkpoint.set(
                wallet,
                failure
            );

            await saveCheckpoint(
                failure
            );

            console.error(
                `[W${workerId}] [FAIL] ${error.message}`
            );
        }

        if (DELAY_MS > 0) {
            await sleep(DELAY_MS);
        }
    }
}

const workerCount =
    Math.min(
        CONCURRENCY,
        wallets.length
    );

await Promise.all(
    Array.from(
        {
            length:
                workerCount,
        },
        (_, index) =>
            runWorker(
                index + 1
            )
    )
);

// ======================================================
// BUILD FINAL OUTPUT
// ======================================================

const successfulResults = [];
const failures = [];

for (const wallet of allWallets) {
    const row =
        checkpoint.get(wallet);

    if (row?.status === "ok") {
        successfulResults.push(row);
    } else if (row) {
        failures.push(row);
    }
}

const output = {
    generatedAt:
        new Date().toISOString(),

    sourceDataset: DATASET,

    months: CALENDAR_MONTHS,

    totalWallets:
        allWallets.length,

    success:
        successfulResults.length,

    failed:
        failures.length,

    results:
        successfulResults,

    failures,
};

await fs.writeFile(
    OUTPUT,
    JSON.stringify(
        output,
        null,
        2
    )
);

// ======================================================
// SUMMARY
// ======================================================

const runtimeSeconds =
    (Date.now() - startedAt) /
    1000;

console.log(
    "\n========================================"
);

console.log(
    "FABRIQ ENRICHMENT COMPLETE"
);

console.log(
    "========================================"
);

console.log(
    `Total   : ${allWallets.length}`
);

console.log(
    `Success : ${successfulResults.length}`
);

console.log(
    `Failed  : ${failures.length}`
);

console.log(
    `Skipped : ${skipped}`
);

console.log(
    `Runtime : ${runtimeSeconds.toFixed(
        1
    )} sec`
);

console.log(
    `Output  : ${OUTPUT}`
);

console.log(
    `Checkpoint: ${CHECKPOINT}`
);


const walletsPerMin = runtimeSeconds > 0 ? (successfulResults.length / runtimeSeconds) * 60 : 0;
console.log("\n========================================");
console.log("PERFORMANCE PROFILE");
console.log("========================================");
console.log(`Wallets Completed: ${successfulResults.length} / ${wallets.length}`);
console.log(`Throughput       : ${walletsPerMin.toFixed(2)} wallets/min`);
console.log(`Avg Wallet Time  : ${average(metrics.walletTimesMs).toFixed(0)} ms`);
console.log(`Total Requests   : ${metrics.totalRequests}`);
console.log(`Peak In-Flight   : ${metrics.peakActiveRequests}`);
console.log(`Req Latency (all): mean=${average(metrics.allLatencies).toFixed(0)}ms p50=${percentile(metrics.allLatencies, 50).toFixed(0)}ms p95=${percentile(metrics.allLatencies, 95).toFixed(0)}ms`);
console.log(`Stats Latency    : mean=${average(metrics.statsLatencies).toFixed(0)}ms p50=${percentile(metrics.statsLatencies, 50).toFixed(0)}ms p95=${percentile(metrics.statsLatencies, 95).toFixed(0)}ms`);
console.log(`Calendar Latency : mean=${average(metrics.calendarLatencies).toFixed(0)}ms p50=${percentile(metrics.calendarLatencies, 50).toFixed(0)}ms p95=${percentile(metrics.calendarLatencies, 95).toFixed(0)}ms`);
console.log(`HTTP 429s        : ${metrics.http429Count}`);
console.log(`HTTP 403s        : ${metrics.http403Count}`);
console.log(`HTTP 404s        : ${metrics.http404Count}`);
console.log(`HTTP 5xxs        : ${metrics.http5xxCount}`);
console.log(`Retry/Wait Time  : ${(metrics.retryWaitTimeMs / 1000).toFixed(2)}s`);
console.log(`Checkpoint Time  : ${(metrics.checkpointWriteTimeMs / 1000).toFixed(2)}s`);
console.log(`JWT Refresh Time : ${(metrics.jwtRefreshTimeMs / 1000).toFixed(2)}s (${metrics.jwtRefreshCount} refreshes)`);
console.log("========================================");
process.exit(failures.length > 0 ? 1 : 0);

// IMPORTANT:
// jangan browser.close()
// karena ini attach ke Brave milikmu.