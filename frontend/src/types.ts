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

  total_inflow: number;
  avg_inflow: number;
  total_outflow: number;
  total_fee: number;
  total_reward: number;
  total_pnl: number;

  total_inflow_native: number;
  avg_inflow_native: number;
  total_outflow_native: number;
  total_fee_native: number;
  total_reward_native: number;
  total_pnl_native: number;

  avg_age_hour: number;
  total_lp: number;
  win_lp: number;
  win_lp_native: number;
  closed_lp: number;
  opening_lp: number;
  total_pool: number;
  win_rate: number;
  win_rate_native: number;
  expected_value: number;
  expected_value_native: number;
  fee_percent: number;
  fee_percent_native: number;
  apr: number;
  roi: number;
  roi_avg_inflow: number;
  roi_avg_inflow_native: number;

  first_activity: string;
  last_activity: string;

  avg_pos_profit: number;
  avg_pos_profit_native: number;
  avg_monthly_profit_percent: number;
  avg_monthly_pnl: number;
  avg_monthly_inflow: number;
  avg_monthly_profit_percent_native: number;
  avg_monthly_pnl_native: number;
  avg_monthly_inflow_native: number;

  updated_at: string;
  pnl_chart: PnlPoint[];

  total_pnl_7d: number;
  total_pnl_native_7d: number;
  total_pnl_30d: number;
  total_pnl_native_30d: number;
  total_lp_7d: number;
  total_lp_30d: number;

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
