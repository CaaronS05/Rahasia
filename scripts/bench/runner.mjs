/**
 * LP Agent Performance Benchmark Runner.
 * Executes Mode A, Mode B, and Mode C under controlled conditions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { RateLimiter } from "./rate-limiter.mjs";
import { MetricsCollector } from "./metrics.mjs";
import { processPoolPages, samplePageMemoryMb } from "./worker.mjs";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const DEFAULT_CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const BENCH_RESULTS_DIR = path.resolve(ROOT, "data/bench/results");

// Target pools: 1 SOL and 1 USDC pool for HOOKED
const TARGET_POOLS = [
  {
    poolAddress: "FtiotJckV2ZG4S1YgJDJLiXKKDAnKWXgQxo7vxsjPwPe",
    pair: "HOOKED/SOL",
    label: "SOL Pool",
  },
  {
    poolAddress: "975Nkfi5CV2PYjW61BbTpSodauUdxgHFinLHMyHNjNcZ",
    pair: "HOOKED/USDC",
    label: "USDC Pool",
  },
];

export function sampleBraveMemoryMb() {
  try {
    const lines = execSync(
      "ps -A -o pid,rss,command | grep fabriq-playwright-profile | grep -v grep",
      { timeout: 1500 }
    ).toString().trim().split("\n");
    let totalRssKb = 0;
    for (const line of lines) {
      const match = line.trim().match(/^\d+\s+(\d+)/);
      if (match) totalRssKb += parseInt(match[1], 10);
    }
    return Number((totalRssKb / 1024).toFixed(2));
  } catch {
    return 0;
  }
}

export function sampleCloakMemoryMb() {
  try {
    const lines = execSync(
      "ps -A -o pid,rss,command | grep -E \"cloakbrowser|data/bench/cloak-profile\" | grep -v grep",
      { timeout: 1500 }
    ).toString().trim().split("\n");
    let totalRssKb = 0;
    for (const line of lines) {
      const match = line.trim().match(/^\d+\s+(\d+)/);
      if (match) totalRssKb += parseInt(match[1], 10);
    }
    return Number((totalRssKb / 1024).toFixed(2));
  } catch {
    return 0;
  }
}

export async function getCloakBrowserModule() {
  try {
    return await import("cloakbrowser");
  } catch {
    const isolatedPath = path.resolve(ROOT, "data/bench/cloak-env/node_modules/cloakbrowser/dist/index.js");
    try {
      return await import(pathToFileURL(isolatedPath).href);
    } catch {
      return null;
    }
  }
}

export async function checkCloakBrowserReadiness() {
  let isInstalled = false;
  let pkgVersion = null;
  let hasSession = false;
  let details = [];

  const cloak = await getCloakBrowserModule();
  if (!cloak) {
    details.push("cloakbrowser package is not found in root or isolated bench environment.");
    return {
      isInstalled: false,
      pkgVersion: null,
      hasSession: false,
      ready: false,
      reasons: details,
    };
  }

  try {
    const info = cloak.binaryInfo ? cloak.binaryInfo() : null;
    isInstalled = Boolean(info?.installed);
    pkgVersion = info?.version || "installed";
  } catch {
    isInstalled = true;
    pkgVersion = "installed";
  }

  const profileDir = path.resolve(ROOT, "data/bench/cloak-profile");
  try {
    const stat = await fs.stat(profileDir);
    hasSession = stat.isDirectory();
  } catch {
    hasSession = false;
  }

  if (isInstalled) {
    details.push(`CloakBrowser package and binary ready (version: ${pkgVersion}).`);
    details.push(`Isolated profile directory: ${profileDir}`);
  } else {
    details.push("CloakBrowser binary not yet installed.");
  }

  return {
    isInstalled,
    pkgVersion,
    hasSession,
    ready: isInstalled,
    reasons: details,
  };
}

export async function runModeA({
  cdpUrl = DEFAULT_CDP_URL,
  pools = TARGET_POOLS,
  pageBudget = 4,
  minPageDelay = 350,
  maxPageDelay = 800,
  runIndex = 1,
} = {}) {
  const metrics = new MetricsCollector({
    mode: "Mode A (Brave 1 Tab)",
    scenario: `Run ${runIndex}`,
  });

  metrics.startSetup();
  console.log(`\n[Mode A - Run ${runIndex}] Connecting to Brave CDP at ${cdpUrl}...`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context found in Brave CDP session");
  }

  let page = context.pages().find((p) => !p.isClosed() && p.url().includes("app.lpagent.io"));
  if (!page) {
    page = await context.newPage();
    await page.goto(`https://app.lpagent.io/pools/${pools[0].poolAddress}?tab=top`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
  const initialMem = await samplePageMemoryMb(page);
  if (initialMem !== null) metrics.recordMemoryUsage(initialMem);
  metrics.endSetup();

  const rateLimiter = new RateLimiter({ maxInFlight: 1, minIntervalMs: 250 });

  console.log(`[Mode A - Run ${runIndex}] Starting sequential extraction across ${pools.length} pools...`);
  metrics.startExtraction();

  try {
    for (const pool of pools) {
      console.log(`  -> Processing ${pool.pair} (${pool.poolAddress}) [budget: ${pageBudget} pages]`);
      await processPoolPages({
        workerId: "Brave-Worker-1",
        page,
        poolAddress: pool.poolAddress,
        startPage: 1,
        pageBudget,
        rateLimiter,
        metricsCollector: metrics,
        minPageDelay,
        maxPageDelay,
      });
    }
  } finally {
    metrics.endExtraction();
    rateLimiter.destroy();
    await browser.close();
  }

  return metrics.getSummary();
}

export async function runModeB({
  cdpUrl = DEFAULT_CDP_URL,
  pools = TARGET_POOLS,
  pageBudget = 4,
  minPageDelay = 350,
  maxPageDelay = 800,
  runIndex = 1,
} = {}) {
  const metrics = new MetricsCollector({
    mode: "Mode B (Brave 2 Tabs)",
    scenario: `Run ${runIndex}`,
  });

  metrics.startSetup();
  console.log(`\n[Mode B - Run ${runIndex}] Connecting to Brave CDP at ${cdpUrl}...`);
  const tConnectStart = performance.now();
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context found in Brave CDP session");
  }
  const startupSec = (performance.now() - tConnectStart) / 1000;
  metrics.recordStartupDuration(startupSec);

  // Create 2 benchmark-owned pages (do NOT touch existing user pages)
  console.log(`[Mode B - Run ${runIndex}] Opening 2 benchmark-owned tabs in Brave context...`);
  const tAuthStart = performance.now();
  const page1 = await context.newPage();
  const page2 = await context.newPage();

  // Navigate both pages to their respective pools
  await Promise.all([
    page1.goto(`https://app.lpagent.io/pools/${pools[0].poolAddress}?tab=top`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }),
    page2.goto(`https://app.lpagent.io/pools/${pools[1].poolAddress}?tab=top`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }),
  ]);
  const authSec = (performance.now() - tAuthStart) / 1000;
  metrics.recordAuthReadiness(authSec);

  // Sample process memory and heap
  metrics.recordBrowserProcessMemory(sampleBraveMemoryMb());
  const mem1 = await samplePageMemoryMb(page1);
  const mem2 = await samplePageMemoryMb(page2);
  metrics.recordBrowserHeap((mem1 || 0) + (mem2 || 0));
  metrics.endSetup();

  // Shared global rate limiter: maxInFlight 2, minIntervalMs 250
  const rateLimiter = new RateLimiter({ maxInFlight: 2, minIntervalMs: 250 });

  console.log(`[Mode B - Run ${runIndex}] Starting concurrent extraction across 2 tabs...`);
  metrics.startExtraction();

  try {
    const worker1 = processPoolPages({
      workerId: "Brave-Tab-1",
      page: page1,
      poolAddress: pools[0].poolAddress,
      startPage: 1,
      pageBudget,
      rateLimiter,
      metricsCollector: metrics,
      minPageDelay,
      maxPageDelay,
      sampleProcessMemory: sampleBraveMemoryMb,
    });

    const worker2 = processPoolPages({
      workerId: "Brave-Tab-2",
      page: page2,
      poolAddress: pools[1].poolAddress,
      startPage: 1,
      pageBudget,
      rateLimiter,
      metricsCollector: metrics,
      minPageDelay,
      maxPageDelay,
      sampleProcessMemory: sampleBraveMemoryMb,
    });

    await Promise.all([worker1, worker2]);
  } finally {
    metrics.endExtraction();
    rateLimiter.destroy();
    // Cleanly close both benchmark-owned tabs, leaving existing user tab intact
    try {
      await page1.close();
    } catch {}
    try {
      await page2.close();
    } catch {}
    await browser.close();
  }

  return metrics.getSummary();
}

export async function runModeD({
  pools = TARGET_POOLS,
  pageBudget = 4,
  minPageDelay = 350,
  maxPageDelay = 800,
  runIndex = 1,
} = {}) {
  const readiness = await checkCloakBrowserReadiness();
  if (!readiness.ready) {
    return {
      mode: "Mode D (CloakBrowser 2 Tabs)",
      scenario: `Run ${runIndex}`,
      status: "SKIPPED_NOT_CONFIGURED",
      reasons: readiness.reasons,
      summary: null,
    };
  }

  const cloak = await getCloakBrowserModule();
  if (!cloak) {
    throw new Error("CloakBrowser module failed to load");
  }

  const metrics = new MetricsCollector({
    mode: "Mode D (CloakBrowser 2 Tabs)",
    scenario: `Run ${runIndex}`,
  });

  metrics.startSetup();
  console.log(`\n[Mode D - Run ${runIndex}] Launching single CloakBrowser process with persistent context...`);
  const profileDir = path.resolve(ROOT, "data/bench/cloak-profile");
  const tStartupStart = performance.now();
  const cloakContext = await cloak.launchPersistentContext({
    userDataDir: profileDir,
    headless: false,
  });
  const startupSec = (performance.now() - tStartupStart) / 1000;
  metrics.recordStartupDuration(startupSec);

  console.log(`[Mode D - Run ${runIndex}] Setting up 2 benchmark pages in CloakBrowser...`);
  const tAuthStart = performance.now();
  const existingPages = cloakContext.pages().filter((p) => !p.isClosed());
  const page1 = existingPages[0] || (await cloakContext.newPage());
  const page2 = await cloakContext.newPage();

  // Navigate both pages to their respective pools in the same persistent context
  await Promise.all([
    page1.goto(`https://app.lpagent.io/pools/${pools[0].poolAddress}?tab=top`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }),
    page2.goto(`https://app.lpagent.io/pools/${pools[1].poolAddress}?tab=top`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }),
  ]);
  const authSec = (performance.now() - tAuthStart) / 1000;
  metrics.recordAuthReadiness(authSec);

  // Sample process memory and heap
  metrics.recordBrowserProcessMemory(sampleCloakMemoryMb());
  const mem1 = await samplePageMemoryMb(page1);
  const mem2 = await samplePageMemoryMb(page2);
  metrics.recordBrowserHeap((mem1 || 0) + (mem2 || 0));
  metrics.endSetup();

  // Shared global rate limiter: maxInFlight 2, minIntervalMs 250
  const rateLimiter = new RateLimiter({ maxInFlight: 2, minIntervalMs: 250 });

  console.log(`[Mode D - Run ${runIndex}] Starting concurrent extraction across 2 CloakBrowser tabs...`);
  metrics.startExtraction();

  try {
    const worker1 = processPoolPages({
      workerId: "Cloak-Tab-1",
      page: page1,
      poolAddress: pools[0].poolAddress,
      startPage: 1,
      pageBudget,
      rateLimiter,
      metricsCollector: metrics,
      minPageDelay,
      maxPageDelay,
      sampleProcessMemory: sampleCloakMemoryMb,
    });

    const worker2 = processPoolPages({
      workerId: "Cloak-Tab-2",
      page: page2,
      poolAddress: pools[1].poolAddress,
      startPage: 1,
      pageBudget,
      rateLimiter,
      metricsCollector: metrics,
      minPageDelay,
      maxPageDelay,
      sampleProcessMemory: sampleCloakMemoryMb,
    });

    await Promise.all([worker1, worker2]);
  } finally {
    metrics.endExtraction();
    rateLimiter.destroy();
    try {
      await page1.close();
    } catch {}
    try {
      await page2.close();
    } catch {}
    try {
      await cloakContext.close();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return metrics.getSummary();
}

export async function runModeC({
  braveCdpUrl = DEFAULT_CDP_URL,
  pools = TARGET_POOLS,
  pageBudget = 4,
  minPageDelay = 350,
  maxPageDelay = 800,
  runIndex = 1,
} = {}) {
  const readiness = await checkCloakBrowserReadiness();
  if (!readiness.ready) {
    return {
      mode: "Mode C (Brave + Cloak)",
      scenario: `Run ${runIndex}`,
      status: "SKIPPED_NOT_CONFIGURED",
      reasons: readiness.reasons,
      summary: null,
    };
  }

  const cloak = await getCloakBrowserModule();
  if (!cloak) {
    throw new Error("CloakBrowser module failed to load");
  }

  const metrics = new MetricsCollector({
    mode: "Mode C (Brave + Cloak)",
    scenario: `Run ${runIndex}`,
  });

  metrics.startSetup();
  console.log(`\n[Mode C - Run ${runIndex}] Connecting to Brave CDP at ${braveCdpUrl}...`);
  const braveBrowser = await chromium.connectOverCDP(braveCdpUrl);
  const braveContext = braveBrowser.contexts()[0];
  if (!braveContext) {
    throw new Error("No browser context found in Brave CDP session");
  }

  let bravePage = braveContext.pages().find((p) => !p.isClosed() && p.url().includes("app.lpagent.io"));
  if (!bravePage) {
    bravePage = await braveContext.newPage();
    await bravePage.goto(`https://app.lpagent.io/pools/${pools[0].poolAddress}?tab=top`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }

  console.log(`[Mode C - Run ${runIndex}] Launching CloakBrowser in isolated profile...`);
  const profileDir = path.resolve(ROOT, "data/bench/cloak-profile");
  const cloakContext = await cloak.launchPersistentContext({
    userDataDir: profileDir,
    headless: false,
  });

  let cloakPage = cloakContext.pages().find((p) => !p.isClosed() && p.url().includes("app.lpagent.io"));
  if (!cloakPage) {
    cloakPage = await cloakContext.newPage();
  }
  await cloakPage.goto(`https://app.lpagent.io/pools/${pools[1].poolAddress}?tab=top`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const memBrave = await samplePageMemoryMb(bravePage);
  const memCloak = await samplePageMemoryMb(cloakPage);
  metrics.recordMemoryUsage((memBrave || 0) + (memCloak || 0));
  metrics.endSetup();

  // Shared global rate limiter: maxInFlight 2, minIntervalMs 250
  const rateLimiter = new RateLimiter({ maxInFlight: 2, minIntervalMs: 250 });

  console.log(`[Mode C - Run ${runIndex}] Starting concurrent extraction across Brave & CloakBrowser...`);
  metrics.startExtraction();

  try {
    const worker1 = processPoolPages({
      workerId: "Brave-Worker-1",
      page: bravePage,
      poolAddress: pools[0].poolAddress,
      startPage: 1,
      pageBudget,
      rateLimiter,
      metricsCollector: metrics,
      minPageDelay,
      maxPageDelay,
    });

    const worker2 = processPoolPages({
      workerId: "Cloak-Worker-2",
      page: cloakPage,
      poolAddress: pools[1].poolAddress,
      startPage: 1,
      pageBudget,
      rateLimiter,
      metricsCollector: metrics,
      minPageDelay,
      maxPageDelay,
    });

    await Promise.all([worker1, worker2]);
  } finally {
    metrics.endExtraction();
    rateLimiter.destroy();
    try {
      await cloakContext.close();
    } catch {}
    await braveBrowser.close();
  }

  return metrics.getSummary();
}

export async function saveBenchmarkResults(results) {
  await fs.mkdir(BENCH_RESULTS_DIR, { recursive: true });
  const filename = `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(BENCH_RESULTS_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(results, null, 2), "utf8");
  return filePath;
}
