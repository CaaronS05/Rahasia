import {
  Activity,
  Copy,
  ExternalLink,
  Layers3,
  MoreVertical,
  Star,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  duration,
  fmt,
  fullDate,
  pct,
  shortWallet,
  timeAgo,
} from "../lib/format";
import type { Wallet } from "../types";
import { DailyActivity } from "./DailyActivity";
import { PnlHistory } from "./PnlHistory";

type Tab = "Overview" | "LP Positions" | "Trades" | "Pools" | "Activity";

function DetailStat({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="detail-stat">
      <span>{label}</span>
      <strong className={className}>{value}</strong>
    </div>
  );
}

export function WalletDetailPanel({ wallet }: { wallet?: Wallet }) {
  const [tab, setTab] = useState<Tab>("Overview");

  const dailyRows = useMemo(
    () => [...(wallet?.pnl_chart ?? [])].reverse(),
    [wallet]
  );

  if (!wallet) {
    return (
      <aside className="detail-panel empty-detail">
        <Layers3 size={28} />
        <strong>Select a wallet</strong>
        <span>Click any table row to inspect its metrics and PnL history.</span>
      </aside>
    );
  }

  const pnlPositive = wallet.total_pnl_native_7d >= 0;

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <div className="wallet-identity">
          <div className="wallet-avatar">◎</div>
          <div>
            <div className="wallet-title-row">
              <strong>{shortWallet(wallet.owner, 12, 5)}</strong>
              <button
                className="icon-btn"
                onClick={() => navigator.clipboard.writeText(wallet.owner)}
              >
                <Copy size={13} />
              </button>
            </div>
            <div className="identity-meta">
              <span className="network-badge">Solana</span>
              <span className="protocol-badge">Meteora</span>
              <span className="active-badge">Active</span>
            </div>
          </div>
        </div>

        <div className="detail-actions">
          <button className="icon-btn bordered"><Star size={14} /></button>
          <a
            className="btn ghost small"
            href={`https://solscan.io/account/${wallet.owner}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} />
            Explorer
          </a>
          <button className="icon-btn bordered"><MoreVertical size={14} /></button>
        </div>
      </div>

      <div className="first-seen">
        First seen <strong>{fullDate(wallet.first_activity)}</strong>
        <span> · Last active {timeAgo(wallet.last_activity)}</span>
      </div>

      <div className="detail-tabs">
        {(["Overview", "LP Positions", "Trades", "Pools", "Activity"] as Tab[]).map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <>
          <div className="detail-stats-grid">
            <DetailStat
              label="PnL 7D (SOL)"
              value={`${pnlPositive ? "+" : ""}${fmt(wallet.total_pnl_native_7d, 4)}`}
              className={pnlPositive ? "positive" : "negative"}
            />
            <DetailStat label="Win Rate" value={pct(wallet.win_rate_native, 1)} />
            <DetailStat label="Total LP 7D" value={wallet.total_lp_7d.toLocaleString()} />
            <DetailStat label="Total Pools" value={wallet.total_pool.toLocaleString()} />
            <DetailStat label="Total Inflow (SOL)" value={fmt(wallet.total_inflow_native, 2)} />
            <DetailStat label="Total Outflow (SOL)" value={fmt(wallet.total_outflow_native, 2)} />
            <DetailStat label="Fees Earned (SOL)" value={fmt(wallet.total_fee_native, 2)} />
            <DetailStat label="Avg Position Age" value={duration(wallet.avg_age_hour)} />
          </div>

          <PnlHistory points={wallet.pnl_chart} />
          <DailyActivity wallet={wallet} />

          <section className="activity-card">
            <div className="activity-card-title">
              <div>
                <strong>Daily LP Activity</strong>
                <span>Derived from the captured pnl_chart records</span>
              </div>
              <Activity size={16} />
            </div>

            <div className="activity-table-wrap">
              <table className="activity-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>PnL</th>
                    <th>Fees</th>
                    <th>LP</th>
                    <th>Closed</th>
                    <th>Pools</th>
                  </tr>
                </thead>

                <tbody>
                  {dailyRows.map((p) => (
                    <tr key={p.close_day}>
                      <td>{fullDate(p.close_day)}</td>
                      <td className={p.sum_native >= 0 ? "positive" : "negative"}>
                        {p.sum_native >= 0 ? "+" : ""}{fmt(p.sum_native, 4)}
                      </td>
                      <td>{fmt(p.total_fee_native, 3)}</td>
                      <td>{p.total_lp}</td>
                      <td>{p.closed_lp}</td>
                      <td>{p.total_pools}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <div className="tab-placeholder">
          <Layers3 size={25} />

          {/* 0123 adalah marker visual bahwa section ini BELUM punya real data. */}
          <strong>0123 · DUMMY</strong>

          <span>
            {tab} belum terhubung ke data position/trade-level.
            Jangan gunakan section ini untuk analisis sampai pipeline datanya disambungkan.
          </span>
        </div>
      )}
    </aside>
  );
}
