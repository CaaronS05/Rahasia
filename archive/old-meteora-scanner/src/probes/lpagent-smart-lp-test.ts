import fs from "node:fs/promises";
import { chromium, Page, Response } from "playwright-core";

// ============================================================
// CONFIG
// ============================================================

const CDP_URL = "http://127.0.0.1:9222";

const SMART_LP_PAGE =
    "https://app.lpagent.io/smart-lp";

const API_TARGET =
    "/api/v1/smart-lp";

const OUTPUT =
    "output/lpagent-smart-lp-test.json";

const CHECKPOINT =
    "output/lpagent-smart-lp-test-checkpoint.json";

// TEST DULU 5 PAGE.
// Setelah berhasil ubah menjadi 0 untuk scan semua page.
const MAX_PAGES_TO_TEST = 0;

const PAGE_DELAY_MS = 1500;
const RESPONSE_TIMEOUT_MS = 20_000;


// ============================================================
// TYPES
// ============================================================

type WalletRow = {
    owner?: string;
    [key: string]: any;
};

type Pagination = {
    page?: number;
    pageSize?: number;
    totalCount?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    [key: string]: any;
};

type PageResult = {
    page: number;
    url: string;
    status: number;
    rows: WalletRow[];
    pagination: Pagination | null;
    capturedAt: string;
};


// ============================================================
// UTILS
// ============================================================

