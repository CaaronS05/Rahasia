# AGENTS.md — Meteora DLMM LP Intelligence

## Project Overview
Meteora DLMM LP Intelligence on Solana: wallet discovery, pool analytics, and position lifecycle intelligence for liquidity providers.

## Architecture
- **Backend**: Node.js/TypeScript CLI pipelines and analysis engines
- **Frontend**: React 19 / Vite application (`frontend/`)
- **Control Server**: Local control API on `127.0.0.1:8787` (`scripts/control/server.mjs`)
- **Brave CDP**: Browser session bridge on `127.0.0.1:9222` for Fabriq data extraction
- **Core Modules**:
  - Pool Scanner & Pool Intelligence
  - Wallet Explorer & Portfolio
  - Wallet Intelligence V1
  - Position Analytics data foundation

## Data Sources
- **LP Agent**: Pool-local LP wallet discovery (`data/raw/lpagent/`, `data/master/wallets-master.json`)
- **Fabriq**: Wallet statistics and position history via CDP bridge (`data/master/wallets-fabriq.json`)
- **Meteora Data API**: Pool discovery, pair metadata, and bin configurations

## Data Integrity & Isolation
- **Separation of Scopes**: Wallet-global and pool-local metrics must remain strictly separated.
- **Canonical Master Isolation**: Canonical datasets (`data/master/*`) are isolated from pool-specific scans.
- **Runtime Snapshot Separation**: Runtime analytics snapshots (`data/analytics/*`) remain separate from canonical master data; failures must never overwrite valid snapshots.

## Key Files & Directories
- `scripts/control/server.mjs`: Local control server
- `scripts/discovery/core/fabriq-position-history.ts`: Fabriq CDP bridge and API client
- `scripts/v1/single-wallet-intelligence.ts`: Wallet intelligence pipeline
- `scripts/analytics/`: Position lifecycle extraction, sampling, and dataset building
- `frontend/src/`: React UI components, hooks, and views
- `tests/analytics/`: Position analytics unit and regression tests

## Workflow
- Requirements are defined by the user and ChatGPT; OMP implements the approved task directly.
- Scope discipline: implement assigned requirements without inventing unrequested features or abstractions.
- Report status, blockers, and results with factual precision.

## Verified Commands
- `npm test`: Run position analytics tests via Node test runner
- `npm --prefix frontend run build`: Build production frontend bundle with Vite
- `npm run control`: Start local control server on `127.0.0.1:8787`
- `node --experimental-strip-types <path.ts>`: Execute TypeScript scripts directly without compile step
