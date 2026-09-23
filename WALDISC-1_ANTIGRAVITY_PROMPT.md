# WALDISC-1 — One-Pool Historical LP Wallet Discovery Proof

## Role

You are implementing **WALDISC-1 only** inside the existing repository:

`CaaronS05/Rahasia`

Do **not** redesign the project from scratch. Read the current repository first and preserve all existing working pipelines.

This step is a proof-of-correctness step for the future Wallet Discovery system.

---

# 1. Project Context

The final Wallet Discovery system will have two pool sources but only **one wallet extraction engine**.

```text
SOURCE A — GLOBAL
data/pools/legacy-dlmm-pools.json
    ↓
selected Legacy DLMM pools
    ↓
shared wallet discovery engine

SOURCE B — TOKEN CA
Token CA
    ↓
discover all matching pools
    ↓
keep Legacy pairType === 0
    ↓
shared wallet discovery engine
```

The shared engine concept is:

```text
Pool address(es)
    ↓
Historical transaction scanner
    ↓
Meteora LP instruction detector
    ↓
Wallet resolver
    ↓
Deduplicate
```

Later, valid discovered wallets will be compared against:

`data/master/wallets-master.json`

Existing wallets will only receive updated discovery/source metadata.

New wallets will later enter the existing Fabriq enrichment pipeline.

**None of that master/Fabriq integration is part of WALDISC-1.**

---

# 2. Current Repository Facts You Must Preserve

The repository already contains:

```text
scripts/pool/
scripts/lpagent/
scripts/fabriq/
scripts/pipeline/
scripts/control/
data/pools/
data/master/
data/raw/
archive/old-meteora-scanner/
```

The existing legacy pool cache is:

```text
data/pools/legacy-dlmm-pools.json
```

It is built by:

```text
scripts/pool/build-legacy-pool-cache.cjs
```

The existing builder classifies pools on-chain and only includes:

```text
pairType === 0
```

The existing wallet master pipeline is already working:

```text
scripts/pipeline/merge-wallets.ts
scripts/fabriq/*
scripts/pipeline/merge-fabriq.ts
scripts/pipeline/publish-wallets.ts
```

Do not rewrite these systems.

The repository also contains useful old research/probes under:

```text
archive/old-meteora-scanner/
```

Important references include:

```text
archive/old-meteora-scanner/src/rpc.ts
archive/old-meteora-scanner/src/scanner.ts
archive/old-meteora-scanner/src/extract.ts

archive/old-meteora-scanner/src/probes/
  decode-5-lp-transactions.ts
  helius-pool-positions-probe.ts
  verify-decoded-owner.ts
  closed-position-gap-test.ts
  helius-dlmm-logs-strict.ts
  helius-dlmm-event-data-probe.ts
```

You MAY reuse concepts and proven decoding logic from these files.

You MUST NOT turn `archive/old-meteora-scanner` back into the production architecture.

New production-ready Wallet Discovery code belongs in a new active folder:

```text
scripts/discovery/
```

---

# 3. WALDISC-1 Objective

Prove that for **one current Legacy Meteora DLMM pool**, we can correctly discover wallets that actually performed LP actions on that exact pool.

The proof must follow this chain:

```text
ONE LEGACY POOL
      ↓
historical transactions referencing that pool
      ↓
decode Meteora DLMM instructions
      ↓
keep LP instructions only
      ↓
verify decoded lb_pair == target pool
      ↓
resolve the actual LP wallet / authority
      ↓
deduplicate wallet addresses
      ↓
store audit evidence
```

The output must be strong enough that another engineer can inspect a discovered wallet and answer:

> “Why is this wallet considered an LP wallet for this pool?”

A plain list of addresses is NOT enough.

---

# 4. Strict Scope

## Implement in WALDISC-1

