import type { ReactNode } from "react";

export function MetricCard({
  label,
  value,
  helper,
  icon,
  positive,
}: {
  label: string;
  value: ReactNode;
  helper?: ReactNode;
  icon?: ReactNode;
  positive?: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="metric-card-top">
        <span>{label}</span>
        {icon}
      </div>
      <div className={`metric-value ${positive ? "positive" : ""}`}>{value}</div>
      {helper ? <div className="metric-helper">{helper}</div> : null}
    </div>
  );
}
