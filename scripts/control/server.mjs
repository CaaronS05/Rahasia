import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8787;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const ALLOWED_ORIGINS = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]);

let currentChild = null;
let lpAgentChild = null;
let runtimeTicker = null;
const sseClients = new Set();

let state = {
    status: "idle", // "idle" | "running" | "stopping" | "stopped" | "completed" | "error"
    stage: "idle",  // "idle" | "enrich" | "merge" | "publish" | "completed" | "error"

    mode: null,     // "stale" | "full" | null
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

    stopMode: null, // "graceful" | "force" | null
    checkpointPreserved: true,

    logs: [],
};

let lpAgentState = {
    status: "idle",
    stage: "idle",
    concurrency: 5,
    fabriqConcurrency: 10,

    startedAt: null,
    finishedAt: null,

    exitCode: null,
    error: null,

    // LP Agent scrape progress
    completedPages: 0,
    totalPages: 0,
    wallets: 0,
    progressPercent: 0,

    // merge-wallets result
    inputRows: 0,
    uniqueIncoming: 0,
    updatedExisting: 0,
    addedNew: 0,
    masterWallets: 0,

    // Fabriq auto-enrichment result
    fabriqTotal: 0,
    fabriqCompleted: 0,
    fabriqSuccess: 0,
    fabriqFailed: 0,
    fabriqSkipped: 0,

    // Stop mode tracking
    stopMode: null, // "graceful" | "force" | null
    checkpointPreserved: true,

    runtimeSeconds: 0,
    logs: [],
};

function lpAgentPublicState() {
    const isRunning =
        Boolean(lpAgentChild) ||
        lpAgentState.status === "running" ||
        lpAgentState.status === "stopping";

    let runtimeSeconds =
        lpAgentState.runtimeSeconds;

    if (lpAgentState.startedAt) {
        const start =
            Date.parse(
                lpAgentState.startedAt
            );

        const end =
            lpAgentState.finishedAt
                ? Date.parse(
                    lpAgentState.finishedAt
                )
                : Date.now();

        if (
            Number.isFinite(start) &&
            Number.isFinite(end)
        ) {
            runtimeSeconds =
                Math.max(
                    0,
                    Math.floor(
                        (
                            end -
                            start
                        ) /
                        1000
                    )
                );
        }
    }

    return {
        ...lpAgentState,
        runtimeSeconds,
        running: isRunning,
    };
}

let lpAgentBaseCompletedPages = 0;
let lpAgentSavedPagesThisRun = new Set();

function syncLpAgentProgress() {
    if (lpAgentState.totalPages > 0) {
        lpAgentState.progressPercent = Math.min(
            100,
            Math.round(
                (lpAgentState.completedPages / lpAgentState.totalPages) * 100
            )
        );
    } else {
        lpAgentState.progressPercent = 0;
    }
}

function parseLpAgentLine(line) {
    // A. [CHECKPOINT] 2 completed pages found
    const cpMatch = line.match(/\[CHECKPOINT\]\s+(\d+)\s+completed pages found/i);
    if (cpMatch) {
        lpAgentBaseCompletedPages = Number.parseInt(cpMatch[1], 10);
        lpAgentState.completedPages = lpAgentBaseCompletedPages;
        syncLpAgentProgress();
        return;
    }

    // B. [CHECKPOINT] known total pages: 48
    const knownTotalMatch = line.match(/\[CHECKPOINT\]\s+known total pages:\s*(\d+)/i);
    if (knownTotalMatch) {
        lpAgentState.totalPages = Number.parseInt(knownTotalMatch[1], 10);
        syncLpAgentProgress();
        return;
    }

    // C. [W3] [PAGE 12/48] fetching
    const pageSlashMatch = line.match(/\[PAGE\s+(\d+)\/(\d+)\]\s+fetching/i);
    if (pageSlashMatch) {
        lpAgentState.totalPages = Number.parseInt(pageSlashMatch[2], 10);
        syncLpAgentProgress();
        return;
    }

    // E. [W2] [CHECKPOINT] page 17 saved or [CHECKPOINT] page 1 saved
    const pageSavedMatch = line.match(/\[CHECKPOINT\]\s+page\s+(\d+)\s+saved/i);
    if (pageSavedMatch) {
        const pageNum = Number.parseInt(pageSavedMatch[1], 10);
        if (!lpAgentSavedPagesThisRun.has(pageNum)) {
            lpAgentSavedPagesThisRun.add(pageNum);
            lpAgentState.completedPages =
                lpAgentBaseCompletedPages + lpAgentSavedPagesThisRun.size;
            if (lpAgentState.totalPages > 0) {
                lpAgentState.completedPages = Math.min(
                    lpAgentState.totalPages,
                    lpAgentState.completedPages
                );
            }
            syncLpAgentProgress();
        }
        return;
    }

    // F. [TOTAL] 570 unique wallets
    const totalWalletsMatch = line.match(/\[TOTAL\]\s+(\d+)\s+unique wallets/i);
    if (totalWalletsMatch) {
        lpAgentState.wallets = Number.parseInt(totalWalletsMatch[1], 10);
        return;
    }

    // G. Final pages: Pages   : 48/48
    const finalPagesMatch = line.match(/^Pages\s*:\s*(\d+)\/(\d+)/i);
    if (finalPagesMatch) {
        lpAgentState.completedPages = Number.parseInt(finalPagesMatch[1], 10);
        lpAgentState.totalPages = Number.parseInt(finalPagesMatch[2], 10);
        lpAgentState.progressPercent = 100;
        return;
    }

    // H. Final wallet count: Wallets : 570
    const finalWalletsMatch = line.match(/^Wallets\s*:\s*(\d+)$/i);
    if (finalWalletsMatch) {
        lpAgentState.wallets = Number.parseInt(finalWalletsMatch[1], 10);
        return;
    }
}

