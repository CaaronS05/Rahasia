# Antigravity Prompt — Fix `Illegal return statement` in `server.mjs`

## TASK

Fix the broken `startPipeline()` function structure in:

```text
scripts/control/server.mjs
```

The current control server fails to start because of:

```text
SyntaxError: Illegal return statement
```

The error happens because the declaration for:

```js
async function startPipeline({
    mode,
    concurrency,
    resume,
}) {
```

was accidentally removed.

As a result, code that should be inside `startPipeline()` is currently executed at top-level, causing later `return;` statements to become illegal.

---

## IMPORTANT RULES

- Only edit `scripts/control/server.mjs`
- Do not refactor unrelated code
- Do not change LP Agent logic
- Do not change Fabriq business logic
- Do not change checkpoint behavior
- Do not change worker behavior
- Do not change graceful stop behavior
- Do not change force stop behavior
- Do not change API endpoints
- Do not modify frontend files
- Do not run any testing
- Do not run `npm`
- Do not run `node`
- Do not run `node --check`
- Do not run `curl`
- Do not run build commands
- Do not run browser commands
- Do not run git commands
- Only edit/write the required code
- User will test everything manually

---

# FIX REQUIRED

## FILE

```text
scripts/control/server.mjs
```

## CURRENT BROKEN AREA

Immediately after the closing brace of:

```js
function runChildProcess(...)
```

the file currently begins with something equivalent to:

```js
state.startedAt = isResume && state.startedAt ? state.startedAt : new Date().toISOString();

if (currentChild || state.status === "running" || state.status === "stopping") {
    throw new Error("Fabriq update is already running");
}
```

This is wrong because the `startPipeline()` function declaration is missing.

---

# CHANGE

Replace that broken beginning with:

```js
async function startPipeline({
    mode,
    concurrency,
    resume,
}) {
    if (
        currentChild ||
        state.status === "running" ||
        state.status === "stopping"
    ) {
        throw new Error(
            "Fabriq update is already running"
        );
    }
```

---

# REMOVE THIS OLD TOP-LEVEL LINE

Delete this accidental top-level line:

```js
state.startedAt = isResume && state.startedAt ? state.startedAt : new Date().toISOString();
```

Do not keep it anywhere outside `startPipeline()`.

---

# KEEP THIS VALID ASSIGNMENT

Later inside `startPipeline()`, keep this existing assignment:

```js
state.startedAt =
    new Date().toISOString();
```

This assignment is intentional and must remain.

It is used so that when Fabriq resumes, the runtime counter starts from the current resumed session instead of counting the time while the pipeline was stopped.

Do not change `refreshBefore`.

---

# EXPECTED STRUCTURE

The relevant section should structurally become:

```js
function runChildProcess(
    command,
    args,
    env,
    lineParser = null
) {
    // existing buffered stdout/stderr implementation
    ...
}

async function startPipeline({
    mode,
    concurrency,
    resume,
}) {
    if (
        currentChild ||
        state.status === "running" ||
        state.status === "stopping"
    ) {
        throw new Error(
            "Fabriq update is already running"
        );
    }

    const isResume =
        Boolean(resume);

    const safeConcurrency =
        sanitizeConcurrency(
            concurrency ??
            state.concurrency
        );

    let safeMode = mode;

    if (!safeMode) {
        safeMode =
            isResume &&
            state.mode
                ? state.mode
                : "stale";
    }

    let refreshBefore =
        state.refreshBefore;

    if (isResume) {
        if (
            safeMode === "full" &&
            !refreshBefore
        ) {
            refreshBefore =
                new Date().toISOString();
        }
    } else {
        if (safeMode === "full") {
            refreshBefore =
                new Date().toISOString();
        } else {
            refreshBefore =
                null;
        }
    }

    state.status =
        "running";

    state.stage =
        "enrich";

    state.mode =
        safeMode;

    state.concurrency =
        safeConcurrency;

    state.refreshBefore =
        refreshBefore;

    state.startedAt =
        new Date().toISOString();

    state.finishedAt =
        null;

    state.exitCode =
        null;

    state.error =
        null;

    state.stopMode =
        null;

    state.checkpointPreserved =
        true;

    // existing pipeline logic continues here
    ...

    try {
        // enrich
        // merge
        // publish

        ...
        return;

    } catch (error) {
        ...
    }
}
```

---

# BRACE / STRUCTURE REQUIREMENTS

Make sure:

- `runChildProcess()` has its own correct closing brace
- `startPipeline()` begins immediately after `runChildProcess()`
- all Fabriq pipeline `return;` statements remain inside `startPipeline()`
- `startPipeline()` has exactly one correct closing brace after its `catch` block
- there is no duplicate `startPipeline()` declaration
- there is no dangling top-level code that references:
  - `isResume`
  - `mode`
  - `concurrency`
  - `safeConcurrency`
  - `safeMode`
  - `refreshBefore`
- there are no top-level `return;` statements

---

# DO NOT CHANGE EXISTING WORKING LOGIC

Do not modify:

```text
runChildProcess buffered stdout/stderr handling
failed-wallet safety gate
graceful stop behavior
force stop behavior
discardFabriqCheckpoint()
LP Agent pipeline
LP Agent Force Stop
Fabriq checkpoint semantics
worker concurrency logic
mutual exclusion logic
API routes
frontend code
dataset logic
PnL logic
```

---

# RUNTIME BEHAVIOR TO PRESERVE

For a resumed Fabriq run:

```text
refreshBefore = keep original full-run cutoff
startedAt     = current resume time
```

Expected concept:

```text
Run 1:
15 sec active

Stopped:
2 min idle

Resume:
20 sec active
```

After resume, runtime should represent the resumed active session:

```text
~20 sec
```

not:

```text
~155 sec
```

Again: do not test this yourself. User will test manually.

---

# FINAL RESPONSE

After editing, reply only:

```text
FIX COMPLETE

Modified:
- scripts/control/server.mjs

Summary:
- restored startPipeline() function declaration
- removed accidental top-level startedAt line
- preserved intended startedAt reset on resume
- fixed illegal return syntax issue

Testing:
- Not run, per instruction
```
