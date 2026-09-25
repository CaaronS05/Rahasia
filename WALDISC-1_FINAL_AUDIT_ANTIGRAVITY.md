# WALDISC-1 FIX / FINAL AUDIT — Antigravity Prompt

## Goal

Finish **WALDISC-1 only**.

Do not start WALDISC-2.
Do not build Global Pool Scan.
Do not build Token CA Scan.
Do not touch wallet master, Fabriq integration, UI, scoring, cohorts, or scheduling.

The current WALDISC-1 implementation already proves the main flow works:

```text
Legacy DLMM Pool
    ↓
Historical transactions
    ↓
Meteora LP instruction decoding
    ↓
Exact pool verification
    ↓
Wallet resolver via IDL signer semantics
    ↓
Dedup
    ↓
PositionV2 / deleted-position verification
```

Current successful test pool:

```text
Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf
JUP-SOL
pairType = 0
binStep = 4
```

Current observed result:

```text
transactionsFetched              1000
meteoraInstructionsDecoded       1480
lpInstructionsAccepted           21
nonLpInstructionsRejected        475
wrongPoolInstructionsRejected    0
unknownDiscriminators            980
walletResolvedEvents             21
unresolvedEvents                 0
uniqueWallets                    3
uniquePositions                  7
verificationMatchCount           2
verificationMismatchCount        0
deletedOrClosedCount             6
```

The core logic is promising, but WALDISC-1 is not final until the audit weaknesses below are fixed.

---

# 1. Strict Scope

You may modify only WALDISC-related code and test/audit output.

Preferred allowed paths:

```text
scripts/discovery/**
package.json                  # only if absolutely needed
data/discovery/waldisc-1/**   # regenerated test output
data/idl/**                   # only if needed for IDL cache metadata
```

Do NOT modify:

```text
scripts/pipeline/**
scripts/fabriq/**
scripts/lpagent/**
scripts/control/**
data/master/**
data/raw/fabriq/**
frontend/**
```

Do not revert unrelated existing frontend work either.

If unrelated files are already dirty before you start, leave them untouched and report them separately.

---

# 2. Blocker A — Audit the 980 UNKNOWN_DISCRIMINATOR results

This is the most important task.

Current result:

```text
1480 total Meteora instructions
 475 known non-LP
  21 accepted LP
 980 unknown discriminator
```

Do NOT simply suppress or ignore the 980 unknowns.

We need to determine what they actually are.

## A1. Build unknown discriminator diagnostics

During scan, aggregate unknown discriminators into a histogram.

For each unique unknown discriminator record:

```json
{
  "discriminatorHex": "...",
  "count": 0,
  "sources": {
    "topLevel": 0,
    "inner": 0
  },
  "sampleSignatures": [],
  "sampleAccountCounts": [],
  "sampleDataLengths": []
}
```

Limit sample signatures to a small number such as 3-5.

Store diagnostic data in:

```text
data/discovery/waldisc-1/<POOL>/unknown-discriminators.json
```

Also add to `summary.json`:

```text
unknownDiscriminatorUniqueCount
unknownDiscriminatorTotalCount
```

## A2. Load BOTH IDL instruction and event discriminator maps

Current `meteora-idl.ts` only needs instruction discriminators for direct LP decoding.

Extend the loader so it can also expose:

```text
instruction discriminator map
event discriminator map
```

from the official Meteora DLMM IDL.

Do NOT treat events as LP instructions automatically.

The event map is only for classification/audit.

## A3. Classify unknown discriminator type

For every unknown discriminator, try to classify it into one of:

```text
IDL_EVENT_DISCRIMINATOR
ANCHOR_EVENT_CPI_OR_INTERNAL
UNKNOWN_REAL_INSTRUCTION
MALFORMED_DATA
```

Do not guess.

Use evidence such as:

```text
IDL events
instruction data length
account count
source top-level vs inner
transaction logs if available
known Anchor event-CPI patterns
official Meteora/Anchor source if needed
```

The purpose is to answer:

> Are the 980 unknowns harmless event/internal CPI traffic, or are we missing real DLMM instructions?

## A4. WALDISC-1 acceptance rule for unknowns

WALDISC-1 may only pass if:

```text
all high-frequency unknown discriminator families are explained
```

and:

```text
no unexplained discriminator appears to represent a genuine LP lifecycle instruction
```

A small residual set of malformed/unclassified records is acceptable only if:

```text
count is explicitly reported
samples are stored
there is no evidence they are LP instructions
```

Do NOT silently convert them into ignored events.

---

# 3. Blocker B — Fix Program Correctness Assertion

The current runner has an invalid test similar to:

```ts
pass: true
```

for program correctness.

Remove that.

## B1. Store programId in each accepted event

Update `LpEventRecord`:

```ts
programId: string
```

Every accepted event must store the actual normalized instruction program ID.

Example:

```json
{
  "programId": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
}
```

## B2. Real assertion

Acceptance assertion F must calculate:

```ts
events.every(
  event =>
    event.programId === config.meteoraDlmmProgramId
)
```

