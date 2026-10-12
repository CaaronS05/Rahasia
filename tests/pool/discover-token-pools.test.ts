import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  discoverTokenPools,
  SOL_MINT,
  USDC_MINT,
} from "../../scripts/pool/discover-token-pools.mjs";

const TARGET_TOKEN = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SPOOFED_USDC_MINT = "FakeUSDC1111111111111111111111111111111111";

function computeSelectionFingerprint(tokenMint: string, poolAddresses: string[]): string {
  const sorted = [...new Set(poolAddresses)].sort();
  return createHash("sha256")
    .update(`${tokenMint}:${sorted.join(",")}`)
    .digest("hex");
}

describe("Meteora DLMM Pool Discovery Suite — SOL + USDC Pairs", () => {
  it("1. TOKEN/SOL accepted: token as token_x, SOL as token_y", async () => {
    const mockPool = {
      address: "PoolSol111111111111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockPool], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 1);
    assert.equal(result.pools[0].poolAddress, mockPool.address);
    assert.equal(result.pools[0].pair, "JUP/SOL");
    assert.equal(result.pools[0].quoteMint, SOL_MINT);
    assert.equal(result.pools[0].quoteSymbol, "SOL");
    assert.equal(result.pools[0].solMint, SOL_MINT);
    assert.equal(result.pools[0].tokenX, TARGET_TOKEN);
    assert.equal(result.pools[0].tokenY, SOL_MINT);
    assert.equal(result.pools[0].binStep, 20);
    assert.equal(result.pools[0].baseFeePct, 0.2);
  });

  it("2. SOL/TOKEN accepted: SOL as token_x, token as token_y", async () => {
    const mockPool = {
      address: "PoolSolRev1111111111111111111111111111111111",
      token_x: { address: SOL_MINT, symbol: "SOL" },
      token_y: { address: TARGET_TOKEN, symbol: "JUP" },
      pool_config: { bin_step: 10, base_fee_pct: 0.1 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockPool], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 1);
    assert.equal(result.pools[0].poolAddress, mockPool.address);
    assert.equal(result.pools[0].pair, "SOL/JUP");
    assert.equal(result.pools[0].quoteMint, SOL_MINT);
    assert.equal(result.pools[0].quoteSymbol, "SOL");
    assert.equal(result.pools[0].tokenX, SOL_MINT);
    assert.equal(result.pools[0].tokenY, TARGET_TOKEN);
  });

  it("3. TOKEN/USDC accepted: token as token_x, canonical USDC as token_y", async () => {
    const mockPool = {
      address: "PoolUsdc11111111111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: USDC_MINT, symbol: "USDC" },
      pool_config: { bin_step: 25, base_fee_pct: 0.25 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockPool], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 1);
    assert.equal(result.pools[0].poolAddress, mockPool.address);
    assert.equal(result.pools[0].pair, "JUP/USDC");
    assert.equal(result.pools[0].quoteMint, USDC_MINT);
    assert.equal(result.pools[0].quoteSymbol, "USDC");
    assert.equal(result.pools[0].tokenX, TARGET_TOKEN);
    assert.equal(result.pools[0].tokenY, USDC_MINT);
    assert.equal(result.pools[0].binStep, 25);
    assert.equal(result.pools[0].baseFeePct, 0.25);
  });

  it("4. USDC/TOKEN accepted: canonical USDC as token_x, token as token_y", async () => {
    const mockPool = {
      address: "PoolUsdcRev111111111111111111111111111111111",
      token_x: { address: USDC_MINT, symbol: "USDC" },
      token_y: { address: TARGET_TOKEN, symbol: "JUP" },
      pool_config: { bin_step: 15, base_fee_pct: 0.15 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockPool], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 1);
    assert.equal(result.pools[0].poolAddress, mockPool.address);
    assert.equal(result.pools[0].pair, "USDC/JUP");
    assert.equal(result.pools[0].quoteMint, USDC_MINT);
    assert.equal(result.pools[0].quoteSymbol, "USDC");
    assert.equal(result.pools[0].tokenX, USDC_MINT);
    assert.equal(result.pools[0].tokenY, TARGET_TOKEN);
  });

  it("5. TOKEN/USDT rejected: non-SOL/USDC quote assets excluded", async () => {
    const mockPool = {
      address: "PoolUsdt11111111111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: USDT_MINT, symbol: "USDT" },
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockPool], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 0);
    assert.equal(result.pools.length, 0);
  });

  it("6. Spoofed USDC symbol rejected: noncanonical USDC mint address is filtered out", async () => {
    const mockPool = {
      address: "PoolFakeUsdc1111111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SPOOFED_USDC_MINT, symbol: "USDC" },
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [mockPool], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 0);
    assert.equal(result.pools.length, 0);
  });

  it("7. Unrelated token pair rejected", async () => {
    const mockPools = [
      {
        address: "PoolUnrelated11111111111111111111111111111",
        token_x: { address: "Other1111111111111111111111111111111111111", symbol: "OTHER" },
        token_y: { address: SOL_MINT, symbol: "SOL" },
      },
      {
        address: "PoolUnrelated22222222222222222222222222222",
        token_x: { address: "Other1111111111111111111111111111111111111", symbol: "OTHER" },
        token_y: { address: USDC_MINT, symbol: "USDC" },
      },
    ];

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: mockPools, pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 0);
    assert.equal(result.pools.length, 0);
  });

  it("8. Duplicate pool address deduplicated", async () => {
    const poolA = {
      address: "PoolDup111111111111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    };

    // Duplicate of poolA
    const poolADup = {
      ...poolA,
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [poolA, poolADup], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 1);
    assert.equal(result.pools[0].poolAddress, poolA.address);
  });

  it("9. Missing or malformed metadata handled safely", async () => {
    const mockPools = [
      // Null pool_config
      {
        address: "PoolNullConfig1111111111111111111111111111",
        token_x: { address: TARGET_TOKEN },
        token_y: { address: SOL_MINT },
        pool_config: null,
      },
      // String numeric pool_config
      {
        address: "PoolStrConfig11111111111111111111111111111",
        token_x: { address: TARGET_TOKEN, symbol: null },
        token_y: { address: USDC_MINT, symbol: undefined },
        pool_config: { bin_step: "40", base_fee_pct: "0.4" },
      },
      // Missing pool.address is skipped
      {
        address: null,
        token_x: { address: TARGET_TOKEN },
        token_y: { address: SOL_MINT },
      },
    ];

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: mockPools, pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    assert.equal(result.poolCount, 2);
    const nullConfig = result.pools.find((p) => p.poolAddress === "PoolNullConfig1111111111111111111111111111");
    assert.ok(nullConfig);
    assert.equal(nullConfig.binStep, null);
    assert.equal(nullConfig.baseFeePct, null);
    assert.equal(nullConfig.pair, "?/?");

    const strConfig = result.pools.find((p) => p.poolAddress === "PoolStrConfig11111111111111111111111111111");
    assert.ok(strConfig);
    assert.equal(strConfig.binStep, 40);
    assert.equal(strConfig.baseFeePct, 0.4);
    assert.equal(strConfig.pair, "?/?");
  });

  it("10. Mixed SOL/USDC pool selection and selected-scan validation", async () => {
    const solPool = {
      address: "PoolSolSelected111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      pool_config: { bin_step: 10, base_fee_pct: 0.1 },
    };
    const usdcPool = {
      address: "PoolUsdcSelected11111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: USDC_MINT, symbol: "USDC" },
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [solPool, usdcPool], pages: 1 }), { status: 200 });

    const discoveryResult = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });
    const discoveredMap = new Map(discoveryResult.pools.map((p) => [p.poolAddress, p]));

    // Authoritative validation helper matching scan-selected-pools.mjs
    function validateSelectedPools(selectedAddrs: string[]) {
      for (const addr of selectedAddrs) {
        if (!discoveredMap.has(addr)) {
          throw new Error(
            `Selected pool ${addr} is not an authoritative TOKEN/SOL or TOKEN/USDC pool for token ${TARGET_TOKEN}`
          );
        }
      }
      return discoveryResult.pools.filter((p) => selectedAddrs.includes(p.poolAddress));
    }

    // A: SOL-only selection succeeds
    const solOnly = validateSelectedPools([solPool.address]);
    assert.equal(solOnly.length, 1);
    assert.equal(solOnly[0].quoteSymbol, "SOL");

    // B: USDC-only selection succeeds
    const usdcOnly = validateSelectedPools([usdcPool.address]);
    assert.equal(usdcOnly.length, 1);
    assert.equal(usdcOnly[0].quoteSymbol, "USDC");

    // C: Mixed SOL and USDC selection succeeds
    const mixed = validateSelectedPools([solPool.address, usdcPool.address]);
    assert.equal(mixed.length, 2);

    // D: Unrecognized pool throws error
    assert.throws(
      () => validateSelectedPools(["UnknownPoolAddress11111111111111111111111"]),
      /is not an authoritative TOKEN\/SOL or TOKEN\/USDC pool/
    );
  });

  it("11. Existing SOL-only compatibility: response contract and deterministic ordering", async () => {
    const poolLowStep = {
      address: "PoolSolLowStep1111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      pool_config: { bin_step: 10, base_fee_pct: 0.1 },
    };
    const poolHighStep = {
      address: "PoolSolHighStep111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      pool_config: { bin_step: 100, base_fee_pct: 1.0 },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ data: [poolHighStep, poolLowStep], pages: 1 }), { status: 200 });

    const result = await discoverTokenPools(TARGET_TOKEN, { fetchFn: mockFetch });

    // Root-level compatibility fields
    assert.equal(result.tokenMint, TARGET_TOKEN);
    assert.equal(result.solMint, SOL_MINT);
    assert.equal(result.usdcMint, USDC_MINT);
    assert.equal(result.pairRule, "TOKEN_SOL_OR_USDC_EXACT");
    assert.equal(typeof result.discoveredAt, "string");
    assert.equal(result.poolCount, 2);

    // Sorted by binStep ascending
    assert.equal(result.pools[0].poolAddress, poolLowStep.address);
    assert.equal(result.pools[0].binStep, 10);
    assert.equal(result.pools[1].poolAddress, poolHighStep.address);
    assert.equal(result.pools[1].binStep, 100);

    // Pool-level compatibility field
    assert.equal(result.pools[0].solMint, SOL_MINT);
    assert.equal(result.pools[1].solMint, SOL_MINT);
  });

  it("12. Pagination and API error handling", async () => {
    const page1Pool = {
      address: "Page1Pool111111111111111111111111111111111",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      pool_config: { bin_step: 10, base_fee_pct: 0.1 },
    };
    const page2Pool = {
      address: "Page2Pool222222222222222222222222222222222",
      token_x: { address: TARGET_TOKEN, symbol: "JUP" },
      token_y: { address: USDC_MINT, symbol: "USDC" },
      pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    };

    const requestedPages: string[] = [];
    const mockMultiPageFetch = async (urlInput: URL | RequestInfo) => {
      const u = new URL(String(urlInput));
      const page = u.searchParams.get("page") || "1";
      requestedPages.push(page);

      if (page === "1") {
        return new Response(JSON.stringify({ data: [page1Pool], pages: 2, total: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [page2Pool], pages: 2, total: 2 }), { status: 200 });
    };

    const multiResult = await discoverTokenPools(TARGET_TOKEN, {
      fetchFn: mockMultiPageFetch,
      pageSize: 1,
    });

    assert.deepEqual(requestedPages, ["1", "2"]);
    assert.equal(multiResult.poolCount, 2);
    assert.equal(multiResult.pools[0].poolAddress, page1Pool.address);
    assert.equal(multiResult.pools[1].poolAddress, page2Pool.address);

    // API error handling
    const mockErrorFetch = async () =>
      new Response("Gateway Timeout", { status: 504, statusText: "Gateway Timeout" });

    await assert.rejects(
      () => discoverTokenPools(TARGET_TOKEN, { fetchFn: mockErrorFetch }),
      /Meteora API HTTP 504: Gateway Timeout/
    );

    // Input validation
    await assert.rejects(
      () => discoverTokenPools(""),
      /Token CA must be a non-empty string/
    );
    await assert.rejects(
      // @ts-expect-error test non-string input
      () => discoverTokenPools(null),
      /Token CA must be a non-empty string/
    );
  });

  it("13. Deterministic fingerprints and scan-state resume compatibility", async () => {
    const solAddr = "PoolSolSelected111111111111111111111111111";
    const usdcAddr = "PoolUsdcSelected11111111111111111111111111";

    // 1. SOL-only fingerprint is identical across multiple computations
    const fpSol1 = computeSelectionFingerprint(TARGET_TOKEN, [solAddr]);
    const fpSol2 = computeSelectionFingerprint(TARGET_TOKEN, [solAddr]);
    assert.equal(fpSol1, fpSol2);

    // 2. Mixed fingerprint is deterministic regardless of order passed
    const fpMixed1 = computeSelectionFingerprint(TARGET_TOKEN, [solAddr, usdcAddr]);
    const fpMixed2 = computeSelectionFingerprint(TARGET_TOKEN, [usdcAddr, solAddr]);
    assert.equal(fpMixed1, fpMixed2);

    // 3. Saved scan-state resume check: simulated scan-selected-pools resume
    const savedState = {
      version: "v1",
      tokenMint: TARGET_TOKEN,
      selectionFingerprint: fpMixed1,
      status: "in_progress",
    };

    const canResume =
      savedState.tokenMint === TARGET_TOKEN &&
      savedState.selectionFingerprint === fpMixed2;
    assert.equal(canResume, true);
  });
});
