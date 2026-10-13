import type { ChartTimeframe, PnlPoint, Wallet } from "../../types";
import {
  computePeriodCumulativePnl,
  extractNormalizedDailyPnl,
  filterDailyPnlByTimeframe,
} from "../../lib/walletMetrics";

export type PnlChartProps = {
  points?: PnlPoint[];
  wallet?: Wallet;
  timeframe?: ChartTimeframe;
  referenceDate?: string;
  currency?: "SOL" | "USD";
};

function svgLine(values: number[], width: number, height: number) {
  if (values.length < 2) return "";

  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;

  return values
    .map((value, index) => {
      const x = 12 + (index / (values.length - 1)) * (width - 24);
      const y = 12 + (1 - (value - min) / range) * (height - 34);
      return `${x},${y}`;
    })
    .join(" ");
}

export function CumulativePnlChart({
  points,
  wallet,
  timeframe = "30D",
  referenceDate,
  currency = "SOL",
}: PnlChartProps) {
  const dailyPoints = extractNormalizedDailyPnl(wallet ?? points, currency);
  const filteredPoints = filterDailyPnlByTimeframe(dailyPoints, timeframe, referenceDate);
  const cumulativeSeries = computePeriodCumulativePnl(filteredPoints);

  const values = cumulativeSeries.map((p) => p.cumulativePnl);
  const count = values.length;

  const width = 560;
  const height = 210;

  if (count === 0) {
    return (
      <div className="portfolio-chart">
        <div className="chart-empty">Not enough chart data</div>
      </div>
    );
  }

  const lastVal = values[count - 1];
  const chartColor = lastVal < 0 ? "var(--red)" : "var(--green)";

  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;

  let line = "";
  let areaPoints = "";
  let singleY = 0;

  if (count === 1) {
    singleY = 12 + (1 - (values[0] - min) / range) * (height - 34);
    line = `12,${singleY} ${width - 12},${singleY}`;
    areaPoints = `12,${height - 18} 12,${singleY} ${width - 12},${singleY} ${width - 12},${height - 18}`;
  } else {
    line = svgLine(values, width, height);
    areaPoints = `12,${height - 18} ${line} ${width - 12},${height - 18}`;
  }

  return (
    <div className="portfolio-chart" style={{ color: chartColor }}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="portfolioArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity=".30" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[42, 82, 122, 162].map((y) => (
          <line key={y} x1="12" x2={width - 12} y1={y} y2={y} className="chart-grid-line" />
        ))}

        <polygon
          points={areaPoints}
          fill="url(#portfolioArea)"
          stroke="none"
        />
        <polyline points={line} fill="none" className="chart-line" />
        {count === 1 ? (
          <circle
            cx={width / 2}
            cy={singleY}
            r={4}
            fill="currentColor"
          />
        ) : null}
      </svg>
    </div>
  );
}

export function DailyPnlChart({
  points,
  wallet,
  timeframe = "30D",
  referenceDate,
  currency = "SOL",
}: PnlChartProps) {
  const dailyPoints = extractNormalizedDailyPnl(wallet ?? points, currency);
  const filteredPoints = filterDailyPnlByTimeframe(dailyPoints, timeframe, referenceDate);

  if (filteredPoints.length === 0) {
    return (
      <div className="daily-bars">
        <div className="chart-empty">Not enough chart data</div>
      </div>
    );
  }

  const values = filteredPoints.map((point) => point.pnl);
  const max = Math.max(...values.map((value) => Math.abs(value)), 0.0001);

  return (
    <div className="daily-bars">
      {filteredPoints.map((point) => {
        const val = point.pnl;
        const barClass = val > 0 ? "positive-bar" : val < 0 ? "negative-bar" : "zero-bar";
        const heightPct = val === 0 ? 4 : Math.max(6, (Math.abs(val) / max) * 92);
        const sign = val > 0 ? "+" : "";

        return (
          <span
            key={point.date}
            className={barClass}
            style={{
              height: `${heightPct}%`,
            }}
            title={`${point.date}: ${sign}${val.toFixed(4)} ${currency}`}
          />
        );
      })}
    </div>
  );
}
