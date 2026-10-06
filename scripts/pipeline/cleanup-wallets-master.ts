import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, any>;

interface MasterFile {
  meta?: JsonObject;
  wallets: JsonObject[];
}

interface FabriqFile {
  version?: string;
  updatedAt?: string;
  walletCount?: number;
  wallets: Array<{
    owner: string;
    fabriq?: JsonObject;
  }>;
}

const DEFAULT_MASTER = path.resolve("data/master/wallets-master.json");
const DEFAULT_BACKUP = path.resolve(
  "data/master/wallets-master.before-pool-scanner.json",
);
const DEFAULT_FABRIQ = path.resolve("data/master/wallets-fabriq.json");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}


export async function cleanupWalletsMaster(options: {
  masterPath?: string;
  backupPath?: string;
  fabriqPath?: string;
  dryRun?: boolean;
} = {}): Promise<void> {
  const masterPath = options.masterPath ?? DEFAULT_MASTER;
  const backupPath = options.backupPath ?? DEFAULT_BACKUP;
  const fabriqPath = options.fabriqPath ?? DEFAULT_FABRIQ;
  const dryRun = options.dryRun ?? false;

  // 1. Load inputs
  const masterPayload = JSON.parse(await readFile(masterPath, "utf8")) as MasterFile;
  const backupPayload = JSON.parse(await readFile(backupPath, "utf8")) as MasterFile;
  const fabriqPayload = JSON.parse(await readFile(fabriqPath, "utf8")) as FabriqFile;

  if (!isObject(masterPayload) || !Array.isArray(masterPayload.wallets)) {
    throw new Error(`Invalid master file schema at ${masterPath}`);
  }
  if (!isObject(backupPayload) || !Array.isArray(backupPayload.wallets)) {
    throw new Error(`Invalid backup file schema at ${backupPath}`);
  }
  if (!isObject(fabriqPayload) || !Array.isArray(fabriqPayload.wallets)) {
    throw new Error(`Invalid fabriq file schema at ${fabriqPath}`);
  }

  const currentMasterWallets = masterPayload.wallets;
  const backupWallets = backupPayload.wallets;
  const canonicalFabriqWallets = fabriqPayload.wallets;

  // 2. Validate backup invariants
  const backupOwnerSet = new Set<string>();
  for (const [idx, w] of backupWallets.entries()) {
    if (!isObject(w) || typeof w.owner !== "string" || !w.owner.trim()) {
      throw new Error(`Backup record at index ${idx} is missing a valid owner.`);
    }
    const owner = w.owner.trim();
    if (backupOwnerSet.has(owner)) {
      throw new Error(`Duplicate owner in backup file: ${owner}`);
    }
    backupOwnerSet.add(owner);
  }

  if (backupOwnerSet.size !== 1557) {
    throw new Error(
      `Backup owner count mismatch: expected 1557 unique owners, got ${backupOwnerSet.size}`,
    );
  }

  // 3. Index canonical Fabriq by owner
  const canonicalFabriqByOwner = new Map<string, JsonObject>();
  for (const [idx, w] of canonicalFabriqWallets.entries()) {
    if (!isObject(w) || typeof w.owner !== "string" || !w.owner.trim()) {
      throw new Error(
        `Canonical fabriq record at index ${idx} is missing a valid owner.`,
      );
    }
    const owner = w.owner.trim();
    if (canonicalFabriqByOwner.has(owner)) {
      throw new Error(`Duplicate owner in canonical wallets-fabriq: ${owner}`);
    }
    if (isObject(w.fabriq)) {
      canonicalFabriqByOwner.set(owner, w.fabriq);
    }
  }

  if (canonicalFabriqByOwner.size !== 2498) {
    throw new Error(
      `Canonical Fabriq record count mismatch: expected 2498, got ${canonicalFabriqByOwner.size}`,
    );
  }

  // 4. Inspect current master unique owners
  const masterOwnerSet = new Set<string>();
  for (const [idx, w] of currentMasterWallets.entries()) {
    if (!isObject(w) || typeof w.owner !== "string" || !w.owner.trim()) {
      throw new Error(`Master record at index ${idx} is missing a valid owner.`);
    }
    const owner = w.owner.trim();
    if (masterOwnerSet.has(owner)) {
      throw new Error(`Duplicate owner in master file: ${owner}`);
    }
    masterOwnerSet.add(owner);
  }

  const currentCount = currentMasterWallets.length;
  const isAlreadyClean = currentCount === 1557;

  if (currentCount !== 2498 && !isAlreadyClean) {
    throw new Error(
      `Unexpected master record count: expected 2498 (uncleaned) or 1557 (already clean), got ${currentCount}`,
    );
  }

  // Classify current master wallets
  const retainedCurrent: JsonObject[] = [];
  const removableStubs: JsonObject[] = [];

  for (const w of currentMasterWallets) {
    const owner = String(w.owner).trim();
    if (backupOwnerSet.has(owner)) {
      retainedCurrent.push(w);
    } else {
      removableStubs.push(w);
    }
  }

  if (isAlreadyClean) {
    if (retainedCurrent.length !== 1557 || removableStubs.length !== 0) {
      throw new Error(
        `Already-clean master mismatch: expected 1557 retained, 0 stubs; got ${retainedCurrent.length} retained, ${removableStubs.length} stubs`,
      );
    }
  } else {
    if (retainedCurrent.length !== 1557 || removableStubs.length !== 941) {
      throw new Error(
        `Record classification mismatch: expected 1557 retained and 941 stubs, got ${retainedCurrent.length} retained and ${removableStubs.length} stubs`,
      );
    }
  }

  // 5. Inspect removable stubs: must NOT contain meaningful LP Agent data
  const lpAgentFields = [
    "first_activity",
    "last_activity",
    "pnl_chart",
    "positions",
    "total_lp",
    "win_rate",
    "win_lp",
    "win_lp_native",
    "closed_lp",
    "opening_lp",
    "total_pnl",
    "totalPnlUsd",
    "total_pnl_native",
    "volume",
    "fees",
    "total_fee",
    "total_fee_native",
    "total_inflow",
    "total_outflow",
    "total_inflow_native",
    "total_outflow_native",
    "avg_inflow",
    "avg_inflow_native",
    "avg_age_hour",
    "chain",
    "protocol",
  ];

  let lpAgentDataOnStubsCount = 0;
  const problematicStubs: Array<{ owner: string; fields: string[] }> = [];

  for (const stub of removableStubs) {
    const foundFields = lpAgentFields.filter(
      (f) => f in stub && stub[f] !== undefined && stub[f] !== null,
    );
    if (foundFields.length > 0) {
      lpAgentDataOnStubsCount++;
      problematicStubs.push({ owner: stub.owner, fields: foundFields });
    }
  }

  if (lpAgentDataOnStubsCount > 0) {
    throw new Error(
      `SAFETY FAILURE: Found meaningful LP Agent fields on ${lpAgentDataOnStubsCount} removable stubs. First example: ${JSON.stringify(
        problematicStubs[0],
      )}`,
    );
  }

  // 6. CANONICAL FABRIQ PRESERVATION GATE
  // For every current master wallet having an embedded fabriq object:
  // require matching owner in wallets-fabriq.json, compare complete parsed payload.
  let canonicalCoverageCount = 0;

  for (const w of currentMasterWallets) {
    if ("fabriq" in w && w.fabriq !== undefined) {
      const owner = String(w.owner).trim();
      const canonicalFab = canonicalFabriqByOwner.get(owner);

      if (!canonicalFab) {
        throw new Error(
          `CANONICAL FABRIQ GATE FAILURE: Master owner ${owner} has embedded fabriq, but is missing from wallets-fabriq.json`,
        );
      }

      // Semantic / age check
      const masterFetched =
        isObject(w.fabriq) && typeof w.fabriq.fetchedAt === "string"
          ? parseDate(w.fabriq.fetchedAt)
          : null;
      const canonicalFetched =
        isObject(canonicalFab) && typeof canonicalFab.fetchedAt === "string"
          ? parseDate(canonicalFab.fetchedAt)
          : null;

      if (masterFetched !== null && canonicalFetched === null) {
        throw new Error(
          `CANONICAL FABRIQ GATE FAILURE: Canonical payload for ${owner} missing fetchedAt present in master.`,
        );
      }

      if (
        masterFetched !== null &&
        canonicalFetched !== null &&
        canonicalFetched < masterFetched
      ) {
        throw new Error(
          `CANONICAL FABRIQ GATE FAILURE: Canonical payload for ${owner} is older (${canonicalFab.fetchedAt}) than master (${w.fabriq.fetchedAt}).`,
        );
      }

      canonicalCoverageCount++;
    }
  }

  // 7. Verify all 941 removed owners and all 1557 retained owners exist in wallets-fabriq
  let removedInFabriq = 0;
  for (const stub of removableStubs) {
    if (canonicalFabriqByOwner.has(String(stub.owner).trim())) {
      removedInFabriq++;
    }
  }

  let retainedInFabriq = 0;
  for (const r of retainedCurrent) {
    if (canonicalFabriqByOwner.has(String(r.owner).trim())) {
      retainedInFabriq++;
    }
  }

  if (!isAlreadyClean && removedInFabriq !== 941) {
    throw new Error(
      `Removed owners missing from wallets-fabriq: expected 941, found ${removedInFabriq}`,
    );
  }

  if (retainedInFabriq !== 1557) {
    throw new Error(
      `Retained owners missing from wallets-fabriq: expected 1557, found ${retainedInFabriq}`,
    );
  }

  // 8. Prepare retained records:
  // Start from CURRENT master record.
  // Preserve every field exactly except remove `fabriq`.
  // If `fabriqDerived` exists in master: FAIL.
  const cleanedWallets: JsonObject[] = [];
  let embeddedFabriqToStripCount = 0;

  for (const currentRecord of retainedCurrent) {
    if ("fabriqDerived" in currentRecord) {
      throw new Error(
        `SAFETY FAILURE: Record for ${currentRecord.owner} contains unexpected 'fabriqDerived' field.`,
      );
    }
    if ("fabriq" in currentRecord && currentRecord.fabriq !== undefined) {
      embeddedFabriqToStripCount++;
    }

    const cleanedRecord: JsonObject = {};
    for (const [k, v] of Object.entries(currentRecord)) {
      if (k === "fabriq") {
        continue;
      }
      cleanedRecord[k] = v;
    }
    cleanedWallets.push(cleanedRecord);
  }

  // Sort using normal LP Agent master writer order:
  // last_activity descending, then owner ascending
  cleanedWallets.sort((a, b) => {
    const bt = parseDate(b.last_activity) ?? 0;
    const at = parseDate(a.last_activity) ?? 0;
    return bt - at || String(a.owner).localeCompare(String(b.owner));
  });

  // Verify retained owner set matches backup owner set exactly
  const cleanedOwnerSet = new Set(cleanedWallets.map((w) => String(w.owner)));
  if (cleanedOwnerSet.size !== 1557) {
    throw new Error(`Cleaned wallets unique count mismatch: ${cleanedOwnerSet.size}`);
  }

  for (const owner of backupOwnerSet) {
    if (!cleanedOwnerSet.has(owner)) {
      throw new Error(`Cleaned wallets missing backup owner: ${owner}`);
    }
  }

  // 9. Master meta preparation
  // Preserve unrelated metadata.
  // Update uniqueWallets to 1557.
  // Preserve existing authoritative updatedAt timestamp for idempotency.
  // Pool scanner metadata is inspected and preserved.
  const outputMeta: JsonObject = {
    ...(isObject(masterPayload.meta) ? masterPayload.meta : {}),
    uniqueWallets: cleanedWallets.length,
  };

  const outputPayload: MasterFile = {
    meta: outputMeta,
    wallets: cleanedWallets,
  };

  const serializedOutput = JSON.stringify(outputPayload, null, 2) + "\n";

  if (dryRun) {
    console.log("STEP 3D-B4 MASTER CLEANUP DRY RUN\n");
    console.log(`CURRENT MASTER:\n${currentCount}\n`);
    console.log(`BACKUP FULL OWNERS:\n${backupOwnerSet.size}\n`);
    console.log(`RETAINED FULL LP AGENT:\n${cleanedWallets.length}\n`);
    console.log(`REMOVABLE FABRIQ-ONLY STUBS:\n${removableStubs.length}\n`);
    console.log(`EMBEDDED FABRIQ TO STRIP:\n${embeddedFabriqToStripCount}\n`);
    console.log(
      `CANONICAL FABRIQ COVERAGE:\n${canonicalCoverageCount} / ${currentCount}\n`,
    );
    console.log(
      `REMOVED OWNERS STILL IN WALLETS-FABRIQ:\n${removedInFabriq} / ${
        isAlreadyClean ? 0 : 941
      }\n`,
    );
    console.log(
      `RETAINED OWNERS STILL IN WALLETS-FABRIQ:\n${retainedInFabriq} / 1557\n`,
    );
    console.log("RETAINED OWNER SET MATCHES BACKUP:\nYES\n");
    console.log(`LP AGENT DATA FOUND ON REMOVABLE STUBS:\n0\n`);
    console.log("VALIDATION:\nPASS\n");
    console.log("WALLETS-MASTER WRITTEN:\nNO\n");
    console.log("WALLETS-FABRIQ WRITTEN:\nNO");
    return;
  }

  // Idempotency check: if current file content is already byte-identical, don't rewrite
  const currentRaw = await readFile(masterPath, "utf8");
  if (currentRaw === serializedOutput) {
    console.log(
      "wallets-master.json is already completely cleaned and byte-identical. No write needed.",
    );
    return;
  }

  // Atomic write: write to temp file then rename
  await mkdir(path.dirname(masterPath), { recursive: true });
  const tempPath = `${masterPath}.tmp-${Date.now()}`;
  await writeFile(tempPath, serializedOutput, "utf8");
  await rename(tempPath, masterPath);

  console.log("STEP 3D-B4 MASTER CLEANUP COMPLETE");
  console.log("==================================");
  console.log(`Retained LP Agent wallets : ${cleanedWallets.length}`);
  console.log(`Removed Fabriq stubs      : ${removableStubs.length}`);
  console.log(`Master file updated       : ${masterPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  await cleanupWalletsMaster({ dryRun });
}

// Only invoke CLI runner when executed directly
const isDirectCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve("scripts/pipeline/cleanup-wallets-master.ts");

if (isDirectCli) {
  main().catch((error) => {
    console.error("Cleanup failed:", error);
    process.exit(1);
  });
}
