import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

// ======================================================
// CONFIG
// ======================================================

const CDP_URL = "http://127.0.0.1:9222";
const API_MATCH = "/api/v1/smart-lp";

function resolvePath(envVar, defaultRelativeUrl) {
    if (process.env[envVar]) {
        return path.resolve(process.cwd(), process.env[envVar]);
    }
    return fileURLToPath(new URL(defaultRelativeUrl, import.meta.url));
}

const OUTPUT_PATH = resolvePath(
    "LPAGENT_OUTPUT_PATH",
    "../../data/raw/lpagent/smart-lp-latest.json"
);

const CHECKPOINT_PATH = resolvePath(
    "LPAGENT_CHECKPOINT_PATH",
    "../../data/checkpoints/lpagent.jsonl"
);

const CONCURRENCY =
    Math.max(
        1,
        parseInt(
            process.env.LPAGENT_CONCURRENCY ??
            "8",
            10
        ) || 8
    );

const MAX_IN_FLIGHT =
    Math.max(
        1,
        parseInt(
            process.env.LPAGENT_MAX_IN_FLIGHT ??
            "10",
            10
        ) || 10
    );

const PAGE_DELAY_MS =
    process.env.LPAGENT_PAGE_DELAY_MS !== undefined
        ? Math.max(0, parseInt(process.env.LPAGENT_PAGE_DELAY_MS, 10))
        : 0;

const JITTER_MS =
    process.env.LPAGENT_JITTER_MS !== undefined
        ? Math.max(0, parseInt(process.env.LPAGENT_JITTER_MS, 10))
        : (PAGE_DELAY_MS > 0 ? 500 : 0);

const WORKER_STAGGER_MS =
    process.env.LPAGENT_WORKER_STAGGER_MS !== undefined
        ? Math.max(0, parseInt(process.env.LPAGENT_WORKER_STAGGER_MS, 10))
        : 250;

const PAGE_LIMIT =
    process.env.LPAGENT_PAGE_LIMIT
        ? Math.max(1, parseInt(process.env.LPAGENT_PAGE_LIMIT, 10))
        : null;

const PAGE_START =
    process.env.LPAGENT_PAGE_START
        ? Math.max(1, parseInt(process.env.LPAGENT_PAGE_START, 10))
        : 1;

const MAX_RETRIES = 5;

// ======================================================
// REQUEST SCHEDULER
// ======================================================

class RequestScheduler {
    constructor({
        maxInFlight = 6,
        minInFlight = 1,
        minIntervalMs = 40,
    } = {}) {
        this.maxInFlight = Math.max(1, maxInFlight);
        this.minInFlight = Math.max(1, Math.min(minInFlight, this.maxInFlight));
        this.currentLimit = this.maxInFlight;
        this.minIntervalMs = Math.max(0, minIntervalMs);
        this.activeRequests = 0;
        this.queue = [];
        this.lastDispatchTime = 0;
        this.consecutiveSuccesses = 0;
        this.pausedUntil = 0;
    }

    async acquireSlot() {
        return new Promise((resolve) => {
            this.queue.push(resolve);
            this._processQueue();
        });
    }

    releaseSlot() {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        this._processQueue();
    }

    _processQueue() {
        if (this.queue.length === 0) return;

        const now = Date.now();
        if (now < this.pausedUntil) {
            const delay = this.pausedUntil - now;
            setTimeout(() => this._processQueue(), delay);
            return;
        }

        if (this.activeRequests >= this.currentLimit) {
            return;
        }

        const elapsed = now - this.lastDispatchTime;
        if (elapsed < this.minIntervalMs) {
            const waitTime = this.minIntervalMs - elapsed;
            setTimeout(() => this._processQueue(), waitTime);
            return;
        }

        this.activeRequests++;
        this.lastDispatchTime = Date.now();
        const next = this.queue.shift();
        if (next) next();

        if (this.queue.length > 0 && this.activeRequests < this.currentLimit) {
            setTimeout(() => this._processQueue(), this.minIntervalMs);
        }
    }

