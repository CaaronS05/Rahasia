export type FilterState = {
  search: string;
  firstActivityFrom: string;
  firstActivityTo: string;
  minPnl: string;
  minLp: string;
  minWinRate: string;
  minPools: string;
};

export const defaultFilters: FilterState = {
  search: "",
  firstActivityFrom: "",
  firstActivityTo: "",
  minPnl: "",
  minLp: "",
  minWinRate: "",
  minPools: "",
};
