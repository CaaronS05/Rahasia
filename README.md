# Meteora Wallet Scanner

Wallet discovery and analytics pipeline for Meteora DLMM LP wallets.

The current system combines:

- LP Agent Smart LP data
- Fabriq wallet analytics
- Local master wallet dataset
- React Wallet Explorer frontend

---

## Current Architecture

```text
LP Agent
   ↓
data/raw/lpagent/
   ↓
merge-wallets.ts
   ↓
data/master/wallets-master.json
   ↓
Fabriq enrichment
   ↓
merge-fabriq.ts
   ↓
data/master/wallets-master.json
   ↓
publish-wallets.ts
   ↓
frontend/public/data/wallets-14d.json
   ↓
Wallet Explorer UI