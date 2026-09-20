import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dateLabel, fmt } from "../lib/format";
import type { PnlPoint } from "../types";

export function PnlChart({ points }: { points: PnlPoint[] }) {
  const data = points.map((p) => ({
    ...p,
    label: dateLabel(p.close_day),
  }));

  return (
    <div className="chart-height">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="pnlArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#34e58a" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#34e58a" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1d2634" strokeDasharray="3 3" vertical={true} />
          <XAxis
            dataKey="label"
            tick={{ fill: "#748198", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: "#748198", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => fmt(v, 1)}
          />
          <Tooltip
            contentStyle={{
              background: "#0d131d",
              border: "1px solid #243044",
              borderRadius: 10,
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => [
              `${fmt(value, 4)} SOL`,
              name === "cumulative_pnl_native" ? "Cumulative PnL" : name,
            ]}
          />
          <Area
            type="monotone"
            dataKey="cumulative_pnl_native"
            stroke="none"
            fill="url(#pnlArea)"
          />
          <Line
            type="monotone"
            dataKey="cumulative_pnl_native"
            stroke="#35e78b"
            strokeWidth={2}
            dot={{ r: 2, fill: "#35e78b", strokeWidth: 0 }}
            activeDot={{ r: 4, fill: "#35e78b" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
