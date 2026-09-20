import fs from "node:fs/promises";
import { chromium } from "playwright-core";

const POOL =
    "66RWZy7xGkUMQ4Aj3ws394nvfQJqFnfvsZmywZzfvwsi";

const TARGET =
    `/api/v1/pools/${POOL}/top-lpers`;

const OUTPUT =
    "output/lpagent-playwright-single-pool.json";

async function main() {
    console.log("====================================");
    console.log("LP AGENT PLAYWRIGHT NETWORK TEST");
    console.log("====================================");

    // Attach ke Brave yang sudah dibuka manual
    const browser =
        await chromium.connectOverCDP(
            "http://127.0.0.1:9222"
        );

    const contexts =
        browser.contexts();

    if (contexts.length === 0) {
        throw new Error(
            "Tidak menemukan browser context."
        );
    }

    const context =
        contexts[0];

    let pages =
        context.pages();

    if (pages.length === 0) {
        pages = [
            await context.newPage()
        ];
    }

    const page =
        pages[0];

    console.log(
        `Attached page: ${page.url()}`
    );

    const captured: any[] = [];
    const wallets =
        new Map<string, any>();

    page.on(
        "response",
        async (response) => {
            const url =
                response.url();

            if (
                !url.includes(
                    TARGET
                )
            ) {
                return;
            }

            console.log("\n[TOP LPERS RESPONSE]");
            console.log(
                `Status : ${response.status()}`
            );
            console.log(
                `URL    : ${url}`
            );

            try {
                const data =
                    await response.json();

                captured.push({
                    url,
                    status:
                        response.status(),
                    data,
                });

                // Cari array LP wallet
                const rows =
                    data?.data?.lpers ??
                    data?.data?.top_lpers ??
                    data?.data?.items ??
                    data?.data ??
                    [];

                if (
                    Array.isArray(rows)
                ) {
                    console.log(
                        `Rows   : ${rows.length}`
                    );

                    for (
                        const row of rows
                    ) {
                        if (
                            row &&
                            typeof row ===
                            "object" &&
                            row.owner
                        ) {
                            wallets.set(
                                row.owner,
                                row
                            );
                        }
                    }
                }

                const pagination =
                    data?.pagination ??
                    data?.data?.pagination ??
                    null;

                if (pagination) {
                    console.log(
                        "Pagination:",
                        pagination
                    );
                }

            } catch (error) {
                console.log(
                    "Response bukan JSON:",
                    error
                );
            }
        }
    );

    console.log("");
    console.log(
        "Sekarang di Brave:"
    );
    console.log(
        "1. Buka pool target"
    );
    console.log(
        "2. Klik Top LPer"
    );
    console.log(
        "3. Klik page 2 / page 3"
    );
    console.log("");
    console.log(
        "Biarkan script berjalan 60 detik..."
    );

    await new Promise(
        (resolve) =>
            setTimeout(
                resolve,
                60_000
            )
    );

    await fs.mkdir(
        "output",
        {
            recursive: true,
        }
    );

    await fs.writeFile(
        OUTPUT,
        JSON.stringify(
            {
                pool: POOL,

                capturedAt:
                    new Date()
                        .toISOString(),

                responses:
                    captured.length,

                uniqueWallets:
                    wallets.size,

                captures:
                    captured,

                wallets:
                    Array.from(
                        wallets.values()
                    ),
            },
            null,
            2
        )
    );

    console.log("");
    console.log(
        "===================================="
    );

    console.log(
        "TEST COMPLETE"
    );

    console.log(
        "===================================="
    );

    console.log(
        `Responses      : ${captured.length}`
    );

    console.log(
        `Unique wallets : ${wallets.size}`
    );

    console.log(
        `Output         : ${OUTPUT}`
    );

    // Jangan browser.close()
    // karena ini browser manual milik user.
}

main().catch(
    console.error
);