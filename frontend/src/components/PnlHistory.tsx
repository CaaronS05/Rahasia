import { CalendarDays, ChartNoAxesCombined } from "lucide-react";
import { useMemo, useState } from "react";
import type { PnlPoint } from "../types";
import { PnlCalendar } from "./PnlCalendar";
import { PnlChart } from "./PnlChart";

type Range = "7D" | "14D" | "30D" | "ALL";

export function PnlHistory({ points }: { points: PnlPoint[] }) {
  const [view, setView] = useState<"chart" | "calendar">("chart");
  const [range, setRange] = useState<Range>("7D");

  const filtered = useMemo(() => {
    if (!points.length || range === "ALL") return points;
    const days = range === "7D" ? 7 : range === "14D" ? 14 : 30;
    const max = new Date(points[points.length - 1].close_day).getTime();
    const min = max - (days - 1) * 86400000;
    return points.filter((p) => new Date(p.close_day).getTime() >= min);
  }, [points, range]);

  return (
    <section className="pnl-card">
      <div className="pnl-heading">
        <div>
          <strong>Cumulative PnL</strong>
          <span>Real LP Agent daily history in SOL</span>
        </div>

        <div className="pnl-controls">
          <div className="segmented">
            <button
              className={view === "chart" ? "active" : ""}
              onClick={() => setView("chart")}
            >
              <ChartNoAxesCombined size={13} />
              Chart
            </button>
            <button
              className={view === "calendar" ? "active" : ""}
              onClick={() => setView("calendar")}
            >
              <CalendarDays size={13} />
              Calendar
            </button>
          </div>

          <div className="segmented compact-segment">
            {(["7D", "14D", "30D", "ALL"] as Range[]).map((item) => (
              <button
                key={item}
                className={range === item ? "active" : ""}
                onClick={() => setRange(item)}
              >
                {item === "ALL" ? "All" : item}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "chart" ? (
        <PnlChart points={filtered} />
      ) : (
        <PnlCalendar points={filtered} />
      )}
    </section>
  );
}
