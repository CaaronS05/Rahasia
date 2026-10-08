import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withCanonicalLock } from "./canonical-lock.ts";
import { publishWallets } from "./publish-wallets.ts";
import { syncPoolWallets } from "./sync-pool-wallets.ts";

const POOL_SCANNER_BASE = path.resolve("data/discovery/pool-scanner");
const MASTER_DIR = path.resolve("data/master");
const BACKUP_DIR = path.resolve("data/backup");
const MASTER_PATH = path.join(MASTER_DIR, "wallets-master.json");
const FABRIQ_PATH = path.join(MASTER_DIR, "wallets-fabriq.json");
const REGISTRY_PATH = path.join(MASTER_DIR, "pool-wallets-registry.json");

interface MasterFile {
  wallets?: Array<{ owner: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface FabriqFile {
  wallets?: Array<{ owner: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface RegistryFile {
  totalUniqueWallets?: number;
  wallets?: Array<{ owner: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  return { dryRun };
}

async function findScannedTokens(): Promise<string[]> {
  try {
    const entries = await readdir(POOL_SCANNER_BASE, { withFileTypes: true });
    const tokens: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const token = entry.name;
      const selectionPath = path.join(POOL_SCANNER_BASE, token, "selected-scan", "selection.json");
      const enrichedPath = path.join(POOL_SCANNER_BASE, token, "selected-scan", "fabriq-enriched.json");

      try {
        await stat(selectionPath);
        await stat(enrichedPath);
        tokens.push(token);
      } catch {
        // Not a complete selected scan, skip
      }
    }

    return tokens.sort();
  } catch (err: unknown) {
    console.error(`Error reading ${POOL_SCANNER_BASE}:`, err);
    return [];
  }
}

async function createBackup(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFolder = path.join(BACKUP_DIR, `canonical-${timestamp}`);
  await mkdir(backupFolder, { recursive: true });

  const filesToBackup = [
    { src: MASTER_PATH, name: "wallets-master.json" },
    { src: FABRIQ_PATH, name: "wallets-fabriq.json" },
    { src: REGISTRY_PATH, name: "pool-wallets-registry.json" },
  ];

  for (const item of filesToBackup) {
    try {
      await stat(item.src);
      await copyFile(item.src, path.join(backupFolder, item.name));
    } catch {
      // File may not exist yet, that is fine
    }
  }

  return backupFolder;
}

export async function runHistoricalBackfill(options: { dryRun?: boolean } = {}) {
  const { dryRun = false } = options;

  console.log("==================================================");
  console.log("HISTORICAL POOL WALLET BACKFILL");
  console.log("==================================================");
  if (dryRun) console.log("MODE: DRY RUN (no files will be written)\n");

  const tokens = await findScannedTokens();
  console.log(`Discovered ${tokens.length} completed pool scanner token directories:`);
  for (const t of tokens) {
    console.log(`  - ${t}`);
  }

  if (tokens.length === 0) {
    console.log("\nNo scanned tokens found to backfill.");
    return;
  }

  // 1. Create recoverable backup if not dry run
  let backupPath = "NONE (dry-run)";
  if (!dryRun) {
    backupPath = await withCanonicalLock(async () => {
      return await createBackup();
    }, "canonical-backup");
    console.log(`\nCreated recoverable local backup: ${backupPath}`);
  }

  // 2. Perform synchronization for all tokens under canonical lock
  console.log("\nSynchronizing token artifacts into canonical registries...");
  const results = [];
  for (const token of tokens) {
    console.log(`\nSyncing token: ${token}...`);
    const res = await syncPoolWallets({ token, dryRun });
    console.log(`  Discovered: ${res.discoveredWalletsCount} | Reg Added: ${res.registryAdded} | Reg Updated: ${res.registryUpdated} | Fabriq Added: ${res.fabriqAdded} | Fabriq Updated: ${res.fabriqUpdated} | Stale Skipped: ${res.fabriqSkippedStale}`);
    results.push(res);
  }

  // 3. Publish unified wallet population
  let publishRes = null;
  if (!dryRun) {
    console.log("\nPublishing unified wallet population to Wallet Explorer...");
    publishRes = await publishWallets();
  }

  // 4. Verification & Summary
  let registryTotal = 0;
  let fabriqTotal = 0;
  let masterTotal = 0;

  try {
    const regData = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as RegistryFile;
    registryTotal = regData.wallets?.length ?? 0;
  } catch {
    //
  }

  try {
    const fabData = JSON.parse(await readFile(FABRIQ_PATH, "utf8")) as FabriqFile;
    fabriqTotal = fabData.wallets?.length ?? 0;
  } catch {
    //
  }

  try {
    const masData = JSON.parse(await readFile(MASTER_PATH, "utf8")) as MasterFile;
    masterTotal = masData.wallets?.length ?? 0;
  } catch {
    //
  }

  console.log("\n==================================================");
  console.log("BACKFILL SUMMARY & VERIFICATION");
  console.log("==================================================");
  console.log(`Backup Location     : ${backupPath}`);
  console.log(`Tokens Processed    : ${tokens.length}`);
  console.log(`Master Wallets      : ${masterTotal} (LP Agent only)`);
  console.log(`Registry Wallets    : ${registryTotal} (Pool Scanner cumulative)`);
  console.log(`Fabriq Store Total  : ${fabriqTotal} (Enriched wallets)`);
  if (publishRes) {
    console.log(`Published Total     : ${publishRes.publishedCount} (Wallet Explorer)`);
    console.log(`Missing Fabriq      : ${publishRes.missingFabriqCount}`);
  }
  console.log("==================================================");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dryRun } = parseCliArgs();
  runHistoricalBackfill({ dryRun }).catch((err) => {
    console.error("\nBACKFILL FAILED:", err);
    process.exit(1);
  });
}
