export type PnlPoint = {
  close_day: string;
  sum: number;
  sum_native: number;
  total_invested: number;
  total_invested_native: number;
  max_invested: number;
  max_invested_native: number;
  pnl_percent: number;
  pnl_percent_native: number;
  total_lp: number;
  total_pools: number;
  closed_lp: number;
  win_lp: number;
  total_fee: number;
  total_fee_native: number;
  cumulative_pnl: number;
  cumulative_pnl_native: number;
};

export type FabriqDailyPoint = {
  date: string;
  pnlSol: number;
  pnlUsd: number;
  feesSol: number;
  feesUsd: number;
  positions: number;
  winRateSol: number;
  winRateUsd: number;
};

export type FabriqDerived = {
  asOfDate: string;
  currentMonth: string;

  pnl7dSol: number;
  pnl30dSol: number;
  monthlyPnlSol: number;

  allTimePnlSol: number | null;

  daily: FabriqDailyPoint[];
};

export type Wallet = {
  owner: string;
  chain: string;
  protocol: string;
  source?: "lpagent" | "pool-scanner";

  total_inflow?: number | null;
  avg_inflow?: number | null;
  total_outflow?: number | null;
  total_fee?: number | null;
  total_reward?: number | null;
  total_pnl?: number | null;

  total_inflow_native?: number | null;
  avg_inflow_native?: number | null;
  total_outflow_native?: number | null;
  total_fee_native?: number | null;
  total_reward_native?: number | null;
  total_pnl_native?: number | null;

  avg_age_hour?: number | null;
  total_lp?: number | null;
  win_lp?: number | null;
  win_lp_native?: number | null;
  closed_lp?: number | null;
  opening_lp?: number | null;
  total_pool?: number | null;
  win_rate?: number | null;
  win_rate_native?: number | null;
  expected_value?: number | null;
  expected_value_native?: number | null;
  fee_percent?: number | null;
  fee_percent_native?: number | null;
  apr?: number | null;
  roi?: number | null;
  roi_avg_inflow?: number | null;
  roi_avg_inflow_native?: number | null;

  first_activity?: string | null;
  last_activity?: string | null;

  avg_pos_profit?: number | null;
  avg_pos_profit_native?: number | null;
  avg_monthly_profit_percent?: number | null;
  avg_monthly_pnl?: number | null;
  avg_monthly_inflow?: number | null;
  avg_monthly_profit_percent_native?: number | null;
  avg_monthly_pnl_native?: number | null;
  avg_monthly_inflow_native?: number | null;

  updated_at?: string;
  pnl_chart?: PnlPoint[];

  total_pnl_7d?: number | null;
  total_pnl_native_7d?: number | null;
  total_pnl_30d?: number | null;
  total_pnl_native_30d?: number | null;
  total_lp_7d?: number | null;
  total_lp_30d?: number | null;

  fabriq?: {
    fetchedAt?: string;
    month?: string;

    stats?: {
      dayWinUsd?: {
        percentage?: number;
        wins?: number;
        losses?: number;
      };

      dayWinSol?: {
        percentage?: number;
        wins?: number;
        losses?: number;
      };

      [key: string]: any;
    };

    calendar?: any;

    calendars?: Record<
      string,
      Record<string, any>
    >;
  };

  fabriqDerived?: FabriqDerived;
  intelligenceV1?: WalletIntelligenceV1 | null;
};

export type WalletStyleV1 = "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";

export type WalletIntelligenceV1Performance = {
  totalPnl: number;
  profitFactor: number;
  medianPositionPnlPct: number;
  positionWinRate: number;
  closedPositionCount: number;
  pnlConcentrationTop1: number;
};

export type WalletIntelligenceV1 = {
  wallet: string;
  qualityScore: number | null;
  riskScore: number | null;
  confidenceScore: number | null;
  style: WalletStyleV1 | string | null;
  shortlisted: boolean;
  performance?: WalletIntelligenceV1Performance | null;
};

export type WalletIntelligenceV1Dataset = {
  generatedAt: string;
  version: string;
  population: {
    validWallets: number;
    shortlistedWallets: number;
  };
  shortlistRule: {
    qualityMinimum: number;
    riskMaximum: number;
    confidenceMinimum: number;
  };
  wallets: WalletIntelligenceV1[];
};


export type WalletDataset = {
  meta: {
    scanStartedAt?: string;
    scanFinishedAt?: string;
    uniqueWallets?: number;
    pageCount?: number;
    publishedAt?: string;
    derivedAsOfDate?: string;
  };
  wallets: Wallet[];
};

export type SortKey =
  | "owner"
  | "total_pnl_native_7d"
  | "win_rate_native"
  | "total_lp_7d"
  | "total_pool"
  | "avg_age_hour"
  | "avg_inflow_native"
  | "total_fee_native"
  | "last_activity";