function parseMergeWalletsLine(line) {
    const inputMatch = line.match(/^Input rows\s*:\s*(\d+)/i);
    if (inputMatch) {
        lpAgentState.inputRows = Number.parseInt(inputMatch[1], 10);
        return;
    }
    const incomingMatch = line.match(/^Unique incoming\s*:\s*(\d+)/i);
    if (incomingMatch) {
        lpAgentState.uniqueIncoming = Number.parseInt(incomingMatch[1], 10);
        return;
    }
    const updatedMatch = line.match(/^Updated existing\s*:\s*(\d+)/i);
    if (updatedMatch) {
        lpAgentState.updatedExisting = Number.parseInt(updatedMatch[1], 10);
        return;
    }
    const addedMatch = line.match(/^Added new\s*:\s*(\d+)/i);
    if (addedMatch) {
        lpAgentState.addedNew = Number.parseInt(addedMatch[1], 10);
        return;
    }
    const masterMatch = line.match(/^Master wallets\s*:\s*(\d+)/i);
    if (masterMatch) {
        lpAgentState.masterWallets = Number.parseInt(masterMatch[1], 10);
        return;
    }
}

function parseLpPipelineFabriqLine(line) {
    const datasetMatch = line.match(/\[DATASET\]\s+(\d+)\s+total wallets/i);
    if (datasetMatch) {
        lpAgentState.fabriqTotal = Number.parseInt(datasetMatch[1], 10);
        return;
    }

    const okMatch = line.match(/\[W\d+\]\s+\[OK\]/i);
    if (okMatch) {
        lpAgentState.fabriqSuccess++;
        lpAgentState.fabriqCompleted = Math.min(
            lpAgentState.fabriqTotal || 999999,
            lpAgentState.fabriqCompleted + 1
        );
        return;
    }

    const failMatch = line.match(/\[W\d+\]\s+\[FAIL\]/i);
    if (failMatch) {
        lpAgentState.fabriqFailed++;
        lpAgentState.fabriqCompleted = Math.min(
            lpAgentState.fabriqTotal || 999999,
            lpAgentState.fabriqCompleted + 1
        );
        return;
    }

    const totalMatch = line.match(/^Total\s*:\s*(\d+)$/i);
    if (totalMatch) {
        lpAgentState.fabriqTotal = Number.parseInt(totalMatch[1], 10);
        return;
    }

    const successMatch = line.match(/^Success\s*:\s*(\d+)$/i);
    if (successMatch) {
        lpAgentState.fabriqSuccess = Number.parseInt(successMatch[1], 10);
        return;
    }

    const failedMatch = line.match(/^Failed\s*:\s*(\d+)$/i);
    if (failedMatch) {
        lpAgentState.fabriqFailed = Number.parseInt(failedMatch[1], 10);
        return;
    }

    const skippedMatch = line.match(/^Skipped\s*:\s*(\d+)$/i);
    if (skippedMatch) {
        lpAgentState.fabriqSkipped = Number.parseInt(skippedMatch[1], 10);
        return;
    }
}

function addLpAgentLog(line) {
    const cleaned =
        String(line).trimEnd();

    if (!cleaned) {
        return;
    }

    console.log(
        `[LPAGENT] ${cleaned}`,
    );

    lpAgentState.logs.push(
        cleaned,
    );

    if (
        lpAgentState.logs.length >
        200
    ) {
        lpAgentState.logs =
            lpAgentState.logs.slice(
                -200,
            );
    }
}

const enrichProgress = {
    fresh: 0,
    resumed: 0,
    workerSkips: 0,
    ok: 0,
    failed: 0,
};

function resetEnrichProgress() {
    enrichProgress.fresh = 0;
    enrichProgress.resumed = 0;
    enrichProgress.workerSkips = 0;
    enrichProgress.ok = 0;
    enrichProgress.failed = 0;
}

function syncEnrichProgress() {
    // RESUME dan worker SKIP adalah wallet yang sama.
    // Gunakan nilai terbesar, jangan dijumlahkan.
    const skipped =
        Math.max(
            enrichProgress.resumed,
            enrichProgress.workerSkips,
        );

    const successful =
        enrichProgress.fresh +
        skipped +
        enrichProgress.ok;

    const completed =
        successful +
        enrichProgress.failed;

    state.skipped =
        skipped;

    state.success =
        state.total > 0
            ? Math.min(
                state.total,
                successful,
            )
            : successful;

    state.failed =
        enrichProgress.failed;

    state.completed =
        state.total > 0
            ? Math.min(
                state.total,
                completed,
            )
            : completed;

    broadcastState(
        "progress",
    );
}

function sanitizeConcurrency(value) {
    const parsed =
        Number.parseInt(
            String(value),
            10,
        );

    if (
        !Number.isFinite(parsed)
    ) {
        return 10;
    }

    return Math.max(
        1,
        parsed,
    );
}

function publicState() {
    let runtimeSeconds = state.runtimeSeconds;
    if (state.startedAt) {
        const start = Date.parse(state.startedAt);
        const end = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
        if (Number.isFinite(start) && Number.isFinite(end)) {
            runtimeSeconds = Math.max(0, Math.floor((end - start) / 1000));
        }
    }

    return {
        ...state,
        runtimeSeconds,
        running: Boolean(currentChild) || state.status === "running" || state.status === "stopping",
    };
}

function addLog(line) {
    const cleaned = String(line).trimEnd();
    if (!cleaned) return;

    console.log(cleaned);
    state.logs.push(cleaned);

    if (state.logs.length > 200) {
        state.logs = state.logs.slice(-200);
    }

    broadcast({
        type: "log",
        log: cleaned,
        state: publicState(),
    });
}

function broadcast(payload) {
    const body = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(body);
        } catch {
            sseClients.delete(client);
        }
    }
}

function broadcastState(type = "status") {
    broadcast({
        type,
        state: publicState(),
    });
}

function startRuntimeTicker() {
    stopRuntimeTicker();
    runtimeTicker = setInterval(() => {
        if (state.status === "running" && state.startedAt) {
            const now = Date.now();
            const start = Date.parse(state.startedAt);
            if (Number.isFinite(start)) {
                state.runtimeSeconds = Math.max(0, Math.floor((now - start) / 1000));
                broadcastState("progress");
            }
        }
    }, 1000);
}

function stopRuntimeTicker() {
    if (runtimeTicker) {
        clearInterval(runtimeTicker);
        runtimeTicker = null;
    }
}

