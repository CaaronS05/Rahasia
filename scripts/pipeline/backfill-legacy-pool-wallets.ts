import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withCanonicalLock } from "./canonical-lock.ts";
import { publishWallets } from "./publish-wallets.ts";

// ======================================================
// CONSTANTS & EXCLUSIONS
// ======================================================

export const LEGACY_TOKENS = [
  "HSnCtWsw5YmfAkJo9S3eetWtGHPMrc2pAxvCu24AnQEa",
  "EDETAdjB1N8AARfoWWTwxeUJiNFjGAEhBv1JBePnagoh",
  "AqoPZcUumKUBHrnfBsNtoNuneYEjoimaiWYq8GH8gpX9",
] as const;

/**
 * Ambiguous BLUEPRINT root-only owners excluded by exact full public key.
 */
export const EXCLUDED_AMBIGUOUS_RECORD: Record<string, true> = {
  "4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN": true,
  "D5vLKeUASwyeV9kY45mewajqR6JfyZZhxdj8dgoFtqbg": true,
};

export const EXCLUDED_AMBIGUOUS_OWNERS = Object.keys(EXCLUDED_AMBIGUOUS_RECORD) as readonly string[];
export const BASE58_REGEX = /^[1-9A-HJ-NP-za-km-z]{32,44}$/;

export const DEFAULT_PATHS = {
  poolScannerBase: path.resolve("data/discovery/pool-scanner"),
  masterDir: path.resolve("data/master"),
  backupDir: path.resolve("data/backup"),
  masterPath: path.resolve("data/master/wallets-master.json"),
  registryPath: path.resolve("data/master/pool-wallets-registry.json"),
  fabriqPath: path.resolve("data/master/wallets-fabriq.json"),
};

// ======================================================
// DOMAIN TYPES
// ======================================================

export interface LegacyProvenanceMetadata {
  evidenceLevel: "TOKEN_SCAN_CANDIDATE";
  candidatePools: string[];
  sourceArtifactPaths: string[];
}

export interface LegacyPoolDiscoveredWallet {
  owner: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tokens: string[];
  pools: string[];
  scans: string[];
  source: "pool-scanner";
  legacyProvenance: LegacyProvenanceMetadata;
}

export interface ExistingRegistryWallet {
  owner: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tokens: string[];
  pools: string[];
  scans: string[];
  source: string;
  legacyProvenance?: LegacyProvenanceMetadata;
  [key: string]: unknown;
}

export interface PoolWalletsRegistryFile {
  version: "v1";
  updatedAt: string;
  totalUniqueWallets: number;
  wallets: ExistingRegistryWallet[];
  [key: string]: unknown;
}

