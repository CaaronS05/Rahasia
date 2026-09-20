import fs from "node:fs/promises";
import { chromium } from "playwright-core";

const DATASET = "./public/data/wallets-14d.json";
const LIMIT = 50;

const TIMEZONE = "Asia/Jakarta";
const MONTH = "2026-09";

// =========================
// AUTH
// =========================

const browser = await chromium.connectOverCDP(
    "http://127.0.0.1:9222"
);

const context = browser.contexts()[0];

if (!context) {
    throw new Error("No Brave context found.");
}

const page =
    context.pages().find((p) => p.url().includes("fabriq.trade")) ??
    context.pages()[0];

if (!page) {
    throw new Error("Open Fabriq in Brave first.");
}

let token = null;
let tokenExpiresAt = 0;

async function getToken(force = false) {
    if (
        !force &&
        token &&
        Date.now() < tokenExpiresAt - 10_000
    ) {
        return token;
    }

    const result = await page.evaluate(async () => {
        const response = await fetch("/auth/verify", {
            credentials: "include",
        });

        return {
            status: response.status,
            text: await response.text(),
        };
    });

    if (result.status !== 200) {
        throw new Error(
            `/auth/verify failed: ${result.status} ${result.text.slice(0, 200)}`
        );
    }

    const json = JSON.parse(result.text);

    if (!json.token) {
        throw new Error("JWT missing from /auth/verify");
    }

    token = json.token;

    // JWT Fabriq sangat pendek; refresh konservatif.
    tokenExpiresAt = Date.now() + 45_000;

    console.log("[AUTH] JWT refreshed");

    return token;
}

// =========================
// API
// =========================

async function fabriqFetch(url, retry = true) {
    const jwt = await getToken();

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/json",
        },
    });

    if (response.status === 401 && retry) {
        console.log("[AUTH] token rejected → refreshing");

        await getToken(true);

        return fabriqFetch(url, false);
    }

    if (!response.ok) {
        throw new Error(
            `${response.status} ${response.statusText}`
        );
    }

    return response.json();
}

async function fetchWallet(wallet) {
    const statsUrl =
        `https://apinew.fabriq.trade/portfolio/stats/${wallet}` +
        `?timezone=${encodeURIComponent(TIMEZONE)}` +
        `&sources=wallet&sources=hawkfi`;

    const calendarUrl =
        `https://apinew.fabriq.trade/portfolio/calendar/${wallet}` +
        `?month=${MONTH}` +
        `&timezone=${encodeURIComponent(TIMEZONE)}` +
        `&sources=wallet&sources=hawkfi`;

    // Sengaja sequential dulu untuk batch test.
    const stats = await fabriqFetch(statsUrl);
    const calendar = await fabriqFetch(calendarUrl);

    return {
        owner: wallet,

        fabriq: {
            fetchedAt: new Date().toISOString(),

            stats: stats?.data ?? null,

            calendar: calendar?.data ?? {},
        },
    };
}

// =========================
// LOAD DATASET
// =========================

const raw = JSON.parse(
    await fs.readFile(DATASET, "utf8")
);

const wallets =
    Array.isArray(raw)
        ? raw
        : raw.wallets ??
        raw.data ??
        raw.smart_lp ??
        [];

const selected = wallets
    .map((wallet) =>
        wallet.owner ??
        wallet.wallet ??
        wallet.wallet_address
    )
    .filter(Boolean)
    .slice(0, LIMIT);

console.log(
    `[START] Testing ${selected.length} wallets`
);

// =========================
// SCRAPE
// =========================

const results = [];

for (let i = 0; i < selected.length; i++) {
    const wallet = selected[i];

    console.log(
        `\n[${i + 1}/${selected.length}] ${wallet}`
    );

    try {
        const result = await fetchWallet(wallet);

        results.push(result);

        console.log(
            `[OK] positions=${result.fabriq.stats?.totalPositions ?? "?"}` +
            ` pnl=$${result.fabriq.stats?.netPnlUsd?.toFixed?.(2) ?? "?"}` +
            ` calendarDays=${Object.keys(result.fabriq.calendar).length}`
        );
    } catch (error) {
        console.error(
            `[FAIL] ${wallet}:`,
            error.message
        );

        results.push({
            owner: wallet,
            error: error.message,
        });
    }

    // kecil dulu supaya kita observasi perilaku API
    await new Promise((resolve) =>
        setTimeout(resolve, 500)
    );
}

// =========================
// SAVE TEST OUTPUT
// =========================

await fs.writeFile(
    "./fabriq-test-50.json",
    JSON.stringify(
        {
            generatedAt: new Date().toISOString(),
            count: results.length,
            results,
        },
        null,
        2
    )
);

console.log(
    "\n[DONE] Saved → fabriq-test-10.json"
);

// jangan browser.close()