import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";

import {
  DEFAULT_FABRIQ_CDP_URL,
  getFabriqCdpUrl,
  getFabriqPage,
  getToken,
  fabriqFetch,
  closeFabriqConnection,
  setFabriqBrowserForTesting,
  setFabriqTokenForTesting,
  resetFabriqAuthForTesting,
  FabriqCdpError,
} from "../../scripts/discovery/core/fabriq-position-history.ts";
import { getEnrichCdpUrl } from "../../scripts/fabriq/enrich-wallets.mjs";
import { resolveSelectedEnrichCdpUrl } from "../../scripts/pool/enrich-selected-wallets.mjs";
interface MockTabOptions {
  url?: string;
  authStatus?: number;
  authBody?: string;
  isClosed?: boolean;
}

class MockTab {
  private _url: string;
  private _isClosed: boolean;
  public authStatus: number;
  public authBody: string;
  public evaluateCallCount = 0;

  constructor(options: MockTabOptions = {}) {
    this._url = options.url ?? "about:blank";
    this._isClosed = options.isClosed ?? false;
    this.authStatus = options.authStatus ?? 200;
    this.authBody = options.authBody ?? JSON.stringify({ token: "mock.jwt.token" });
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
    return {
      status: this.authStatus,
      text: this.authBody,
    } as unknown as T;
  }
}

class MockBrowserSession {
  private _connected = true;
  private _pages: MockTab[];
  public closeCallCount = 0;

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
    this.closeCallCount++;
    this._connected = false;
  }

  contexts(): BrowserContext[] {
    const contextMock = {
      pages: () => this._pages as unknown as Page[],
    } as unknown as BrowserContext;
    return [contextMock];
  }
}

function makeValidJwt(expiresInSec = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec, sub: "user_test" })
  ).toString("base64url");
  return `${header}.${payload}.mockSignature`;
}

