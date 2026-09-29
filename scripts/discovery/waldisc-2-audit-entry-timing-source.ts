import fs from "node:fs";
import path from "node:path";

interface CliOptions {
  waldiscDir: string;
  poolsCacheFile: string;
  outputFile: string;
}

export type CandidateClassification =
  | "AUTHORITATIVE"
  | "POSSIBLE_BUT_UNPROVEN"
  | "NOT_CREATION_TIME";

export type GlobalAssessment =
  | "ENTRY_TIMING_IMPLEMENTABLE"
  | "ENTRY_TIMING_PARTIALLY_IMPLEMENTABLE"
  | "SOURCE_NOT_AVAILABLE";

export interface PositionOpenAudit {
  status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  totalClosedPositions: number;
  positionsWithOpenedAt: number;
  coveragePct: number;
  sourceFile: string;
  sourceField: string;
  sourceSystem: string;
  semantics: string;
}

export interface PoolTimingCandidate {
  source: string;
  field: string;
  classification: CandidateClassification;
  reason: string;
  evaluatedSemantic: string;
}

export interface PoolAuditRecord {
  pool: string;
  name?: string | null;
  associatedWallets: string[];
  canonicalLegacyDLMM: boolean;
  creationTimestampAvailable: boolean;
  source: string | null;
  rawTimestamp: number | string | null;
  classification: CandidateClassification;
  notes: string;
}

export interface EntryTimingSourceAuditOutput {
  generatedAt: string;
  purpose: string;
  positionOpenTimestamp: PositionOpenAudit;
  poolTimingCandidates: PoolTimingCandidate[];
  pools: PoolAuditRecord[];
  summary: {
    distinctPoolsCount: number;
    authoritativePoolsCount: number;
    unprovenPoolsCount: number;
    missingPoolsCount: number;
    authoritativeCoveragePct: number;
  };
  globalAssessment: GlobalAssessment;
  blockingIssues: string[];
  recommendations: string[];
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
    poolsCacheFile:
      options["pools-cache"] ||
      path.resolve("data/pools/legacy-dlmm-pools.json"),
    outputFile:
      options.output ||
      options["output-file"] ||
      path.resolve("data/discovery/waldisc-2/entry-timing-source-audit.json"),
  };
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

