import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import EventEmitter from "node:events";

import {
  scanSelectedPools,
  parseCliArgs,
  validateAndReconcileCheckpoints,
  connectToBrowser,
  CheckpointWriter,
  computeSelectionFingerprint,
  DiagnosticsCollector,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_NAV_SETTLE_MS,
} from "../../scripts/pool/scan-selected-pools.mjs";
import { RateLimiter } from "../../scripts/bench/rate-limiter.mjs";

const TEST_TOKEN = "TEST_TOKEN_MINT_111111111111111111111111111";
const POOL_A = "PoolAddressA11111111111111111111111111111111";
const POOL_B = "PoolAddressB22222222222222222222222222222222";
const POOL_C = "PoolAddressC33333333333333333333333333333333";
const POOL_D = "PoolAddressD44444444444444444444444444444444";

interface TopLperRow {
  owner?: string;
  wallet?: string;
  total_pnl?: number | string;
  win_rate?: number | string;
  total_lp?: number | string;
}

interface DiscoveredPoolItem {
  poolAddress: string;
  pair: string;
  binStep?: number;
  baseFeePct?: number;
}

interface PoolWalletsRecord {
  poolAddress: string;
  status: string;
  wallets: Array<{ wallet: string; pnlUsd?: number | null; winRate?: number | null; positions?: number | null }>;
}

interface PoolWalletsJson {
  version: string;
  tokenMint: string;
  updatedAt?: string;
  pools: PoolWalletsRecord[];
}

interface ScanStateJson {
  version: string;
  tokenMint: string;
  selectionFingerprint: string;
  status: string;
  selectedPoolCount: number;
  completedPoolCount: number;
  completedPoolAddresses: string[];
  error?: string;
}

function createMockDiscoveryResult(pools: DiscoveredPoolItem[]) {
  return async () => ({
    tokenMint: TEST_TOKEN,
    solMint: "So11111111111111111111111111111111111111112",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    pairRule: "TOKEN_SOL_OR_USDC_EXACT",
    discoveredAt: new Date().toISOString(),
    poolCount: pools.length,
    pools: pools.map((p) => ({
      poolAddress: p.poolAddress,
      pair: p.pair,
      binStep: p.binStep ?? 20,
      baseFeePct: p.baseFeePct ?? 0.25,
      tokenX: TEST_TOKEN,
      tokenY: "So11111111111111111111111111111111111111112",
    })),
  });
}

interface StatusOverrideItem {
  status: number;
  retryAfter?: number;
  text?: string;
  errorName?: string;
  delayMs?: number;
  remainingFailures?: number;
}

interface MockPageOptions {
  id?: string;
  browser?: MockBrowser;
  dataMap?: Record<string, Record<number, TopLperRow[]>>;
  statusOverrides?: Record<string, StatusOverrideItem>;
  onGoto?: (url: string, pageId: string) => void;
  onRequest?: (poolAddress: string, pageNumber: number, pageId: string) => void;
}

class MockPage {
  id: string;
  _url = "about:blank";
  _closed = false;
  _windowName = "";
  bringToFrontCalled = false;
  options: MockPageOptions;

  constructor(options: MockPageOptions = {}) {
    this.id = options.id || `tab-${Math.random().toString(36).slice(2, 6)}`;
    this.options = options;
  }

  url(): string {
    return this._url;
  }

  isClosed(): boolean {
    return this._closed;
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  async bringToFront(): Promise<void> {
    this.bringToFrontCalled = true;
  }

  async goto(url: string): Promise<void> {
    if (this._closed) throw new Error("Target page closed");
    if (this.options.browser && !this.options.browser.isConnected()) {
      throw new Error("Target page closed due to browser disconnect");
    }
    this._url = url;
    this.options.onGoto?.(url, this.id);
  }

  async evaluate(
    fn: unknown,
    args?: unknown
  ): Promise<unknown> {
    if (this._closed) throw new Error("Target page closed");
    if (this.options.browser && !this.options.browser.isConnected()) {
      throw new Error("Target page closed due to browser disconnect");
    }

    if (typeof fn === "function") {
      const fnStr = fn.toString();
      if (fnStr.includes("window.name =") || fnStr.includes("window.name=")) {
        this._windowName = typeof args === "string" ? args : "";
        return undefined;
      }
      if (fnStr.includes("window.name")) {
        return this._windowName || "";
      }
    }

    const evaluatedArgs = (args && typeof args === "object" ? args : {}) as { poolAddress?: string; pageNumber?: number };
    const poolAddress = evaluatedArgs.poolAddress ?? "";
    const pageNumber = evaluatedArgs.pageNumber ?? 1;
    if (poolAddress) {
      this.options.onRequest?.(poolAddress, pageNumber, this.id);
    }

    if (this.options.browser && !this.options.browser.isConnected()) {
      throw new Error("Browser CDP session disconnected");
    }
    const overrideKey = `${poolAddress}:${pageNumber}`;
    const override = this.options.statusOverrides?.[overrideKey];
    if (override) {
      if (override.remainingFailures !== undefined) {
        if (override.remainingFailures > 0) {
          override.remainingFailures--;
          return {
            ok: override.status >= 200 && override.status < 300,
            status: override.status,
            retryAfterSec: override.retryAfter ?? null,
            errorName: override.errorName ?? (override.status === 0 ? "TimeoutError" : `HTTP_${override.status}`),
            text: override.text || (override.status === 429 ? "Too Many Requests" : "Error"),
          };
        }
      } else {
        return {
          ok: override.status >= 200 && override.status < 300,
          status: override.status,
          retryAfterSec: override.retryAfter ?? null,
          errorName: override.errorName ?? (override.status === 0 ? "TimeoutError" : `HTTP_${override.status}`),
          text: override.text || (override.status === 429 ? "Too Many Requests" : "Error"),
        };
      }
    }

    const poolRows = this.options.dataMap?.[poolAddress]?.[pageNumber] || [];
    const totalPages = Object.keys(this.options.dataMap?.[poolAddress] || { 1: [] }).length;

    return {
      ok: true,
      status: 200,
      retryAfterSec: null,
      errorName: null,
      text: JSON.stringify({
        status: "success",
        data: poolRows,
        pagination: {
          totalPages,
          totalCount: poolRows.length,
          page: pageNumber,
          pageSize: 20,
        },
      }),
    };
  }
}

class MockBrowserContext {
  _pages: MockPage[] = [];
  _pageOptions: MockPageOptions;