It must fail if even one event differs.

Report:

```text
correctProgramEvents
wrongProgramEvents
```

---

# 4. Blocker C — Fix Closed / Deleted Position Assertion

Current assertion:

```ts
deletedOrClosedCount >= 0
```

is meaningless because it always passes.

Replace it with an actual evidence-based assertion.

## C1. Historical evidence preservation check

For every event marked:

```text
DELETED_OR_CLOSED
```

confirm it still contains:

```text
signature
timestamp
instruction
category
pool
position
wallet
walletAccountName
walletResolutionMethod
```

No deleted/closed historical event may disappear from `lp-events.json`.

## C2. Real assertion K

If deleted/closed positions exist:

```text
all DELETED_OR_CLOSED events retain complete historical evidence
```

must be true.

If no deleted/closed position exists in a future test run, the test can report:

```text
NOT_APPLICABLE
```

rather than pretending this behavior was tested.

The current JUP-SOL proof already has deleted/closed positions, so for this WALDISC-1 final run this assertion should actually be exercised.

---

# 5. Blocker D — Harden PositionV2 Verification

Before parsing account data as Position or PositionV2, verify:

```text
account.owner === METEORA_DLMM_PROGRAM_ID
```

If account owner is different, classify it as:

```text
UNKNOWN_ACCOUNT
```

or preferably:

```text
NON_METEORA_ACCOUNT
```

Do NOT decode arbitrary account bytes using PositionV2 offsets.

## D1. Surviving PositionV2 acceptance

For every surviving PositionV2:

```text
onchainPool === targetPool
onchainOwner === resolved wallet
account.owner === METEORA_DLMM_PROGRAM_ID
```

Any mismatch must make WALDISC-1 fail.

---

# 6. IDL Cache Hardening

Current IDL loader uses:

```text
data/idl/dlmm.json
```

if present.

Improve this without overengineering.

At minimum store metadata:

```json
{
  "sourceUrl": "...",
  "fetchedAt": "...",
  "sha256": "...",
  "instructionCount": 0,
  "eventCount": 0
}
```

Recommended file:

```text
data/idl/dlmm.meta.json
```

Validate:

```text
instructions is a non-empty array
all discriminator arrays used are 8 bytes
event list is structurally valid if present
```

If the official IDL includes a program address field, compare it against:

```text
METEORA_DLMM_PROGRAM_ID
```

If the IDL does not contain an address field, report:

```text
programAddressValidation: unavailable_from_idl
```

Do not invent validation.

Do NOT fetch the IDL on every scan if the local cache is valid.

A simple cache-age policy is acceptable, for example 24 hours.

---

# 7. Scan Cap Semantics

The current proof uses:

```text
sortOrder = asc
maxTransactions = 1000
```

This means the test scans the earliest transactions in the requested window until the cap is hit.

That is acceptable for WALDISC-1, but it must be explicit.

Add summary fields:

```text
transactionLimit: 1000
transactionLimitReached: true/false
historyWindowComplete: true/false
```

Rules:

```text
if maxTransactions == 0:
    transactionLimitReached = false
    historyWindowComplete = pagination exhausted

if maxTransactions > 0 and cap reached before pagination ends:
    transactionLimitReached = true
    historyWindowComplete = false
```

The WALDISC-1 proof does NOT need a complete 7-day history.

But the summary must not imply that 1000 transactions = all activity in 7 days.

---

# 8. Acceptance Assertions — Final Version

The final runner must calculate all assertions from real data.

## A — Legacy Pool

```text
pool exists in data/pools/legacy-dlmm-pools.json
pairType === 0
```

## B — Transactions

```text
transactionsFetched > 0
```

## C — LP Instructions

```text
lpInstructionsAccepted > 0
```

## D — Wallet Resolution

```text
uniqueWallets > 0
walletResolvedEvents > 0
```

## E — Exact Pool

For 100% of accepted events:

```text
event.pool === targetPool
```

## F — Program ID

For 100% of accepted events:

```text
event.programId === METEORA_DLMM_PROGRAM_ID
```

No hardcoded pass.

## G — LP Allowlist

For 100% of accepted events:

```text
category is one of:
initialize
add
remove
claim_fee
claim_reward
close
rebalance
```

## H — No Fee-Payer Fallback

For 100% of accepted events:

```text
walletResolutionMethod === "idl_signer"
```

## I — Wallet Dedup

```text
new Set(wallet.owner).size === wallets.length
```

## J — PositionV2

```text
verificationMismatchCount === 0
```

Additionally all surviving PositionV2 records must have:

```text
program owner match
pool match
wallet owner match
```

## K — Deleted/Closed Evidence Preservation

If deleted/closed events exist:

```text
every DELETED_OR_CLOSED event retains full historical evidence
```

If none exist:

```text
NOT_APPLICABLE
```

## L — No Protected File Mutation

Hash before/after:

```text
data/master/wallets-master.json
frontend/public/data/wallets-14d.json
```

For `data/raw/fabriq/`, do not use directory mtime alone.