1. One-pool historical transaction retrieval.
2. Transaction normalization.
3. Meteora DLMM instruction decoding through the official IDL.
4. Conservative LP instruction classification.
5. Exact target-pool verification.
6. LP wallet/authority resolution.
7. Wallet deduplication.
8. Evidence output.
9. Current Position/PositionV2 verification where possible.
10. A CLI smoke/integration test for one pool.
11. Package script to run that test.

## Do NOT implement yet

Do not implement:

- Global scan of all ~2055 pools.
- Token CA pool discovery.
- Global exclusion list.
- Production multi-pool concurrency.
- Production checkpoint/resume.
- `wallets-master.json` updates.
- Fabriq enrichment queue.
- Fabriq calls.
- frontend publishing.
- API/control server integration.
- Wallet Discovery UI.
- Cohorts.
- scoring.
- scheduled scans.
- realtime websocket collector.
- `changedSinceSlot` incremental PositionV2 scanning.

Those belong to later WALDISC steps.

---

# 5. Important Architecture Rule

Do not build a throwaway one-pool script containing all business logic.

WALDISC-1 is a one-pool test, but the scanner logic must already be reusable.

Recommended structure:

```text
scripts/discovery/
  core/
    config.ts
    rpc.ts
    transaction-normalizer.ts
    meteora-idl.ts
    lp-instruction-decoder.ts
    wallet-resolver.ts
    scan-pool-history.ts

  waldisc-1-test-one-pool.ts
```

You may adjust exact filenames if the codebase strongly suggests a cleaner layout, but preserve the separation:

```text
RPC
transaction normalization
IDL decoding
wallet resolution
pool scanner
test runner
```

The future Global and Token CA modes must be able to call the same `scanPoolHistory(...)` core function.

---

# 6. RPC / Historical Transaction Strategy

The primary historical source should be Helius:

```text
getTransactionsForAddress
```

Use the **target pool address** as the address being scanned.

Do NOT scan the entire Meteora program history and then filter every transaction for WALDISC-1.

Concept:

```text
getTransactionsForAddress(targetPool)
      ↓
transactions that reference targetPool
      ↓
decode Meteora instructions
      ↓
exact lb_pair verification
```

Use:

```text
transactionDetails: "full"
status: succeeded only
paginationToken
```

Support a bounded test window such as:

```text
--days 7
```

and optional:

```text
--max-transactions N
```

for safe testing.

Use the existing `.env` convention:

```text
HELIUS_API_KEY
METEORA_DLMM_PROGRAM_ID
SCAN_MODE
GTFA_PAGE_SIZE
STANDARD_SIGNATURE_PAGE_SIZE
GET_TX_CONCURRENCY
REQUEST_RETRIES
MAX_TRANSACTIONS
```

Do not expose secrets in logs.

---

# 7. Fallback RPC

Preserve the repository's earlier proven fallback idea.

If `SCAN_MODE=auto` and Helius `getTransactionsForAddress` is unavailable:

```text
getSignaturesForAddress(targetPool)
      ↓
getTransaction(signature)
```

Use bounded concurrency and retry/backoff.

Do not duplicate decoding logic between gTFA and standard RPC.

Both paths must normalize into the same internal transaction shape.

---

# 8. Transaction Normalization — Critical

Do not assume every historical transaction is already `jsonParsed`.

The normalizer must safely support raw/compiled Solana transactions.

It must resolve:

```text
static account keys
+
meta.loadedAddresses.writable
+
meta.loadedAddresses.readonly
```

for versioned transactions / address lookup tables.

For a compiled instruction:

```text
programIdIndex
accounts[]
data
```

resolve all indices into real base58 pubkeys before decoding.

Handle:

```text
top-level instructions
innerInstructions / CPI instructions
```

Both can contain Meteora DLMM instructions.

Do not silently drop inner instructions.

The normalized internal instruction should contain enough information for later decoding:

```text
signature
slot
blockTime
source            // top-level or inner
parentIndex       // if inner
instructionIndex
programId
accounts[]
data
```

