import type { Config, ScanMode } from "./types.ts";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!apiKey) throw new Error("HELIUS_API_KEY is required in .env");

  const mode = (process.env.SCAN_MODE || "auto") as ScanMode;
  if (!["auto", "gtfa", "standard"].includes(mode)) {
    throw new Error("SCAN_MODE must be auto, gtfa, or standard");
  }

  return {
    apiKey,
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
    programId:
      process.env.METEORA_DLMM_PROGRAM_ID?.trim() ||
      "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    scanDays: intEnv("SCAN_DAYS", 7),
    mode,
    gtfaPageSize: Math.min(100, Math.max(1, intEnv("GTFA_PAGE_SIZE", 100))),
    signaturePageSize: Math.min(
      1000,
      Math.max(1, intEnv("STANDARD_SIGNATURE_PAGE_SIZE", 1000)),
    ),
    getTxConcurrency: Math.max(1, intEnv("GET_TX_CONCURRENCY", 8)),
    requestRetries: Math.max(1, intEnv("REQUEST_RETRIES", 6)),
    maxTransactions: intEnv("MAX_TRANSACTIONS", 0),
  };
}
