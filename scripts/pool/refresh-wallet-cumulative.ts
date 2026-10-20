import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fetchWalletPoolCumulativeAggregates,
  extractPoolSearchQueries,
  type FabriqPoolCumulativeAggregate,
} from "../analytics/fabriq-analytics-client.ts";
import { acquireCanonicalLock } from "../pipeline/canonical-lock.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const MASTER_CUMULATIVE_PATH = path.join(ROOT, "data/master/pool-cumulative-history.json");
const SCANNED_POOLS_PATH = path.join(ROOT, "data/master/scanned-pools.json");

export interface RefreshWalletCumulativeOptions {
  onLog?: (msg: string) => void;
}

export interface RefreshWalletCumulativeResult {
  poolAddress: string;
  wallet: string;
  pair?: string;
  aggregate: FabriqPoolCumulativeAggregate;
  isNew: boolean;
  totalAggregatesInMaster: number;
}

/**
 * Perform a targeted refresh for a single wallet + single pool cumulative aggregate.
 * Reads from Fabriq CDP bridge via GET /history/<wallet>/pnl-by-pool without rescanning
 * the pool or rebuilding trade history. Atomically merges the result into
 * data/master/pool-cumulative-history.json with advisory locking.
 */
export async function refreshWalletCumulative(
  poolAddress: string,
  wallet: string,
  options?: RefreshWalletCumulativeOptions
): Promise<RefreshWalletCumulativeResult> {
  const log = options?.onLog ?? ((msg: string) => console.log(msg));

  const cleanPool = String(poolAddress || "").trim();
  const cleanWallet = String(wallet || "").trim();

  if (!cleanPool) {
    throw new Error("Invalid poolAddress: pool address is required");
  }
  if (!cleanWallet) {
    throw new Error("Invalid wallet: wallet address is required");
  }

  log(`[TARGETED-CUMULATIVE] Fetching Fabriq cumulative aggregate for ${cleanWallet} in pool ${cleanPool}...`);

  // 1. Resolve pair symbol from scanned pools if available to enable server search
  let resolvedPair: string | undefined;
  try {
    const rawScanned = await fs.readFile(SCANNED_POOLS_PATH, "utf8");
    const scannedData = JSON.parse(rawScanned) as { pools?: Array<{ poolAddress?: string; pair?: string }> };
    const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
    const foundPool = pools.find((p) => p?.poolAddress === cleanPool);
    if (foundPool?.pair) {
      resolvedPair = foundPool.pair;
    }
  } catch {
    // optional enrichment fallback
  }

  const poolQueries = resolvedPair ? extractPoolSearchQueries(resolvedPair) : undefined;

  // 2. Fetch official Fabriq aggregate for this wallet and pool
  const aggregates = await fetchWalletPoolCumulativeAggregates(
    cleanWallet,
    [cleanPool],
    { onLog: log, poolQueries }
  );

  const matched = aggregates.find(
    (a) => a.poolAddress.toLowerCase() === cleanPool.toLowerCase()
  );

  if (!matched) {
    throw new Error(
      `No Fabriq cumulative aggregate found for wallet ${cleanWallet} in pool ${cleanPool}`
    );
  }

  // Ensure normalized poolAddress casing
  matched.poolAddress = cleanPool;
  matched.wallet = cleanWallet;
  if (!matched.pair && resolvedPair) {
    matched.pair = resolvedPair;
  }

  // 3. Atomically update data/master/pool-cumulative-history.json under canonical lock
  const releaseLock = await acquireCanonicalLock("refresh-wallet-cumulative");
  let isNew = false;
  let totalAggregatesInMaster = 0;

  try {
    let masterData: { version: string; updatedAt: string; aggregates: FabriqPoolCumulativeAggregate[] } = {
      version: "v1",
      updatedAt: new Date().toISOString(),
      aggregates: [],
    };

    try {
      const rawMaster = await fs.readFile(MASTER_CUMULATIVE_PATH, "utf8");
      const parsed = JSON.parse(rawMaster);
      if (parsed && typeof parsed === "object") {
        masterData = {
          version: parsed.version || "v1",
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          aggregates: Array.isArray(parsed.aggregates) ? parsed.aggregates : [],
        };
      }
    } catch {
      // master file not yet existing or empty, start fresh
    }

    const key = `${matched.poolAddress}::${matched.wallet}`;
    const aggMap = new Map<string, FabriqPoolCumulativeAggregate>();

    for (const a of masterData.aggregates) {
      if (a?.poolAddress && a?.wallet) {
        aggMap.set(`${a.poolAddress}::${a.wallet}`, a);
      }
    }

    isNew = !aggMap.has(key);
    aggMap.set(key, matched);

    const sortedAggregates = Array.from(aggMap.values()).sort((a, b) => {
      const pComp = a.poolAddress.localeCompare(b.poolAddress);
      if (pComp !== 0) return pComp;
      return a.wallet.localeCompare(b.wallet);
    });

    totalAggregatesInMaster = sortedAggregates.length;

    const finalOutput = {
      version: "v1",
      updatedAt: new Date().toISOString(),
      aggregates: sortedAggregates,
    };

    const nonce = randomUUID();
    const tmpPath = `${MASTER_CUMULATIVE_PATH}.${nonce}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(finalOutput, null, 2), "utf8");
    await fs.rename(tmpPath, MASTER_CUMULATIVE_PATH);

    log(`[TARGETED-CUMULATIVE] Canonical pool-cumulative-history.json updated (total: ${totalAggregatesInMaster}, isNew: ${isNew})`);
  } finally {
    await releaseLock();
  }

  // 4. Also update local scan checkpoint and artifact if present
  try {
    await updateLocalScanArtifacts(cleanPool, cleanWallet, matched, log);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[TARGETED-CUMULATIVE] Note: local scan directory update skipped: ${msg}`);
  }

  return {
    poolAddress: cleanPool,
    wallet: cleanWallet,
    pair: matched.pair,
    aggregate: matched,
    isNew,
    totalAggregatesInMaster,
  };
}