function parseEnrichLine(line) {
    // ---------------------------------------
    // Total dataset
    // [DATASET] 1458 total wallets
    // ---------------------------------------

    const datasetMatch =
        line.match(
            /\[DATASET\]\s+(\d+)\s+total wallets/i,
        );

    if (datasetMatch) {
        state.total =
            Number.parseInt(
                datasetMatch[1],
                10,
            );

        broadcastState(
            "progress",
        );

        return;
    }

    // ---------------------------------------
    // Already fresh in master
    // [FRESH] 1358 wallets
    // ---------------------------------------

    const freshMatch =
        line.match(
            /\[FRESH\]\s+(\d+)\s+wallets/i,
        );

    if (freshMatch) {
        enrichProgress.fresh =
            Number.parseInt(
                freshMatch[1],
                10,
            );

        syncEnrichProgress();
        return;
    }

    // ---------------------------------------
    // Already completed in checkpoint
    //
    // [RESUME] 426/1458 already completed
    //
    // IMPORTANT:
    // These wallets will also generate SKIP
    // lines later, so do NOT count twice.
    // ---------------------------------------

    const resumeMatch =
        line.match(
            /\[RESUME\]\s+(\d+)\/(\d+)\s+already completed/i,
        );

    if (resumeMatch) {
        enrichProgress.resumed =
            Number.parseInt(
                resumeMatch[1],
                10,
            );

        syncEnrichProgress();
        return;
    }

    // ---------------------------------------
    // Worker SKIP
    // [W1] [427/1458] SKIP ...
    //
    // Do NOT add on top of resumed.
    // ---------------------------------------

    const skipMatch =
        line.match(
            /\[W\d+\]\s+\[(\d+)\/(\d+)\]\s+SKIP/i,
        );

    if (skipMatch) {
        enrichProgress.workerSkips++;

        syncEnrichProgress();
        return;
    }

    // ---------------------------------------
    // Newly successfully fetched wallet
    // [W1] [OK] ...
    // ---------------------------------------

    const okMatch =
        line.match(
            /\[W\d+\]\s+\[OK\]/i,
        );

    if (okMatch) {
        enrichProgress.ok++;

        syncEnrichProgress();
        return;
    }

    // ---------------------------------------
    // Newly failed wallet
    // [W1] [FAIL] ...
    // ---------------------------------------

    const failMatch =
        line.match(
            /\[W\d+\]\s+\[FAIL\]/i,
        );

    if (failMatch) {
        enrichProgress.failed++;

        syncEnrichProgress();
        return;
    }

    // =======================================
    // FINAL SCRAPER SUMMARY
    // =======================================

    const totalMatch =
        line.match(
            /^Total\s*:\s*(\d+)$/i,
        );

    if (totalMatch) {
        state.total =
            Number.parseInt(
                totalMatch[1],
                10,
            );

        broadcastState(
            "progress",
        );

        return;
    }

    const successMatch =
        line.match(
            /^Success\s*:\s*(\d+)$/i,
        );

    if (successMatch) {
        state.success =
            Number.parseInt(
                successMatch[1],
                10,
            );

        state.completed =
            Math.min(
                state.total,
                state.success +
                state.failed,
            );

        broadcastState(
            "progress",
        );

        return;
    }

    const failedMatch =
        line.match(
            /^Failed\s*:\s*(\d+)$/i,
        );

    if (failedMatch) {
        state.failed =
            Number.parseInt(
                failedMatch[1],
                10,
            );

        state.completed =
            Math.min(
                state.total,
                state.success +
                state.failed,
            );

        broadcastState(
            "progress",
        );

        return;
    }

    const skippedMatch =
        line.match(
            /^Skipped\s*:\s*(\d+)$/i,
        );

    if (skippedMatch) {
        state.skipped =
            Number.parseInt(
                skippedMatch[1],
                10,
            );

        broadcastState(
            "progress",
        );

        return;
    }

    const runtimeMatch =
        line.match(
            /^Runtime\s*:\s*([\d.]+)\s*sec$/i,
        );

    if (runtimeMatch) {
        state.runtimeSeconds =
            Number.parseFloat(
                runtimeMatch[1],
            );

        broadcastState(
            "progress",
        );
    }
}

function runChildProcess(
    command,
    args,
    env,
    lineParser = null
) {
    return new Promise(
        (resolve, reject) => {
            currentChild =
                spawn(
                    command,
                    args,
                    {
                        cwd: ROOT,

                        env: {
                            ...process.env,
                            ...env,
                        },

                        stdio: [
                            "ignore",
                            "pipe",
                            "pipe",
                        ],
                    }
                );

            let stdoutBuffer = "";
            let stderrBuffer = "";

            function processLine(line) {
                const trimmed =
                    line.trimEnd();

                if (!trimmed) {
                    return;
                }

                addLog(trimmed);

                if (lineParser) {
                    lineParser(
                        trimmed
                    );
                }
            }

            function consumeChunk(
                buffer,
                chunk
            ) {
                buffer +=
                    String(chunk);

                const lines =
                    buffer.split("\n");

                const remainder =
                    lines.pop() ?? "";

                for (
                    const line
                    of lines
                ) {
                    processLine(line);
                }

                return remainder;
            }

            currentChild.stdout.on(
                "data",
                (chunk) => {
                    stdoutBuffer =
                        consumeChunk(
                            stdoutBuffer,
                            chunk
                        );
                }
            );

            currentChild.stderr.on(
                "data",
                (chunk) => {
                    stderrBuffer =
                        consumeChunk(
                            stderrBuffer,
                            chunk
                        );
                }
            );

            currentChild.on(
                "error",
                (error) => {
                    currentChild =
                        null;

                    reject(error);
                }
            );

            currentChild.on(
                "exit",
                (code, signal) => {
                    if (
                        stdoutBuffer.trim()
                    ) {
                        processLine(
                            stdoutBuffer
                        );
                    }

                    if (
                        stderrBuffer.trim()
                    ) {
                        processLine(
                            stderrBuffer
                        );
                    }

                    currentChild =
                        null;

                    resolve({
                        code,
                        signal,
                    });
                }
            );
        }
    );
}

