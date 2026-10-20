import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type Browser } from "playwright";
import {
  groupPoolsByToken,
  filterTokenGroups,
  type ScannedPoolItem,
  type TokenPoolGroup,
} from "../../frontend/src/lib/poolInsight.ts";

const DIST_DIR = path.resolve(import.meta.dirname, "../../frontend/dist");
const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "../../.tmp-screenshots");

const MOCK_POOLS: ScannedPoolItem[] = [
  {
    poolAddress: "JubJubPool1111111111111111111111111111111111",
    tokenMint: "JubJubMint1111111111111111111111111111111111",
    pair: "JubJub/SOL",
    binStep: 20,
    baseFeePct: 0.2,
    selectionFingerprint: "fp1",
    walletCount: 15,
    tradeCount: 120,
    firstScannedAt: "2026-03-01T10:00:00Z",
    lastScannedAt: "2026-03-01T12:00:00Z",
  },
  {
    poolAddress: "IncognitoPoolSol1111111111111111111111111111",
    tokenMint: "IncognitoMint1111111111111111111111111111111",
    pair: "Incognito/SOL",
    binStep: 25,
    baseFeePct: 0.25,
    selectionFingerprint: "fp2",
    walletCount: 22,
    tradeCount: 210,
    firstScannedAt: "2026-03-01T09:00:00Z",
    lastScannedAt: "2026-03-01T14:00:00Z",
  },
  {
    poolAddress: "IncognitoPoolUsdc11111111111111111111111111",
    tokenMint: "IncognitoMint1111111111111111111111111111111",
    pair: "Incognito/USDC",
    binStep: 10,
    baseFeePct: 0.1,
    selectionFingerprint: "fp3",
    walletCount: 8,
    tradeCount: 45,
    firstScannedAt: "2026-03-01T08:00:00Z",
    lastScannedAt: "2026-03-01T11:00:00Z",
  },
  {
    poolAddress: "IncognitoPoolSol2222222222222222222222222222",
    tokenMint: "IncognitoMint1111111111111111111111111111111",
    pair: "Incognito/SOL",
    binStep: 50,
    baseFeePct: 0.5,
    selectionFingerprint: "fp4",
    walletCount: 5,
    tradeCount: 30,
    firstScannedAt: "2026-03-01T07:00:00Z",
    lastScannedAt: "2026-03-01T15:00:00Z",
  },
];