    onSuccess(latencyMs = 0) {
        if (this.currentLimit < this.maxInFlight && latencyMs < 5000) {
            this.consecutiveSuccesses++;
            if (this.consecutiveSuccesses >= 15) {
                this.currentLimit = Math.min(this.maxInFlight, this.currentLimit + 1);
                this.consecutiveSuccesses = 0;
                this._processQueue();
            }
        }
    }

    onRateLimit(retryAfterSeconds = null) {
        this.consecutiveSuccesses = 0;
        const prev = this.currentLimit;
        this.currentLimit = Math.max(
            this.minInFlight,
            Math.floor(this.currentLimit * 0.6)
        );
        const pauseSec =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? retryAfterSeconds
                : 20;
        this.pausedUntil = Date.now() + pauseSec * 1000;
        console.log(
            `[SCHEDULER] 429 backoff: concurrency reduced ${prev} -> ${this.currentLimit}, paused ${pauseSec}s`
        );
    }
}

const scheduler = new RequestScheduler({
    maxInFlight: MAX_IN_FLIGHT,
    minInFlight: 1,
    minIntervalMs: 40,
});

// ======================================================
// HELPERS
// ======================================================

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

async function politeDelay() {
    if (PAGE_DELAY_MS <= 0) return;
    const jitter =
        JITTER_MS > 0 ? Math.floor(Math.random() * JITTER_MS) : 0;
    const delay =
        PAGE_DELAY_MS + jitter;
    console.log(
        `[DELAY] ${(delay / 1000).toFixed(1)}s`
    );
    await sleep(delay);
}

function extractRows(json) {
    return (
        [
            json?.data?.smart_lp,
            json?.smart_lp,
            json?.data?.data,
            json?.data,
        ].find(Array.isArray) ?? []
    );
}

function extractPagination(json) {
    return (
        json?.data?.pagination ??
        json?.pagination ??
        null
    );
}

function getWalletOwner(row) {
    return (
        row?.owner ??
        row?.wallet ??
        row?.wallet_address ??
        null
    );
}

// ======================================================
// FILTER SIGNATURE
// ======================================================

// Supaya checkpoint filter A tidak dipakai
// ketika kamu mengganti filter menjadi B.

function createFilterSignature(urlString) {
    const url =
        new URL(urlString);

    // parameter yang tidak menentukan filter
    const ignored = [
        "page",
        "_",
        "ts",
        "timestamp",
        "cacheBust",
        "cache_bust",
    ];

    for (const key of ignored) {
        url.searchParams.delete(key);
    }

    url.searchParams.sort();

    const normalized =
        `${url.origin}${url.pathname}?${url.searchParams.toString()}`;

    return createHash("sha256")
        .update(normalized)
        .digest("hex");
}

// ======================================================
// CHECKPOINT
// ======================================================

async function loadCheckpoint(
    filterSignature
) {
    const pages =
        new Map();

    let savedTotalPages = null;

    try {
        const text =
            await fs.readFile(
                CHECKPOINT_PATH,
                "utf8"
            );

        const lines =
            text
                .split("\n")
                .filter(Boolean);

        for (const line of lines) {
            try {
                const record =
                    JSON.parse(line);

                if (
                    record.type !== "page"
                ) {
                    continue;
                }

                if (
                    record.filterSignature !==
                    filterSignature
                ) {
                    continue;
                }

                if (
                    !Number.isInteger(
                        record.page
                    )
                ) {
                    continue;
                }

                if (
                    !Array.isArray(
                        record.rows
                    )
                ) {
                    continue;
                }

                // kalau page tercatat lebih dari sekali,
                // versi terakhir menang.
                pages.set(
                    record.page,
                    record
                );

                if (
                    Number.isInteger(
                        record.totalPages
                    )
                ) {
                    savedTotalPages =
                        record.totalPages;
                }
            } catch {
                // Abaikan 1 line rusak,
                // checkpoint lainnya tetap aman.
            }
        }
    } catch (error) {
        if (
            error.code !== "ENOENT"
        ) {
            throw error;
        }
    }

    return {
        pages,
        totalPages:
            savedTotalPages,
    };
}

