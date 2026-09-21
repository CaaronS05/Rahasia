import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, any>;

type LocalMeta = {
  firstSeenAt: string;
  lastSeenAt: string;
  scrapeCount: number;
};

type SmartLpWallet = JsonObject & {
  owner: string;
  first_activity?: string;
  last_activity?: string;
  pnl_chart?: JsonObject[];
  _local?: LocalMeta;
};

type MasterFile = {
  meta?: JsonObject;
  wallets: SmartLpWallet[];
};

const DEFAULT_MASTER = path.resolve(
  "data/master/wallets-master.json"
);

function usage(): never {
  console.error(`
Usage:
  npm run merge:wallets -- <new-scan.json> [master.json]

Example:
  npm run merge:wallets -- ./data/raw/lpagent/smart-lp-latest.json
`);
  process.exit(1);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOwner(row: JsonObject): string | null {
  const value = row.owner ?? row.wallet ?? row.wallet_address;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractWallets(payload: unknown): SmartLpWallet[] {
  let rows: unknown = payload;

  if (isObject(payload)) {
    rows =
      payload.wallets ??
      payload.smart_lp ??
      payload.data?.wallets ??
      payload.data?.smart_lp ??
      payload.data?.data ??
      [];
  }

  if (!Array.isArray(rows)) {
    throw new Error("Could not find a wallet array in the input JSON.");
  }

  const normalized: SmartLpWallet[] = [];
  for (const raw of rows) {
    if (!isObject(raw)) continue;
    const owner = normalizeOwner(raw);
    if (!owner) continue;
    normalized.push({ ...raw, owner });
  }

  return normalized;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function earliestIso(a?: string, b?: string): string | undefined {
  const at = parseDate(a);
  const bt = parseDate(b);

  if (at === null) return b ?? a;
  if (bt === null) return a ?? b;

  return at <= bt ? a : b;
}

function latestIso(a?: string, b?: string): string | undefined {
  const at = parseDate(a);
  const bt = parseDate(b);

  if (at === null) return b ?? a;
  if (bt === null) return a ?? b;

  return at >= bt ? a : b;
}

function chartKey(point: JsonObject, index: number): string {
  const closeDay = point.close_day;
  if (typeof closeDay === "string" && closeDay) return closeDay;
  return `__row_${index}`;
}

function mergePnlChart(
  existing: JsonObject[] | undefined,
  incoming: JsonObject[] | undefined,
): JsonObject[] | undefined {
  if (!Array.isArray(existing) && !Array.isArray(incoming)) {
    return undefined;
  }

  const byDay = new Map<string, JsonObject>();

  for (const [index, point] of (existing ?? []).entries()) {
    if (!isObject(point)) continue;
    byDay.set(chartKey(point, index), point);
  }

  for (const [index, point] of (incoming ?? []).entries()) {
    if (!isObject(point)) continue;

    // Kalau tanggal sama, data dari scrape terbaru menang.
    byDay.set(chartKey(point, index), point);
  }

  return [...byDay.values()].sort((a, b) => {
    const at = parseDate(a.close_day) ?? 0;
    const bt = parseDate(b.close_day) ?? 0;
    return at - bt;
  });
}

function mergeWallet(
  existing: SmartLpWallet,
  incoming: SmartLpWallet,
  now: string,
): SmartLpWallet {
  return {
    ...existing,
    ...incoming,

    // owner adalah primary key.
    owner: existing.owner,

    fabriq:
      incoming.fabriq ??
      existing.fabriq,

    // Jangan kehilangan tanggal historis paling awal.
    first_activity: earliestIso(
      existing.first_activity,
      incoming.first_activity,
    ),

    // Simpan aktivitas paling baru.
    last_activity: latestIso(
      existing.last_activity,
      incoming.last_activity,
    ),

    // Daily chart tidak di-overwrite seluruhnya.
    // Tanggal lama tetap disimpan, tanggal yang sama di-refresh.
    pnl_chart: mergePnlChart(
      existing.pnl_chart,
      incoming.pnl_chart,
    ),

    // Metadata lokal milik sistem kita.
    _local: {
      firstSeenAt: existing._local?.firstSeenAt ?? now,
      lastSeenAt: now,
      scrapeCount: (existing._local?.scrapeCount ?? 1) + 1,
    },
  };
}

function extractMeta(payload: unknown): JsonObject {
  if (!isObject(payload)) return {};
  if (isObject(payload.meta)) return payload.meta;

  const result: JsonObject = {};

  for (const key of [
    "scanStartedAt",
    "scanFinishedAt",
    "pagesCaptured",
    "uniqueWallets",
    "finalUi",
    "filter",
    "filters",
  ]) {
    if (key in payload) result[key] = payload[key];
  }

  return result;
}

async function loadJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadMaster(filePath: string): Promise<MasterFile> {
  try {
    const payload = await loadJson(filePath);

    return {
      meta:
        isObject(payload) && isObject(payload.meta)
          ? payload.meta
          : {},
      wallets: extractWallets(payload),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { meta: {}, wallets: [] };
    }

    throw error;
  }
}

async function main() {
  const inputArg = process.argv[2];
  if (!inputArg) usage();

  const inputPath = path.resolve(inputArg);
  const masterPath = path.resolve(
    process.argv[3] ?? DEFAULT_MASTER,
  );

  if (inputPath === masterPath) {
    throw new Error(
      "Input file and master file must be different paths.",
    );
  }

  const now = new Date().toISOString();

  const [incomingPayload, master] = await Promise.all([
    loadJson(inputPath),
    loadMaster(masterPath),
  ]);

  const incomingWallets = extractWallets(incomingPayload);

  // Deduplicate hasil scrape baru terlebih dahulu.
  const incomingByOwner = new Map<string, SmartLpWallet>();
  for (const wallet of incomingWallets) {
    incomingByOwner.set(wallet.owner, wallet);
  }

  // Build index master sekali saja -> O(1) lookup per wallet.
  const masterByOwner = new Map<string, SmartLpWallet>();
  for (const wallet of master.wallets) {
    masterByOwner.set(wallet.owner, wallet);
  }

  let added = 0;
  let updated = 0;

  for (const incoming of incomingByOwner.values()) {
    const existing = masterByOwner.get(incoming.owner);

    if (!existing) {
      masterByOwner.set(incoming.owner, {
        ...incoming,
        _local: {
          firstSeenAt: now,
          lastSeenAt: now,
          scrapeCount: 1,
        },
      });

      added += 1;
      continue;
    }

    masterByOwner.set(
      incoming.owner,
      mergeWallet(existing, incoming, now),
    );

    updated += 1;
  }

  const wallets = [...masterByOwner.values()].sort((a, b) => {
    const bt = parseDate(b.last_activity) ?? 0;
    const at = parseDate(a.last_activity) ?? 0;

    return bt - at || a.owner.localeCompare(b.owner);
  });

  const incomingMeta = extractMeta(incomingPayload);

  const output: MasterFile = {
    meta: {
      ...(master.meta ?? {}),
      ...incomingMeta,

      updatedAt: now,
      uniqueWallets: wallets.length,

      lastImport: {
        sourceFile: path.basename(inputPath),
        importedWalletRows: incomingWallets.length,
        uniqueIncomingWallets: incomingByOwner.size,
        added,
        updated,
      },
    },

    wallets,
  };

  await mkdir(path.dirname(masterPath), {
    recursive: true,
  });

  // Atomic-ish write: tulis temp dulu baru rename.
  const tempPath = `${masterPath}.tmp`;

  await writeFile(
    tempPath,
    JSON.stringify(output, null, 2) + "\n",
    "utf8",
  );

  await rename(tempPath, masterPath);

  console.log("\nSMART LP WALLET UPSERT COMPLETE");
  console.log("===============================");
  console.log(`Input rows       : ${incomingWallets.length}`);
  console.log(`Unique incoming  : ${incomingByOwner.size}`);
  console.log(`Updated existing : ${updated}`);
  console.log(`Added new        : ${added}`);
  console.log(`Master wallets   : ${wallets.length}`);
  console.log(`Master file      : ${masterPath}`);
}

main().catch((error) => {
  console.error("\nUPSERT FAILED");
  console.error(
    error instanceof Error
      ? error.stack || error.message
      : error,
  );

  process.exitCode = 1;
});
