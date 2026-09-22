# Antigravity Prompt — Fabriq Update Control from UI

## Project Context

Repository:

```text
https://github.com/CaaronS05/Rahasia.git
```

Project root:

```text
Meteora Scanner/
```

Current important structure:

```text
scripts/
  fabriq/
    enrich-wallets.mjs
  pipeline/
    merge-fabriq.ts
    publish-wallets.ts
  control/

data/
  master/
    wallets-master.json
  raw/
    fabriq/
      fabriq-enriched.json
  checkpoints/
    fabriq.jsonl

frontend/
  src/
    App.tsx
    types.ts
    components/
    pages/
    lib/
  public/
    data/
      wallets-14d.json
```

Current Fabriq enrichment already supports:

```text
FABRIQ_CONCURRENCY
FABRIQ_LIMIT
FABRIQ_REFRESH_BEFORE
```

The scraper is:

```text
scripts/fabriq/enrich-wallets.mjs
```

The project has already successfully refreshed all ~1458 wallets using:

```text
FABRIQ_CONCURRENCY=10
```

with:

```text
Success : 1458
Failed  : 0
```

Therefore worker count `10` is currently considered a valid default maximum.

Do not rewrite the Fabriq scraping logic unless necessary. Reuse the existing pipeline.

---

# Main Goal

Create a local control system so I can control Fabriq wallet updates directly from the React UI instead of running terminal commands manually.

Desired flow:

```text
React UI
   ↓
Local Control API
   ↓
Fabriq Enrichment
   ↓
merge:fabriq
   ↓
publish:wallets
   ↓
Frontend automatically reloads latest wallet data
```

The control system must work locally on my Mac.

---

# Important Rules

1. Before changing anything, inspect the existing repository and understand the current implementation.
2. Preserve all existing functionality.
3. Do not replace working Fabriq logic with a new scraper.
4. Do not expose arbitrary shell command execution through HTTP.
5. The control server must bind only to:

```text
127.0.0.1
```

Never bind to:

```text
0.0.0.0
```

6. The UI must never directly execute shell commands.
7. All backend process execution must be controlled by predefined commands only.
8. Keep the implementation simple and maintainable.
9. Use the existing project style and naming conventions.
10. After every major change, run syntax/build checks.
11. Do not delete old LP Agent fields; the current project still keeps them for compatibility/debugging.
12. Do not change the Fabriq data schema unless required.

---

# CONTROL-1 — Local Fabriq Control Server

Create:

```text
scripts/control/server.mjs
```

Use Node's built-in:

```text
node:http
node:child_process
```

Avoid adding Express unless absolutely necessary.

The server must run on:

```text
http://127.0.0.1:8787
```

Add root package script:

```json
"control": "node scripts/control/server.mjs"
```

The server must support:

```text
GET  /api/fabriq/status
POST /api/fabriq/refresh
POST /api/fabriq/stop
GET  /api/fabriq/events
```

---

## POST /api/fabriq/refresh

Expected request:

```json
{
  "mode": "full",
  "concurrency": 10
}
```

Supported modes:

```text
stale
full
```

### stale

Runs the normal Fabriq enrichment using freshness logic.

Conceptually:

```bash
FABRIQ_CONCURRENCY=10 npm run enrich:fabriq
```

### full

Generate a timestamp:

```js
new Date().toISOString()
```

Pass it as:

```text
FABRIQ_REFRESH_BEFORE
```

Equivalent conceptually to:

```bash
FABRIQ_CONCURRENCY=10 FABRIQ_REFRESH_BEFORE="2026-09-22T..." npm run enrich:fabriq
```

Keep this `refreshBefore` timestamp in server state for the entire run.

If the process is stopped and resumed, reuse the same timestamp.

Do not create a new cutoff when resuming the same run.

---

# Worker Control

The frontend should be able to select worker count.

Allowed UI values:

```text
1
2
5
10
```

Backend validation:

```text
1 <= concurrency <= 10
```

Default:

```text
10
```

Do not trust arbitrary frontend values.

---

# Process State

Maintain server-side state similar to:

```js
{
  status: "idle" | "running" | "stopping" | "stopped" | "completed" | "error",
  stage: "idle" | "enrich" | "merge" | "publish" | "completed" | "error",

  mode: "stale" | "full" | null,
  concurrency: 10,
  refreshBefore: null,

  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,

  total: 0,
  completed: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  runtimeSeconds: 0,

  logs: []
}
```

Also expose:

```js
running: boolean
```

from `/status`.

Keep only the most recent ~200 log lines in memory.

---

# CONTROL-2 — Live Progress

Parse stdout from:

```text
scripts/fabriq/enrich-wallets.mjs
```

The scraper already outputs lines similar to:

