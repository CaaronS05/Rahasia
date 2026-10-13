import { SlidersHorizontal } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import {
  type FilterState,
  defaultFilters,
} from "../lib/walletFilters";
export type { FilterState };
export { defaultFilters };

type Props = {
  draft: FilterState;
  setDraft: Dispatch<SetStateAction<FilterState>>;
  onApply: () => void;
  onReset?: () => void;
  timeframe?: "7d" | "30d" | "all";
};

export function Filters({ draft, setDraft, onApply, onReset, timeframe = "7d" }: Props) {
  function set<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function handleReset() {
    setDraft(defaultFilters);
    if (onReset) {
      onReset();
    }
  }
  return (
    <form
      className="filters-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <div className="filters-label">
        <SlidersHorizontal size={14} />
        <strong>Screening filters</strong>
      </div>
      <label className="filter-control">
        <span>SEARCH WALLET</span>
        <input
          placeholder="Filter by address..."
          value={draft.search}
          onChange={(event) => set("search", event.target.value)}
        />
      </label>


      <label className="filter-control">
        <span>FIRST ACTIVITY START</span>
        <input
          type="date"
          value={draft.firstActivityFrom}
          onChange={(event) => set("firstActivityFrom", event.target.value)}
        />
      </label>

      <label className="filter-control">
        <span>FIRST ACTIVITY END</span>
        <input
          type="date"
          value={draft.firstActivityTo}
          onChange={(event) => set("firstActivityTo", event.target.value)}
        />
      </label>

      <label className="filter-control">
        <span>MIN {timeframe === "all" ? "ALL-TIME" : timeframe.toUpperCase()} PNL (SOL)</span>
        <input
          inputMode="decimal"
          placeholder="Any"
          value={draft.minPnl}
          onChange={(event) => set("minPnl", event.target.value)}
        />
      </label>

      <label className="filter-control">
        <span>MIN LP {timeframe === "all" ? "ALL-TIME" : timeframe.toUpperCase()}</span>
        <input
          inputMode="numeric"
          placeholder="Any"
          value={draft.minLp}
          onChange={(event) => set("minLp", event.target.value)}
        />
      </label>

      <label className="filter-control">
        <span>MIN WIN RATE (%)</span>
        <input
          inputMode="decimal"
          placeholder="Any"
          value={draft.minWinRate}
          onChange={(event) => set("minWinRate", event.target.value)}
        />
      </label>

      <label className="filter-control">
        <span>MIN POOLS</span>
        <input
          inputMode="numeric"
          placeholder="Any"
          value={draft.minPools}
          onChange={(event) => set("minPools", event.target.value)}
        />
      </label>

      <div className="filter-actions">
        <button
          type="button"
          className="secondary-button reset-filters-btn"
          onClick={handleReset}
        >
          Reset Filters
        </button>
        <button className="primary-button" type="submit">
          Apply
        </button>
      </div>
    </form>
  );
}
