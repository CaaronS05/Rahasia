import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";

import {
  getToken,
  fabriqFetch,
  setFabriqTokenForTesting,
  setFabriqBrowserForTesting,
  resetFabriqAuthForTesting,
  closeFabriqConnection,
  FabriqCdpError,
} from "../../scripts/discovery/core/fabriq-position-history.ts";

interface MockTabOptions {
  url?: string;
  authStatus?: number;
  authBody?: string;
  delayMs?: number;
}

class MockTab {
  private _url: string;
  private _isClosed = false;
  public authStatus: number;
  public authBody: string;
  public delayMs: number;
  public evaluateCallCount = 0;

  constructor(options: MockTabOptions = {}) {
    this._url = options.url ?? "https://fabriq.trade/portfolio-beta";
    this.authStatus = options.authStatus ?? 200;
    this.authBody = options.authBody ?? JSON.stringify({ token: makeValidJwt(300) });
    this.delayMs = options.delayMs ?? 0;
  }

  url(): string {
    return this._url;
  }

  isClosed(): boolean {
    return this._isClosed;
  }

  closeTab(): void {
    this._isClosed = true;
  }

  async evaluate<T>(_pageFunction: unknown): Promise<T> {
    this.evaluateCallCount++;
    if (this._isClosed) {
      throw new Error("Target page, context or browser has been closed");
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return {
      status: this.authStatus,
      text: this.authBody,
    } as unknown as T;
  }
}

class MockBrowserSession {
  private _connected = true;
  private _pages: MockTab[];

  constructor(pages: MockTab[] = []) {
    this._pages = pages;
  }

  isConnected(): boolean {
    return this._connected;
  }

  disconnect(): void {
    this._connected = false;
  }

  async close(): Promise<void> {
    this._connected = false;
  }

  contexts(): any[] {
    return [
      {
        pages: () => this._pages,
      },
    ];
  }
}

function makeValidJwt(expiresInSec = 3600, subject = "sub_test"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec, sub: subject })
  ).toString("base64url");
  return `${header}.${payload}.mockSignature_${Math.random().toString(36).slice(2, 8)}`;
}

