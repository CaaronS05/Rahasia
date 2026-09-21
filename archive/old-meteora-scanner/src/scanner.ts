import { addTransactionToWallets } from "./aggregate.ts";
import { normalizeTransaction } from "./extract.ts";
import { RpcError, mapConcurrent, rpcCall } from "./rpc.ts";
import type { Config, ScanSummary, WalletStat } from "./types.ts";

type GtfaResult = {
  data?: any[];
  paginationToken?: string | null;
};

type SignatureInfo = {
  signature: string;
  blockTime: number | null;
  err: unknown;
};

function reachedLimit(config: Config, count: number) {
  return config.maxTransactions > 0 && count >= config.maxTransactions;
}

export async function scanWithGtfa(
  config: Config,
  startTime: number,
  endTime: number,
): Promise<ScanSummary> {
  const wallets = new Map<string, WalletStat>();
  let paginationToken: string | undefined;
  let transactionsScanned = 0;
  let page = 0;

  do {
    page += 1;
    const options: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: config.gtfaPageSize,
      maxSupportedTransactionVersion: 1,
      filters: {
        blockTime: { gte: startTime, lte: endTime },
        status: "succeeded",
      },
    };
    if (paginationToken) options.paginationToken = paginationToken;

    const result = await rpcCall<GtfaResult>(config, "getTransactionsForAddress", [
      config.programId,
      options,
    ]);

    const rows = result?.data ?? [];
    for (const row of rows) {
      if (reachedLimit(config, transactionsScanned)) break;
      const tx = normalizeTransaction(row);
      if (!tx) continue;
      if (tx.blockTime < startTime || tx.blockTime > endTime) continue;
      addTransactionToWallets(wallets, tx);
      transactionsScanned += 1;
    }

    paginationToken = result?.paginationToken || undefined;
    console.log(
      `[gTFA] page=${page} rows=${rows.length} tx=${transactionsScanned} wallets=${wallets.size}`,
    );

    if (reachedLimit(config, transactionsScanned)) break;
  } while (paginationToken);

  return {
    source: "gtfa",
    startTime,
    endTime,
    transactionsScanned,
    uniqueWallets: wallets.size,
    wallets,
  };
}

export async function scanWithStandardRpc(
  config: Config,
  startTime: number,
  endTime: number,
): Promise<ScanSummary> {
  const wallets = new Map<string, WalletStat>();
  let before: string | undefined;
  let transactionsScanned = 0;
  let page = 0;
  let done = false;

  while (!done) {
    page += 1;
    const options: Record<string, unknown> = { limit: config.signaturePageSize };
    if (before) options.before = before;

    const signatures = await rpcCall<SignatureInfo[]>(
      config,
      "getSignaturesForAddress",
      [config.programId, options],
    );

    if (!signatures.length) break;

    const inRange = signatures.filter((s) => {
      if (s.err != null || s.blockTime == null) return false;
      if (s.blockTime > endTime) return false;
      if (s.blockTime < startTime) return false;
      return true;
    });

    const remaining =
      config.maxTransactions > 0
        ? Math.max(0, config.maxTransactions - transactionsScanned)
        : inRange.length;
    const selected = config.maxTransactions > 0 ? inRange.slice(0, remaining) : inRange;

    const txs = await mapConcurrent(
      selected,
      config.getTxConcurrency,
      async (sig) => {
        try {
          return await rpcCall<any>(config, "getTransaction", [sig.signature, {
            encoding: "json",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 1,
          }]);
        } catch (error) {
          console.warn(`[standard] getTransaction failed ${sig.signature}: ${String(error)}`);
          return null;
        }
      },
    );

    for (const txRow of txs) {
      const tx = normalizeTransaction(txRow);
      if (!tx) continue;
      addTransactionToWallets(wallets, tx);
      transactionsScanned += 1;
    }

    console.log(
      `[standard] page=${page} signatures=${signatures.length} in_range=${inRange.length} tx=${transactionsScanned} wallets=${wallets.size}`,
    );

    if (reachedLimit(config, transactionsScanned)) break;

    const oldest = signatures[signatures.length - 1];
    before = oldest.signature;
    if (oldest.blockTime != null && oldest.blockTime < startTime) done = true;
    if (signatures.length < config.signaturePageSize) done = true;
  }

  return {
    source: "standard",
    startTime,
    endTime,
    transactionsScanned,
    uniqueWallets: wallets.size,
    wallets,
  };
}

export async function scanWallets(config: Config): Promise<ScanSummary> {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - config.scanDays * 24 * 60 * 60;

  if (config.mode === "standard") {
    return scanWithStandardRpc(config, startTime, endTime);
  }

  if (config.mode === "gtfa") {
    return scanWithGtfa(config, startTime, endTime);
  }

  try {
    return await scanWithGtfa(config, startTime, endTime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RpcError ? error.code : undefined;
    console.warn(
      `[auto] getTransactionsForAddress unavailable (code=${code ?? "?"}): ${message}`,
    );
    console.warn("[auto] falling back to standard Solana RPC...");
    return scanWithStandardRpc(config, startTime, endTime);
  }
}
