import fs from "node:fs";
import path from "node:path";

const METEORA_API_BASE = "https://dlmm.datapi.meteora.ag";
const DEFAULT_PACING_MS = 250;
const BACKOFF_SCHEDULE_MS = [2000, 4000, 8000, 16000, 30000];
const TERMINAL_BACKOFF_MS = 30000;

export type PoolTimestampStatus =
  | "AVAILABLE_VALID"
  | "MISSING"
  | "ZERO"
  | "INVALID"
  | "REQUEST_FAILED";

export type CoverageAssessment =
  | "HIGH_COVERAGE"
  | "PARTIAL_COVERAGE"
  | "INSUFFICIENT_COVERAGE";

interface CliOptions {
  waldiscDir: string;
  outputFile: string;
  pacingMs: number;
}

export interface PoolAuditRecord {
  pool: string;
  httpStatus: number;
  field: string | null;
  rawValue: unknown;
  timestamp: number | null;
  iso: string | null;
  status: PoolTimestampStatus;
}

export interface MeteoraPoolCreatedAtAuditOutput {
  generatedAt: string;
  apiBase: string;
  poolPopulation: {
    total: number;
  };
  responseSchemaObservation: {
    topLevelKeys: string[];
    candidateCreationField: string | null;
  };
  coverage: {
    valid: number;
    missing: number;
    zero: number;
    invalid: number;
    requestFailed: number;
    coveragePct: number;
  };
  pools: PoolAuditRecord[];
  assessment: CoverageAssessment;
  notes: string;
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
    outputFile:
      options.output ||
      options["output-file"] ||
      path.resolve("data/discovery/waldisc-2/meteora-pool-created-at-audit.json"),
    pacingMs: Math.max(0, Number(options["pacing-ms"] || DEFAULT_PACING_MS)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function getDynamicCohortPools(waldiscDir: string): string[] {
  const behaviourPath = path.join(waldiscDir, "wallet-behaviour-dataset.json");
  const behaviourData = tryReadJson(behaviourPath);
  const poolSet = new Set<string>();

  if (Array.isArray(behaviourData?.wallets)) {
    for (const w of behaviourData.wallets) {
      const walletAddr = w.wallet;
      const positionsPath = path.join(waldiscDir, walletAddr, "positions.json");
      const positions = tryReadJson(positionsPath);

      if (Array.isArray(positions)) {
        for (const p of positions) {
          if (p.pool && typeof p.pool === "string" && p.pool.trim().length > 0) {
            poolSet.add(p.pool.trim());
          }
        }
      } else {
        const poolsPath = path.join(waldiscDir, walletAddr, "pools.json");
        const pools = tryReadJson(poolsPath);
        if (Array.isArray(pools)) {
          for (const p of pools) {
            const poolId = p.pool_id || p.pool?.id;
            if (poolId && typeof poolId === "string") {
              poolSet.add(poolId.trim());
            }
          }
        }
      }
    }
  }

  // Fallback scan if behaviour dataset is not loaded
  if (poolSet.size === 0 && fs.existsSync(waldiscDir)) {
    const entries = fs.readdirSync(waldiscDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const posPath = path.join(waldiscDir, entry.name, "positions.json");
      const positions = tryReadJson(posPath);
      if (Array.isArray(positions)) {
        for (const p of positions) {
          if (p.pool && typeof p.pool === "string") {
            poolSet.add(p.pool.trim());
          }
        }
      }
    }
  }

  return Array.from(poolSet).sort();
}

async function fetchPoolWithBackoff(
  poolAddress: string
): Promise<{ status: number; data: any | null }> {
  const url = `${METEORA_API_BASE}/pools/${poolAddress}`;
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Meteora-Scanner-Coverage-Audit/1.0",
        },
      });

      if (res.status === 429) {
        const delay =
          attempt < BACKOFF_SCHEDULE_MS.length
            ? BACKOFF_SCHEDULE_MS[attempt]
            : TERMINAL_BACKOFF_MS;
        attempt++;
        console.warn(
          `\n[429 Rate Limit] Pool ${poolAddress} — backing off for ${delay / 1000}s (retry #${attempt})...`
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        return { status: res.status, data: null };
      }

      const json = await res.json();
      return { status: res.status, data: json };
    } catch (err: any) {
      const delay =
        attempt < BACKOFF_SCHEDULE_MS.length
          ? BACKOFF_SCHEDULE_MS[attempt]
          : TERMINAL_BACKOFF_MS;
      attempt++;
      console.warn(
        `\n[Network Error] Pool ${poolAddress} (${err.message}) — retrying in ${delay / 1000}s...`
      );
      await sleep(delay);
    }
  }
}