  constructor(pageOptions: MockPageOptions = {}, initialPages: MockPage[] = []) {
    this._pageOptions = pageOptions;
    this._pages = [...initialPages];
  }

  pages(): MockPage[] {
    return [...this._pages];
  }

  async newPage(): Promise<MockPage> {
    const p = new MockPage({
      ...this._pageOptions,
      id: `worker-tab-${this._pages.length + 1}`,
    });
    this._pages.push(p);
    return p;
  }
}

class MockBrowser extends EventEmitter {
  _context: MockBrowserContext;
  _closed = false;

  constructor(context: MockBrowserContext) {
    super();
    this._context = context;
  }

  contexts(): MockBrowserContext[] {
    return [this._context];
  }

  isConnected(): boolean {
    return !this._closed;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.emit("disconnected");
  }
}

describe("CloakBrowser 2-Tab LP Agent Selected Pool Scanner Suite", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dllm-pool-scan-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // 1. One-worker compatibility
  // ---------------------------------------------------------------------------
  it("1. One-worker compatibility: runs sequential extraction using single tab", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA1", total_pnl: 100 }] },
      [POOL_B]: { 1: [{ owner: "WalletB1", total_pnl: 200 }] },
    };

    const createdPages: MockPage[] = [];
    const context = new MockBrowserContext({ dataMap });
    const originalNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      const p = await originalNewPage();
      createdPages.push(p);
      return p;
    };
    const browser = new MockBrowser(context);

    const result = await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 1,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(createdPages.length, 1, "Only 1 scanner tab should be created for 1 worker");
    assert.equal(createdPages[0].isClosed(), false, "Scanner tab must remain open (persistent) when complete");
    assert.equal(createdPages[0].bringToFrontCalled, false, "bringToFront must not be called");
    assert.equal(result.completedPoolsMap.size, 2);
    assert.equal(result.uniqueWallets, 2);

