import { chromium } from "playwright";

const POOL_ADDRESS =
    "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8";

const browser = await chromium.connectOverCDP(
    "http://127.0.0.1:9222"
);

const context = browser.contexts()[0];

if (!context) {
    throw new Error("Browser context tidak ditemukan");
}

let page = context.pages().find(
    (p) => !p.isClosed() && p.url().includes("app.lpagent.io")
);

if (!page) {
    page = await context.newPage();
}

const targetUrl =
    `https://app.lpagent.io/pools/${POOL_ADDRESS}?tab=top`;

const wallets = new Set();

let lastPage = 0;
let totalPages = null;
let totalCount = null;
let hasNextPage = true;

/*
  Capture semua response /top-lpers.
  Body langsung dibaca ketika response muncul.
*/
page.on("response", async (response) => {
    try {
        const url = new URL(response.url());

        if (
            url.hostname !== "api.lpagent.io" ||
            url.pathname !==
            `/api/v1/pools/${POOL_ADDRESS}/top-lpers`
        ) {
            return;
        }

        const body = await response.text();
        const json = JSON.parse(body);

        const currentPage = json.pagination?.page;

        if (!currentPage) return;

        for (const row of json.data ?? []) {
            if (row.owner) {
                wallets.add(row.owner);
            }
        }

        lastPage = Math.max(lastPage, currentPage);

        totalPages = json.pagination.totalPages;
        totalCount = json.pagination.totalCount;
        hasNextPage = json.pagination.hasNextPage;

        console.log(
            `Page ${currentPage}/${totalPages}` +
            ` | rows=${json.data.length}` +
            ` | unique=${wallets.size}`
        );
    } catch (err) {
        console.error("Capture error:", err.message);
    }
});

console.log("Opening:", targetUrl);

await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
});

/*
  Tunggu page 1 masuk.
*/
while (lastPage < 1) {
    await page.waitForTimeout(250);
}

console.log(
    `\nTop LPers: ${totalCount}` +
    ` | total pages: ${totalPages}\n`
);

/*
  Cari scroll container tabel Top LPer.
*/
const tableScroller = page.locator(
    "div.relative.overflow-auto"
).filter({
    hasText: "OWNER",
}).first();

await tableScroller.waitFor({
    state: "visible",
    timeout: 15000,
});

/*
  Infinite scroll sampai API mengatakan
  hasNextPage = false.
*/

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 500, max = 800) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

while (hasNextPage) {
    const expectedPage = lastPage + 1;

    const delay = randomDelay(500, 800);

    console.log(
        `Waiting ${delay}ms before page ${expectedPage}...`
    );

    await sleep(delay);

    console.log(`Scrolling for page ${expectedPage}...`);

    await tableScroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });

    const started = Date.now();

    while (lastPage < expectedPage) {
        if (Date.now() - started > 15000) {
            throw new Error(
                `Timeout waiting for page ${expectedPage}`
            );
        }

        await page.waitForTimeout(250);
    }
}

console.log("\n==============================");
console.log("SCAN COMPLETE");
console.log("==============================");

console.log("Pool:", POOL_ADDRESS);
console.log("Reported Top LPers:", totalCount);
console.log("Pages captured:", lastPage);
console.log("Unique wallets:", wallets.size);

console.log("\nWallet addresses:\n");

let i = 1;

for (const wallet of wallets) {
    console.log(`${i}. ${wallet}`);
    i++;
}

console.log("\nTOP LPER FULL SCAN PASS");

process.exit(0);