describe("Pool Explorer Search & Grouping Unit Tests", () => {
  const groups: TokenPoolGroup[] = groupPoolsByToken(MOCK_POOLS);

  it("groups pools by exact token mint and quote pair rules", () => {
    // JubJub/SOL -> 1 group with 1 pool
    // Incognito/SOL -> 1 group with 2 pools
    // Incognito/USDC -> 1 group with 1 pool
    assert.strictEqual(groups.length, 3);

    const jubjubGroup = groups.find((g) => g.tokenName === "JubJub/SOL");
    assert.ok(jubjubGroup);
    assert.strictEqual(jubjubGroup.pools.length, 1);

    const incognitoSolGroup = groups.find((g) => g.groupKey.endsWith(":SOL") && g.tokenMint === "IncognitoMint1111111111111111111111111111111");
    assert.ok(incognitoSolGroup);
    assert.strictEqual(incognitoSolGroup.pools.length, 2);

    const incognitoUsdcGroup = groups.find((g) => g.groupKey.endsWith(":INCOGNITO/USDC"));
    assert.ok(incognitoUsdcGroup);
    assert.strictEqual(incognitoUsdcGroup.pools.length, 1);
  });

  it("searching 'JubJub' finds JubJub/SOL group", () => {
    const results = filterTokenGroups(groups, "JubJub");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].tokenName, "JubJub/SOL");
  });

  it("searching 'Incognito' finds Incognito/SOL and Incognito/USDC groups", () => {
    const results = filterTokenGroups(groups, "Incognito");
    assert.strictEqual(results.length, 2);
    const names = results.map((r) => r.tokenName);
    assert.ok(names.includes("Incognito/SOL"));
    assert.ok(names.includes("Incognito/USDC"));
  });

  it("searching 'SOL' finds SOL-paired pool groups", () => {
    const results = filterTokenGroups(groups, "SOL");
    assert.strictEqual(results.length, 2);
    const names = results.map((r) => r.tokenName);
    assert.ok(names.includes("JubJub/SOL"));
    assert.ok(names.includes("Incognito/SOL"));
    assert.ok(!names.includes("Incognito/USDC"));
  });

  it("searches are case-insensitive", () => {
    const r1 = filterTokenGroups(groups, "jubjub");
    const r2 = filterTokenGroups(groups, "JUBJUB");
    const r3 = filterTokenGroups(groups, "JuBjUb");
    assert.strictEqual(r1.length, 1);
    assert.strictEqual(r2.length, 1);
    assert.strictEqual(r3.length, 1);
  });

  it("ignores surrounding whitespace in search query", () => {
    const results = filterTokenGroups(groups, "   JubJub   ");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].tokenName, "JubJub/SOL");
  });

  it("empty or whitespace-only search restores all pool groups", () => {
    const rEmpty = filterTokenGroups(groups, "");
    const rSpaces = filterTokenGroups(groups, "   ");
    assert.strictEqual(rEmpty.length, 3);
    assert.strictEqual(rSpaces.length, 3);
  });

  it("allows matching by token mint address", () => {
    const results = filterTokenGroups(groups, "JubJubMint1111111111111111111111111111111111");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].tokenName, "JubJub/SOL");
  });

  it("allows matching by pool address", () => {
    const results = filterTokenGroups(groups, "IncognitoPoolUsdc11111111111111111111111111");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].tokenName, "Incognito/USDC");
  });

  it("returns empty array for non-matching query", () => {
    const results = filterTokenGroups(groups, "NonExistentTokenXYZ");
    assert.strictEqual(results.length, 0);
  });
});