export interface MasterFile {
  wallets?: Array<{ owner: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface FabriqFile {
  wallets?: Array<{ owner: string; fabriq?: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface LegacySummaryArtifact {
  tokenCa: string;
  generatedAt: string;
  poolCount?: number;
  uniqueWallets?: number;
  pools: Array<{ pool: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface LegacyPoolArtifact {
  pool: string;
  [key: string]: unknown;
}

export interface LegacyTokenScanArtifacts {
  tokenCa: string;
  generatedAt: string;
  candidatePools: string[];
  wallets: string[];
  scanFingerprint: string;
  artifactPath: string;
}

export interface ExtractedCandidateMapEntry {
  owner: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tokens: Set<string>;
  candidatePools: Set<string>;
  scans: Set<string>;
  sourceArtifactPaths: Set<string>;
}

export interface EligibilityPartition {
  eligibleNew: LegacyPoolDiscoveredWallet[];
  alreadyInRegistry: string[];
  alreadyInMaster: string[];
  missingFabriq: string[];
  excludedAmbiguous: string[];
  invalidAddresses: string[];
}

export interface DryRunReport {
  existingLpAgentWallets: number;
  existingPoolRegistryWallets: number;
  newEligibleWallets: number;
  newRegistryTotal: number;
  predictedPublishedWallets: number;
  canonicalFabriqWallets: number;
  excludedAmbiguousWallets: number;
  duplicateOwnersAcrossScans: number;
  missingCanonicalRecords: number;
  invalidAddresses: number;
  missingOrAmbiguousProvenance: number;
  matchesExpectations: boolean;
  mismatches: string[];
}

export interface BackfillOptions {
  dryRun?: boolean;
  apply?: boolean;
  publishAfterApply?: boolean;
  basePaths?: typeof DEFAULT_PATHS;
  tokens?: readonly string[];
}

export interface BackfillResult {
  mode: "dry-run" | "apply";
  report: DryRunReport;
  backupPath?: string;
  publishedCount?: number;
}

// ======================================================
// HELPERS
// ======================================================

export function computeLegacyScanFingerprint(token: string, generatedAt: string): string {
  return createHash("sha256").update(`legacy-scan:${token}:${generatedAt}`).digest("hex");
}

async function loadJsonOrDefault<T>(filePath: string, defaultVal: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return defaultVal;
  }
}

async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}

// ======================================================
// LEGACY ARTIFACT PARSING
// ======================================================

/**
 * Parse and validate flat legacy token scan artifacts for a given token.
 * Fails closed if source evidence is missing, malformed, or contradictory.
 */
export async function loadLegacyTokenScan(
  token: string,
  poolScannerBase: string = DEFAULT_PATHS.poolScannerBase
): Promise<LegacyTokenScanArtifacts> {
  const tokenDir = path.join(poolScannerBase, token);
  const summaryPath = path.join(tokenDir, "summary.json");
  const poolsPath = path.join(tokenDir, "pools.json");
  const walletsPath = path.join(tokenDir, "wallets.json");

  let summaryRaw: string;
  let poolsRaw: string;
  let walletsRaw: string;

  try {
    [summaryRaw, poolsRaw, walletsRaw] = await Promise.all([
      readFile(summaryPath, "utf8"),
      readFile(poolsPath, "utf8"),
      readFile(walletsPath, "utf8"),
    ]);
  } catch (err: unknown) {
    throw new Error(
      `Failed to read legacy artifacts for token ${token} in ${tokenDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let summary: LegacySummaryArtifact;
  let pools: LegacyPoolArtifact[];
  let wallets: string[];

  try {
    summary = JSON.parse(summaryRaw) as LegacySummaryArtifact;
    pools = JSON.parse(poolsRaw) as LegacyPoolArtifact[];
    wallets = JSON.parse(walletsRaw) as string[];
  } catch (err: unknown) {
    throw new Error(
      `JSON parsing error in legacy artifacts for token ${token}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (summary.tokenCa !== token) {
    throw new Error(
      `Conflicting token mint in summary: expected ${token}, found ${summary.tokenCa}`
    );
  }

  if (!summary.generatedAt || Number.isNaN(Date.parse(summary.generatedAt))) {
    throw new Error(`Missing or invalid generatedAt timestamp for token ${token}`);
  }

  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error(`Missing or empty pools list in pools.json for token ${token}`);
  }

  if (!Array.isArray(wallets)) {
    throw new Error(`Invalid wallets structure in wallets.json for token ${token}; expected string array`);
  }

  // Cross-check pools in pools.json against summary.pools
  const poolsSet = new Set(pools.map((p) => p.pool).filter(Boolean));
  const summaryPoolsSet = new Set((summary.pools || []).map((p) => p.pool).filter(Boolean));

  for (const p of poolsSet) {
    if (!summaryPoolsSet.has(p)) {
      throw new Error(`Conflicting pool evidence for token ${token}: pool ${p} in pools.json but missing in summary.pools`);
    }
  }

  const candidatePools = Array.from(poolsSet).sort();
  const scanFingerprint = computeLegacyScanFingerprint(token, summary.generatedAt);
  const relativeArtifactPath = path.relative(process.cwd(), walletsPath);

  return {
    tokenCa: token,
    generatedAt: summary.generatedAt,
    candidatePools,
    wallets,
    scanFingerprint,
    artifactPath: relativeArtifactPath,
  };
}

// ======================================================
// EXTRACTION & ELIGIBILITY PARTITIONING
// ======================================================

/**
 * Extract deduplicated candidate wallets across multiple legacy token scans.
 * Strictly preserves candidate pools in legacyProvenance and keeps confirmed pools as [].
 */
export function extractCandidateWallets(
  tokenScans: LegacyTokenScanArtifacts[]
): {
  candidateMap: Map<string, ExtractedCandidateMapEntry>;
  duplicateOwnersAcrossScans: number;
} {
  const candidateMap = new Map<string, ExtractedCandidateMapEntry>();
  let duplicateOccurrences = 0;

  for (const scan of tokenScans) {
    const seenInCurrentScan = new Set<string>();

    for (const rawOwner of scan.wallets) {
      if (typeof rawOwner !== "string") continue;
      const owner = rawOwner.trim();
      if (!owner) continue;

      if (seenInCurrentScan.has(owner)) {
        duplicateOccurrences++;
        continue;
      }
      seenInCurrentScan.add(owner);

      const existing = candidateMap.get(owner);
      if (!existing) {
        candidateMap.set(owner, {
          owner,
          firstSeenAt: scan.generatedAt,
          lastSeenAt: scan.generatedAt,
          tokens: new Set([scan.tokenCa]),
          candidatePools: new Set(scan.candidatePools),
          scans: new Set([scan.scanFingerprint]),
          sourceArtifactPaths: new Set([scan.artifactPath]),
        });
      } else {
        duplicateOccurrences++;
        if (scan.generatedAt < existing.firstSeenAt) {
          existing.firstSeenAt = scan.generatedAt;
        }
        if (scan.generatedAt > existing.lastSeenAt) {
          existing.lastSeenAt = scan.generatedAt;
        }
        existing.tokens.add(scan.tokenCa);
        existing.scans.add(scan.scanFingerprint);
        for (const pool of scan.candidatePools) {
          existing.candidatePools.add(pool);
        }
        existing.sourceArtifactPaths.add(scan.artifactPath);
      }
    }
  }

  return { candidateMap, duplicateOwnersAcrossScans: duplicateOccurrences };
}

/**
 * Partition extracted candidates based on registry, master, fabriq presence, and exclusions.
 */
export function partitionCandidateEligibility(
  candidateMap: Map<string, ExtractedCandidateMapEntry>,
  masterSet: Set<string>,
  registrySet: Set<string>,
  fabriqSet: Set<string>
): EligibilityPartition {

  const eligibleNew: LegacyPoolDiscoveredWallet[] = [];
  const alreadyInRegistry: string[] = [];
  const alreadyInMaster: string[] = [];
  const missingFabriq: string[] = [];
  const excludedAmbiguous: string[] = [];
  const invalidAddresses: string[] = [];

  for (const [owner, entry] of candidateMap.entries()) {
    if (!BASE58_REGEX.test(owner)) {
      invalidAddresses.push(owner);
      continue;
    }
    if (EXCLUDED_AMBIGUOUS_RECORD[owner]) {
      excludedAmbiguous.push(owner);
      continue;
    }

    if (registrySet.has(owner)) {
      alreadyInRegistry.push(owner);
      continue;
    }

    if (masterSet.has(owner)) {
      alreadyInMaster.push(owner);
      continue;
    }

    if (!fabriqSet.has(owner)) {
      missingFabriq.push(owner);
      continue;
    }

    eligibleNew.push({
      owner,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      tokens: Array.from(entry.tokens).sort(),
      pools: [], // Strictly empty: candidate pools kept separate
      scans: Array.from(entry.scans).sort(),
      source: "pool-scanner",
      legacyProvenance: {
        evidenceLevel: "TOKEN_SCAN_CANDIDATE",
        candidatePools: Array.from(entry.candidatePools).sort(),
        sourceArtifactPaths: Array.from(entry.sourceArtifactPaths).sort(),
      },
    });
  }

  // Deterministic sort by owner
  eligibleNew.sort((a, b) => a.owner.localeCompare(b.owner));

  return {
    eligibleNew,
    alreadyInRegistry,
    alreadyInMaster,
    missingFabriq,
    excludedAmbiguous,
    invalidAddresses,
  };
}

// ======================================================
// DRY-RUN REPORT CALCULATION
// ======================================================

export function calculateDryRunReport(
  masterCount: number,
  registryCount: number,
  fabriqCount: number,
  poolOnlyCountCurrent: number,
  partition: EligibilityPartition,
  duplicateOwnersAcrossScans: number
): DryRunReport {
  const newEligibleWallets = partition.eligibleNew.length;
  const newRegistryTotal = registryCount + newEligibleWallets;
  const predictedPublishedWallets = masterCount + poolOnlyCountCurrent + newEligibleWallets;
  const canonicalFabriqWallets = fabriqCount;
  const excludedAmbiguousWallets = EXCLUDED_AMBIGUOUS_OWNERS.length;

  const mismatches: string[] = [];
  if (masterCount !== 1557) mismatches.push(`LP Agent wallets: actual ${masterCount} !== expected 1,557`);
  if (registryCount !== 2982) mismatches.push(`Pool Registry: actual ${registryCount} !== expected 2,982`);
  if (newEligibleWallets !== 199) mismatches.push(`New eligible wallets: actual ${newEligibleWallets} !== expected 199`);
  if (newRegistryTotal !== 3181) mismatches.push(`New Registry total: actual ${newRegistryTotal} !== expected 3,181`);
  if (predictedPublishedWallets !== 4352) mismatches.push(`Predicted published wallets: actual ${predictedPublishedWallets} !== expected 4,352`);
  if (canonicalFabriqWallets !== 4354) mismatches.push(`Canonical Fabriq wallets: actual ${canonicalFabriqWallets} !== expected 4,354`);
  if (excludedAmbiguousWallets !== 2) mismatches.push(`Excluded ambiguous wallets: actual ${excludedAmbiguousWallets} !== expected 2`);

  return {
    existingLpAgentWallets: masterCount,
    existingPoolRegistryWallets: registryCount,
    newEligibleWallets,
    newRegistryTotal,
    predictedPublishedWallets,
    canonicalFabriqWallets,
    excludedAmbiguousWallets,
    duplicateOwnersAcrossScans,
    missingCanonicalRecords: partition.missingFabriq.length,
    invalidAddresses: partition.invalidAddresses.length,
    missingOrAmbiguousProvenance: excludedAmbiguousWallets,
    matchesExpectations: mismatches.length === 0,
    mismatches,
  };
}

export function printDryRunReport(report: DryRunReport): void {
  console.log("==================================================");
  console.log("SAFE LEGACY POOL SCANNER BACKFILL — DRY-RUN REPORT");
  console.log("==================================================");
  console.log(`Existing LP Agent wallets        : ${report.existingLpAgentWallets} (expected: 1,557)`);
  console.log(`Existing Pool Registry           : ${report.existingPoolRegistryWallets} (expected: 2,982)`);
  console.log(`New eligible wallets             : ${report.newEligibleWallets} (expected: 199)`);
  console.log(`New Registry total               : ${report.newRegistryTotal} (expected: 3,181)`);
  console.log(`Predicted published wallets      : ${report.predictedPublishedWallets} (expected: 4,352)`);
  console.log(`Canonical Fabriq wallets         : ${report.canonicalFabriqWallets} (expected: unchanged at 4,354)`);
  console.log(`Excluded ambiguous wallets       : ${report.excludedAmbiguousWallets} (expected: 2)`);
  console.log(`Duplicate owners across scans    : ${report.duplicateOwnersAcrossScans}`);
  console.log(`Missing canonical records        : ${report.missingCanonicalRecords}`);
  console.log(`Invalid addresses                : ${report.invalidAddresses}`);
  console.log(`Missing or ambiguous provenance  : ${report.missingOrAmbiguousProvenance}`);
  console.log("--------------------------------------------------");
  if (report.matchesExpectations) {
    console.log("STATUS: ALL EXPECTED POPULATIONS MATCH EXACTLY");
  } else {
    console.log("STATUS: POPULATION MISMATCH DETECTED:");
    for (const m of report.mismatches) {
      console.log(`  - ${m}`);
    }
  }
  console.log("==================================================");
}

// ======================================================
// BACKUP CREATION
// ======================================================

async function createRegistryBackup(
  registryPath: string,
  backupDir: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetFolder = path.join(backupDir, `legacy-backfill-${timestamp}`);
  await mkdir(targetFolder, { recursive: true });
  const backupFilePath = path.join(targetFolder, "pool-wallets-registry.json");
  await copyFile(registryPath, backupFilePath);
  return backupFilePath;
}

// ======================================================
// MAIN BACKFILL RUNNER
// ======================================================

export async function runLegacyBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const {
    dryRun = true,
    apply = false,
    publishAfterApply = false,
    basePaths = DEFAULT_PATHS,
    tokens = LEGACY_TOKENS,
  } = options;

  const isApplyMode = Boolean(apply && !dryRun);
  const modeLabel: "dry-run" | "apply" = isApplyMode ? "apply" : "dry-run";

  console.log("==================================================");
  console.log(`LEGACY POOL WALLETS BACKFILL [MODE: ${modeLabel.toUpperCase()}]`);
  console.log("==================================================");

  // 1. Load legacy token scan artifacts (fail-closed if missing/corrupt)
  console.log(`Loading legacy token artifacts for ${tokens.length} tokens...`);
  const tokenScans: LegacyTokenScanArtifacts[] = [];
  for (const token of tokens) {
    const scan = await loadLegacyTokenScan(token, basePaths.poolScannerBase);
    console.log(`  - ${token}: ${scan.wallets.length} wallets, ${scan.candidatePools.length} candidate pools, date: ${scan.generatedAt}`);
    tokenScans.push(scan);
  }

  // 2. Extract and deduplicate candidate wallets
  const { candidateMap, duplicateOwnersAcrossScans } = extractCandidateWallets(tokenScans);
  console.log(`Extracted ${candidateMap.size} unique candidate owners (${duplicateOwnersAcrossScans} cross-token duplicates merged).`);

  // 3. Load canonical reference datasets (read-only)
  const masterPayload = await loadJsonOrDefault<MasterFile>(basePaths.masterPath, { wallets: [] });
  const registryPayload = await loadJsonOrDefault<PoolWalletsRegistryFile>(basePaths.registryPath, {
    version: "v1",
    updatedAt: new Date().toISOString(),
    totalUniqueWallets: 0,
    wallets: [],
  });
  const fabriqPayload = await loadJsonOrDefault<FabriqFile>(basePaths.fabriqPath, { wallets: [] });

  const masterWallets = Array.isArray(masterPayload.wallets) ? masterPayload.wallets : [];
  const registryWallets = Array.isArray(registryPayload.wallets) ? registryPayload.wallets : [];
  const fabriqWallets = Array.isArray(fabriqPayload.wallets) ? fabriqPayload.wallets : [];

  const masterSet = new Set<string>();
  for (const w of masterWallets) {
    if (typeof w?.owner === "string" && w.owner.trim()) masterSet.add(w.owner.trim());
  }

  const registrySet = new Set<string>();
  for (const w of registryWallets) {
    if (typeof w?.owner === "string" && w.owner.trim()) registrySet.add(w.owner.trim());
  }

  const fabriqSet = new Set<string>();
  for (const w of fabriqWallets) {
    if (typeof w?.owner === "string" && w.owner.trim()) fabriqSet.add(w.owner.trim());
  }

  // Calculate current pool-only wallets
  const currentPoolOnlyCount = registryWallets.filter((w) => !masterSet.has(w.owner)).length;

  // 4. Partition candidate eligibility
  const partition = partitionCandidateEligibility(candidateMap, masterSet, registrySet, fabriqSet);

  // 5. Generate and print dry-run report
  const report = calculateDryRunReport(
    masterSet.size,
    registrySet.size,
    fabriqSet.size,
    currentPoolOnlyCount,
    partition,
    duplicateOwnersAcrossScans
  );

  printDryRunReport(report);

  if (!report.matchesExpectations) {
    throw new Error(
      `Dataset population check failed: ${report.mismatches.join("; ")}. Stopping to prevent unsafe migration.`
    );
  }

  // 6. Handle execution mode
  if (!isApplyMode) {
    console.log("\n[DRY RUN COMPLETE] No files modified. All safety constraints verified.\n");
    return {
      mode: "dry-run",
      report,
    };
  }

  // 7. Apply mode: Acquire canonical lock, back up, apply atomically
  console.log("\n[APPLY MODE] Acquiring canonical lock...");
  let backupPath = "";
  let publishedCount: number | undefined;

  await withCanonicalLock(async () => {
    // A. Re-read registry inside lock to prevent race conditions
    const latestRegistry = await loadJsonOrDefault<PoolWalletsRegistryFile>(basePaths.registryPath, {
      version: "v1",
      updatedAt: new Date().toISOString(),
      totalUniqueWallets: 0,
      wallets: [],
    });

    // B. Backup existing registry before write
    backupPath = await createRegistryBackup(basePaths.registryPath, basePaths.backupDir);
    console.log(`Created recoverable registry backup: ${backupPath}`);

    // C. Preserve all existing wallets and append new eligible wallets idempotently
    const existingMap = new Map<string, ExistingRegistryWallet>();
    for (const w of latestRegistry.wallets || []) {
      if (w && typeof w.owner === "string") {
        existingMap.set(w.owner, w);
      }
    }

    let newlyAppended = 0;
    for (const eligible of partition.eligibleNew) {
      if (!existingMap.has(eligible.owner)) {
        existingMap.set(eligible.owner, eligible);
        newlyAppended++;
      }
    }

    console.log(`Appended ${newlyAppended} new wallets into registry map (total: ${existingMap.size}).`);

    const updatedWallets = Array.from(existingMap.values()).sort((a, b) =>
      a.owner.localeCompare(b.owner)
    );

    const updatedRegistryFile: PoolWalletsRegistryFile = {
      ...latestRegistry,
      version: "v1",
      updatedAt: new Date().toISOString(),
      totalUniqueWallets: updatedWallets.length,
      wallets: updatedWallets,
    };

    // D. Atomic write
    await writeAtomicJson(basePaths.registryPath, updatedRegistryFile);
    console.log(`Atomically wrote updated registry to ${basePaths.registryPath}`);

    // E. Optional publish (if requested)
    if (publishAfterApply) {
      console.log("Publishing updated wallet population to Wallet Explorer...");
      try {
        const pubResult = await publishWallets();
        publishedCount = pubResult.publishedCount;
        console.log(`Successfully published ${publishedCount} wallets.`);
      } catch (pubErr: unknown) {
        throw new Error(
          `Publish step failed after registry update: ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`
        );
      }
    }
  }, "legacy-pool-wallets-backfill");

  return {
    mode: "apply",
    report,
    backupPath,
    publishedCount,
  };
}

// ======================================================
// CLI ENTRY POINT
// ======================================================

function parseCliArgs() {
  const args = process.argv.slice(2);
  let dryRun = true;
  let apply = false;

  for (const arg of args) {
    if (arg === "--apply") {
      apply = true;
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
      apply = false;
    }
  }

  return { dryRun, apply };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dryRun, apply } = parseCliArgs();
  runLegacyBackfill({ dryRun, apply })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n[FATAL ERROR]", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
