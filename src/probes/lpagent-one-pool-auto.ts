import fs from "node:fs/promises";
import { chromium, Page, Locator } from "playwright-core";


// ============================================================
// CONFIG
// ============================================================

const POOL =
    "66RWZy7xGkUMQ4Aj3ws394nvfQJqFnfvsZmywZzfvwsi";

const POOL_URL =
    `https://app.lpagent.io/pools/${POOL}`;

const API_TARGET =
    `/api/v1/pools/${POOL}/top-lpers`;

const CDP_URL =
    "http://127.0.0.1:9222";

const OUTPUT_DIR =
    "output";

const OUTPUT_FILE =
    `${OUTPUT_DIR}/lpagent-one-pool-auto.json`;

const CHECKPOINT_FILE =
    `${OUTPUT_DIR}/lpagent-one-pool-auto-checkpoint.json`;

const SCROLL_DELAY_MS =
    850;

const MAX_SCROLL_ATTEMPTS_WITHOUT_PROGRESS =
    12;

const MAX_TOTAL_SCROLLS =
    500;


// ============================================================
// TYPES
// ============================================================

type WalletRow = {
    owner?: string;
    [key: string]: any;
};


type Pagination = {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasNextPage: boolean;
};


type PageResult = {
    page: number;
    url: string;
    status: number;
    rows: WalletRow[];
    pagination: Pagination;
    capturedAt: string;
};


type UiProgress = {
    loaded: number;
    total: number;
    text: string;
};


// ============================================================
// UTILS
// ============================================================

function sleep(
    ms: number
) {
    return new Promise<void>(
        resolve => setTimeout(
            resolve,
            ms
        )
    );
}


