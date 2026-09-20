export type ScanMode = "auto" | "gtfa" | "standard";

export type Config = {
  apiKey: string;
  rpcUrl: string;
  programId: string;
  scanDays: number;
  mode: ScanMode;
  gtfaPageSize: number;
  signaturePageSize: number;
  getTxConcurrency: number;
  requestRetries: number;
  maxTransactions: number;
};

export type WalletStat = {
  address: string;
  txCount: number;
  feePayerCount: number;
  firstSeen: number;
  lastSeen: number;
};

export type NormalizedTransaction = {
  signature: string;
  blockTime: number;
  feePayer: string | null;
  signers: string[];
};

export type ScanSummary = {
  source: "gtfa" | "standard";
  startTime: number;
  endTime: number;
  transactionsScanned: number;
  uniqueWallets: number;
  wallets: Map<string, WalletStat>;
};
