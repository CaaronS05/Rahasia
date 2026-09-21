import type { PnlPoint } from "../../types";

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

export function CumulativePnlChart({ points }: { points: PnlPoint[] }) {
  const values = points
    .slice(-30)
    .map((point) => Number(point.cumulative_pnl ?? point.cumulative_pnl_native))
    .filter(Number.isFinite);

  const width = 560;
  const height = 210;
  const line = svgLine(values, width, height);

  return (
    <div className="portfolio-chart">
      {values.length > 1 ? (
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
            points={`12,${height - 18} ${line} ${width - 12},${height - 18}`}
            fill="url(#portfolioArea)"
            stroke="none"
          />
          <polyline points={line} fill="none" className="chart-line" />
        </svg>
      ) : (
        <div className="chart-empty">Not enough chart data</div>
      )}
    </div>
  );
}

export function DailyPnlChart({ points }: { points: PnlPoint[] }) {
  const values = points
    .slice(-30)
    .map((point) => Number(point.sum ?? point.sum_native))
    .filter(Number.isFinite);

  const max = Math.max(...values.map((value) => Math.abs(value)), 1);

  return (
    <div className="daily-bars">
      {values.length ? (
        values.map((value, index) => (
          <span
            key={index}
            className={value >= 0 ? "positive-bar" : "negative-bar"}
            style={{
              height: `${Math.max(6, (Math.abs(value) / max) * 92)}%`,
            }}
            title={`${value >= 0 ? "+" : ""}${value.toFixed(2)}`}
          />
        ))
      ) : (
        <div className="chart-empty">Not enough chart data</div>
      )}
    </div>
  );
}
