import { CalendarDays, RotateCcw, SlidersHorizontal } from "lucide-react";

export type FilterState = {
  search: string;
  minPnl: string;
  minLp: string;
  minWinRate: string;
  minPools: string;
  firstActivityFrom: string;
};

export const defaultFilters: FilterState = {
  search: "",
  minPnl: "",
  minLp: "",
  minWinRate: "",
  minPools: "",
  firstActivityFrom: "2026-09-06",
};

export function Filters({
  draft,
  setDraft,
  onApply,
  onReset,
}: {
  draft: FilterState;
  setDraft: (next: FilterState) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const set = (key: keyof FilterState, value: string) =>
    setDraft({ ...draft, [key]: value });

  return (
    <div className="filters-card">
      <div className="filter-field wide">
        <label>Wallet search</label>
        <input
          value={draft.search}
          onChange={(e) => set("search", e.target.value)}
          placeholder="Wallet address..."
        />
      </div>

      <div className="filter-field">
        <label>First Activity</label>
        <div className="input-icon">
          <CalendarDays size={14} />
          <input
            type="date"
            value={draft.firstActivityFrom}
            onChange={(e) => set("firstActivityFrom", e.target.value)}
          />
        </div>
      </div>

      <div className="filter-field">
        <label>Min PnL 7D (SOL)</label>
        <input
          inputMode="decimal"
          value={draft.minPnl}
          onChange={(e) => set("minPnl", e.target.value)}
          placeholder="Any"
        />
      </div>

      <div className="filter-field">
        <label>Min LP 7D</label>
        <input
          inputMode="numeric"
          value={draft.minLp}
          onChange={(e) => set("minLp", e.target.value)}
          placeholder="Any"
        />
      </div>

      <div className="filter-field">
        <label>Min Win Rate (%)</label>
        <input
          inputMode="decimal"
          value={draft.minWinRate}
          onChange={(e) => set("minWinRate", e.target.value)}
          placeholder="Any"
        />
      </div>

      <div className="filter-field">
        <label>Min Pools</label>
        <input
          inputMode="numeric"
          value={draft.minPools}
          onChange={(e) => set("minPools", e.target.value)}
          placeholder="Any"
        />
      </div>

      <button className="btn secondary" onClick={onReset}>
        <RotateCcw size={14} />
        Reset
      </button>
      <button className="btn primary" onClick={onApply}>
        <SlidersHorizontal size={14} />
        Apply
      </button>
    </div>
  );
}