```text
[DATASET] 1458 total wallets
[STALE/MISSING] 1458 wallets need Fabriq
[WORKERS] 10
[RESUME] 426/1458 already completed

[W1] [427/1458] ...
[W2] [428/1458] ...

[W1] [OK] positions=...
[W2] [OK] positions=...

[W3] [FAIL] ...

FABRIQ ENRICHMENT COMPLETE

Total   : 1458
Success : 1458
Failed  : 0
Skipped : 426
Runtime : 244.7 sec
```

Parse enough information to update:

```text
total
completed
success
failed
skipped
runtimeSeconds
workers
```

Prefer parsing the existing log format rather than changing the scraper.

---

# Live Events with SSE

Implement:

```text
GET /api/fabriq/events
```

using Server-Sent Events.

Frontend should receive events when:

```text
status changes
stage changes
progress changes
a log line arrives
the run finishes
an error occurs
```

Example payload:

```json
{
  "type": "progress",
  "status": "running",
  "stage": "enrich",
  "completed": 742,
  "total": 1458,
  "success": 742,
  "failed": 0,
  "skipped": 426,
  "concurrency": 10
}
```

`GET /api/fabriq/status` must remain available as fallback.

---

# CONTROL-3 — Stop and Resume

Implement:

```text
POST /api/fabriq/stop
```

Behavior:

1. Set state to `stopping`.
2. Gracefully terminate the current child process.
3. Preserve:

```text
mode
concurrency
refreshBefore
```

4. Preserve the existing checkpoint:

```text
data/checkpoints/fabriq.jsonl
```

Never delete the checkpoint automatically.

After stopping:

```text
status = stopped
```

The UI should allow:

```text
Resume Update
```

Resume requirements:

- use the same `refreshBefore`
- use the same mode
- allow changing concurrency if desired
- reuse the checkpoint
- do not unnecessarily restart already completed wallets

You may implement resume either through the same `/refresh` endpoint with a resume flag or a dedicated endpoint, but keep the API simple.

---

# CONTROL-4 — Automatic Merge + Publish

When Fabriq enrichment exits successfully:

```text
exit code 0
```

automatically run:

```bash
npm run merge:fabriq
```

If successful, run:

```bash
npm run publish:wallets
```

Workflow:

```text
Fabriq enrichment
    ↓ success
merge:fabriq
    ↓ success
publish:wallets
    ↓ success
completed
```

Expose stage changes:

```text
enrich
merge
publish
completed
```

If any stage fails:

```text
status = error
stage = error
```

Expose:

```text
which stage failed
error message
recent logs
```

Do not run merge/publish when enrichment fails.

---

# CONTROL-5 — Frontend UI

The current topbar already contains a refresh icon using `RefreshCw`.

Currently it only reloads the browser.

Replace or extend that behavior so clicking it opens a Fabriq Update modal/popover.

Do not make the control visually oversized.

---

# Desired UI

Idle:

```text
┌───────────────────────────────────────┐
│ Update Wallet Data                    │
│                                       │
│ Source          Fabriq                │
│ Wallets         1,458                 │
│ Last Updated    22 Sep 2026 15:54     │
│                                       │
│ Update Mode                           │
│ ● Refresh Stale                       │
│ ○ Refresh All                         │
│                                       │
│ Workers                               │
│ [ 1 ] [ 2 ] [ 5 ] [ 10 ]             │
│                                       │
│             [ Start Update ]          │
└───────────────────────────────────────┘
```

Running:

```text
┌───────────────────────────────────────┐
│ Updating Fabriq                       │
│                                       │
│ ████████████████░░░░   74%            │
│                                       │
│ 1080 / 1458 wallets                   │
│ Success   1080                        │
│ Failed       0                        │
│ Skipped    426                        │
│ Workers     10                        │
│ Runtime   03:48                       │
│ Stage     Enriching                   │
│                                       │
│             [ Stop Update ]           │
└───────────────────────────────────────┘
```

After enrichment, stage should visibly progress through:

```text
Merging...
Publishing...
Completed
```

After stopped:

```text
[ Resume Update ]
```

After completed:

```text
✓ Update completed
1458 / 1458 wallets

[ Close ]
```

---

# Frontend API Layer

Create a reusable file, for example:

```text
frontend/src/lib/fabriqControl.ts
```

It should contain functions similar to:

```ts
getFabriqStatus()
startFabriqRefresh()
stopFabriqRefresh()
resumeFabriqRefresh()
subscribeFabriqEvents()
```

Do not place all fetch logic directly inside `App.tsx`.

Development base URL:

```text
http://127.0.0.1:8787
```

Define it in one location.

---

# CORS

Allow development origins:

```text
http://localhost:5173
http://127.0.0.1:5173
```

Do not use unrestricted:

