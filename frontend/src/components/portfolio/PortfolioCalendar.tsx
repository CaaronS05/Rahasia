import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

type CalendarEntry = {
  date: string;
  pnl: number;
  positions: number;
  winRate?: number;
};

function normalize(data: any): CalendarEntry[] {
  if (!data) return [];

  const result: CalendarEntry[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const date = item.date ?? item.day ?? item.close_day ?? item.timestamp;
      if (!date) continue;
      result.push({
        date: String(date).slice(0, 10),
        pnl: Number(item.pnlUsd ?? item.pnl ?? item.realizedPnlUsd ?? 0),
        positions: Number(item.positions ?? item.totalPositions ?? 0),
        winRate: Number(item.winRateUsd ?? item.winRate ?? 0),
      });
    }

    return result;
  }

  if (typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        result.push(...normalize(value));
        continue;
      }

      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, any>;
      const date = row.date ?? row.day ?? key;

      if (!/^\d{4}-\d{2}-\d{2}/.test(String(date))) continue;

      result.push({
        date: String(date).slice(0, 10),
        pnl: Number(row.pnlUsd ?? row.pnl ?? row.realizedPnlUsd ?? 0),
        positions: Number(row.positions ?? row.totalPositions ?? 0),
        winRate: Number(row.winRateUsd ?? row.winRate ?? 0),
      });
    }
  }

  return result;
}

function money(value: number) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return `${value >= 0 ? "+" : "-"}$${(abs / 1000).toFixed(2)}K`;
  return `${value >= 0 ? "+" : "-"}$${abs.toFixed(0)}`;
}

function getCurrentMonthString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function addMonths(yearMonth: string, delta: number): string {
  const [yearStr, monthStr] = yearMonth.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  const newYear = date.getUTCFullYear();
  const newMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${newYear}-${newMonth}`;
}

export function PortfolioCalendar({
  data,
  calendars,
  month,
}: {
  data?: any;
  calendars?: Record<string, any>;
  month?: string;
}) {
  const currentMonth = getCurrentMonthString();
  const defaultMonth =
    month && /^\d{4}-\d{2}$/.test(month) ? month : currentMonth;

  const [selectedMonth, setSelectedMonth] = useState(defaultMonth);

  useEffect(() => {
    setSelectedMonth(defaultMonth);
  }, [defaultMonth]);

  const isCurrentMonth = selectedMonth >= currentMonth;

  function handlePrevMonth() {
    setSelectedMonth((prev) => addMonths(prev, -1));
  }

  function handleNextMonth() {
    if (isCurrentMonth) return;
    setSelectedMonth((prev) => {
      const next = addMonths(prev, 1);
      return next > currentMonth ? prev : next;
    });
  }

  let selectedData: any = undefined;
  if (calendars && typeof calendars === "object") {
    selectedData = calendars[selectedMonth];
  }
  // Legacy compatibility fallback only if calendars collection is not present and on default month
  if (
    selectedData === undefined &&
    (!calendars || Object.keys(calendars).length === 0) &&
    selectedMonth === defaultMonth
  ) {
    selectedData = data;
  }

  const entries = normalize(selectedData);
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));

  const [yearNum, monthNum] = selectedMonth.split("-").map(Number);
  const monthDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
  const year = monthDate.getUTCFullYear();
  const monthIndex = monthDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(monthDate);

  const cells: Array<{ day?: number; entry?: CalendarEntry }> = [];

  for (let index = 0; index < firstDay; index++) cells.push({});

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({ day, entry: byDate.get(date) });
  }

  while (cells.length % 7 !== 0) cells.push({});

  const total = entries.reduce((sum, entry) => sum + entry.pnl, 0);
  const winDays = entries.filter((entry) => entry.pnl > 0).length;
  const loseDays = entries.filter((entry) => entry.pnl < 0).length;
  const activeDays = winDays + loseDays;

  return (
    <div className="portfolio-calendar">
      <div className="calendar-summary">
        <div className="calendar-nav-wrap">
          <button
            type="button"
            className="calendar-nav-btn"
            onClick={handlePrevMonth}
            aria-label="Previous month"
            title="Previous month"
          >
            <ChevronLeft size={13} />
          </button>
          <strong className="calendar-month-title">{monthName}</strong>
          <button
            type="button"
            className="calendar-nav-btn"
            onClick={handleNextMonth}
            disabled={isCurrentMonth}
            aria-label="Next month"
            title={isCurrentMonth ? "Current month" : "Next month"}
          >
            <ChevronRight size={13} />
          </button>
        </div>

        <div className="calendar-stats">
          <span>
            Monthly PnL:{" "}
            <strong
              className={
                entries.length === 0
                  ? ""
                  : total > 0
                  ? "positive"
                  : total < 0
                  ? "negative"
                  : ""
              }
            >
              {entries.length === 0 ? "—" : money(total)}
            </strong>
          </span>

          <span>
            Win Days:{" "}
            <strong className="positive">
              {winDays}
            </strong>
          </span>

          <span>
            Lose Days:{" "}
            <strong className="negative">
              {loseDays}
            </strong>
          </span>

          <span>
            Win Rate:{" "}
            <strong className="positive">
              {activeDays
                ? `${(
                  (winDays / activeDays) *
                  100
                ).toFixed(1)}%`
                : "—"}
            </strong>
          </span>
        </div>
      </div>

      <div className="calendar-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="calendar-grid">
        {cells.map((cell, index) => (
          <div
            key={`${cell.day ?? "blank"}-${index}`}
            className={`calendar-cell ${
              cell.entry
                ? cell.entry.pnl >= 0
                  ? "profit"
                  : "loss"
                : ""
            }`}
          >
            {cell.day ? <span className="calendar-day">{cell.day}</span> : null}
            {cell.entry ? (
              <div className="calendar-cell-data">
                <strong>{money(cell.entry.pnl)}</strong>
                <small>
                  {cell.entry.positions || 0} position
                  {cell.entry.positions === 1 ? "" : "s"}
                </small>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
