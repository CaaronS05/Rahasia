import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { discoverTokenPools } from "./discover-token-pools.mjs";
import { RateLimiter } from "../bench/rate-limiter.mjs";
import {
  DEFAULT_CDP_PORT,
  FORBIDDEN_PORT,
  checkCdpEndpoint,
} from "../browser/launch-cloak.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

export const DEFAULT_CLOAK_CDP_URL = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
export const DEFAULT_BRAVE_CDP_URL = `http://127.0.0.1:${FORBIDDEN_PORT}`;

export const MIN_PAGE_DELAY = 350;
export const MAX_PAGE_DELAY = 800;
export const MIN_POOL_DELAY = 2000;
export const MAX_POOL_DELAY = 4500;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(min, max) {
  if (min >= max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let tokenCA = null;
  let refresh = false;
  let workers = 1;
  let browserType = "cloak";
  let cdpUrl = null;
  const pools = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--token") {
      tokenCA = argv[i + 1]?.trim() ?? null;
      i++;
    } else if (arg === "--pool") {
      const p = argv[i + 1]?.trim();
      if (p) pools.push(p);
      i++;
    } else if (arg === "--refresh") {
      refresh = true;
    } else if (arg === "--workers" || arg === "-w") {
      const val = argv[i + 1]?.trim();
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 2 || String(parsed) !== val) {
        throw new Error(
          `Invalid workers count "${val}". Only 1 or 2 workers are supported.`
        );
      }
      workers = parsed;
      i++;
    } else if (arg === "--browser") {
      const val = argv[i + 1]?.trim().toLowerCase();
      if (val !== "cloak" && val !== "brave") {
        throw new Error(
          `Invalid browser type "${val}". Only "cloak" or "brave" are supported.`
        );
      }
      browserType = val;
      i++;
    } else if (arg === "--cdp-url") {
      cdpUrl = argv[i + 1]?.trim() ?? null;
      i++;
    }
  }

  if (!tokenCA && process.env.TOKEN_CA) {
    tokenCA = process.env.TOKEN_CA.trim();
  }

  // Fall back to env var for CDP_URL if not explicitly passed
  if (!cdpUrl && process.env.CDP_URL) {
    cdpUrl = process.env.CDP_URL.trim();
  }

  if (browserType === "cloak") {
    const target = cdpUrl || process.env.CLOAK_CDP_URL || DEFAULT_CLOAK_CDP_URL;
    try {
      const u = new URL(target);
      if (Number(u.port) === FORBIDDEN_PORT) {
        throw new Error(
          `Security violation: Refusing to connect to Brave CDP port ${FORBIDDEN_PORT} when browser is set to 'cloak'. Set '--browser brave' if Brave is intended.`
        );
      }
    } catch (err) {
      if (err.message.includes("Security violation")) throw err;
    }
  }

  return { tokenCA, pools, refresh, workers, browserType, cdpUrl };
}

export function computeSelectionFingerprint(tokenMint, poolAddresses) {
  const sorted = [...new Set(poolAddresses)].sort();
  return createHash("sha256")
    .update(`${tokenMint}:${sorted.join(",")}`)
    .digest("hex");
}

export async function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export function getGlobalWallets(completedPoolsMap) {
  const set = new Set();
  for (const p of completedPoolsMap.values()) {
    if (Array.isArray(p.wallets)) {
      for (const w of p.wallets) {
        if (typeof w?.wallet === "string" && w.wallet.trim()) {
          set.add(w.wallet.trim());
        }
      }
    }
  }
  return Array.from(set).sort();
}

export class CheckpointWriter {
  constructor() {
    this._chain = Promise.resolve();
  }

  async write(fn) {
    const next = this._chain.then(() => fn());
    this._chain = next.catch(() => {});
    return next;
  }
}

