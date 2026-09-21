import type { NormalizedTransaction } from "./types.ts";

function pubkeyOf(key: unknown): string | null {
  if (typeof key === "string") return key;
  if (key && typeof key === "object" && "pubkey" in key) {
    const value = (key as { pubkey?: unknown }).pubkey;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "toString" in value) {
      return String(value);
    }
  }
  return null;
}

export function normalizeTransaction(item: any): NormalizedTransaction | null {
  if (!item) return null;

  // Works for both getTransactionsForAddress full rows and getTransaction responses.
  const tx = item.transaction ?? item;
  const message = tx?.message;
  if (!message) return null;

  const blockTime = Number(item.blockTime ?? tx.blockTime ?? 0);
  if (!Number.isFinite(blockTime) || blockTime <= 0) return null;

  const accountKeys: unknown[] = Array.isArray(message.accountKeys)
    ? message.accountKeys
    : [];

  const keys = accountKeys.map(pubkeyOf).filter((v): v is string => Boolean(v));
  if (!keys.length) return null;

  let signers: string[] = [];

  // jsonParsed accountKeys may expose signer directly.
  const parsedSigners = accountKeys
    .filter(
      (k: any) =>
        k && typeof k === "object" && k.signer === true && pubkeyOf(k) !== null,
    )
    .map((k) => pubkeyOf(k)!)
    .filter(Boolean);

  if (parsedSigners.length) {
    signers = parsedSigners;
  } else {
    // Raw/compiled Solana message: first numRequiredSignatures static keys are signers.
    const numRequiredSignatures = Number(message.header?.numRequiredSignatures ?? 0);
    signers = keys.slice(0, Math.max(0, numRequiredSignatures));
  }

  const signatures = Array.isArray(tx.signatures) ? tx.signatures : [];
  const signature = typeof signatures[0] === "string" ? signatures[0] : "unknown";

  return {
    signature,
    blockTime,
    feePayer: keys[0] ?? null,
    signers: [...new Set(signers)],
  };
}
