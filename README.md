# Meteora DLMM 7-Day Wallet Scanner — V1

V1 discovers **unique signer wallets** from successful transactions involving the official Meteora DLMM (`lb_clmm`) program during the last N days (default: 7).

It intentionally does **not** classify wallets as LP/trader/bot yet. That comes next by decoding Meteora DLMM events such as `AddLiquidity`, `RemoveLiquidity`, `Rebalancing`, and `ClaimFee2`.

## Why signer wallets?

A Solana transaction contains many non-wallet accounts: pool PDAs, position accounts, bin arrays, vaults, token accounts, and programs. V1 only records transaction signers, with a separate count for how often each signer was the fee payer.

## Requirements

- Node.js 22.6+ (uses built-in TypeScript type stripping; no npm packages required)
- Helius API key

## Setup

```bash
cp .env.example .env
```

Edit `.env`:

```env
HELIUS_API_KEY=YOUR_KEY
SCAN_DAYS=7
SCAN_MODE=auto
```

Then run:

```bash
npm run scan
```

Outputs:

```text
output/wallets_7d.csv
output/wallets_7d.json
```

## Scan modes

### `auto` (recommended)

Tries Helius `getTransactionsForAddress` first. If that RPC is unavailable for the current plan, falls back to standard Solana RPC.

### `gtfa`

Requires Helius `getTransactionsForAddress`. This is the preferred historical backfill path.

### `standard`

Uses:

```text
getSignaturesForAddress
        ↓
getTransaction
        ↓
extract signer wallets
```

This works more broadly but can be much slower and more RPC-heavy for a very active program like Meteora DLMM.

## Cheap smoke test before a full 7-day run

Set a cap temporarily:

```env
MAX_TRANSACTIONS=1000
```

Run:

```bash
npm run scan
```

Then set it back to:

```env
MAX_TRANSACTIONS=0
```

for the full scan.

## Current definition of a wallet

V1 records **all signer public keys** on successful transactions involving the Meteora DLMM program. This is intentionally broader than "LP wallet".

V2 should decode Meteora events and classify:

- `PositionCreate`
- `AddLiquidity`
- `RemoveLiquidity`
- `Rebalancing`
- `ClaimFee2`
- `ClaimReward2`
- `PositionClose`

That lets us separate true LP wallets from swap-only users, aggregators, operators, and bots.

## Important implementation detail

The scanner sets `maxSupportedTransactionVersion: 1` on historical full-transaction reads so it is prepared for Solana transaction v1 support.