async function startPipeline({ mode, concurrency, resume }) {
    if (currentChild || state.status === "running" || state.status === "stopping") {
        throw new Error("Fabriq update is already running");
    }

    const isResume = Boolean(resume);
    const safeConcurrency = sanitizeConcurrency(concurrency ?? state.concurrency);

    let safeMode = mode;
    if (!safeMode) {
        safeMode = isResume && state.mode ? state.mode : "stale";
    }

    let refreshBefore = state.refreshBefore;
    if (isResume) {
        // Keep existing refreshBefore when resuming
        if (safeMode === "full" && !refreshBefore) {
            refreshBefore = new Date().toISOString();
        }
    } else {
        // New run
        if (safeMode === "full") {
            refreshBefore = new Date().toISOString();
        } else {
            refreshBefore = null;
        }
    }

    state.status = "running";
    state.stage = "enrich";
    state.mode = safeMode;
    state.concurrency = safeConcurrency;
    state.refreshBefore = refreshBefore;
    state.startedAt = isResume && state.startedAt ? state.startedAt : new Date().toISOString();
    state.finishedAt = null;
    state.exitCode = null;
    state.error = null;
    state.stopMode = null;
    state.checkpointPreserved = true;

    if (!isResume) {
        state.total = 0;
        state.completed = 0;
        state.success = 0;
        state.failed = 0;
        state.skipped = 0;
        state.runtimeSeconds = 0;
        state.logs = [];
    }

    resetEnrichProgress();

    addLog(`[CONTROL] Starting pipeline: mode=${safeMode}, workers=${safeConcurrency}, resume=${isResume}`);
    if (refreshBefore) {
        addLog(`[CONTROL] refreshBefore=${refreshBefore}`);
    }

    broadcastState("status");
    startRuntimeTicker();

    try {
        // ----------------------------------------------------
        // 1. Stage: enrich
        // ----------------------------------------------------
        state.stage = "enrich";
        broadcastState("stage");

        const enrichEnv = {
            FABRIQ_CONCURRENCY: String(safeConcurrency),
        };
        if (refreshBefore) {
            enrichEnv.FABRIQ_REFRESH_BEFORE = refreshBefore;
        }

        const enrichResult = await runChildProcess(
            process.execPath,
            ["scripts/fabriq/enrich-wallets.mjs"],
            enrichEnv,
            parseEnrichLine
        );

        if (state.status === "stopping" || state.status === "stopped") {
            const wasForce = state.stopMode === "force";
            if (wasForce) {
                discardFabriqCheckpoint();
            }
            state.status = "stopped";
            state.stage = "stopped";
            state.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLog("[CONTROL] Fabriq pipeline force-stopped. Checkpoint discarded. Next update will start fresh.");
            } else {
                addLog("[CONTROL] Enrichment stopped by user. Progress is saved and can be resumed.");
            }
            stopRuntimeTicker();
            broadcastState("status");
            return;
        }

        if (enrichResult.code !== 0) {
            state.status = "error";
            state.stage = "error";
            state.exitCode = enrichResult.code;
            state.error = `Enrichment failed with exit code ${enrichResult.code}`;
            state.finishedAt = new Date().toISOString();
            addLog(`[CONTROL] ${state.error}`);
            stopRuntimeTicker();
            broadcastState("error");
            return;
        }

        if (state.failed > 0) {
            state.status = "error";
            state.stage = "error";
            state.error =
                `Fabriq enrichment completed with ${state.failed} failed wallets; merge/publish aborted.`;
            state.finishedAt =
                new Date().toISOString();

            addLog(
                `[CONTROL] ${state.error}`
            );

            stopRuntimeTicker();
            broadcastState("error");

            return;
        }

        if (state.total > 0) {
            state.completed = state.total;
        }

        // ----------------------------------------------------
        // 2. Stage: merge
        // ----------------------------------------------------
        if (state.status === "stopping" || state.status === "stopped") return;

        state.stage = "merge";
        addLog("[CONTROL] Enrichment completed. Running merge:fabriq...");
        broadcastState("stage");

        const mergeResult = await runChildProcess(
            process.execPath,
            [
                "--experimental-strip-types",
                "scripts/pipeline/merge-fabriq.ts",
            ],
            {}
        );

        if (state.status === "stopping" || state.status === "stopped") {
            const wasForce = state.stopMode === "force";
            if (wasForce) {
                discardFabriqCheckpoint();
            }
            state.status = "stopped";
            state.stage = "stopped";
            state.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLog("[CONTROL] Fabriq pipeline force-stopped during merge. Checkpoint discarded.");
            } else {
                addLog("[CONTROL] Pipeline stopped by user during merge.");
            }
            stopRuntimeTicker();
            broadcastState("status");
            return;
        }

        if (mergeResult.code !== 0) {
            state.status = "error";
            state.stage = "error";
            state.exitCode = mergeResult.code;
            state.error = `Merge failed with exit code ${mergeResult.code}`;
            state.finishedAt = new Date().toISOString();
            addLog(`[CONTROL] ${state.error}`);
            stopRuntimeTicker();
            broadcastState("error");
            return;
        }

        // ----------------------------------------------------
        // 3. Stage: publish
        // ----------------------------------------------------
        if (state.status === "stopping" || state.status === "stopped") return;

        state.stage = "publish";
        addLog("[CONTROL] Merge completed. Running publish:wallets...");
        broadcastState("stage");

        const publishResult = await runChildProcess(
            process.execPath,
            [
                "--experimental-strip-types",
                "scripts/pipeline/publish-wallets.ts",
            ],
            {}
        );

        if (state.status === "stopping" || state.status === "stopped") {
            const wasForce = state.stopMode === "force";
            if (wasForce) {
                discardFabriqCheckpoint();
            }
            state.status = "stopped";
            state.stage = "stopped";
            state.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLog("[CONTROL] Fabriq pipeline force-stopped during publish. Checkpoint discarded.");
            } else {
                addLog("[CONTROL] Pipeline stopped by user during publish.");
            }
            stopRuntimeTicker();
            broadcastState("status");
            return;
        }

        if (publishResult.code !== 0) {
            state.status = "error";
            state.stage = "error";
            state.exitCode = publishResult.code;
            state.error = `Publish failed with exit code ${publishResult.code}`;
            state.finishedAt = new Date().toISOString();
            addLog(`[CONTROL] ${state.error}`);
            stopRuntimeTicker();
            broadcastState("error");
            return;
        }

        // ----------------------------------------------------
        // 4. Stage: completed
        // ----------------------------------------------------
        state.status = "completed";
        state.stage = "completed";
        state.exitCode = 0;
        state.finishedAt = new Date().toISOString();
        addLog("[CONTROL] Entire pipeline (enrich -> merge -> publish) completed successfully.");
        stopRuntimeTicker();
        broadcastState("finish");
    } catch (error) {
        state.status = "error";
        state.stage = "error";
        state.error = error instanceof Error ? error.message : String(error);
        state.finishedAt = new Date().toISOString();
        addLog(`[CONTROL] Pipeline error: ${state.error}`);
        stopRuntimeTicker();
        broadcastState("error");
    }
}

