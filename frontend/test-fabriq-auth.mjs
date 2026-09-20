import { chromium } from "playwright-core";

const WALLET = "9xv2w9f7ADKAA2K85ohnK2E6pYGE8WEamvMFD325NoGW";

const browser = await chromium.connectOverCDP(
    "http://127.0.0.1:9222"
);

const contexts = browser.contexts();

if (!contexts.length) {
    throw new Error("No Brave context found");
}

const context = contexts[0];

let pages = context.pages();

let page = pages.find((p) =>
    p.url().includes("fabriq.trade")
);

if (!page) {
    page = await context.newPage();
    await page.goto("https://fabriq.trade", {
        waitUntil: "domcontentloaded",
    });

    console.log(
        "Open Fabriq in Brave and complete the normal verification first."
    );

    process.exit(1);
}

console.log("[1] Fabriq page:", page.url());

const auth = await page.evaluate(async () => {
    const response = await fetch("/auth/verify", {
        credentials: "include",
    });

    const text = await response.text();

    return {
        status: response.status,
        text,
    };
});

console.log("[2] auth status:", auth.status);

if (auth.status !== 200) {
    console.log("[FAIL] /auth/verify did not return 200");
    console.log(auth.text.slice(0, 300));
    process.exit(1);
}

const authJson = JSON.parse(auth.text);

if (!authJson.token) {
    throw new Error("JWT token missing from auth response");
}

console.log("[3] JWT received successfully");

const url =
    `https://apinew.fabriq.trade/portfolio/stats/${WALLET}` +
    `?timezone=Asia%2FJakarta&sources=wallet&sources=hawkfi`;

const response = await fetch(url, {
    headers: {
        Authorization: `Bearer ${authJson.token}`,
        Accept: "application/json",
    },
});

console.log("[4] stats status:", response.status);

const data = await response.json();

console.log(JSON.stringify(data, null, 2));

const calendarUrl =
    `https://apinew.fabriq.trade/portfolio/calendar/${WALLET}` +
    `?month=2026-09&timezone=Asia%2FJakarta&sources=wallet&sources=hawkfi`;

const calendarResponse = await fetch(calendarUrl, {
    headers: {
        Authorization: `Bearer ${authJson.token}`,
        Accept: "application/json",
    },
});

console.log("[5] calendar status:", calendarResponse.status);

const calendarData = await calendarResponse.json();

console.log(
    "[6] calendar:",
    JSON.stringify(calendarData, null, 2)
);

// IMPORTANT:
// jangan browser.close()
// karena kita attach ke Brave yang sedang kamu gunakan.