```text
Access-Control-Allow-Origin: *
```

for this local command server.

---

# Security Requirements

This server can execute project processes, so be strict.

Never expose:

```text
POST /run-command
```

Never accept arbitrary input like:

```json
{
  "command": "..."
}
```

Only predefined operations are allowed:

```text
Fabriq refresh
Fabriq stop
Fabriq resume
merge
publish
status
events
```

Build all commands and arguments internally.

---

# Process Handling

Use:

```js
spawn()
```

instead of:

```js
exec()
```

for long-running processes.

Pipe stdout/stderr.

Store process handles so they can be stopped.

Prevent multiple simultaneous Fabriq refreshes.

If one is already running:

```text
HTTP 409
```

with a clear message.

---

# UI Data Refresh After Completion

After:

```text
publish:wallets
```

completes successfully, reload the latest:

```text
/public/data/wallets-14d.json
```

without requiring a manual browser refresh.

Reuse the existing wallet dataset loader where possible.

The table/dashboard should update automatically.

---

# Last Updated Information

Use:

```text
meta.publishedAt
```

from the published dataset.

Display this as:

```text
Last Updated
```

Use Asia/Jakarta formatting consistent with the existing frontend.

---

# Progress Calculation

Use:

```text
progressPercent = completed / total * 100
```

Clamp to:

```text
0 - 100
```

If `total` is not yet known, show:

```text
Preparing update...
```

Do not show a fake percentage.

---

# UX Behavior

While a run is active:

```text
Start Update
```

must be disabled.

Show:

```text
Stop Update
```

If stopped:

```text
Resume Update
```

If failed:

```text
Retry
```

Also include a compact collapsible section:

```text
View Logs
```

Do not render hundreds of log lines by default.

The modal must not close whenever progress updates.

---

# Existing Fabriq Behavior to Preserve

Do not break:

```text
FABRIQ_CONCURRENCY
FABRIQ_LIMIT
FABRIQ_REFRESH_BEFORE
checkpoint resume
Fabriq JWT refresh
calendar current + previous month
calendar boundary filtering
Fabriq stats fetching
```

Checkpoint:

```text
data/checkpoints/fabriq.jsonl
```

Never clear it automatically.

---

# Existing Pipeline to Reuse

Reuse existing root scripts:

```text
npm run enrich:fabriq
npm run merge:fabriq
npm run publish:wallets
```

Do not duplicate merge/publish logic inside the server.

---

# Testing Plan

Implement incrementally.

## Test 1 — Control server

Run:

```bash
npm run control
```

Verify:

```bash
curl http://127.0.0.1:8787/api/fabriq/status
```

Expected idle state:

```json
{
  "status": "idle",
  "running": false
}
```

---

## Test 2 — Stale mode

```bash
curl -X POST   http://127.0.0.1:8787/api/fabriq/refresh   -H "Content-Type: application/json"   -d '{
    "mode": "stale",
    "concurrency": 2
  }'
```

Current data may already be fresh, so this may complete quickly.

---

## Test 3 — Full refresh with 2 workers

Use:

```json
{
  "mode": "full",
  "concurrency": 2
}
```

Verify:

```text
FABRIQ_REFRESH_BEFORE is created
W1 and W2 run
progress updates
```

Stop before completion if desired.

---

## Test 4 — Resume

Stop a run.

Resume it.

Verify:

```text
same refreshBefore
checkpoint reused
completed wallets skipped
```

---

## Test 5 — 10 workers

After the control flow is correct, test:

```json
{
  "mode": "full",
  "concurrency": 10
}
```

This has previously succeeded manually with:

```text
Total   : 1458
Success : 1458
Failed  : 0
Runtime : ~244.7 sec
```

---

## Test 6 — Auto merge/publish

After enrichment completes, verify:

```text
merge:fabriq
publish:wallets
```

run automatically.

Then verify the frontend dataset updates.

---

## Test 7 — Frontend build

Run:

```bash
cd frontend
npm run build
```

There must be no TypeScript/Vite errors.

---

# Deliverables

When finished, provide:

1. Files created.
2. Files modified.
3. Brief explanation of each change.
4. Exact commands to run the system.
5. Environment assumptions.
6. Build/test results.
7. Remaining limitations.

Do not only describe the solution. Implement it.

---

# Desired Final Workflow

Normal usage should become:

Terminal 1:

```bash
npm run control
```

Terminal 2:

```bash
cd frontend
npm run dev
```

Then all Fabriq update management happens from the browser:

```text
Refresh icon
    ↓
Choose stale/full
    ↓
Choose workers
    ↓
Start
    ↓
Watch progress
    ↓
optional Stop / Resume
    ↓
Auto merge
    ↓
Auto publish
    ↓
UI reloads latest data
```

That is the target behavior.
