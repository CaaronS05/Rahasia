import { chromium } from "playwright-core";

const POOL =
    "7THpxneYN3Cp98VgKTJcoawLSKUFK3rGzELEJxVmXTwU";

const browser =
    await chromium.connectOverCDP(
        "http://127.0.0.1:9222"
    );

const context =
    browser.contexts()[0];

if (!context) {
    throw new Error(
        "Brave context tidak ditemukan"
    );
}

let page =
    context.pages().find((p) =>
        p.url().includes("lpagent.io")
    );

if (!page) {
    page = await context.newPage();

    await page.goto(
        `https://app.lpagent.io/pools/${POOL}?tab=top`,
        {
            waitUntil: "domcontentloaded",
            timeout: 120000,
        }
    );
}

const result =
    await page.evaluate(
        async (pool) => {
            const url =
                `https://api.lpagent.io/api/v1/pools/${pool}/top-lpers` +
                `?page=2` +
                `&pageSize=20` +
                `&order_by=total_pnl_native` +
                `&sort_order=desc`;

            try {
                const response =
                    await fetch(
                        url,
                        {
                            credentials: "include",
                            headers: {
                                Accept:
                                    "application/json",
                            },
                        }
                    );

                return {
                    ok: response.ok,
                    status: response.status,
                    text:
                        await response.text(),
                };
            } catch (error) {
                return {
                    ok: false,
                    status: 0,
                    text:
                        String(error),
                };
            }
        },
        POOL
    );

console.log(
    "HTTP:",
    result.status
);

console.log(
    result.text.slice(
        0,
        2000
    )
);

process.exit(0);