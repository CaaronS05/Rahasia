import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTokenPools } from "../pool/discover-token-pools.mjs";

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
let poolScannerChild = null;
let walletIntelligenceChild = null;
let poolRefreshChild = null;
let runtimeTicker = null;
const sseClients = new Set();

function getCurrentJakartaMonth() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
    }).formatToParts(new Date());

    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    return `${year}-${month}`;
}

function validateHistoryConfig(historyMode, startMonth) {
    const mode = historyMode ?? "90d";
    if (mode !== "90d" && mode !== "custom") {
        throw new Error('historyMode must be "90d" or "custom"');
    }

    if (mode === "90d") {
        return {
            historyMode: "90d",
            startMonth: null,
        };
    }

    if (!startMonth || typeof startMonth !== "string") {
        throw new Error('startMonth is required when historyMode is "custom"');
    }

    const trimmed = startMonth.trim();
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(trimmed)) {
        throw new Error('startMonth must be in strict YYYY-MM format');
    }

    const curMonth = getCurrentJakartaMonth();
    if (trimmed > curMonth) {
        throw new Error(`startMonth (${trimmed}) cannot be later than current month (${curMonth})`);
    }

    return {
        historyMode: "custom",
        startMonth: trimmed,
    };
}

let state = {
    status: "idle", // "idle" | "running" | "stopping" | "stopped" | "completed" | "error"
    stage: "idle",  // "idle" | "enrich" | "merge" | "publish" | "completed" | "error"

    mode: null,     // "stale" | "full" | null
    concurrency: 10,
    historyMode: "90d", // "90d" | "custom"
    startMonth: null,   // string | null
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
    historyMode: "90d", // "90d" | "custom"
    startMonth: null,   // string | null

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

let poolScannerState = {
    status: "idle",
    stage: "idle",
    tokenCa: null,
    fabriqWorkers: 8,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    logs: [],
    selectedPools: [],
    selectedPoolCount: 0,
    completedPoolCount: 0,
    uniqueWallets: 0,
    currentPool: null,
    fabriqTotal: 0,
    fabriqCompleted: 0,
    fabriqSuccess: 0,
    fabriqFailed: 0,
    fabriqSkipped: 0,
    fabriqLimit: null,
    tradeHistoryTotalWallets: 0,
    tradeHistoryCompletedWallets: 0,
    tradeHistoryFailedWallets: 0,
    tradeHistoryTotalTrades: 0,
};

function readPoolScannerPipelineState(tokenCa) {
    if (!tokenCa) return null;
    const statePath = path.join(
        ROOT,
        "data",
        "discovery",
        "pool-scanner",
        tokenCa,
        "pipeline-state.json"
    );
    try {
        if (!fs.existsSync(statePath)) return null;
        return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
        return null;
    }
}

function checkPoolScannerResumable(tokenCa) {
    if (!tokenCa) return false;
    const baseDir = path.join(
        ROOT,
        "data",
        "discovery",
        "pool-scanner",
        tokenCa
    );
    const statePath = path.join(baseDir, "pipeline-state.json");
    const walletsPath = path.join(baseDir, "wallets.json");
    try {
        if (!fs.existsSync(statePath) || !fs.existsSync(walletsPath)) {
            return false;
        }
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        return (
            state.stage1Complete === true &&
            state.stage2Complete !== true &&
            state.pipelineComplete !== true
        );
    } catch {
        return false;
    }
}

function checkPoolsPersisted(tokenCa, selectedPools) {
    if (!tokenCa) return false;
    try {
        const scannedData = loadScannedPools();
        const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
        if (!selectedPools || selectedPools.length === 0) {
            return pools.some((p) => p.tokenMint === tokenCa);
        }
        return selectedPools.every((sp) => {
            const addr = typeof sp === "string" ? sp : sp.poolAddress;
            return pools.some((p) => p.poolAddress === addr && p.tokenMint === tokenCa);
        });
    } catch {
        return false;
    }
}

function readSelectedScanState(tokenCa) {
    if (!tokenCa) return null;
    const selectedScanDir = path.join(
        ROOT,
        "data",
        "discovery",
        "pool-scanner",
        tokenCa,
        "selected-scan"
    );
    if (!fs.existsSync(selectedScanDir)) return null;

    try {
        const selectionPath = path.join(selectedScanDir, "selection.json");
        const scanStatePath = path.join(selectedScanDir, "scan-state.json");
        const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
        const fabriqStatePath = path.join(selectedScanDir, "fabriq-state.json");
        const tradeHistoryStatePath = path.join(selectedScanDir, "trade-history-state.json");

        const selection = fs.existsSync(selectionPath)
            ? JSON.parse(fs.readFileSync(selectionPath, "utf8"))
            : null;
        const scanState = fs.existsSync(scanStatePath)
            ? JSON.parse(fs.readFileSync(scanStatePath, "utf8"))
            : null;
        const poolWallets = fs.existsSync(poolWalletsPath)
            ? JSON.parse(fs.readFileSync(poolWalletsPath, "utf8"))
            : null;
        const fabriqState = fs.existsSync(fabriqStatePath)
            ? JSON.parse(fs.readFileSync(fabriqStatePath, "utf8"))
            : null;
        const tradeHistoryState = fs.existsSync(tradeHistoryStatePath)
            ? JSON.parse(fs.readFileSync(tradeHistoryStatePath, "utf8"))
            : null;

        const selectedPools = selection?.pools || [];
        const isPersisted = checkPoolsPersisted(tokenCa, selectedPools);

        let uniqueWallets = 0;
        if (poolWallets?.pools) {
            const walletSet = new Set();
            for (const p of poolWallets.pools) {
                for (const w of p.wallets || []) {
                    if (w.wallet) walletSet.add(w.wallet);
                }
            }
            uniqueWallets = walletSet.size;
        }

        return {
            selectedPools: selectedPools.map((p) => p.poolAddress),
            selectedPoolCount: selectedPools.length,
            completedPoolCount: scanState?.completedPoolCount ?? selectedPools.length,
            uniqueWallets: uniqueWallets || fabriqState?.totalWallets || tradeHistoryState?.totalWallets || 0,
            fabriqTotal: fabriqState?.totalWallets ?? 0,
            fabriqCompleted: fabriqState?.status === "completed" ? (fabriqState.totalWallets ?? 0) : 0,
            fabriqSuccess: fabriqState?.status === "completed" ? (fabriqState.totalWallets ?? 0) : 0,
            tradeHistoryTotalWallets: tradeHistoryState?.totalWallets ?? 0,
            tradeHistoryCompletedWallets: tradeHistoryState?.completedWallets ?? 0,
            tradeHistoryFailedWallets: tradeHistoryState?.failedWallets ?? 0,
            tradeHistoryTotalTrades: tradeHistoryState?.totalTrades ?? 0,
            tradeHistoryStatus: tradeHistoryState?.status ?? null,
            fabriqStatus: fabriqState?.status ?? null,
            scanStateStatus: scanState?.status ?? null,
            isPersisted,
        };
    } catch {
        return null;
    }
}

function poolScannerPublicState(queryToken = null) {
    // Keep the UI lock active until a stopped process tree has actually exited.
    const isRunning = Boolean(poolScannerChild) || poolScannerState.status === "running";

    const targetToken = queryToken || poolScannerState.tokenCa;
    const pState = readPoolScannerPipelineState(targetToken);
    const isResumable = !isRunning && checkPoolScannerResumable(targetToken);
    const selectedScan = readSelectedScanState(targetToken);

    const isPersisted = checkPoolsPersisted(
        targetToken,
        poolScannerState.selectedPools?.length ? poolScannerState.selectedPools : selectedScan?.selectedPools
    );

    // If a job is actively running in memory, preserve in-memory tracking
    if (isRunning || (poolScannerState.status !== "idle" && (!queryToken || queryToken === poolScannerState.tokenCa))) {
        return {
            ...poolScannerState,
            running: isRunning,
            resumable: isResumable,
            resumableTokenCa: isResumable ? targetToken : null,
            isPersisted,
            stage1Complete: pState?.stage1Complete ?? false,
            stage2Complete: pState?.stage2Complete ?? false,
            pipelineComplete: pState?.pipelineComplete ?? false,
        };
    }

    // When idle and targetToken has selected-scan artifacts, return accurate snapshot
    if (selectedScan) {
        let derivedStage = "idle";
        let derivedStatus = "idle";

        if (isPersisted) {
            derivedStage = "persisted";
            derivedStatus = "completed";
        } else if (selectedScan.tradeHistoryStatus === "completed") {
            derivedStage = "trade_history_completed";
            derivedStatus = "completed";
        } else if (selectedScan.fabriqStatus === "completed") {
            derivedStage = "fabriq_completed";
            derivedStatus = "completed";
        } else if (selectedScan.scanStateStatus === "completed") {
            derivedStage = "extract_completed";
            derivedStatus = "completed";
        }

        return {
            ...poolScannerState,
            status: derivedStatus,
            stage: derivedStage,
            tokenCa: targetToken,
            selectedPools: selectedScan.selectedPools,
            selectedPoolCount: selectedScan.selectedPoolCount,
            completedPoolCount: selectedScan.completedPoolCount,
            uniqueWallets: selectedScan.uniqueWallets,
            fabriqTotal: selectedScan.fabriqTotal,
            fabriqCompleted: selectedScan.fabriqCompleted,
            fabriqSuccess: selectedScan.fabriqSuccess,
            tradeHistoryTotalWallets: selectedScan.tradeHistoryTotalWallets,
            tradeHistoryCompletedWallets: selectedScan.tradeHistoryCompletedWallets,
            tradeHistoryFailedWallets: selectedScan.tradeHistoryFailedWallets,
            tradeHistoryTotalTrades: selectedScan.tradeHistoryTotalTrades,
            isPersisted,
            running: false,
            resumable: isResumable,
            resumableTokenCa: isResumable ? targetToken : null,
            stage1Complete: pState?.stage1Complete ?? false,
            stage2Complete: pState?.stage2Complete ?? false,
            pipelineComplete: pState?.pipelineComplete ?? false,
        };
    }

    return {
        ...poolScannerState,
        running: isRunning,
        resumable: isResumable,
        resumableTokenCa: isResumable ? targetToken : null,
        isPersisted: false,
        stage1Complete: pState?.stage1Complete ?? false,
        stage2Complete: pState?.stage2Complete ?? false,
        pipelineComplete: pState?.pipelineComplete ?? false,
    };
}


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
            const childEnv = {
                ...process.env,
                ...env,
            };
            if (!env?.FABRIQ_START_MONTH) {
                delete childEnv.FABRIQ_START_MONTH;
            }

            currentChild =
                spawn(
                    command,
                    args,
                    {
                        cwd: ROOT,
                        env: childEnv,
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

async function startPipeline({ mode, concurrency, resume, historyMode, startMonth }) {
    assertDataPipelineAvailable();

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

    if (!isResume) {
        const validatedHistory = validateHistoryConfig(historyMode, startMonth);
        state.historyMode = validatedHistory.historyMode;
        state.startMonth = validatedHistory.startMonth;
    }

    state.status = "running";
    state.stage = "enrich";
    state.mode = safeMode;
    state.concurrency = safeConcurrency;
    state.refreshBefore = refreshBefore;
    state.startedAt =
        new Date().toISOString();
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
    if (state.historyMode === "custom") {
        addLog(`[CONTROL] history=custom startMonth=${state.startMonth}`);
    } else {
        addLog("[CONTROL] history=90d");
    }
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
        if (state.historyMode === "custom" && state.startMonth) {
            enrichEnv.FABRIQ_START_MONTH = state.startMonth;
        }
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
        const childEnv = {
            ...process.env,
            ...env,
        };
        if (!env?.FABRIQ_START_MONTH) {
            delete childEnv.FABRIQ_START_MONTH;
        }

        lpAgentChild = spawn(command, args, {
            cwd: ROOT,
            env: childEnv,
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
    historyMode,
    startMonth,
} = {}) {
    assertDataPipelineAvailable();

    const safeConcurrency = sanitizeConcurrency(concurrency ?? 5);
    const safeFabriqConcurrency = sanitizeConcurrency(fabriqConcurrency ?? 10);
    const validatedHistory = validateHistoryConfig(historyMode, startMonth);

    lpAgentBaseCompletedPages = 0;
    lpAgentSavedPagesThisRun = new Set();

    lpAgentState = {
        status: "running",
        stage: "scrape",
        concurrency: safeConcurrency,
        fabriqConcurrency: safeFabriqConcurrency,
        historyMode: validatedHistory.historyMode,
        startMonth: validatedHistory.startMonth,

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
    if (lpAgentState.historyMode === "custom") {
        addLpAgentLog(`[CONTROL] history=custom startMonth=${lpAgentState.startMonth}`);
    } else {
        addLpAgentLog("[CONTROL] history=90d");
    }

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

        const enrichEnv = {
            FABRIQ_CONCURRENCY: String(safeFabriqConcurrency),
        };
        if (lpAgentState.historyMode === "custom" && lpAgentState.startMonth) {
            enrichEnv.FABRIQ_START_MONTH = lpAgentState.startMonth;
        }

        const enrichResult = await runLpAgentChildProcess(
            process.execPath,
            ["scripts/fabriq/enrich-wallets.mjs"],
            enrichEnv,
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

function addPoolScannerLog(line) {
    const cleaned = String(line).trimEnd();
    if (!cleaned) {
        return;
    }

    console.log(`[POOL_SCANNER] ${cleaned}`);

    poolScannerState.logs.push(cleaned);

    if (poolScannerState.logs.length > 200) {
        poolScannerState.logs = poolScannerState.logs.slice(-200);
    }
}

function parsePoolScannerLine(line) {
    if (line.includes("[STAGE 1/4]")) {
        poolScannerState.stage = "discovery";
        return;
    }

    if (line.includes("[RESUME]") || line.includes("[STAGE 2/4]")) {
        poolScannerState.stage = "fabriq";
        return;
    }

    if (line.includes("[STAGE 3/4]")) {
        poolScannerState.stage = "master_upsert";
        return;
    }

    if (line.includes("[STAGE 4/4]")) {
        poolScannerState.stage = "publish";
        return;
    }

    if (line.includes("POOL SCANNER PIPELINE COMPLETE")) {
        poolScannerState.status = "completed";
        poolScannerState.stage = "completed";
        return;
    }

    const currentPoolMatch = line.match(
        /\[SELECTED_SCAN\]\s+CURRENT_POOL\s+pair="([^"]+)"\s+bin=([^\s]+)\s+fee=([^\s]+)\s+addr="?([^\s"]+)"?/i
    );
    if (currentPoolMatch) {
        poolScannerState.currentPool = {
            pair: currentPoolMatch[1],
            binStep:
                currentPoolMatch[2] === "—" || currentPoolMatch[2] === "null"
                    ? null
                    : Number(currentPoolMatch[2]),
            baseFeePct:
                currentPoolMatch[3] === "—" || currentPoolMatch[3] === "null"
                    ? null
                    : Number(currentPoolMatch[3]),
            poolAddress: currentPoolMatch[4],
        };
        return;
    }

    const progressMatch = line.match(
        /\[SELECTED_SCAN\]\s+POOL_PROGRESS\s+completed=(\d+)\s+total=(\d+)\s+wallets=(\d+)/i
    );
    if (progressMatch) {
        poolScannerState.stage = "extract";
        poolScannerState.completedPoolCount = Number(progressMatch[1]);
        poolScannerState.selectedPoolCount = Number(progressMatch[2]);
        poolScannerState.uniqueWallets = Number(progressMatch[3]);
        return;
    }

    if (line.includes("[SELECTED_SCAN] COMPLETE")) {
        poolScannerState.status = "completed";
        poolScannerState.stage = "extract_completed";
        return;
    }

    const datasetMatch = line.match(/\[DATASET\]\s+(\d+)\s+total wallets/i);
    if (datasetMatch) {
        poolScannerState.fabriqTotal = parseInt(datasetMatch[1], 10);
        return;
    }

    const resumeMatch = line.match(/\[RESUME\]\s+(\d+)\/(\d+)\s+already completed/i);
    if (resumeMatch) {
        poolScannerState.fabriqSkipped = parseInt(resumeMatch[1], 10);
        poolScannerState.fabriqCompleted =
            poolScannerState.fabriqSkipped +
            poolScannerState.fabriqSuccess +
            poolScannerState.fabriqFailed;
        return;
    }

    const skipMatch = line.match(/\[W\d+\]\s+\[\d+\/\d+\]\s+SKIP/i);
    if (skipMatch) {
        poolScannerState.fabriqSkipped++;
        poolScannerState.fabriqCompleted =
            poolScannerState.fabriqSkipped +
            poolScannerState.fabriqSuccess +
            poolScannerState.fabriqFailed;
        return;
    }

    const okMatch = line.match(/\[W\d+\]\s+\[OK\]/i);
    if (okMatch) {
        poolScannerState.fabriqSuccess++;
        poolScannerState.fabriqCompleted =
            poolScannerState.fabriqSkipped +
            poolScannerState.fabriqSuccess +
            poolScannerState.fabriqFailed;
        return;
    }

    const failMatch = line.match(/\[W\d+\]\s+\[FAIL\]/i);
    if (failMatch) {
        poolScannerState.fabriqFailed++;
        poolScannerState.fabriqCompleted =
            poolScannerState.fabriqSkipped +
            poolScannerState.fabriqSuccess +
            poolScannerState.fabriqFailed;
        return;
    }

    if (line.includes("[ENRICH_SELECTED] COMPLETE")) {
        poolScannerState.status = "completed";
        poolScannerState.stage = "fabriq_completed";
        return;
    }

    const tradeProgressMatch = line.match(
        /\[TRADE_HISTORY\]\s+PROGRESS\s+completed=(\d+)\s+total=(\d+)\s+failed=(\d+)\s+trades=(\d+)/i
    );
    if (tradeProgressMatch) {
        poolScannerState.stage = "trade_history";
        poolScannerState.tradeHistoryCompletedWallets = Number(tradeProgressMatch[1]);
        poolScannerState.tradeHistoryTotalWallets = Number(tradeProgressMatch[2]);
        poolScannerState.tradeHistoryFailedWallets = Number(tradeProgressMatch[3]);
        poolScannerState.tradeHistoryTotalTrades = Number(tradeProgressMatch[4]);
        return;
    }

    if (line.includes("[TRADE_HISTORY] COMPLETE")) {
        poolScannerState.status = "completed";
        poolScannerState.stage = "trade_history_completed";
        return;
    }

    if (line.includes("STEP 3D-A PERSISTENCE COMPLETE")) {
        poolScannerState.status = "completed";
        poolScannerState.stage = "persisted";
        return;
    }
}

let poolScannerUserStopped = false;

function stopPoolScanner() {
    if (!poolScannerChild && poolScannerState.status !== "running") {
        return poolScannerPublicState();
    }

    poolScannerUserStopped = true;
    poolScannerState.status = "stopped";
    poolScannerState.stage = "stopped";
    poolScannerState.finishedAt = new Date().toISOString();
    poolScannerState.error = null;

    addPoolScannerLog("[CONTROL] Stopping Pool Scanner pipeline...");

    if (poolScannerChild) {
        const targetChild = poolScannerChild;
        const targetPid = targetChild.pid;

        function killProcessTree(sig) {
            let killedGroup = false;
            if (targetPid && process.platform !== "win32") {
                try {
                    process.kill(-targetPid, sig);
                    killedGroup = true;
                } catch {
                    // process group kill may fail if group doesn't exist
                }
            }
            if (!killedGroup) {
                try {
                    targetChild.kill(sig);
                } catch {
                    // ignore
                }
            }
        }

        killProcessTree("SIGTERM");

        setTimeout(() => {
            if (poolScannerChild === targetChild) {
                killProcessTree("SIGKILL");
            }
        }, 3000);
    }

    return poolScannerPublicState();
}

function startPoolScanner(tokenCa, fabriqWorkers = 8) {
    assertDataPipelineAvailable();
    const isResuming = checkPoolScannerResumable(tokenCa);

    poolScannerUserStopped = false;
    poolScannerState = {
        status: "running",
        stage: isResuming ? "fabriq" : "discovery",
        tokenCa,
        fabriqWorkers,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
        logs: [],
    };

    addPoolScannerLog(
        `[CONTROL] Starting Pool Scanner pipeline for token: ${tokenCa}${
            isResuming ? " (resuming from Stage 2)" : ""
        } [workers: ${fabriqWorkers}]`
    );

    poolScannerChild = spawn(
        process.execPath,
        [
            "scripts/pipeline/run-pool-scanner-pipeline.mjs",
            "--token",
            tokenCa,
            "--fabriq-workers",
            String(fabriqWorkers),
        ],
        {
            cwd: ROOT,
            env: {
                ...process.env,
            },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

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

    poolScannerChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeBuffer(stdoutBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            return;
        }

        poolScannerState.status = "error";
        poolScannerState.stage = "error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Pool Scanner process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            if (!poolScannerState.finishedAt) {
                poolScannerState.finishedAt = new Date().toISOString();
            }
            addPoolScannerLog("[CONTROL] Pool Scanner pipeline stopped.");
            return;
        }

        poolScannerState.finishedAt = new Date().toISOString();
        poolScannerState.exitCode = code;

        if (code === 0) {
            poolScannerState.status = "completed";
            poolScannerState.stage =
                poolScannerState.stage === "extract"
                    ? "extract_completed"
                    : "completed";
            poolScannerState.error = null;
            addPoolScannerLog(
                poolScannerState.stage === "extract_completed"
                    ? "[CONTROL] Selected Pool Scanner finished successfully."
                    : "[CONTROL] Pool Scanner pipeline finished successfully."
            );
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "error";
            poolScannerState.error =
                poolScannerState.error ??
                `Pool Scanner pipeline failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(
                `[CONTROL] ${poolScannerState.error}`
            );
        }
    });
}

function startSelectedPoolScanner(tokenCa, selectedPoolAddresses) {
    assertDataPipelineAvailable();

    poolScannerUserStopped = false;
    poolScannerState = {
        status: "running",
        stage: "extract",
        tokenCa,
        fabriqWorkers: 8,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
        logs: [],
        selectedPools: selectedPoolAddresses,
        selectedPoolCount: selectedPoolAddresses.length,
        completedPoolCount: 0,
        uniqueWallets: 0,
        currentPool: null,
    };

    addPoolScannerLog(
        `[CONTROL] Starting Selected Pool Scanner for token: ${tokenCa} (${selectedPoolAddresses.length} pools)`
    );

    const args = [
        "scripts/pool/scan-selected-pools.mjs",
        "--token",
        tokenCa,
    ];
    for (const poolAddr of selectedPoolAddresses) {
        args.push("--pool", poolAddr);
    }

    poolScannerChild = spawn(
        process.execPath,
        args,
        {
            cwd: ROOT,
            env: {
                ...process.env,
            },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

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

    poolScannerChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeBuffer(stdoutBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            return;
        }

        poolScannerState.status = "error";
        poolScannerState.stage = "error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Selected Pool Scanner process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            if (!poolScannerState.finishedAt) {
                poolScannerState.finishedAt = new Date().toISOString();
            }
            addPoolScannerLog("[CONTROL] Selected Pool Scanner stopped.");
            return;
        }

        poolScannerState.finishedAt = new Date().toISOString();
        poolScannerState.exitCode = code;

        if (code === 0) {
            poolScannerState.status = "completed";
            poolScannerState.stage = "extract_completed";
            poolScannerState.error = null;
            addPoolScannerLog(
                "[CONTROL] Selected Pool Scanner finished successfully."
            );
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "error";
            poolScannerState.error =
                poolScannerState.error ??
                `Selected Pool Scanner failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(
                `[CONTROL] ${poolScannerState.error}`
            );
        }
    });
}

function startSelectedWalletsEnrichment(tokenCa, fabriqWorkers = 8, limit = null) {
    assertDataPipelineAvailable();

    poolScannerUserStopped = false;
    poolScannerState = {
        ...poolScannerState,
        status: "running",
        stage: "fabriq",
        tokenCa,
        fabriqWorkers,
        fabriqLimit: limit || null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
        fabriqTotal: poolScannerState.uniqueWallets || 0,
        fabriqCompleted: 0,
        fabriqSuccess: 0,
        fabriqFailed: 0,
        fabriqSkipped: 0,
    };

    addPoolScannerLog(
        `[CONTROL] Starting Selected Wallets Fabriq Enrichment for token: ${tokenCa} [workers: ${fabriqWorkers}${
            limit ? `, limit: ${limit}` : ""
        }]`
    );

    const args = [
        "scripts/pool/enrich-selected-wallets.mjs",
        "--token",
        tokenCa,
        "--workers",
        String(fabriqWorkers),
    ];

    if (limit && Number.isInteger(limit) && limit >= 1) {
        args.push("--limit", String(limit));
    }

    poolScannerChild = spawn(
        process.execPath,
        args,
        {
            cwd: ROOT,
            env: {
                ...process.env,
            },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

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

    poolScannerChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeBuffer(stdoutBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            return;
        }

        poolScannerState.status = "error";
        poolScannerState.stage = "error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Selected Wallets Enrichment process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            if (!poolScannerState.finishedAt) {
                poolScannerState.finishedAt = new Date().toISOString();
            }
            addPoolScannerLog("[CONTROL] Selected Wallets Enrichment stopped.");
            return;
        }

        poolScannerState.finishedAt = new Date().toISOString();
        poolScannerState.exitCode = code;

        if (code === 0) {
            poolScannerState.status = "completed";
            poolScannerState.stage = "fabriq_completed";
            poolScannerState.error = null;
            addPoolScannerLog(
                "[CONTROL] Selected Wallets Fabriq Enrichment finished successfully."
            );
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "error";
            poolScannerState.error =
                poolScannerState.error ??
                `Selected Wallets Enrichment failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(
                `[CONTROL] ${poolScannerState.error}`
            );
        }
    });
}

function startPoolTradeHistory(tokenCa, workers = 2, wallet = null, limit = null) {
    assertDataPipelineAvailable();

    poolScannerUserStopped = false;
    poolScannerState = {
        ...poolScannerState,
        status: "running",
        stage: "trade_history",
        tokenCa,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
        tradeHistoryTotalWallets: poolScannerState.uniqueWallets || 0,
        tradeHistoryCompletedWallets: 0,
        tradeHistoryFailedWallets: 0,
        tradeHistoryTotalTrades: 0,
    };

    addPoolScannerLog(
        `[CONTROL] Starting Pool Trade History extraction for token: ${tokenCa} [workers: ${workers}${
            wallet ? `, wallet: ${wallet}` : ""
        }${limit ? `, limit: ${limit}` : ""}]`
    );

    const args = [
        "--experimental-strip-types",
        "scripts/pool/build-pool-trade-history.ts",
        "--token",
        tokenCa,
        "--workers",
        String(workers),
    ];

    if (wallet && typeof wallet === "string" && wallet.trim()) {
        args.push("--wallet", wallet.trim());
    }

    if (limit && Number.isInteger(limit) && limit >= 1) {
        args.push("--limit", String(limit));
    }

    poolScannerChild = spawn(
        process.execPath,
        args,
        {
            cwd: ROOT,
            env: {
                ...process.env,
            },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

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

    poolScannerChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeBuffer(stdoutBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            return;
        }

        poolScannerState.status = "error";
        poolScannerState.stage = "error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Pool Trade History process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            if (!poolScannerState.finishedAt) {
                poolScannerState.finishedAt = new Date().toISOString();
            }
            addPoolScannerLog("[CONTROL] Pool Trade History extraction stopped.");
            return;
        }

        poolScannerState.finishedAt = new Date().toISOString();
        poolScannerState.exitCode = code;

        if (code === 0) {
            if (wallet || limit) {
                poolScannerState.status = "completed";
                poolScannerState.stage = "trade_history_completed";
                poolScannerState.error = null;
                addPoolScannerLog(
                    "[CONTROL] Test trade history extraction finished successfully (partial run). Full run required to persist to Pool Insight."
                );
            } else {
                addPoolScannerLog(
                    "[CONTROL] Pool Trade History extraction finished successfully. Starting canonical persistence..."
                );
                try {
                    validateTradeHistoryArtifacts(tokenCa);
                    startCanonicalPersistence(tokenCa, true);
                } catch (persistErr) {
                    poolScannerState.status = "error";
                    poolScannerState.stage = "persistence_error";
                    poolScannerState.error =
                        persistErr instanceof Error ? persistErr.message : String(persistErr);
                    addPoolScannerLog(
                        `[CONTROL] Failed to start canonical persistence: ${poolScannerState.error}`
                    );
                }
            }
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "error";
            poolScannerState.error =
                poolScannerState.error ??
                `Pool Trade History extraction failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(
                `[CONTROL] ${poolScannerState.error}`
            );
        }
    });
}

function validateTradeHistoryArtifacts(tokenCa) {
    const selectedScanDir = path.join(
        ROOT,
        "data",
        "discovery",
        "pool-scanner",
        tokenCa,
        "selected-scan"
    );
    const selectionPath = path.join(selectedScanDir, "selection.json");
    const scanStatePath = path.join(selectedScanDir, "scan-state.json");
    const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");
    const poolTradeHistoryPath = path.join(selectedScanDir, "pool-trade-history.json");

    if (!fs.existsSync(selectionPath)) {
        throw new Error("Missing selection.json in selected-scan directory");
    }
    if (!fs.existsSync(scanStatePath)) {
        throw new Error("Missing scan-state.json in selected-scan directory");
    }
    if (!fs.existsSync(poolWalletsPath)) {
        throw new Error("Missing pool-wallets.json in selected-scan directory");
    }
    if (!fs.existsSync(poolTradeHistoryPath)) {
        throw new Error("Missing pool-trade-history.json in selected-scan directory");
    }

    const tradeHistory = JSON.parse(fs.readFileSync(poolTradeHistoryPath, "utf8"));
    if (tradeHistory.runScope !== "full" || tradeHistory.isFullDataset !== true) {
        throw new Error("pool-trade-history.json is not a full dataset. Run full trade history extraction before persisting.");
    }
    if (tradeHistory.membershipWalletCount !== tradeHistory.processedWalletCount) {
        throw new Error(`Incomplete trade history: processed ${tradeHistory.processedWalletCount} of ${tradeHistory.membershipWalletCount} wallets.`);
    }
    return true;
}

function startCanonicalPersistence(tokenCa, isChained = false) {
    if (!isChained) {
        assertDataPipelineAvailable();
    } else {
        if (Boolean(currentChild || lpAgentChild || walletIntelligenceChild || poolRefreshChild)) {
            const error = new Error("Another data pipeline is currently running");
            error.statusCode = 409;
            throw error;
        }
    }

    poolScannerUserStopped = false;
    poolScannerState = {
        ...poolScannerState,
        status: "running",
        stage: "persisting",
        tokenCa,
        startedAt: poolScannerState.startedAt || new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
    };

    addPoolScannerLog(
        `[CONTROL] Starting Canonical Persistence for token: ${tokenCa}`
    );

    const args = [
        "--experimental-strip-types",
        "scripts/pipeline/persist-pool-scanner.ts",
        "--token",
        tokenCa,
    ];

    poolScannerChild = spawn(
        process.execPath,
        args,
        {
            cwd: ROOT,
            env: {
                ...process.env,
            },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

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

    poolScannerChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeBuffer(stdoutBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
            parsePoolScannerLine(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            return;
        }

        poolScannerState.status = "error";
        poolScannerState.stage = "persistence_error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Canonical Persistence process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            parsePoolScannerLine(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;

        if (wasUserStopped) {
            poolScannerState.status = "stopped";
            poolScannerState.stage = "stopped";
            poolScannerState.error = null;
            if (!poolScannerState.finishedAt) {
                poolScannerState.finishedAt = new Date().toISOString();
            }
            addPoolScannerLog("[CONTROL] Canonical Persistence stopped.");
            return;
        }

        poolScannerState.finishedAt = new Date().toISOString();
        poolScannerState.exitCode = code;

        if (code === 0) {
            poolScannerState.status = "completed";
            poolScannerState.stage = "persisted";
            poolScannerState.error = null;
            scannedPoolsCache = null;
            scannedPoolsMtimeMs = null;
            poolMembershipCache = null;
            poolMembershipMtimeMs = null;
            poolTradesCache = null;
            poolTradesMtimeMs = null;
            addPoolScannerLog(
                "[CONTROL] Canonical Persistence finished successfully. Scanned pools published to Pool Insight."
            );
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "persistence_error";
            poolScannerState.error =
                poolScannerState.error ??
                `Canonical Persistence failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(
                `[CONTROL] ${poolScannerState.error}`
            );
        }
    });
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

// ============================================================
// POOL EXPLORER
// ============================================================

const POOL_CACHE_PATH =
    "data/pools/legacy-dlmm-pools.json";

let poolCacheMemory = null;
let poolCacheMtimeMs = null;

function loadPoolExplorerCache() {
    const stats =
        fs.statSync(
            POOL_CACHE_PATH
        );

    if (
        poolCacheMemory &&
        poolCacheMtimeMs ===
        stats.mtimeMs
    ) {
        return poolCacheMemory;
    }

    const raw =
        fs.readFileSync(
            POOL_CACHE_PATH,
            "utf8"
        );

    const parsed =
        JSON.parse(raw);

    poolCacheMemory =
        parsed;

    poolCacheMtimeMs =
        stats.mtimeMs;

    return parsed;
}

function finiteQueryNumber(
    value
) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const number =
        Number(value);

    return Number.isFinite(
        number
    )
        ? number
        : null;
}

function poolSearchText(pool) {
    return [
        pool.name,
        pool.address,

        pool.tokenX?.name,
        pool.tokenX?.symbol,
        pool.tokenX?.address,

        pool.tokenY?.name,
        pool.tokenY?.symbol,
        pool.tokenY?.address,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

function poolSortValue(
    pool,
    sortBy
) {
    switch (sortBy) {
        case "tvl":
            return pool.tvl ?? 0;

        case "volume24h":
            return (
                pool.volume?.["24h"] ??
                0
            );

        case "fees24h":
            return (
                pool.fees?.["24h"] ??
                0
            );

        case "feeTvl24h":
            return (
                pool.feeTvlRatio
                ?.["24h"] ??
                0
            );

        case "apr":
            return pool.apr ?? 0;

        case "apy":
            return pool.apy ?? 0;

        case "createdAt":
            return (
                pool.createdAt ??
                0
            );

        case "binStep":
            return (
                pool.binStep ??
                0
            );

        case "baseFeePct":
            return (
                pool.baseFeePct ??
                0
            );

        case "name":
            return (
                pool.name ??
                ""
            ).toLowerCase();

        default:
            return (
                pool.volume?.["24h"] ??
                0
            );
    }
}

function queryPoolExplorer(
    url
) {
    const cache =
        loadPoolExplorerCache();

    let pools =
        Array.isArray(
            cache.pools
        )
            ? [...cache.pools]
            : [];

    // --------------------------------------------------------
    // PAGINATION
    // --------------------------------------------------------

    const page =
        Math.max(
            1,
            Math.floor(
                finiteQueryNumber(
                    url.searchParams.get(
                        "page"
                    )
                ) ?? 1
            )
        );

    const pageSize =
        Math.min(
            100,
            Math.max(
                1,
                Math.floor(
                    finiteQueryNumber(
                        url.searchParams.get(
                            "pageSize"
                        )
                    ) ?? 50
                )
            )
        );

    // --------------------------------------------------------
    // SEARCH
    // --------------------------------------------------------

    const query =
        (
            url.searchParams.get(
                "query"
            ) ?? ""
        )
            .trim()
            .toLowerCase();

    if (query) {
        pools =
            pools.filter(
                (pool) =>
                    poolSearchText(
                        pool
                    ).includes(
                        query
                    )
            );
    }

    // --------------------------------------------------------
    // FILTERS
    // --------------------------------------------------------

    const minTvl =
        finiteQueryNumber(
            url.searchParams.get(
                "minTvl"
            )
        );

    const maxTvl =
        finiteQueryNumber(
            url.searchParams.get(
                "maxTvl"
            )
        );

    const minVolume24h =
        finiteQueryNumber(
            url.searchParams.get(
                "minVolume24h"
            )
        );

    const minFees24h =
        finiteQueryNumber(
            url.searchParams.get(
                "minFees24h"
            )
        );

    const minFeeTvl24h =
        finiteQueryNumber(
            url.searchParams.get(
                "minFeeTvl24h"
            )
        );

    const binStep =
        finiteQueryNumber(
            url.searchParams.get(
                "binStep"
            )
        );

    if (minTvl !== null) {
        pools =
            pools.filter(
                (pool) =>
                    (pool.tvl ?? 0) >=
                    minTvl
            );
    }

    if (maxTvl !== null) {
        pools =
            pools.filter(
                (pool) =>
                    (pool.tvl ?? 0) <=
                    maxTvl
            );
    }

    if (
        minVolume24h !== null
    ) {
        pools =
            pools.filter(
                (pool) =>
                    (
                        pool.volume
                        ?.["24h"] ??
                        0
                    ) >=
                    minVolume24h
            );
    }

    if (
        minFees24h !== null
    ) {
        pools =
            pools.filter(
                (pool) =>
                    (
                        pool.fees
                        ?.["24h"] ??
                        0
                    ) >=
                    minFees24h
            );
    }

    if (
        minFeeTvl24h !==
        null
    ) {
        pools =
            pools.filter(
                (pool) =>
                    (
                        pool
                            .feeTvlRatio
                        ?.["24h"] ??
                        0
                    ) >=
                    minFeeTvl24h
            );
    }

    if (binStep !== null) {
        pools =
            pools.filter(
                (pool) =>
                    pool.binStep ===
                    binStep
            );
    }

    // --------------------------------------------------------
    // SORT
    // --------------------------------------------------------

    const sortBy =
        url.searchParams.get(
            "sortBy"
        ) ??
        "volume24h";

    const sortOrder =
        (
            url.searchParams.get(
                "sortOrder"
            ) ?? "desc"
        ).toLowerCase() ===
            "asc"
            ? "asc"
            : "desc";

    pools.sort(
        (a, b) => {
            const aValue =
                poolSortValue(
                    a,
                    sortBy
                );

            const bValue =
                poolSortValue(
                    b,
                    sortBy
                );

            let comparison = 0;

            if (
                typeof aValue ===
                "string" &&
                typeof bValue ===
                "string"
            ) {
                comparison =
                    aValue.localeCompare(
                        bValue
                    );
            } else {
                comparison =
                    Number(aValue) -
                    Number(bValue);
            }

            return sortOrder ===
                "asc"
                ? comparison
                : -comparison;
        }
    );

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    const total =
        pools.length;

    const pages =
        Math.max(
            1,
            Math.ceil(
                total /
                pageSize
            )
        );

    const safePage =
        Math.min(
            page,
            pages
        );

    const start =
        (safePage - 1) *
        pageSize;

    const data =
        pools.slice(
            start,
            start +
            pageSize
        );

    return {
        generatedAt:
            cache.generatedAt ??
            null,

        total,

        page:
            safePage,

        pageSize,

        pages,

        filters: {
            query:
                query || null,

            minTvl,

            maxTvl,

            minVolume24h,

            minFees24h,

            minFeeTvl24h,

            binStep,
        },

        sort: {
            sortBy,
            sortOrder,
        },

        data,
    };
}

// ============================================================
// POOL INSIGHT CACHED LOADERS & HELPERS
// ============================================================

const SCANNED_POOLS_PATH = path.join(ROOT, "data/master/scanned-pools.json");
const POOL_MEMBERSHIP_PATH = path.join(ROOT, "data/master/pool-wallet-membership.json");
const POOL_TRADES_PATH = path.join(ROOT, "data/master/pool-trade-history.json");

let scannedPoolsCache = null;
let scannedPoolsMtimeMs = null;

let poolMembershipCache = null;
let poolMembershipMtimeMs = null;

let poolTradesCache = null;
let poolTradesMtimeMs = null;

function loadScannedPools() {
    const stats = fs.statSync(SCANNED_POOLS_PATH);
    if (scannedPoolsCache && scannedPoolsMtimeMs === stats.mtimeMs) {
        return scannedPoolsCache;
    }
    const raw = fs.readFileSync(SCANNED_POOLS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    scannedPoolsCache = parsed;
    scannedPoolsMtimeMs = stats.mtimeMs;
    return parsed;
}

function loadPoolWalletMembership() {
    const stats = fs.statSync(POOL_MEMBERSHIP_PATH);
    if (poolMembershipCache && poolMembershipMtimeMs === stats.mtimeMs) {
        return poolMembershipCache;
    }
    const raw = fs.readFileSync(POOL_MEMBERSHIP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    poolMembershipCache = parsed;
    poolMembershipMtimeMs = stats.mtimeMs;
    return parsed;
}

function loadPoolTradeHistory() {
    const stats = fs.statSync(POOL_TRADES_PATH);
    if (poolTradesCache && poolTradesMtimeMs === stats.mtimeMs) {
        return poolTradesCache;
    }
    const raw = fs.readFileSync(POOL_TRADES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    poolTradesCache = parsed;
    poolTradesMtimeMs = stats.mtimeMs;
    return parsed;
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

// One shared lock covers process lifetime, stage gaps, and stopping process trees.
let poolRefreshState = {
    poolAddress: null,
    status: "idle",
    stage: "idle",
    startedAt: null,
    completedAt: null,
    error: null,
    logs: [],
};

function poolRefreshPublicState(queryPoolAddress = null) {
    if (queryPoolAddress && poolRefreshState.poolAddress && poolRefreshState.poolAddress !== queryPoolAddress) {
        return {
            poolAddress: queryPoolAddress,
            status: "idle",
            stage: "idle",
            startedAt: null,
            completedAt: null,
            error: null,
        };
    }
    return {
        poolAddress: poolRefreshState.poolAddress,
        status: poolRefreshState.status,
        stage: poolRefreshState.stage,
        startedAt: poolRefreshState.startedAt,
        completedAt: poolRefreshState.completedAt,
        error: poolRefreshState.error,
    };
}

function startPoolRefresh(poolAddress, options = {}) {
    assertDataPipelineAvailable();

    poolRefreshState = {
        poolAddress,
        status: "running",
        stage: "starting",
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        logs: [],
    };

    const args = [
        "scripts/pool/refresh-pool.mjs",
        "--pool",
        poolAddress,
    ];

    const workers = options?.workers ?? (
        process.env.FABRIQ_CONCURRENCY
            ? parseInt(process.env.FABRIQ_CONCURRENCY, 10)
            : 8
    );

    if (workers && Number.isInteger(workers) && workers >= 1) {
        args.push("--workers", String(workers));
    }

    const childEnv = {
        ...process.env,
        ...(workers && Number.isInteger(workers) && workers >= 1
            ? { FABRIQ_CONCURRENCY: String(workers) }
            : {}),
    };

    poolRefreshChild = spawn(
        process.execPath,
        args,
        {
            cwd: ROOT,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";

    function consumeLocalBuffer(buffer, chunk, onLine) {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        const remainder = lines.pop() ?? "";
        for (const line of lines) {
            onLine(line);
        }
        return remainder;
    }

    function parseRefreshLine(line) {
        if (line.includes("[REFRESH_POOL] STAGE scanning")) {
            poolRefreshState.stage = "scanning";
        } else if (line.includes("[REFRESH_POOL] STAGE enriching")) {
            poolRefreshState.stage = "enriching";
        } else if (line.includes("[REFRESH_POOL] STAGE trade_history")) {
            poolRefreshState.stage = "trade_history";
        } else if (line.includes("[REFRESH_POOL] STAGE persisting")) {
            poolRefreshState.stage = "persisting";
        } else if (line.includes("[REFRESH_POOL] COMPLETE")) {
            poolRefreshState.stage = "completed";
            poolRefreshState.status = "completed";
            poolRefreshState.completedAt = new Date().toISOString();
        } else if (line.includes("[REFRESH_POOL] ERROR")) {
            poolRefreshState.error = line;
        }
    }

    poolRefreshChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeLocalBuffer(stdoutBuffer, chunk, (line) => {
            poolRefreshState.logs.push(line);
            if (poolRefreshState.logs.length > 200) poolRefreshState.logs = poolRefreshState.logs.slice(-200);
            parseRefreshLine(line);
        });
    });

    poolRefreshChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeLocalBuffer(stderrBuffer, chunk, (line) => {
            poolRefreshState.logs.push(line);
            if (poolRefreshState.logs.length > 200) poolRefreshState.logs = poolRefreshState.logs.slice(-200);
            parseRefreshLine(line);
        });
    });

    poolRefreshChild.on("error", (error) => {
        poolRefreshChild = null;
        poolRefreshState.status = "failed";
        poolRefreshState.stage = "failed";
        poolRefreshState.error = error instanceof Error ? error.message : String(error);
        poolRefreshState.completedAt = new Date().toISOString();
    });

    poolRefreshChild.on("exit", (code, signal) => {
        poolRefreshChild = null;
        poolRefreshState.completedAt = new Date().toISOString();
        scannedPoolsCache = null;
        poolMembershipCache = null;
        poolTradesCache = null;
        if (code === 0) {
            poolRefreshState.status = "completed";
            poolRefreshState.stage = "completed";
            poolRefreshState.error = null;
        } else {
            poolRefreshState.status = "failed";
            poolRefreshState.stage = "failed";
            if (!poolRefreshState.error) {
                poolRefreshState.error = `Pool refresh failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            }
        }
    });

    return poolRefreshPublicState();
}

// One shared lock covers process lifetime, stage gaps, and stopping process trees.
function dataPipelineBusy() {
    return Boolean(currentChild || lpAgentChild || poolScannerChild || walletIntelligenceChild || poolRefreshChild) ||
        [state, lpAgentState, poolScannerState, walletIntelligenceState, poolRefreshState]
            .some((value) => value.status === "running" || value.status === "stopping");
}

function assertDataPipelineAvailable() {
    if (dataPipelineBusy()) {
        const error = new Error("Another data pipeline is currently running");
        error.statusCode = 409;
        throw error;
    }
}

function rejectBusyDataPipeline(request, response) {
    if (!dataPipelineBusy()) return false;
    json(request, response, 409, { error: "Another data pipeline is currently running" });
    return true;
}

const WALLET_INTELLIGENCE_STAGES = [
    "historical_cohort", "quality", "risk_metrics", "risk_score", "confidence",
    "style_readiness", "style", "shortlist", "publish", "audit",
];
let walletIntelligenceState = {
    status: "idle",
    stage: "idle",
    stageStates: Object.fromEntries(WALLET_INTELLIGENCE_STAGES.map((stage) => [stage, "pending"])),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    logs: [],
};

function walletIntelligencePublicState() {
    let lastPublishedAt = null;
    try {
        const published = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend/public/data/wallet-intelligence-v1.json"), "utf8"));
        lastPublishedAt = typeof published.generatedAt === "string" ? published.generatedAt : null;
    } catch { /* No published artifact yet. */ }
    const end = walletIntelligenceState.finishedAt ? Date.parse(walletIntelligenceState.finishedAt) : Date.now();
    return {
        ...walletIntelligenceState,
        lastPublishedAt,
        running: Boolean(walletIntelligenceChild) || ["running", "stopping"].includes(walletIntelligenceState.status),
        runtimeSeconds: walletIntelligenceState.startedAt
            ? Math.max(0, Math.floor((end - Date.parse(walletIntelligenceState.startedAt)) / 1000)) : 0,
    };
}

function addWalletIntelligenceLog(line) {
    walletIntelligenceState.logs.push(line);
    if (walletIntelligenceState.logs.length > 2000) walletIntelligenceState.logs.shift();
    if (!line.startsWith("[WALLET_INTELLIGENCE] ") || walletIntelligenceState.status === "stopping") return;
    try {
        const event = JSON.parse(line.slice("[WALLET_INTELLIGENCE] ".length));
        if (!WALLET_INTELLIGENCE_STAGES.includes(event.stage)) return;
        if (!["running", "completed", "error"].includes(event.status)) return;
        walletIntelligenceState.stage = event.stage;
        walletIntelligenceState.stageStates[event.stage] = event.status;
        if (event.status === "error") walletIntelligenceState.error = event.error || `${event.stage} failed`;
    } catch { /* Ordinary logs cannot change control state. */ }
}

function startWalletIntelligencePipeline() {
    assertDataPipelineAvailable();
    walletIntelligenceState = {
        status: "running", stage: "historical_cohort",
        stageStates: Object.fromEntries(WALLET_INTELLIGENCE_STAGES.map((stage) => [stage, "pending"])),
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null, logs: [],
    };
    addWalletIntelligenceLog("[CONTROL] Starting Wallet Intelligence V1 pipeline.");
    const child = spawn(process.execPath, ["scripts/v1/run-wallet-intelligence-pipeline.mjs"], {
        cwd: ROOT, env: { ...process.env }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    walletIntelligenceChild = child;
    const buffers = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"]) {
        child[stream].on("data", (chunk) => {
            buffers[stream] += String(chunk);
            const lines = buffers[stream].split("\n");
            buffers[stream] = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) addWalletIntelligenceLog(line.trimEnd());
        });
    }
    child.on("error", (error) => {
        walletIntelligenceState.error = error.message;
        addWalletIntelligenceLog(`[CONTROL] Process error: ${error.message}`);
        // Retain the lock until close confirms that the child and streams ended.
    });
    child.on("close", (code, signal) => {
        for (const stream of ["stdout", "stderr"]) if (buffers[stream].trim()) addWalletIntelligenceLog(buffers[stream].trimEnd());
        const stopped = walletIntelligenceState.status === "stopping";
        const audited = walletIntelligenceState.stageStates.audit === "completed";
        const successful = !stopped && !walletIntelligenceState.error && code === 0 && audited;
        walletIntelligenceState.status = stopped ? "stopped" : successful ? "completed" : "error";
        for (const stage of WALLET_INTELLIGENCE_STAGES) {
            if (walletIntelligenceState.stageStates[stage] === "running") {
                walletIntelligenceState.stageStates[stage] = stopped ? "stopped" : "error";
            }
        }
        if (!stopped && !successful && !walletIntelligenceState.error) {
            walletIntelligenceState.error = code === 0 && !audited
                ? "Pipeline exited without a successful final audit"
                : `Pipeline failed (${signal || `exit ${code}`})`;
        }
        if (stopped) walletIntelligenceState.error = null;
        walletIntelligenceState.stage = stopped ? "stopped" : successful ? "completed" : "error";
        walletIntelligenceState.exitCode = code;
        walletIntelligenceState.finishedAt = new Date().toISOString();
        walletIntelligenceChild = null;
        addWalletIntelligenceLog(`[CONTROL] Wallet Intelligence ${walletIntelligenceState.status}.`);
    });
}

function stopWalletIntelligencePipeline() {
    if (!walletIntelligenceChild || walletIntelligenceState.status === "stopping") return false;
    walletIntelligenceState.status = "stopping";
    const child = walletIntelligenceChild;
    const pid = child.pid;
    const killTree = (signal) => {
        if (pid && process.platform !== "win32") {
            try { process.kill(-pid, signal); return; } catch { /* Fall back to child. */ }
        }
        try { child.kill(signal); } catch { /* Already exited. */ }
    };
    addWalletIntelligenceLog("[CONTROL] Stopping Wallet Intelligence; generated artifacts are preserved.");
    killTree("SIGTERM");
    const timer = setTimeout(() => {
        if (walletIntelligenceChild === child) killTree("SIGKILL");
    }, 3000);
    timer.unref();
    return true;
}

const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
        setCors(request, response);
        response.writeHead(204);
        response.end();
        return;
    }

    const url = new URL(request.url, `http://${HOST}:${PORT}`);

    if (request.method === "GET" && url.pathname === "/api/wallet-intelligence/status") {
        json(request, response, 200, walletIntelligencePublicState());
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/wallet-intelligence/start") {
        if (rejectBusyDataPipeline(request, response)) return;
        try {
            startWalletIntelligencePipeline();
            json(request, response, 202, walletIntelligencePublicState());
        } catch (error) {
            json(request, response, error.statusCode || 500, { error: error.message });
        }
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/wallet-intelligence/stop") {
        const stopped = stopWalletIntelligencePipeline();
        json(request, response, stopped ? 202 : 409, {
            ...walletIntelligencePublicState(),
            ...(stopped ? {} : { error: "Wallet Intelligence is not running or is already stopping" }),
        });
        return;
    }


    // ------------------------------------------------------
    // GET /api/pools
    // ------------------------------------------------------

    if (
        request.method === "GET" &&
        url.pathname ===
        "/api/pools"
    ) {
        try {
            const result =
                queryPoolExplorer(
                    url
                );

            json(
                request,
                response,
                200,
                result
            );
        } catch (error) {
            console.error(
                "[POOLS] Failed:",
                error
            );

            json(
                request,
                response,
                500,
                {
                    error:
                        "Failed to load Pool Explorer cache",
                }
            );
        }

        return;
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools
    // ------------------------------------------------------

    if (
        request.method === "GET" &&
        (url.pathname === "/api/pool-insight/pools" || url.pathname === "/api/pool-insight/pools/")
    ) {
        try {
            const scannedData = loadScannedPools();
            const rawPools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
            const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();

            let pools = rawPools;
            if (search) {
                pools = rawPools.filter((p) => {
                    const pair = (p?.pair ?? "").toLowerCase();
                    const poolAddress = (p?.poolAddress ?? "").toLowerCase();
                    const tokenMint = (p?.tokenMint ?? "").toLowerCase();
                    return pair.includes(search) || poolAddress.includes(search) || tokenMint.includes(search);
                });
            }

            json(request, response, 200, {
                updatedAt: scannedData?.updatedAt ?? null,
                total: pools.length,
                pools,
            });
        } catch (error) {
            console.error("[POOL INSIGHT] Error loading pools:", error.message);
            json(request, response, 500, { error: "Failed to read scanned pools data" });
        }

        return;
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools/:poolAddress/wallets/:wallet/trades
    // ------------------------------------------------------

    if (request.method === "GET") {
        const matchWalletTrades = url.pathname.match(
            /^\/api\/pool-insight\/pools\/([^/]+)\/wallets\/([^/]+)\/trades\/?$/
        );

        if (matchWalletTrades) {
            const poolAddress = safeDecodeURIComponent(matchWalletTrades[1]);
            const wallet = safeDecodeURIComponent(matchWalletTrades[2]);

            if (poolAddress === null || wallet === null) {
                json(request, response, 400, { error: "Malformed URL path encoding" });
                return;
            }

            if (!poolAddress.trim() || !wallet.trim()) {
                json(request, response, 400, { error: "Invalid pool address or wallet" });
                return;
            }

            try {
                // 1. Verify pool exists in scanned-pools.json
                const scannedData = loadScannedPools();
                const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
                const poolExists = pools.some((p) => p?.poolAddress === poolAddress);
                if (!poolExists) {
                    json(request, response, 404, { error: "Pool not found" });
                    return;
                }

                // 2. Verify wallet exists in pool-wallet-membership for this pool
                const membershipData = loadPoolWalletMembership();
                const memberships = Array.isArray(membershipData?.memberships) ? membershipData.memberships : [];
                const walletExistsInPool = memberships.some(
                    (m) => m?.poolAddress === poolAddress && m?.wallet === wallet
                );
                if (!walletExistsInPool) {
                    json(request, response, 404, { error: "Wallet not found in pool" });
                    return;
                }

                // 3. Load trade history
                const tradesData = loadPoolTradeHistory();
                const rawTrades = Array.isArray(tradesData?.trades) ? tradesData.trades : [];
                const poolWalletTrades = rawTrades.filter(
                    (t) => t?.poolAddress === poolAddress && t?.wallet === wallet
                );

                // 4. Default ordering: closedAt descending, then positionId ascending
                const trades = [...poolWalletTrades].sort((a, b) => {
                    const aClosed = a?.closedAt ? Date.parse(a.closedAt) : 0;
                    const bClosed = b?.closedAt ? Date.parse(b.closedAt) : 0;
                    const aTime = Number.isFinite(aClosed) ? aClosed : 0;
                    const bTime = Number.isFinite(bClosed) ? bClosed : 0;

                    if (aTime !== bTime) {
                        return bTime - aTime;
                    }

                    return (a?.positionId ?? "").localeCompare(b?.positionId ?? "");
                });

                json(request, response, 200, {
                    poolAddress,
                    wallet,
                    total: trades.length,
                    trades,
                });
            } catch (error) {
                console.error("[POOL INSIGHT] Error loading wallet trades:", error.message);
                json(request, response, 500, { error: "Failed to read pool trade history data" });
            }

            return;
        }
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools/:poolAddress/wallets
    // ------------------------------------------------------

    if (request.method === "GET") {
        const matchPoolWallets = url.pathname.match(
            /^\/api\/pool-insight\/pools\/([^/]+)\/wallets\/?$/
        );

        if (matchPoolWallets) {
            const poolAddress = safeDecodeURIComponent(matchPoolWallets[1]);

            if (poolAddress === null) {
                json(request, response, 400, { error: "Malformed URL path encoding" });
                return;
            }

            if (!poolAddress.trim()) {
                json(request, response, 400, { error: "Invalid pool address" });
                return;
            }

            try {
                // 1. Verify pool exists in scanned-pools.json
                const scannedData = loadScannedPools();
                const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
                const poolExists = pools.some((p) => p?.poolAddress === poolAddress);
                if (!poolExists) {
                    json(request, response, 404, { error: "Pool not found" });
                    return;
                }

                // 2. Load pool wallet membership
                const membershipData = loadPoolWalletMembership();
                const rawMemberships = Array.isArray(membershipData?.memberships) ? membershipData.memberships : [];
                const poolMemberships = rawMemberships.filter((m) => m?.poolAddress === poolAddress);

                // 3. Sorting
                const ALLOWED_WALLET_SORT_KEYS = new Set(["pnlUsd", "winRate", "positions", "tradeCount"]);
                const rawSortBy = url.searchParams.get("sortBy");
                const sortBy = (rawSortBy && ALLOWED_WALLET_SORT_KEYS.has(rawSortBy.trim()))
                    ? rawSortBy.trim()
                    : "pnlUsd";

                const rawSortOrder = (url.searchParams.get("sortOrder") ?? "desc").toLowerCase();
                const sortOrder = rawSortOrder === "asc" ? "asc" : "desc";

                const wallets = [...poolMemberships].sort((a, b) => {
                    const aVal = a?.[sortBy];
                    const bVal = b?.[sortBy];

                    // Nulls handled deterministically: placed at end
                    if (aVal === null || aVal === undefined) {
                        if (bVal === null || bVal === undefined) {
                            return (a?.wallet ?? "").localeCompare(b?.wallet ?? "");
                        }
                        return 1;
                    }
                    if (bVal === null || bVal === undefined) {
                        return -1;
                    }

                    const diff = Number(aVal) - Number(bVal);
                    if (diff !== 0) {
                        return sortOrder === "asc" ? diff : -diff;
                    }

                    // Deterministic owner/wallet tie-break
                    return (a?.wallet ?? "").localeCompare(b?.wallet ?? "");
                });

                json(request, response, 200, {
                    poolAddress,
                    updatedAt: membershipData?.updatedAt ?? null,
                    total: wallets.length,
                    wallets,
                });
            } catch (error) {
                console.error("[POOL INSIGHT] Error loading pool wallets:", error.message);
                json(request, response, 500, { error: "Failed to read pool membership data" });
            }

            return;
        }
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools/:poolAddress/trade-filter
    // ------------------------------------------------------

    if (request.method === "GET") {
        const matchTradeFilter = url.pathname.match(
            /^\/api\/pool-insight\/pools\/([^/]+)\/trade-filter\/?$/
        );

        if (matchTradeFilter) {
            const poolAddress = safeDecodeURIComponent(matchTradeFilter[1]);

            if (poolAddress === null) {
                json(request, response, 400, { error: "Malformed URL path encoding" });
                return;
            }

            if (!poolAddress.trim()) {
                json(request, response, 400, { error: "Invalid pool address" });
                return;
            }

            // Parse and validate query parameters
            function parseQueryNumber(paramName) {
                const raw = url.searchParams.get(paramName);
                if (raw === null || raw === undefined || raw.trim() === "") {
                    return undefined;
                }
                const trimmed = raw.trim();
                const num = Number(trimmed);
                if (!Number.isFinite(num)) {
                    return { error: `Query parameter '${paramName}' must be a finite number` };
                }
                return num;
            }

            const minDurationRes = parseQueryNumber("minDurationSeconds");
            if (typeof minDurationRes === "object" && minDurationRes.error) {
                json(request, response, 400, { error: minDurationRes.error });
                return;
            }
            const minDurationSeconds = minDurationRes;

            const maxDurationRes = parseQueryNumber("maxDurationSeconds");
            if (typeof maxDurationRes === "object" && maxDurationRes.error) {
                json(request, response, 400, { error: maxDurationRes.error });
                return;
            }
            const maxDurationSeconds = maxDurationRes;

            const minPnlUsdRes = parseQueryNumber("minPnlUsd");
            if (typeof minPnlUsdRes === "object" && minPnlUsdRes.error) {
                json(request, response, 400, { error: minPnlUsdRes.error });
                return;
            }
            const minPnlUsd = minPnlUsdRes;

            const maxPnlUsdRes = parseQueryNumber("maxPnlUsd");
            if (typeof maxPnlUsdRes === "object" && maxPnlUsdRes.error) {
                json(request, response, 400, { error: maxPnlUsdRes.error });
                return;
            }
            const maxPnlUsd = maxPnlUsdRes;

            const minPnlPctRes = parseQueryNumber("minPnlPct");
            if (typeof minPnlPctRes === "object" && minPnlPctRes.error) {
                json(request, response, 400, { error: minPnlPctRes.error });
                return;
            }
            const minPnlPct = minPnlPctRes;

            const maxPnlPctRes = parseQueryNumber("maxPnlPct");
            if (typeof maxPnlPctRes === "object" && maxPnlPctRes.error) {
                json(request, response, 400, { error: maxPnlPctRes.error });
                return;
            }
            const maxPnlPct = maxPnlPctRes;

            // Validate duration bounds
            if (minDurationSeconds !== undefined && minDurationSeconds < 0) {
                json(request, response, 400, { error: "minDurationSeconds must not be negative" });
                return;
            }
            if (maxDurationSeconds !== undefined && maxDurationSeconds < 0) {
                json(request, response, 400, { error: "maxDurationSeconds must not be negative" });
                return;
            }
            if (minDurationSeconds !== undefined && maxDurationSeconds !== undefined && minDurationSeconds > maxDurationSeconds) {
                json(request, response, 400, { error: "minDurationSeconds cannot be greater than maxDurationSeconds" });
                return;
            }

            // Validate PnL USD bounds
            if (minPnlUsd !== undefined && maxPnlUsd !== undefined && minPnlUsd > maxPnlUsd) {
                json(request, response, 400, { error: "minPnlUsd cannot be greater than maxPnlUsd" });
                return;
            }

            // Validate PnL % bounds
            if (minPnlPct !== undefined && maxPnlPct !== undefined && minPnlPct > maxPnlPct) {
                json(request, response, 400, { error: "minPnlPct cannot be greater than maxPnlPct" });
                return;
            }

            try {
                // 1. Verify pool exists in scanned-pools.json
                const scannedData = loadScannedPools();
                const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
                const poolExists = pools.some((p) => p?.poolAddress === poolAddress);
                if (!poolExists) {
                    json(request, response, 404, { error: "Pool not found" });
                    return;
                }

                // 2. Load trade history
                const tradesData = loadPoolTradeHistory();
                const rawTrades = Array.isArray(tradesData?.trades) ? tradesData.trades : [];
                const poolTrades = rawTrades.filter((t) => t?.poolAddress === poolAddress);
                const totalPoolTrades = poolTrades.length;

                // 3. Filter trades
                const hasDurationFilter = minDurationSeconds !== undefined || maxDurationSeconds !== undefined;
                const hasPnlUsdFilter = minPnlUsd !== undefined || maxPnlUsd !== undefined;
                const hasPnlPctFilter = minPnlPct !== undefined || maxPnlPct !== undefined;

                const matchedTrades = poolTrades.filter((trade) => {
                    if (hasDurationFilter) {
                        const d = trade?.durationSeconds;
                        if (typeof d !== "number" || !Number.isFinite(d)) {
                            return false;
                        }
                        if (minDurationSeconds !== undefined && d < minDurationSeconds) {
                            return false;
                        }
                        if (maxDurationSeconds !== undefined && d > maxDurationSeconds) {
                            return false;
                        }
                    }

                    if (hasPnlUsdFilter) {
                        const pnl = trade?.pnlUsd;
                        if (typeof pnl !== "number" || !Number.isFinite(pnl)) {
                            return false;
                        }
                        if (minPnlUsd !== undefined && pnl < minPnlUsd) {
                            return false;
                        }
                        if (maxPnlUsd !== undefined && pnl > maxPnlUsd) {
                            return false;
                        }
                    }

                    if (hasPnlPctFilter) {
                        const pct = trade?.pnlPct;
                        if (typeof pct !== "number" || !Number.isFinite(pct)) {
                            return false;
                        }
                        if (minPnlPct !== undefined && pct < minPnlPct) {
                            return false;
                        }
                        if (maxPnlPct !== undefined && pct > maxPnlPct) {
                            return false;
                        }
                    }

                    return true;
                });

                // 4. Group by wallet preserving canonical trade order within each wallet
                const walletMap = new Map();
                for (const trade of matchedTrades) {
                    const w = trade?.wallet;
                    if (!w) continue;
                    let entry = walletMap.get(w);
                    if (!entry) {
                        entry = {
                            wallet: w,
                            matchedTradeCount: 0,
                            trades: [],
                        };
                        walletMap.set(w, entry);
                    }
                    entry.matchedTradeCount += 1;
                    entry.trades.push({
                        positionId: trade.positionId,
                        openedAt: trade.openedAt,
                        closedAt: trade.closedAt,
                        durationSeconds: trade.durationSeconds,
                        pnlUsd: trade.pnlUsd,
                        pnlPct: trade.pnlPct,
                    });
                }

                // 5. Sort wallets by matchedTradeCount descending, tie-break deterministically by wallet address
                const wallets = Array.from(walletMap.values()).sort((a, b) => {
                    if (b.matchedTradeCount !== a.matchedTradeCount) {
                        return b.matchedTradeCount - a.matchedTradeCount;
                    }
                    return a.wallet.localeCompare(b.wallet);
                });

                json(request, response, 200, {
                    poolAddress,
                    filters: {
                        minDurationSeconds: minDurationSeconds ?? null,
                        maxDurationSeconds: maxDurationSeconds ?? null,
                        minPnlUsd: minPnlUsd ?? null,
                        maxPnlUsd: maxPnlUsd ?? null,
                        minPnlPct: minPnlPct ?? null,
                        maxPnlPct: maxPnlPct ?? null,
                    },
                    totalPoolTrades,
                    matchedTradeCount: matchedTrades.length,
                    matchedWalletCount: wallets.length,
                    wallets,
                });
            } catch (error) {
                console.error("[POOL INSIGHT] Error filtering trades:", error.message);
                json(request, response, 500, { error: "Failed to read pool trade history data" });
            }

            return;
        }
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools/:poolAddress
    // ------------------------------------------------------
    // ------------------------------------------------------
    // POST /api/pool-insight/pools/:poolAddress/refresh
    // ------------------------------------------------------

    if (request.method === "POST") {
        const matchRefresh = url.pathname.match(
            /^\/api\/pool-insight\/pools\/([^/]+)\/refresh\/?$/
        );

        if (matchRefresh) {
            const poolAddress = safeDecodeURIComponent(matchRefresh[1]);

            if (!poolAddress || !poolAddress.trim()) {
                json(request, response, 400, { error: "Invalid pool address" });
                return;
            }

            let scannedData;
            try {
                scannedData = loadScannedPools();
            } catch (err) {
                json(request, response, 500, { error: "Failed to read scanned pools data" });
                return;
            }

            const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
            const canonicalPool = pools.find((p) => p?.poolAddress === poolAddress);
            if (!canonicalPool) {
                json(request, response, 404, { error: `Pool ${poolAddress} not found in canonical registry` });
                return;
            }

            if (rejectBusyDataPipeline(request, response)) {
                return;
            }

            try {
                const queryWorkers = url.searchParams.get("workers");
                const parsedWorkers = queryWorkers ? parseInt(queryWorkers, 10) : null;
                const options = {};
                if (parsedWorkers && Number.isInteger(parsedWorkers) && parsedWorkers >= 1) {
                    options.workers = parsedWorkers;
                }
                const jobState = startPoolRefresh(poolAddress, options);
                json(request, response, 202, jobState);
            } catch (err) {
                json(request, response, 500, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            return;
        }
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools/:poolAddress/refresh/status
    // ------------------------------------------------------

    if (request.method === "GET") {
        const matchRefreshStatus = url.pathname.match(
            /^\/api\/pool-insight\/pools\/([^/]+)\/refresh\/status\/?$/
        );

        if (matchRefreshStatus) {
            const poolAddress = safeDecodeURIComponent(matchRefreshStatus[1]);

            if (!poolAddress || !poolAddress.trim()) {
                json(request, response, 400, { error: "Invalid pool address" });
                return;
            }

            json(request, response, 200, poolRefreshPublicState(poolAddress));
            return;
        }
    }

    // ------------------------------------------------------
    // GET /api/pool-insight/pools/:poolAddress
    // ------------------------------------------------------
    if (request.method === "GET") {
        const matchPoolDetail = url.pathname.match(
            /^\/api\/pool-insight\/pools\/([^/]+)\/?$/
        );

        if (matchPoolDetail) {
            const poolAddress = safeDecodeURIComponent(matchPoolDetail[1]);

            if (poolAddress === null) {
                json(request, response, 400, { error: "Malformed URL path encoding" });
                return;
            }

            if (!poolAddress.trim()) {
                json(request, response, 400, { error: "Invalid pool address" });
                return;
            }

            try {
                const scannedData = loadScannedPools();
                const pools = Array.isArray(scannedData?.pools) ? scannedData.pools : [];
                const pool = pools.find((p) => p?.poolAddress === poolAddress);

                if (!pool) {
                    json(request, response, 404, { error: "Pool not found" });
                    return;
                }

                json(request, response, 200, { pool });
            } catch (error) {
                console.error("[POOL INSIGHT] Error loading pool detail:", error.message);
                json(request, response, 500, { error: "Failed to read scanned pools data" });
            }

            return;
        }
    }

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
        if (dataPipelineBusy()) {
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

        let validatedHistory;
        try {
            validatedHistory = validateHistoryConfig(
                body.historyMode,
                body.startMonth
            );
        } catch (error) {
            json(
                request,
                response,
                400,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                }
            );
            return;
        }

        if (rejectBusyDataPipeline(request, response)) return;

        startLpAgentRefresh({
            concurrency:
                body.concurrency,
            fabriqConcurrency:
                body.fabriqConcurrency,
            historyMode:
                validatedHistory.historyMode,
            startMonth:
                validatedHistory.startMonth,
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
    // GET /api/pool-scanner/status
    // ------------------------------------------------------

    if (
        request.method === "GET" &&
        url.pathname === "/api/pool-scanner/status"
    ) {
        const queryToken = url.searchParams.get("token")?.trim() || null;
        json(
            request,
            response,
            200,
            poolScannerPublicState(queryToken),
        );

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/discover
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/discover"
    ) {
        let body = {};

        try {
            body = await readJson(request);
        } catch {
            json(
                request,
                response,
                400,
                {
                    error: "Invalid JSON body",
                },
            );

            return;
        }

        const rawToken = body?.tokenCa;

        if (
            typeof rawToken !== "string" ||
            !rawToken.trim()
        ) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a non-empty string",
                },
            );

            return;
        }

        const tokenCa = rawToken.trim();

        if (tokenCa.length < 32 || tokenCa.length > 50) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a valid Solana address (32-50 characters)",
                },
            );

            return;
        }

        try {
            const discoveryResult = await discoverTokenPools(tokenCa);
            json(
                request,
                response,
                200,
                discoveryResult,
            );
        } catch (error) {
            json(
                request,
                response,
                502,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
        }

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/scan-selected
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/scan-selected"
    ) {
        if (dataPipelineBusy()) {
            json(
                request,
                response,
                409,
                {
                    error:
                        "Another update process is already running",

                    poolScanner:
                        poolScannerPublicState(),

                    fabriq:
                        publicState(),

                    lpagent:
                        lpAgentPublicState(),
                },
            );

            return;
        }

        let body = {};

        try {
            body = await readJson(request);
        } catch {
            json(
                request,
                response,
                400,
                {
                    error: "Invalid JSON body",
                },
            );

            return;
        }

        const rawToken = body?.tokenCa;

        if (
            typeof rawToken !== "string" ||
            !rawToken.trim()
        ) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a non-empty string",
                },
            );

            return;
        }

        const tokenCa = rawToken.trim();

        if (tokenCa.length < 32 || tokenCa.length > 50) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a valid Solana address (32-50 characters)",
                },
            );

            return;
        }

        const rawPoolAddresses = body?.poolAddresses;
        if (!Array.isArray(rawPoolAddresses) || rawPoolAddresses.length === 0) {
            json(
                request,
                response,
                400,
                {
                    error: "poolAddresses must be a non-empty array of pool address strings",
                },
            );

            return;
        }

        for (const p of rawPoolAddresses) {
            if (typeof p !== "string" || !p.trim()) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "All pool addresses must be non-empty strings",
                    },
                );

                return;
            }
        }

        const selectedAddresses = [...new Set(rawPoolAddresses.map((p) => p.trim()))];
        if (selectedAddresses.length === 0) {
            json(
                request,
                response,
                400,
                {
                    error: "At least one pool address is required",
                },
            );

            return;
        }

        if (rejectBusyDataPipeline(request, response)) return;

        let discoveryResult;
        try {
            discoveryResult = await discoverTokenPools(tokenCa);
        } catch (err) {
            json(
                request,
                response,
                502,
                {
                    error: `Pool discovery failed: ${err instanceof Error ? err.message : String(err)}`,
                },
            );

            return;
        }

        const discoveredMap = new Map((discoveryResult?.pools ?? []).map((p) => [p.poolAddress, p]));

        for (const addr of selectedAddresses) {
            if (!discoveredMap.has(addr)) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: `Invalid pool address: ${addr} does not belong to discovered TOKEN/SOL pools for token ${tokenCa}`,
                    },
                );

                return;
            }
        }

        try {
            startSelectedPoolScanner(tokenCa, selectedAddresses);
            json(
                request,
                response,
                202,
                poolScannerPublicState(),
            );
        } catch (error) {
            json(
                request,
                response,
                500,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
        }

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/enrich-selected
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/enrich-selected"
    ) {
        if (dataPipelineBusy()) {
            json(
                request,
                response,
                409,
                {
                    error:
                        "Another update process is already running",

                    poolScanner:
                        poolScannerPublicState(),

                    fabriq:
                        publicState(),

                    lpagent:
                        lpAgentPublicState(),
                },
            );

            return;
        }

        let body = {};

        try {
            body = await readJson(request);
        } catch {
            json(
                request,
                response,
                400,
                {
                    error: "Invalid JSON body",
                },
            );

            return;
        }

        const rawToken = body?.tokenCa;

        if (
            typeof rawToken !== "string" ||
            !rawToken.trim()
        ) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a non-empty string",
                },
            );

            return;
        }

        const tokenCa = rawToken.trim();

        if (tokenCa.length < 32 || tokenCa.length > 50) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a valid Solana address (32-50 characters)",
                },
            );

            return;
        }

        let fabriqWorkers = 8;
        if (body?.fabriqWorkers !== undefined && body?.fabriqWorkers !== null) {
            const rawVal = body.fabriqWorkers;
            const strVal = String(rawVal).trim();
            const isValid =
                (typeof rawVal === "number" && Number.isInteger(rawVal) && rawVal >= 1) ||
                (typeof rawVal === "string" && /^[1-9]\d*$/.test(strVal));

            if (!isValid) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "fabriqWorkers must be an integer >= 1",
                    },
                );

                return;
            }
            fabriqWorkers = Math.min(50, Number(strVal));
        }

        let limit = null;
        if (body?.limit !== undefined && body?.limit !== null) {
            const rawLimit = body.limit;
            const strLimit = String(rawLimit).trim();
            const isValid =
                (typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 1) ||
                (typeof rawLimit === "string" && /^[1-9]\d*$/.test(strLimit));

            if (!isValid) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "limit must be an integer >= 1",
                    },
                );

                return;
            }
            limit = Number(strLimit);
        }

        if (rejectBusyDataPipeline(request, response)) return;

        const selectedScanDir = path.join(
            ROOT,
            "data",
            "discovery",
            "pool-scanner",
            tokenCa,
            "selected-scan"
        );
        const statePath = path.join(selectedScanDir, "scan-state.json");
        const walletsPath = path.join(selectedScanDir, "wallets.json");

        if (!fs.existsSync(statePath) || !fs.existsSync(walletsPath)) {
            json(
                request,
                response,
                400,
                {
                    error: "Selected pool scan must be completed before Fabriq enrichment. Please run Step 3B first.",
                },
            );

            return;
        }

        try {
            const scanState = JSON.parse(fs.readFileSync(statePath, "utf8"));
            if (scanState.status !== "completed") {
                json(
                    request,
                    response,
                    400,
                    {
                        error: `Selected pool scan is not completed (current status: ${scanState.status}).`,
                    },
                );

                return;
            }
        } catch (err) {
            json(
                request,
                response,
                400,
                {
                    error: `Invalid scan-state.json in selected-scan: ${err instanceof Error ? err.message : String(err)}`,
                },
            );

            return;
        }

        try {
            startSelectedWalletsEnrichment(tokenCa, fabriqWorkers, limit);
            json(
                request,
                response,
                202,
                poolScannerPublicState(),
            );
        } catch (error) {
            json(
                request,
                response,
                500,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
        }

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/trade-history
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/trade-history"
    ) {
        if (dataPipelineBusy()) {
            json(
                request,
                response,
                409,
                {
                    error:
                        "Another update process is already running",

                    poolScanner:
                        poolScannerPublicState(),

                    fabriq:
                        publicState(),

                    lpagent:
                        lpAgentPublicState(),
                },
            );

            return;
        }

        let body = {};

        try {
            body = await readJson(request);
        } catch {
            json(
                request,
                response,
                400,
                {
                    error: "Invalid JSON body",
                },
            );

            return;
        }

        const rawToken = body?.tokenCa;

        if (
            typeof rawToken !== "string" ||
            !rawToken.trim()
        ) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a non-empty string",
                },
            );

            return;
        }

        const tokenCa = rawToken.trim();

        if (tokenCa.length < 32 || tokenCa.length > 50) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a valid Solana address (32-50 characters)",
                },
            );

            return;
        }

        let workers = 2;
        if (body?.workers !== undefined && body?.workers !== null) {
            const rawVal = body.workers;
            const strVal = String(rawVal).trim();
            const isValid =
                (typeof rawVal === "number" && Number.isInteger(rawVal) && rawVal >= 1) ||
                (typeof rawVal === "string" && /^[1-9]\d*$/.test(strVal));

            if (!isValid) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "workers must be an integer >= 1",
                    },
                );

                return;
            }
            workers = Math.min(20, Math.max(1, Number(strVal)));
        }

        let wallet = null;
        if (body?.wallet !== undefined && body?.wallet !== null) {
            if (typeof body.wallet !== "string" || !body.wallet.trim()) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "wallet must be a non-empty string if provided",
                    },
                );

                return;
            }
            wallet = body.wallet.trim();
        }

        let limit = null;
        if (body?.limit !== undefined && body?.limit !== null) {
            const rawLimit = body.limit;
            const strLimit = String(rawLimit).trim();
            const isValid =
                (typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 1) ||
                (typeof rawLimit === "string" && /^[1-9]\d*$/.test(strLimit));

            if (!isValid) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "limit must be an integer >= 1",
                    },
                );

                return;
            }
            limit = Number(strLimit);
        }

        if (rejectBusyDataPipeline(request, response)) return;

        const selectedScanDir = path.join(
            ROOT,
            "data",
            "discovery",
            "pool-scanner",
            tokenCa,
            "selected-scan"
        );
        const statePath = path.join(selectedScanDir, "scan-state.json");
        const poolWalletsPath = path.join(selectedScanDir, "pool-wallets.json");

        if (!fs.existsSync(statePath) || !fs.existsSync(poolWalletsPath)) {
            json(
                request,
                response,
                400,
                {
                    error: "Selected pool scan artifacts (scan-state.json, pool-wallets.json) not found. Please complete Step 3B first.",
                },
            );

            return;
        }

        try {
            const scanState = JSON.parse(fs.readFileSync(statePath, "utf8"));
            if (scanState.status !== "completed") {
                json(
                    request,
                    response,
                    400,
                    {
                        error: `Selected pool scan is not completed (current status: ${scanState.status}).`,
                    },
                );

                return;
            }
            if (!scanState.selectionFingerprint || typeof scanState.selectionFingerprint !== "string") {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "selectionFingerprint missing or invalid in scan-state.json.",
                    },
                );

                return;
            }
        } catch (err) {
            json(
                request,
                response,
                400,
                {
                    error: `Invalid scan-state.json in selected-scan: ${err instanceof Error ? err.message : String(err)}`,
                },
            );

            return;
        }

        try {
            startPoolTradeHistory(tokenCa, workers, wallet, limit);
            json(
                request,
                response,
                200,
                poolScannerPublicState(),
            );
        } catch (error) {
            json(
                request,
                response,
                500,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
        }

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/persist
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/persist"
    ) {
        if (dataPipelineBusy()) {
            json(
                request,
                response,
                409,
                {
                    error:
                        "Another update process is already running",
                    poolScanner:
                        poolScannerPublicState(),
                    fabriq:
                        publicState(),
                    lpagent:
                        lpAgentPublicState(),
                },
            );
            return;
        }

        let body = {};
        try {
            body = await readJson(request);
        } catch {
            json(
                request,
                response,
                400,
                {
                    error: "Invalid JSON body",
                },
            );
            return;
        }

        const rawToken = body?.tokenCa;
        if (typeof rawToken !== "string" || !rawToken.trim()) {
            json(
                request,
                response,
                400,
                {
                    error: "tokenCa must be a non-empty string",
                },
            );
            return;
        }

        const tokenCa = rawToken.trim();

        try {
            validateTradeHistoryArtifacts(tokenCa);
        } catch (valErr) {
            json(
                request,
                response,
                400,
                {
                    error: valErr instanceof Error ? valErr.message : String(valErr),
                },
            );
            return;
        }

        try {
            startCanonicalPersistence(tokenCa, false);
            json(
                request,
                response,
                200,
                poolScannerPublicState(),
            );
        } catch (error) {
            json(
                request,
                response,
                500,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
        }

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/start
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/start"
    ) {
        if (dataPipelineBusy()) {
            json(
                request,
                response,
                409,
                {
                    error:
                        "Another update process is already running",

                    poolScanner:
                        poolScannerPublicState(),

                    fabriq:
                        publicState(),

                    lpagent:
                        lpAgentPublicState(),
                },
            );

            return;
        }

        let body = {};

        try {
            body = await readJson(request);
        } catch {
            json(
                request,
                response,
                400,
                {
                    error: "Invalid JSON body",
                },
            );

            return;
        }

        const rawToken = body?.tokenCa;

        if (
            typeof rawToken !== "string" ||
            !rawToken.trim()
        ) {
            json(
                request,
                response,
                400,
                {
                    error:
                        "tokenCa must be a non-empty string",
                },
            );

            return;
        }

        const tokenCa = rawToken.trim();

        let fabriqWorkers = 8;
        if (body?.fabriqWorkers !== undefined && body?.fabriqWorkers !== null) {
            const rawVal = body.fabriqWorkers;
            const strVal = String(rawVal).trim();
            const isValid =
                (typeof rawVal === "number" && Number.isInteger(rawVal) && rawVal >= 1) ||
                (typeof rawVal === "string" && /^[1-9]\d*$/.test(strVal));

            if (!isValid) {
                json(
                    request,
                    response,
                    400,
                    {
                        error: "fabriqWorkers must be an integer >= 1",
                    },
                );

                return;
            }
            fabriqWorkers = Number(strVal);
        }

        try {
            if (rejectBusyDataPipeline(request, response)) return;
            startPoolScanner(tokenCa, fabriqWorkers);

            json(
                request,
                response,
                202,
                poolScannerPublicState(),
            );
        } catch (error) {
            json(
                request,
                response,
                500,
                {
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                },
            );
        }

        return;
    }

    // ------------------------------------------------------
    // POST /api/pool-scanner/stop
    // ------------------------------------------------------

    if (
        request.method === "POST" &&
        url.pathname === "/api/pool-scanner/stop"
    ) {
        const state = stopPoolScanner();

        json(
            request,
            response,
            200,
            state,
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
        if (dataPipelineBusy()) {
            json(request, response, 409, {
                error: "Another update process is already running",
                fabriq: publicState(),
                lpagent: lpAgentPublicState(),
            });
            return;
        }

        try {
            const body = await readJson(request);
            const isResume = Boolean(body.resume);

            let validatedHistory = null;
            if (!isResume) {
                validatedHistory = validateHistoryConfig(
                    body.historyMode,
                    body.startMonth
                );
            }

            if (rejectBusyDataPipeline(request, response)) return;
            startPipeline({
                mode: body.mode,
                concurrency: body.concurrency,
                resume: isResume,
                historyMode: validatedHistory?.historyMode,
                startMonth: validatedHistory?.startMonth,
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
        if (dataPipelineBusy()) {
            json(request, response, 409, {
                error: "Another update process is already running",
                fabriq: publicState(),
                lpagent: lpAgentPublicState(),
            });
            return;
        }

        try {
            const body = await readJson(request);

            if (rejectBusyDataPipeline(request, response)) return;
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