function atomicWriteJson(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

export async function runEntryTimingSourceAudit(): Promise<EntryTimingSourceAuditOutput> {
  const opts = parseCliArgs();

  const validatedWallets = [
    "12xt4kpUmWMGY7rRenFZXLGtQFcpDFJigFXzQx6FTGyZ",
    "2MzqqSFqg17GhJirQwYzxWY1BquKCQgS3U8XLdnNQrjZ",
    "3bv2BLABbZ7Qi9LRHohknFbiB1cKWBDRcbXKntmNBSpA",
    "4pEhSid6oETEJUoNaxTK3yVmXDBnxKWVgf9nrgQqJZ4c",
    "4tNE6wAxeCJVfuJYEhjRqobfgnB9b8Ww4xctAPK4gtB5",
    "8FZWoB4AbNUi3tahgSCKEiihgnD5ANVgLmhrC2EEzabj",
    "AKiQ6v5DsWTNuTLZAFxK1gtwv8G3dysthfvEqGvgLrTA",
    "ANvsEBu7b3ehFnGbTkL8gDaaXs2MdyXtg7HRNUAEg3Ur",
    "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
    "DR2TThuNJHiKseXJL2yXnbTjWEwBtjbLrjS2FB5MN51y",
  ];

  // -------------------------------------------------------------------------
  // 1. AUDIT POSITION OPEN TIMESTAMPS
  // -------------------------------------------------------------------------
  let totalClosedPositions = 0;
  let positionsWithOpenedAt = 0;
  const poolWalletMap = new Map<string, Set<string>>();

  for (const wallet of validatedWallets) {
    const posFile = path.join(opts.waldiscDir, wallet, "positions.json");
    const positions = tryReadJson(posFile);
    if (!Array.isArray(positions)) continue;

    for (const pos of positions) {
      if (pos.status === "CLOSED" || pos.lifecycle?.closeCount > 0 || pos.closedAt) {
        totalClosedPositions++;
        if (pos.openedAt && typeof pos.openedAt === "string" && pos.openedAt.trim().length > 0) {
          positionsWithOpenedAt++;
        }
      }

      if (pos.pool) {
        if (!poolWalletMap.has(pos.pool)) {
          poolWalletMap.set(pos.pool, new Set());
        }
        poolWalletMap.get(pos.pool)!.add(wallet);
      }
    }
  }

  const coveragePct =
    totalClosedPositions > 0
      ? Number(((positionsWithOpenedAt / totalClosedPositions) * 100).toFixed(2))
      : 0;

  const positionOpenTimestamp: PositionOpenAudit = {
    status: coveragePct === 100 ? "AVAILABLE" : coveragePct > 0 ? "PARTIAL" : "UNAVAILABLE",
    totalClosedPositions,
    positionsWithOpenedAt,
    coveragePct,
    sourceFile: "data/discovery/waldisc-2/<wallet>/positions.json",
    sourceField: "openedAt (and fabriqSummary.openedAt, events[category='initialize'].createdAt)",
    sourceSystem: "Fabriq lifecycle event timestamps / on-chain DLMM event sequence",
    semantics: "Exact UTC timestamp when the position account was initialized on-chain.",
  };

  // -------------------------------------------------------------------------
  // 2. AUDIT POOL CREATION / FIRST-ACTIVE CANDIDATE SOURCES
  // -------------------------------------------------------------------------
  const legacyPoolsCache = tryReadJson(opts.poolsCacheFile);
  const legacyPoolsList: any[] = Array.isArray(legacyPoolsCache?.pools)
    ? legacyPoolsCache.pools
    : [];
  const legacyPoolMap = new Map<string, any>();
  for (const p of legacyPoolsList) {
    if (p.address) legacyPoolMap.set(p.address, p);
  }

  const poolTimingCandidates: PoolTimingCandidate[] = [
    {
      source: "data/pools/legacy-dlmm-pools.json",
      field: "createdAt",
      classification: "POSSIBLE_BUT_UNPROVEN",
      evaluatedSemantic:
        "Field populated from Meteora datapi (dlmm.datapi.meteora.ag/pools source.created_at) by build-legacy-pool-cache.cjs.",
      reason:
        "Third-party REST API metadata without on-chain transaction or blocktime provenance. Early pools report createdAt=0, and several reference DLMM pools are entirely absent from the cache.",
    },
    {
      source: "data/discovery/waldisc-2/<wallet>/pools.json",
      field: "earliest_open_ts",
      classification: "NOT_CREATION_TIME",
      evaluatedSemantic:
        "Earliest timestamp among positions opened by this specific wallet in this pool.",
      reason:
        "Reflects individual wallet entry time, not pool creation. Substituting wallet interaction for pool age violates explicit audit rules.",
    },
    {
      source: "data/discovery/waldisc-2/<wallet>/positions.json",
      field: "openedAt",
      classification: "NOT_CREATION_TIME",
      evaluatedSemantic:
        "Position opening timestamp for a specific LP position account.",
      reason:
        "Identifies position lifecycle start, completely unrelated to the pool creation or first-active timestamp.",
    },
    {
      source: "data/discovery/waldisc-2/<wallet>/events.json",
      field: "events[0].createdAt",
      classification: "NOT_CREATION_TIME",
      evaluatedSemantic:
        "Earliest observed event for the wallet in the discovery transaction log.",
      reason:
        "Represents wallet-level interaction, not pool genesis or first-active trading activity.",
    },
    {
      source: "data/discovery/waldisc-1/",
      field: "summary.json / lp-events.json",
      classification: "NOT_CREATION_TIME",
      evaluatedSemantic:
        "Single-pool historical scan outputs from WALDISC-1 proof of concept.",
      reason:
        "Contains only 1 test pool (Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf). Covers 0 of the 25 distinct canonical DLMM pools in the WALDISC-2 cohort.",
    },
    {
      source: "data/idl/dlmm.json",
      field: "initialize_lb_pair / initialize_lb_pair2",
      classification: "NOT_CREATION_TIME",
      evaluatedSemantic:
        "Anchor IDL instruction definition for DLMM pool initialization.",
      reason:
        "Defines instruction schema only. Actual on-chain pool initialization transactions have not been scanned, decoded, or persisted in repository artifacts.",
    },
  ];

  // -------------------------------------------------------------------------
  // 3. AUDIT CONTROL WALLET DISTINCT POOLS
  // -------------------------------------------------------------------------
  const distinctPoolAddresses = Array.from(poolWalletMap.keys()).sort();
  const poolRecords: PoolAuditRecord[] = [];

  let authoritativePoolsCount = 0;
  let unprovenPoolsCount = 0;
  let missingPoolsCount = 0;

  for (const poolAddr of distinctPoolAddresses) {
    const associatedWallets = Array.from(poolWalletMap.get(poolAddr) || []).sort();
    const cachedPool = legacyPoolMap.get(poolAddr);

    if (cachedPool) {
      const rawCreatedAt = cachedPool.createdAt;
      const isZero = rawCreatedAt === 0 || rawCreatedAt === "0";

      if (rawCreatedAt !== undefined && rawCreatedAt !== null && !isZero) {
        unprovenPoolsCount++;
        poolRecords.push({
          pool: poolAddr,
          name: cachedPool.name || null,
          associatedWallets,
          canonicalLegacyDLMM: true,
          creationTimestampAvailable: false, // NOT authoritative
          source: "data/pools/legacy-dlmm-pools.json",
          rawTimestamp: rawCreatedAt,
          classification: "POSSIBLE_BUT_UNPROVEN",
          notes:
            "Contains non-zero createdAt from dlmm.datapi.meteora.ag; unproven against on-chain blocktime.",
        });
      } else {
        missingPoolsCount++;
        poolRecords.push({
          pool: poolAddr,
          name: cachedPool.name || null,
          associatedWallets,
          canonicalLegacyDLMM: true,
          creationTimestampAvailable: false,
          source: "data/pools/legacy-dlmm-pools.json",
          rawTimestamp: rawCreatedAt ?? null,
          classification: "NOT_CREATION_TIME",
          notes: "Pool exists in legacy cache but createdAt is 0 or null.",
        });
      }
    } else {
      missingPoolsCount++;
      poolRecords.push({
        pool: poolAddr,
        name: null,
        associatedWallets,
        canonicalLegacyDLMM: true,
        creationTimestampAvailable: false,
        source: null,
        rawTimestamp: null,
        classification: "NOT_CREATION_TIME",
        notes: "Pool absent from legacy-dlmm-pools.json cache (e.g. StonkFun reference control pool).",
      });
    }
  }

  // Authoritative sources require provenance proof:
  // Under the CRITICAL RULE, since none of the candidates have verified on-chain provenance,
  // authoritative count is strictly 0.
  const distinctPoolsCount = distinctPoolAddresses.length;
  const authoritativeCoveragePct =
    distinctPoolsCount > 0
      ? Number(((authoritativePoolsCount / distinctPoolsCount) * 100).toFixed(2))
      : 0;

  // -------------------------------------------------------------------------
  // 4. GLOBAL ASSESSMENT & BLOCKING ISSUES
  // -------------------------------------------------------------------------
  const blockingIssues: string[] = [];
  let globalAssessment: GlobalAssessment = "SOURCE_NOT_AVAILABLE";

  if (authoritativePoolsCount === distinctPoolsCount && distinctPoolsCount > 0) {
    globalAssessment = "ENTRY_TIMING_IMPLEMENTABLE";
  } else if (authoritativePoolsCount > 0) {
    globalAssessment = "ENTRY_TIMING_PARTIALLY_IMPLEMENTABLE";
    blockingIssues.push(
      `Authoritative pool creation timestamp available for only ${authoritativePoolsCount} / ${distinctPoolsCount} pools.`
    );
  } else {
    globalAssessment = "SOURCE_NOT_AVAILABLE";
    blockingIssues.push(
      "Pool creation / first-active timestamp source is not currently available from repository artifacts."
    );
    blockingIssues.push(
      "Candidate createdAt field in data/pools/legacy-dlmm-pools.json originates from an unverified third-party REST API (Meteora datapi) without on-chain transaction or blocktime validation."
    );
    blockingIssues.push(
      `Multiple pools in the current cohort are either completely missing from legacy-dlmm-pools.json (e.g. GuPbekwP..., zxTpi4Bt..., CcG3fyDZ...) or have createdAt=0.`
    );
    blockingIssues.push(
      "Substituting first observed wallet interaction or Fabriq position timestamp for pool age is explicitly prohibited by specification rules."
    );
  }

  const recommendations: string[] = [
    "Build an on-chain pool genesis indexer to query the first transaction signature or initialize_lb_pair transaction for each target pool via getSignaturesForAddress with until/before boundaries.",
    "Persist verified pool initialization timestamps in a dedicated repository artifact (e.g., data/pools/canonical-pool-genesis.json) including on-chain slot and blockTime.",
    "Defer sniper style classification until the pool genesis artifact is constructed and validated.",
  ];

  const output: EntryTimingSourceAuditOutput = {
    generatedAt: new Date().toISOString(),
    purpose:
      "Audit repository artifacts to determine trustworthiness and availability of positionOpenedAt and poolFirstActiveAt for entryTimingProfile calculation.",
    positionOpenTimestamp,
    poolTimingCandidates,
    pools: poolRecords,
    summary: {
      distinctPoolsCount,
      authoritativePoolsCount,
      unprovenPoolsCount,
      missingPoolsCount,
      authoritativeCoveragePct,
    },
    globalAssessment,
    blockingIssues,
    recommendations,
  };

  // Write output
  atomicWriteJson(opts.outputFile, output);

  // -------------------------------------------------------------------------
  // 5. TERMINAL REPORT
  // -------------------------------------------------------------------------
  console.log("==================================================");
  console.log("WALDISC-2 — ENTRY TIMING SOURCE AUDIT");
  console.log("==================================================");
  console.log("");
  console.log("Position Open Timestamp:");
  console.log(`Available       : ${positionOpenTimestamp.status === "AVAILABLE" ? "YES" : "NO"}`);
  console.log(
    `Coverage        : ${positionsWithOpenedAt} / ${totalClosedPositions} positions (${coveragePct}%)`
  );
  console.log("");
  console.log("Pool Timing Source:");
  console.log(
    `Authoritative   : ${authoritativePoolsCount > 0 ? "YES" : "NONE (SOURCE_NOT_AVAILABLE)"}`
  );
  console.log(
    `Coverage        : ${authoritativePoolsCount} / ${distinctPoolsCount} pools (${authoritativeCoveragePct}%)`
  );
  console.log("");
  console.log("Global Assessment:");
  console.log(globalAssessment);
  console.log("");
  console.log("Blocking Issues:");
  if (blockingIssues.length === 0) {
    console.log("(none)");
  } else {
    for (let i = 0; i < blockingIssues.length; i++) {
      console.log(`${i + 1}. ${blockingIssues[i]}`);
    }
  }
  console.log("");
  if (globalAssessment === "SOURCE_NOT_AVAILABLE") {
    console.log(
      "Pool creation / first-active timestamp source is not currently available from repository artifacts."
    );
  }
  console.log("==================================================");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("waldisc-2-audit-entry-timing-source.ts")) {
  runEntryTimingSourceAudit().catch((err) => {
    console.error("Fatal error during entry timing source audit:", err);
    process.exit(1);
  });
}