function parseCandidateTimestamp(
  raw: unknown
): { valid: boolean; timestamp: number | null; iso: string | null; reason: PoolTimestampStatus } {
  if (raw === undefined || raw === null) {
    return { valid: false, timestamp: null, iso: null, reason: "MISSING" };
  }

  if (raw === 0 || raw === "0") {
    return { valid: false, timestamp: 0, iso: null, reason: "ZERO" };
  }

  let tsNum: number;
  if (typeof raw === "number") {
    tsNum = raw;
  } else if (typeof raw === "string") {
    tsNum = Number(raw);
  } else {
    return { valid: false, timestamp: null, iso: null, reason: "INVALID" };
  }

  if (isNaN(tsNum) || tsNum <= 0) {
    return { valid: false, timestamp: null, iso: null, reason: "INVALID" };
  }

  // Handle both seconds (e.g. 1715892541) and milliseconds (e.g. 1715892541000)
  let ms: number;
  if (tsNum < 1e11) {
    ms = tsNum * 1000;
  } else {
    ms = tsNum;
  }

  const dateObj = new Date(ms);
  if (isNaN(dateObj.getTime())) {
    return { valid: false, timestamp: tsNum, iso: null, reason: "INVALID" };
  }

  // Check if timestamp is in the future (with 5 minute tolerance)
  const now = Date.now() + 5 * 60 * 1000;
  if (ms > now) {
    return { valid: false, timestamp: tsNum, iso: dateObj.toISOString(), reason: "INVALID" };
  }

  return {
    valid: true,
    timestamp: tsNum,
    iso: dateObj.toISOString(),
    reason: "AVAILABLE_VALID",
  };
}

