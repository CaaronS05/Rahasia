import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

// ======================================================
// CONFIG
// ======================================================

const CDP_URL = "http://127.0.0.1:9222";
const API_MATCH = "/api/v1/smart-lp";

const OUTPUT = new URL(
    "../../data/raw/lpagent/smart-lp-latest.json",
    import.meta.url
);

const CHECKPOINT = new URL(
    "../../data/checkpoints/lpagent.jsonl",
    import.meta.url
);

// Sebelumnya request terlalu rapat.
// Sekarang sekitar 1.5 - 2 detik antar page.
const PAGE_DELAY_MS = 1500;
const JITTER_MS = 500;

const MAX_RETRIES = 5;

const CONCURRENCY =
    Math.max(
        1,
        parseInt(
            process.env.LPAGENT_CONCURRENCY ??
            "3",
            10
        ) || 3
    );

const WORKER_STAGGER_MS = 250;

// ======================================================
// HELPERS
// ======================================================

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

async function politeDelay() {
    const jitter =
        Math.floor(Math.random() * JITTER_MS);

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
                CHECKPOINT,
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
                () =>
                    fs.appendFile(
                        CHECKPOINT,
                        line
                    )
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
        let response;

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
                `[NETWORK] ${error.message}`
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
            return response;
        }

        const status =
            response.status;

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
            if (
                attempt ===
                MAX_RETRIES
            ) {
                throw new Error(
                    "429 Too Many Requests after retries."
                );
            }

            const retryAfterHeader =
                Number(
                    response.headers.get(
                        "retry-after"
                    )
                );

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
    "[3] Smart LP request captured"
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

    for (
        let page = 1;
        page <= totalPages;
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
        CHECKPOINT,
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
    let pageNumber = 1;

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

    const response =
        await fetchPageWithRetry(
            url.toString(),
            headers
        );

    console.log(
        `[W${workerId}] status=${response.status}`
    );

    const json =
        await response.json();

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

if (totalPages) {
    const missingPages =
        [];

    for (
        let page = 1;
        page <= totalPages;
        page++
    ) {
        if (
            !checkpoint.pages.has(
                page
            )
        ) {
            missingPages.push(
                page
            );
        }
    }

    console.log(
        `[QUEUE] ${missingPages.length} pages remaining`
    );

    let nextPageIndex =
        0;

    async function runPageWorker(
        workerId
    ) {
        // Hindari semua worker request tepat
        // pada millisecond yang sama.
        if (
            workerId > 1
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
            const index =
                nextPageIndex++;

            if (
                index >=
                missingPages.length
            ) {
                return;
            }

            const page =
                missingPages[
                index
                ];

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

            await politeDelay();
        }
    }

    const workerCount =
        Math.min(
            CONCURRENCY,
            missingPages.length
        );

    if (
        workerCount > 0
    ) {
        console.log(
            `[WORKERS] Starting ${workerCount} page workers`
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
// FINAL OUTPUT
// ======================================================

const wallets =
    [...walletMap.values()];

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

await fs.writeFile(
    OUTPUT,

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
    CHECKPOINT,
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
${OUTPUT}

Checkpoint:
cleared after successful scrape
`);

process.exit(0);

// Jangan browser.close()
// karena browser merupakan Brave milikmu.