function runLpAgentChildProcess(command, args, env, lineParser = null) {
    return new Promise((resolve, reject) => {
        lpAgentChild = spawn(command, args, {
            cwd: ROOT,
            env: {
                ...process.env,
                ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdoutBuffer = "";
        let stderrBuffer = "";

        function consumeBuffer(buffer, chunk, onLine) {
            buffer += String(chunk);
            const lines = buffer.split("\n");
            const remainder = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trimEnd();
                if (trimmed) {
                    onLine(trimmed);
                }
            }
            return remainder;
        }

        lpAgentChild.stdout.on("data", (chunk) => {
            stdoutBuffer = consumeBuffer(stdoutBuffer, chunk, (line) => {
                addLpAgentLog(line);
                if (lineParser) lineParser(line);
            });
        });

        lpAgentChild.stderr.on("data", (chunk) => {
            stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
                addLpAgentLog(line);
                if (lineParser) lineParser(line);
            });
        });

        lpAgentChild.on("error", (error) => {
            lpAgentChild = null;
            reject(error);
        });

        lpAgentChild.on("exit", (code, signal) => {
            if (stdoutBuffer.trim()) {
                const trimmed = stdoutBuffer.trimEnd();
                addLpAgentLog(trimmed);
                if (lineParser) lineParser(trimmed);
                stdoutBuffer = "";
            }
            if (stderrBuffer.trim()) {
                const trimmed = stderrBuffer.trimEnd();
                addLpAgentLog(trimmed);
                if (lineParser) lineParser(trimmed);
                stderrBuffer = "";
            }

            lpAgentChild = null;
            resolve({ code, signal });
        });
    });
}