---

# 9. Meteora Program

Default Meteora DLMM program:

```text
LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
```

Use:

```text
process.env.METEORA_DLMM_PROGRAM_ID
```

with the above value as fallback.

Only instructions whose resolved `programId` equals the Meteora DLMM program may enter the LP decoder.

---

# 10. Official Meteora IDL

Use the official deployed DLMM IDL as the instruction schema.

Official source:

```text
https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json
```

The old repo probe:

```text
archive/old-meteora-scanner/src/probes/decode-5-lp-transactions.ts
```

already demonstrates the basic technique:

```text
instruction data
      ↓
base58 decode
      ↓
first 8 bytes = Anchor discriminator
      ↓
lookup official IDL instruction
      ↓
map instruction account indexes to IDL account names
```

Reuse the idea, not necessarily the exact implementation.

Validate that the IDL corresponds to the expected Meteora program.

Fail clearly if the IDL cannot be loaded or is structurally invalid.

---

# 11. LP Instruction Classification

WALDISC-1 must be deliberately conservative.

We want **real LP wallets**, not every wallet that touched the pool.

Include direct LP lifecycle instructions such as families matching:

```text
initialize_position*
add_liquidity*
remove_liquidity*
claim_fee*
claim_reward*
close_position*
rebalance_liquidity*
```

Other clearly direct position-management instructions may be included only if their semantics are unambiguous from the official IDL.

Explicitly reject unrelated instruction families such as:

```text
swap*
initialize_lb_pair*
update_*
set_*
fund_reward*
withdraw_protocol_fee*
limit_order*
admin/operator/configuration instructions
```

### Important operator rule

For WALDISC-1, be conservative with instruction names containing concepts such as:

```text
operator
admin
protocol
reward_funder
```

Do not automatically treat an operator signer as the LP owner.

If owner semantics are ambiguous, classify the event as unresolved/rejected rather than creating a false wallet.

False negatives are acceptable in WALDISC-1.

False positives are not.

---

# 12. Exact Pool Verification

Every accepted LP event MUST contain a decoded pool account from the IDL, normally:

```text
lb_pair
```

or another explicitly equivalent field.

Before accepting the event:

```text
decodedPool === targetPool
```

must be true.

A transaction merely referencing the pool address is not enough.

A Meteora instruction somewhere in the transaction is not enough.

The decoded LP instruction itself must reference the target pool.

---

# 13. Wallet Resolver — Most Important Correctness Rule

Do NOT blindly use:

```text
transaction fee payer
```

as the LP wallet.

Do NOT blindly use:

```text
first signer
```

as the LP wallet.

Resolve the wallet from the decoded Meteora instruction account schema.

Preferred approach:

1. Read the IDL account definitions for the matched instruction.
2. Determine which mapped account(s) are declared `signer: true`.
3. Prefer known direct LP authority names such as:

```text
owner
sender
user
authority
position_authority
```

4. Exclude known non-user/system/program authorities.
5. If the instruction semantics contain multiple ambiguous signers, do not guess.

Each accepted event must store:

```text
wallet
walletAccountName
walletResolutionMethod
```

For example:

```json
{
  "wallet": "...",
  "walletAccountName": "sender",
  "walletResolutionMethod": "idl_signer"
}
```

Do not accept a wallet when the resolver is not confident.

Track unresolved events separately.

---

# 14. Position Address

When the instruction contains:

```text
position
position_v2
```

capture it.

The position is evidence linking:

```text
wallet
↔
position
↔
pool
↔
transaction
```

A discovered wallet may have multiple positions in the same pool.

Deduplicate positions per wallet.

---

# 15. Current On-Chain Validation

Use the old proven probes as reference:

```text
helius-pool-positions-probe.ts
verify-decoded-owner.ts
```

For positions that still exist on-chain, verify the historical resolution against current position state where possible.

The earlier research established the useful PositionV2 prefix:

```text
8 bytes   Anchor discriminator
32 bytes  lb_pair
32 bytes  owner
```

For a surviving PositionV2:

```text
decoded pool   == target pool
decoded wallet == on-chain PositionV2 owner
```

should match.

Store validation state such as:

```text
MATCH
OWNER_MISMATCH
POOL_MISMATCH
DELETED_OR_CLOSED
LEGACY_POSITION
UNKNOWN_ACCOUNT
NOT_CHECKED
```

### Critical rule

A deleted/closed position must NOT invalidate a historically proven LP event.

The project already discovered that closed position accounts can disappear.

Historical instruction evidence is intentionally being built to solve that blind spot.

---

# 16. Event Schema

Create a clear internal/output event schema similar to:

```json
{
  "signature": "...",
  "slot": 0,
  "blockTime": 0,
  "timestamp": "...",

  "source": "top-level",
  "parentInstructionIndex": null,
  "instructionIndex": 0,

  "instruction": "add_liquidity_by_strategy",
  "category": "add",

  "pool": "...",
  "position": "...",

  "wallet": "...",
  "walletAccountName": "sender",
  "walletResolutionMethod": "idl_signer",

  "verification": {
    "status": "MATCH",
    "onchainPool": "...",
    "onchainOwner": "..."
  }
}
```

The exact schema may evolve, but retain the audit information.

---

# 17. Wallet Aggregation Schema

Deduplicate by wallet address.

Each wallet record should contain at least:

```json
{
  "owner": "...",
  "firstSeenAt": "...",
  "lastSeenAt": "...",
  "lpInstructionCount": 0,
  "categories": [],
  "positions": [],
  "signatures": [],
  "evidenceCount": 0
}
```

Do not copy Fabriq metrics here.

This is discovery evidence only.

---

# 18. WALDISC-1 Output

Do NOT write into `data/master/`.

Use an isolated WALDISC-1 directory.

Recommended:

```text
data/discovery/
  waldisc-1/
    <POOL_ADDRESS>/
      summary.json
      wallets.json
      lp-events.json
```

`summary.json` should include:

```text
step
generatedAt
pool
pool metadata
scan mode
start/end time
pages fetched
transactions fetched
Meteora instructions decoded
LP instructions accepted
non-LP instructions rejected
wrong-pool instructions rejected
wallet-resolved events
unresolved events
unique wallets
unique positions
verification MATCH count
verification MISMATCH count
deleted/closed count
```

Do not store all raw transactions unless needed for a debugging failure.

Keep output auditable but reasonably sized.

---

# 19. Test Pool Selection

The CLI must accept:

```bash
--pool <POOL_ADDRESS>
```

The test pool MUST exist in:

```text
data/pools/legacy-dlmm-pools.json
```

and must have:

```text
pairType === 0
```

Fail fast otherwise.

For the actual WALDISC-1 test, choose a pool with **moderate recent activity** so we get LP events without scanning a massive major pool.

Avoid using very high-volume majors for this proof if possible, such as:

```text
SOL-USDC
USDC-USDT
```

Also avoid obviously dead pools.

You may first check whether the historically used probe pool:

```text
5fjmuEN72LQeo9NjvhLyQTV3ezyNgQqUXzSXskD2SCcy
```

still exists in the current Legacy cache and has suitable activity.

If it does not, choose another suitable Legacy pool from the current cache.

Record the selected pool and its metadata in the final report.

---

# 20. CLI

Add a package script similar to:

```json
"waldisc:test-one-pool": "node --experimental-strip-types --env-file=.env scripts/discovery/waldisc-1-test-one-pool.ts"
```

Expected usage:

```bash
npm run waldisc:test-one-pool -- \
  --pool <POOL_ADDRESS> \
  --days 7
```

Optional:

```bash
--max-transactions 500
--mode auto
```

Do not introduce a new CLI framework unless necessary.

Simple argument parsing is enough.