describe("Fabriq CloakBrowser Integration Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetFabriqAuthForTesting();
    delete process.env.FABRIQ_CDP_URL;
    delete process.env.CLOAK_CDP_URL;
    delete process.env.FABRIQ_MAX_CHALLENGE_RETRIES;
  });

  afterEach(async () => {
    await closeFabriqConnection();
    resetFabriqAuthForTesting();
    process.env = { ...originalEnv };
  });

  // ---------------------------------------------------------------------------
  // 1. CloakBrowser CDP connection
  // ---------------------------------------------------------------------------
  it("1. CloakBrowser CDP connection: discovers Fabriq tab from active context", async () => {
    const fabriqTab = new MockTab({ url: "https://fabriq.trade/portfolio-beta" });
    const browser = new MockBrowserSession([fabriqTab]);
    setFabriqBrowserForTesting(browser as unknown as Browser, null);

    const page = await getFabriqPage();
    assert.ok(page, "Should find and return Fabriq page");
    assert.equal(page.url(), "https://fabriq.trade/portfolio-beta");
  });

  // ---------------------------------------------------------------------------
  // 2. Missing browser endpoint
  // ---------------------------------------------------------------------------
  it("2. Missing browser endpoint: rejects with CDP_UNREACHABLE referencing CloakBrowser", async () => {
    const deadEndpoint = "http://127.0.0.1:59999";
    await assert.rejects(
      async () => {
        await getFabriqPage(undefined, deadEndpoint);
      },
      (err: unknown) => {
        assert.ok(err instanceof FabriqCdpError);
        assert.equal(err.code, "CDP_UNREACHABLE");
        assert.equal(err.stageNumber, 1);
        assert.match(err.message, /CloakBrowser remote debugging endpoint is unreachable/);
        assert.match(err.recommendedAction, /npm run browser:cloak/);
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Fabriq challenge or unauthenticated page
  // ---------------------------------------------------------------------------
  it("3. Fabriq challenge or unauthenticated page: handles Cloudflare 403 and missing token", async () => {
    // 3a. Cloudflare 403 challenge waiting
    process.env.FABRIQ_MAX_CHALLENGE_RETRIES = "1";
    const challengeTab = new MockTab({
      url: "https://fabriq.trade/portfolio-beta",
      authStatus: 403,
      authBody: "<html><body>Cloudflare Challenge</body></html>",
    });
    const browserChallenge = new MockBrowserSession([challengeTab]);
    setFabriqBrowserForTesting(browserChallenge as unknown as Browser, challengeTab as unknown as Page);

    await assert.rejects(
      async () => {
        await getToken(true);
      },
      (err: unknown) => {
        assert.ok(err instanceof FabriqCdpError);
        assert.equal(err.code, "CLOUDFLARE_WAITING");
        assert.match(err.message, /Cloudflare security verification active/);
        return true;
      }
    );

    // 3b. Unauthenticated page (HTML response without token)
    delete process.env.FABRIQ_MAX_CHALLENGE_RETRIES;
    const unauthTab = new MockTab({
      url: "https://fabriq.trade/portfolio-beta",
      authStatus: 200,
      authBody: "<!DOCTYPE html><html><body>Login Required</body></html>",
    });
    const browserUnauth = new MockBrowserSession([unauthTab]);
    setFabriqBrowserForTesting(browserUnauth as unknown as Browser, unauthTab as unknown as Page);

    await assert.rejects(
      async () => {
        await getToken(true);
      },
      (err: unknown) => {
        assert.ok(err instanceof FabriqCdpError);
        assert.equal(err.code, "AUTH_SESSION_ERROR");
        assert.match(err.message, /Failed to parse JSON response/);
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Successful /auth/verify
  // ---------------------------------------------------------------------------
  it("4. Successful /auth/verify: extracts and validates session JWT", async () => {
    const validJwt = makeValidJwt(300);
    const authedTab = new MockTab({
      url: "https://fabriq.trade/portfolio-beta",
      authStatus: 200,
      authBody: JSON.stringify({ token: validJwt }),
    });
    const browser = new MockBrowserSession([authedTab]);
    setFabriqBrowserForTesting(browser as unknown as Browser, authedTab as unknown as Page);

    const token = await getToken(true);
    assert.equal(token, validJwt);
    assert.equal(authedTab.evaluateCallCount, 1);
  });

  // ---------------------------------------------------------------------------
  // 5. JWT expiration and refresh
  // ---------------------------------------------------------------------------
  it("5. JWT expiration and refresh: reuses unexpired token and refreshes when expired or forced", async () => {
    const jwt1 = makeValidJwt(300);
    const jwt2 = makeValidJwt(600);
    const authedTab = new MockTab({
      url: "https://fabriq.trade/portfolio-beta",
      authStatus: 200,
      authBody: JSON.stringify({ token: jwt1 }),
    });
    const browser = new MockBrowserSession([authedTab]);
    setFabriqBrowserForTesting(browser as unknown as Browser, authedTab as unknown as Page);

    const tokenFirst = await getToken(true);
    assert.equal(tokenFirst, jwt1);
    assert.equal(authedTab.evaluateCallCount, 1);

    // Reuse unexpired token without evaluate
    const tokenCached = await getToken(false);
    assert.equal(tokenCached, jwt1);
    assert.equal(authedTab.evaluateCallCount, 1);

    // Force refresh fetches updated token
    authedTab.authBody = JSON.stringify({ token: jwt2 });
    const tokenRefreshed = await getToken(true);
    assert.equal(tokenRefreshed, jwt2);
    assert.equal(authedTab.evaluateCallCount, 2);
  });

  // ---------------------------------------------------------------------------
  // 6. Browser disconnect
  // ---------------------------------------------------------------------------
  it("6. Browser disconnect: detects disconnected browser and closed page", async () => {
    // 6a. Page closed during /auth/verify
    let checkCount = 0;
    const closingTab = new MockTab({
      url: "https://fabriq.trade/portfolio-beta",
    });
    closingTab.isClosed = () => {
      checkCount++;
      return checkCount > 1;
    };
    const browserWithClosingTab = new MockBrowserSession([closingTab]);
    setFabriqBrowserForTesting(browserWithClosingTab as unknown as Browser, null);

    await assert.rejects(
      async () => {
        await getToken(true);
      },
      (err: unknown) => {
        assert.ok(err instanceof FabriqCdpError);
        assert.equal(err.code, "CDP_SESSION_DISCONNECTED");
        assert.match(err.message, /Fabriq tab was closed during authentication/);
        return true;
      }
    );

    // 6b. Browser disconnected cleans up stale references
    const disconnectedBrowser = new MockBrowserSession([]);
    disconnectedBrowser.disconnect();
    setFabriqBrowserForTesting(disconnectedBrowser as unknown as Browser, null);

    await assert.rejects(
      async () => {
        await getFabriqPage(undefined, "http://127.0.0.1:59998");
      },
      (err: unknown) => {
        assert.ok(err instanceof FabriqCdpError);
        assert.equal(err.code, "CDP_UNREACHABLE");
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Failed wallet API request
  // ---------------------------------------------------------------------------
  it("7. Failed wallet API request: handles 403 API session error correctly", async () => {
    const validJwt = makeValidJwt(300);
    setFabriqTokenForTesting(validJwt);

    // Mock API server returning 403
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: session invalid" }));
    });

    const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<number>();
    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer.address();
      if (addr && typeof addr === "object") {
        resolvePort(addr.port);
      }
    });
    const port = await portPromise;

    try {
      // Direct call to fabriqFetch against the mock server URL
      const customFetch = fetch;
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("https://apinew.fabriq.trade")) {
          const replaced = urlStr.replace("https://apinew.fabriq.trade", `http://127.0.0.1:${port}`);
          return customFetch(replaced, init);
        }
        return customFetch(url, init);
      }) as typeof fetch;

      await assert.rejects(
        async () => {
          await fabriqFetch("/history/test-wallet/pnl-by-pool", undefined, { maxRetries: 1 });
        },
        (err: unknown) => {
          assert.ok(err instanceof FabriqCdpError);
          assert.equal(err.code, "FABRIQ_API_ERROR");
          assert.match(err.message, /403 Forbidden on direct Fabriq API/);
          return true;
        }
      );
    } finally {
      globalThis.fetch = fetch;
      mockServer.close();
    }
  });

  // ---------------------------------------------------------------------------
  // 8. No Brave fallback
  // ---------------------------------------------------------------------------
  it("8. No Brave fallback: defaults strictly to 9223 and never silently falls back to 9222", () => {
    delete process.env.FABRIQ_CDP_URL;
    delete process.env.CLOAK_CDP_URL;

    assert.equal(DEFAULT_FABRIQ_CDP_URL, "http://127.0.0.1:9223");
    assert.equal(getFabriqCdpUrl(), "http://127.0.0.1:9223");

    process.env.FABRIQ_CDP_URL = "http://127.0.0.1:9225";
    assert.equal(getFabriqCdpUrl(), "http://127.0.0.1:9225");

    delete process.env.FABRIQ_CDP_URL;
    process.env.CLOAK_CDP_URL = "http://127.0.0.1:9226";
    assert.equal(getFabriqCdpUrl(), "http://127.0.0.1:9226");

    assert.throws(
      () => getFabriqCdpUrl("http://127.0.0.1:9222"),
      /Security violation: Refusing to connect to Brave CDP port 9222/
    );
    assert.throws(
      () => getEnrichCdpUrl("http://127.0.0.1:9222"),
      /Security violation: Refusing to connect to Brave CDP port 9222/
    );
    assert.throws(
      () => resolveSelectedEnrichCdpUrl("http://127.0.0.1:9222"),
      /Security violation: Refusing to connect to Brave CDP port 9222/
    );
  });

  // ---------------------------------------------------------------------------
  // 9. Existing enrichment compatibility
  // ---------------------------------------------------------------------------
  it("9. Existing enrichment compatibility: enrich-wallets defaults to CloakBrowser 9223", async () => {
    const content = await fs.readFile("scripts/fabriq/enrich-wallets.mjs", "utf8");
    assert.match(content, /DEFAULT_FABRIQ_CDP_URL\s*=\s*["']http:\/\/127\.0\.0\.1:9223["']/);
    assert.match(content, /process\.env\.FABRIQ_CDP_URL/);
    assert.doesNotMatch(content, /http:\/\/127\.0\.0\.1:9222/);
  });
  // ---------------------------------------------------------------------------
  // 10. Browser tab ownership and cleanup
  // ---------------------------------------------------------------------------
  it("10. Browser tab ownership and cleanup: preserves unrelated tabs and resets session references", async () => {
    const userTab1 = new MockTab({ url: "https://solscan.io" });
    const userTab2 = new MockTab({ url: "https://app.lpagent.io/portfolio" });
    const fabriqTab = new MockTab({ url: "https://fabriq.trade/portfolio-beta" });

    const browser = new MockBrowserSession([userTab1, userTab2, fabriqTab]);
    setFabriqBrowserForTesting(browser as unknown as Browser, null);

    const page = await getFabriqPage();
    assert.equal(page.url(), "https://fabriq.trade/portfolio-beta");
    assert.equal(userTab1.isClosed(), false, "User tab 1 must remain untouched and open");
    assert.equal(userTab2.isClosed(), false, "User tab 2 must remain untouched and open");

    // Close session
    await closeFabriqConnection();
    assert.equal(browser.closeCallCount, 1, "Should disconnect browser session");
    assert.equal(userTab1.isClosed(), false, "Browser disconnect should not close underlying user tab");
  });
});
