export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const METEORA_API = "https://dlmm.datapi.meteora.ag/pools";

export async function discoverTokenPools(rawTokenMint) {
  if (typeof rawTokenMint !== "string" || !rawTokenMint.trim()) {
    throw new Error("Token CA must be a non-empty string");
  }

  const tokenMint = rawTokenMint.trim();
  const url = new URL(METEORA_API);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "1000");
  url.searchParams.set("query", tokenMint);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Meteora API HTTP ${response.status}: ${response.statusText || "Request failed"}`);
  }

  const json = await response.json();
  const rawPools = Array.isArray(json?.data) ? json.data : [];
  const pools = [];

  for (const pool of rawPools) {
    if (!pool?.address) continue;

    const tokenX = pool.token_x ?? {};
    const tokenY = pool.token_y ?? {};
    const xAddress = typeof tokenX.address === "string" ? tokenX.address.trim() : "";
    const yAddress = typeof tokenY.address === "string" ? tokenY.address.trim() : "";

    const isExactTokenSol =
      (xAddress === tokenMint && yAddress === SOL_MINT) ||
      (xAddress === SOL_MINT && yAddress === tokenMint);

    if (!isExactTokenSol) continue;

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
      poolAddress: pool.address,
      pair: `${tokenX.symbol ?? "?"}/${tokenY.symbol ?? "?"}`,
      tokenMint,
      solMint: SOL_MINT,
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
    pairRule: "TOKEN_SOL_EXACT",
    discoveredAt: new Date().toISOString(),
    poolCount: pools.length,
    pools,
  };
}