let checkpointWriteQueue =
    Promise.resolve();

async function savePageCheckpoint({
    filterSignature,
    page,
    totalPages,
    rows,
}) {
    const record = {
        type: "page",

        filterSignature,

        page,

        totalPages,

        fetchedAt:
            new Date().toISOString(),

        rows,
    };

    const line =
        JSON.stringify(record) +
        "\n";

    checkpointWriteQueue =
        checkpointWriteQueue
            .catch(() => { })
            .then(
                async () => {
                    await fs.mkdir(
                        path.dirname(CHECKPOINT_PATH),
                        { recursive: true }
                    );
                    await fs.appendFile(
                        CHECKPOINT_PATH,
                        line
                    );
                }
            );

    await checkpointWriteQueue;
}

// ======================================================
// ROBUST FETCH
// ======================================================

async function fetchPageWithRetry(
    url,
    headers
) {
    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        await scheduler.acquireSlot();
        let slotReleased = false;
        const releaseSlot = () => {
            if (!slotReleased) {
                slotReleased = true;
                scheduler.releaseSlot();
            }
        };

        let response;
        const reqStart = performance.now();

        // --------------------------------
        // NETWORK ERROR
        // --------------------------------

        try {
            response =
                await fetch(
                    url,
                    { headers }
                );
        } catch (error) {
            releaseSlot();
            if (
                attempt === MAX_RETRIES
            ) {
                throw error;
            }

            const waitMs =
                Math.min(
                    60_000,
                    5_000 *
                    2 ** (attempt - 1)
                );

            console.log(
                `[NETWORK] ${error.message} (${error.cause?.message ?? error.cause ?? "no cause"})`
            );

            console.log(
                `[RETRY ${attempt}/${MAX_RETRIES}] waiting ${waitMs / 1000}s`
            );

            await sleep(waitMs);

            continue;
        }

        // --------------------------------
        // SUCCESS
        // --------------------------------

        if (response.ok) {
            try {
                const json =
                    await response.json();
                const latencyMs = Math.round(performance.now() - reqStart);
                releaseSlot();
                scheduler.onSuccess(latencyMs);

                return {
                    status:
                        response.status,

                    json,
                    latencyMs,
                };
            } catch (error) {
                releaseSlot();
                if (
                    attempt ===
                    MAX_RETRIES
                ) {
                    throw error;
                }

                const waitMs =
                    Math.min(
                        60_000,
                        5_000 *
                        2 ** (attempt - 1)
                    );

                console.log(
                    `[BODY] ${error.message}`
                );

                console.log(
                    `[RETRY ${attempt}/${MAX_RETRIES}] response body interrupted, waiting ${waitMs / 1000}s`
                );

                await sleep(
                    waitMs
                );

                continue;
            }
        }

        const status =
            response.status;
        releaseSlot();

        // --------------------------------
        // AUTH
        // --------------------------------

        if (
            status === 401 ||
            status === 403
        ) {
            throw new Error(
                `${status} Auth/session error. ` +
                `Checkpoint sudah aman. ` +
                `Siapkan LP Agent di Brave lalu jalankan ulang script.`
            );
        }

        // --------------------------------
        // RATE LIMIT
        // --------------------------------

        if (status === 429) {
            const retryAfterHeader =
                Number(
                    response.headers.get(
                        "retry-after"
                    )
                );

            scheduler.onRateLimit(retryAfterHeader);

            if (
                attempt ===
                MAX_RETRIES
            ) {
                throw new Error(
                    "429 Too Many Requests after retries."
                );
            }

            const waitSeconds =
                Number.isFinite(
                    retryAfterHeader
                ) &&
                    retryAfterHeader > 0
                    ? retryAfterHeader
                    : 20 * attempt;

            console.log(
                `[429] Rate limited`
            );

            console.log(
                `[RETRY ${attempt}/${MAX_RETRIES}] waiting ${waitSeconds}s`
            );

            await sleep(
                waitSeconds * 1000
            );

            continue;
        }

        // --------------------------------
        // CLOUDFLARE / ORIGIN OUTAGE
        // --------------------------------

        if (
            [
                520,
                521,
                522,
                523,
                524,
            ].includes(status)
        ) {
            if (
                attempt ===
                MAX_RETRIES
            ) {
                throw new Error(
                    `${status} LP Agent origin still unavailable after retries.`
                );
            }

            // Server kemungkinan sedang benar-benar bermasalah.
            // Jangan hammer request.
            const waitSeconds =
                Math.min(
                    180,
                    60 * attempt
                );

            console.log(
                `[${status}] LP Agent origin/server issue`
            );

            console.log(
                `[RETRY ${attempt}/${MAX_RETRIES}] waiting ${waitSeconds}s`
            );

            await sleep(
                waitSeconds * 1000
            );

            continue;
        }

        // --------------------------------
        // TEMPORARY SERVER ERROR
        // --------------------------------

        if (
            [
                500,
                502,
                503,
                504,
            ].includes(status)
        ) {
            if (
                attempt ===
                MAX_RETRIES
            ) {
                throw new Error(
                    `${status} Server error after retries.`
                );
            }

            const waitMs =
                Math.min(
                    60_000,
                    5_000 *
                    2 ** (attempt - 1)
                );

            console.log(
                `[${status}] Temporary server error`
            );

            console.log(
                `[RETRY ${attempt}/${MAX_RETRIES}] waiting ${waitMs / 1000}s`
            );

            await sleep(waitMs);

            continue;
        }

        // --------------------------------
        // OTHER HTTP ERROR
        // --------------------------------

        const body =
            await response.text();

        throw new Error(
            `HTTP ${status}: ${body.slice(0, 250)}`
        );
    }

    throw new Error(
        "Maximum retry reached."
    );
}