async function saveJson(
    file: string,
    data: any
) {
    await fs.mkdir(
        OUTPUT_DIR,
        {
            recursive: true
        }
    );

    await fs.writeFile(
        file,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}


async function waitForEnter(
    message: string
) {
    process.stdout.write(
        message
    );

    await new Promise<void>(
        resolve => {
            process.stdin.once(
                "data",
                () => resolve()
            );
        }
    );
}


// ============================================================
// FIND LP AGENT PAGE
// ============================================================

function findLpAgentPage(
    pages: Page[]
): Page | null {
    for (const page of pages) {
        if (
            page.url().includes(
                "app.lpagent.io"
            )
        ) {
            return page;
        }
    }

    return null;
}


// ============================================================
// PARSE TOP LPER RESPONSE
// ============================================================

async function parseTopLperResponse(
    response: any
): Promise<PageResult | null> {
    try {
        const url =
            response.url();

        if (
            !url.includes(
                API_TARGET
            )
        ) {
            return null;
        }

        const status =
            response.status();

        if (
            status !== 200
        ) {
            console.log(
                `[WARN] HTTP ${status}: ${url}`
            );

            return null;
        }

        const json =
            await response.json();

        const rows =
            Array.isArray(
                json?.data
            )
                ? json.data
                : [];

        const pagination =
            json?.pagination;

        if (
            !pagination
        ) {
            console.log(
                "[WARN] Pagination tidak ditemukan:"
            );

            console.log(
                url
            );

            return null;
        }

        return {
            page:
                Number(
                    pagination.page
                ),

            url,

            status,

            rows,

            pagination: {
                page:
                    Number(
                        pagination.page
                    ),

                pageSize:
                    Number(
                        pagination.pageSize
                    ),

                totalCount:
                    Number(
                        pagination.totalCount
                    ),

                totalPages:
                    Number(
                        pagination.totalPages
                    ),

                hasNextPage:
                    Boolean(
                        pagination.hasNextPage
                    ),
            },

            capturedAt:
                new Date()
                    .toISOString(),
        };

    } catch (error) {
        console.log(
            "[WARN] gagal parse top-lpers response"
        );

        console.log(
            error
        );

        return null;
    }
}


// ============================================================
// CLICK TOP LPER TAB
// ============================================================

async function clickTopLperTab(
    page: Page
) {
    console.log(
        "\nMencari tab Top LPer..."
    );

    const candidates = [
        page.getByText(
            "Top LPer",
            {
                exact: true
            }
        ),

        page.getByRole(
            "tab",
            {
                name:
                    /Top LPer/i
            }
        ),

        page.getByRole(
            "button",
            {
                name:
                    /Top LPer/i
            }
        ),
    ];

    for (
        const locator
        of candidates
    ) {
        try {
            if (
                await locator.count()
                === 0
            ) {
                continue;
            }

            const target =
                locator.first();

            if (
                await target.isVisible()
            ) {
                await target.click();

                console.log(
                    "Top LPer diklik."
                );

                return;
            }

        } catch {
            // lanjut kandidat berikutnya
        }
    }

    throw new Error(
        "Tab Top LPer tidak ditemukan."
    );
}


// ============================================================
// UI PROGRESS
// contoh:
// 40 of 778
// ============================================================

async function getUiProgress(
    page: Page
): Promise<UiProgress | null> {
    try {
        const locator =
            page.getByText(
                /^\s*\d+\s+of\s+\d+\s*$/
            );

        const count =
            await locator.count();

        if (
            count === 0
        ) {
            return null;
        }

        /*
         * Ambil yang visible.
         */

        for (
            let i = 0;
            i < count;
            i++
        ) {
            const item =
                locator.nth(i);

            if (
                !await item.isVisible()
            ) {
                continue;
            }

            const text =
                (
                    await item.innerText()
                ).trim();

            const match =
                text.match(
                    /(\d+)\s+of\s+(\d+)/
                );

            if (!match) {
                continue;
            }

            return {
                loaded:
                    Number(match[1]),

                total:
                    Number(match[2]),

                text,
            };
        }

        return null;

    } catch {
        return null;
    }
}


// ============================================================
// FIND TOP LPER SCROLL CONTAINER
// ============================================================

async function getTopLperScroller(
    page: Page
): Promise<Locator> {

    /*
     * Strategi 1:
     * Cari footer:
     *
     * 40 of 778
     *
     * lalu naik ke parent wrapper dan cari
     * descendant div yang overflow-auto.
     */

    const progressLocator =
        page.getByText(
            /^\s*\d+\s+of\s+\d+\s*$/
        );

    const progressCount =
        await progressLocator.count();


    for (
        let i = 0;
        i < progressCount;
        i++
    ) {
        const footer =
            progressLocator.nth(i);

        try {
            if (
                !await footer.isVisible()
            ) {
                continue;
            }

            const found =
                await footer.evaluate(
                    node => {
                        const footerElement =
                            node as HTMLElement;

                        const parent =
                            footerElement.parentElement;

                        if (!parent) {
                            return false;
                        }

                        const candidates =
                            Array.from(
                                parent.querySelectorAll(
                                    "div"
                                )
                            ) as HTMLElement[];


                        for (
                            const el
                            of candidates
                        ) {
                            const style =
                                window.getComputedStyle(
                                    el
                                );

                            const overflowY =
                                style.overflowY;

                            const scrollable =
                                (
                                    overflowY ===
                                    "auto"
                                    ||
                                    overflowY ===
                                    "scroll"
                                )
                                &&
                                el.scrollHeight >
                                el.clientHeight + 5;


                            if (
                                scrollable
                            ) {
                                el.setAttribute(
                                    "data-lpagent-toplper-scroller",
                                    "true"
                                );

                                return true;
                            }
                        }

                        return false;
                    }
                );


            if (found) {
                const locator =
                    page.locator(
                        '[data-lpagent-toplper-scroller="true"]'
                    );

                if (
                    await locator.count()
                    > 0
                ) {
                    return locator.first();
                }
            }

        } catch {
            // lanjut
        }
    }


    /*
     * Strategi 2:
     * Selector langsung dari outerHTML
     * yang kamu kirim.
     *
     * class:
     * relative overflow-auto
     * max-h-[600px]
     */

    const direct =
        page.locator(
            'div[class*="relative"][class*="overflow-auto"][class*="max-h-[600px]"]'
        );


    const directCount =
        await direct.count();


    for (
        let i = 0;
        i < directCount;
        i++
    ) {
        const candidate =
            direct.nth(i);

        try {
            if (
                !await candidate.isVisible()
            ) {
                continue;
            }

            const info =
                await candidate.evaluate(
                    (el: HTMLElement) => ({
                        clientHeight:
                            el.clientHeight,

                        scrollHeight:
                            el.scrollHeight,
                    })
                );


            if (
                info.scrollHeight >
                info.clientHeight + 5
            ) {
                return candidate;
            }

        } catch {
            // lanjut
        }
    }


    /*
     * Strategi 3:
     * cari table yang mengandung owner wallet,
     * lalu naik ke ancestor scrollable.
     */

    const ownerLink =
        page.locator(
            'a[href^="/portfolio?address="]'
        ).first();


    if (
        await ownerLink.count()
        > 0
    ) {
        const found =
            await ownerLink.evaluate(
                node => {
                    let el =
                        node.parentElement;

                    while (el) {
                        const htmlEl =
                            el as HTMLElement;

                        const style =
                            window.getComputedStyle(
                                htmlEl
                            );

                        const overflowY =
                            style.overflowY;

                        if (
                            (
                                overflowY ===
                                "auto"
                                ||
                                overflowY ===
                                "scroll"
                            )
                            &&
                            htmlEl.scrollHeight >
                            htmlEl.clientHeight + 5
                        ) {
                            htmlEl.setAttribute(
                                "data-lpagent-toplper-scroller",
                                "true"
                            );

                            return true;
                        }

                        el =
                            el.parentElement;
                    }

                    return false;
                }
            );


        if (found) {
            return page
                .locator(
                    '[data-lpagent-toplper-scroller="true"]'
                )
                .first();
        }
    }


    throw new Error(
        "Scroll container Top LPer tidak ditemukan."
    );
}


// ============================================================
// SCROLL TOP LPER PANEL
// ============================================================

async function scrollTopLperDown(
    page: Page,
    scroller: Locator
) {
    const before =
        await scroller.evaluate(
            (el: HTMLElement) => ({
                scrollTop:
                    el.scrollTop,

                clientHeight:
                    el.clientHeight,

                scrollHeight:
                    el.scrollHeight,
            })
        );


    /*
     * Scroll dekat sekali ke bagian bawah.
     */

    await scroller.evaluate(
        (el: HTMLElement) => {
            el.scrollTop =
                el.scrollHeight;

            el.dispatchEvent(
                new Event(
                    "scroll",
                    {
                        bubbles: true
                    }
                )
            );
        }
    );


    /*
     * Simulasi wheel di dalam container.
     * Ini membantu listener infinite-scroll
     * yang bergantung pada user scrolling.
     */

    await scroller.hover();

    await page.mouse.wheel(
        0,
        1600
    );


    await sleep(
        250
    );


    const after =
        await scroller.evaluate(
            (el: HTMLElement) => ({
                scrollTop:
                    el.scrollTop,

                clientHeight:
                    el.clientHeight,

                scrollHeight:
                    el.scrollHeight,
            })
        );


    return {
        before,
        after,
    };
}


// ============================================================
// WAIT UNTIL FIRST API RESPONSE EXISTS
// ============================================================

async function waitForFirstPage(
    capturedPages:
        Map<number, PageResult>
) {
    const timeoutAt =
        Date.now() + 20_000;


    while (
        Date.now()
        <
        timeoutAt
    ) {
        if (
            capturedPages.has(1)
        ) {
            return;
        }

        await sleep(
            100
        );
    }


    throw new Error(
        "Page 1 top-lpers tidak muncul dalam 20 detik."
    );
}


// ============================================================
// CHECKPOINT
// ============================================================

async function saveCheckpoint(
    capturedPages:
        Map<number, PageResult>,

    wallets:
        Map<string, WalletRow>,

    scanStartedAt:
        string
) {
    const pages =
        Array.from(
            capturedPages.keys()
        ).sort(
            (a, b) =>
                a - b
        );


    const latestPage =
        pages.length
            ? pages[
            pages.length - 1
            ]
            : 0;


    const latestPagination =
        latestPage
            ? capturedPages.get(
                latestPage
            )?.pagination
            : null;


    await saveJson(
        CHECKPOINT_FILE,
        {
            pool:
                POOL,

            scanStartedAt,

            updatedAt:
                new Date()
                    .toISOString(),

            pagesCaptured:
                capturedPages.size,

            pageNumbers:
                pages,

            latestPagination,

            uniqueWallets:
                wallets.size,

            wallets:
                Array.from(
                    wallets.values()
                ),
        }
    );
}


// ============================================================
// MAIN
// ============================================================

async function main() {

    console.log(
        "================================================"
    );

    console.log(
        "LP AGENT — ONE POOL AUTO SCROLL"
    );

    console.log(
        "================================================"
    );

    console.log(
        `Pool : ${POOL}`
    );


    // ========================================================
    // CHECK CDP
    // ========================================================

    console.log(
        "\nChecking Brave CDP..."
    );


    const versionResponse =
        await fetch(
            `${CDP_URL}/json/version`
        );


    if (
        !versionResponse.ok
    ) {
        throw new Error(
            "Brave CDP tidak tersedia pada port 9222."
        );
    }


    const version =
        (
            await versionResponse.json()
        ) as {
            webSocketDebuggerUrl:
            string;
        };


    console.log(
        "CDP OK"
    );


    // ========================================================
    // CONNECT
    // ========================================================

    const browser =
        await chromium.connectOverCDP(
            version.webSocketDebuggerUrl
        );


    const contexts =
        browser.contexts();


    if (
        contexts.length === 0
    ) {
        throw new Error(
            "Browser context tidak ditemukan."
        );
    }


    const context =
        contexts[0];


    let page =
        findLpAgentPage(
            context.pages()
        );


    if (!page) {
        page =
            await context.newPage();
    }


    console.log(
        `Attached page: ${page.url()}`
    );


    // ========================================================
    // STORAGE
    // ========================================================

    const capturedPages =
        new Map<
            number,
            PageResult
        >();


    const wallets =
        new Map<
            string,
            WalletRow
        >();


    const scanState: {
        latestPagination: Pagination | null;
    } = {
        latestPagination: null,
    };


    const scanStartedAt =
        new Date()
            .toISOString();


    // ========================================================
    // GLOBAL RESPONSE LISTENER
    // ========================================================

    page.on(
        "response",
        async response => {

            if (
                !response
                    .url()
                    .includes(
                        API_TARGET
                    )
            ) {
                return;
            }


            const parsed =
                await parseTopLperResponse(
                    response
                );


            if (!parsed) {
                return;
            }


            const alreadyCaptured =
                capturedPages.has(
                    parsed.page
                );


            capturedPages.set(
                parsed.page,
                parsed
            );


            scanState.latestPagination =
                parsed.pagination;


            for (
                const row
                of parsed.rows
            ) {
                if (
                    row.owner
                ) {
                    wallets.set(
                        row.owner,
                        row
                    );
                }
            }


            console.log();
            console.log(
                `[API PAGE ${parsed.page}]`
            );

            console.log(
                `Rows        : ${parsed.rows.length}`
            );

            console.log(
                `Unique      : ${wallets.size}`
            );

            console.log(
                `Total count : ${parsed.pagination.totalCount}`
            );

            console.log(
                `Total pages : ${parsed.pagination.totalPages}`
            );

            console.log(
                `Has next    : ${parsed.pagination.hasNextPage}`
            );


            if (
                !alreadyCaptured
            ) {
                await saveCheckpoint(
                    capturedPages,
                    wallets,
                    scanStartedAt
                );
            }
        }
    );


    // ========================================================
    // OPEN POOL
    // ========================================================

    if (
        !page
            .url()
            .includes(
                POOL
            )
    ) {
        console.log(
            "\nOpening pool..."
        );


        await page.goto(
            POOL_URL,
            {
                waitUntil:
                    "domcontentloaded",

                timeout:
                    30_000,
            }
        );
    }


    console.log();
    console.log(
        "Jika Cloudflare/login muncul,"
    );

    console.log(
        "selesaikan manual di Brave."
    );


    await waitForEnter(
        "\nJika halaman pool sudah normal, tekan ENTER..."
    );


    // ========================================================
    // RELOAD CLEAN STATE
    // ========================================================

    console.log(
        "\nReloading pool..."
    );


    await page.reload({
        waitUntil:
            "domcontentloaded",
    });


    await sleep(
        1200
    );


    // ========================================================
    // CLICK TOP LPER
    // ========================================================

    await clickTopLperTab(
        page
    );


    console.log(
        "\nMenunggu Top LPer page 1..."
    );


    await waitForFirstPage(
        capturedPages
    );


    await sleep(
        500
    );


    // ========================================================
    // FIND SCROLLER
    // ========================================================

    const scroller =
        await getTopLperScroller(
            page
        );


    const initialScrollerInfo =
        await scroller.evaluate(
            (el: HTMLElement) => ({
                scrollTop:
                    el.scrollTop,

                clientHeight:
                    el.clientHeight,

                scrollHeight:
                    el.scrollHeight,

                className:
                    el.className,
            })
        );


    console.log();
    console.log(
        "Top LPer scroller ditemukan:"
    );

    console.log(
        initialScrollerInfo
    );


    // ========================================================
    // INITIAL UI PROGRESS
    // ========================================================

    let uiProgress =
        await getUiProgress(
            page
        );


    if (uiProgress) {
        console.log(
            `UI progress: ${uiProgress.text}`
        );
    }


    // ========================================================
    // SCROLL LOOP
    // ========================================================

    let noProgressAttempts =
        0;


    let totalScrolls =
        0;


    let previousPagesCaptured =
        capturedPages.size;


    while (true) {

        if (
            totalScrolls
            >=
            MAX_TOTAL_SCROLLS
        ) {
            throw new Error(
                `Safety stop setelah ${MAX_TOTAL_SCROLLS} scroll.`
            );
        }


        /*
         * Jika API sudah bilang final page,
         * scan selesai.
         */

        if (
            scanState.latestPagination
            &&
            scanState.latestPagination.hasNextPage
            === false
        ) {
            console.log(
                "\nAPI hasNextPage=false."
            );

            break;
        }


        totalScrolls++;


        console.log();
        console.log(
            `--------------------------------------------`
        );

        console.log(
            `Scroll #${totalScrolls}`
        );


        const scrollInfo =
            await scrollTopLperDown(
                page,
                scroller
            );


        console.log(
            "scrollTop:",
            scrollInfo.before.scrollTop,
            "→",
            scrollInfo.after.scrollTop
        );


        console.log(
            "scrollHeight:",
            scrollInfo.before.scrollHeight,
            "→",
            scrollInfo.after.scrollHeight
        );


        await sleep(
            SCROLL_DELAY_MS
        );


        /*
         * UI progress:
         * 40 of 778
         */

        uiProgress =
            await getUiProgress(
                page
            );


        if (uiProgress) {
            console.log(
                `UI progress: ${uiProgress.text}`
            );
        }


        /*
         * Network page bertambah?
         */

        if (
            capturedPages.size
            >
            previousPagesCaptured
        ) {
            previousPagesCaptured =
                capturedPages.size;

            noProgressAttempts =
                0;

            continue;
        }


        noProgressAttempts++;


        console.log(
            `No API progress: ${noProgressAttempts}/${MAX_SCROLL_ATTEMPTS_WITHOUT_PROGRESS}`
        );


        /*
         * Kalau UI sudah bilang loaded = total,
         * beri waktu sedikit untuk last response.
         */

        if (
            uiProgress
            &&
            uiProgress.loaded
            >=
            uiProgress.total
        ) {
            console.log(
                "UI sudah mencapai total rows."
            );


            await sleep(
                1200
            );


            if (
                scanState.latestPagination
                &&
                scanState.latestPagination
                    .hasNextPage
                === false
            ) {
                break;
            }
        }


        /*
         * Tidak ada progress terlalu lama.
         */

        if (
            noProgressAttempts
            >=
            MAX_SCROLL_ATTEMPTS_WITHOUT_PROGRESS
        ) {
            console.log();
            console.log(
                "[WARN] Tidak ada page baru setelah beberapa scroll."
            );

            break;
        }
    }


    // ========================================================
    // WAIT LAST RESPONSES
    // ========================================================

    await sleep(
        1500
    );


    // ========================================================
    // VALIDATION
    // ========================================================

    const pageNumbers =
        Array.from(
            capturedPages.keys()
        ).sort(
            (a, b) =>
                a - b
        );


    const rawRows =
        Array.from(
            capturedPages.values()
        ).reduce(
            (
                total,
                item
            ) =>
                total
                +
                item.rows.length,
            0
        );


    const missingPages:
        number[] = [];


    if (
        pageNumbers.length
        > 0
    ) {
        const maxPage =
            Math.max(
                ...pageNumbers
            );


        for (
            let i = 1;
            i <= maxPage;
            i++
        ) {
            if (
                !capturedPages.has(i)
            ) {
                missingPages.push(i);
            }
        }
    }


    const finalUiProgress =
        await getUiProgress(
            page
        );


    const scanFinishedAt =
        new Date()
            .toISOString();


    // ========================================================
    // FINAL OUTPUT
    // ========================================================

    const finalResult = {
        pool:
            POOL,

        scanStartedAt,

        scanFinishedAt,

        totalScrolls,

        pagesCaptured:
            capturedPages.size,

        pageNumbers,

        missingPages,

        rawRows,

        uniqueWallets:
            wallets.size,

        finalPagination:
            scanState.latestPagination,

        uiProgress:
            finalUiProgress,

        pages:
            Array.from(
                capturedPages.values()
            ).sort(
                (a, b) =>
                    a.page - b.page
            ),

        wallets:
            Array.from(
                wallets.values()
            ),
    };


    await saveJson(
        OUTPUT_FILE,
        finalResult
    );


    // ========================================================
    // SUMMARY
    // ========================================================

    console.log();
    console.log(
        "================================================"
    );

    console.log(
        "SCAN COMPLETE"
    );

    console.log(
        "================================================"
    );

    console.log(
        `Pages captured : ${capturedPages.size}`
    );

    console.log(
        `Raw rows       : ${rawRows}`
    );

    console.log(
        `Unique wallets : ${wallets.size}`
    );

    console.log(
        `Missing pages  : ${missingPages.length
            ? missingPages.join(", ")
            : "0"
        }`
    );


    const finalPagination =
        scanState.latestPagination;

    if (
        finalPagination
    ) {
        console.log(
            `API total      : ${finalPagination.totalCount}`
        );

        console.log(
            `API pages      : ${finalPagination.totalPages}`
        );

        console.log(
            `API has next   : ${finalPagination.hasNextPage}`
        );
    }


    if (
        finalUiProgress
    ) {
        console.log(
            `UI progress    : ${finalUiProgress.text}`
        );
    }


    console.log(
        `Total scrolls  : ${totalScrolls}`
    );

    console.log(
        `Output         : ${OUTPUT_FILE}`
    );

    console.log(
        `Checkpoint     : ${CHECKPOINT_FILE}`
    );

    console.log(
        "================================================"
    );


    /*
     * Jangan browser.close().
     *
     * Brave adalah browser normal
     * yang sedang dipakai user.
     */
}


// ============================================================
// RUN
// ============================================================

main().catch(
    error => {
        console.error();
        console.error(
            "FATAL ERROR"
        );

        console.error(
            error
        );

        process.exit(1);
    }
);