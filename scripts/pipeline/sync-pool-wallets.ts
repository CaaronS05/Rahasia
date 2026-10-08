import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withCanonicalLock } from "./canonical-lock.ts";

// ======================================================
// DOMAIN TYPES
// ======================================================

export interface PoolDiscoveredWallet {
  owner: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tokens: string[];
  pools: string[];
  scans: string[];
  source: "pool-scanner";
}

export interface PoolWalletsRegistryFile {
  version: "v1";
  updatedAt: string;
  totalUniqueWallets: number;
  wallets: PoolDiscoveredWallet[];
}

export interface CanonicalFabriqRecord {
  owner: string;
  fabriq: Record<string, unknown>;
  _local?: Record<string, unknown>;
}

export interface CanonicalFabriqFile {
  version?: string;
  updatedAt?: string;
  wallets: CanonicalFabriqRecord[];
}

export interface SyncOptions {
  token: string;
  targetPool?: string | null;
  dryRun?: boolean;
}

export interface SyncResult {
  token: string;
  targetPool: string | null;
  discoveredWalletsCount: number;
  registryAdded: number;
  registryUpdated: number;
  registryUnchanged: number;
  fabriqAdded: number;
  fabriqUpdated: number;
  fabriqUnchanged: number;
  fabriqSkippedStale: number;
  totalRegistryWallets: number;
  totalFabriqWallets: number;
  dryRun: boolean;
}

// Artifact interfaces
interface SelectionPool {
  poolAddress: string;
  [key: string]: unknown;
}

interface SelectionArtifact {
  tokenMint?: string;
  selectionFingerprint?: string;
  createdAt?: string;
  pools?: SelectionPool[];
  [key: string]: unknown;
}

interface ScanStateArtifact {
  status?: string;
  tokenMint?: string;
  selectionFingerprint?: string;
  startedAt?: string;
  completedAt?: string;
  selectedPoolCount?: number;
  completedPoolCount?: number;
  [key: string]: unknown;
}

interface PoolWalletsPool {
  poolAddress: string;
  wallets?: Array<{ wallet: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface PoolWalletsArtifact {
  tokenMint?: string;
  pools?: PoolWalletsPool[];
  [key: string]: unknown;
}

interface FabriqResultItem {
  owner: string;
  status: string;
  fabriq?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FabriqEnrichedArtifact {
  generatedAt?: string;
  totalWallets?: number;
  success?: number;
  failed?: number;
  results?: FabriqResultItem[];
  [key: string]: unknown;
}

interface FabriqStateArtifact {
  status?: string;
  tokenMint?: string;
  completedAt?: string;
  [key: string]: unknown;
}

// ======================================================
// CONSTANTS & PATHS
// ======================================================

const MASTER_DIR = path.resolve("data/master");
const REGISTRY_PATH = path.join(MASTER_DIR, "pool-wallets-registry.json");
const FABRIQ_PATH = path.join(MASTER_DIR, "wallets-fabriq.json");

// ======================================================
// HELPERS
// ======================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseValidTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ts = Date.parse(value.trim());
  return Number.isFinite(ts) ? ts : null;
}

function earliestIso(a?: string, b?: string): string | undefined {
  const at = parseValidTimestamp(a);
  const bt = parseValidTimestamp(b);
  if (at === null) return b ?? a;
  if (bt === null) return a ?? b;
  return at <= bt ? a : b;
}

function latestIso(a?: string, b?: string): string | undefined {
  const at = parseValidTimestamp(a);
  const bt = parseValidTimestamp(b);
  if (at === null) return b ?? a;
  if (bt === null) return a ?? b;
  return at >= bt ? a : b;
}

function normalizeCalendars(fabriq: Record<string, unknown>): Record<string, unknown> {
  const calendars: Record<string, unknown> = {};
  if (isPlainObject(fabriq.calendars)) {
    for (const [month, calendar] of Object.entries(fabriq.calendars)) {
      if (isPlainObject(calendar)) {
        calendars[month] = calendar;
      }
    }
  }
  if (typeof fabriq.month === "string" && isPlainObject(fabriq.calendar)) {
    const existingMonth = isPlainObject(calendars[fabriq.month]) ? calendars[fabriq.month] : {};
    calendars[fabriq.month] = {
      ...existingMonth,
      ...fabriq.calendar,
    };
  }
  return calendars;
}

function mergeNewerFabriq(
  existingFabriq: Record<string, unknown>,
  incomingFabriq: Record<string, unknown>
): Record<string, unknown> {
  const existingCalendars = normalizeCalendars(existingFabriq);
  const incomingCalendars = normalizeCalendars(incomingFabriq);
  const mergedCalendars: Record<string, unknown> = {
    ...existingCalendars,
    ...incomingCalendars,
  };

  for (const month of Object.keys(incomingCalendars)) {
    const incMonth = incomingCalendars[month];
    const exMonth = existingCalendars[month];
    if (isPlainObject(incMonth) && isPlainObject(exMonth)) {
      mergedCalendars[month] = {
        ...exMonth,
        ...incMonth,
      };
    }
  }

  return {
    ...incomingFabriq,
    calendars: mergedCalendars,
  };
}

function mergeNonDestructiveFabriq(
  existingFabriq: Record<string, unknown>,
  incomingFabriq: Record<string, unknown>
): Record<string, unknown> {
  const existingCalendars = normalizeCalendars(existingFabriq);
  const incomingCalendars = normalizeCalendars(incomingFabriq);
  const mergedCalendars: Record<string, unknown> = {
    ...incomingCalendars,
    ...existingCalendars,
  };

  for (const month of Object.keys(existingCalendars)) {
    const incMonth = incomingCalendars[month];
    const exMonth = existingCalendars[month];
    if (isPlainObject(incMonth) && isPlainObject(exMonth)) {
      mergedCalendars[month] = {
        ...incMonth,
        ...exMonth,
      };
    }
  }

  return {
    ...incomingFabriq,
    ...existingFabriq,
    calendars: mergedCalendars,
  };
}

async function loadJsonOrDefault<T>(filePath: string, defaultVal: T): Promise<T> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return defaultVal;
    }
    throw err;
  }
}

