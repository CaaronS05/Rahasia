import type { PnlPoint } from "../types";

export function Sparkline({ points }: { points: PnlPoint[] }) {
  const values = points.map((p) => p.cumulative_pnl_native);
  if (values.length < 2) return <span className="muted">—</span>;

  const width = 54;
  const height = 20;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const coords = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 3) - 1.5;
      return `${x},${y}`;
    })
    .join(" ");

  const positive = values.at(-1)! >= values[0];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={coords}
        fill="none"
        stroke={positive ? "#3ce88b" : "#ff5d6f"}
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