---

# 21. Runtime Logging

Use useful high-level logs, for example:

```text
========================================
WALDISC-1 — ONE POOL DISCOVERY
========================================
Pool          : ...
Pair          : ...
Bin step      : ...
Window        : ...
Mode          : gtfa
----------------------------------------
Page 1        : 100 tx
Page 2        : 100 tx
...
----------------------------------------
Transactions  : ...
Meteora IX    : ...
LP IX         : ...
Resolved      : ...
Unresolved    : ...
Wallets       : ...
Positions     : ...
Verified      : ...
Deleted       : ...
Mismatch      : ...
Output        : ...
========================================
```

Never log the Helius API key.

---

# 22. Assertions / Acceptance Tests

The WALDISC-1 run is NOT considered successful merely because the process exits with code 0.

Implement explicit assertions.

## A. Pool validation

Must prove:

```text
target pool exists in current legacy cache
pairType === 0
```

## B. Transaction discovery

Must fetch:

```text
transactions > 0
```

for the chosen test window.

If not, choose a better test pool/window.

## C. LP decoding

Must produce:

```text
accepted LP instructions > 0
```

## D. Wallet resolution

Must produce:

```text
unique resolved LP wallets > 0
```

## E. Exact pool correctness

For **100% of accepted LP events**:

```text
event.pool === targetPool
```

## F. Program correctness

For **100% of accepted events**:

```text
event program == METEORA_DLMM_PROGRAM_ID
```

## G. Instruction correctness

For **100% of accepted events**:

```text
instruction belongs to conservative LP allowlist
```

Swap/admin/limit-order transactions must not create discovered wallets.

## H. Wallet correctness

For **100% of accepted wallet events**:

```text
walletResolutionMethod != fee_payer_fallback
```

Do not use an unsafe fee-payer fallback.

## I. Deduplication

The final wallet list must contain unique owner addresses.

## J. PositionV2 validation

For every accepted position that is still a readable PositionV2:

```text
onchainPool === targetPool
```

and:

```text
onchainOwner === resolved wallet
```

Any mismatch is a WALDISC-1 failure that must be investigated.

Do not hide mismatches.

## K. Closed/deleted behavior

If a historically decoded position no longer exists:

```text
DELETED_OR_CLOSED
```

is valid and should remain in historical evidence.

Do not discard the wallet solely because the position account is gone.

---

# 23. Required Audit Samples

At the end, print at least 5 accepted evidence rows if available:

```text
wallet
instruction
position
pool
signature
timestamp
verification status
```

Also print several rejected/non-LP examples showing that swaps or unrelated Meteora instructions were correctly excluded.

This makes false-positive filtering auditable.

---

# 24. No Master Mutation

Before and after WALDISC-1, confirm that these files are NOT modified by the test:

```text
data/master/wallets-master.json
frontend/public/data/wallets-14d.json
data/raw/fabriq/*
```

The WALDISC-1 scanner only writes under:

```text
data/discovery/waldisc-1/
```

---

# 25. Do Not Break Existing Commands

After implementation, ensure existing commands still parse/run as before.

At minimum do not break:

```text
npm run scrape:lpagent
npm run merge:wallets
npm run enrich:fabriq
npm run merge:fabriq
npm run publish:wallets
npm run pipeline
```

You do not need to execute expensive network pipelines just to prove this.

But TypeScript/module changes must not alter those files unnecessarily.

---

# 26. Implementation Guidance From Archive

Use these files as references only.

### Historical RPC / retry concepts

```text
archive/old-meteora-scanner/src/rpc.ts
archive/old-meteora-scanner/src/scanner.ts
```

### Transaction normalization concept

```text
archive/old-meteora-scanner/src/extract.ts
```

Improve it for full instruction decoding and loaded address resolution.

### IDL instruction decoder concept

```text
archive/old-meteora-scanner/src/probes/decode-5-lp-transactions.ts
```