async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tempPath, filePath);
}

// ======================================================
// MAIN SYNC LOGIC
// ======================================================

export async function syncPoolWallets(options: SyncOptions): Promise<SyncResult> {
  const { token, targetPool = null, dryRun = false } = options;

  if (!token || !token.trim()) {
    throw new Error("Missing required token parameter for pool wallets sync.");
  }

  const selectedScanDir = path.resolve(`data/discovery/pool-scanner/${token}/selected-scan`);

  // 1. Validate required artifacts exist
  const selectionPath = path.join(selectedScanDir, "selection.json");
  const scanStatePath = path.join(selectedScanDir, "scan-state.json");
  const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
  const fabriqEnrichedPath = path.join(selectedScanDir, "fabriq-enriched.json");
  const fabriqStatePath = path.join(selectedScanDir, "fabriq-state.json");

  let selection: SelectionArtifact;
  let scanState: ScanStateArtifact;
  let poolWalletsArtifact: PoolWalletsArtifact;
  let fabriqEnriched: FabriqEnrichedArtifact;
  let fabriqState: FabriqStateArtifact;

  try {
    selection = JSON.parse(await readFile(selectionPath, "utf8")) as SelectionArtifact;
    scanState = JSON.parse(await readFile(scanStatePath, "utf8")) as ScanStateArtifact;
    poolWalletsArtifact = JSON.parse(await readFile(poolWalletsPath, "utf8")) as PoolWalletsArtifact;
    fabriqEnriched = JSON.parse(await readFile(fabriqEnrichedPath, "utf8")) as FabriqEnrichedArtifact;
    fabriqState = JSON.parse(await readFile(fabriqStatePath, "utf8")) as FabriqStateArtifact;
  } catch (err: unknown) {
    throw new Error(
      `Artifact validation failed in ${selectedScanDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2. Validate scan completion
  if (scanState.status !== "completed") {
    // If targetPool specified, check if completedPoolCount > 0
    if (!targetPool && (scanState.completedPoolCount ?? 0) === 0) {
      throw new Error(`Cannot sync incomplete scan (scan-state.json status="${scanState.status}")`);
    }
  }

  if (fabriqState.status !== "completed") {
    throw new Error(`Cannot sync incomplete Fabriq enrichment (fabriq-state.json status="${fabriqState.status}")`);
  }

  // 3. Derive stable scan fingerprint
  const scanFingerprint =
    selection.selectionFingerprint ||
    scanState.selectionFingerprint ||
    `${token}:${selection.createdAt || scanState.startedAt || "unknown"}`;

  const scanTimestamp =
    selection.createdAt ||
    scanState.startedAt ||
    fabriqEnriched.generatedAt ||
    new Date().toISOString();

  // 4. Extract pools and discovered wallets
  const discoveredPoolAddresses = new Set<string>();
  if (Array.isArray(selection.pools)) {
    for (const p of selection.pools) {
      if (p.poolAddress) discoveredPoolAddresses.add(p.poolAddress.trim());
    }
  }
  if (Array.isArray(poolWalletsArtifact.pools)) {
    for (const p of poolWalletsArtifact.pools) {
      if (p.poolAddress) discoveredPoolAddresses.add(p.poolAddress.trim());
    }
  }

  // Match target pool if provided
  const poolsToAssociate = targetPool
    ? [targetPool.trim()]
    : [...discoveredPoolAddresses];

  // Discovered wallet addresses from pool-wallets.json
  const discoveredWalletsMap = new Map<string, Set<string>>(); // owner -> Set of pools
  if (Array.isArray(poolWalletsArtifact.pools)) {
    for (const pool of poolWalletsArtifact.pools) {
      if (!pool.poolAddress) continue;
      if (targetPool && pool.poolAddress.trim() !== targetPool.trim()) continue;
      const pAddr = pool.poolAddress.trim();
      if (Array.isArray(pool.wallets)) {
        for (const entry of pool.wallets) {
          if (typeof entry.wallet === "string" && entry.wallet.trim()) {
            const owner = entry.wallet.trim();
            if (!discoveredWalletsMap.has(owner)) {
              discoveredWalletsMap.set(owner, new Set());
            }
            discoveredWalletsMap.get(owner)?.add(pAddr);
          }
        }
      }
    }
  }

  // Also check wallets.json if pool-wallets has no entries
  const walletsJsonPath = path.join(selectedScanDir, "wallets.json");
  try {
    const rawWalletsList = JSON.parse(await readFile(walletsJsonPath, "utf8"));
    if (Array.isArray(rawWalletsList)) {
      for (const w of rawWalletsList) {
        if (typeof w === "string" && w.trim()) {
          const owner = w.trim();
          if (!discoveredWalletsMap.has(owner)) {
            discoveredWalletsMap.set(owner, new Set(poolsToAssociate));
          }
        }
      }
    }
  } catch {
    // wallets.json optional if pool-wallets.json exists
  }

  // 5. Extract successful Fabriq enrichment
  const incomingFabriqByOwner = new Map<string, Record<string, unknown>>();
  if (Array.isArray(fabriqEnriched.results)) {
    for (const item of fabriqEnriched.results) {
      if (!isPlainObject(item)) continue;
      if (item.status !== "ok") continue;
      if (typeof item.owner !== "string" || !item.owner.trim()) continue;
      if (!isPlainObject(item.fabriq)) continue;
      incomingFabriqByOwner.set(item.owner.trim(), item.fabriq);
    }
  }

  // 6. Execute synchronization under cross-process lock
  return await withCanonicalLock(async () => {
    // A. Load existing registries
    const existingRegistry = await loadJsonOrDefault<PoolWalletsRegistryFile>(REGISTRY_PATH, {
      version: "v1",
      updatedAt: new Date().toISOString(),
      totalUniqueWallets: 0,
      wallets: [],
    });

    const existingFabriq = await loadJsonOrDefault<CanonicalFabriqFile>(FABRIQ_PATH, {
      wallets: [],
    });

    // Build lookup maps
    const registryMap = new Map<string, PoolDiscoveredWallet>();
    for (const w of existingRegistry.wallets || []) {
      if (w && typeof w.owner === "string" && w.owner.trim()) {
        registryMap.set(w.owner.trim(), w);
      }
    }

    const fabriqMap = new Map<string, CanonicalFabriqRecord>();
    for (const w of existingFabriq.wallets || []) {
      if (w && typeof w.owner === "string" && w.owner.trim()) {
        fabriqMap.set(w.owner.trim(), w);
      }
    }

    // B. Upsert pool wallets into registry
    let registryAdded = 0;
    let registryUpdated = 0;
    let registryUnchanged = 0;

    for (const [owner, poolSet] of discoveredWalletsMap.entries()) {
      const associatedPools = poolSet.size > 0 ? [...poolSet] : poolsToAssociate;
      const existing = registryMap.get(owner);

      if (!existing) {
        registryAdded++;
        registryMap.set(owner, {
          owner,
          firstSeenAt: scanTimestamp,
          lastSeenAt: scanTimestamp,
          tokens: [token],
          pools: associatedPools,
          scans: [scanFingerprint],
          source: "pool-scanner",
        });
      } else {
        // Idempotency check: if this scan was already applied, do not advance timestamps
        const alreadyHasScan = existing.scans.includes(scanFingerprint);
        const tokensUnion = [...new Set([...existing.tokens, token])];
        const poolsUnion = [...new Set([...existing.pools, ...associatedPools])];

        const tokensChanged = tokensUnion.length !== existing.tokens.length;
        const poolsChanged = poolsUnion.length !== existing.pools.length;

        if (alreadyHasScan && !tokensChanged && !poolsChanged) {
          registryUnchanged++;
        } else {
          registryUpdated++;
          const scansUnion = alreadyHasScan ? existing.scans : [...existing.scans, scanFingerprint];
          registryMap.set(owner, {
            ...existing,
            firstSeenAt: earliestIso(existing.firstSeenAt, scanTimestamp) ?? existing.firstSeenAt,
            lastSeenAt: alreadyHasScan ? existing.lastSeenAt : (latestIso(existing.lastSeenAt, scanTimestamp) ?? scanTimestamp),
            tokens: tokensUnion,
            pools: poolsUnion,
            scans: scansUnion,
          });
        }
      }
    }

    // C. Upsert Fabriq records
    let fabriqAdded = 0;
    let fabriqUpdated = 0;
    let fabriqUnchanged = 0;
    let fabriqSkippedStale = 0;

    for (const [owner, incomingData] of incomingFabriqByOwner.entries()) {
      const existingRecord = fabriqMap.get(owner);

      if (!existingRecord) {
        fabriqAdded++;
        const normalizedCalendars = normalizeCalendars(incomingData);
        fabriqMap.set(owner, {
          owner,
          fabriq: {
            ...incomingData,
            calendars: normalizedCalendars,
          },
        });
      } else {
        const existingFabriqData = isPlainObject(existingRecord.fabriq) ? existingRecord.fabriq : {};
        const canonicalTs = parseValidTimestamp(existingFabriqData.fetchedAt);
        const incomingTs = parseValidTimestamp(incomingData.fetchedAt);

        // Case 1: Incoming older -> Skip
        if (canonicalTs !== null && incomingTs !== null && incomingTs < canonicalTs) {
          fabriqSkippedStale++;
          fabriqUnchanged++;
          continue;
        }

        // Case 2: Incoming newer -> Merge newer snapshot
        let mergedFabriqPayload: Record<string, unknown>;
        if (canonicalTs !== null && incomingTs !== null && incomingTs > canonicalTs) {
          fabriqUpdated++;
          mergedFabriqPayload = mergeNewerFabriq(existingFabriqData, incomingData);
        } else if (canonicalTs !== null && incomingTs !== null && incomingTs === canonicalTs) {
          // Case 3: Same timestamp -> Non-destructive calendar union
          mergedFabriqPayload = mergeNonDestructiveFabriq(existingFabriqData, incomingData);
          fabriqUnchanged++;
        } else if (canonicalTs === null && incomingTs !== null) {
          // Case 4: Canonical timestamp missing -> Accept incoming
          fabriqUpdated++;
          mergedFabriqPayload = mergeNewerFabriq(existingFabriqData, incomingData);
        } else {
          // Case 5 & 6: Missing timestamp -> Non-destructive
          mergedFabriqPayload = mergeNonDestructiveFabriq(existingFabriqData, incomingData);
          fabriqUnchanged++;
        }

        fabriqMap.set(owner, {
          ...existingRecord,
          owner,
          fabriq: mergedFabriqPayload,
        });
      }
    }

    // D. Persist files atomically if not dry-run
    const updatedRegistryFile: PoolWalletsRegistryFile = {
      version: "v1",
      updatedAt: new Date().toISOString(),
      totalUniqueWallets: registryMap.size,
      wallets: [...registryMap.values()].sort((a, b) => a.owner.localeCompare(b.owner)),
    };

    const updatedFabriqFile: CanonicalFabriqFile = {
      ...existingFabriq,
      updatedAt: new Date().toISOString(),
      wallets: [...fabriqMap.values()].sort((a, b) => a.owner.localeCompare(b.owner)),
    };

    if (!dryRun) {
      await writeAtomicJson(REGISTRY_PATH, updatedRegistryFile);
      await writeAtomicJson(FABRIQ_PATH, updatedFabriqFile);
    }

    return {
      token,
      targetPool,
      discoveredWalletsCount: discoveredWalletsMap.size,
      registryAdded,
      registryUpdated,
      registryUnchanged,
      fabriqAdded,
      fabriqUpdated,
      fabriqUnchanged,
      fabriqSkippedStale,
      totalRegistryWallets: registryMap.size,
      totalFabriqWallets: fabriqMap.size,
      dryRun,
    };
  }, `sync-pool-wallets:${token}`);
}

// ======================================================
// CLI ENTRY POINT
// ======================================================

function parseCliArgs() {
  const args = process.argv.slice(2);
  let token = "";
  let targetPool: string | null = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token" && args[i + 1]) {
      token = args[i + 1].trim();
      i++;
    } else if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length).trim();
    } else if (arg === "--pool" && args[i + 1]) {
      targetPool = args[i + 1].trim();
      i++;
    } else if (arg.startsWith("--pool=")) {
      targetPool = arg.slice("--pool=".length).trim();
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { token, targetPool, dryRun };
}

// Execute when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { token, targetPool, dryRun } = parseCliArgs();

  if (!token) {
    console.error(
      "Missing required argument: --token <TOKEN_CA>\n" +
        "Usage: node --experimental-strip-types scripts/pipeline/sync-pool-wallets.ts --token <TOKEN_CA> [--pool <POOL_ADDRESS>] [--dry-run]"
    );
    process.exit(1);
  }

  console.log("========================================");
  console.log("SYNC POOL WALLETS TO GLOBAL REGISTRY");
  console.log("========================================");
  console.log(`Token Mint:  ${token}`);
  if (targetPool) console.log(`Target Pool: ${targetPool}`);
  if (dryRun) console.log("Mode:        DRY RUN (no writes)");

  syncPoolWallets({ token, targetPool, dryRun })
    .then((result) => {
      console.log("\nSYNC RESULT:");
      console.log(`  Discovered Wallets : ${result.discoveredWalletsCount}`);
      console.log(`  Registry Added     : ${result.registryAdded}`);
      console.log(`  Registry Updated   : ${result.registryUpdated}`);
      console.log(`  Registry Unchanged : ${result.registryUnchanged}`);
      console.log(`  Fabriq Added       : ${result.fabriqAdded}`);
      console.log(`  Fabriq Updated     : ${result.fabriqUpdated}`);
      console.log(`  Fabriq Skipped     : ${result.fabriqSkippedStale}`);
      console.log(`  Total Registry     : ${result.totalRegistryWallets}`);
      console.log(`  Total Fabriq       : ${result.totalFabriqWallets}`);
      console.log("========================================");
      console.log("SYNC COMPLETE");
    })
    .catch((err) => {
      console.error(`\nSYNC ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
