import type { NormalizedTransaction, WalletStat } from "./types.ts";

export function addTransactionToWallets(
  wallets: Map<string, WalletStat>,
  tx: NormalizedTransaction,
) {
  const uniqueSigners = [...new Set(tx.signers)];

  for (const address of uniqueSigners) {
    const current = wallets.get(address);
    if (!current) {
      wallets.set(address, {
        address,
        txCount: 1,
        feePayerCount: address === tx.feePayer ? 1 : 0,
        firstSeen: tx.blockTime,
        lastSeen: tx.blockTime,
      });
      continue;
    }

    current.txCount += 1;
    if (address === tx.feePayer) current.feePayerCount += 1;
    current.firstSeen = Math.min(current.firstSeen, tx.blockTime);
    current.lastSeen = Math.max(current.lastSeen, tx.blockTime);
  }
}
