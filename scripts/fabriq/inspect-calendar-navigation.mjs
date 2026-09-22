import { chromium } from "playwright-core";

const CDP_URL =
    "http://127.0.0.1:9222";

console.log(
    "[BOOT] Connecting to Brave..."
);

const browser =
    await chromium.connectOverCDP(
        CDP_URL,
        {
            timeout: 120_000,
        }
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
        .find(
            (page) =>
                page
                    .url()
                    .includes(
                        "fabriq.trade"
                    )
        );

if (!page) {
    throw new Error(
        "Fabriq tab not found."
    );
}

console.log(
    "[BOOT] Fabriq page:",
    page.url()
);

console.log(`
========================================
CALENDAR NETWORK MONITOR
========================================

Sekarang di Fabriq:

1. Buka wallet portfolio
2. Lihat calendar bulan sekarang
3. Klik tombol PREVIOUS MONTH sekali
4. Klik PREVIOUS MONTH sekali lagi
5. Klik NEXT MONTH sekali

Script akan mencatat request calendar.

Tekan Ctrl+C setelah selesai.
`);

page.on(
    "response",
    async (response) => {
        const url =
            response.url();

        if (
            !url.includes(
                "/portfolio/calendar/"
            )
        ) {
            return;
        }

        console.log(
            "\n----------------------------------------"
        );

        console.log(
            "[CALENDAR RESPONSE]"
        );

        console.log(
            "Status:",
            response.status()
        );

        console.log(
            "URL:",
            url
        );

        try {
            const parsed =
                new URL(url);

            console.log(
                "Month:",
                parsed.searchParams.get(
                    "month"
                )
            );

            console.log(
                "Timezone:",
                parsed.searchParams.get(
                    "timezone"
                )
            );

            console.log(
                "Sources:",
                parsed.searchParams.getAll(
                    "sources"
                )
            );
        } catch {
            // ignore URL parse error
        }

        try {
            const json =
                await response.json();

            const data =
                json?.data ?? {};

            console.log(
                "Success:",
                json?.success
            );

            console.log(
                "Days:",
                Object.keys(
                    data
                ).length
            );

            console.log(
                "Dates:",
                Object.keys(
                    data
                ).join(", ")
            );
        } catch {
            console.log(
                "Response body could not be parsed."
            );
        }
    }
);

// Keep process alive
await new Promise(() => { });