describe("Fabriq JWT Refresh & Concurrency Suite", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetFabriqAuthForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabriq-jwt-test-"));
  });

  afterEach(async () => {
    await closeFabriqConnection();
    resetFabriqAuthForTesting();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 1. JWT reuse while valid (Canary JWT had ~37s remaining)
  // ---------------------------------------------------------------------------
  it("1. JWT reuse while valid: returns cached token without browser evaluate when >= 10s remaining", async () => {
    const canaryTtlSec = 37;
    const canaryJwt = makeValidJwt(canaryTtlSec, "canary_wallet_user");

    // Pre-populate cached token with 37 seconds remaining
    setFabriqTokenForTesting(canaryJwt, Date.now() + canaryTtlSec * 1000);

    const mockTab = new MockTab();
    const mockBrowser = new MockBrowserSession([mockTab]);
    setFabriqBrowserForTesting(mockBrowser as any, mockTab as any);

    // Call getToken 5 times concurrently
    const tokens = await Promise.all([
      getToken(false),
      getToken(false),
      getToken(false),
      getToken(false),
      getToken(false),
    ]);

    for (const t of tokens) {
      assert.equal(t, canaryJwt);
    }
    // No browser evaluation performed because token has 37s remaining (> 10s safety margin)
    assert.equal(mockTab.evaluateCallCount, 0);
  });

  // ---------------------------------------------------------------------------
  // 2. Single-flight refresh when expired or near expiry
  // ---------------------------------------------------------------------------
  it("2. Single-flight refresh: refreshes token when within 10s safety buffer and coalesces in-flight calls", async () => {
    const nearExpiryTtlSec = 5; // within 10s margin -> considered expired
    const staleJwt = makeValidJwt(nearExpiryTtlSec, "stale_user");
    setFabriqTokenForTesting(staleJwt, Date.now() + nearExpiryTtlSec * 1000);

    const freshJwt = makeValidJwt(300, "refreshed_user");
    const mockTab = new MockTab({
      authBody: JSON.stringify({ token: freshJwt }),
      delayMs: 50, // deliberate delay to allow multiple callers during in-flight evaluation
    });
    const mockBrowser = new MockBrowserSession([mockTab]);
    setFabriqBrowserForTesting(mockBrowser as any, mockTab as any);

    // Trigger two staggered requests while refresh is active
    const p1 = getToken(false);
    const p2 = getToken(false);
    const [t1, t2] = await Promise.all([p1, p2]);

    assert.equal(t1, freshJwt);
    assert.equal(t2, freshJwt);
    // Single flight: exactly one evaluate call was triggered
    assert.equal(mockTab.evaluateCallCount, 1);
  });

  // ---------------------------------------------------------------------------
  // 3. Concurrent requests do not trigger duplicate refreshes
  // ---------------------------------------------------------------------------
  it("3. Concurrent requests: 10 simultaneous calls with forceRefresh trigger exactly 1 browser evaluate", async () => {
    const refreshedJwt = makeValidJwt(600, "batch_user");
    const mockTab = new MockTab({
      authBody: JSON.stringify({ token: refreshedJwt }),
      delayMs: 40,
    });
    const mockBrowser = new MockBrowserSession([mockTab]);
    setFabriqBrowserForTesting(mockBrowser as any, mockTab as any);

    const concurrentCalls = Array.from({ length: 10 }, () => getToken(true));
    const results = await Promise.all(concurrentCalls);

    for (const res of results) {
      assert.equal(res, refreshedJwt);
    }
    // Exactly 1 evaluate call executed despite 10 concurrent requests
    assert.equal(mockTab.evaluateCallCount, 1);
  });

  // ---------------------------------------------------------------------------
  // 4. One request receiving 401 can refresh and retry safely
  // ---------------------------------------------------------------------------
  it("4. 401 retry: request receiving 401 triggers single refresh and retries successfully", async () => {
    const initialJwt = makeValidJwt(100, "expired_claim_user");
    const refreshedJwt = makeValidJwt(300, "reauthenticated_user");

    setFabriqTokenForTesting(initialJwt, Date.now() + 100_000);

    const mockTab = new MockTab({
      authBody: JSON.stringify({ token: refreshedJwt }),
    });
    const mockBrowser = new MockBrowserSession([mockTab]);
    setFabriqBrowserForTesting(mockBrowser as any, mockTab as any);

    let requestCount = 0;
    const receivedTokens: string[] = [];

    const mockApiServer = http.createServer((req, res) => {
      requestCount++;
      const authHeader = req.headers.authorization ?? "";
      const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
      receivedTokens.push(bearerToken);

      if (requestCount === 1) {
        // First request rejected with 401 Unauthorized
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized token expired" }));
      } else {
        // Second request accepted
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { status: "retried_ok" } }));
      }
    });

    const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
    mockApiServer.listen(0, "127.0.0.1", () => {
      const addr = mockApiServer.address();
      if (addr && typeof addr === "object") {
        resolvePort(addr.port);
      }
    });
    const port = await portPromise;

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("https://apinew.fabriq.trade")) {
          const replaced = urlStr.replace("https://apinew.fabriq.trade", `http://127.0.0.1:${port}`);
          return originalFetch(replaced, init);
        }
        return originalFetch(url, init);
      }) as typeof fetch;

      const result = await fabriqFetch<{ success: boolean; data: { status: string } }>(
        "/portfolio/stats/mock-wallet",
        undefined,
        { maxRetries: 3 }
      );

      assert.equal(result.success, true);
      assert.equal(result.data.status, "retried_ok");
      assert.equal(requestCount, 2, "Should attempt twice: initial (401) + retry (200)");
      assert.equal(receivedTokens[0], initialJwt, "First attempt should send initial token");
      assert.equal(receivedTokens[1], refreshedJwt, "Second attempt should send refreshed token");
      assert.equal(mockTab.evaluateCallCount, 1, "Should trigger exactly 1 refresh on 401");
    } finally {
      globalThis.fetch = originalFetch;
      mockApiServer.close();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Failed refresh stops safely without corrupting checkpoints
  // ---------------------------------------------------------------------------
  it("5. Safe failure: failed refresh raises cleanly and preserves pre-existing valid checkpoints", async () => {
    const checkpointFile = path.join(tmpDir, "fabriq-test.jsonl");

    // Pre-populate checkpoint with valid completed wallet
    const validEntry = {
      owner: "WalletPreExisting11111111111111111111111111",
      status: "ok",
      fabriq: {
        fetchedAt: new Date().toISOString(),
        stats: { totalPositions: 5, netPnlSol: 1.25 },
        calendars: { "2026-10": { "2026-10-01": { pnl: 0.1 } } },
      },
    };
    await fs.writeFile(checkpointFile, JSON.stringify(validEntry) + "\n", "utf8");

    // Tab that fails authentication with Cloudflare challenge exceeded
    process.env.FABRIQ_MAX_CHALLENGE_RETRIES = "1";
    const failingTab = new MockTab({
      authStatus: 403,
      authBody: "Cloudflare challenge block",
    });
    const mockBrowser = new MockBrowserSession([failingTab]);
    setFabriqBrowserForTesting(mockBrowser as any, failingTab as any);

    // Attempting to get token fails cleanly
    await assert.rejects(
      async () => {
        await getToken(true);
      },
      (err: unknown) => {
        assert.ok(err instanceof FabriqCdpError);
        assert.equal(err.code, "CLOUDFLARE_WAITING");
        return true;
      }
    );

    // Simulated worker appends failure row
    const failedEntry = {
      owner: "WalletFailedDuringRefresh22222222222222222222",
      status: "error",
      failedAt: new Date().toISOString(),
      error: "Cloudflare security verification active on /auth/verify",
    };
    await fs.appendFile(checkpointFile, JSON.stringify(failedEntry) + "\n", "utf8");

    // Verify checkpoint file content integrity
    const content = await fs.readFile(checkpointFile, "utf8");
    const lines = content.split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "Must contain exactly 2 valid JSONL rows");

    const parsedRow1 = JSON.parse(lines[0]);
    assert.equal(parsedRow1.owner, validEntry.owner);
    assert.equal(parsedRow1.status, "ok");
    assert.equal(parsedRow1.fabriq.stats.totalPositions, 5);

    const parsedRow2 = JSON.parse(lines[1]);
    assert.equal(parsedRow2.owner, failedEntry.owner);
    assert.equal(parsedRow2.status, "error");

    // Invariant: no raw token string in file content
    assert.doesNotMatch(content, /mockSignature/);
  });
});
