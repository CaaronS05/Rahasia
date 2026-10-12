export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const METEORA_API = "https://dlmm.datapi.meteora.ag/pools";

export async function discoverTokenPools(rawTokenMint, options = {}) {
  if (typeof rawTokenMint !== "string" || !rawTokenMint.trim()) {
    throw new Error("Token CA must be a non-empty string");
  }

  const tokenMint = rawTokenMint.trim();
  const fetchFn = typeof options?.fetchFn === "function" ? options.fetchFn : fetch;
  const pageSize = Number.isInteger(options?.pageSize) && options.pageSize > 0 ? options.pageSize : 1000;
  const maxPages = Number.isInteger(options?.maxPages) && options.maxPages > 0 ? options.maxPages : 20;

  let page = 1;
  let totalPages = 1;
  const rawPools = [];

  do {
    const url = new URL(METEORA_API);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("query", tokenMint);

    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`Meteora API HTTP ${response.status}: ${response.statusText || "Request failed"}`);
    }

    const json = await response.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    rawPools.push(...data);

    const reportedPages =
      Number(json?.pages) ||
      Number(json?.total_pages) ||
      Number(json?.pagination?.totalPages) ||
      Number(json?.pagination?.pages) ||
      (Number(json?.total) ? Math.ceil(Number(json.total) / pageSize) : 0);

    if (reportedPages > 0) {
      totalPages = Math.min(reportedPages, maxPages);
    } else if (data.length < pageSize) {
      totalPages = page;
    } else {
      totalPages = Math.min(page + 1, maxPages);
    }

    if (data.length === 0) {
      break;
    }

    page++;
  } while (page <= totalPages);

  const seenPoolAddresses = new Set();
  const pools = [];

  for (const pool of rawPools) {
    if (!pool?.address) continue;
    const poolAddress = String(pool.address).trim();
    if (!poolAddress || seenPoolAddresses.has(poolAddress)) continue;

    const tokenX = pool.token_x ?? {};
    const tokenY = pool.token_y ?? {};
    const xAddress = typeof tokenX.address === "string" ? tokenX.address.trim() : "";
    const yAddress = typeof tokenY.address === "string" ? tokenY.address.trim() : "";

    let quoteMint = null;
    let quoteSymbol = null;

    if (xAddress === tokenMint && yAddress === SOL_MINT) {
      quoteMint = SOL_MINT;
      quoteSymbol = "SOL";
    } else if (xAddress === SOL_MINT && yAddress === tokenMint) {
      quoteMint = SOL_MINT;
      quoteSymbol = "SOL";
    } else if (xAddress === tokenMint && yAddress === USDC_MINT) {
      quoteMint = USDC_MINT;
      quoteSymbol = "USDC";
    } else if (xAddress === USDC_MINT && yAddress === tokenMint) {
      quoteMint = USDC_MINT;
      quoteSymbol = "USDC";
    } else {
      continue;
    }

    seenPoolAddresses.add(poolAddress);

    const rawBinStep = pool.pool_config?.bin_step;
    const binStep =
      typeof rawBinStep === "number" && Number.isFinite(rawBinStep)
        ? rawBinStep
        : rawBinStep !== undefined && rawBinStep !== null && !isNaN(Number(rawBinStep))
        ? Number(rawBinStep)
        : null;

    const rawBaseFeePct = pool.pool_config?.base_fee_pct;
    const baseFeePct =
      typeof rawBaseFeePct === "number" && Number.isFinite(rawBaseFeePct)
        ? rawBaseFeePct
        : rawBaseFeePct !== undefined && rawBaseFeePct !== null && !isNaN(Number(rawBaseFeePct))
        ? Number(rawBaseFeePct)
        : null;

    pools.push({
      poolAddress,
      pair: `${tokenX.symbol ?? "?"}/${tokenY.symbol ?? "?"}`,
      tokenMint,
      solMint: SOL_MINT,
      quoteMint,
      quoteSymbol,
      tokenX: xAddress,
      tokenY: yAddress,
      binStep,
      baseFeePct,
    });
  }

  pools.sort((a, b) => {
    if (a.binStep !== null && b.binStep !== null) {
      if (a.binStep !== b.binStep) return a.binStep - b.binStep;
    } else if (a.binStep !== null && b.binStep === null) {
      return -1;
    } else if (a.binStep === null && b.binStep !== null) {
      return 1;
    }
    return a.poolAddress.localeCompare(b.poolAddress);
  });

  return {
    tokenMint,
    solMint: SOL_MINT,
    usdcMint: USDC_MINT,
    pairRule: "TOKEN_SOL_OR_USDC_EXACT",
    discoveredAt: new Date().toISOString(),
    poolCount: pools.length,
    pools,
  };
}
