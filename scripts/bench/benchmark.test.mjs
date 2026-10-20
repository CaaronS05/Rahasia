import test from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rate-limiter.mjs";
import { MetricsCollector } from "./metrics.mjs";
import { processPoolPages } from "./worker.mjs";
import { formatComparisonTable } from "./run-benchmark.mjs";

test("RateLimiter enforces concurrency limit and dispatch queue", async () => {
  const limiter = new RateLimiter({ maxInFlight: 2, minIntervalMs: 20 });
  let active = 0;
  let maxObservedActive = 0;

  const tasks = Array.from({ length: 6 }).map(async (_, idx) => {
    await limiter.acquireSlot();
    active++;
    maxObservedActive = Math.max(maxObservedActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    limiter.releaseSlot();
  });

  await Promise.all(tasks);
  limiter.destroy();

  assert.ok(maxObservedActive <= 2, `Observed active concurrency ${maxObservedActive} exceeded 2`);
});

test("RateLimiter handles backoff correctly", async () => {
  const limiter = new RateLimiter({ maxInFlight: 1, minIntervalMs: 0 });
  limiter.triggerBackoff(50);

  const start = Date.now();
  await limiter.acquireSlot();
  const elapsed = Date.now() - start;
  limiter.releaseSlot();
  limiter.destroy();

  assert.ok(elapsed >= 40, `Elapsed time ${elapsed}ms was shorter than backoff duration`);
});

test("MetricsCollector accurately calculates latency, p95, pages/min, and unique wallets", () => {
  const collector = new MetricsCollector({ mode: "Mode Test", scenario: "Mock" });
  collector.startSetup();
  collector.endSetup();

  collector.startExtraction();
  // Simulate 4 requests with distinct latencies and wallets
  collector.recordRequest({
    poolAddress: "poolA",
    pageNumber: 1,
    workerId: "w1",
    status: 200,
    latencyMs: 100,
    rowCount: 20,
    wallets: ["wallet1", "wallet2", "wallet3"],
  });
  collector.recordRequest({
    poolAddress: "poolA",
    pageNumber: 2,
    workerId: "w1",
    status: 200,
    latencyMs: 200,
    rowCount: 20,
    wallets: ["wallet3", "wallet4"], // wallet3 is duplicate
  });
  collector.recordRequest({
    poolAddress: "poolA",
    pageNumber: 3,
    workerId: "w1",
    status: 429,
    latencyMs: 50,
    rowCount: 0,
    wallets: [],
    error: "Too Many Requests",
  });
  collector.recordRequest({
    poolAddress: "poolA",
    pageNumber: 3,
    workerId: "w1",
    status: 200,
    latencyMs: 300,
    rowCount: 10,
    wallets: ["wallet5"],
    isRetry: true,
  });
  collector.endExtraction();

  const summary = collector.getSummary();
  assert.equal(summary.successfulPages, 3);
  assert.equal(summary.httpRequestsTotal, 4);
  assert.equal(summary.http429Count, 1);
  assert.equal(summary.retriesCount, 1);
  assert.equal(summary.totalRowsExtracted, 50);
  assert.equal(summary.deduplicatedWalletCount, 5); // wallet1, 2, 3, 4, 5
  assert.equal(summary.avgLatencyMs, 162.5); // (100+200+50+300)/4 = 162.5
  assert.equal(summary.p95LatencyMs, 300);
});

test("Worker processPoolPages bounded execution with mock page", async () => {
  const collector = new MetricsCollector({ mode: "MockWorker", scenario: "Test" });
  const limiter = new RateLimiter({ maxInFlight: 1, minIntervalMs: 5 });

  const fetchedPages = [];
  const mockPage = {
    evaluate: async (fn, args) => {
      fetchedPages.push(args.pageNumber);
      return {
        ok: true,
        status: 200,
        latencyMs: 15,
        rows: [{ owner: `mock-wallet-${args.pageNumber}` }],
        wallets: [`mock-wallet-${args.pageNumber}`],
        pagination: { page: args.pageNumber, totalPages: 10 },
      };
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ metrics: [{ name: "JSHeapUsedSize", value: 10 * 1024 * 1024 }] }),
        detach: async () => {},
      }),
    }),
  };

  await processPoolPages({
    workerId: "test-worker",
    page: mockPage,
    poolAddress: "mock-pool",
    startPage: 1,
    pageBudget: 3,
    rateLimiter: limiter,
    metricsCollector: collector,
    minPageDelay: 10,
    maxPageDelay: 20,
  });

  limiter.destroy();

  assert.deepEqual(fetchedPages, [1, 2, 3], "Should fetch exactly pages 1, 2, and 3");
  const summary = collector.getSummary();
  assert.equal(summary.successfulPages, 3);
  assert.equal(summary.totalRowsExtracted, 3);
  assert.equal(summary.deduplicatedWalletCount, 3);
  assert.equal(summary.peakMemoryMb, 10);
});

