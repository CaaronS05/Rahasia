export type ColumnKey =
  | "wallet"
  | "shortlist"
  | "quality"
  | "risk"
  | "confidence"
  | "style"
  | "pnl7"
  | "win"
  | "winDays"
  | "loseDays"
  | "pnl30"
  | "pnlAll"
  | "positions"
  | "walletAge"
  | "age"
  | "ev"
  | "invested"
  | "monthly"
  | "fees"
  | "last";

export const labels: Record<ColumnKey, string> = {
  wallet: "Wallet",
  shortlist: "Shortlist",
  quality: "Quality",
  risk: "Risk",
  confidence: "Confidence",
  style: "Style",
  pnl7: "7D PnL",
  win: "Win Rate",
  winDays: "Win Days",
  loseDays: "Lose Days",
  pnl30: "30D PnL",
  pnlAll: "All-Time PnL",
  positions: "Positions",
  walletAge: "Wallet Age",
  age: "Avg Age",
  ev: "EV",
  invested: "Avg Invested",
  monthly: "Monthly PnL",
  fees: "Fees",
  last: "Last Active",
};

export const COLUMN_STORAGE_KEY = "dlmm_wallet_columns_v1";

export function getDefaultVisibleColumns(
  timeframe: "7d" | "30d" | "all" = "7d",
): Record<ColumnKey, boolean> {
  const pnlKey: ColumnKey =
    timeframe === "30d" ? "pnl30" : timeframe === "all" ? "pnlAll" : "pnl7";
  return {
    wallet: true,
    shortlist: true,
    quality: true,
    risk: true,
    confidence: false,
    style: false,
    pnl7: pnlKey === "pnl7",
    win: true,
    winDays: false,
    loseDays: false,
    pnl30: pnlKey === "pnl30",
    pnlAll: pnlKey === "pnlAll",
    positions: true,
    walletAge: false,
    age: true,
    ev: false,
    invested: false,
    monthly: false,
    fees: false,
    last: false,
  };
}

export const defaultVisible: Record<ColumnKey, boolean> = getDefaultVisibleColumns("7d");

export function loadSavedColumns(): Partial<Record<ColumnKey, boolean>> | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveColumns(columns: Record<ColumnKey, boolean>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // Ignore storage write failures
  }
}

export function clearSavedColumns(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(COLUMN_STORAGE_KEY);
  } catch {
    // Ignore storage remove failures
  }
}
