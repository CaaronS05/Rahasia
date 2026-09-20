import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScanSummary, WalletStat } from "./types.ts";

function iso(epoch: number) {
  return new Date(epoch * 1000).toISOString();
}

function csvEscape(value: string | number) {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function sortedWallets(summary: ScanSummary): WalletStat[] {
  return [...summary.wallets.values()].sort(
    (a, b) => b.txCount - a.txCount || b.lastSeen - a.lastSeen,
  );
}

export async function writeOutputs(summary: ScanSummary) {
  const outputDir = path.resolve("output");
  await mkdir(outputDir, { recursive: true });

  const rows = sortedWallets(summary);
  const csvHeader = [
    "wallet_address",
    "tx_count",
    "fee_payer_count",
    "first_seen_utc",
    "last_seen_utc",
  ];
  const csv = [
    csvHeader.join(","),
    ...rows.map((w) =>
      [w.address, w.txCount, w.feePayerCount, iso(w.firstSeen), iso(w.lastSeen)]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n");

  const json = {
    source: summary.source,
    start_time_utc: iso(summary.startTime),
    end_time_utc: iso(summary.endTime),
    transactions_scanned: summary.transactionsScanned,
    unique_wallets: summary.uniqueWallets,
    wallets: rows.map((w) => ({
      wallet_address: w.address,
      tx_count: w.txCount,
      fee_payer_count: w.feePayerCount,
      first_seen_utc: iso(w.firstSeen),
      last_seen_utc: iso(w.lastSeen),
    })),
  };

  const csvPath = path.join(outputDir, "wallets_7d.csv");
  const jsonPath = path.join(outputDir, "wallets_7d.json");
  await Promise.all([
    writeFile(csvPath, csv + "\n", "utf8"),
    writeFile(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8"),
  ]);

  return { csvPath, jsonPath, rows };
}
