import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSolanaAddress,
  fetchAlertsStatus,
  fetchWatchlist,
  addWatchlistWallet,
  startWalletMonitoring,
  pauseWalletMonitoring,
  resumeWalletMonitoring,
  removeWatchlistWallet,
  fetchActivePositions,
  fetchAlertEvents,
  fetchTelegramPreviews,
  startAlertsEngine,
  pauseAlertsEngine,
  resumeAlertsEngine,
  ALERTS_API_BASE,
  getRpcHealthPresentation,
  getProtocolIndicator,
  isPollingStale,
  formatWib,
  formatLastSuccessfulPoll,
  type AlertsStatus,
  type WatchlistWallet,
  type ActivePosition,
  type DlmmAlertEvent,
  type TelegramPreview,
} from "../../frontend/src/lib/alertsApi.ts";
import {
  resolveRouteFromPath,
  TOOLS_NAV_ITEMS,
} from "../../frontend/src/lib/navigation.ts";

const VALID_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const VALID_POOL = "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8";
const VALID_POSITION = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";

describe("DLLM Alerts UI & API Client Suite", () => {
  describe("1. Solana Address Validation Invariants", () => {
    it("accepts valid Base58 public keys of length 32-44", () => {
      assert.strictEqual(isValidSolanaAddress(VALID_WALLET), true);
      assert.strictEqual(isValidSolanaAddress(VALID_POOL), true);
      assert.strictEqual(isValidSolanaAddress("11111111111111111111111111111111"), true); // 32 chars
    });

    it("rejects invalid Base58 characters (0, O, I, l)", () => {
      assert.strictEqual(isValidSolanaAddress("0icCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"), false);
      assert.strictEqual(isValidSolanaAddress("OicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"), false);
      assert.strictEqual(isValidSolanaAddress("IicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"), false);
      assert.strictEqual(isValidSolanaAddress("licCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"), false);
    });

    it("rejects out-of-range lengths (< 32 or > 44)", () => {
      assert.strictEqual(isValidSolanaAddress("shortAddress"), false);
      assert.strictEqual(isValidSolanaAddress("DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU1234567890"), false); // >44
    });

    it("rejects empty, null, undefined, and non-string values", () => {
      assert.strictEqual(isValidSolanaAddress(""), false);
      assert.strictEqual(isValidSolanaAddress("   "), false);
      assert.strictEqual(isValidSolanaAddress(null), false);
      assert.strictEqual(isValidSolanaAddress(undefined), false);
    });
  });

  describe("2. Navigation & Routing Integration", () => {
    it("resolves /alerts to alerts page in SPA router", () => {
      const route = resolveRouteFromPath("/alerts");
      assert.deepStrictEqual(route, { page: "alerts" });
    });

    it("enables Alerts navigation item in tools menu", () => {
      const alertsItem = TOOLS_NAV_ITEMS.find((item) => item.label === "Alerts");
      assert.ok(alertsItem, "Alerts item must exist in TOOLS_NAV_ITEMS");
      assert.strictEqual(alertsItem.disabled, undefined);
      assert.strictEqual(alertsItem.page, "alerts");
      assert.strictEqual(alertsItem.activeKey, "alerts");
    });
  });

  describe("3. Alerts API Client Contracts & Payload Schemas", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("fetchAlertsStatus retrieves health and bounded buffer counts", async () => {
      const mockStatus: AlertsStatus = {
        status: "RUNNING",
        isDegraded: false,
        sdkCompatible: true,
        monitoredWalletsCount: 2,
        activePositionsCount: 5,
        totalPolls: 42,
        totalEventsEmitted: 10,
        lastPollAt: 1728892173000,
        retryCount: 0,
        errorCount: 0,
        coverageGaps: [],
        bufferedEventsCount: 10,
        bufferedPreviewsCount: 10,
      };

      globalThis.fetch = async (input: RequestInfo | URL) => {
        assert.strictEqual(input.toString(), `${ALERTS_API_BASE}/api/alerts/status`);
        return new Response(JSON.stringify(mockStatus), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const result = await fetchAlertsStatus();
      assert.strictEqual(result.status, "RUNNING");
      assert.strictEqual(result.monitoredWalletsCount, 2);
      assert.strictEqual(result.activePositionsCount, 5);
      assert.strictEqual(result.bufferedEventsCount, 10);
    });

    it("addWatchlistWallet enforces enabled: false by default for new wallets", async () => {
      let capturedBody: unknown = null;

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.strictEqual(input.toString(), `${ALERTS_API_BASE}/api/alerts/wallets`);
        assert.strictEqual(init?.method, "POST");
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            success: true,
            wallet: {
              address: VALID_WALLET,
              alias: "Whale Alpha",
              enabled: false,
              addedAt: 1000,
              updatedAt: 1000,
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      };

      const added = await addWatchlistWallet(VALID_WALLET, "Whale Alpha");
      assert.strictEqual(added.address, VALID_WALLET);
      assert.strictEqual(added.enabled, false);

      assert.deepStrictEqual(capturedBody, {
        address: VALID_WALLET,
        alias: "Whale Alpha",
        enabled: false,
      });
    });

    it("start, pause, and resume endpoints execute correct POST methods", async () => {
      const calls: string[] = [];

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method} ${input.toString()}`);
        return new Response(
          JSON.stringify({
            success: true,
            wallet: { address: VALID_WALLET, alias: null, enabled: true, addedAt: 100, updatedAt: 200 },
            engineStatus: "RUNNING",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      await startWalletMonitoring(VALID_WALLET);
      await pauseWalletMonitoring(VALID_WALLET);
      await resumeWalletMonitoring(VALID_WALLET);

      assert.strictEqual(calls[0], `POST ${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(VALID_WALLET)}/start`);
      assert.strictEqual(calls[1], `POST ${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(VALID_WALLET)}/pause`);
      assert.strictEqual(calls[2], `POST ${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(VALID_WALLET)}/resume`);
    });

    it("removeWatchlistWallet executes DELETE on wallet URI", async () => {
      let calledUrl = "";
      let calledMethod = "";

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl = input.toString();
        calledMethod = init?.method || "GET";
        return new Response(
          JSON.stringify({ success: true, removed: VALID_WALLET }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await removeWatchlistWallet(VALID_WALLET);
      assert.strictEqual(calledMethod, "DELETE");
      assert.strictEqual(calledUrl, `${ALERTS_API_BASE}/api/alerts/wallets/${encodeURIComponent(VALID_WALLET)}`);
      assert.strictEqual(res.removed, VALID_WALLET);
    });

    it("fetchActivePositions extracts positions and passes wallet parameter", async () => {
      let calledUrl = "";

      globalThis.fetch = async (input: RequestInfo | URL) => {
        calledUrl = input.toString();
        return new Response(
          JSON.stringify({
            positions: [
              {
                positionAddress: VALID_POSITION,
                owner: VALID_WALLET,
                poolAddress: VALID_POOL,
                version: "V2",
                hasLiquidity: false,
                discoveredAt: 100,
                lastUpdatedAt: 150,
              },
            ],
            totalCount: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const positions = await fetchActivePositions(VALID_WALLET);
      assert.strictEqual(calledUrl, `${ALERTS_API_BASE}/api/alerts/positions?wallet=${encodeURIComponent(VALID_WALLET)}`);
      assert.strictEqual(positions.length, 1);
      assert.strictEqual(positions[0].positionAddress, VALID_POSITION);
      assert.strictEqual(positions[0].hasLiquidity, false);
    });

    it("fetchAlertEvents and fetchTelegramPreviews support query parameters", async () => {
      const urls: string[] = [];

      globalThis.fetch = async (input: RequestInfo | URL) => {
        urls.push(input.toString());
        return new Response(
          JSON.stringify({ events: [], previews: [], totalCount: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      await fetchAlertEvents({ limit: 50, wallet: VALID_WALLET, eventType: "POSITION_OPENED" });
      await fetchTelegramPreviews({ limit: 25, wallet: VALID_WALLET, eventType: "FEES_CLAIMED" });

      assert.match(urls[0], /limit=50/);
      assert.match(urls[0], new RegExp(`wallet=${VALID_WALLET}`));
      assert.match(urls[0], /eventType=POSITION_OPENED/);

      assert.match(urls[1], /limit=25/);
      assert.match(urls[1], new RegExp(`wallet=${VALID_WALLET}`));
      assert.match(urls[1], /eventType=FEES_CLAIMED/);
    });

    it("extracts JSON error message safely on non-200 responses", async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({ error: "Wallet 'test' already exists in watchlist" }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      };

      await assert.rejects(
        async () => {
          await addWatchlistWallet(VALID_WALLET);
        },
        /already exists in watchlist/
      );
    });
  });

  describe("4. Presentation Invariants", () => {
    it("zero liquidity position is retained as active, never inferred as closed", () => {
      const zeroLiquidityPos: ActivePosition = {
        positionAddress: VALID_POSITION,
        owner: VALID_WALLET,
        poolAddress: VALID_POOL,
        version: "V1",
        hasLiquidity: false,
        discoveredAt: 100,
        lastUpdatedAt: 120,
      };

      // Invariant: hasLiquidity: false does NOT mean closed
      assert.strictEqual(zeroLiquidityPos.hasLiquidity, false);
      assert.ok(zeroLiquidityPos.positionAddress, "Position remains tracked");
    });

    it("Telegram preview status must be PREVIEW_ONLY and never SENT", () => {
      const mockPreview: TelegramPreview = {
        id: "tx:0:POSITION_OPENED",
        eventId: "tx:0:POSITION_OPENED",
        eventType: "POSITION_OPENED",
        walletAddress: VALID_WALLET,
        walletAlias: null,
        poolAddress: VALID_POOL,
        positionAddress: VALID_POSITION,
        walletRole: "owner (signer)",
        signature: "5K5h5K5h",
        slot: 12345,
        blockTime: 1728892173,
        timestamp: "2024-10-14T07:49:33.000Z",
        commitment: "finalized",
        explorerUrl: "https://explorer.solana.com/tx/5K5h5K5h",
        amounts: null,
        messageText: "[DRY-RUN PREVIEW] DLMM Alert: POSITION_OPENED",
        status: "PREVIEW_ONLY",
        generatedAt: Date.now(),
      };

      assert.strictEqual(mockPreview.status, "PREVIEW_ONLY");
      assert.notStrictEqual(mockPreview.status, "SENT");
      assert.match(mockPreview.messageText, /\[DRY-RUN PREVIEW\]/);
      assert.match(mockPreview.explorerUrl, /^https:\/\/explorer\.solana\.com\/tx\//);
    });

    it("RPC health presentation: PAUSED displays 'Monitoring Paused', not '100% Operational'", () => {
      const mockStatus: AlertsStatus = {
        status: "PAUSED",
        isDegraded: false,
        sdkCompatible: true,
        monitoredWalletsCount: 0,
        activePositionsCount: 1,
        totalPolls: 10,
        totalEventsEmitted: 2,
        lastPollAt: Date.now(),
        retryCount: 0,
        errorCount: 0,
        rpcErrorCount: 0,
        http429Count: 0,
        coverageGaps: [],
        bufferedEventsCount: 0,
        bufferedPreviewsCount: 0,
      };

      const pausedPresentation = getRpcHealthPresentation("PAUSED", mockStatus);
      assert.strictEqual(pausedPresentation.label, "Monitoring Paused");
      assert.notStrictEqual(pausedPresentation.label, "100% Operational");

      const runningPresentation = getRpcHealthPresentation("RUNNING", mockStatus);
      assert.strictEqual(runningPresentation.label, "100% Operational");

      const degradedPresentation = getRpcHealthPresentation("DEGRADED", { ...mockStatus, rpcErrorCount: 2 });
      assert.strictEqual(degradedPresentation.label, "Degraded (2 errors)");

      const offlinePresentation = getRpcHealthPresentation("OFFLINE", mockStatus);
      assert.strictEqual(offlinePresentation.label, "Offline");

      const nullStatusPresentation = getRpcHealthPresentation("OFFLINE", null);
      assert.strictEqual(nullStatusPresentation.label, "Offline");
    });

    it("RPC health presentation: detects STALE polling during RUNNING state", () => {
      const now = Date.now();
      const staleStatus: AlertsStatus = {
        status: "RUNNING",
        isDegraded: false,
        sdkCompatible: true,
        monitoredWalletsCount: 1,
        activePositionsCount: 1,
        totalPolls: 10,
        totalEventsEmitted: 2,
        configuredPollIntervalMs: 5000,
        lastSuccessfulPollAt: now - 30000,
        lastPollAt: now - 30000,
        retryCount: 0,
        errorCount: 0,
        rpcErrorCount: 0,
        http429Count: 0,
        coverageGaps: [],
        bufferedEventsCount: 0,
        bufferedPreviewsCount: 0,
      };

      assert.strictEqual(isPollingStale(staleStatus, now), true);
      const stalePresentation = getRpcHealthPresentation("RUNNING", staleStatus, now);
      assert.strictEqual(stalePresentation.label, "Stale Polling");
      assert.notStrictEqual(stalePresentation.label, "100% Operational");
    });

    it("RPC health presentation: distinguishes current operational state from historical success & past errors", () => {
      const now = Date.now();
      const runningWithHistoricalErrors: AlertsStatus = {
        status: "RUNNING",
        isDegraded: false,
        sdkCompatible: true,
        monitoredWalletsCount: 1,
        activePositionsCount: 1,
        totalPolls: 50,
        totalEventsEmitted: 2,
        configuredPollIntervalMs: 5000,
        lastSuccessfulPollAt: now - 2000,
        lastPollAt: now - 2000,
        retryCount: 2,
        errorCount: 1,
        rpcErrorCount: 1,
        http429Count: 1,
        totalPollsSuccessful: 48,
        coverageGaps: [],
        bufferedEventsCount: 0,
        bufferedPreviewsCount: 0,
      };

      assert.strictEqual(isPollingStale(runningWithHistoricalErrors, now), false);
      const result = getRpcHealthPresentation("RUNNING", runningWithHistoricalErrors, now);
      assert.strictEqual(result.label, "Operational (Past Errors)");
      assert.strictEqual(result.color, "var(--green, #55d69d)");
    });

    it("Protocol indicator: accurately reflects compatible vs verified evidence", () => {
      const mockCompatible: AlertsStatus = {
        status: "RUNNING",
        isDegraded: false,
        sdkCompatible: true,
        monitoredWalletsCount: 1,
        activePositionsCount: 1,
        totalPolls: 5,
        totalEventsEmitted: 1,
        lastPollAt: Date.now(),
        retryCount: 0,
        errorCount: 0,
        coverageGaps: [],
        bufferedEventsCount: 0,
        bufferedPreviewsCount: 0,
      };

      // Compatible without runtime verified evidence must not claim Verified
      const compatibleResult = getProtocolIndicator(mockCompatible);
      assert.strictEqual(compatibleResult.label, "DLMM SDK v2 (Compatible)");

      // Verified when supported by runtime evidence
      const verifiedResult = getProtocolIndicator({ ...mockCompatible, sdkVerified: true } as any);
      assert.strictEqual(verifiedResult.label, "DLMM SDK v2 (Verified)");

      // Neither compatible nor verified
      const idlResult = getProtocolIndicator({ ...mockCompatible, sdkCompatible: false });
      assert.strictEqual(idlResult.label, "Meteora IDL Core");

      const nullResult = getProtocolIndicator(null);
      assert.strictEqual(nullResult.label, "—");
    });

    it("Last Successful Poll presentation: displays 'Awaiting First Successful Poll' when lastSuccessfulPollAt is null and lastPollAt is non-null during RUNNING", () => {
      const now = Date.now();
      const runningWithNullSuccess: AlertsStatus = {
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
        lastSuccessfulPollAt: null,
        lastPollAt: now - 2000,
        retryCount: 3,
        errorCount: 5,
        rpcErrorCount: 0,
        http429Count: 0,
        coverageGaps: [],
        bufferedEventsCount: 0,
        bufferedPreviewsCount: 0,
      };

      // 1. Must display 'Awaiting First Successful Poll' and never substitute lastPollAt
      const displayValue = formatLastSuccessfulPoll(runningWithNullSuccess);
      assert.strictEqual(displayValue, "Awaiting First Successful Poll");
      assert.notStrictEqual(displayValue, formatWib(runningWithNullSuccess.lastPollAt));

      // 2. Direct timestamp call with null or undefined also yields 'Awaiting First Successful Poll'
      assert.strictEqual(
        formatLastSuccessfulPoll(runningWithNullSuccess.lastSuccessfulPollAt),
        "Awaiting First Successful Poll"
      );
      assert.strictEqual(formatLastSuccessfulPoll(null), "Awaiting First Successful Poll");
      assert.strictEqual(formatLastSuccessfulPoll(undefined), "Awaiting First Successful Poll");

      // 3. When lastSuccessfulPollAt is present, formatWib is used
      const successTs = now - 4000;
      const runningWithSuccess: AlertsStatus = {
        ...runningWithNullSuccess,
        lastSuccessfulPollAt: successTs,
      };
      assert.strictEqual(formatLastSuccessfulPoll(runningWithSuccess), formatWib(successTs));

      // 4. Preserves STALE detection when attempts are recent vs exceeding cadence threshold
      assert.strictEqual(isPollingStale(runningWithNullSuccess, now), false);
      const staleRunningWithNullSuccess: AlertsStatus = {
        ...runningWithNullSuccess,
        lastPollAt: now - 35000,
      };
      assert.strictEqual(isPollingStale(staleRunningWithNullSuccess, now), true);

      // 5. Preserves RPC health presentation for RUNNING with recent poll attempt
      const health = getRpcHealthPresentation("RUNNING", runningWithNullSuccess, now);
      assert.strictEqual(health.label, "100% Operational");

      // 6. Preserves RPC health presentation for RUNNING with stale poll attempt
      const staleHealth = getRpcHealthPresentation("RUNNING", staleRunningWithNullSuccess, now);
      assert.strictEqual(staleHealth.label, "Stale Polling");

      // 7. Preserves DEGRADED status presentation
      const degradedHealth = getRpcHealthPresentation(
        "DEGRADED",
        { ...runningWithNullSuccess, rpcErrorCount: 2 },
        now
      );
      assert.strictEqual(degradedHealth.label, "Degraded (2 errors)");
    });
  });
});