export async function saveCheckpoints({
  outputDir,
  tokenCA,
  fingerprint,
  selectedPools,
  completedPoolsMap,
  status = "in_progress",
  startedAt,
  error = null,
}) {
  // Deterministic ordering: follow selectedPools array order
  const completedList = selectedPools
    .filter((p) => completedPoolsMap.has(p.poolAddress))
    .map((p) => completedPoolsMap.get(p.poolAddress));
  const globalWallets = getGlobalWallets(completedPoolsMap);
  const completedAddresses = completedList.map((p) => p.poolAddress);
  const isAllComplete = status !== "error" && completedAddresses.length === selectedPools.length;

  const poolWalletsData = {
    version: "v1",
    tokenMint: tokenCA,
    updatedAt: new Date().toISOString(),
    pools: completedList,
  };
  await atomicWriteJson(path.join(outputDir, "pool-wallets.json"), poolWalletsData);

  await atomicWriteJson(path.join(outputDir, "wallets.json"), globalWallets);

  const scanStateData = {
    version: "v1",
    tokenMint: tokenCA,
    selectionFingerprint: fingerprint,
    status: isAllComplete ? "completed" : status,
    selectedPoolCount: selectedPools.length,
    completedPoolCount: completedAddresses.length,
    pendingPoolCount: selectedPools.length - completedAddresses.length,
    selectedPoolAddresses: selectedPools.map((p) => p.poolAddress),
    completedPoolAddresses: completedAddresses,
    startedAt,
    updatedAt: new Date().toISOString(),
    ...(isAllComplete ? { completedAt: new Date().toISOString() } : {}),
    ...(error ? { error } : {}),
  };
  await atomicWriteJson(path.join(outputDir, "scan-state.json"), scanStateData);
}