// ======================================================
// CONNECT BRAVE
// ======================================================

console.log(
    "[BOOT] Connecting to Brave..."
);

const browser =
    await chromium.connectOverCDP(
        CDP_URL
    );

const context =
    browser.contexts()[0];

if (!context) {
    throw new Error(
        "No Brave context found."
    );
}

const page =
    context
        .pages()
        .find((p) =>
            p.url().includes(
                "lpagent"
            )
        );

if (!page) {
    throw new Error(
        "LP Agent tab not found."
    );
}

console.log(
    "[1] LP Agent page:",
    page.url()
);

console.log(`
========================================
BEFORE RUNNING
========================================

Pastikan di browser:

1. Filter sudah diisi
2. Workaround Robinhood → Filter → Solana sudah dilakukan
3. Tabel Solana sudah menampilkan hasil yang benar

Script akan reload halaman dan mengambil request Smart LP.
`);

// ======================================================
// CAPTURE SMART LP REQUEST
// ======================================================

const requestPromise =
    new Promise(
        (resolve, reject) => {
            const timeout =
                setTimeout(() => {
                    reject(
                        new Error(
                            "Smart LP request tidak ditemukan setelah reload."
                        )
                    );
                }, 30000);

            const handler =
                async (request) => {
                    const url =
                        request.url();

                    if (
                        !url.includes(
                            API_MATCH
                        )
                    ) {
                        return;
                    }

                    const parsed =
                        new URL(url);

                    const chain =
                        parsed.searchParams.get(
                            "chain"
                        ) ??
                        parsed.searchParams.get(
                            "network"
                        );

                    if (
                        chain &&
                        ![
                            "SOL",
                            "SOLANA",
                            "solana",
                        ].includes(chain)
                    ) {
                        return;
                    }

                    clearTimeout(
                        timeout
                    );

                    context.off(
                        "request",
                        handler
                    );

                    const headers =
                        await request.allHeaders();

                    resolve({
                        url,
                        headers,
                    });
                };

            context.on(
                "request",
                handler
            );
        }
    );

