import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dateLabel, fmt } from "../lib/format";
import type { Wallet } from "../types";

export function DailyActivity({ wallet }: { wallet: Wallet }) {
  const data = wallet.pnl_chart.map((p) => ({
    label: dateLabel(p.close_day),
    pnl: p.sum_native,
    fees: p.total_fee_native,
  }));

  return (
    <div className="mini-grid">
      <section className="small-card">
        <div className="small-card-title">Daily PnL (SOL)</div>
        <div className="mini-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, left: -28, bottom: 0 }}>
              <CartesianGrid stroke="#1c2533" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#6f7d93", fontSize: 9 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: "#6f7d93", fontSize: 9 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: "#0d131d", border: "1px solid #243044", borderRadius: 9, fontSize: 11 }}
                formatter={(value: number) => `${fmt(value, 4)} SOL`}
              />
              <Bar dataKey="pnl" fill="#35e78b" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="small-card">
        <div className="small-card-title">Win Rate</div>
        <div className="win-rate-card">
          <div
            className="donut"
            style={{
              background: `conic-gradient(#35e78b ${wallet.win_rate_native * 360}deg, #1a2230 0deg)`,
            }}
          >
            <div className="donut-inner">
              <strong>{fmt(wallet.win_rate_native * 100, 1)}%</strong>
              <span>native</span>
            </div>
          </div>
          <div className="win-rate-copy">
            <div><span className="dot green" /> Win rate</div>
            <strong>{fmt(wallet.win_rate_native * 100, 2)}%</strong>
            <span>{wallet.closed_lp.toLocaleString()} closed LP records</span>
          </div>
        </div>
      </section>
    </div>
  );
}