export async function validateAndReconcileCheckpoints({
  outputDir,
  tokenCA,
  fingerprint,
  selectedPools,
  refresh = false,
}) {
  let canResume = false;
  let savedState = null;
  const completedPoolsMap = new Map();

  const statePath = path.join(outputDir, "scan-state.json");
  const poolWalletsPath = path.join(outputDir, "pool-wallets.json");
  const walletsPath = path.join(outputDir, "wallets.json");

  try {
    const stateRaw = await fs.readFile(statePath, "utf8");
    savedState = JSON.parse(stateRaw);
    if (
      savedState?.tokenMint === tokenCA &&
      savedState?.selectionFingerprint === fingerprint
    ) {
      canResume = true;
    }
  } catch {
    canResume = false;
  }

  if (!canResume) {
    return {
      canResume: false,
      completedPoolsMap,
      savedState: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
  }

  // Load pool-wallets.json and validate consistency
  let pwData = null;
  try {
    const pwRaw = await fs.readFile(poolWalletsPath, "utf8");
    pwData = JSON.parse(pwRaw);
  } catch {
    console.warn("[Resume] pool-wallets.json corrupted or missing. Starting fresh scan.");
    return {
      canResume: false,
      completedPoolsMap,
      savedState: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
  }

  const selectedAddressSet = new Set(selectedPools.map((p) => p.poolAddress));
  const stateCompletedSet = new Set(
    Array.isArray(savedState?.completedPoolAddresses)
      ? savedState.completedPoolAddresses
      : []
  );

  if (Array.isArray(pwData?.pools)) {
    for (const poolItem of pwData.pools) {
      const addr = poolItem?.poolAddress;
      if (!addr || !selectedAddressSet.has(addr)) continue;

      const isCompletedInPw =
        poolItem?.status === "completed" && Array.isArray(poolItem?.wallets);
      const isConfirmedInState = stateCompletedSet.has(addr);

      // Strict checkpoint consistency:
      // A pool must be completed with valid data in pool-wallets AND acknowledged in scan-state
      if (isCompletedInPw && isConfirmedInState) {
        completedPoolsMap.set(addr, poolItem);
      } else {
        console.warn(
          `[Resume] Checkpoint desynchronization for pool ${addr}: inPoolWallets=${isCompletedInPw}, inScanState=${isConfirmedInState}. Discarding unconfirmed pool.`
        );
      }
    }
  }

  if (refresh) {
    for (const p of selectedPools) {
      completedPoolsMap.delete(p.poolAddress);
    }
    console.log(
      `[Refresh] Cleared cached completion for ${selectedPools.length} target pool(s) to force fresh extraction.`
    );
  } else {
    console.log(
      `[Resume] Matching selection fingerprint found. Resuming with ${completedPoolsMap.size} valid completed pool(s).`
    );
  }

  // Validate and reconcile wallets.json to match confirmed completed pools
  const expectedWallets = getGlobalWallets(completedPoolsMap);
  let walletsNeedRewrite = false;
  try {
    const walletsRaw = await fs.readFile(walletsPath, "utf8");
    const currentWallets = JSON.parse(walletsRaw);
    if (
      !Array.isArray(currentWallets) ||
      currentWallets.length !== expectedWallets.length ||
      currentWallets.some((w, idx) => w !== expectedWallets[idx])
    ) {
      walletsNeedRewrite = true;
    }
  } catch {
    walletsNeedRewrite = true;
  }

  if (walletsNeedRewrite && completedPoolsMap.size > 0) {
    console.log("[Resume] Reconciling wallets.json to match verified completed pools.");
    await atomicWriteJson(walletsPath, expectedWallets);
  }

  let createdAt = new Date().toISOString();
  try {
    const selRaw = await fs.readFile(path.join(outputDir, "selection.json"), "utf8");
    const selData = JSON.parse(selRaw);
    if (selData?.createdAt) createdAt = selData.createdAt;
  } catch {}

  const startedAt = refresh
    ? new Date().toISOString()
    : (savedState?.startedAt ?? new Date().toISOString());

  return {
    canResume: true,
    completedPoolsMap,
    savedState,
    createdAt,
    startedAt,
  };
}

export async function connectToBrowser({
  browserType = "cloak",
  cdpUrl = null,
  timeout = 30000,
  chromiumClient = chromium,
  checkEndpointFn = checkCdpEndpoint,
} = {}) {
  let targetUrl = cdpUrl;
  if (!targetUrl) {
    if (browserType === "cloak") {
      targetUrl = process.env.CLOAK_CDP_URL || DEFAULT_CLOAK_CDP_URL;
    } else {
      targetUrl = process.env.CDP_URL || DEFAULT_BRAVE_CDP_URL;
    }
  }

  const parsed = new URL(targetUrl);
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  const host = parsed.hostname || "127.0.0.1";

  if (browserType === "cloak" && port === FORBIDDEN_PORT) {
    throw new Error(
      `Security violation: Refusing to connect to Brave CDP port ${FORBIDDEN_PORT} when browser is set to 'cloak'. Falling back to Brave is strictly forbidden.`
    );
  }

  if (browserType === "cloak") {
    const isReady = await checkEndpointFn(port, host, 2000);
    if (!isReady) {
      throw new Error(
        `CloakBrowser is not running at ${targetUrl}. Start it first with 'npm run browser:cloak'. Silent fallback to Brave is strictly forbidden.`
      );
    }
  }

  console.log(`[Browser] Connecting to ${browserType.toUpperCase()} CDP at ${targetUrl}...`);
  const browser = await chromiumClient.connectOverCDP(targetUrl, { timeout });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error(`No browser context found in ${browserType} CDP session`);
  }

  return { browser, context, targetUrl };
}

export async function fetchTopLpersPageWithLimiter({
  page,
  poolAddress,
  pageNumber,
  rateLimiter,
  maxRetries = 3,
  workerId = 1,
}) {
  let attempt = 0;

  while (attempt <= maxRetries) {
    await rateLimiter.acquireSlot();
    let res;
    try {
      res = await page.evaluate(
        async ({ poolAddress, pageNumber }) => {
          const url =
            `https://api.lpagent.io/api/v1/pools/${poolAddress}/top-lpers` +
            `?page=${pageNumber}` +
            `&pageSize=20` +
            `&order_by=total_pnl_native` +
            `&sort_order=desc`;

          try {
            const response = await fetch(url, {
              credentials: "include",
              headers: { Accept: "application/json" },
            });

            const retryAfterHeader = response.headers.get("retry-after");
            const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
            const text = await response.text();

            return {
              ok: response.ok,
              status: response.status,
              retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
              text,
            };
          } catch (networkErr) {
            return {
              ok: false,
              status: 0,
              retryAfterSec: null,
              text: networkErr?.message || String(networkErr),
            };
          }
        },
        { poolAddress, pageNumber }
      );
    } finally {
      rateLimiter.releaseSlot();
    }

    if (res.ok) {
      let json;
      try {
        json = JSON.parse(res.text);
      } catch {
        throw new Error(`Failed to parse LP Agent response JSON for page ${pageNumber}`);
      }

      if (json?.status !== "success" || !Array.isArray(json?.data)) {
        throw new Error(`Invalid LP Agent response payload for page ${pageNumber}`);
      }

      return json;
    }

    // Fail closed immediately on auth or permission barriers (manual intervention needed)
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `LP Agent authentication barrier (HTTP ${res.status}): ${res.text?.slice(0, 150)}. User intervention required in CloakBrowser.`
      );
    }

    // Handle 429 rate limit
    if (res.status === 429) {
      const waitMs =
        res.retryAfterSec && res.retryAfterSec > 0
          ? res.retryAfterSec * 1000
          : Math.min(10000, 1500 * Math.pow(2, attempt));
      console.warn(
        `[Worker ${workerId}] HTTP 429 on pool ${poolAddress} page ${pageNumber}. Backing off for ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1}).`
      );
      rateLimiter.triggerBackoff(waitMs);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // Transient errors (5xx or network status 0)
    if (attempt < maxRetries) {
      const backoffMs = Math.min(5000, 1000 * Math.pow(2, attempt));
      console.warn(
        `[Worker ${workerId}] HTTP ${res.status} on pool ${poolAddress} page ${pageNumber}. Retrying in ${backoffMs}ms...`
      );
      await sleep(backoffMs);
      attempt++;
      continue;
    }

    throw new Error(
      `Failed to fetch LP Agent page ${pageNumber} for pool ${poolAddress} after ${maxRetries + 1} attempts (HTTP ${res.status}): ${res.text?.slice(0, 150)}`
    );
  }
}

