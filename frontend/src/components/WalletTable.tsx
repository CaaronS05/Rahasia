import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
} from "lucide-react";
import { useMemo, useState } from "react";
import { csvEscape, duration, fmt, pct, shortWallet, timeAgo } from "../lib/format";
import type { SortKey, Wallet } from "../types";
import { Sparkline } from "./Sparkline";

type ColumnKey =
  | "wallet"
  | "pnl"
  | "win"
  | "lp"
  | "pools"
  | "age"
  | "inflow"
  | "fees"
  | "last"
  | "trend";

const columnLabels: Record<ColumnKey, string> = {
  wallet: "Wallet",
  pnl: "PnL 7D (SOL)",
  win: "Win Rate",
  lp: "Total LP 7D",
  pools: "Pools",
  age: "Avg Age",
  inflow: "Avg Inflow (SOL)",
  fees: "Fees (SOL)",
  last: "Last Activity",
  trend: "Trend",
};

const columnSortKeys: Partial<Record<ColumnKey, SortKey>> = {
  wallet: "owner",
  pnl: "total_pnl_native_7d",
  win: "win_rate_native",
  lp: "total_lp_7d",
  pools: "total_pool",
  age: "avg_age_hour",
  inflow: "avg_inflow_native",
  fees: "total_fee_native",
  last: "last_activity",
};

export function WalletTable({
  wallets,
  totalUnfiltered,
  selected,
  onSelect,
  sortKey,
  sortDir,
  onSort,
}: {
  wallets: Wallet[];
  totalUnfiltered: number;
  selected?: string;
  onSelect: (wallet: Wallet) => void;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visible, setVisible] = useState<Record<ColumnKey, boolean>>({
    wallet: true,
    pnl: true,
    win: true,
    lp: true,
    pools: true,
    age: true,
    inflow: true,
    fees: true,
    last: true,
    trend: true,
  });

  const pageCount = Math.max(1, Math.ceil(wallets.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const rows = useMemo(
    () => wallets.slice((safePage - 1) * pageSize, safePage * pageSize),
    [wallets, safePage, pageSize]
  );

  const exportCsv = () => {
    const header = [
      "wallet",
      "pnl_7d_sol",
      "win_rate",
      "total_lp_7d",
      "total_pools",
      "avg_age_hour",
      "avg_inflow_sol",
      "fees_sol",
      "first_activity",
      "last_activity",
    ];
    const body = wallets.map((w) => [
      w.owner,
      w.total_pnl_native_7d,
      w.win_rate_native,
      w.total_lp_7d,
      w.total_pool,
      w.avg_age_hour,
      w.avg_inflow_native,
      w.total_fee_native,
      w.first_activity,
      w.last_activity,
    ]);
    const csv = [header, ...body]
      .map((row) => row.map(csvEscape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "soltrace-wallets-filtered.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const sortIcon = (key?: SortKey) => {
    if (!key) return null;
    if (sortKey !== key) return <ArrowUpDown size={12} />;
    return sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
  };

  const toggleColumn = (key: ColumnKey) =>
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <section className="table-card">
      <div className="table-toolbar">
        <div className="view-pills">
          <button className="pill active">Table</button>
          <span>{wallets.length.toLocaleString()} wallets</span>
        </div>

        <div className="toolbar-actions">
          <div className="columns-wrap">
            <button className="btn ghost" onClick={() => setColumnsOpen((v) => !v)}>
              <Columns3 size={14} />
              Columns
            </button>
            {columnsOpen ? (
              <div className="columns-menu">
                {(Object.keys(columnLabels) as ColumnKey[]).map((key) => (
                  <button key={key} onClick={() => toggleColumn(key)}>
                    <span>{columnLabels[key]}</span>
                    {visible[key] ? <Check size={14} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button className="btn ghost" onClick={exportCsv}>
            <Download size={14} />
            Export
          </button>
        </div>
      </div>

      <div className="table-scroll">
        <table className="wallet-table">
          <thead>
            <tr>
              <th className="rank-col">#</th>
              {(Object.keys(columnLabels) as ColumnKey[]).map((col) => {
                if (!visible[col]) return null;
                const key = columnSortKeys[col];
                return (
                  <th
                    key={col}
                    className={key ? "sortable" : ""}
                    onClick={() => key && onSort(key)}
                  >
                    <span>{columnLabels[col]} {sortIcon(key)}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((w, index) => {
              const pnlPositive = w.total_pnl_native_7d >= 0;
              return (
                <tr
                  key={w.owner}
                  className={selected === w.owner ? "selected" : ""}
                  onClick={() => onSelect(w)}
                >
                  <td className="rank-col">{(safePage - 1) * pageSize + index + 1}</td>
                  {visible.wallet && (
                    <td>
                      <div className="wallet-cell">
                        <strong>{shortWallet(w.owner, 6, 4)}</strong>
                        <button
                          className="icon-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(w.owner);
                          }}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    </td>
                  )}
                  {visible.pnl && (
                    <td className={pnlPositive ? "positive" : "negative"}>
                      {pnlPositive ? "+" : ""}{fmt(w.total_pnl_native_7d, 3)}
                    </td>
                  )}
                  {visible.win && <td>{pct(w.win_rate_native)}</td>}
                  {visible.lp && <td>{w.total_lp_7d.toLocaleString()}</td>}
                  {visible.pools && <td>{w.total_pool.toLocaleString()}</td>}
                  {visible.age && <td>{duration(w.avg_age_hour)}</td>}
                  {visible.inflow && <td>{fmt(w.avg_inflow_native, 2)}</td>}
                  {visible.fees && <td>{fmt(w.total_fee_native, 2)}</td>}
                  {visible.last && <td className="muted">{timeAgo(w.last_activity)}</td>}
                  {visible.trend && <td><Sparkline points={w.pnl_chart} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span>
          Showing {wallets.length ? (safePage - 1) * pageSize + 1 : 0}–
          {Math.min(safePage * pageSize, wallets.length)} of {wallets.length} filtered
          <span className="subtle"> · {totalUnfiltered} total</span>
        </span>

        <div className="pagination-controls">
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
          <button
            className="icon-btn bordered"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft size={15} />
          </button>
          <span className="page-indicator">{safePage} / {pageCount}</span>
          <button
            className="icon-btn bordered"
            disabled={safePage >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}