async function startLpAgentRefresh({
    concurrency,
    fabriqConcurrency,
} = {}) {
    if (
        lpAgentChild ||
        currentChild ||
        state.status === "running" ||
        state.status === "stopping" ||
        lpAgentState.status === "running" ||
        lpAgentState.status === "stopping"
    ) {
        throw new Error("Another update process is already running");
    }

    const safeConcurrency = sanitizeConcurrency(concurrency ?? 5);
    const safeFabriqConcurrency = sanitizeConcurrency(fabriqConcurrency ?? 10);

    lpAgentBaseCompletedPages = 0;
    lpAgentSavedPagesThisRun = new Set();

    lpAgentState = {
        status: "running",
        stage: "scrape",
        concurrency: safeConcurrency,
        fabriqConcurrency: safeFabriqConcurrency,

        startedAt: new Date().toISOString(),
        finishedAt: null,

        exitCode: null,
        error: null,

        completedPages: 0,
        totalPages: 0,
        wallets: 0,
        progressPercent: 0,

        inputRows: 0,
        uniqueIncoming: 0,
        updatedExisting: 0,
        addedNew: 0,
        masterWallets: 0,

        fabriqTotal: 0,
        fabriqCompleted: 0,
        fabriqSuccess: 0,
        fabriqFailed: 0,
        fabriqSkipped: 0,

        stopMode: null,
        checkpointPreserved: true,

        runtimeSeconds: 0,
        logs: [],
    };

    addLpAgentLog(
        `[CONTROL] Starting LP Agent pipeline: LP workers=${safeConcurrency}, Fabriq workers=${safeFabriqConcurrency}`
    );

    try {
        // ----------------------------------------------------
        // 1. Stage: scrape
        // ----------------------------------------------------
        lpAgentState.stage = "scrape";
        const scrapeResult = await runLpAgentChildProcess(
            process.execPath,
            ["scripts/lpagent/scrape-smart-lp.mjs"],
            {
                LPAGENT_CONCURRENCY: String(safeConcurrency),
            },
            parseLpAgentLine
        );

        if (lpAgentState.status === "stopping" || lpAgentState.status === "stopped") {
            const wasForce = lpAgentState.stopMode === "force";
            if (wasForce) {
                discardLpAgentCheckpoints(lpAgentState.stage);
            }
            lpAgentState.status = "stopped";
            lpAgentState.stage = "stopped";
            lpAgentState.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLpAgentLog("[CONTROL] LP Agent scrape force-stopped. Checkpoint discarded. Next update will start fresh.");
            } else {
                addLpAgentLog("[CONTROL] LP Agent scrape stopped by user. Progress is saved and can be resumed.");
            }
            return;
        }

        if (scrapeResult.code !== 0) {
            lpAgentState.status = "error";
            lpAgentState.stage = "error";
            lpAgentState.exitCode = scrapeResult.code;
            lpAgentState.error = `LP Agent scrape failed with exit code ${scrapeResult.code}`;
            lpAgentState.finishedAt = new Date().toISOString();
            addLpAgentLog(`[CONTROL] ${lpAgentState.error}`);
            return;
        }

        // ----------------------------------------------------
        // 2. Stage: merge_wallets
        // ----------------------------------------------------
        lpAgentState.stage = "merge_wallets";
        addLpAgentLog("[CONTROL] Scrape succeeded. Merging Smart LP wallets into master dataset...");

        const mergeResult = await runLpAgentChildProcess(
            process.execPath,
            [
                "--experimental-strip-types",
                "scripts/pipeline/merge-wallets.ts",
                "data/raw/lpagent/smart-lp-latest.json",
            ],
            {},
            parseMergeWalletsLine
        );

        if (lpAgentState.status === "stopping" || lpAgentState.status === "stopped") {
            const wasForce = lpAgentState.stopMode === "force";
            if (wasForce) {
                discardLpAgentCheckpoints(lpAgentState.stage);
            }
            lpAgentState.status = "stopped";
            lpAgentState.stage = "stopped";
            lpAgentState.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLpAgentLog("[CONTROL] Pipeline force-stopped during wallet merge. Checkpoint discarded.");
            } else {
                addLpAgentLog("[CONTROL] Pipeline stopped by user during wallet merge.");
            }
            return;
        }

        if (mergeResult.code !== 0) {
            lpAgentState.status = "error";
            lpAgentState.stage = "error";
            lpAgentState.exitCode = mergeResult.code;
            lpAgentState.error = `Wallet merge failed with exit code ${mergeResult.code}`;
            lpAgentState.finishedAt = new Date().toISOString();
            addLpAgentLog(`[CONTROL] ${lpAgentState.error}`);
            return;
        }

        // ----------------------------------------------------
        // 3. Stage: fabriq_enrich
        // ----------------------------------------------------
        lpAgentState.stage = "fabriq_enrich";
        addLpAgentLog(
            `[CONTROL] Wallet merge succeeded. Enriching missing/stale Fabriq data (workers=${safeFabriqConcurrency})...`
        );

        const enrichResult = await runLpAgentChildProcess(
            process.execPath,
            ["scripts/fabriq/enrich-wallets.mjs"],
            {
                FABRIQ_CONCURRENCY: String(safeFabriqConcurrency),
            },
            parseLpPipelineFabriqLine
        );

        if (lpAgentState.status === "stopping" || lpAgentState.status === "stopped") {
            const wasForce = lpAgentState.stopMode === "force";
            if (wasForce) {
                discardLpAgentCheckpoints(lpAgentState.stage);
            }
            lpAgentState.status = "stopped";
            lpAgentState.stage = "stopped";
            lpAgentState.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLpAgentLog("[CONTROL] Pipeline force-stopped during Fabriq enrichment. Checkpoint discarded.");
            } else {
                addLpAgentLog("[CONTROL] Pipeline stopped by user during Fabriq enrichment.");
            }
            return;
        }

        if (enrichResult.code !== 0) {
            lpAgentState.status = "error";
            lpAgentState.stage = "error";
            lpAgentState.exitCode = enrichResult.code;
            lpAgentState.error = `Fabriq enrichment failed with exit code ${enrichResult.code}`;
            lpAgentState.finishedAt = new Date().toISOString();
            addLpAgentLog(`[CONTROL] ${lpAgentState.error}`);
            return;
        }

        // Safety gate: If fabriqFailed > 0, do NOT proceed to merge or publish!
        if (lpAgentState.fabriqFailed > 0) {
            lpAgentState.status = "error";
            lpAgentState.stage = "error";
            lpAgentState.error = `Fabriq enrichment completed with ${lpAgentState.fabriqFailed} failed wallets; merge/publish aborted.`;
            lpAgentState.finishedAt = new Date().toISOString();
            addLpAgentLog(`[CONTROL] ${lpAgentState.error}`);
            return;
        }

        if (lpAgentState.fabriqTotal > 0) {
            lpAgentState.fabriqCompleted = lpAgentState.fabriqTotal;
        }

        // ----------------------------------------------------
        // 4. Stage: fabriq_merge
        // ----------------------------------------------------
        lpAgentState.stage = "fabriq_merge";
        addLpAgentLog("[CONTROL] Fabriq enrichment succeeded. Running merge:fabriq...");

        const fabriqMergeResult = await runLpAgentChildProcess(
            process.execPath,
            [
                "--experimental-strip-types",
                "scripts/pipeline/merge-fabriq.ts",
            ],
            {},
            null
        );

        if (lpAgentState.status === "stopping" || lpAgentState.status === "stopped") {
            const wasForce = lpAgentState.stopMode === "force";
            if (wasForce) {
                discardLpAgentCheckpoints(lpAgentState.stage);
            }
            lpAgentState.status = "stopped";
            lpAgentState.stage = "stopped";
            lpAgentState.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLpAgentLog("[CONTROL] Pipeline force-stopped during Fabriq merge.");
            } else {
                addLpAgentLog("[CONTROL] Pipeline stopped by user during Fabriq merge.");
            }
            return;
        }

        if (fabriqMergeResult.code !== 0) {
            lpAgentState.status = "error";
            lpAgentState.stage = "error";
            lpAgentState.exitCode = fabriqMergeResult.code;
            lpAgentState.error = `Fabriq merge failed with exit code ${fabriqMergeResult.code}`;
            lpAgentState.finishedAt = new Date().toISOString();
            addLpAgentLog(`[CONTROL] ${lpAgentState.error}`);
            return;
        }

        // ----------------------------------------------------
        // 5. Stage: publish
        // ----------------------------------------------------
        lpAgentState.stage = "publish";
        addLpAgentLog("[CONTROL] Fabriq merge succeeded. Publishing frontend dataset...");

        const publishResult = await runLpAgentChildProcess(
            process.execPath,
            [
                "--experimental-strip-types",
                "scripts/pipeline/publish-wallets.ts",
            ],
            {},
            null
        );

        if (lpAgentState.status === "stopping" || lpAgentState.status === "stopped") {
            const wasForce = lpAgentState.stopMode === "force";
            if (wasForce) {
                discardLpAgentCheckpoints(lpAgentState.stage);
            }
            lpAgentState.status = "stopped";
            lpAgentState.stage = "stopped";
            lpAgentState.finishedAt = new Date().toISOString();
            if (wasForce) {
                addLpAgentLog("[CONTROL] Pipeline force-stopped during publish.");
            } else {
                addLpAgentLog("[CONTROL] Pipeline stopped by user during publish.");
            }
            return;
        }

        if (publishResult.code !== 0) {
            lpAgentState.status = "error";
            lpAgentState.stage = "error";
            lpAgentState.exitCode = publishResult.code;
            lpAgentState.error = `Publish failed with exit code ${publishResult.code}`;
            lpAgentState.finishedAt = new Date().toISOString();
            addLpAgentLog(`[CONTROL] ${lpAgentState.error}`);
            return;
        }

        // ----------------------------------------------------
        // Final: completed
        // ----------------------------------------------------
        lpAgentState.status = "completed";
        lpAgentState.stage = "completed";
        lpAgentState.exitCode = 0;
        lpAgentState.progressPercent = 100;
        lpAgentState.finishedAt = new Date().toISOString();
        if (lpAgentState.startedAt) {
            lpAgentState.runtimeSeconds = Math.max(
                0,
                Math.floor((Date.now() - Date.parse(lpAgentState.startedAt)) / 1000)
            );
        }
        addLpAgentLog("[CONTROL] LP Agent wallet pipeline completed successfully.");
    } catch (error) {
        lpAgentState.status = "error";
        lpAgentState.stage = "error";
        lpAgentState.error = error instanceof Error ? error.message : String(error);
        lpAgentState.finishedAt = new Date().toISOString();
        addLpAgentLog(`[CONTROL] Pipeline exception: ${lpAgentState.error}`);
    }
}