export async function scanPoolDirect({
  page,
  pool,
  rateLimiter,
  workerId = 1,
  minPageDelay = MIN_PAGE_DELAY,
  maxPageDelay = MAX_PAGE_DELAY,
  maxRetries = 3,
}) {
  const poolAddress = pool.poolAddress;
  await page.goto(
    `https://app.lpagent.io/pools/${poolAddress}?tab=top`,
    {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    }
  );

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth")) {
    throw new Error(
      `CloakBrowser redirected to login page (${currentUrl}). User intervention required: please log in to LP Agent in CloakBrowser.`
    );
  }

  const first = await fetchTopLpersPageWithLimiter({
    page,
    poolAddress,
    pageNumber: 1,
    rateLimiter,
    maxRetries,
    workerId,
  });

  const totalPages = Number(first?.pagination?.totalPages ?? 1);
  const totalCount = Number(first?.pagination?.totalCount ?? 0);
  const allRows = [...(first.data || [])];

  console.log(
    `    [Worker ${workerId}] Page 1/${totalPages} | rows=${first.data?.length || 0} | reportedTotal=${totalCount}`
  );

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
    const delay = randomDelay(minPageDelay, maxPageDelay);
    if (delay > 0) {
      await sleep(delay);
    }

    const json = await fetchTopLpersPageWithLimiter({
      page,
      poolAddress,
      pageNumber,
      rateLimiter,
      maxRetries,
      workerId,
    });

    const rows = json.data || [];
    allRows.push(...rows);

    console.log(
      `    [Worker ${workerId}] Page ${pageNumber}/${totalPages} | rows=${rows.length} | totalRows=${allRows.length}`
    );
  }

  const poolWalletsMap = new Map();
  for (const row of allRows) {
    const wallet =
      typeof row?.owner === "string" && row.owner.trim()
        ? row.owner.trim()
        : typeof row?.wallet === "string" && row.wallet.trim()
        ? row.wallet.trim()
        : null;

    if (!wallet) continue;

    if (!poolWalletsMap.has(wallet)) {
      let pnlUsd = null;
      if (
        row?.total_pnl !== undefined &&
        row?.total_pnl !== null &&
        row?.total_pnl !== ""
      ) {
        const parsed = Number(row.total_pnl);
        if (Number.isFinite(parsed)) {
          pnlUsd = parsed;
        }
      }

      let winRate = null;
      if (
        row?.win_rate !== undefined &&
        row?.win_rate !== null &&
        row?.win_rate !== ""
      ) {
        const parsed = Number(row.win_rate);
        if (Number.isFinite(parsed)) {
          winRate = parsed * 100;
        }
      }

      let positions = null;
      if (
        row?.total_lp !== undefined &&
        row?.total_lp !== null &&
        row?.total_lp !== ""
      ) {
        const parsed = Number(row.total_lp);
        if (Number.isFinite(parsed)) {
          positions = parsed;
        }
      }

      poolWalletsMap.set(wallet, {
        wallet,
        pnlUsd,
        winRate,
        positions,
      });
    }
  }

  return {
    poolAddress: pool.poolAddress,
    pair: pool.pair,
    binStep: pool.binStep,
    baseFeePct: pool.baseFeePct,
    status: "completed",
    walletCount: poolWalletsMap.size,
    wallets: Array.from(poolWalletsMap.values()),
  };
}