describe("Pool Explorer Search UI Integration Tests", () => {
  let server: http.Server;
  let serverPort: number;
  let baseUrl: string;
  let browser: Browser;

  before(async () => {
    if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
      throw new Error("frontend/dist/index.html not found. Run 'npm --prefix frontend run build' first.");
    }

    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };

    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");

      if (parsedUrl.pathname === "/api/pool-insight/pools") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            updatedAt: "2026-03-01T15:00:00Z",
            total: MOCK_POOLS.length,
            pools: MOCK_POOLS,
          })
        );
        return;
      }

      let filePath = path.join(DIST_DIR, parsedUrl.pathname);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_DIR, "index.html");
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || "text/plain";
      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        serverPort = addr.port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };

  async function createTestPage(viewport = { width: 1280, height: 800 }) {
    const page = await browser.newPage({ viewport });
    await page.route("**/api/pool-insight/**", async (route) => {
      const url = route.request().url();
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 200, headers: CORS_HEADERS });
        return;
      }
      if (url.includes("/api/pool-insight/pools/")) {
        const pool = MOCK_POOLS[0];
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({ pool }),
        });
        return;
      }
      if (url.includes("/api/pool-insight/pools")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            updatedAt: "2026-03-01T15:00:00Z",
            total: MOCK_POOLS.length,
            pools: MOCK_POOLS,
          }),
        });
        return;
      }
      await route.continue();
    });
    return page;
  }

  it("renders search input with placeholder and filters token groups by name", async () => {
    const page = await createTestPage({ width: 1280, height: 800 });
    await page.goto(`${baseUrl}/pools`, { waitUntil: "networkidle" });

    // Assert search input is visible with correct placeholder
    const searchInput = page.locator(".pool-search-input");
    await assert.doesNotReject(searchInput.waitFor({ state: "visible", timeout: 5000 }));
    const placeholder = await searchInput.getAttribute("placeholder");
    assert.strictEqual(placeholder, "Search pool name...");

    // Check initial group count display
    const toolbarLeft = page.locator(".pool-insight-table-toolbar-left");
    let countText = await toolbarLeft.innerText();
    assert.ok(countText.includes("3 Token Groups"));
    assert.ok(countText.includes("4 Scanned DLMM Pools"));

    // Type "JubJub"
    await searchInput.fill("JubJub");

    // Check count text updates without misrepresenting total pools
    countText = await toolbarLeft.innerText();
    assert.ok(countText.includes("1 of 3 Token Groups"));
    assert.ok(countText.includes("4 Scanned DLMM Pools"));

    // Verify visible rows
    const rows = page.locator(".token-group-row");
    assert.strictEqual(await rows.count(), 1);
    const rowText = await rows.first().innerText();
    assert.ok(rowText.includes("JubJub/SOL"));

    // Expand All / Collapse All works on filtered results
    const toggleAllBtn = page.locator(".token-group-toggle-all-btn");
    assert.strictEqual(await toggleAllBtn.innerText(), "Expand All");

    await toggleAllBtn.click();
    assert.strictEqual(await toggleAllBtn.innerText(), "Collapse All");
    const nestedPoolRows = page.locator(".token-pool-row");
    assert.strictEqual(await nestedPoolRows.count(), 1);

    await toggleAllBtn.click();
    assert.strictEqual(await toggleAllBtn.innerText(), "Expand All");
    assert.strictEqual(await nestedPoolRows.count(), 0);

    // Save desktop screenshot
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "search-ui-desktop.png"), fullPage: false });

    // Clear search using clear button (X)
    const clearBtn = page.locator(".pool-search-clear-btn");
    await clearBtn.click();
    assert.strictEqual(await searchInput.inputValue(), "");
    assert.strictEqual(await rows.count(), 3);

    // Filter by "Incognito" -> finds both Incognito/SOL and Incognito/USDC
    await searchInput.fill("Incognito");
    assert.strictEqual(await rows.count(), 2);
    const textAll = await page.locator(".token-groups-table").innerText();
    assert.ok(textAll.includes("Incognito/SOL"));
    assert.ok(textAll.includes("Incognito/USDC"));

    // Filter by non-existent token -> empty state with clear button
    await searchInput.fill("NoMatchingToken999");
    assert.strictEqual(await rows.count(), 0);

    const emptyState = page.locator(".pool-search-empty-state");
    await assert.doesNotReject(emptyState.waitFor({ state: "visible" }));
    const emptyText = await emptyState.innerText();
    assert.ok(emptyText.includes("No pools found matching your search."));
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "search-ui-empty-state.png"), fullPage: false });
    const resetBtn = page.locator(".pool-search-reset-btn");
    await resetBtn.click();
    assert.strictEqual(await searchInput.inputValue(), "");
    assert.strictEqual(await rows.count(), 3);

    await page.close();
  });

  it("clicking a filtered pool still navigates to pool intelligence", async () => {
    const page = await createTestPage({ width: 1280, height: 800 });
    await page.goto(`${baseUrl}/pools`, { waitUntil: "networkidle" });
    const searchInput = page.locator(".pool-search-input");
    await searchInput.fill("JubJub");
    // Expand the JubJub group
    const expandBtn = page.locator(".token-group-expand-btn").first();
    await expandBtn.click();

    // Click the pool row
    const poolRow = page.locator(".token-pool-row").first();
    await poolRow.click();

    // Verify URL contains intelligence tab and pool address
    await page.waitForURL(/tab=intelligence/);
    const url = page.url();
    assert.ok(url.includes("tab=intelligence"));
    assert.ok(url.includes("JubJubPool1111111111111111111111111111111111"));

    await page.close();
  });

  it("responsive layout on mobile with no horizontal overflow", async () => {
    const page = await createTestPage({ width: 375, height: 667 });
    await page.goto(`${baseUrl}/pools`, { waitUntil: "networkidle" });
    const searchInput = page.locator(".pool-search-input");
    await searchInput.waitFor({ state: "visible" });
    await searchInput.fill("JubJub");

    // Save mobile screenshot
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "search-ui-mobile.png"), fullPage: false });

    // Check table toolbar does not exceed viewport width
    const toolbar = page.locator(".pool-insight-table-toolbar");
    const isOverflowing = await toolbar.evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.strictEqual(isOverflowing, false, "Toolbar must not overflow horizontally on mobile");

    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.strictEqual(bodyOverflow, false, "Document must not overflow horizontally on mobile");

    await page.close();
  });
});