function discardFabriqCheckpoint() {
    try {
        const fabriqCheckpointPath = path.join(ROOT, "data/checkpoints/fabriq.jsonl");
        if (fs.existsSync(fabriqCheckpointPath)) {
            fs.unlinkSync(fabriqCheckpointPath);
            addLog("[CONTROL] Discarded checkpoint: data/checkpoints/fabriq.jsonl");
        }
    } catch (err) {
        console.error("Failed to delete fabriq checkpoint:", err);
    }
}

function discardLpAgentCheckpoints(stage) {
    try {
        const lpCheckpointPath = path.join(ROOT, "data/checkpoints/lpagent.jsonl");
        if (fs.existsSync(lpCheckpointPath)) {
            fs.unlinkSync(lpCheckpointPath);
            addLpAgentLog("[CONTROL] Discarded checkpoint: data/checkpoints/lpagent.jsonl");
        }
    } catch (err) {
        console.error("Failed to delete lpagent checkpoint:", err);
    }

    if (stage === "fabriq_enrich") {
        discardFabriqCheckpoint();
    }
}

function stopLpAgentRefresh() {
    if (!lpAgentChild && lpAgentState.status !== "running" && lpAgentState.status !== "stopping") {
        return false;
    }

    lpAgentState.status = "stopping";
    lpAgentState.stopMode = "graceful";
    lpAgentState.checkpointPreserved = true;
    addLpAgentLog("[CONTROL] Stopping LP Agent pipeline (preserving checkpoint)...");

    if (lpAgentChild) {
        try {
            lpAgentChild.kill("SIGTERM");
        } catch (e) {
            console.error(e);
        }

        const targetChild = lpAgentChild;
        setTimeout(() => {
            if (lpAgentChild === targetChild) {
                try {
                    lpAgentChild.kill("SIGKILL");
                } catch { }
            }
        }, 4000);
    } else {
        lpAgentState.status = "stopped";
        lpAgentState.stage = "stopped";
        lpAgentState.finishedAt = new Date().toISOString();
    }

    return true;
}

function forceStopLpAgentRefresh() {
    if (!lpAgentChild && lpAgentState.status !== "running" && lpAgentState.status !== "stopping") {
        return false;
    }

    const currentStage = lpAgentState.stage;
    lpAgentState.status = "stopping";
    lpAgentState.stopMode = "force";
    lpAgentState.checkpointPreserved = false;
    addLpAgentLog("[CONTROL] Force-stopping LP Agent pipeline...");

    discardLpAgentCheckpoints(currentStage);

    if (lpAgentChild) {
        try {
            lpAgentChild.kill("SIGTERM");
        } catch (e) {
            console.error(e);
        }

        const targetChild = lpAgentChild;
        setTimeout(() => {
            if (lpAgentChild === targetChild) {
                try {
                    lpAgentChild.kill("SIGKILL");
                } catch { }
            }
            discardLpAgentCheckpoints(currentStage);
        }, 1500);
    } else {
        lpAgentState.status = "stopped";
        lpAgentState.stage = "stopped";
        lpAgentState.finishedAt = new Date().toISOString();
        discardLpAgentCheckpoints(currentStage);
    }

    return true;
}

function stopPipeline() {
    if (!currentChild && state.status !== "running" && state.status !== "stopping") {
        return false;
    }

    state.status = "stopping";
    state.stopMode = "graceful";
    state.checkpointPreserved = true;
    addLog("[CONTROL] Stopping Fabriq pipeline (preserving checkpoint)...");
    broadcastState("status");

    if (currentChild) {
        try {
            currentChild.kill("SIGTERM");
        } catch (e) {
            console.error(e);
        }

        const targetChild = currentChild;
        setTimeout(() => {
            if (currentChild === targetChild) {
                try {
                    currentChild.kill("SIGKILL");
                } catch { }
            }
        }, 4000);
    } else {
        state.status = "stopped";
        state.stage = "stopped";
        state.finishedAt = new Date().toISOString();
        stopRuntimeTicker();
        broadcastState("status");
    }

    return true;
}

function forceStopPipeline() {
    if (!currentChild && state.status !== "running" && state.status !== "stopping") {
        return false;
    }

    const currentStage = state.stage;
    state.status = "stopping";
    state.stopMode = "force";
    state.checkpointPreserved = false;
    addLog("[CONTROL] Force-stopping Fabriq pipeline...");
    broadcastState("status");

    discardFabriqCheckpoint();

    if (currentChild) {
        try {
            currentChild.kill("SIGTERM");
        } catch (e) {
            console.error(e);
        }

        const targetChild = currentChild;
        setTimeout(() => {
            if (currentChild === targetChild) {
                try {
                    currentChild.kill("SIGKILL");
                } catch { }
            }
            discardFabriqCheckpoint();
        }, 1500);
    } else {
        state.status = "stopped";
        state.stage = "stopped";
        state.finishedAt = new Date().toISOString();
        discardFabriqCheckpoint();
        stopRuntimeTicker();
        broadcastState("status");
        addLog("[CONTROL] Fabriq pipeline force-stopped. Checkpoint discarded. Next update will start fresh.");
    }

    return true;
}

