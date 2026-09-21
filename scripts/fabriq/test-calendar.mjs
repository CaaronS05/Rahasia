import { chromium } from "playwright-core";

const CDP_URL =
    "http://127.0.0.1:9222";

const TIMEZONE =
    "Asia/Jakarta";

const wallet =
    process.argv[2];

if (!wallet) {
    console.error(`
Usage:

node scripts/fabriq/test-calendar.mjs <wallet>

Example:

node scripts/fabriq/test-calendar.mjs Bx9mCNqo5Ce9kKpb26hYWPzkeSxS3DSZSzkZ3nJjicP6
`);

    process.exit(1);
}

// ======================================================
// MONTH HELPERS
// ======================================================

function getCurrentMonth() {
    const parts =
        new Intl.DateTimeFormat(
            "en-US",
            {
                timeZone: TIMEZONE,
                year: "numeric",
                month: "2-digit",
            }
        ).formatToParts(
            new Date()
        );

    const year =
        parts.find(
            (part) =>
                part.type === "year"
        )?.value;

    const month =
        parts.find(
            (part) =>
                part.type === "month"
        )?.value;

    return `${year}-${month}`;
}

function getPreviousMonth(month) {
    const [year, monthNumber] =
        month
            .split("-")
            .map(Number);

    const date =
        new Date(
            Date.UTC(
                year,
                monthNumber - 2,
                1
            )
        );

    return [
        date.getUTCFullYear(),

        String(
            date.getUTCMonth() + 1
        ).padStart(
            2,
            "0"
        ),
    ].join("-");
}

const currentMonth =
    getCurrentMonth();

const previousMonth =
    getPreviousMonth(
        currentMonth
    );

const months = [
    previousMonth,
    currentMonth,
];

// ======================================================
// CONNECT BRAVE
// ======================================================

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
        "Fabriq tab not found. Open Fabriq in Brave first."
    );
}

console.log(
    "[BOOT] Fabriq:",
    page.url()
);

// ======================================================
// GET TOKEN
// ======================================================

const auth =
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

if (
    auth.status !== 200
) {
    throw new Error(
        `/auth/verify failed: ${auth.status}`
    );
}

const authJson =
    JSON.parse(
        auth.text
    );

const token =
    authJson.token;

if (!token) {
    throw new Error(
        "JWT missing."
    );
}

console.log(
    "[AUTH] JWT OK"
);

// ======================================================
// FETCH
// ======================================================

async function fetchCalendar(
    month
) {
    const url =
        `https://apinew.fabriq.trade/portfolio/calendar/${wallet}` +
        `?month=${month}` +
        `&timezone=${encodeURIComponent(
            TIMEZONE
        )}` +
        `&sources=wallet&sources=hawkfi`;

    console.log(
        `\n[FETCH] ${month}`
    );

    const response =
        await fetch(
            url,
            {
                headers: {
                    Authorization:
                        `Bearer ${token}`,

                    Accept:
                        "application/json",
                },
            }
        );

    if (!response.ok) {
        throw new Error(
            `${month} → HTTP ${response.status}`
        );
    }

    const json =
        await response.json();

    if (
        json?.success !== true ||
        !json?.data
    ) {
        throw new Error(
            `${month} → invalid response`
        );
    }

    return json.data;
}

// ======================================================
// FETCH BOTH MONTHS
// ======================================================

const calendars = {};

for (
    const month
    of months
) {
    const rawCalendar =
        await fetchCalendar(
            month
        );

    calendars[month] =
        Object.fromEntries(
            Object.entries(
                rawCalendar
            ).filter(
                ([date]) =>
                    date.startsWith(
                        `${month}-`
                    )
            )
        );
}

// ======================================================
// REPORT
// ======================================================

console.log(
    "\n========================================"
);

console.log(
    "FABRIQ CALENDAR TEST"
);

console.log(
    "========================================"
);

console.log(
    "Wallet:",
    wallet
);

console.log(
    "Months:",
    months.join(", ")
);

for (
    const month
    of months
) {
    const calendar =
        calendars[month];

    const entries =
        Object.entries(
            calendar
        );

    const pnlSol =
        entries.reduce(
            (
                total,
                [, day]
            ) =>
                total +
                (
                    Number(
                        day?.pnlSol
                    ) || 0
                ),
            0
        );

    const pnlUsd =
        entries.reduce(
            (
                total,
                [, day]
            ) =>
                total +
                (
                    Number(
                        day?.pnlUsd
                    ) || 0
                ),
            0
        );

    console.log(
        `\n${month}`
    );

    console.log(
        "Days returned :",
        entries.length
    );

    console.log(
        "PnL SOL       :",
        pnlSol
    );

    console.log(
        "PnL USD       :",
        pnlUsd
    );

    console.log(
        "Dates         :",
        entries
            .map(
                ([date]) =>
                    date
            )
            .join(", ") ||
        "(none)"
    );
}

console.log(
    "\nSCHEMA PREVIEW"
);

console.log(
    JSON.stringify(
        {
            calendars,
        },
        null,
        2
    )
);

console.log(
    "\n[OK] Test completed."
);

// IMPORTANT:
// jangan browser.close()
// karena kita attach ke Brave milik user.