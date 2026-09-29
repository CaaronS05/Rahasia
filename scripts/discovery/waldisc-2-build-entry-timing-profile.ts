import fs from "node:fs";
import path from "node:path";

export type PositionTimingStatus =
  | "VALID"
  | "NEGATIVE_ENTRY_DELAY"
  | "MISSING_POSITION_OPEN"
  | "MISSING_POOL"
  | "MISSING_POOL_CREATION";

export interface PositionTimingRecord {
  wallet: string;
  position: string;
  pool: string | null;

  positionOpenedAt: string | null;
  positionOpenedAtUnix: number | null;

  poolCreatedAt: string | null;
  poolCreatedAtUnix: number | null;
  poolCreationSource: string | null;

  entryDelaySeconds: number | null;
  entryDelayMinutes: number | null;
  entryDelayHours: number | null;
  entryDelayDays: number | null;

  status: PositionTimingStatus;
}

export interface WalletTimingAggregate {
  wallet: string;
  positionCount: number;
  validEntryTimingCount: number;
  entryTimingCoveragePct: number;

  minEntryDelayHours: number | null;
  p25EntryDelayHours: number | null;
  medianEntryDelayHours: number | null;
  p75EntryDelayHours: number | null;
  maxEntryDelayHours: number | null;

  meanEntryDelayHours: number | null;
}

export interface EntryTimingProfileOutput {
  generatedAt: string;

  population: {
    wallets: number;
    positions: number;
    validPositions: number;
    invalidPositions: number;
  };

  poolCreationCoverage: {
    pools: number;
    available: number;
  };

  cohortDistribution: {
    positionEntryDelayHours: {
      min: number | null;
      p10: number | null;
      p25: number | null;
      median: number | null;
      p75: number | null;
      p90: number | null;
      max: number | null;
    };
    walletMedianEntryDelayHours: {
      p25: number | null;
      median: number | null;
      p75: number | null;
    };
  };

  wallets: WalletTimingAggregate[];
  positions: PositionTimingRecord[];
}

