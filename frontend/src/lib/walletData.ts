import type { WalletDataset } from "../types";

export async function loadWalletDataset(): Promise<WalletDataset> {
  const response = await fetch("/data/wallets-14d.json");
  if (!response.ok) {
    throw new Error(`Failed to load wallet dataset (${response.status})`);
  }
  return response.json();
}