function setCors(request, response) {
    const origin = request.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
    } else {
        response.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(request, response, statusCode, payload) {
    setCors(request, response);
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(statusCode);
    response.end(JSON.stringify(payload, null, 2));
}

async function readJson(request) {
    let body = "";
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 100_000) {
            throw new Error("Request body too large");
        }
    }
    if (!body.trim()) {
        return {};
    }
    return JSON.parse(body);
}

const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
        setCors(request, response);
        response.writeHead(204);
        response.end();
        return;
    }

    const url = new URL(request.url, `http://${HOST}:${PORT}`);

    // ------------------------------------------------------
    // GET /api/lpagent/status
    // ------------------------------------------------------

    if (
        request.method === "GET" &&
        url.pathname ===
        "/api/lpagent/status"
    ) {
        json(
            request,
            response,
            200,
            lpAgentPublicState(),
        );

        return;
    }

    // ------------------------------------------------------
    // POST /api/lpagent/refresh
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname ===
        "/api/lpagent/refresh"
    ) {
        if (
            lpAgentChild ||
            currentChild ||
            state.status === "running" ||
            state.status === "stopping" ||
            lpAgentState.status === "running" ||
            lpAgentState.status === "stopping"
        ) {
            json(
                request,
                response,
                409,
                {
                    error:
                        "Another update process is already running",

                    lpagent:
                        lpAgentPublicState(),

                    fabriq:
                        publicState(),
                },
            );

            return;
        }

        let body = {};

        try {
            body =
                await readJson(
                    request,
                );
        } catch (error) {
            json(
                request,
                response,
                400,
                {
                    error:
                        "Invalid JSON body",
                },
            );

            return;
        }

        startLpAgentRefresh({
            concurrency:
                body.concurrency,
            fabriqConcurrency:
                body.fabriqConcurrency,
        })
            .catch(
                (error) => {
                    console.error(
                        "LP Agent background error:",
                        error,
                    );
                },
            );

        json(
            request,
            response,
            202,
            lpAgentPublicState(),
        );

        return;
    }

    // ------------------------------------------------------
    // POST /api/lpagent/stop
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname ===
        "/api/lpagent/stop"
    ) {
        const stopped =
            stopLpAgentRefresh();

        json(
            request,
            response,
            stopped ? 202 : 409,
            {
                stopped,

                ...lpAgentPublicState(),
            },
        );

        return;
    }

    // ------------------------------------------------------
    // POST /api/lpagent/force-stop
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname ===
        "/api/lpagent/force-stop"
    ) {
        const stopped =
            forceStopLpAgentRefresh();

        json(
            request,
            response,
            stopped ? 202 : 409,
            {
                stopped,

                ...lpAgentPublicState(),
            },
        );

        return;
    }

    // ------------------------------------------------------
    // SSE: GET /api/fabriq/events
    // ------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/fabriq/events") {
        setCors(request, response);
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        });

        // Send initial state immediately
        response.write(`data: ${JSON.stringify({ type: "init", state: publicState() })}\n\n`);

        sseClients.add(response);

        request.on("close", () => {
            sseClients.delete(response);
        });
        return;
    }

    // ------------------------------------------------------
    // GET /api/fabriq/status
    // ------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/fabriq/status") {
        json(request, response, 200, publicState());
        return;
    }

    // ------------------------------------------------------
    // POST /api/fabriq/refresh
    // ------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/fabriq/refresh") {
        if (
            currentChild ||
            lpAgentChild ||
            state.status === "running" ||
            state.status === "stopping" ||
            lpAgentState.status === "running" ||
            lpAgentState.status === "stopping"
        ) {
            json(request, response, 409, {
                error: "Another update process is already running",
                fabriq: publicState(),
                lpagent: lpAgentPublicState(),
            });
            return;
        }

        try {
            const body = await readJson(request);

            startPipeline({
                mode: body.mode,
                concurrency: body.concurrency,
                resume: body.resume,
            }).catch((err) => {
                console.error("Pipeline background error:", err);
            });

            json(request, response, 202, publicState());
        } catch (error) {
            json(request, response, 400, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }

    // ------------------------------------------------------
    // POST /api/fabriq/resume
    // ------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/fabriq/resume") {
        if (
            currentChild ||
            lpAgentChild ||
            state.status === "running" ||
            state.status === "stopping" ||
            lpAgentState.status === "running" ||
            lpAgentState.status === "stopping"
        ) {
            json(request, response, 409, {
                error: "Another update process is already running",
                fabriq: publicState(),
                lpagent: lpAgentPublicState(),
            });
            return;
        }

        try {
            const body = await readJson(request);

            startPipeline({
                mode: state.mode || "stale",
                concurrency: body.concurrency,
                resume: true,
            }).catch((err) => {
                console.error("Pipeline background error:", err);
            });

            json(request, response, 202, publicState());
        } catch (error) {
            json(request, response, 400, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }

    // ------------------------------------------------------
    // POST /api/fabriq/stop
    // ------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/fabriq/stop") {
        const stopped = stopPipeline();
        json(request, response, stopped ? 202 : 409, {
            stopped,
            ...publicState(),
        });
        return;
    }

    // ------------------------------------------------------
    // POST /api/fabriq/force-stop
    // ------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/fabriq/force-stop") {
        const stopped = forceStopPipeline();
        json(request, response, stopped ? 202 : 409, {
            stopped,
            ...publicState(),
        });
        return;
    }

    // 404
    json(request, response, 404, {
        error: "Not found",
    });
});

// Periodic heartbeat for SSE connections
setInterval(() => {
    for (const client of sseClients) {
        try {
            client.write(": ping\n\n");
        } catch {
            sseClients.delete(client);
        }
    }
}, 15000);

server.listen(PORT, HOST, () => {
    console.log(`Fabriq Control Server running at http://${HOST}:${PORT}`);
    console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ")}`);
    console.log(
        "Worker limit: none",
    );
});