function sleep(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function saveJson(
    file: string,
    data: any
) {
    await fs.mkdir(
        "output",
        {
            recursive: true,
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
    process.stdout.write(message);

    await new Promise<void>(
        (resolve) => {
            process.stdin.once(
                "data",
                () => resolve()
            );
        }
    );
}


// ============================================================
// FIND SMART LP TAB
// ============================================================

function findSmartLpPage(
    pages: Page[]
): Page | null {
    for (const page of pages) {
        if (
            page.url().includes(
                "app.lpagent.io/smart-lp"
            )
        ) {
            return page;
        }
    }

    return null;
}


// ============================================================
// RESPONSE PARSER
// ============================================================

async function parseSmartLpResponse(
    response: Response
): Promise<PageResult> {
    const url = response.url();

    const parsedUrl =
        new URL(url);

    const pageNumber =
        Number(
            parsedUrl.searchParams.get(
                "page"
            )
        );

    const json =
        await response.json();

    /*
     * LP Agent response sebelumnya terlihat menggunakan:
     *
     * data.smart_lp
     *
     * Tetapi kita buat parser fleksibel agar tidak gampang rusak.
     */

    let rows: WalletRow[] = [];

    if (
        Array.isArray(
            json?.data?.smart_lp
        )
    ) {
        rows =
            json.data.smart_lp;
    } else if (
        Array.isArray(
            json?.smart_lp
        )
    ) {
        rows =
            json.smart_lp;
    } else if (
        Array.isArray(
            json?.data
        )
    ) {
        rows =
            json.data;
    }

    const pagination =
        json?.pagination
        ??
        json?.data?.pagination
        ??
        null;

    return {
        page:
            pageNumber,

        url,

        status:
            response.status(),

        rows,

        pagination,

        capturedAt:
            new Date()
                .toISOString(),
    };
}


// ============================================================
// WAIT SPECIFIC API PAGE
// ============================================================

async function waitSmartLpResponse(
    page: Page,
    expectedPage: number
): Promise<PageResult> {
    console.log(
        `Waiting API page ${expectedPage}...`
    );

    const response =
        await page.waitForResponse(
            (response) => {
                if (
                    !response
                        .url()
                        .includes(
                            API_TARGET
                        )
                ) {
                    return false;
                }

                if (
                    response.status()
                    !== 200
                ) {
                    return false;
                }

                try {
                    const url =
                        new URL(
                            response.url()
                        );

                    return (
                        url.searchParams.get(
                            "page"
                        )
                        ===
                        String(expectedPage)
                    );
                } catch {
                    return false;
                }
            },
            {
                timeout:
                    RESPONSE_TIMEOUT_MS,
            }
        );

    return parseSmartLpResponse(
        response
    );
}


// ============================================================
// PAGINATION FOOTER
// ============================================================

function getFooter(
    page: Page
) {
    const text =
        page.getByText(
            /^Showing \d+ to \d+ of \d+ wallets$/
        ).first();

    /*
     * Parent langsungnya adalah wrapper:
     *
     * Showing ...
     * pagination buttons
     */

    return text.locator("..");
}


// ============================================================
// READ UI INFO
// ============================================================

async function getUiInfo(
    page: Page
) {
    const textLocator =
        page.getByText(
            /^Showing \d+ to \d+ of \d+ wallets$/
        ).first();

    await textLocator.waitFor({
        state: "visible",
        timeout: 15_000,
    });

    const text =
        (
            await textLocator.innerText()
        ).trim();

    const match =
        text.match(
            /Showing (\d+) to (\d+) of (\d+) wallets/
        );

    if (!match) {
        throw new Error(
            `Tidak bisa parse footer: ${text}`
        );
    }

    const start =
        Number(match[1]);

    const end =
        Number(match[2]);

    const total =
        Number(match[3]);

    /*
     * Dari HAR kita tahu pageSize = 12.
     */

    const pageSize = 12;

    const currentPage =
        Math.ceil(
            start / pageSize
        );

    const totalPages =
        Math.ceil(
            total / pageSize
        );

    return {
        text,
        start,
        end,
        total,
        currentPage,
        totalPages,
    };
}


// ============================================================
// CLICK PAGE NUMBER
// ============================================================

async function clickPageNumber(
    page: Page,
    pageNumber: number
) {
    const footer =
        getFooter(page);

    const button =
        footer.getByRole(
            "button",
            {
                name:
                    String(pageNumber),

                exact:
                    true,
            }
        );

    if (
        await button.count()
        === 0
    ) {
        throw new Error(
            `Button page ${pageNumber} tidak ditemukan.`
        );
    }

    await button
        .first()
        .click();
}


// ============================================================
// NEXT BUTTON
// ============================================================

async function getNextButton(
    page: Page
) {
    const footer =
        getFooter(page);

    return footer
        .locator(
            "button:has(svg.lucide-chevron-right)"
        )
        .first();
}


// ============================================================
// STORE RESULT
// ============================================================

function storePage(
    result: PageResult,
    capturedPages:
        Map<number, PageResult>,
    wallets:
        Map<string, WalletRow>
) {
    capturedPages.set(
        result.page,
        result
    );

    for (
        const wallet
        of result.rows
    ) {
        if (
            wallet.owner
        ) {
            wallets.set(
                wallet.owner,
                wallet
            );
        }
    }
}


// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log(
        "============================================"
    );

    console.log(
        "LP AGENT — SMART LP PAGINATION TEST"
    );

    console.log(
        "============================================"
    );

    console.log(
        `Test limit : ${MAX_PAGES_TO_TEST} pages`
    );


    // ========================================================
    // CDP
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
            "Brave CDP tidak aktif di port 9222."
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
        findSmartLpPage(
            context.pages()
        );


    if (!page) {
        page =
            await context.newPage();

        await page.goto(
            SMART_LP_PAGE,
            {
                waitUntil:
                    "domcontentloaded",
            }
        );
    }


    console.log(
        `Attached: ${page.url()}`
    );


    // ========================================================
    // USER READY
    // ========================================================

    console.log();
    console.log(
        "Atur filter Smart LP seperti yang kamu mau."
    );

    console.log(
        "Pastikan wallet cards dan pagination sudah terlihat."
    );


    await waitForEnter(
        "\nKalau sudah siap, tekan ENTER..."
    );


    // ========================================================
    // GO TO BOTTOM
    // ========================================================

    await page.evaluate(
        () => {
            window.scrollTo(
                0,
                document.body.scrollHeight
            );
        }
    );


    await sleep(
        500
    );


    let ui =
        await getUiInfo(
            page
        );


    console.log();
    console.log(
        `Current UI : ${ui.text}`
    );

    console.log(
        `Current page: ${ui.currentPage}`
    );

    console.log(
        `Total pages : ${ui.totalPages}`
    );

    console.log(
        `Total wallets: ${ui.total}`
    );


    // ========================================================
    // STORAGE
    // ========================================================

    const scanStartedAt =
        new Date()
            .toISOString();


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


    // ========================================================
    // CAPTURE PAGE 1 VIA RELOAD
    // ========================================================

    console.log(
        "\nReloading untuk capture API page 1..."
    );

    const page1Promise =
        waitSmartLpResponse(
            page,
            1
        );

    await page.reload({
        waitUntil: "domcontentloaded",
    });

    const first =
        await page1Promise;

    storePage(
        first,
        capturedPages,
        wallets
    );

    /*
     * Tunggu UI selesai render lagi.
     */
    await page
        .getByText(
            /^Showing \d+ to \d+ of \d+ wallets$/
        )
        .first()
        .waitFor({
            state: "visible",
            timeout: 15_000,
        });

    ui =
        await getUiInfo(
            page
        );

    console.log();
    console.log(
        `[PAGE 1]`
    );

    console.log(
        `Rows      : ${first.rows.length}`
    );

    console.log(
        `Unique    : ${wallets.size}`
    );

    console.log(
        `UI        : ${ui.text}`
    );


    // ========================================================
    // PAGINATION LOOP
    // ========================================================

    const pagesToScan =
        MAX_PAGES_TO_TEST > 0
            ? Math.min(
                MAX_PAGES_TO_TEST,
                ui.totalPages
            )
            : ui.totalPages;


    for (
        let expectedPage = 2;
        expectedPage <= pagesToScan;
        expectedPage++
    ) {

        console.log();
        console.log(
            "--------------------------------------------"
        );

        console.log(
            `Moving ${expectedPage - 1
            } → ${expectedPage}`
        );


        /*
         * Scroll bawah dulu supaya pagination
         * pasti berada di viewport.
         */

        await page.evaluate(
            () => {
                window.scrollTo(
                    0,
                    document.body.scrollHeight
                );
            }
        );


        await sleep(
            250
        );


        const nextButton =
            await getNextButton(
                page
            );


        if (
            await nextButton.count()
            === 0
        ) {
            throw new Error(
                "Next button tidak ditemukan."
            );
        }


        if (
            await nextButton.isDisabled()
        ) {
            console.log(
                "Next button disabled."
            );

            break;
        }


        /*
         * Listener dibuat SEBELUM click.
         */

        const responsePromise =
            waitSmartLpResponse(
                page,
                expectedPage
            );


        await nextButton.click();


        const result =
            await responsePromise;


        storePage(
            result,
            capturedPages,
            wallets
        );


        await sleep(
            PAGE_DELAY_MS
        );


        ui =
            await getUiInfo(
                page
            );


        console.log(
            `[PAGE ${result.page}]`
        );

        console.log(
            `Rows      : ${result.rows.length}`
        );

        console.log(
            `Unique    : ${wallets.size}`
        );

        console.log(
            `UI        : ${ui.text}`
        );


        /*
         * checkpoint setiap page
         */

        await saveJson(
            CHECKPOINT,
            {
                scanStartedAt,

                updatedAt:
                    new Date()
                        .toISOString(),

                testLimit:
                    MAX_PAGES_TO_TEST,

                currentPage:
                    result.page,

                pagesCaptured:
                    Array.from(
                        capturedPages.keys()
                    ),

                uniqueWallets:
                    wallets.size,

                ui,

                wallets:
                    Array.from(
                        wallets.values()
                    ),
            }
        );
    }


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
                sum,
                result
            ) =>
                sum
                +
                result.rows.length,
            0
        );


    const missingPages:
        number[] = [];


    if (
        pageNumbers.length
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


    const finalUi =
        await getUiInfo(
            page
        );


    // ========================================================
    // SAVE
    // ========================================================

    const finalResult = {
        scanStartedAt,

        scanFinishedAt:
            new Date()
                .toISOString(),

        testLimit:
            MAX_PAGES_TO_TEST,

        pagesCaptured:
            capturedPages.size,

        pageNumbers,

        missingPages,

        rawRows,

        uniqueWallets:
            wallets.size,

        finalUi,

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
        OUTPUT,
        finalResult
    );


    // ========================================================
    // SUMMARY
    // ========================================================

    console.log();
    console.log(
        "============================================"
    );

    console.log(
        "TEST COMPLETE"
    );

    console.log(
        "============================================"
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

    console.log(
        `Final UI       : ${finalUi.text}`
    );

    console.log(
        `Output         : ${OUTPUT}`
    );

    console.log(
        `Checkpoint     : ${CHECKPOINT}`
    );

    console.log(
        "============================================"
    );


    /*
     * Jangan browser.close()
     * karena ini Brave manual.
     */
}


// ============================================================
// RUN
// ============================================================

main().catch(
    (error) => {
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