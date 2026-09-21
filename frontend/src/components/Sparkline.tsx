type Props = {
  values: number[];
};

export function Sparkline({ values }: Props) {
  if (values.length < 2) return <span className="sparkline-empty">—</span>;

  const width = 62;
  const height = 22;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x},${y}`;
    })
    .join(" ");

  const positive = values[values.length - 1] >= values[0];

  return (
    <svg
      className={`sparkline ${positive ? "positive" : "negative"}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
