import { chromium } from "playwright";

const TOKEN_CA =
    "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR";

console.log("Connecting to Brave...");

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

console.log("Opening LP Agent Pools...");

await page.goto("https://app.lpagent.io/pools", {
    waitUntil: "domcontentloaded",
});

console.log("Page:", page.url());

const search = page.locator(
    'input[name="searchValue"]'
);

await search.waitFor({
    state: "visible",
    timeout: 20000,
});

console.log("Search box found");

const responsePromise = page.waitForResponse(
    (response) => {
        try {
            const url = new URL(response.url());

            return (
                response.request().method() === "GET" &&
                url.hostname === "api.lpagent.io" &&
                url.pathname === "/api/v1/pools/discover" &&
                url.searchParams.get("search") === TOKEN_CA
            );
        } catch {
            return false;
        }
    },
    {
        timeout: 30000,
    }
);

console.log("Entering Token CA...");

await search.fill("");
await search.fill(TOKEN_CA);

const response = await responsePromise;

console.log(
    `HTTP ${response.status()} | ${response.headers()["content-type"]}`
);

if (response.status() !== 200) {
    console.log(
        "Request failed:",
        await response.text()
    );

    process.exit(1);
}

const json = await response.json();

console.log("\nStatus:", json.status);
console.log("Pagination:", json.pagination);
console.log();

for (const [index, pool] of json.data.entries()) {
    console.log(
        `${index + 1}. ` +
        `${pool.token0_symbol}/${pool.token1_symbol}` +
        ` | bin=${pool.bin_step}` +
        ` | pool=${pool.pool}`
    );
}

console.log("\nPOOL DISCOVERY PROOF PASS");

// Jangan browser.close()
// karena browser ini adalah Brave asli yang sedang kita reuse.
process.exit(0);