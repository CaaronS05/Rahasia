import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { fmt } from "../lib/format";
import type { PnlPoint } from "../types";

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function PnlCalendar({ points }: { points: PnlPoint[] }) {
  const newest = points.length
    ? new Date(points[points.length - 1].close_day)
    : new Date();

  const [month, setMonth] = useState(
    new Date(Date.UTC(newest.getUTCFullYear(), newest.getUTCMonth(), 1))
  );

  const pointMap = useMemo(() => {
    const map = new Map<string, PnlPoint>();
    for (const point of points) {
      const d = new Date(point.close_day);
      map.set(d.toISOString().slice(0, 10), point);
    }
    return map;
  }, [points]);

  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  const cells: Array<{ day?: number; point?: PnlPoint }> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({});
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
    cells.push({ day, point: pointMap.get(iso) });
  }
  while (cells.length % 7) cells.push({});

  const move = (delta: number) =>
    setMonth(new Date(Date.UTC(year, monthIndex + delta, 1)));

  return (
    <div className="calendar-wrap">
      <div className="calendar-header">
        <button className="icon-btn" onClick={() => move(-1)}>
          <ChevronLeft size={15} />
        </button>
        <strong>
          {month.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })}
        </strong>
        <button className="icon-btn" onClick={() => move(1)}>
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="calendar-grid calendar-days">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>

      <div className="calendar-grid">
        {cells.map((cell, idx) => {
          const pnl = cell.point?.sum_native ?? 0;
          const cls = cell.point
            ? pnl > 0
              ? "calendar-profit"
              : pnl < 0
              ? "calendar-loss"
              : "calendar-flat"
            : "";
          return (
            <div key={`${monthKey(month)}-${idx}`} className={`calendar-cell ${cls}`}>
              {cell.day ? <span className="calendar-date">{cell.day}</span> : null}
              {cell.point ? (
                <strong className={pnl >= 0 ? "positive" : "negative"}>
                  {pnl >= 0 ? "+" : ""}{fmt(pnl, 3)}
                </strong>
              ) : null}
              {cell.point ? (
                <span className="calendar-meta">
                  {cell.point.closed_lp} closed · {cell.point.total_pools} pools
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
