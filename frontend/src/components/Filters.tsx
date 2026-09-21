import { SlidersHorizontal } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

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
  firstActivityFrom: "2026-09-06",
  firstActivityTo: "",
  minPnl: "",
  minLp: "",
  minWinRate: "",
  minPools: "",
};

type Props = {
  draft: FilterState;
  setDraft: Dispatch<SetStateAction<FilterState>>;
  onApply: () => void;
};

export function Filters({ draft, setDraft, onApply }: Props) {
  function set<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
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
        <span>MIN 7D PNL (SOL)</span>
        <input
          inputMode="decimal"
          placeholder="Any"
          value={draft.minPnl}
          onChange={(event) => set("minPnl", event.target.value)}
        />
      </label>

      <label className="filter-control">
        <span>MIN LP 7D</span>
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
        <button className="primary-button" type="submit">
          Apply
        </button>
      </div>
    </form>
  );
}
