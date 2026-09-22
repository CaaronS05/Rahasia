import fs from "node:fs/promises";
import { chromium } from "playwright-core";

// ======================================================
// CONFIG
// ======================================================

const DATASET = new URL(
    "../../data/master/wallets-master.json",
    import.meta.url
);

const OUTPUT = new URL(
    "../../data/raw/fabriq/fabriq-enriched.json",
    import.meta.url
);

const CHECKPOINT = new URL(
    "../../data/checkpoints/fabriq.jsonl",
    import.meta.url
);

const CDP_URL = "http://127.0.0.1:9222";

const TIMEZONE = "Asia/Jakarta";

const DELAY_MS = 500;
const MAX_RETRIES = 3;
const STALE_AFTER_HOURS = 24;

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
            process.env.FABRIQ_CONCURRENCY ?? "2",
            10
        ) || 2
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

function getWalletOwner(row) {
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

function getCurrentMonth() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
    }).formatToParts(new Date());

    const year = parts.find(
        (part) => part.type === "year"
    )?.value;

    const month = parts.find(
        (part) => part.type === "month"
    )?.value;

    return `${year}-${month}`;
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

async function loadCheckpoint() {
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
                    // last checkpoint for the wallet wins
                    map.set(row.owner, row);
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

    return map;
}

let checkpointWriteQueue =
    Promise.resolve();

async function saveCheckpoint(row) {
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

    console.log(
        `[AUTH] JWT refreshed (${secondsLeft}s)`
    );

    return token;
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
    attempt = 1
) {
    try {
        const jwt = await getToken();

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: "application/json",
            },
        });

        // --------------------------------
        // JWT expired/rejected
        // --------------------------------

        if (response.status === 401) {
            if (attempt >= MAX_RETRIES) {
                throw new Error(
                    "401 Unauthorized after retries"
                );
            }

            console.log(
                "[AUTH] 401 → refreshing JWT"
            );

            await getToken(true);

            return fabriqFetch(
                url,
                attempt + 1
            );
        }

        // --------------------------------
        // Rate limit
        // --------------------------------

        if (response.status === 429) {
            if (attempt >= MAX_RETRIES) {
                throw new Error(
                    "429 Too Many Requests"
                );
            }

            const retryAfter =
                Number(
                    response.headers.get(
                        "retry-after"
                    )
                ) || 5;

            console.log(
                `[RATE LIMIT] waiting ${retryAfter}s`
            );

            await sleep(
                retryAfter * 1000
            );

            return fabriqFetch(
                url,
                attempt + 1
            );
        }

        // --------------------------------
        // Cloudflare / forbidden
        // --------------------------------

        if (response.status === 403) {
            throw new Error(
                "403 Forbidden. Check the existing Fabriq browser session."
            );
        }

        // --------------------------------
        // Server error
        // --------------------------------

        if (response.status >= 500) {
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

            await sleep(delay);

            return fabriqFetch(
                url,
                attempt + 1
            );
        }

        if (!response.ok) {
            throw new Error(
                `${response.status} ${response.statusText}`
            );
        }

        return await response.json();
    } catch (error) {
        // network error
        if (
            attempt < MAX_RETRIES &&
            !String(error.message).includes(
                "403 Forbidden"
            )
        ) {
            const delay =
                attempt * 2000;

            console.log(
                `[RETRY] ${error.message} → ${delay}ms`
            );

            await sleep(delay);

            return fabriqFetch(
                url,
                attempt + 1
            );
        }

        throw error;
    }
}

// ======================================================
// WALLET FETCH
// ======================================================

const CURRENT_MONTH = getCurrentMonth();

function getPreviousMonth(month) {
    const [year, monthNumber] =
        month.split("-").map(Number);

    const date = new Date(
        Date.UTC(
            year,
            monthNumber - 2,
            1,
        )
    );

    return [
        date.getUTCFullYear(),
        String(
            date.getUTCMonth() + 1
        ).padStart(2, "0"),
    ].join("-");
}

const PREVIOUS_MONTH =
    getPreviousMonth(
        CURRENT_MONTH
    );

const CALENDAR_MONTHS = [
    PREVIOUS_MONTH,
    CURRENT_MONTH,
];

async function fetchWallet(wallet) {
    const statsUrl =
        `https://apinew.fabriq.trade/portfolio/stats/${wallet}` +
        `?timezone=${encodeURIComponent(TIMEZONE)}` +
        `&sources=wallet&sources=hawkfi`;

    const statsResponse =
        await fabriqFetch(statsUrl);

    if (
        statsResponse?.success !== true ||
        !statsResponse?.data
    ) {
        throw new Error(
            "Invalid Fabriq stats response"
        );
    }

    const calendars = {};

    for (const month of CALENDAR_MONTHS) {
        const calendarUrl =
            `https://apinew.fabriq.trade/portfolio/calendar/${wallet}` +
            `?month=${month}` +
            `&timezone=${encodeURIComponent(TIMEZONE)}` +
            `&sources=wallet&sources=hawkfi`;

        const calendarResponse =
            await fabriqFetch(
                calendarUrl
            );

        if (
            calendarResponse?.success !== true ||
            !calendarResponse?.data
        ) {
            throw new Error(
                `Invalid Fabriq calendar response for ${month}`
            );
        }

        calendars[month] =
            Object.fromEntries(
                Object.entries(
                    calendarResponse.data
                ).filter(
                    ([date]) =>
                        date.startsWith(
                            `${month}-`
                        )
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
                ],
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

const walletsNeedingRefresh =
    rows
        .filter((row) => {
            const owner =
                getWalletOwner(row);

            if (!owner) {
                return false;
            }

            return !isFabriqFresh(row);
        })
        .map(getWalletOwner)
        .filter(Boolean);

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

console.log(
    `[CALENDAR] months=${CALENDAR_MONTHS.join(", ")}`
);

// ======================================================
// LOAD OLD PROGRESS
// ======================================================

const checkpoint =
    await loadCheckpoint();

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

        try {
            const result =
                await fetchWallet(
                    wallet
                );

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

        await sleep(
            DELAY_MS
        );
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

process.exit(0);

// IMPORTANT:
// jangan browser.close()
// karena ini attach ke Brave milikmu.