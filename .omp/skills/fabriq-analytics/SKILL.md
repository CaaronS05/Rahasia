---
name: fabriq-analytics
description: Use when implementing or debugging Fabriq data extraction, Meteora DLMM closed positions, lifecycle transactions, initial entry reconstruction, or wallet analytics.
---

# Fabriq Analytics Skill

## Fabriq Client & Authentication
- **Reuse Client**: Use existing client functions in `scripts/analytics/fabriq-analytics-client.ts` and `scripts/discovery/core/fabriq-position-history.ts`.
- **JWT Refresh**: Preserve single-flight token refresh on 401 via Brave CDP (`getToken(true)`).
- **Error Boundaries**: Preserve hard failure on 403 (invalid/blocked session) and exponential backoff on 429 (`retry-after`).
- **Bounded 404 Retries**: Apply bounded retry logic for Position Analytics 404s (`max404Retries`, default 3; `delay404Ms`, default 5000ms); never introduce uncontrolled retry loops.

## Position Lifecycle Events
Normalize raw event types into standardized lifecycle categories:
- `POSITION_OPEN` / `initialize`: Initial position creation.
- `ADD_LIQUIDITY` / `add`: Liquidity deposits.
- `REMOVE_LIQUIDITY` / `remove`: Liquidity withdrawals.
- `FEE_CLAIM` / `claim_fee`: Claimed trading fees.
- `POSITION_CLOSE` / `close`: Final position closure.

## Financial Semantics & Reconstruction
- **Initial Entry vs Total Deposits**: `initialEntryUsd` represents capital at open; `totalDepositsUsd` is `initialEntryUsd + additionalLiquidityUsd`. They are not equivalent.
- **Additional Liquidity**: Excludes opening liquidity (associated add within same transaction / timestamp).
- **First Observed Add**: `FIRST_OBSERVED_ADD_ONLY` when opening event is missing; never mark as verified initial entry.
- **Missing Values**: Missing or unknown monetary metrics must remain `null`; never convert to zero.
- **Win / Loss Classification**: PnL > +0.0001 is `WIN`, < -0.0001 is `LOSS`, between is `BREAKEVEN`. If `pnlUsd === null`, classification must be `UNKNOWN`, never `BREAKEVEN`.
- **Units & Scopes**: Preserve USD units and explicit metric scoping (`pool` vs `wallet`).

## Dataset & Analytics Rules
- **Time Windows**: Support `30D`, `90D`, and `ALL_AVAILABLE` periods based on position `closedAt`.
- **Global Sampling**: Select the newest 1000 closed positions globally (`LATEST_CLOSED_1000`), sorted by `latest_close_ts` DESC.
- **Deduplication**: Deduplicate by `${poolAddress}:${positionId}`, retaining the record with richer non-null metrics.
- **Data Quality**: Explicitly report `initialEntryStatus`, `transactionCoverage`, `positionCompleteness`, and `samplingMeta`.
- **Metric Isolation**: Never blend wallet-wide calendar metrics with sampled-position performance metrics.
- **Preserve Scoring**: Retain established V1 scoring methodology in `scripts/v1/single-wallet-intelligence.ts`.

## Key Implementation References
- `scripts/analytics/position-analytics-types.ts`: Normalized contracts and status types.
- `scripts/analytics/position-lifecycle-extractor.ts`: Event normalization and financial reconstruction.
- `scripts/analytics/fabriq-analytics-client.ts`: Paginated pool, position, and event fetching.
- `scripts/analytics/build-position-dataset.ts`: End-to-end dataset builder and checkpoint storage.