interface CliOptions {
  waldiscDir: string;
  poolCreationCache: string;
  outputFile: string;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    }
  }

  return {
    waldiscDir:
      options["waldisc-dir"] ||
      path.resolve("data/discovery/waldisc-2"),
    poolCreationCache:
      options["pool-creation-cache"] ||
      options.cache ||
      path.resolve("data/discovery/waldisc-2/pool-creation-times.json"),
    outputFile:
      options["output-file"] ||
      options.output ||
      path.resolve("data/discovery/waldisc-2/entry-timing-profile.json"),
  };
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: any): void {
  ensureDirectory(filePath);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function tryReadJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTimestampToMs(ts: any): number | null {
  if (!ts) return null;
  if (typeof ts === "number") {
    return ts > 1e11 ? ts : ts * 1000;
  }
  if (typeof ts !== "string") return null;
  let s = ts.trim();
  if (!s) return null;
  if (!s.endsWith("Z") && !s.includes("+") && !s.includes("-", 10)) {
    s = s.replace(" ", "T") + "Z";
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function formatHoursDisplay(val: number | null): string {
  if (val === null) return "N/A";
  if (val < 1) {
    return `${val.toFixed(2)}h (${(val * 60).toFixed(1)}m)`;
  }
  if (val < 48) {
    return `${val.toFixed(2)}h`;
  }
  return `${val.toFixed(2)}h (${(val / 24).toFixed(1)}d)`;
}

export function buildEntryTimingProfile(): EntryTimingProfileOutput {
  const opts = parseCliArgs();

  console.log("==================================================");
  console.log("WALDISC-2 — ENTRY TIMING PROFILE");
  console.log("==================================================");

  // 1. Load authoritative pool creation timestamp cache
  const cacheData = tryReadJson(opts.poolCreationCache);
  if (!cacheData || !Array.isArray(cacheData.pools)) {
    throw new Error(
      `Failed to load authoritative pool creation timestamp cache from: ${opts.poolCreationCache}`
    );
  }

  const poolMap = new Map<
    string,
    {
      createdAt: number | null;
      createdAtIso: string | null;
      source: string | null;
      status: string;
    }
  >();

  for (const p of cacheData.pools) {
    poolMap.set(p.pool, {
      createdAt: typeof p.createdAt === "number" ? p.createdAt : null,
      createdAtIso: p.createdAtIso || null,
      source: p.source || null,
      status: p.status || "UNAVAILABLE",
    });
  }

  console.log(`Pool Cache Loaded     : ${poolMap.size} pool(s)`);

  // 2. Discover validated cohort wallets
  const behaviourPath = path.join(opts.waldiscDir, "wallet-behaviour-dataset.json");
  const behaviourData = tryReadJson(behaviourPath);
  let walletAddresses: string[] = [];

  if (Array.isArray(behaviourData?.wallets)) {
    walletAddresses = behaviourData.wallets.map((w: any) => w.wallet);
  } else if (fs.existsSync(opts.waldiscDir)) {
    const entries = fs.readdirSync(opts.waldiscDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const posFile = path.join(opts.waldiscDir, entry.name, "positions.json");
      if (fs.existsSync(posFile)) {
        walletAddresses.push(entry.name);
      }
    }
    walletAddresses.sort();
  }

  console.log(`Cohort Wallets        : ${walletAddresses.length}`);

  // 3. Process each wallet and position
  const allPositionRecords: PositionTimingRecord[] = [];
  const walletAggregates: WalletTimingAggregate[] = [];
  let negativeEntryDelayCount = 0;

  for (const walletAddr of walletAddresses) {
    const posPath = path.join(opts.waldiscDir, walletAddr, "positions.json");
    const rawPositions = tryReadJson(posPath);
    const positionsList: any[] = Array.isArray(rawPositions) ? rawPositions : [];

    const walletValidDelaysHours: number[] = [];

    for (const pos of positionsList) {
      const positionAddress = pos.position || pos.address || "unknown";
      const poolAddress = pos.pool || null;

      // Extract lifecycle open timestamp
      const rawOpenedAt = pos.openedAt || pos.opened_at || pos.fabriqSummary?.openedAt || null;
      const openMs = parseTimestampToMs(rawOpenedAt);

      const positionOpenedAtUnix = openMs !== null ? Math.floor(openMs / 1000) : null;
      const positionOpenedAt = openMs !== null ? new Date(openMs).toISOString() : (rawOpenedAt || null);

      // Match pool creation timestamp
      const poolRecord = poolAddress ? poolMap.get(poolAddress) : undefined;
      const poolCreatedAtUnix = poolRecord?.createdAt ?? null;
      const poolCreatedAt = poolRecord?.createdAtIso ?? null;
      const poolCreationSource = poolRecord?.source ?? null;

      let status: PositionTimingStatus;
      let entryDelaySeconds: number | null = null;
      let entryDelayMinutes: number | null = null;
      let entryDelayHours: number | null = null;
      let entryDelayDays: number | null = null;

      if (!poolAddress) {
        status = "MISSING_POOL";
      } else if (positionOpenedAtUnix === null) {
        status = "MISSING_POSITION_OPEN";
      } else if (poolCreatedAtUnix === null) {
        status = "MISSING_POOL_CREATION";
      } else {
        entryDelaySeconds = positionOpenedAtUnix - poolCreatedAtUnix;
        entryDelayMinutes = entryDelaySeconds / 60;
        entryDelayHours = entryDelaySeconds / 3600;
        entryDelayDays = entryDelaySeconds / 86400;

        if (entryDelaySeconds < 0) {
          status = "NEGATIVE_ENTRY_DELAY";
          negativeEntryDelayCount++;
        } else {
          status = "VALID";
          walletValidDelaysHours.push(entryDelayHours);
        }
      }

      allPositionRecords.push({
        wallet: walletAddr,
        position: positionAddress,
        pool: poolAddress,

        positionOpenedAt,
        positionOpenedAtUnix,

        poolCreatedAt,
        poolCreatedAtUnix,
        poolCreationSource,

        entryDelaySeconds,
        entryDelayMinutes,
        entryDelayHours,
        entryDelayDays,

        status,
      });
    }

    // Compute wallet aggregates
    const positionCount = positionsList.length;
    const validCount = walletValidDelaysHours.length;
    const coveragePct =
      positionCount > 0 ? Number(((validCount / positionCount) * 100).toFixed(2)) : 0;

    let minH: number | null = null;
    let p25H: number | null = null;
    let medianH: number | null = null;
    let p75H: number | null = null;
    let maxH: number | null = null;
    let meanH: number | null = null;

    if (validCount > 0) {
      walletValidDelaysHours.sort((a, b) => a - b);
      minH = walletValidDelaysHours[0];
      maxH = walletValidDelaysHours[walletValidDelaysHours.length - 1];
      p25H = percentile(walletValidDelaysHours, 25);
      medianH = percentile(walletValidDelaysHours, 50);
      p75H = percentile(walletValidDelaysHours, 75);
      meanH = walletValidDelaysHours.reduce((sum, v) => sum + v, 0) / validCount;
    }

    walletAggregates.push({
      wallet: walletAddr,
      positionCount,
      validEntryTimingCount: validCount,
      entryTimingCoveragePct: coveragePct,

      minEntryDelayHours: minH,
      p25EntryDelayHours: p25H,
      medianEntryDelayHours: medianH,
      p75EntryDelayHours: p75H,
      maxEntryDelayHours: maxH,

      meanEntryDelayHours: meanH,
    });
  }

  // 4. Compute cohort distributions
  const allValidDelaysHours = allPositionRecords
    .filter((p) => p.status === "VALID" && p.entryDelayHours !== null)
    .map((p) => p.entryDelayHours as number)
    .sort((a, b) => a - b);

  const cohortPositionDistribution = {
    min: allValidDelaysHours.length > 0 ? allValidDelaysHours[0] : null,
    p10: percentile(allValidDelaysHours, 10),
    p25: percentile(allValidDelaysHours, 25),
    median: percentile(allValidDelaysHours, 50),
    p75: percentile(allValidDelaysHours, 75),
    p90: percentile(allValidDelaysHours, 90),
    max: allValidDelaysHours.length > 0 ? allValidDelaysHours[allValidDelaysHours.length - 1] : null,
  };

  const walletMedians = walletAggregates
    .map((w) => w.medianEntryDelayHours)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);

  const cohortWalletMedianDistribution = {
    p25: percentile(walletMedians, 25),
    median: percentile(walletMedians, 50),
    p75: percentile(walletMedians, 75),
  };

  const totalPositions = allPositionRecords.length;
  const validPositionsCount = allValidDelaysHours.length;
  const invalidPositionsCount = totalPositions - validPositionsCount;
  const overallCoveragePct =
    totalPositions > 0 ? Number(((validPositionsCount / totalPositions) * 100).toFixed(2)) : 0;

  const output: EntryTimingProfileOutput = {
    generatedAt: new Date().toISOString(),

    population: {
      wallets: walletAddresses.length,
      positions: totalPositions,
      validPositions: validPositionsCount,
      invalidPositions: invalidPositionsCount,
    },

    poolCreationCoverage: {
      pools: cacheData.poolCount ?? poolMap.size,
      available: cacheData.coverage?.available ?? poolMap.size,
    },

    cohortDistribution: {
      positionEntryDelayHours: cohortPositionDistribution,
      walletMedianEntryDelayHours: cohortWalletMedianDistribution,
    },

    wallets: walletAggregates,
    positions: allPositionRecords,
  };

  // Write output artifact
  atomicWriteJson(opts.outputFile, output);

  // -------------------------------------------------------------------------
  // Terminal Report
  // -------------------------------------------------------------------------
  console.log("\nWALDISC-2 — ENTRY TIMING PROFILE\n");
  console.log(`Wallets                 : ${walletAddresses.length}`);
  console.log(`Positions               : ${totalPositions}`);
  console.log(`Valid Entry Timing      : ${validPositionsCount}`);
  console.log(`Invalid Entry Timing    : ${invalidPositionsCount}`);
  console.log(`Coverage                : ${overallCoveragePct}%\n`);

  console.log("POSITION ENTRY DELAY");
  console.log(`P10                     : ${formatHoursDisplay(cohortPositionDistribution.p10)}`);
  console.log(`P25                     : ${formatHoursDisplay(cohortPositionDistribution.p25)}`);
  console.log(`Median                  : ${formatHoursDisplay(cohortPositionDistribution.median)}`);
  console.log(`P75                     : ${formatHoursDisplay(cohortPositionDistribution.p75)}`);
  console.log(`P90                     : ${formatHoursDisplay(cohortPositionDistribution.p90)}\n`);

  console.log("WALLET MEDIAN ENTRY DELAY");
  console.log(`P25                     : ${formatHoursDisplay(cohortWalletMedianDistribution.p25)}`);
  console.log(`Median                  : ${formatHoursDisplay(cohortWalletMedianDistribution.median)}`);
  console.log(`P75                     : ${formatHoursDisplay(cohortWalletMedianDistribution.p75)}\n`);

  console.log(`Negative Entry Delays   : ${negativeEntryDelayCount}\n`);

  const isComplete = invalidPositionsCount === 0 && overallCoveragePct === 100;
  console.log(`Result:\n${isComplete ? "COMPLETE" : "PARTIAL"}`);
  console.log("==================================================");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("waldisc-2-build-entry-timing-profile.ts")) {
  try {
    buildEntryTimingProfile();
  } catch (err) {
    console.error("Fatal error building entry timing profile:", err);
    process.exit(1);
  }
}