console.log(
    "[2] Reloading Smart LP..."
);

await page.reload({
    waitUntil:
        "domcontentloaded",
});

const captured =
    await requestPromise;

console.log(
    "[3] Smart LP request captured:",
    captured.url
);

// ======================================================
// SAFE REQUEST HEADERS
// ======================================================

const headers = {
    accept:
        captured.headers.accept ??
        "application/json",
};

for (const key of [
    "authorization",
    "cookie",
    "origin",
    "referer",
    "user-agent",
]) {
    if (
        captured.headers[key]
    ) {
        headers[key] =
            captured.headers[key];
    }
}

console.log(
    "[4] Authorization:",
    captured.headers
        .authorization
        ? "YES"
        : "NO"
);

console.log(
    "[5] Cookie:",
    captured.headers.cookie
        ? "YES"
        : "NO"
);

// ======================================================
// PREPARE BASE URL
// ======================================================

const baseUrl =
    new URL(
        captured.url
    );

const filterSignature =
    createFilterSignature(
        baseUrl.toString()
    );

console.log(
    "[6] Filter signature:",
    filterSignature.slice(
        0,
        12
    )
);

// ======================================================
// LOAD CHECKPOINT
// ======================================================

let checkpoint =
    await loadCheckpoint(
        filterSignature
    );

function isCheckpointComplete(
    checkpoint
) {
    const totalPages =
        checkpoint.totalPages;

    if (
        !Number.isInteger(totalPages) ||
        totalPages <= 0
    ) {
        return false;
    }

    const targetStart = PAGE_START;
    const targetEnd = PAGE_LIMIT
        ? Math.min(totalPages, PAGE_START + PAGE_LIMIT - 1)
        : totalPages;

    for (
        let page = targetStart;
        page <= targetEnd;
        page++
    ) {
        if (
            !checkpoint.pages.has(page)
        ) {
            return false;
        }
    }

    return true;
}

if (
    isCheckpointComplete(
        checkpoint
    )
) {
    console.log(
        "[CHECKPOINT] Previous scrape already complete"
    );

    console.log(
        "[CHECKPOINT] Starting fresh from page 1"
    );

    await fs.rm(
        CHECKPOINT_PATH,
        { force: true }
    );

    checkpoint = {
        pages: new Map(),
        totalPages: null,
    };
}

let totalPages =
    checkpoint.totalPages;

console.log(
    `[CHECKPOINT] ${checkpoint.pages.size} completed pages found`
);

if (totalPages) {
    console.log(
        `[CHECKPOINT] known total pages: ${totalPages}`
    );
}

// ======================================================
// RESTORE SAVED ROWS
// ======================================================

const walletMap =
    new Map();

for (
    const record
    of checkpoint.pages.values()
) {
    for (
        const row
        of record.rows
    ) {
        const owner =
            getWalletOwner(row);

        if (!owner) continue;

        walletMap.set(
            owner,
            row
        );
    }
}

console.log(
    `[CHECKPOINT] ${walletMap.size} unique wallets restored`
);

// ======================================================
// FIND FIRST MISSING PAGE
// ======================================================

function getFirstMissingPage() {
    let pageNumber = PAGE_START;

    while (
        checkpoint.pages.has(
            pageNumber
        )
    ) {
        pageNumber++;
    }

    return pageNumber;
}

let pageNumber =
    getFirstMissingPage();

console.log(
    `[RESUME] starting at page ${pageNumber}`
);

console.log(
    `[WORKERS] ${CONCURRENCY}`
);

// ======================================================
// PAGE FETCH
// ======================================================

