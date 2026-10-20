/**
 * Metrics Collector and Calculator for LP Agent Performance Benchmark.
 */
export class MetricsCollector {
  constructor({ mode = "unknown", scenario = "benchmark" } = {}) {
    this.mode = mode;
    this.scenario = scenario;
    this.setupStartTime = 0;
    this.setupEndTime = 0;
    this.startupDurationSec = 0;
    this.authReadinessSec = 0;
    this.extractionStartTime = 0;
    this.extractionEndTime = 0;

    this.requests = [];
    this.peakMemoryMb = 0;
    this.peakBrowserProcessMemoryMb = 0;
    this.peakBrowserHeapMb = 0;
    this.disconnectionsCount = 0;
    this.uniqueWallets = new Set();
    this.walletsByPoolPage = new Map();
    this.completedPools = new Set();
    this.completedPages = [];
    this.errors = [];
    this.startCpuUsage = null;
    this.endCpuUsage = null;
  }

  startSetup() {
    this.setupStartTime = Date.now();
  }

  endSetup() {
    this.setupEndTime = Date.now();
  }

  startExtraction() {
    this.extractionStartTime = Date.now();
    this.startCpuUsage = process.cpuUsage();
  }

  endExtraction() {
    this.extractionEndTime = Date.now();
    if (this.startCpuUsage) {
      this.endCpuUsage = process.cpuUsage(this.startCpuUsage);
    }
  }

  recordStartupDuration(sec) {
    this.startupDurationSec = Number(Number(sec).toFixed(2));
  }

  recordAuthReadiness(sec) {
    this.authReadinessSec = Number(Number(sec).toFixed(2));
  }

  recordBrowserProcessMemory(memoryMb) {
    if (typeof memoryMb === "number" && Number.isFinite(memoryMb)) {
      if (memoryMb > this.peakBrowserProcessMemoryMb) {
        this.peakBrowserProcessMemoryMb = memoryMb;
      }
    }
  }

  recordBrowserHeap(memoryMb) {
    if (typeof memoryMb === "number" && Number.isFinite(memoryMb)) {
      if (memoryMb > this.peakBrowserHeapMb) {
        this.peakBrowserHeapMb = memoryMb;
      }
      if (memoryMb > this.peakMemoryMb) {
        this.peakMemoryMb = memoryMb;
      }
    }
  }

  recordMemoryUsage(memoryMb) {
    this.recordBrowserHeap(memoryMb);
  }

  recordDisconnection() {
    this.disconnectionsCount++;
  }

  recordRequest({
    poolAddress,
    pageNumber,
    workerId,
    status,
    latencyMs,
    rowCount = 0,
    wallets = [],
    isRetry = false,
    error = null,
  }) {
    const entry = {
      timestamp: new Date().toISOString(),
      poolAddress,
      pageNumber,
      workerId,
      status,
      latencyMs: Math.round(latencyMs),
      rowCount,
      isRetry,
      error: error ? String(error) : null,
    };
    this.requests.push(entry);

    if (Array.isArray(wallets)) {
      if (status === 200 && wallets.length > 0) {
        const pageKey = `${poolAddress}:${pageNumber}`;
        this.walletsByPoolPage.set(pageKey, [...wallets]);
      }
      for (const w of wallets) {
        if (typeof w === "string" && w.trim()) {
          this.uniqueWallets.add(w.trim());
        }
      }
    }

    if (status === 200) {
      this.completedPages.push({ poolAddress, pageNumber, rowCount });
    } else if (error) {
      this.errors.push({ poolAddress, pageNumber, error: String(error) });
    }
  }

  recordPoolCompletion(poolAddress) {
    this.completedPools.add(poolAddress);
  }

