# Implementation Map

## Step 1 — Create the frontend folder
Place this full folder at:

`<project-root>/frontend/`

**Affected element:** creates a standalone UI without touching the working scanner.

## Step 2 — Install dependencies
Run:

```bash
cd frontend
npm install
npm run dev
```

**Affected element:** starts the Wallet Explorer locally on port 5173.

## Step 3 — Data source
Current real scan is already included at:

`frontend/public/data/wallets-14d.json`

**Affected element:** feeds all 796 wallets into the table, filters, KPI cards, chart, and calendar.

## Step 4 — Main files to tune manually
Use these for visual tuning:

- `frontend/src/styles.css`
  - colors
  - widths
  - spacing
  - font sizes
  - table density
  - right-panel width

- `frontend/src/components/PnlHistory.tsx`
  - Chart vs Calendar controls
  - 7D / 14D / 30D / All controls

- `frontend/src/components/WalletTable.tsx`
  - visible columns
  - page size
  - sorting

**Affected element:** these three files control almost all visual/interaction tuning visible in the latest mockup.

## Step 5 — Do not implement fake LP positions yet
`LP Positions` and `Trades` tabs intentionally show placeholders.

**Affected element:** avoids mixing aggregated Smart LP data with position-level data we have not connected yet.
