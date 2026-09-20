# SOLTRACE Wallet Explorer UI

Dark-mode Wallet Explorer built from the **real 14-day LP Agent scan (796 wallets)**.

## What is already implemented

- Left navigation sidebar for future modules.
- Real 796-wallet dataset loaded from `public/data/wallets-14d.json`.
- Search + numeric filters.
- Sort ASC/DESC by clicking table headers.
- Pagination (25 / 50 / 100 rows).
- Column show/hide menu.
- CSV export for the current filtered result.
- Click a wallet to open the right-side detail panel.
- Real wallet metrics from LP Agent.
- **Cumulative PnL Chart ↔ Calendar toggle exactly in the right-side PnL section.**
- 7D / 14D / 30D / All time-range controls.
- Daily PnL chart, win-rate ring, and daily LP activity table.
- Tabs reserved for `LP Positions`, `Trades`, `Pools`, and `Activity`.

> The Smart LP snapshot has wallet-level and daily PnL aggregates, but not the complete individual position/trade history. Those tabs are intentionally placeholders instead of fake data.

---

## Folder placement

If you want this as a separate frontend:

```text
your-project/
├─ scanner/                     # your existing scanner/indexer code
└─ frontend/
   ├─ package.json
   ├─ index.html
   ├─ vite.config.ts
   ├─ tsconfig.json
   ├─ tsconfig.app.json
   ├─ tsconfig.node.json
   ├─ public/
   │  └─ data/
   │     └─ wallets-14d.json
   └─ src/
      ├─ main.tsx
      ├─ App.tsx
      ├─ styles.css
      ├─ types.ts
      ├─ lib/
      │  ├─ format.ts
      │  └─ walletData.ts
      └─ components/
         ├─ Sidebar.tsx
         ├─ MetricCard.tsx
         ├─ Filters.tsx
         ├─ Sparkline.tsx
         ├─ WalletTable.tsx
         ├─ WalletDetailPanel.tsx
         ├─ PnlHistory.tsx
         ├─ PnlChart.tsx
         ├─ PnlCalendar.tsx
         └─ DailyActivity.tsx
```

### Recommended integration

Put the extracted folder at:

```text
<YOUR_PROJECT_ROOT>/frontend
```

So your project becomes:

```text
<YOUR_PROJECT_ROOT>/
├─ src/                         # scanner / Node / TypeScript backend
├─ output/                      # scanner output, if you use one
└─ frontend/                    # this UI
```

No scanner file needs to be deleted or replaced yet.

---

## Run

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

---

## Which files affect what?

| File | What it controls |
|---|---|
| `src/App.tsx` | Main Wallet Explorer layout, dataset filtering, sorting, KPI calculations |
| `src/styles.css` | Entire dark visual design, spacing, dimensions, colors |
| `src/components/Sidebar.tsx` | Left navigation |
| `src/components/Filters.tsx` | Filter bar above the wallet table |
| `src/components/WalletTable.tsx` | Wallet table, sorting, pagination, column picker, CSV export |
| `src/components/WalletDetailPanel.tsx` | Right-side wallet detail panel and tabs |
| `src/components/PnlHistory.tsx` | Chart/Calendar toggle and 7D/14D/30D/All controls |
| `src/components/PnlChart.tsx` | Cumulative PnL line/area chart |
| `src/components/PnlCalendar.tsx` | Calendar PnL view |
| `src/components/DailyActivity.tsx` | Daily PnL chart and win-rate panel |
| `public/data/wallets-14d.json` | Current 796-wallet real dataset |

---

## Updating the dataset later

The UI expects:

```json
{
  "meta": {},
  "wallets": []
}
```

So after a new scan you only need to replace:

```text
frontend/public/data/wallets-14d.json
```

with the latest wallet array.

For production, the next improvement should be to have the scanner write this compact JSON automatically instead of manually copying the scan result.

---

## Important data semantics

The main table uses:

- `total_pnl_native_7d` → PnL 7D in SOL
- `win_rate_native` → native win rate
- `total_lp_7d` → positions/LP activity in the 7-day field
- `total_pool` → total pools
- `avg_age_hour` → average position age
- `avg_inflow_native` → average invested/inflow in SOL
- `total_fee_native` → native fee field
- `pnl_chart[].sum_native` → daily PnL shown in Calendar
- `pnl_chart[].cumulative_pnl_native` → cumulative PnL chart

The UI does **not** invent per-position or per-trade records.

---

## Next implementation

Once this UI feels right:

1. Connect the scanner output automatically.
2. Build the real `LP Positions` tab from Meteora position data.
3. Keep `Trades` separate from LP positions.
4. Add screening presets / saved filters.
5. Add watchlist and live refresh.