async function fetchAndSavePage(
    pageNumber,
    workerId
) {
    const url =
        new URL(baseUrl);

    url.searchParams.set(
        "page",
        String(pageNumber)
    );

    console.log(
        `\n========================================`
    );

    console.log(
        `[W${workerId}] [PAGE ${pageNumber}${totalPages ? `/${totalPages}` : ""}] fetching`
    );

    const {
        status,
        json,
    } =
        await fetchPageWithRetry(
            url.toString(),
            headers
        );

    console.log(
        `[W${workerId}] status=${status}`
    );

    const rows =
        extractRows(json);

    const pagination =
        extractPagination(json);

    if (pagination) {
        const detectedTotal =
            pagination.totalPages ??
            pagination.total_pages;

        if (
            Number.isInteger(
                detectedTotal
            ) &&
            detectedTotal > 0
        ) {
            if (totalPages && detectedTotal > totalPages) {
                console.log(
                    `[PAGINATION] Total pages updated: ${totalPages} -> ${detectedTotal}`
                );
                const maxAllowed = PAGE_LIMIT
                    ? Math.min(detectedTotal, PAGE_START + PAGE_LIMIT - 1)
                    : detectedTotal;
                for (let p = totalPages + 1; p <= maxAllowed; p++) {
                    enqueuePage(p);
                }
            }
            totalPages =
                detectedTotal;
        }
    }

    console.log(
        `[W${workerId}] rows=${rows.length}`
    );

    // ----------------------------------
    // SAVE DATA TO MEMORY
    // ----------------------------------

    for (
        const row
        of rows
    ) {
        const owner =
            getWalletOwner(row);

        if (!owner) {
            continue;
        }

        walletMap.set(
            owner,
            row
        );
    }

    // ----------------------------------
    // CHECKPOINT
    // ----------------------------------

    await savePageCheckpoint({
        filterSignature,

        page:
            pageNumber,

        totalPages,

        rows,
    });

    checkpoint.pages.set(
        pageNumber,
        {
            page:
                pageNumber,

            rows,

            totalPages,
        }
    );

    console.log(
        `[W${workerId}] [CHECKPOINT] page ${pageNumber} saved`
    );

    console.log(
        `[TOTAL] ${walletMap.size} unique wallets`
    );

    return rows;
}

// ======================================================
// DISCOVER TOTAL PAGES
// ======================================================

if (!totalPages) {
    const discoveryPage =
        getFirstMissingPage();

    console.log(
        `[DISCOVERY] fetching page ${discoveryPage} to detect pagination`
    );

    const discoveryRows =
        await fetchAndSavePage(
            discoveryPage,
            1
        );

    // Fallback untuk API yang tidak memberikan totalPages.
    if (!totalPages) {
        console.log(
            "[WORKERS] totalPages unavailable → sequential fallback"
        );

        let nextPage =
            discoveryPage + 1;

        let previousRows =
            discoveryRows;

        while (
            previousRows.length >
            0
        ) {
            await politeDelay();

            previousRows =
                await fetchAndSavePage(
                    nextPage,
                    1
                );

            nextPage++;
        }
    }
}

// ======================================================
// PARALLEL PAGE WORKERS
// ======================================================

// ======================================================
// PARALLEL PAGE WORKERS & DYNAMIC QUEUE
// ======================================================

const pendingPages = [];
const enqueuedPages = new Set();

function enqueuePage(p) {
    if (!checkpoint.pages.has(p) && !enqueuedPages.has(p)) {
        enqueuedPages.add(p);
        pendingPages.push(p);
    }
}