export async function runMeteoraPoolCreatedAtAudit(): Promise<MeteoraPoolCreatedAtAuditOutput> {
  const opts = parseCliArgs();

  console.log("==================================================");
  console.log("WALDISC-2 — METEORA POOL CREATED_AT COVERAGE AUDIT");
  console.log("==================================================");
  console.log(`API Base             : ${METEORA_API_BASE}`);

  // 1. Derive distinct pool population dynamically
  const distinctPools = getDynamicCohortPools(opts.waldiscDir);
  console.log(`Cohort Pool Count    : ${distinctPools.length}`);

  if (distinctPools.length === 0) {
    throw new Error(
      `No distinct pools found in validated WALDISC-2 cohort artifacts under: ${opts.waldiscDir}`
    );
  }

  // 2. Fetch and inspect pools
  console.log(`\nQuerying official Meteora DLMM Data API (pacing: ${opts.pacingMs}ms)...`);

  const poolRecords: PoolAuditRecord[] = [];
  let observedTopLevelKeys: string[] = [];
  let observedCandidateField: string | null = null;

  let validCount = 0;
  let missingCount = 0;
  let zeroCount = 0;
  let invalidCount = 0;
  let requestFailedCount = 0;

  for (let i = 0; i < distinctPools.length; i++) {
    const pool = distinctPools[i];
    process.stdout.write(
      `\r[${i + 1}/${distinctPools.length}] Checking ${pool.slice(0, 8)}... `
    );

    const { status: httpStatus, data } = await fetchPoolWithBackoff(pool);

    if (httpStatus !== 200 || !data || typeof data !== "object") {
      requestFailedCount++;
      poolRecords.push({
        pool,
        httpStatus,
        field: null,
        rawValue: null,
        timestamp: null,
        iso: null,
        status: "REQUEST_FAILED",
      });
    } else {
      // Record raw response schema discovery from first successful response
      if (observedTopLevelKeys.length === 0) {
        observedTopLevelKeys = Object.keys(data);
      }

      // Look for candidate creation-time fields in actual returned JSON
      let fieldName: string | null = null;
      let rawVal: unknown = undefined;

      if ("created_at" in data) {
        fieldName = "created_at";
        rawVal = data.created_at;
      } else if ("createdAt" in data) {
        fieldName = "createdAt";
        rawVal = data.createdAt;
      }

      if (observedCandidateField === null && fieldName !== null) {
        observedCandidateField = fieldName;
      }

      const parsed = parseCandidateTimestamp(rawVal);

      if (parsed.reason === "AVAILABLE_VALID") {
        validCount++;
      } else if (parsed.reason === "ZERO") {
        zeroCount++;
      } else if (parsed.reason === "MISSING") {
        missingCount++;
      } else if (parsed.reason === "INVALID") {
        invalidCount++;
      }

      poolRecords.push({
        pool,
        httpStatus,
        field: fieldName,
        rawValue: rawVal ?? null,
        timestamp: parsed.timestamp,
        iso: parsed.iso,
        status: parsed.reason,
      });
    }

    if (opts.pacingMs > 0 && i < distinctPools.length - 1) {
      await sleep(opts.pacingMs);
    }
  }

  process.stdout.write("\nDone.\n");

  const totalPools = distinctPools.length;
  const coveragePct =
    totalPools > 0 ? Number(((validCount / totalPools) * 100).toFixed(2)) : 0;

  let assessment: CoverageAssessment = "INSUFFICIENT_COVERAGE";
  if (coveragePct >= 90) {
    assessment = "HIGH_COVERAGE";
  } else if (coveragePct > 0) {
    assessment = "PARTIAL_COVERAGE";
  } else {
    assessment = "INSUFFICIENT_COVERAGE";
  }

  const output: MeteoraPoolCreatedAtAuditOutput = {
    generatedAt: new Date().toISOString(),
    apiBase: METEORA_API_BASE,
    poolPopulation: {
      total: totalPools,
    },
    responseSchemaObservation: {
      topLevelKeys: observedTopLevelKeys,
      candidateCreationField: observedCandidateField,
    },
    coverage: {
      valid: validCount,
      missing: missingCount,
      zero: zeroCount,
      invalid: invalidCount,
      requestFailed: requestFailedCount,
      coveragePct,
    },
    pools: poolRecords,
    assessment,
    notes:
      "Availability does not yet prove creation-time semantics. Field availability must subsequently be compared against on-chain initialization blockTime before adopting as authoritative.",
  };

  // Write output
  atomicWriteJson(opts.outputFile, output);

  // -------------------------------------------------------------------------
  // Terminal Report
  // -------------------------------------------------------------------------
  console.log("\nWALDISC-2 — METEORA POOL CREATED_AT COVERAGE AUDIT\n");
  console.log(`Pools Checked        : ${totalPools}`);
  console.log(`Valid Timestamp      : ${validCount}`);
  console.log(`Missing              : ${missingCount}`);
  console.log(`Zero                 : ${zeroCount}`);
  console.log(`Invalid              : ${invalidCount}`);
  console.log(`Request Failed       : ${requestFailedCount}`);
  console.log(`Coverage             : ${coveragePct}%\n`);
  console.log(`Observed Field       : ${observedCandidateField ?? "NONE"}\n`);
  console.log(`Assessment:`);
  console.log(assessment);
  console.log("\nIMPORTANT:");
  console.log("Availability does not yet prove creation-time semantics.");
  console.log("==================================================");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("waldisc-2-audit-meteora-pool-created-at.ts")) {
  runMeteoraPoolCreatedAtAudit().catch((err) => {
    console.error("Fatal error during Meteora pool created_at coverage audit:", err);
    process.exit(1);
  });
}