export async function scanSelectedPools(options = {}) {
  const {
    tokenCA,
    pools: rawPools = [],
    refresh = false,
    workers = 1,
    browserType = "cloak",
    cdpUrl = null,
    outputDir: customOutputDir = null,
    discoverTokenPoolsFn = discoverTokenPools,
    chromiumClient = chromium,
    checkEndpointFn = checkCdpEndpoint,
    minPageDelay = MIN_PAGE_DELAY,
    maxPageDelay = MAX_PAGE_DELAY,
    minPoolDelay = MIN_POOL_DELAY,
    maxPoolDelay = MAX_POOL_DELAY,
    maxRetries = 3,
    context: injectedContext = null,
    browser: injectedBrowser = null,
  } = options;

  if (!tokenCA) {
    throw new Error("Token CA is required. Use --token <TOKEN_CA>");
  }

  if (!rawPools.length) {
    throw new Error("At least one pool address is required. Use --pool <POOL_ADDRESS>");
  }

  if (workers !== 1 && workers !== 2) {
    throw new Error(`Invalid workers count: ${workers}. Only 1 or 2 workers are supported.`);
  }

  const uniqueSelectedAddresses = [...new Set(rawPools)];

  console.log(`\n======================================`);
  console.log(`SELECTED POOL SCANNER (STEP 3B)`);
  console.log(`======================================`);
  console.log(`Token CA:       ${tokenCA}`);
  console.log(`Selected Pools: ${uniqueSelectedAddresses.length}`);
  console.log(`Workers:        ${workers}`);
  console.log(`Browser Type:   ${browserType.toUpperCase()}`);
  if (refresh) {
    console.log(`Refresh Mode:   ENABLED (forcing fresh LP Agent extraction)`);
  }

  console.log("\n[Discovery] Validating selected pools with Meteora API...");
  const discoveryResult = await discoverTokenPoolsFn(tokenCA);
  const discoveredMap = new Map(discoveryResult.pools.map((p) => [p.poolAddress, p]));

  for (const addr of uniqueSelectedAddresses) {
    if (!discoveredMap.has(addr)) {
      throw new Error(
        `Selected pool ${addr} is not an authoritative TOKEN/SOL or TOKEN/USDC pool for token ${tokenCA}`
      );
    }
  }

  const selectedPools = discoveryResult.pools.filter((p) =>
    uniqueSelectedAddresses.includes(p.poolAddress)
  );

  console.log(`[Discovery] Authoritative pools validated: ${selectedPools.length}`);
  for (const [idx, p] of selectedPools.entries()) {
    console.log(
      `  ${idx + 1}. ${p.pair} | binStep=${p.binStep ?? "—"} | fee=${p.baseFeePct ?? "—"}% | ${p.poolAddress}`
    );
  }

  const fingerprint = computeSelectionFingerprint(
    tokenCA,
    selectedPools.map((p) => p.poolAddress)
  );

  const outputDir =
    customOutputDir ||
    path.resolve(ROOT, "data/discovery/pool-scanner", tokenCA, "selected-scan");
  await fs.mkdir(outputDir, { recursive: true });

  const {
    canResume,
    completedPoolsMap,
    savedState,
    createdAt,
    startedAt,
  } = await validateAndReconcileCheckpoints({
    outputDir,
    tokenCA,
    fingerprint,
    selectedPools,
    refresh,
  });

  const selectionData = {
    version: "v1",
    tokenMint: tokenCA,
    selectionFingerprint: fingerprint,
    createdAt,
    selectedPoolCount: selectedPools.length,
    pools: selectedPools.map((p) => ({
      poolAddress: p.poolAddress,
      pair: p.pair,
      binStep: p.binStep,
      baseFeePct: p.baseFeePct,
    })),
  };
  await atomicWriteJson(path.join(outputDir, "selection.json"), selectionData);

  const allAlreadyComplete = selectedPools.every((p) => completedPoolsMap.has(p.poolAddress));
  if (allAlreadyComplete) {
    console.log(`[Selected Scan] All ${selectedPools.length} selected pools already completed.`);
    await saveCheckpoints({
      outputDir,
      tokenCA,
      fingerprint,
      selectedPools,
      completedPoolsMap,
      status: "completed",
      startedAt,
    });
    const uniqueWallets = getGlobalWallets(completedPoolsMap).length;
    console.log(
      `[SELECTED_SCAN] POOL_PROGRESS completed=${completedPoolsMap.size} total=${selectedPools.length} wallets=${uniqueWallets}`
    );
    console.log(
      `[SELECTED_SCAN] COMPLETE totalPools=${selectedPools.length} uniqueWallets=${uniqueWallets}`
    );
    return {
      completedPoolsMap,
      uniqueWallets,
      outputDir,
    };
  }

  // Pending pool queue
  const pendingPools = selectedPools.filter((p) => !completedPoolsMap.has(p.poolAddress));

  // Connect to browser or use injected context
  let browser = injectedBrowser;
  let context = injectedContext;

  if (!context) {
    const conn = await connectToBrowser({
      browserType,
      cdpUrl,
      chromiumClient,
      checkEndpointFn,
    });
    browser = conn.browser;
    context = conn.context;
  }

  // Dedicated scanner-owned tabs
  const scannerPages = [];
  const checkpointWriter = new CheckpointWriter();
  const rateLimiter = new RateLimiter({
    maxInFlight: Math.min(workers, 2),
    minIntervalMs: 250,
  });

  let workerError = null;
  let shouldAbort = false;

  const onDisconnect = () => {
    shouldAbort = true;
    if (!workerError) {
      workerError = new Error("Browser CDP session disconnected");
    }
  };
  browser?.on?.("disconnected", onDisconnect);
  try {
    const page1 = await context.newPage();
    scannerPages.push(page1);

    const activeWorkerCount = Math.min(workers, pendingPools.length);
    let page2 = null;
    if (activeWorkerCount > 1) {
      page2 = await context.newPage();
      scannerPages.push(page2);
    }

    let queueIndex = 0;
    function getNextPool() {
      if (shouldAbort || queueIndex >= pendingPools.length) return null;
      return pendingPools[queueIndex++];
    }

    async function runWorker(workerId, page) {
      while (!shouldAbort) {
        const pool = getNextPool();
        if (!pool) break;

        console.log(
          `[SELECTED_SCAN] CURRENT_POOL pair="${pool.pair}" bin=${pool.binStep} fee=${pool.baseFeePct} addr="${pool.poolAddress}"`
        );
        console.log(`\n======================================`);
        console.log(`[Worker ${workerId}] Scanning pool ${completedPoolsMap.size + 1}/${selectedPools.length}`);
        console.log(`Pair: ${pool.pair} | Bin Step: ${pool.binStep ?? "—"} | Base Fee: ${pool.baseFeePct ?? "—"}%`);
        console.log(`Pool Address: ${pool.poolAddress}`);
        console.log(`======================================`);

        try {
          const poolResult = await scanPoolDirect({
            page,
            pool,
            rateLimiter,
            workerId,
            minPageDelay,
            maxPageDelay,
            maxRetries,
          });

          if (shouldAbort) {
            break;
          }

          await checkpointWriter.write(async () => {
            completedPoolsMap.set(pool.poolAddress, poolResult);
            await saveCheckpoints({
              outputDir,
              tokenCA,
              fingerprint,
              selectedPools,
              completedPoolsMap,
              status: "in_progress",
              startedAt,
            });

            const currentWallets = getGlobalWallets(completedPoolsMap);
            console.log(
              `\n[Pool Complete] [Worker ${workerId}] ${pool.pair} (${pool.poolAddress}): ${poolResult.walletCount} wallets extracted.`
            );
            console.log(
              `[SELECTED_SCAN] POOL_PROGRESS completed=${completedPoolsMap.size} total=${selectedPools.length} wallets=${currentWallets.length}`
            );
          });

          if (!shouldAbort && queueIndex < pendingPools.length) {
            const poolDelay = randomDelay(minPoolDelay, maxPoolDelay);
            if (poolDelay > 0) {
              console.log(`[Worker ${workerId}] Waiting ${poolDelay}ms before next pool...`);
              await sleep(poolDelay);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n[Pool FAILED] [Worker ${workerId}] ${pool.poolAddress}: ${msg}`);
          shouldAbort = true;
          if (!workerError) {
            workerError = err;
          }
          break;
        }
      }
    }

    const workerTasks = [runWorker(1, page1)];
    if (page2) {
      workerTasks.push(runWorker(2, page2));
    }

    await Promise.all(workerTasks);

    if (workerError) {
      await checkpointWriter.write(async () => {
        await saveCheckpoints({
          outputDir,
          tokenCA,
          fingerprint,
          selectedPools,
          completedPoolsMap,
          status: "error",
          startedAt,
          error: workerError instanceof Error ? workerError.message : String(workerError),
        });
      });
      throw workerError;
    }

    // Save final completed checkpoints
    await checkpointWriter.write(async () => {
      await saveCheckpoints({
        outputDir,
        tokenCA,
        fingerprint,
        selectedPools,
        completedPoolsMap,
        status: "completed",
        startedAt,
      });
    });

    const finalGlobalWallets = getGlobalWallets(completedPoolsMap);

    console.log(`\n======================================`);
    console.log(`SELECTED POOLS SCAN COMPLETE`);
    console.log(`Total Pools:     ${selectedPools.length}`);
    console.log(`Completed Pools: ${completedPoolsMap.size}`);
    console.log(`Unique Wallets:  ${finalGlobalWallets.length}`);
    console.log(`Output Directory: ${outputDir}`);
    console.log(`======================================`);
    console.log(
      `[SELECTED_SCAN] COMPLETE totalPools=${selectedPools.length} uniqueWallets=${finalGlobalWallets.length}`
    );

    return {
      completedPoolsMap,
      uniqueWallets: finalGlobalWallets.length,
      outputDir,
    };
  } finally {
    browser?.off?.("disconnected", onDisconnect);
    rateLimiter.destroy();
    // Close only scanner-owned tabs; keep CloakBrowser and existing tabs alive
    for (const p of scannerPages) {
      try {
        if (!p.isClosed()) {
          await p.close();
        }
      } catch {}
    }
  }
}

export async function main() {
  const cliArgs = parseCliArgs();
  await scanSelectedPools(cliArgs);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("\n[SELECTED_SCAN FAILED]", err);
    process.exit(1);
  });
}