  getSummary() {
    const setupDurationSec =
      this.setupEndTime > this.setupStartTime
        ? (this.setupEndTime - this.setupStartTime) / 1000
        : 0;

    const extractionDurationSec =
      this.extractionEndTime > this.extractionStartTime
        ? (this.extractionEndTime - this.extractionStartTime) / 1000
        : 0;

    const totalWallClockSec =
      (this.setupEndTime > 0 && this.setupStartTime > 0 ? (this.setupEndTime - this.setupStartTime) : 0) / 1000 +
      extractionDurationSec;

    const successfulPages = this.requests.filter((r) => r.status === 200).length;
    const totalRequests = this.requests.length;
    const http429Count = this.requests.filter((r) => r.status === 429).length;
    const http403Count = this.requests.filter((r) => r.status === 403).length;
    const http401Count = this.requests.filter((r) => r.status === 401).length;
    const retriesCount = this.requests.filter((r) => r.isRetry).length;
    const networkErrors = this.requests.filter(
      (r) => !r.status || r.status >= 500 || r.error
    ).length;
    const totalRowsExtracted = this.requests.reduce(
      (sum, r) => sum + (r.rowCount || 0),
      0
    );

    const minutes = extractionDurationSec > 0 ? extractionDurationSec / 60 : 0;
    const pagesPerMinute = minutes > 0 ? Number((successfulPages / minutes).toFixed(2)) : 0;
    const rowsPerMinute = minutes > 0 ? Number((totalRowsExtracted / minutes).toFixed(2)) : 0;

    // Latency calculations (only for valid latency values)
    const latencies = this.requests
      .map((r) => r.latencyMs)
      .filter((l) => typeof l === "number" && Number.isFinite(l) && l >= 0)
      .sort((a, b) => a - b);

    let avgLatencyMs = 0;
    let p95LatencyMs = 0;
    if (latencies.length > 0) {
      const sum = latencies.reduce((a, b) => a + b, 0);
      avgLatencyMs = Number((sum / latencies.length).toFixed(1));
      const p95Idx = Math.min(
        latencies.length - 1,
        Math.floor(latencies.length * 0.95)
      );
      p95LatencyMs = latencies[p95Idx];
    }

    const cpuUserMs = this.endCpuUsage ? Number((this.endCpuUsage.user / 1000).toFixed(1)) : 0;
    const cpuSystemMs = this.endCpuUsage ? Number((this.endCpuUsage.system / 1000).toFixed(1)) : 0;
    const cpuTotalMs = Number((cpuUserMs + cpuSystemMs).toFixed(1));
    const nodeRssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));

    return {
      mode: this.mode,
      scenario: this.scenario,
      setupDurationSec: Number(setupDurationSec.toFixed(2)),
      startupDurationSec: this.startupDurationSec,
      authReadinessSec: this.authReadinessSec,
      extractionDurationSec: Number(extractionDurationSec.toFixed(2)),
      totalWallClockSec: Number(totalWallClockSec.toFixed(2)),
      successfulPages,
      failedPages: totalRequests - successfulPages,
      pagesPerMinute,
      totalRowsExtracted,
      rowsPerMin: rowsPerMinute,
      rowsPerMinute,
      httpRequestsTotal: totalRequests,
      http429Count,
      http403Count,
      http401Count,
      disconnectionsCount: this.disconnectionsCount,
      retriesCount,
      avgLatencyMs,
      p95LatencyMs,
      completedPoolsCount: this.completedPools.size,
      completedPagesCount: this.completedPages.length,
      deduplicatedWalletCount: this.uniqueWallets.size,
      peakMemoryMb: Number(this.peakMemoryMb.toFixed(2)),
      peakBrowserHeapMb: Number(this.peakBrowserHeapMb.toFixed(2)),
      peakBrowserProcessMemoryMb: Number(this.peakBrowserProcessMemoryMb.toFixed(2)),
      nodeRssMb,
      walletsByPoolPage: Object.fromEntries(this.walletsByPoolPage.entries()),
      extractedWallets: Array.from(this.uniqueWallets),
    };
  }
}
