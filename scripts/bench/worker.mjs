/**
 * Benchmark Worker for LP Agent Top LPers extraction.
 * Performs read-only fetches inside a Playwright page with timing, pacing, and rate limiting.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function fetchTopLpersPage(page, poolAddress, pageNumber) {
  return await page.evaluate(
    async ({ poolAddress, pageNumber }) => {
      const url =
        `https://api.lpagent.io/api/v1/pools/${poolAddress}/top-lpers` +
        `?page=${pageNumber}` +
        `&pageSize=20` +
        `&order_by=total_pnl_native` +
        `&sort_order=desc`;

      const start = performance.now();
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: {
            Accept: "application/json",
          },
        });

        const latencyMs = Math.round(performance.now() - start);
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
        const text = await response.text();

        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            latencyMs,
            retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
            error: `LP Agent HTTP ${response.status}: ${text.slice(0, 150)}`,
            rows: [],
            wallets: [],
          };
        }

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return {
            ok: false,
            status: response.status,
            latencyMs,
            error: "Failed to parse JSON response",
            rows: [],
            wallets: [],
          };
        }

        if (json?.status !== "success" || !Array.isArray(json?.data)) {
          return {
            ok: false,
            status: response.status,
            latencyMs,
            error: `Unexpected payload shape for page ${pageNumber}`,
            rows: [],
            wallets: [],
          };
        }

        const wallets = [];
        for (const r of json.data) {
          const w =
            typeof r?.owner === "string" && r.owner.trim()
              ? r.owner.trim()
              : typeof r?.wallet === "string" && r.wallet.trim()
              ? r.wallet.trim()
              : null;
          if (w) wallets.push(w);
        }

        return {
          ok: true,
          status: response.status,
          latencyMs,
          rows: json.data,
          wallets,
          pagination: json.pagination ?? null,
        };
      } catch (err) {
        const latencyMs = Math.round(performance.now() - start);
        return {
          ok: false,
          status: 0,
          latencyMs,
          error: err?.message || String(err),
          rows: [],
          wallets: [],
        };
      }
    },
    { poolAddress, pageNumber }
  );
}

export async function samplePageMemoryMb(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const perf = await cdp.send("Performance.getMetrics");
    const jsHeap = perf.metrics.find((m) => m.name === "JSHeapUsedSize");
    await cdp.detach();
    if (jsHeap?.value) {
      return jsHeap.value / (1024 * 1024);
    }
  } catch {
    // CDP performance metrics are best-effort
  }
  return null;
}

export async function processPoolPages({
  workerId,
  page,
  poolAddress,
  startPage = 1,
  pageBudget = 5,
  rateLimiter,
  metricsCollector,
  minPageDelay = 350,
  maxPageDelay = 800,
  maxRetries = 3,
  sampleProcessMemory = null,
}) {
  const endPage = startPage + pageBudget - 1;

  for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
    // Intra-worker delay between pages (except first page if startPage === 1)
    if (pageNum > startPage) {
      const delay = randomDelay(minPageDelay, maxPageDelay);
      await sleep(delay);
    }

    let attempt = 0;
    let success = false;

    while (attempt <= maxRetries && !success) {
      const isRetry = attempt > 0;
      await rateLimiter.acquireSlot();
      let res;
      try {
        res = await fetchTopLpersPage(page, poolAddress, pageNum);
      } finally {
        rateLimiter.releaseSlot();
      }

      // Sample memory opportunistically
      const memMb = await samplePageMemoryMb(page);
      if (memMb !== null) {
        metricsCollector.recordMemoryUsage(memMb);
      }
      if (typeof sampleProcessMemory === "function") {
        const procMb = sampleProcessMemory();
        if (procMb) metricsCollector.recordBrowserProcessMemory(procMb);
      }
      if (res.ok) {
        success = true;
        metricsCollector.recordRequest({
          poolAddress,
          pageNumber: pageNum,
          workerId,
          status: res.status,
          latencyMs: res.latencyMs,
          rowCount: res.rows?.length || 0,
          wallets: res.wallets || [],
          isRetry,
        });
      } else {
        metricsCollector.recordRequest({
          poolAddress,
          pageNumber: pageNum,
          workerId,
          status: res.status,
          latencyMs: res.latencyMs,
          rowCount: 0,
          wallets: [],
          isRetry,
          error: res.error,
        });

        if (res.status === 429) {
          const waitMs =
            res.retryAfterSec && res.retryAfterSec > 0
              ? res.retryAfterSec * 1000
              : Math.min(10000, 2000 * Math.pow(2, attempt));
          rateLimiter.triggerBackoff(waitMs);
          await sleep(waitMs);
          attempt++;
        } else if (res.status === 403) {
          // Authentication or Cloudflare barrier: stop retrying this page
          break;
        } else {
          // Network or transient 5xx error
          const backoff = Math.min(5000, 1000 * Math.pow(2, attempt));
          await sleep(backoff);
          attempt++;
        }
      }
    }

    if (!success) {
      console.warn(
        `[Worker ${workerId}] Page ${pageNum} for pool ${poolAddress} failed after attempts.`
      );
    }
  }

  metricsCollector.recordPoolCompletion(poolAddress);
}