test("formatComparisonTable formats Mode B vs Mode D Markdown cleanly", () => {
  const medB = {
    durationSec: 5.2,
    totalDurationSec: 6.5,
    pagesPerMin: 40,
    rowsPerMin: 800,
    avgLatencyMs: 120,
    p95LatencyMs: 150,
    http429: 0,
    http403: 0,
    http401: 0,
    failedPages: 0,
    peakProcessMemoryMb: 760,
    peakHeapMb: 95,
    nodeRssMb: 45,
    cpuTotalMs: 120,
    retries: 0,
    uniqueWallets: 80,
  };
  const medD = {
    durationSec: 4.8,
    totalDurationSec: 6.0,
    pagesPerMin: 45,
    rowsPerMin: 900,
    avgLatencyMs: 110,
    p95LatencyMs: 140,
    http429: 0,
    http403: 0,
    http401: 0,
    failedPages: 0,
    peakProcessMemoryMb: 350,
    peakHeapMb: 85,
    nodeRssMb: 46,
    cpuTotalMs: 115,
    retries: 0,
    uniqueWallets: 80,
  };

  const table = formatComparisonTable(medB, medD);
  assert.ok(table.includes("| Metric | Brave 2 Tabs | CloakBrowser 2 Tabs |"));
  assert.ok(table.includes("Median extraction duration"));
  assert.ok(table.includes("5.2s"));
  assert.ok(table.includes("4.8s"));
  assert.ok(table.includes("760 MB"));
  assert.ok(table.includes("350 MB"));
});

test("Two-tab parallel extraction guarantees disjoint page sets and zero duplicate assignments", async () => {
  const collector = new MetricsCollector({ mode: "Parallel-2-Tab", scenario: "DisjointCheck" });
  const limiter = new RateLimiter({ maxInFlight: 2, minIntervalMs: 5 });

  const pool1 = "pool-sol-111";
  const pool2 = "pool-usdc-222";
  const assignedPagesPool1 = [];
  const assignedPagesPool2 = [];

  const mockPage1 = {
    evaluate: async (fn, args) => {
      assignedPagesPool1.push(`${args.poolAddress}:${args.pageNumber}`);
      return {
        ok: true,
        status: 200,
        latencyMs: 10,
        rows: [{ owner: `sol-wallet-${args.pageNumber}` }],
        wallets: [`sol-wallet-${args.pageNumber}`],
      };
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ metrics: [{ name: "JSHeapUsedSize", value: 5 * 1024 * 1024 }] }),
        detach: async () => {},
      }),
    }),
  };

  const mockPage2 = {
    evaluate: async (fn, args) => {
      assignedPagesPool2.push(`${args.poolAddress}:${args.pageNumber}`);
      return {
        ok: true,
        status: 200,
        latencyMs: 12,
        rows: [{ owner: `usdc-wallet-${args.pageNumber}` }],
        wallets: [`usdc-wallet-${args.pageNumber}`],
      };
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ metrics: [{ name: "JSHeapUsedSize", value: 6 * 1024 * 1024 }] }),
        detach: async () => {},
      }),
    }),
  };

  const w1 = processPoolPages({
    workerId: "Tab-1",
    page: mockPage1,
    poolAddress: pool1,
    startPage: 1,
    pageBudget: 4,
    rateLimiter: limiter,
    metricsCollector: collector,
    minPageDelay: 5,
    maxPageDelay: 10,
  });

  const w2 = processPoolPages({
    workerId: "Tab-2",
    page: mockPage2,
    poolAddress: pool2,
    startPage: 1,
    pageBudget: 4,
    rateLimiter: limiter,
    metricsCollector: collector,
    minPageDelay: 5,
    maxPageDelay: 10,
  });

  await Promise.all([w1, w2]);
  limiter.destroy();

  // Verify page assignments are exactly pages 1 to 4 with zero overlap between pools
  assert.deepEqual(assignedPagesPool1, [
    `${pool1}:1`,
    `${pool1}:2`,
    `${pool1}:3`,
    `${pool1}:4`,
  ]);
  assert.deepEqual(assignedPagesPool2, [
    `${pool2}:1`,
    `${pool2}:2`,
    `${pool2}:3`,
    `${pool2}:4`,
  ]);

  const allAssignments = [...assignedPagesPool1, ...assignedPagesPool2];
  const uniqueAssignments = new Set(allAssignments);
  assert.equal(allAssignments.length, 8);
  assert.equal(uniqueAssignments.size, 8, "Zero duplicate page assignments across parallel workers");

  const summary = collector.getSummary();
  assert.equal(summary.successfulPages, 8);
  assert.equal(summary.deduplicatedWalletCount, 8);
});

test("Jaccard wallet parity accurately calculates similarity between sets", () => {
  const walletsA = ["w1", "w2", "w3", "w4"];
  const walletsB = ["w2", "w3", "w4", "w5"];
  const setA = new Set(walletsA);
  const setB = new Set(walletsB);

  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = ((intersection / union) * 100).toFixed(1);

  assert.equal(intersection, 3);
  assert.equal(union, 5);
  assert.equal(jaccard, "60.0");
});