async function updateLocalScanArtifacts(
  poolAddress: string,
  wallet: string,
  aggregate: FabriqPoolCumulativeAggregate,
  log: (msg: string) => void
) {
  // Find which tokenMint owns this pool
  let tokenMint: string | null = null;
  try {
    const rawScanned = await fs.readFile(SCANNED_POOLS_PATH, "utf8");
    const scanned = JSON.parse(rawScanned) as { pools?: Array<{ poolAddress?: string; tokenMint?: string }> };
    const pools = Array.isArray(scanned?.pools) ? scanned.pools : [];
    const p = pools.find((x) => x?.poolAddress === poolAddress);
    if (p?.tokenMint) tokenMint = p.tokenMint;
  } catch {}

  if (!tokenMint) return;

  const selectedScanDir = path.join(
    ROOT,
    "data/discovery/pool-scanner",
    tokenMint,
    "selected-scan"
  );

  try {
    await fs.access(selectedScanDir);
  } catch {
    return; // No local scan dir
  }

  // Update selected-scan/pool-cumulative-history.json if exists or create it
  const scanCumulativePath = path.join(selectedScanDir, "pool-cumulative-history.json");
  try {
    let scanCumulativeData: {
      version: string;
      tokenMint?: string;
      updatedAt: string;
      aggregates: FabriqPoolCumulativeAggregate[];
    } = {
      version: "v1",
      tokenMint,
      updatedAt: new Date().toISOString(),
      aggregates: [],
    };
    try {
      const raw = await fs.readFile(scanCumulativePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: string;
        tokenMint?: string;
        updatedAt?: string;
        aggregates?: FabriqPoolCumulativeAggregate[];
      };
      if (Array.isArray(parsed?.aggregates)) {
        scanCumulativeData = {
          version: parsed.version || "v1",
          tokenMint: parsed.tokenMint || tokenMint,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          aggregates: parsed.aggregates,
        };
      }
    } catch {}

    const key = `${aggregate.poolAddress}::${aggregate.wallet}`;
    const scanMap = new Map<string, FabriqPoolCumulativeAggregate>();
    for (const a of scanCumulativeData.aggregates) {
      if (a?.poolAddress && a?.wallet) {
        scanMap.set(`${a.poolAddress}::${a.wallet}`, a);
      }
    }
    scanMap.set(key, aggregate);
    scanCumulativeData.aggregates = Array.from(scanMap.values());
    scanCumulativeData.updatedAt = new Date().toISOString();

    const tmpPath = `${scanCumulativePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(scanCumulativeData, null, 2), "utf8");
    await fs.rename(tmpPath, scanCumulativePath);
  } catch {}

  // Update wallet checkpoint if present in trade-history-checkpoints
  try {
    const checkpointsParent = path.join(selectedScanDir, "trade-history-checkpoints");
    const fingerprints = await fs.readdir(checkpointsParent);
    for (const fp of fingerprints) {
      const cpFile = path.join(checkpointsParent, fp, `${wallet}.json`);
      try {
        const rawCp = await fs.readFile(cpFile, "utf8");
        const cp = JSON.parse(rawCp) as {
          pools?: Array<{ poolAddress?: string; cumulative?: FabriqPoolCumulativeAggregate | null }>;
        };
        if (Array.isArray(cp?.pools)) {
          let updatedCp = false;
          for (const poolObj of cp.pools) {
            if (poolObj?.poolAddress === poolAddress) {
              poolObj.cumulative = aggregate;
              updatedCp = true;
            }
          }
          if (updatedCp) {
            const tmpCp = `${cpFile}.${randomUUID()}.tmp`;
            await fs.writeFile(tmpCp, JSON.stringify(cp, null, 2), "utf8");
            await fs.rename(tmpCp, cpFile);
            log(`[TARGETED-CUMULATIVE] Updated checkpoint for ${wallet} in ${fp}`);
          }
        }
      } catch {}
    }
  } catch {}
  // Update wallet checkpoint if present in cumulative-checkpoints
  try {
    const cumCheckpointsParent = path.join(selectedScanDir, "cumulative-checkpoints");
    const fingerprints = await fs.readdir(cumCheckpointsParent);
    for (const fp of fingerprints) {
      const cpFile = path.join(cumCheckpointsParent, fp, `${wallet}.json`);
      try {
        const rawCp = await fs.readFile(cpFile, "utf8");
        const cp = JSON.parse(rawCp) as {
          version?: string;
          selectionFingerprint?: string;
          wallet?: string;
          status?: string;
          aggregates?: FabriqPoolCumulativeAggregate[];
        };
        const existingAggs = Array.isArray(cp?.aggregates) ? cp.aggregates : [];
        const aggMap = new Map<string, FabriqPoolCumulativeAggregate>();
        for (const a of existingAggs) {
          if (a?.poolAddress) aggMap.set(a.poolAddress, a);
        }
        aggMap.set(poolAddress, aggregate);
        const updatedCp = {
          version: cp?.version || "v1",
          selectionFingerprint: cp?.selectionFingerprint || fp,
          wallet,
          status: "completed",
          aggregates: Array.from(aggMap.values()),
          fetchedAt: new Date().toISOString(),
        };
        const tmpCp = `${cpFile}.${randomUUID()}.tmp`;
        await fs.writeFile(tmpCp, JSON.stringify(updatedCp, null, 2), "utf8");
        await fs.rename(tmpCp, cpFile);
        log(`[TARGETED-CUMULATIVE] Updated cumulative checkpoint for ${wallet} in ${fp}`);
      } catch {}
    }
  } catch {}
}

// CLI Execution Support
async function main() {
  const args = process.argv.slice(2);
  let poolAddress: string | null = null;
  let wallet: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pool" && i + 1 < args.length) {
      poolAddress = args[++i];
    } else if (arg === "--wallet" && i + 1 < args.length) {
      wallet = args[++i];
    }
  }

  if (!poolAddress || !wallet) {
    console.error("Usage: node --experimental-strip-types scripts/pool/refresh-wallet-cumulative.ts --pool <poolAddress> --wallet <wallet>");
    process.exit(1);
  }

  try {
    const result = await refreshWalletCumulative(poolAddress, wallet, {
      onLog: (msg) => console.log(msg),
    });
    console.log("\n========================================");
    console.log("FABRIQ TARGETED CUMULATIVE REFRESH OK");
    console.log("========================================");
    console.log(`Pool Address:       ${result.poolAddress}`);
    console.log(`Wallet:             ${result.wallet}`);
    console.log(`Pair:               ${result.pair || "unknown"}`);
    console.log(`Positions:          ${result.aggregate.positionCount}`);
    console.log(`Cumulative PnL $:   $${result.aggregate.cumulativePnlUsd?.toFixed(2)}`);
    console.log(`Cumulative PnL %:   ${result.aggregate.cumulativePnlPct?.toFixed(2)}%`);
    console.log(`Duration (s):       ${result.aggregate.cumulativeDurationSeconds}`);
    console.log(`Earliest Open:      ${result.aggregate.earliestOpenedAt}`);
    console.log(`Latest Close:       ${result.aggregate.latestClosedAt}`);
    console.log(`Total Add $:        $${result.aggregate.totalAddUsd?.toFixed(2)}`);
    console.log(`Total Rem $:        $${result.aggregate.totalRemUsd?.toFixed(2)}`);
    console.log(`Total Fee $:        $${result.aggregate.totalFeeUsd?.toFixed(2)}`);
    console.log(`Total Master Aggs:  ${result.totalAggregatesInMaster}`);
    console.log("========================================");
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TARGETED-CUMULATIVE] ERROR: ${msg}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("refresh-wallet-cumulative.ts")) {
  main();
}
