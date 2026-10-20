import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type Browser } from "playwright";

const DIST_DIR = path.resolve(import.meta.dirname, "../../frontend/dist");
const VALID_WALLET_1 = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const VALID_WALLET_2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const VALID_POOL = "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8";
const VALID_POS = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";
const VALID_SIG = "5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h5K5h";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

describe("DLLM Alerts UI Smoke & Integration Test Suite", () => {
  let server: http.Server;
  let serverPort: number;
  let baseUrl: string;
  let browser: Browser;
  let tmpScreenshotsDir: string;

  before(async () => {
    if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
      throw new Error(`frontend/dist/index.html not found. Run 'npm --prefix frontend run build' first.`);
    }

    tmpScreenshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dllm-alerts-ui-"));

    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };

    const { promise, resolve } = Promise.withResolvers<void>();
    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
      let filePath = path.join(DIST_DIR, parsedUrl.pathname);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_DIR, "index.html");
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || "text/plain";
      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      serverPort = addr.port;
      baseUrl = `http://127.0.0.1:${serverPort}`;
      resolve();
    });
    await promise;

    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    try {
      fs.rmSync(tmpScreenshotsDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it("1. Desktop Viewport (1280x800): renders header, 4 tabs, evidence drawer, and Telegram previews", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 200, headers: CORS_HEADERS });
        return;
      }
      if (url.includes("/api/alerts/status")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            status: "RUNNING",
            isDegraded: false,
            sdkCompatible: true,
            monitoredWalletsCount: 2,
            activePositionsCount: 1,
            totalPolls: 24,
            totalEventsEmitted: 4,
            lastPollAt: Date.now() - 5000,
            lastSuccessfulPollAt: Date.now() - 5000,
            retryCount: 0,
            errorCount: 0,
            coverageGaps: [],
            bufferedEventsCount: 4,
            bufferedPreviewsCount: 4,
          }),
        });
      } else if (url.includes("/api/alerts/wallets")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            wallets: [
              { address: VALID_WALLET_1, alias: "Alpha Whale", enabled: true },
              { address: VALID_WALLET_2, alias: "Beta Treasury", enabled: false },
            ],
            totalCount: 2,
          }),
        });
      } else if (url.includes("/api/alerts/positions")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            positions: [
              {
                positionAddress: VALID_POS,
                owner: VALID_WALLET_1,
                poolAddress: VALID_POOL,
                version: "V2",
                hasLiquidity: true,
                discoveredAt: Date.now() - 3600000,
                lastUpdatedAt: Date.now() - 120000,
              },
            ],
            totalCount: 1,
          }),
        });
      } else if (url.includes("/api/alerts/events")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                id: `${VALID_SIG}:0:POSITION_OPENED`,
                eventType: "POSITION_OPENED",
                walletAddress: VALID_WALLET_1,
                positionAddress: VALID_POS,
                poolAddress: VALID_POOL,
                signature: VALID_SIG,
                slot: 289456123,
                blockTime: Math.floor(Date.now() / 1000) - 60,
                instructionIndex: 0,
                source: "top-level",
                signer: VALID_WALLET_1,
                feePayer: "ComputeBudget111111111111111111111111111111",
                operator: null,
                instructionName: "initialize_position2",
                detectedAt: Date.now() - 60000,
              },
            ],
            totalCount: 1,
          }),
        });
      } else if (url.includes("/api/alerts/previews")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            previews: [
              {
                id: `${VALID_SIG}:0:POSITION_OPENED`,
                eventId: `${VALID_SIG}:0:POSITION_OPENED`,
                eventType: "POSITION_OPENED",
                walletAddress: VALID_WALLET_1,
                walletAlias: "Alpha Whale",
                poolAddress: VALID_POOL,
                positionAddress: VALID_POS,
                walletRole: "owner (signer)",
                signature: VALID_SIG,
                slot: 289456123,
                blockTime: Math.floor(Date.now() / 1000) - 60,
                timestamp: new Date().toISOString(),
                commitment: "finalized",
                explorerUrl: `https://explorer.solana.com/tx/${VALID_SIG}`,
                amounts: null,
                messageText: `[DRY-RUN PREVIEW] DLMM Alert: POSITION_OPENED\nWallet: ${VALID_WALLET_1} (Alpha Whale)\nRole: owner (signer)\nPool: ${VALID_POOL}\nPosition: ${VALID_POS}\nSignature: ${VALID_SIG}\nStatus: Finalized (Slot 289456123)\nExplorer: https://explorer.solana.com/tx/${VALID_SIG}`,
                status: "PREVIEW_ONLY",
                generatedAt: Date.now() - 60000,
              },
            ],
            totalCount: 1,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({ status: "IDLE", running: false }),
        });
      }
    });

    await page.goto(`${baseUrl}/alerts`, { waitUntil: "networkidle" });

    // 1. Verify Header & Status
    const titleText = await page.textContent(".alerts-title");
    assert.match(titleText || "", /Alerts & Active Positions/, "Header must show Alerts & Active Positions");

    assert.ok(await page.isVisible("text=Last Successful Poll:"), "Last Successful Poll label must be visible");
    const walletFilterText = await page.locator(".alerts-filters-left select").first().textContent();
    assert.match(walletFilterText || "", /All Monitored Wallets \(2 wallets\)/, "Wallet filter must present wallet count, not position count");

    // 2. Default View: Active Positions
    await page.waitForSelector(".alerts-pos-card", { timeout: 3000 });
    assert.ok(await page.isVisible(`text=${VALID_POS.slice(0, 4)}`), "Active position address must be visible");
    assert.ok(await page.isVisible("text=V2"), "Position version V2 must be visible");
    assert.ok(await page.locator(".alerts-pos-card").locator("text=Alpha Whale").isVisible(), "Wallet alias must be visible on position card");
    assert.ok(await page.isVisible("text=DLMM SDK v2 (Compatible)"), "Protocol compatibility indicator must be visible");
    assert.ok(await page.locator(".alerts-pos-card .alerts-pos-primary-pool").isVisible(), "Primary pool address container must be prominent");
    assert.ok(await page.locator(".alerts-pos-card a:has-text('Inspect Pool')").isVisible(), "Inspect Pool action must be preserved");
    assert.ok(await page.locator(".alerts-pos-card a:has-text('Explorer')").isVisible(), "Explorer action must be preserved");

    // Check no horizontal overflow on desktop
    const desktopPageScrollWidth = await page.evaluate(() => {
      const el = document.querySelector(".alerts-page");
      return el ? el.scrollWidth <= el.clientWidth + 2 : true;
    });
    assert.strictEqual(desktopPageScrollWidth, true, "Desktop alerts-page must not have container overflow");
    const desktopPosScreenshot = path.join(tmpScreenshotsDir, "desktop-positions.png");
    await page.screenshot({ path: desktopPosScreenshot, fullPage: true });
    try { fs.copyFileSync(desktopPosScreenshot, "/tmp/dllm-alerts-desktop-positions.png"); } catch {}

    // 3. Tab: Watched Wallets
    await page.locator(".alerts-tab:has-text('Wallet Watchlist')").click();
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".alerts-table").locator("text=Alpha Whale").isVisible(), "Wallet alias must be visible");
    assert.ok(await page.isVisible("text=Config: Enabled"), "Config: Enabled status must be visible");
    assert.ok(await page.isVisible("text=Config: Disabled"), "Config: Disabled status must be visible");
    assert.ok(await page.isVisible("text=Actively Monitored"), "Actively Monitored runtime state must be visible");
    // 4. Tab 3: Recent Activity & Evidence Drawer
    await page.locator(".alerts-tab:has-text('Recent Activity')").click();
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".alerts-badge:has-text('POSITION_OPENED')").isVisible(), "POSITION_OPENED badge must be visible");

    // Click "Details" button to open modal drawer
    const detailsBtn = page.locator("button:has-text('Details')").first();
    assert.ok(await detailsBtn.isVisible(), "Details evidence button must be visible");
    await detailsBtn.click();
    await page.waitForTimeout(300);

    // Verify modal content
    assert.ok(await page.isVisible("text=DLMM Event Evidence"), "Evidence modal title must be visible");
    assert.ok(await page.isVisible("text=Fee payer never used to infer ownership"), "Fee payer note must be visible");
    assert.ok(await page.isVisible(`text=${VALID_SIG.slice(0, 8)}`), "Signature must be visible in modal");

    // Close modal
    const closeBtn = page.locator(".alerts-modal button:has-text('Close'), .alerts-modal button[aria-label='Close']").first();
    await closeBtn.click();
    await page.waitForTimeout(200);

    // 5. Tab 4: Telegram Previews
    await page.locator(".alerts-tab:has-text('Telegram')").click();
    await page.waitForTimeout(300);
    assert.ok(await page.isVisible("text=PREVIEW ONLY / NOT SENT"), "PREVIEW ONLY badge must be visible");
    assert.ok(await page.isVisible("text=[DRY-RUN PREVIEW]"), "Dry-run message text must be visible");
    // Save desktop screenshot
    const desktopScreenshotPath = path.join(tmpScreenshotsDir, "desktop-alerts.png");
    await page.screenshot({ path: desktopScreenshotPath, fullPage: true });
    assert.ok(fs.existsSync(desktopScreenshotPath), "Desktop screenshot must be saved successfully");
    try { fs.copyFileSync(desktopScreenshotPath, "/tmp/dllm-alerts-desktop.png"); } catch {}

    await page.close();
  });

  it("2. Mobile Viewport (375x812): content renders with horizontal table scroll wrappers and readable controls", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });

    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 200, headers: CORS_HEADERS });
        return;
      }
      if (url.includes("/api/alerts/status")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            status: "RUNNING",
            isDegraded: false,
            sdkCompatible: true,
            monitoredWalletsCount: 1,
            activePositionsCount: 0,
            totalPolls: 5,
            totalEventsEmitted: 0,
            lastPollAt: Date.now(),
            retryCount: 0,
            errorCount: 0,
            coverageGaps: [],
            bufferedEventsCount: 0,
            bufferedPreviewsCount: 0,
          }),
        });
      } else if (url.includes("/api/alerts/wallets")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            wallets: [{ address: VALID_WALLET_1, alias: "Mobile Tester", enabled: true }],
            totalCount: 1,
          }),
        });
      } else if (url.includes("/api/alerts/positions")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            positions: [
              {
                positionAddress: VALID_POS,
                owner: VALID_WALLET_1,
                poolAddress: VALID_POOL,
                version: "V2",
                hasLiquidity: true,
                discoveredAt: Date.now() - 3600000,
                lastUpdatedAt: Date.now() - 120000,
              },
            ],
            totalCount: 1,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({ events: [], previews: [], totalCount: 0 }),
        });
      }
    });

    await page.goto(`${baseUrl}/alerts`, { waitUntil: "networkidle" });

    assert.ok(await page.isVisible(".alerts-title"), "Title must be visible on mobile");
    // Check no horizontal overflow on mobile at 375px
    const mobilePageScrollWidth = await page.evaluate(() => {
      const el = document.querySelector(".alerts-page");
      return el ? el.scrollWidth <= el.clientWidth + 2 : true;
    });
    assert.strictEqual(mobilePageScrollWidth, true, "Mobile alerts-page must not have container overflow at 375px");
    const mobilePosScreenshot = path.join(tmpScreenshotsDir, "mobile-positions.png");
    await page.screenshot({ path: mobilePosScreenshot, fullPage: true });
    try { fs.copyFileSync(mobilePosScreenshot, "/tmp/dllm-alerts-mobile-positions.png"); } catch {}


    // Switch to Wallet Watchlist tab
    await page.locator(".alerts-tab:has-text('Wallet Watchlist')").click();
    await page.waitForTimeout(300);

    assert.ok(await page.locator(".alerts-table").locator("text=Mobile Tester").isVisible(), "Wallet alias must be visible on mobile");

    const hasTableScrollWrapper = await page.evaluate(() => {
      const scrollWrap = document.querySelector(".alerts-table-container");
      return !!scrollWrap && window.getComputedStyle(scrollWrap).overflowX === "auto";
    });
    assert.strictEqual(hasTableScrollWrapper, true, "Alerts tables must be wrapped in overflow-x: auto container");

    const mobileScreenshotPath = path.join(tmpScreenshotsDir, "mobile-alerts.png");
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true });
    assert.ok(fs.existsSync(mobileScreenshotPath), "Mobile screenshot must be saved successfully");
    try { fs.copyFileSync(mobileScreenshotPath, "/tmp/dllm-alerts-mobile.png"); } catch {}

    await page.close();
  });

  it("3. State Banners: correctly renders Degraded, Paused, and Offline / Error states", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // 1. Degraded State with Coverage Notice
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 200, headers: CORS_HEADERS });
        return;
      }
      if (url.includes("/api/alerts/status")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({
            status: "DEGRADED",
            isDegraded: true,
            sdkCompatible: true,
            monitoredWalletsCount: 1,
            activePositionsCount: 0,
            totalPolls: 10,
            totalEventsEmitted: 0,
            lastPollAt: Date.now(),
            retryCount: 3,
            errorCount: 1,
            coverageGaps: [
              {
                walletAddress: VALID_WALLET_1,
                reason: "RPC rate limited on getSignaturesForAddress",
                timestamp: Date.now(),
              },
            ],
            bufferedEventsCount: 0,
            bufferedPreviewsCount: 0,
          }),
        });
      } else if (url.includes("/api/alerts/wallets")) {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({ wallets: [], totalCount: 0 }),
        });
      } else {
        await route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "application/json",
          body: JSON.stringify({ positions: [], events: [], previews: [], totalCount: 0 }),
        });
      }
    });

    await page.goto(`${baseUrl}/alerts`, { waitUntil: "networkidle" });
    assert.ok(await page.isVisible("text=Monitoring Coverage Notice"), "Degraded coverage notice banner must be visible");
    assert.ok(await page.isVisible("text=RPC rate limited"), "Coverage gap reason must be visible in degraded banner");

    // 2. Offline / Server Error State
    await page.route("**/api/alerts/status", async (route) => {
      await route.fulfill({
        status: 503,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({ error: "Service Unavailable" }),
      });
    });

    // Trigger refresh
    const refreshBtn = page.locator("button:has-text('Refresh')").first();
    await refreshBtn.click();
    await page.waitForTimeout(500);

    const isOfflineBannerVisible = await page.isVisible(".alerts-banner-error");
    assert.strictEqual(isOfflineBannerVisible, true, "Offline error banner must appear when backend status fails");

    // 3. Paused State: RPC Health displays 'Monitoring Paused', not '100% Operational', and last sync timestamp is visible
    await page.route("**/api/alerts/status", async (route) => {
      await route.fulfill({
        status: 200,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({
          status: "PAUSED",
          isDegraded: false,
          sdkCompatible: true,
          monitoredWalletsCount: 0,
          activePositionsCount: 0,
          totalPolls: 15,
          totalEventsEmitted: 0,
          lastPollAt: Date.now() - 30000,
          lastSuccessfulPollAt: Date.now() - 30000,
          retryCount: 0,
          errorCount: 0,
          rpcErrorCount: 0,
          http429Count: 0,
          coverageGaps: [],
          bufferedEventsCount: 0,
          bufferedPreviewsCount: 0,
        }),
      });
    });

    await page.locator("button:has-text('Refresh')").first().click();
    await page.waitForTimeout(500);

    assert.ok(await page.isVisible("text=Monitoring Paused"), "PAUSED status must display Monitoring Paused");
    assert.strictEqual(await page.isVisible("text=100% Operational"), false, "PAUSED status must not display 100% Operational");
    assert.ok(await page.isVisible("text=Last sync:"), "Last successful sync timestamp must be visible when paused");

    // 4. Stale Polling State: RUNNING with stale lastSuccessfulPollAt shows STALE warning banner, badge, and RPC state
    await page.route("**/api/alerts/status", async (route) => {
      await route.fulfill({
        status: 200,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({
          status: "RUNNING",
          isDegraded: false,
          sdkCompatible: true,
          monitoredWalletsCount: 2,
          activePositionsCount: 1,
          totalPolls: 30,
          totalEventsEmitted: 4,
          configuredPollIntervalMs: 5000,
          lastPollAt: Date.now() - 45000,
          lastSuccessfulPollAt: Date.now() - 45000,
          retryCount: 0,
          errorCount: 0,
          rpcErrorCount: 0,
          http429Count: 0,
          totalPollsSuccessful: 29,
          coverageGaps: [],
          bufferedEventsCount: 0,
          bufferedPreviewsCount: 0,
        }),
      });
    });

    await page.locator("button:has-text('Refresh')").first().click();
    await page.waitForTimeout(500);

    assert.ok(await page.isVisible("text=Monitoring Freshness Warning:"), "Stale polling warning banner must appear");
    assert.ok(await page.isVisible(".alerts-stale-tag:has-text('STALE')"), "STALE badge must appear in telemetry strip");
    assert.ok(await page.isVisible("text=Stale Polling"), "RPC Health card must display Stale Polling instead of 100% Operational");
    assert.strictEqual(await page.isVisible("text=100% Operational"), false, "100% Operational must not be shown when stale");

    // 5. RUNNING with lastSuccessfulPollAt=null and non-null lastPollAt displays 'Awaiting First Successful Poll'
    await page.route("**/api/alerts/status", async (route) => {
      await route.fulfill({
        status: 200,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({
          status: "RUNNING",
          isDegraded: false,
          sdkCompatible: true,
          monitoredWalletsCount: 2,
          activePositionsCount: 1,
          totalPolls: 5,
          totalPollsAttempted: 5,
          totalPollsFailed: 5,
          totalEventsEmitted: 0,
          configuredPollIntervalMs: 5000,
          lastPollAt: Date.now() - 2000,
          lastSuccessfulPollAt: null,
          retryCount: 3,
          errorCount: 5,
          rpcErrorCount: 0,
          http429Count: 0,
          totalPollsSuccessful: 0,
          coverageGaps: [],
          bufferedEventsCount: 0,
          bufferedPreviewsCount: 0,
        }),
      });
    });

    await page.locator("button:has-text('Refresh')").first().click();
    await page.waitForTimeout(500);

    assert.ok(await page.isVisible("text=Awaiting First Successful Poll"), "Telemetry strip must display 'Awaiting First Successful Poll'");
    const stripValueText = await page.locator(".alerts-strip-value").nth(1).textContent();
    assert.strictEqual(stripValueText?.trim(), "Awaiting First Successful Poll", "Strip value must be exactly Awaiting First Successful Poll");

    const awaitingScreenshotPath = path.join(tmpScreenshotsDir, "desktop-awaiting-first-poll.png");
    await page.screenshot({ path: awaitingScreenshotPath, fullPage: true });
    try { fs.copyFileSync(awaitingScreenshotPath, "/tmp/dllm-alerts-desktop-awaiting-first-poll.png"); } catch {}

    await page.close();
  });
});