### Current pool PositionV2 validation

```text
archive/old-meteora-scanner/src/probes/helius-pool-positions-probe.ts
```

### Historical actor vs PositionV2 owner verification

```text
archive/old-meteora-scanner/src/probes/verify-decoded-owner.ts
```

### Closed account blind spot

```text
archive/old-meteora-scanner/src/probes/closed-position-gap-test.ts
```

Do not blindly copy them.

Consolidate the proven ideas into the new reusable `scripts/discovery/core/` layer.

---

# 27. Error Handling

Handle cleanly:

```text
missing HELIUS_API_KEY
invalid pool pubkey
pool not present in legacy cache
pool pairType != 0
Helius HTTP 429
Helius 5xx
RPC JSON error
IDL fetch failure
malformed transaction
unsupported transaction version
missing loaded addresses
unknown instruction discriminator
ambiguous signer
no LP events in chosen window
filesystem write failure
```

Unknown instruction discriminators should be counted/logged, not necessarily crash the entire scan.

Use retry with exponential backoff for transient RPC failures.

---

# 28. Atomic Output

When writing final JSON files:

```text
write <file>.tmp
rename to final path
```

Do not leave partially-written final JSON after interruption.

The current project already uses this pattern.

---

# 29. Final Test Procedure

Run a real test.

Example flow:

```bash
# 1. inspect current cache and pick suitable Legacy pool

# 2. run WALDISC-1
npm run waldisc:test-one-pool -- \
  --pool <SELECTED_POOL> \
  --days 7

# 3. inspect generated summary
cat data/discovery/waldisc-1/<SELECTED_POOL>/summary.json

# 4. inspect wallets
cat data/discovery/waldisc-1/<SELECTED_POOL>/wallets.json

# 5. inspect evidence
cat data/discovery/waldisc-1/<SELECTED_POOL>/lp-events.json
```

If 7 days has too little LP activity, increase the window.

Do not weaken validation simply to make the test pass.

---

# 30. Definition of Done

WALDISC-1 is DONE only if we can demonstrate:

```text
ONE Legacy DLMM pool
        ↓
historical transactions found
        ↓
Meteora LP instructions decoded correctly
        ↓
exact pool verified
        ↓
LP wallet resolved from instruction semantics
        ↓
wallets deduplicated
        ↓
surviving PositionV2 owners match where verifiable
        ↓
closed/deleted positions do not disappear from historical evidence
        ↓
auditable JSON output produced
```

The most important metric is NOT the number of wallets.

The most important metric is:

> **Can we prove that each included wallet is actually associated with a genuine LP action on the exact target pool?**

---

# 31. Stop Condition

After WALDISC-1 passes:

**STOP.**

Do not proceed to:

```text
WALDISC-2
Global scan
Token CA scan
Master merge
Fabriq integration
UI
```

We will audit WALDISC-1 first.

---

# 32. What You Must Return To Me After Implementation

Return a concise implementation report containing:

## Files created

```text
...
```

## Files modified

```text
...
```

## Selected test pool

```text
address:
pair:
binStep:
pairType:
tvl:
24h volume:
```

## Exact command executed

```bash
...
```

## Test summary

```text
transactions fetched:
Meteora instructions:
LP instructions accepted:
non-LP rejected:
wrong-pool rejected:
resolved wallet events:
unresolved wallet events:
unique wallets:
unique positions:
PositionV2 verified matches:
owner mismatches:
pool mismatches:
deleted/closed positions:
unknown discriminators:
```

## Five accepted evidence samples

Include:

```text
wallet
instruction
position
signature
timestamp
verification
```

## Rejected examples

Show several swap/admin/non-LP instructions that were rejected.

## Output files

```text
...
```

## Git diff summary

Run:

```bash
git status --short
git diff --stat
```

Return the output.

If there is any mismatch or unresolved correctness issue, report it clearly.

Do not hide it and do not continue to the next step.