Recursively fingerprint filenames + file hashes so the assertion is meaningful.

## M — Unknown Discriminator Audit

PASS only if:

```text
no unexplained high-frequency unknown discriminator is suspected to be an LP lifecycle instruction
```

Include classification totals.

This assertion must be based on actual audit classification output, not `pass: true`.

---

# 9. Improve Summary JSON

Final `summary.json` should include meanings equivalent to:

```json
{
  "scan": {
    "mode": "gtfa",
    "transactionsFetched": 1000,
    "transactionLimit": 1000,
    "transactionLimitReached": true,
    "historyWindowComplete": false,

    "meteoraInstructionsDecoded": 1480,
    "lpInstructionsAccepted": 21,
    "nonLpInstructionsRejected": 475,

    "unknownDiscriminators": {
      "total": 980,
      "unique": 0,
      "idlEvent": 0,
      "anchorInternal": 0,
      "unexplained": 0
    },

    "walletResolvedEvents": 21,
    "unresolvedEvents": 0,
    "uniqueWallets": 3,
    "uniquePositions": 7,

    "verificationMatchCount": 0,
    "verificationMismatchCount": 0,
    "deletedOrClosedCount": 0
  }
}
```

Exact structure may differ, but retain these meanings.

---

# 10. Output Files

Final WALDISC-1 output should be:

```text
data/discovery/waldisc-1/<POOL>/
  summary.json
  wallets.json
  lp-events.json
  unknown-discriminators.json
```

Optionally:

```text
audit-report.json
```

Do not write anywhere else except IDL cache metadata if needed.

---

# 11. Rerun the Same JUP-SOL Test

Use:

```text
Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf
```

Run:

```bash
npm run waldisc:test-one-pool --   --pool Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf   --days 7   --max-transactions 1000   --mode auto
```

Do NOT weaken assertions simply to get PASS.

---

# 12. Required Final Terminal Report

Print:

```text
========================================
WALDISC-1 FINAL AUDIT
========================================

Pool:
Pair:
Bin step:
Pair type:

History:
Requested days:
Transactions fetched:
Transaction limit:
Limit reached:
History window complete:

Decoder:
Meteora instructions:
Accepted LP:
Rejected non-LP:
Wrong pool:
Unknown total:
Unknown unique:
IDL event:
Anchor/internal:
Unexplained:

Wallets:
Resolved events:
Unresolved:
Unique wallets:
Unique positions:

Verification:
PositionV2 matches:
Owner mismatches:
Pool mismatches:
Non-Meteora accounts:
Deleted/closed:

Assertions:
A PASS/FAIL
B PASS/FAIL
C PASS/FAIL
D PASS/FAIL
E PASS/FAIL
F PASS/FAIL
G PASS/FAIL
H PASS/FAIL
I PASS/FAIL
J PASS/FAIL
K PASS/FAIL/NOT_APPLICABLE
L PASS/FAIL
M PASS/FAIL

FINAL:
WALDISC-1 PASS / FAIL
========================================
```

---

# 13. Required Evidence Samples

Print 5 accepted LP events when available:

```text
wallet
walletAccountName
instruction
category
position
pool
programId
signature
timestamp
verification
```

Also print:

```text
5 rejected swap/non-LP examples
top 10 unknown discriminator families
```

For each top unknown family:

```text
discriminator
count
classification
sample signature
source
data length
```

---

# 14. Git Hygiene

Before finishing:

```bash
git status --short
git diff --stat
```

Do not modify unrelated frontend/pipeline files in this fix.

Do not delete unrelated documentation files.

Do not add `.DS_Store`.

If `.DS_Store` is already tracked, do not create additional changes to it.

---

# 15. Definition of Done

WALDISC-1 is FINAL only when all of these are true:

```text
[1] One Legacy pool historical scan works.
[2] LP instructions are decoded through Meteora IDL.
[3] Swap/admin/non-LP instructions are rejected.
[4] Exact lb_pair is verified.
[5] Wallet is resolved from IDL signer semantics.
[6] No fee-payer fallback is used.
[7] Wallets are deduplicated.
[8] Surviving PositionV2 pool + owner match.
[9] Deleted/closed positions remain in historical evidence.
[10] Unknown discriminator families are explained sufficiently.
[11] Acceptance assertions are real, not hardcoded.
[12] Protected master/Fabriq/frontend output is not mutated.
[13] WALDISC-1 final test exits PASS.
```

When these pass:

STOP.

Do not implement WALDISC-2.

---

# 16. Return This Report To Me

Return:

## Files modified

```text
...
```

## Exact command

```bash
...
```

## Final WALDISC-1 terminal summary

```text
...
```

## Unknown discriminator analysis

```text
top discriminator families:
classification:
unexplained count:
conclusion:
```

## Acceptance assertions A-M

```text
A PASS
...
M PASS
```

## Output files

```text
...
```

## Git status

```text
...
```

## Git diff stat

```text
...
```

If WALDISC-1 fails any assertion, stop and report the failure.

Do not continue to WALDISC-2.