if (totalPages) {
    const targetStart = PAGE_START;
    const targetEnd = PAGE_LIMIT
        ? Math.min(totalPages, PAGE_START + PAGE_LIMIT - 1)
        : totalPages;

    for (let page = targetStart; page <= targetEnd; page++) {
        enqueuePage(page);
    }

    console.log(
        `[QUEUE] ${pendingPages.length} pages remaining (${targetStart}..${targetEnd})`
    );

    async function runPageWorker(
        workerId
    ) {
        // Hindari semua worker request tepat
        // pada millisecond yang sama.
        if (
            workerId > 1 &&
            WORKER_STAGGER_MS > 0
        ) {
            await sleep(
                (
                    workerId -
                    1
                ) *
                WORKER_STAGGER_MS
            );
        }

        while (true) {
            if (pendingPages.length === 0) {
                return;
            }

            const page = pendingPages.shift();
            if (page === undefined) {
                return;
            }

            if (checkpoint.pages.has(page)) {
                continue;
            }

            try {
                await fetchAndSavePage(
                    page,
                    workerId
                );
            } catch (error) {
                console.error(
                    `[W${workerId}] [PAGE ${page}] FAIL ${error.message}`
                );

                throw error;
            }

            if (PAGE_DELAY_MS > 0) {
                await politeDelay();
            }
        }
    }

    const workerCount =
        Math.min(
            CONCURRENCY,
            pendingPages.length
        );

    if (
        workerCount > 0
    ) {
        console.log(
            `[WORKERS] Starting ${workerCount} page workers (concurrency=${CONCURRENCY}, maxInFlight=${MAX_IN_FLIGHT})`
        );

        await Promise.all(
            Array.from(
                {
                    length:
                        workerCount,
                },
                (
                    _,
                    index
                ) =>
                    runPageWorker(
                        index + 1
                    )
            )
        );
    }
}

// ======================================================
// COMPLETENESS & DATA VALIDATION GATE
// ======================================================

const targetStart = PAGE_START;
const targetEnd = PAGE_LIMIT
    ? Math.min(totalPages ?? 1, PAGE_START + PAGE_LIMIT - 1)
    : (totalPages ?? 1);

const missingFromCheckpoint = [];
for (let p = targetStart; p <= targetEnd; p++) {
    if (!checkpoint.pages.has(p)) {
        missingFromCheckpoint.push(p);
    }
}

if (missingFromCheckpoint.length > 0) {
    console.error(
        `\n[VALIDATION FAIL] Checkpoint incomplete! Missing ${missingFromCheckpoint.length} pages: [${missingFromCheckpoint.slice(0, 10).join(", ")}${missingFromCheckpoint.length > 10 ? "..." : ""}]`
    );
    console.error(
        "[VALIDATION FAIL] Refusing to write final output or delete checkpoint."
    );
    process.exit(1);
}

console.log(
    `\n[VALIDATION PASS] Contiguous page coverage verified: pages ${targetStart}..${targetEnd} (${checkpoint.pages.size} pages)`
);

const wallets =
    [...walletMap.values()];

if (wallets.length === 0) {
    console.error(
        "[VALIDATION FAIL] Zero unique wallets extracted. Refusing to write final output."
    );
    process.exit(1);
}

console.log(
    `[VALIDATION PASS] ${wallets.length} unique wallets validated`
);

// ======================================================
// FINAL OUTPUT
// ======================================================

const output = {
    generatedAt:
        new Date().toISOString(),

    source:
        "LP Agent Smart LP",

    filterSignature,

    pagesFetched:
        checkpoint.pages.size,

    totalPages,

    totalUniqueWallets:
        wallets.length,

    wallets,
};

await fs.mkdir(
    path.dirname(OUTPUT_PATH),
    { recursive: true }
);

await fs.writeFile(
    OUTPUT_PATH,

    JSON.stringify(
        output,
        null,
        2
    )
);

// Checkpoint hanya diperlukan untuk resume
// ketika scrape belum selesai.
//
// Setelah output final berhasil ditulis,
// scrape berikutnya harus mengambil data fresh.
await fs.rm(
    CHECKPOINT_PATH,
    { force: true }
);

// ======================================================
// SUMMARY
// ======================================================

console.log(`
========================================
LP AGENT SMART LP COMPLETE
========================================

Pages   : ${checkpoint.pages.size}/${totalPages ?? "?"}
Wallets : ${wallets.length}

Output:
${OUTPUT_PATH}

Checkpoint:
cleared after successful scrape
`);

process.exit(0);