    const pw = JSON.parse(await fs.readFile(path.join(tmpDir, "pool-wallets.json"), "utf8")) as PoolWalletsJson;
    assert.equal(pw.pools.length, 2);
    assert.equal(pw.pools[0].poolAddress, POOL_A);
    assert.equal(pw.pools[1].poolAddress, POOL_B);
  });

  // ---------------------------------------------------------------------------
  // 2. Two independent tab workers
  // ---------------------------------------------------------------------------
  it("2. Two independent tab workers: opens two separate tabs in the same context", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA1", total_pnl: 100 }] },
      [POOL_B]: { 1: [{ owner: "WalletB1", total_pnl: 200 }] },
    };

    const createdPages: MockPage[] = [];
    const context = new MockBrowserContext({ dataMap });
    const originalNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      const p = await originalNewPage();
      createdPages.push(p);
      return p;
    };
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(createdPages.length, 2, "Exactly 2 scanner tabs must be opened for 2 workers");
    assert.notEqual(createdPages[0].id, createdPages[1].id, "Tabs must be distinct");
    assert.equal(createdPages[0].isClosed(), false, "Tab 1 must remain open (persistent) on completion");
    assert.equal(createdPages[1].isClosed(), false, "Tab 2 must remain open (persistent) on completion");
    assert.equal(createdPages[0].bringToFrontCalled, false, "bringToFront must not be called on tab 1");
    assert.equal(createdPages[1].bringToFrontCalled, false, "bringToFront must not be called on tab 2");
    assert.equal(browser.isConnected(), true, "Browser must remain connected after scan");
  });

  // ---------------------------------------------------------------------------
  // 3. Disjoint pool assignment
  // ---------------------------------------------------------------------------
  it("3. Disjoint pool assignment: each pool is processed by exactly one worker without overlap", async () => {
    const poolWorkers: Record<string, string[]> = {};
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "W1" }] },
      [POOL_B]: { 1: [{ owner: "W2" }] },
      [POOL_C]: { 1: [{ owner: "W3" }] },
      [POOL_D]: { 1: [{ owner: "W4" }] },
    };

    const context = new MockBrowserContext({
      dataMap,
      onGoto: (url, pageId) => {
        const match = url.match(/\/pools\/([^?]+)/);
        if (match) {
          const pool = match[1];
          if (!poolWorkers[pool]) poolWorkers[pool] = [];
          poolWorkers[pool].push(pageId);
        }
      },
    });
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B, POOL_C, POOL_D],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
        { poolAddress: POOL_C, pair: "TEST/SOL-2" },
        { poolAddress: POOL_D, pair: "TEST/USDC-2" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    for (const pool of [POOL_A, POOL_B, POOL_C, POOL_D]) {
      assert.ok(poolWorkers[pool], `Pool ${pool} should have been visited`);
      assert.equal(poolWorkers[pool].length, 1, `Pool ${pool} must be handled by exactly 1 tab`);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. No duplicate page requests
  // ---------------------------------------------------------------------------
  it("4. No duplicate page requests: dispatches each (pool, page) request exactly once", async () => {
    const requestedPages: string[] = [];
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: {
        1: [{ owner: "W1" }],
        2: [{ owner: "W2" }],
      },
      [POOL_B]: {
        1: [{ owner: "W3" }],
        2: [{ owner: "W4" }],
      },
    };

    const context = new MockBrowserContext({
      dataMap,
      onRequest: (pool, pageNum) => {
        requestedPages.push(`${pool}:${pageNum}`);
      },
    });
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const uniqueRequests = new Set(requestedPages);
    assert.equal(
      requestedPages.length,
      uniqueRequests.size,
      "Zero duplicate page requests across workers"
    );
    assert.ok(uniqueRequests.has(`${POOL_A}:1`));
    assert.ok(uniqueRequests.has(`${POOL_A}:2`));
    assert.ok(uniqueRequests.has(`${POOL_B}:1`));
    assert.ok(uniqueRequests.has(`${POOL_B}:2`));
  });

  // ---------------------------------------------------------------------------
  // 5. Shared request rate limiting
  // ---------------------------------------------------------------------------
  it("5. Shared request rate limiting: enforces max in-flight = 2 and pauses on 429", async () => {
    let currentInFlight = 0;
    let maxObservedInFlight = 0;
    const limiter = new RateLimiter({ maxInFlight: 2, minIntervalMs: 5 });

    const originalAcquire = limiter.acquireSlot.bind(limiter);
    limiter.acquireSlot = async () => {
      await originalAcquire();
      currentInFlight++;
      if (currentInFlight > maxObservedInFlight) {
        maxObservedInFlight = currentInFlight;
      }
    };
    const originalRelease = limiter.releaseSlot.bind(limiter);
    limiter.releaseSlot = () => {
      currentInFlight = Math.max(0, currentInFlight - 1);
      originalRelease();
    };

    const startBackoff = Date.now();
    limiter.triggerBackoff(30);
    await limiter.acquireSlot();
    const elapsed = Date.now() - startBackoff;
    limiter.releaseSlot();

    assert.ok(elapsed >= 25, `Backoff must hold dispatch for duration (elapsed=${elapsed}ms)`);
    limiter.destroy();
  });

  // ---------------------------------------------------------------------------
  // 6. Pool-local wallet membership
  // ---------------------------------------------------------------------------
  it("6. Pool-local wallet membership: attributes wallets strictly to their parent pool", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "LocalA_1", total_pnl: 10 }, { owner: "Shared_1", total_pnl: 20 }] },
      [POOL_B]: { 1: [{ owner: "LocalB_1", total_pnl: 30 }, { owner: "Shared_1", total_pnl: 40 }] },
    };

    const context = new MockBrowserContext({ dataMap });
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const pw = JSON.parse(await fs.readFile(path.join(tmpDir, "pool-wallets.json"), "utf8")) as PoolWalletsJson;
    const poolARecord = pw.pools.find((p) => p.poolAddress === POOL_A);
    const poolBRecord = pw.pools.find((p) => p.poolAddress === POOL_B);

    assert.ok(poolARecord);
    assert.ok(poolBRecord);

    const walletsInA = poolARecord.wallets.map((w) => w.wallet);
    const walletsInB = poolBRecord.wallets.map((w) => w.wallet);

    assert.deepEqual(walletsInA, ["LocalA_1", "Shared_1"]);
    assert.deepEqual(walletsInB, ["LocalB_1", "Shared_1"]);
    assert.equal(walletsInA.includes("LocalB_1"), false, "LocalB_1 must not leak to Pool A");
  });

  // ---------------------------------------------------------------------------
  // 7. Global wallet deduplication
  // ---------------------------------------------------------------------------
  it("7. Global wallet deduplication: wallets.json contains sorted deduplicated union", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "Z_Wallet" }, { owner: "M_Wallet" }] },
      [POOL_B]: { 1: [{ owner: "A_Wallet" }, { owner: "M_Wallet" }] },
    };

    const context = new MockBrowserContext({ dataMap });
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const globalWallets = JSON.parse(await fs.readFile(path.join(tmpDir, "wallets.json"), "utf8")) as string[];
    assert.deepEqual(
      globalWallets,
      ["A_Wallet", "M_Wallet", "Z_Wallet"],
      "Wallets must be unique and alphabetically sorted"
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Serialized checkpoint writes
  // ---------------------------------------------------------------------------
  it("8. Serialized checkpoint writes: CheckpointWriter queues concurrent write requests", async () => {
    const writer = new CheckpointWriter();
    const executionOrder: number[] = [];

    const { promise: p1Started, resolve: resolveP1Started } = Promise.withResolvers<void>();
    const { promise: p1CanFinish, resolve: resolveP1Finish } = Promise.withResolvers<void>();

    const write1 = writer.write(async () => {
      resolveP1Started();
      await p1CanFinish;
      executionOrder.push(1);
    });

    const write2 = writer.write(async () => {
      executionOrder.push(2);
    });

    await p1Started;
    assert.deepEqual(executionOrder, [], "Write 2 must not start while Write 1 is in progress");
    resolveP1Finish();
    await Promise.all([write1, write2]);

    assert.deepEqual(executionOrder, [1, 2], "Writes must execute in strict serialized order");
  });

  // ---------------------------------------------------------------------------
  // 9. Crash between checkpoint file writes
  // ---------------------------------------------------------------------------
  it("9. Crash between checkpoint file writes: detects partial writes and reconciles state safely", async () => {
    const fingerprint = computeSelectionFingerprint(TEST_TOKEN, [POOL_A, POOL_B]);
    const selectedPools = [
      { poolAddress: POOL_A, pair: "TEST/SOL" },
      { poolAddress: POOL_B, pair: "TEST/USDC" },
    ];

    const pwData: PoolWalletsJson = {
      version: "v1",
      tokenMint: TEST_TOKEN,
      pools: [
        { poolAddress: POOL_A, status: "completed", wallets: [{ wallet: "W1" }] },
        { poolAddress: POOL_B, status: "completed", wallets: [{ wallet: "W2" }] },
      ],
    };
    await fs.writeFile(path.join(tmpDir, "pool-wallets.json"), JSON.stringify(pwData));

    await fs.writeFile(path.join(tmpDir, "wallets.json"), JSON.stringify(["CORRUPTED_OR_OUTDATED"]));

    const scanStateData: ScanStateJson = {
      version: "v1",
      tokenMint: TEST_TOKEN,
      selectionFingerprint: fingerprint,
      status: "in_progress",
      selectedPoolCount: 2,
      completedPoolCount: 1,
      completedPoolAddresses: [POOL_A],
    };
    await fs.writeFile(path.join(tmpDir, "scan-state.json"), JSON.stringify(scanStateData));

    const reconciliation = await validateAndReconcileCheckpoints({
      outputDir: tmpDir,
      tokenCA: TEST_TOKEN,
      fingerprint,
      selectedPools,
      refresh: false,
    });

    assert.equal(reconciliation.canResume, true);
    assert.equal(
      reconciliation.completedPoolsMap.has(POOL_A),
      true,
      "Pool A (acknowledged in both files) must be kept"
    );
    assert.equal(
      reconciliation.completedPoolsMap.has(POOL_B),
      false,
      "Pool B (unconfirmed in scan-state) must be discarded to prevent corrupt resume"
    );

    const reconciledWallets = JSON.parse(await fs.readFile(path.join(tmpDir, "wallets.json"), "utf8")) as string[];
    assert.deepEqual(reconciledWallets, ["W1"]);
  });

  // ---------------------------------------------------------------------------
  // 10. Stop and resume
  // ---------------------------------------------------------------------------
  it("10. Stop and resume: skips completed pools on second run and preserves selection metadata", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
    };

    const visitedPoolsRun1: string[] = [];
    const context1 = new MockBrowserContext({
      dataMap,
      onGoto: (url) => {
        const m = url.match(/\/pools\/([^?]+)/);
        if (m) visitedPoolsRun1.push(m[1]);
      },
    });
    const browser1 = new MockBrowser(context1);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A],
      workers: 1,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
      ]),
      context: context1 as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser1 as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const initialSel = JSON.parse(await fs.readFile(path.join(tmpDir, "selection.json"), "utf8")) as { createdAt: string };
    const initialCreatedAt = initialSel.createdAt;
    assert.ok(initialCreatedAt);

    const fpAB = computeSelectionFingerprint(TEST_TOKEN, [POOL_A, POOL_B]);
    await fs.writeFile(
      path.join(tmpDir, "scan-state.json"),
      JSON.stringify({
        version: "v1",
        tokenMint: TEST_TOKEN,
        selectionFingerprint: fpAB,
        status: "in_progress",
        selectedPoolCount: 2,
        completedPoolCount: 1,
        completedPoolAddresses: [POOL_A],
        startedAt: initialCreatedAt,
      })
    );
    await fs.writeFile(
      path.join(tmpDir, "selection.json"),
      JSON.stringify({
        version: "v1",
        tokenMint: TEST_TOKEN,
        selectionFingerprint: fpAB,
        createdAt: initialCreatedAt,
        selectedPoolCount: 2,
        pools: [
          { poolAddress: POOL_A, pair: "TEST/SOL" },
          { poolAddress: POOL_B, pair: "TEST/USDC" },
        ],
      })
    );

    const visitedPoolsRun2: string[] = [];
    const context2 = new MockBrowserContext({
      dataMap,
      onGoto: (url) => {
        const m = url.match(/\/pools\/([^?]+)/);
        if (m) visitedPoolsRun2.push(m[1]);
      },
    });
    const browser2 = new MockBrowser(context2);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 1,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context2 as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser2 as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.deepEqual(visitedPoolsRun2, [POOL_B], "Run 2 must skip completed POOL_A and only visit POOL_B");
  });

  // ---------------------------------------------------------------------------
  // 11. One worker fails while another completes
  // ---------------------------------------------------------------------------
  it("11. One worker fails while another completes: completed pool work is preserved in error state", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
    };

    const statusOverrides: Record<string, { status: number; text: string }> = {
      [`${POOL_B}:1`]: { status: 500, text: "Internal Server Error" },
    };

    const context = new MockBrowserContext({
      dataMap,
      statusOverrides,
    });
    const browser = new MockBrowser(context);

    let caughtError: unknown = null;
    try {
      await scanSelectedPools({
        tokenCA: TEST_TOKEN,
        pools: [POOL_A, POOL_B],
        workers: 2,
        outputDir: tmpDir,
        discoverTokenPoolsFn: createMockDiscoveryResult([
          { poolAddress: POOL_A, pair: "TEST/SOL" },
          { poolAddress: POOL_B, pair: "TEST/USDC" },
        ]),
        context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
        browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
        maxRetries: 0, // Fail fast without multiple backoff delays
        minPageDelay: 0,
        maxPageDelay: 0,
        minPoolDelay: 0,
        maxPoolDelay: 0,
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Expected scanner to throw on worker error");

    const state = JSON.parse(await fs.readFile(path.join(tmpDir, "scan-state.json"), "utf8")) as ScanStateJson;
    assert.equal(state.status, "error");
    assert.ok(state.error);

    const pw = JSON.parse(await fs.readFile(path.join(tmpDir, "pool-wallets.json"), "utf8")) as PoolWalletsJson;
    assert.equal(pw.pools.length, 1, "Completed POOL_A must be safely preserved in pool-wallets.json");
    assert.equal(pw.pools[0].poolAddress, POOL_A);
  });

  // ---------------------------------------------------------------------------
  // 12. CDP disconnect recovery
  // ---------------------------------------------------------------------------
  it("12. CDP disconnect recovery: handles browser disconnect event without corrupting checkpoints", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
    };

    let browserRef: MockBrowser | null = null;
    const context = new MockBrowserContext({
      dataMap,
      onRequest: (pool) => {
        if (pool === POOL_B && browserRef) {
          // Trigger disconnect during scan of POOL_B
          browserRef.close();
        }
      },
    });
    browserRef = new MockBrowser(context);
    context._pageOptions.browser = browserRef;

    let caughtErr: unknown = null;
    try {
      await scanSelectedPools({
        tokenCA: TEST_TOKEN,
        pools: [POOL_A, POOL_B],
        workers: 1,
        outputDir: tmpDir,
        discoverTokenPoolsFn: createMockDiscoveryResult([
          { poolAddress: POOL_A, pair: "TEST/SOL" },
          { poolAddress: POOL_B, pair: "TEST/USDC" },
        ]),
        context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
        browser: browserRef as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
        minPageDelay: 0,
        maxPageDelay: 0,
        minPoolDelay: 0,
        maxPoolDelay: 0,
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Expected error on disconnect");
    const errMessage = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
    assert.ok(
      errMessage.includes("CDP session disconnected") || errMessage.includes("disconnected"),
      `Error message should indicate disconnect: ${errMessage}`
    );

    const state = JSON.parse(await fs.readFile(path.join(tmpDir, "scan-state.json"), "utf8")) as ScanStateJson;
    assert.equal(state.status, "error");

    const pw = JSON.parse(await fs.readFile(path.join(tmpDir, "pool-wallets.json"), "utf8")) as PoolWalletsJson;
    assert.equal(pw.pools.length, 1, "Only Pool A (completed before disconnect) should be stored");
    assert.equal(pw.pools[0].poolAddress, POOL_A);
  });

  // ---------------------------------------------------------------------------
  // 13. User-owned tab preservation
  // ---------------------------------------------------------------------------
  it("13. User-owned tab preservation: leaves existing browser tabs unnavigated and open", async () => {
    const userTab1 = new MockPage({ id: "user-tab-portfolio" });
    await userTab1.goto("https://app.lpagent.io/portfolio");
    const userTab2 = new MockPage({ id: "user-tab-solana" });
    await userTab2.goto("https://solscan.io");

    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
    };

    const context = new MockBrowserContext({ dataMap }, [userTab1, userTab2]);
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A],
      workers: 1,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(userTab1.isClosed(), false, "userTab1 must NOT be closed");
    assert.equal(userTab2.isClosed(), false, "userTab2 must NOT be closed");
    assert.equal(userTab1.url(), "https://app.lpagent.io/portfolio", "userTab1 URL must be preserved");
    assert.equal(userTab2.url(), "https://solscan.io", "userTab2 URL must be preserved");
  });

  // ---------------------------------------------------------------------------
  // 14. Single-worker versus two-worker data parity
  // ---------------------------------------------------------------------------
  it("14. Single-worker versus two-worker data parity: produces bit-for-bit identical output", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: {
        1: [
          { owner: "AlphaWallet", total_pnl: 100, win_rate: 0.8, total_lp: 5 },
          { owner: "BetaWallet", total_pnl: 50, win_rate: 0.6, total_lp: 2 },
        ],
      },
      [POOL_B]: {
        1: [
          { owner: "GammaWallet", total_pnl: 300, win_rate: 0.9, total_lp: 10 },
          { owner: "AlphaWallet", total_pnl: 20, win_rate: 0.5, total_lp: 1 },
        ],
      },
    };

    const dirWorker1 = path.join(tmpDir, "worker-1");
    const dirWorker2 = path.join(tmpDir, "worker-2");

    const ctx1 = new MockBrowserContext({ dataMap });
    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 1,
      outputDir: dirWorker1,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL", binStep: 20, baseFeePct: 0.25 },
        { poolAddress: POOL_B, pair: "TEST/USDC", binStep: 25, baseFeePct: 0.3 },
      ]),
      context: ctx1 as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: new MockBrowser(ctx1) as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const ctx2 = new MockBrowserContext({ dataMap });
    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: dirWorker2,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL", binStep: 20, baseFeePct: 0.25 },
        { poolAddress: POOL_B, pair: "TEST/USDC", binStep: 25, baseFeePct: 0.3 },
      ]),
      context: ctx2 as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: new MockBrowser(ctx2) as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const pw1 = JSON.parse(await fs.readFile(path.join(dirWorker1, "pool-wallets.json"), "utf8")) as PoolWalletsJson;
    const pw2 = JSON.parse(await fs.readFile(path.join(dirWorker2, "pool-wallets.json"), "utf8")) as PoolWalletsJson;

    const w1 = JSON.parse(await fs.readFile(path.join(dirWorker1, "wallets.json"), "utf8")) as string[];
    const w2 = JSON.parse(await fs.readFile(path.join(dirWorker2, "wallets.json"), "utf8")) as string[];

    delete pw1.updatedAt;
    delete pw2.updatedAt;
    assert.deepEqual(pw1, pw2, "pool-wallets.json must be identical across 1 and 2 workers");
    assert.deepEqual(w1, w2, "wallets.json must be identical across 1 and 2 workers");
  });

  // ---------------------------------------------------------------------------
  // 15. Missing CloakBrowser must not trigger Brave fallback
  // ---------------------------------------------------------------------------
  it("15. Missing CloakBrowser must not trigger Brave fallback: fails closed on port 9223", async () => {
    let connectCalledWith: string | null = null;
    const mockChromium = {
      connectOverCDP: async (url: string) => {
        connectCalledWith = url;
        return {
          contexts: () => [new MockBrowserContext()],
        };
      },
    };

    await assert.rejects(
      async () => {
        await connectToBrowser({
          browserType: "cloak",
          chromiumClient: mockChromium as unknown as Parameters<typeof connectToBrowser>[0]["chromiumClient"],
          checkEndpointFn: async () => null,
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("CloakBrowser is not running"),
          `Expected CloakBrowser not running error, got: ${err.message}`
        );
        assert.ok(
          err.message.includes("Silent fallback to Brave is strictly forbidden"),
          `Expected fallback forbidden warning, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(connectCalledWith, null, "Must never connect to any CDP port when CloakBrowser is down");

    await assert.rejects(
      async () => {
        await connectToBrowser({
          browserType: "cloak",
          cdpUrl: "http://127.0.0.1:9222",
          chromiumClient: mockChromium as unknown as Parameters<typeof connectToBrowser>[0]["chromiumClient"],
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("Security violation") && err.message.includes("Brave CDP port 9222"),
          `Expected security violation for port 9222, got: ${err.message}`
        );
        return true;
      }
    );
  });
  // ---------------------------------------------------------------------------
  // 16. Max pages enforcement
  // ---------------------------------------------------------------------------
  it("16. Max pages enforcement: caps extraction at maxPages per pool", async () => {
    const requestedPages: string[] = [];
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: {
        1: [{ owner: "W1" }],
        2: [{ owner: "W2" }],
        3: [{ owner: "W3" }],
        4: [{ owner: "W4" }],
      },
    };

    const context = new MockBrowserContext({
      dataMap,
      onRequest: (pool, pageNum) => {
        requestedPages.push(`${pool}:${pageNum}`);
      },
    });
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A],
      workers: 1,
      maxPages: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.deepEqual(requestedPages, [`${POOL_A}:1`, `${POOL_A}:2`]);
  });

  // ---------------------------------------------------------------------------
  // 17. Request timeout and HTTP 0 retry recovery
  // ---------------------------------------------------------------------------
  it("17. Deterministic request timeout & HTTP 0 retry recovery: handles transient network timeout safely", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: {
        1: [{ owner: "TimeoutRecoveredWallet", total_pnl: 100 }],
      },
    };

    // Page 1 fails with status 0 (TimeoutError) on first attempt, then succeeds on retry
    const statusOverrides: Record<string, StatusOverrideItem> = {
      [`${POOL_A}:1`]: {
        status: 0,
        errorName: "TimeoutError",
        text: "Request timed out after 5000ms",
        remainingFailures: 1,
      },
    };

    const context = new MockBrowserContext({ dataMap, statusOverrides });
    const browser = new MockBrowser(context);

    const result = await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A],
      workers: 1,
      outputDir: tmpDir,
      requestTimeoutMs: 5000,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(result.uniqueWallets, 1);
    const stateRaw = await fs.readFile(path.join(tmpDir, "scan-state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    assert.equal(state.status, "completed");
    assert.equal(state.completedPoolCount, 1);

    const walletsRaw = await fs.readFile(path.join(tmpDir, "wallets.json"), "utf8");
    assert.deepEqual(JSON.parse(walletsRaw), ["TimeoutRecoveredWallet"]);
  });

  // ---------------------------------------------------------------------------
  // 18. Two-worker parallel scheduling with RateLimiter slot release and coordinated backoff
  // ---------------------------------------------------------------------------
  it("18. Two-worker parallel scheduling with RateLimiter slot release and coordinated backoff", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: {
        1: [{ owner: "WorkerA_Wallet" }],
      },
      [POOL_B]: {
        1: [{ owner: "WorkerB_Wallet" }],
      },
    };

    // Worker 1 encounters transient HTTP 0 network error on pool A, then succeeds on retry
    const statusOverrides: Record<string, StatusOverrideItem> = {
      [`${POOL_A}:1`]: {
        status: 0,
        errorName: "NetworkError",
        text: "Failed to fetch",
        remainingFailures: 1,
      },
    };

    const context = new MockBrowserContext({ dataMap, statusOverrides });
    const browser = new MockBrowser(context);

    const result = await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(result.uniqueWallets, 2);
    assert.equal(result.completedPoolsMap.size, 2);

    const walletsRaw = await fs.readFile(path.join(tmpDir, "wallets.json"), "utf8");
    assert.deepEqual(JSON.parse(walletsRaw), ["WorkerA_Wallet", "WorkerB_Wallet"]);
  });

  // ---------------------------------------------------------------------------
  // 19. Performance diagnostics collection and sanitization
  // ---------------------------------------------------------------------------
  it("19. Performance diagnostics collection: records per-request latencies and summaries without leaking credentials", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: {
        1: [{ owner: "DiagWalletA" }],
      },
      [POOL_B]: {
        1: [{ owner: "DiagWalletB" }],
      },
    };

    const context = new MockBrowserContext({ dataMap });
    const browser = new MockBrowser(context);

    const result = await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      diagnostics: true,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.totalRequests, 2);
    assert.equal(result.diagnostics.pools.length, 2);
    assert.equal(result.diagnostics.workers.length, 2);

    const diagFileRaw = await fs.readFile(path.join(tmpDir, "diagnostics.json"), "utf8");
    const diagData = JSON.parse(diagFileRaw);
    assert.equal(diagData.totalRequests, 2);
    assert.equal(diagData.totalRetries, 0);

    // Verify strict credential sanitization: no cookies or auth tokens
    const serialized = JSON.stringify(diagData);
    assert.ok(!serialized.includes("Authorization"));
    assert.ok(!serialized.includes("Bearer"));
    assert.ok(!serialized.includes("cookie"));
  });

  // ---------------------------------------------------------------------------
  // 20. Persistent Tab Reuse and Background Invariants
  // ---------------------------------------------------------------------------
  it("20. First scan creates scanner tab and second scan reuses same tab without calling newPage (1 worker)", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
    };

    let newPageCalls = 0;
    const context = new MockBrowserContext({ dataMap });
    const origNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      newPageCalls++;
      return origNewPage();
    };
    const browser = new MockBrowser(context);

    // First scan
    const res1 = await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A],
      workers: 1,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(newPageCalls, 1, "First scan should create exactly 1 scanner tab");
    const tab1 = context.pages()[0];
    assert.equal(tab1.isClosed(), false, "Tab must be preserved after first scan");
    assert.equal(tab1.bringToFrontCalled, false, "bringToFront must not be called");

    // Second scan on same context with different pool
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "dllm-pool-scan-test2-"));
    try {
      const res2 = await scanSelectedPools({
        tokenCA: TEST_TOKEN,
        pools: [POOL_B],
        workers: 1,
        outputDir: tmpDir2,
        discoverTokenPoolsFn: createMockDiscoveryResult([
          { poolAddress: POOL_B, pair: "TEST/USDC" },
        ]),
        context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
        browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
        minPageDelay: 0,
        maxPageDelay: 0,
        minPoolDelay: 0,
        maxPoolDelay: 0,
      });

      assert.equal(newPageCalls, 1, "Second scan must NOT call newPage (reuses existing tab)");
      assert.equal(context.pages().length, 1, "Total pages count in context must remain 1");
      assert.equal(tab1.isClosed(), false, "Tab must remain open after second scan");
      assert.ok(tab1.url().includes(POOL_B), "Tab must have navigated to POOL_B");
      assert.ok(tab1.url().includes("#dllm-scanner-worker-1"), "Tab URL must retain worker marker hash");
      assert.equal(tab1.bringToFrontCalled, false, "bringToFront must not be called in second scan");
    } finally {
      await fs.rm(tmpDir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("21. Two-worker scan creates two persistent tabs and subsequent scan reuses both without newPage", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
      [POOL_C]: { 1: [{ owner: "WalletC" }] },
      [POOL_D]: { 1: [{ owner: "WalletD" }] },
    };

    let newPageCalls = 0;
    const context = new MockBrowserContext({ dataMap });
    const origNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      newPageCalls++;
      return origNewPage();
    };
    const browser = new MockBrowser(context);

    // Run 1: 2 workers scanning POOL_A and POOL_B
    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(newPageCalls, 2, "First 2-worker scan creates exactly 2 tabs");
    const pagesRun1 = context.pages();
    assert.equal(pagesRun1.length, 2);
    assert.equal(pagesRun1[0].isClosed(), false, "Tab 1 preserved");
    assert.equal(pagesRun1[1].isClosed(), false, "Tab 2 preserved");

    // Run 2: 2 workers scanning POOL_C and POOL_D
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "dllm-pool-scan-test2-"));
    try {
      await scanSelectedPools({
        tokenCA: TEST_TOKEN,
        pools: [POOL_C, POOL_D],
        workers: 2,
        outputDir: tmpDir2,
        discoverTokenPoolsFn: createMockDiscoveryResult([
          { poolAddress: POOL_C, pair: "TEST/SOL" },
          { poolAddress: POOL_D, pair: "TEST/USDC" },
        ]),
        context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
        browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
        minPageDelay: 0,
        maxPageDelay: 0,
        minPoolDelay: 0,
        maxPoolDelay: 0,
      });

      assert.equal(newPageCalls, 2, "Second 2-worker scan must make 0 newPage calls");
      assert.equal(context.pages().length, 2, "Tab count must remain exactly 2");
      assert.equal(pagesRun1[0].isClosed(), false);
      assert.equal(pagesRun1[1].isClosed(), false);
    } finally {
      await fs.rm(tmpDir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("22. Failed scans preserve persistent tabs for recovery without closing", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
    };
    const statusOverrides: Record<string, { status: number; text: string }> = {
      [`${POOL_A}:1`]: { status: 500, text: "Internal Server Error" },
    };

    const context = new MockBrowserContext({ dataMap, statusOverrides });
    const browser = new MockBrowser(context);

    let failed = false;
    try {
      await scanSelectedPools({
        tokenCA: TEST_TOKEN,
        pools: [POOL_A],
        workers: 1,
        outputDir: tmpDir,
        discoverTokenPoolsFn: createMockDiscoveryResult([
          { poolAddress: POOL_A, pair: "TEST/SOL" },
        ]),
        context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
        browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
        maxRetries: 0,
        minPageDelay: 0,
        maxPageDelay: 0,
        minPoolDelay: 0,
        maxPoolDelay: 0,
      });
    } catch {
      failed = true;
    }

    assert.equal(failed, true, "Scan should have failed due to HTTP 500");
    const pages = context.pages();
    assert.equal(pages.length, 1, "Scanner tab should exist");
    assert.equal(pages[0].isClosed(), false, "Scanner tab must remain open despite failure");
  });

  it("23. Manually closed tab recovery: recreates only closed tab while keeping existing open tab", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
    };

    let newPageCalls = 0;
    const context = new MockBrowserContext({ dataMap });
    const origNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      newPageCalls++;
      return origNewPage();
    };
    const browser = new MockBrowser(context);

    // Initial 2-worker scan
    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(newPageCalls, 2);
    const [tab1, tab2] = context.pages();

    // User manually closes tab 1, but keeps tab 2 open
    await tab1.close();
    assert.equal(tab1.isClosed(), true);
    assert.equal(tab2.isClosed(), false);

    // Next scan with 2 workers: should recreate only 1 tab (for worker 1) and reuse tab 2
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "dllm-pool-scan-test2-"));
    try {
      await scanSelectedPools({
        tokenCA: TEST_TOKEN,
        pools: [POOL_A, POOL_B],
        workers: 2,
        outputDir: tmpDir2,
        discoverTokenPoolsFn: createMockDiscoveryResult([
          { poolAddress: POOL_A, pair: "TEST/SOL" },
          { poolAddress: POOL_B, pair: "TEST/USDC" },
        ]),
        context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
        browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
        minPageDelay: 0,
        maxPageDelay: 0,
        minPoolDelay: 0,
        maxPoolDelay: 0,
      });

      assert.equal(newPageCalls, 3, "Exactly 1 new page should be created to replace closed tab 1");
      assert.equal(tab2.isClosed(), false, "Tab 2 must still remain open and reused");
    } finally {
      await fs.rm(tmpDir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("24. Reconnection over CDP identifies and reuses existing scanner tabs via markers", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
    };

    // Pre-create an existing scanner-tagged tab (simulating persistent tab from previous process)
    const existingTab = new MockPage({ id: "persistent-scanner-tab" });
    await existingTab.goto("https://app.lpagent.io/pools/PREV_POOL?tab=top#dllm-scanner-worker-1");
    existingTab._windowName = "dllm-scanner-worker-1";

    let newPageCalls = 0;
    const context = new MockBrowserContext({ dataMap }, [existingTab]);
    const origNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      newPageCalls++;
      return origNewPage();
    };
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A],
      workers: 1,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    assert.equal(newPageCalls, 0, "Must not create a new page when pre-existing marked tab exists");
    assert.equal(context.pages().length, 1);
    assert.equal(existingTab.isClosed(), false);
    assert.ok(existingTab.url().includes(POOL_A));
  });

  it("25. Browser focus is never activated: bringToFront is never called on any persistent tab", async () => {
    const dataMap: Record<string, Record<number, TopLperRow[]>> = {
      [POOL_A]: { 1: [{ owner: "WalletA" }] },
      [POOL_B]: { 1: [{ owner: "WalletB" }] },
    };

    const context = new MockBrowserContext({ dataMap });
    const browser = new MockBrowser(context);

    await scanSelectedPools({
      tokenCA: TEST_TOKEN,
      pools: [POOL_A, POOL_B],
      workers: 2,
      outputDir: tmpDir,
      discoverTokenPoolsFn: createMockDiscoveryResult([
        { poolAddress: POOL_A, pair: "TEST/SOL" },
        { poolAddress: POOL_B, pair: "TEST/USDC" },
      ]),
      context: context as unknown as Parameters<typeof scanSelectedPools>[0]["context"],
      browser: browser as unknown as Parameters<typeof scanSelectedPools>[0]["browser"],
      minPageDelay: 0,
      maxPageDelay: 0,
      minPoolDelay: 0,
      maxPoolDelay: 0,
    });

    const pages = context.pages();
    for (const page of pages) {
      assert.equal(page.bringToFrontCalled, false, "bringToFront must NEVER be called");
    }
  });

  // ---------------------------------------------------------------------------
  // CLI Arguments Validation
  // ---------------------------------------------------------------------------
  describe("CLI Arguments Parsing & Worker Boundary", () => {
    it("should accept --workers 1 and --workers 2", () => {
      const a1 = parseCliArgs(["--token", "TOK", "--workers", "1"]);
      assert.equal(a1.workers, 1);
      const a2 = parseCliArgs(["--token", "TOK", "--workers", "2"]);
      assert.equal(a2.workers, 2);
    });

    it("should default to workers=1 when --workers is omitted", () => {
      const a = parseCliArgs(["--token", "TOK"]);
      assert.equal(a.workers, 1);
      assert.equal(a.browserType, "cloak");
    });

    it("should reject workers outside 1-2", () => {
      assert.throws(() => parseCliArgs(["--token", "TOK", "--workers", "3"]), /Invalid workers count "3"/);
      assert.throws(() => parseCliArgs(["--token", "TOK", "--workers", "0"]), /Invalid workers count "0"/);
      assert.throws(() => parseCliArgs(["--token", "TOK", "--workers", "-1"]), /Invalid workers count "-1"/);
      assert.throws(() => parseCliArgs(["--token", "TOK", "--workers", "abc"]), /Invalid workers count "abc"/);
    });

    it("should reject invalid browser types including brave", async () => {
      assert.throws(() => parseCliArgs(["--token", "TOK", "--browser", "firefox"]), /Invalid browser type "firefox"/);
      assert.throws(() => parseCliArgs(["--token", "TOK", "--browser", "brave"]), /Invalid browser type "brave"/);
      await assert.rejects(
        async () => {
          await connectToBrowser({ browserType: "brave" });
        },
        /Invalid browser type "brave"/
      );
    });

    it("should accept --output-dir and --max-pages", () => {
      const parsed = parseCliArgs([
        "--token", "TOK",
        "--output-dir", "/custom/path",
        "--max-pages", "4",
      ]);
      assert.equal(parsed.outputDir, "/custom/path");
      assert.equal(parsed.maxPages, 4);
    });

    it("should reject invalid max-pages", () => {
      assert.throws(() => parseCliArgs(["--token", "TOK", "--max-pages", "0"]), /Invalid max-pages count "0"/);
      assert.throws(() => parseCliArgs(["--token", "TOK", "--max-pages", "-2"]), /Invalid max-pages count "-2"/);
      assert.throws(() => parseCliArgs(["--token", "TOK", "--max-pages", "abc"]), /Invalid max-pages count "abc"/);
    });

    it("should accept --diagnostics and --diag", () => {
      const p1 = parseCliArgs(["--token", "TOK", "--diagnostics"]);
      assert.equal(p1.diagnostics, true);
      const p2 = parseCliArgs(["--token", "TOK", "--diag"]);
      assert.equal(p2.diagnostics, true);
    });

    it("should accept --request-timeout and validate minimum value", () => {
      const p = parseCliArgs(["--token", "TOK", "--request-timeout", "5000"]);
      assert.equal(p.requestTimeoutMs, 5000);
      assert.throws(
        () => parseCliArgs(["--token", "TOK", "--request-timeout", "500"]),
        /Invalid request timeout "500"/
      );
      assert.throws(
        () => parseCliArgs(["--token", "TOK", "--request-timeout", "abc"]),
        /Invalid request timeout "abc"/
      );
    });

    it("should accept PERF_DIAGNOSTICS and REQUEST_TIMEOUT_MS env vars", () => {
      process.env.PERF_DIAGNOSTICS = "1";
      process.env.REQUEST_TIMEOUT_MS = "8000";
      try {
        const p = parseCliArgs(["--token", "TOK"]);
        assert.equal(p.diagnostics, true);
        assert.equal(p.requestTimeoutMs, 8000);
      } finally {
        delete process.env.PERF_DIAGNOSTICS;
        delete process.env.REQUEST_TIMEOUT_MS;
      }
    });
  });
});
