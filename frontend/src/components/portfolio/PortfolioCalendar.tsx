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

export function PortfolioCalendar({
  data,
  month,
}: {
  data: any;
  month?: string;
}) {
  const entries = normalize(data);
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));

  const monthDate = month && /^\d{4}-\d{2}$/.test(month)
    ? new Date(`${month}-01T00:00:00`)
    : new Date();

  const year = monthDate.getFullYear();
  const monthIndex = monthDate.getMonth();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const firstDay = new Date(year, monthIndex, 1).getDay();
  const monthName = new Intl.DateTimeFormat("en-US", {
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
  const loseDays = entries.filter(
    (entry) => entry.pnl < 0,
  ).length;

  const activeDays =
    winDays + loseDays;

  return (
    <div className="portfolio-calendar">
      <div className="calendar-summary">
        <strong>{monthName}</strong>
        <div className="calendar-stats">
          <span>
            Monthly PnL:{" "}
            <strong
              className={
                total >= 0
                  ? "positive"
                  : "negative"
              }
            >
              {money(total)}
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
            className={`calendar-cell ${cell.entry
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
