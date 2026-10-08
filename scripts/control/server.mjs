import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTokenPools } from "../pool/discover-token-pools.mjs";
import { activityLogger, stripAnsi, sanitizeText } from "./activity-log.mjs";
import {
    publishPositionAnalyticsPair,
    loadPublishedPositionPair,
    getBundleFilePath,
} from "../analytics/position-analytics-storage.ts";
import { computeMonitoringAssessment } from "../analytics/monitoring-assessment.mjs";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.CONTROL_SERVER_PORT || process.env.PORT || "8787", 10);

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
let fabriqRunId = null;
let lpAgentRunId = null;
let poolScannerRunId = null;
let walletIntelligenceRunId = null;
let poolRefreshRunId = null;

function inferLogLevel(line) {
    const l = String(line || "").toUpperCase();
    if (l.includes("ERROR") || l.includes("FAILED") || l.includes("FAIL") || l.includes("EXCEPTION") || l.includes("REJECTED")) return "ERROR";
    if (l.includes("WARN") || l.includes("RETRY") || l.includes("RATE_LIMITED") || l.includes("WAITING") || l.includes("CLOUDFLARE")) return "WARN";
    if (l.includes("SUCCESS") || l.includes("COMPLETED") || l.includes("FINISHED")) return "SUCCESS";
    if (l.includes("DEBUG")) return "DEBUG";
    return "INFO";
}

function extractCleanErrorMessage(stderr, stdout) {
    const combined = `${stderr || ""}\n${stdout || ""}`;
    const lines = combined.split("\n").map((l) => stripAnsi(l).trim()).filter(Boolean);

    const failedLine = lines.find((l) => l.startsWith("ANALYSIS FAILED:"));
    if (failedLine) {
        return failedLine.replace(/^ANALYSIS FAILED:\s*/, "");
    }

    const classifiedLine = lines.find((l) =>
        l.includes("CDP_UNREACHABLE") ||
        l.includes("CDP_PROTOCOL_TIMEOUT") ||
        l.includes("CDP_SESSION_DISCONNECTED") ||
        l.includes("FABRIQ_TAB_MISSING") ||
        l.includes("AUTH_SESSION_ERROR") ||
        l.includes("FABRIQ_API_ERROR") ||
        l.includes("RATE_LIMITED")
    );
    if (classifiedLine) {
        return classifiedLine;
    }

    if (combined.includes("Timeout 120000ms exceeded") || combined.includes("connectOverCDP")) {
        return "Unable to initialize Brave CDP session (connection timed out).";
    }

    const stderrLines = (stderr || "").split("\n").map((l) => stripAnsi(l).trim()).filter(Boolean);
    if (stderrLines.length > 0) {
        return stderrLines[stderrLines.length - 1];
    }

    return "Single-wallet analysis failed.";
}

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
    const cleaned = String(line).trimEnd();
    if (!cleaned) return;

    console.log(`[LPAGENT] ${cleaned}`);
    lpAgentState.logs.push(cleaned);
    if (lpAgentState.logs.length > 200) {
        lpAgentState.logs = lpAgentState.logs.slice(-200);
    }

    if (lpAgentRunId) {
        activityLogger.log({
            runId: lpAgentRunId,
            source: "lpagent",
            stage: lpAgentState.stage,
            level: inferLogLevel(cleaned),
            message: cleaned,
        });
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

    if (fabriqRunId) {
        activityLogger.log({
            runId: fabriqRunId,
            source: "fabriq_enrich",
            stage: state.stage,
            level: inferLogLevel(cleaned),
            message: cleaned,
        });
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
    fabriqRunId = activityLogger.startRun({
        source: "fabriq_enrich",
        stage: "enrich",
        metadata: { mode: safeMode, workers: safeConcurrency, resume: isResume },
    });

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
        if (fabriqRunId) activityLogger.updateRun(fabriqRunId, { stage: "merge" });
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
        if (fabriqRunId) activityLogger.updateRun(fabriqRunId, { stage: "publish" });
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
        if (fabriqRunId) {
            activityLogger.finishRun(fabriqRunId, { status: "completed", stage: "completed", exitCode: 0 });
            fabriqRunId = null;
        }
        stopRuntimeTicker();
        broadcastState("finish");
    } catch (error) {
        state.status = "error";
        state.stage = "error";
        state.error = error instanceof Error ? error.message : String(error);
        state.finishedAt = new Date().toISOString();
        addLog(`[CONTROL] Pipeline error: ${state.error}`);
        stopRuntimeTicker();
        if (fabriqRunId) {
            activityLogger.finishRun(fabriqRunId, { status: "error", stage: state.stage, error: state.error });
            fabriqRunId = null;
        }
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

    const safeConcurrency = sanitizeConcurrency(concurrency ?? 8);
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
    lpAgentRunId = activityLogger.startRun({
        source: "lpagent",
        stage: "scrape",
        metadata: { workers: safeConcurrency },
    });

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
                LPAGENT_MAX_IN_FLIGHT: String(process.env.LPAGENT_MAX_IN_FLIGHT ?? "10"),
            },
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
        if (lpAgentRunId) activityLogger.updateRun(lpAgentRunId, { stage: "merge_wallets" });
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
        if (lpAgentRunId) activityLogger.updateRun(lpAgentRunId, { stage: "fabriq_enrich" });
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
        if (lpAgentRunId) activityLogger.updateRun(lpAgentRunId, { stage: "fabriq_merge" });
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
        if (lpAgentRunId) activityLogger.updateRun(lpAgentRunId, { stage: "publish" });
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
        if (lpAgentRunId) {
            activityLogger.finishRun(lpAgentRunId, { status: "completed", stage: "completed", exitCode: 0 });
            lpAgentRunId = null;
        }
    } catch (error) {
        lpAgentState.status = "error";
        lpAgentState.stage = "error";
        lpAgentState.error = error instanceof Error ? error.message : String(error);
        lpAgentState.finishedAt = new Date().toISOString();
        addLpAgentLog(`[CONTROL] Pipeline exception: ${lpAgentState.error}`);
        if (lpAgentRunId) {
            activityLogger.finishRun(lpAgentRunId, { status: "error", stage: lpAgentState.stage, error: lpAgentState.error });
            lpAgentRunId = null;
        }
    }
}

function addPoolScannerLog(line) {
    const cleaned = String(line).trimEnd();
    if (!cleaned) return;

    console.log(`[POOL_SCANNER] ${cleaned}`);
    poolScannerState.logs.push(cleaned);
    if (poolScannerState.logs.length > 200) {
        poolScannerState.logs = poolScannerState.logs.slice(-200);
    }

    if (poolScannerRunId) {
        activityLogger.log({
            runId: poolScannerRunId,
            source: "pool_scanner",
            stage: poolScannerState.stage,
            level: inferLogLevel(cleaned),
            message: cleaned,
        });
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
    poolScannerRunId = activityLogger.startRun({
        source: "pool_scanner",
        stage: poolScannerState.stage || "discovery",
        metadata: { tokenCa, fabriqWorkers },
    });

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
        if (poolScannerRunId) {
            activityLogger.finishRun(poolScannerRunId, {
                status: "stopped",
                stage: poolScannerState.stage,
            });
            poolScannerRunId = null;
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
            if (poolScannerRunId) {
                activityLogger.finishRun(poolScannerRunId, {
                    status: "completed",
                    stage: poolScannerState.stage,
                    exitCode: 0,
                });
                poolScannerRunId = null;
            }
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "error";
            poolScannerState.error =
                poolScannerState.error ??
                `Pool Scanner pipeline failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(
                `[CONTROL] ${poolScannerState.error}`
            );
            if (poolScannerRunId) {
                activityLogger.finishRun(poolScannerRunId, {
                    status: "error",
                    stage: poolScannerState.stage,
                    error: poolScannerState.error,
                    exitCode: code,
                });
                poolScannerRunId = null;
            }
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
        if (Boolean(currentChild || lpAgentChild || walletIntelligenceChild || poolRefreshChild || activeSingleWalletChild?.child || activePositionAnalyticsChild?.child)) {
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
            scannedPoolsCache = null;
            scannedPoolsMtimeMs = null;
            poolMembershipCache = null;
            poolMembershipMtimeMs = null;
            poolTradesCache = null;
            poolTradesMtimeMs = null;
            addPoolScannerLog(
                "[CONTROL] Canonical Persistence finished successfully. Scanned pools published to Pool Insight."
            );
            startGlobalWalletSync(tokenCa);
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
function startGlobalWalletSync(tokenCa) {
    poolScannerState.stage = "syncing";
    addPoolScannerLog(
        `[CONTROL] Starting Global Wallet Registry sync for token: ${tokenCa}`
    );

    poolScannerChild = spawn(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/pipeline/sync-pool-wallets.ts",
            "--token",
            tokenCa,
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
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;
        if (wasUserStopped) return;
        poolScannerState.status = "error";
        poolScannerState.stage = "sync_error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Global Wallet Registry sync process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;
        if (wasUserStopped) return;

        if (code === 0) {
            addPoolScannerLog(
                "[CONTROL] Global Wallet Registry sync finished successfully."
            );
            startGlobalWalletPublish(tokenCa);
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "sync_error";
            poolScannerState.error =
                `Global Wallet Registry sync failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            poolScannerState.finishedAt = new Date().toISOString();
            addPoolScannerLog(`[CONTROL] ${poolScannerState.error}`);
        }
    });
}

function startGlobalWalletPublish(tokenCa) {
    poolScannerState.stage = "publishing";
    addPoolScannerLog(
        "[CONTROL] Publishing unified wallet population to Wallet Explorer..."
    );

    poolScannerChild = spawn(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/pipeline/publish-wallets.ts",
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
        });
    });

    poolScannerChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeBuffer(stderrBuffer, chunk, (line) => {
            addPoolScannerLog(line);
        });
    });

    poolScannerChild.on("error", (error) => {
        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;
        if (wasUserStopped) return;
        poolScannerState.status = "error";
        poolScannerState.stage = "publish_error";
        poolScannerState.error =
            error instanceof Error ? error.message : String(error);
        poolScannerState.finishedAt = new Date().toISOString();
        addPoolScannerLog(
            `[CONTROL] Publishing process error: ${poolScannerState.error}`
        );
    });

    poolScannerChild.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
            const trimmed = stdoutBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stderrBuffer.trimEnd();
            addPoolScannerLog(trimmed);
            stderrBuffer = "";
        }

        const wasUserStopped =
            poolScannerUserStopped || poolScannerState.status === "stopped";
        poolScannerChild = null;
        if (wasUserStopped) return;

        poolScannerState.finishedAt = new Date().toISOString();
        poolScannerState.exitCode = code;

        if (code === 0) {
            poolScannerState.status = "completed";
            poolScannerState.stage = "completed";
            poolScannerState.error = null;
            addPoolScannerLog(
                "[CONTROL] Pipeline complete! Discovered pool wallets synced to Global Registry and published to Wallet Explorer."
            );
        } else {
            poolScannerState.status = "error";
            poolScannerState.stage = "publish_error";
            poolScannerState.error =
                `Wallet Explorer publishing failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
            addPoolScannerLog(`[CONTROL] ${poolScannerState.error}`);
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
    poolRefreshRunId = activityLogger.startRun({
        source: "pool_refresh",
        poolAddress,
        stage: "starting",
        metadata: { poolAddress },
    });

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
        } else if (line.includes("[REFRESH_POOL] STAGE syncing")) {
            poolRefreshState.stage = "syncing";
        } else if (line.includes("[REFRESH_POOL] STAGE publishing")) {
            poolRefreshState.stage = "publishing";
        } else if (line.includes("[REFRESH_POOL] COMPLETE")) {
            poolRefreshState.stage = "completed";
            poolRefreshState.status = "completed";
            poolRefreshState.completedAt = new Date().toISOString();
        } else if (line.includes("[REFRESH_POOL] ERROR")) {
            poolRefreshState.error = line;
        }
        if (poolRefreshRunId) {
            activityLogger.updateRun(poolRefreshRunId, { stage: poolRefreshState.stage });
        }
    }

    poolRefreshChild.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeLocalBuffer(stdoutBuffer, chunk, (line) => {
            poolRefreshState.logs.push(line);
            if (poolRefreshState.logs.length > 200) poolRefreshState.logs = poolRefreshState.logs.slice(-200);
            parseRefreshLine(line);
            if (poolRefreshRunId) {
                activityLogger.log({
                    runId: poolRefreshRunId,
                    source: "pool_refresh",
                    poolAddress: poolRefreshState.poolAddress,
                    stage: poolRefreshState.stage,
                    level: inferLogLevel(line),
                    message: line,
                });
            }
        });
    });

    poolRefreshChild.stderr.on("data", (chunk) => {
        stderrBuffer = consumeLocalBuffer(stderrBuffer, chunk, (line) => {
            poolRefreshState.logs.push(line);
            if (poolRefreshState.logs.length > 200) poolRefreshState.logs = poolRefreshState.logs.slice(-200);
            parseRefreshLine(line);
            if (poolRefreshRunId) {
                activityLogger.log({
                    runId: poolRefreshRunId,
                    source: "pool_refresh",
                    poolAddress: poolRefreshState.poolAddress,
                    stage: poolRefreshState.stage,
                    level: "WARN",
                    message: line,
                });
            }
        });
    });

    poolRefreshChild.on("error", (error) => {
        poolRefreshChild = null;
        poolRefreshState.status = "failed";
        poolRefreshState.stage = "failed";
        poolRefreshState.error = error instanceof Error ? error.message : String(error);
        poolRefreshState.completedAt = new Date().toISOString();
        if (poolRefreshRunId) {
            activityLogger.finishRun(poolRefreshRunId, {
                status: "error",
                stage: poolRefreshState.stage,
                error: poolRefreshState.error,
            });
            poolRefreshRunId = null;
        }
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
        if (poolRefreshRunId) {
            activityLogger.finishRun(poolRefreshRunId, {
                status: code === 0 ? "completed" : "error",
                stage: poolRefreshState.stage,
                error: poolRefreshState.error,
                exitCode: code,
            });
            poolRefreshRunId = null;
        }
    });

    return poolRefreshPublicState();
}

// One shared lock covers process lifetime, stage gaps, and stopping process trees.
let activeSingleWalletChild = null; // { address, child, startedAt }
const singleWalletStates = new Map(); // address -> { status, stage, startedAt, finishedAt, error }
let activePositionAnalyticsChild = null; // { wallet, period, child, startedAt, runId, isStopping, abortNextStage }
let positionAnalyticsState = {
    status: "idle",
    wallet: null,
    period: null,
    stage: "idle",
    stageDetails: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    runId: null,
};
const positionAnalyticsStates = new Map(); // `${wallet}:${period}` -> state

function dataPipelineBusy() {
    return Boolean(currentChild || lpAgentChild || poolScannerChild || walletIntelligenceChild || poolRefreshChild || activeSingleWalletChild?.child || activePositionAnalyticsChild?.child) ||
        [state, lpAgentState, poolScannerState, walletIntelligenceState, poolRefreshState, positionAnalyticsState]
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

    if (walletIntelligenceRunId) {
        activityLogger.log({
            runId: walletIntelligenceRunId,
            source: "wallet_intelligence",
            stage: walletIntelligenceState.stage,
            level: inferLogLevel(line),
            message: line,
        });
    }

    if (!line.startsWith("[WALLET_INTELLIGENCE] ") || walletIntelligenceState.status === "stopping") return;
    try {
        const event = JSON.parse(line.slice("[WALLET_INTELLIGENCE] ".length));
        if (!WALLET_INTELLIGENCE_STAGES.includes(event.stage)) return;
        if (!["running", "completed", "error"].includes(event.status)) return;
        walletIntelligenceState.stage = event.stage;
        walletIntelligenceState.stageStates[event.stage] = event.status;
        if (walletIntelligenceRunId) {
            activityLogger.updateRun(walletIntelligenceRunId, { stage: event.stage });
        }
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
    walletIntelligenceRunId = activityLogger.startRun({
        source: "wallet_intelligence",
        stage: "historical_cohort",
    });
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
        if (walletIntelligenceRunId) {
            activityLogger.finishRun(walletIntelligenceRunId, {
                status: walletIntelligenceState.status,
                stage: walletIntelligenceState.stage,
                error: walletIntelligenceState.error,
                exitCode: code,
            });
            walletIntelligenceRunId = null;
        }
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
function isValidSolanaAddress(address) {
    if (typeof address !== "string") return false;
    const trimmed = address.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

function getSingleWalletResultPath(address) {
    return path.join(ROOT, "data/v1/single-wallet", `${address}.json`);
}

function getSingleWalletStatus(address) {
    const norm = address.trim();
    const isActive = Boolean(activeSingleWalletChild && activeSingleWalletChild.address === norm);
    const recorded = singleWalletStates.get(norm);
    const hasResult = fs.existsSync(getSingleWalletResultPath(norm));

    if (isActive) {
        const isStopping = recorded?.status === "stopping" || Boolean(activeSingleWalletChild?.isStopping);
        return {
            wallet: norm,
            status: isStopping ? "stopping" : "running",
            stage: recorded?.stage || (isStopping ? "stopping" : "analyzing"),
            stageDetails: recorded?.stageDetails || (isStopping ? "Stopping single-wallet intelligence analysis..." : "Analyzing wallet..."),
            runId: recorded?.runId || null,
            startedAt: activeSingleWalletChild.startedAt,
            elapsedMs: Date.now() - new Date(activeSingleWalletChild.startedAt).getTime(),
            finishedAt: null,
            error: null,
            hasResult,
        };
    }

    // Check if reference cohort exists
    const hasCohort = fs.existsSync(path.join(ROOT, "data/v1/wallet-quality-scores.json"));
    if (!hasCohort) {
        return {
            wallet: norm,
            status: "reference_required",
            stage: "unavailable",
            stageDetails: null,
            runId: null,
            startedAt: null,
            elapsedMs: 0,
            finishedAt: null,
            error: "Reference cohort required. Please run initial Wallet Intelligence screening first.",
            hasResult: false,
        };
    }

    if (recorded) {
        return {
            wallet: norm,
            status: recorded.status,
            stage: recorded.stage,
            stageDetails: recorded.stageDetails || null,
            runId: recorded.runId || null,
            startedAt: recorded.startedAt,
            elapsedMs: recorded.startedAt && recorded.finishedAt
                ? Math.max(0, new Date(recorded.finishedAt).getTime() - new Date(recorded.startedAt).getTime())
                : 0,
            finishedAt: recorded.finishedAt,
            error: recorded.error,
            hasResult,
        };
    }

    return {
        wallet: norm,
        status: hasResult ? "completed" : "idle",
        stage: hasResult ? "completed" : "idle",
        stageDetails: null,
        runId: null,
        startedAt: null,
        elapsedMs: 0,
        finishedAt: null,
        error: null,
        hasResult,
    };
}

function startSingleWalletAnalysis(address, force = false) {
    const norm = address.trim();
    if (!isValidSolanaAddress(norm)) {
        const err = new Error("Invalid Solana address");
        err.statusCode = 400;
        throw err;
    }

    const hasCohort = fs.existsSync(path.join(ROOT, "data/v1/wallet-quality-scores.json"));
    if (!hasCohort) {
        const err = new Error("Reference cohort required. Please run initial Wallet Intelligence screening first.");
        err.statusCode = 422;
        throw err;
    }

    if (activeSingleWalletChild) {
        const err = new Error(
            activeSingleWalletChild.address === norm
                ? "Analysis already running for this wallet"
                : `Another wallet analysis is currently in progress (${activeSingleWalletChild.address})`
        );
        err.statusCode = 409;
        throw err;
    }

    assertDataPipelineAvailable();

    const startedAt = new Date().toISOString();
    const runId = activityLogger.startRun({
        source: "single_wallet",
        wallet: norm,
        stage: "starting",
    });

    singleWalletStates.set(norm, {
        status: "running",
        stage: "starting",
        stageDetails: "Starting single-wallet intelligence analysis...",
        runId,
        startedAt,
        finishedAt: null,
        error: null,
    });

    const child = spawn(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/v1/single-wallet-intelligence.ts",
            norm,
            ...(force ? ["--force"] : []),
        ],
        {
            cwd: ROOT,
            env: { ...process.env },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    activeSingleWalletChild = { address: norm, child, startedAt, runId };

    let stdoutBuffer = "";
    let stderrBuffer = "";

    function parseSingleWalletLine(line) {
        const stageMatch = line.match(/\[STAGE\s+(\d+)\/10:\s+([A-Z_]+)\]\s*(.*)/i);
        if (stageMatch) {
            const num = stageMatch[1];
            const name = stageMatch[2];
            const details = stageMatch[3];
            const friendlyStage = name.toLowerCase();
            const rec = singleWalletStates.get(norm);
            if (rec && rec.status === "running") {
                rec.stage = friendlyStage;
                rec.stageDetails = details || `Stage ${num}/10: ${name}`;
                activityLogger.updateRun(runId, { stage: friendlyStage });
            }
        }
    }

    child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = stripAnsi(line).trim();
            if (!trimmed) continue;
            parseSingleWalletLine(trimmed);
            activityLogger.log({
                runId,
                source: "single_wallet",
                wallet: norm,
                stage: singleWalletStates.get(norm)?.stage || "running",
                level: inferLogLevel(trimmed),
                message: trimmed,
            });
        }
    });

    child.stderr.on("data", (chunk) => {
        stderrBuffer += String(chunk);
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = stripAnsi(line).trim();
            if (!trimmed) continue;
            parseSingleWalletLine(trimmed);
            activityLogger.log({
                runId,
                source: "single_wallet",
                wallet: norm,
                stage: singleWalletStates.get(norm)?.stage || "error",
                level: "ERROR",
                message: trimmed,
            });
        }
    });

    child.on("error", (err) => {
        if (activeSingleWalletChild?.child === child) {
            activeSingleWalletChild = null;
        }
        const finishedAt = new Date().toISOString();
        const cleanError = stripAnsi(err.message);
        activityLogger.finishRun(runId, {
            status: "error",
            stage: "error",
            error: cleanError,
        });
        singleWalletStates.set(norm, {
            status: "error",
            stage: "error",
            stageDetails: cleanError,
            runId,
            startedAt,
            finishedAt,
            error: cleanError,
        });
    });

    child.on("exit", (code, signal) => {
        const wasStopping = Boolean(activeSingleWalletChild?.isStopping || singleWalletStates.get(norm)?.status === "stopping");
        if (activeSingleWalletChild?.child === child) {
            activeSingleWalletChild = null;
        }
        if (stdoutBuffer.trim()) {
            const trimmed = stripAnsi(stdoutBuffer).trim();
            parseSingleWalletLine(trimmed);
            activityLogger.log({
                runId,
                source: "single_wallet",
                wallet: norm,
                stage: singleWalletStates.get(norm)?.stage || "running",
                level: inferLogLevel(trimmed),
                message: trimmed,
            });
            stdoutBuffer = "";
        }
        if (stderrBuffer.trim()) {
            const trimmed = stripAnsi(stderrBuffer).trim();
            parseSingleWalletLine(trimmed);
            activityLogger.log({
                runId,
                source: "single_wallet",
                wallet: norm,
                stage: singleWalletStates.get(norm)?.stage || "error",
                level: "ERROR",
                message: trimmed,
            });
            stderrBuffer = "";
        }

        const finishedAt = new Date().toISOString();
        if (wasStopping) {
            activityLogger.log({
                runId,
                source: "single_wallet",
                wallet: norm,
                stage: "stopped",
                level: "INFO",
                message: "Single-wallet intelligence analysis stopped by user.",
            });
            activityLogger.finishRun(runId, {
                status: "stopped",
                stage: "stopped",
                exitCode: code,
                signal: signal || "SIGTERM",
            });
            singleWalletStates.set(norm, {
                status: "stopped",
                stage: "stopped",
                stageDetails: "Analysis stopped by user.",
                runId,
                startedAt,
                finishedAt,
                error: null,
            });
        } else if (code === 0) {
            activityLogger.finishRun(runId, {
                status: "completed",
                stage: "completed",
                exitCode: 0,
            });
            singleWalletStates.set(norm, {
                status: "completed",
                stage: "completed",
                stageDetails: "Analysis completed successfully.",
                runId,
                startedAt,
                finishedAt,
                error: null,
            });
        } else {
            const rawError = extractCleanErrorMessage(stderrBuffer, stdoutBuffer) || `Analysis process exited with code ${code}${signal ? ` (${signal})` : ""}`;
            const cleanError = stripAnsi(rawError);
            activityLogger.finishRun(runId, {
                status: "error",
                stage: singleWalletStates.get(norm)?.stage || "error",
                error: cleanError,
                exitCode: code,
            });
            singleWalletStates.set(norm, {
                status: "error",
                stage: "error",
                stageDetails: cleanError,
                runId,
                startedAt,
                finishedAt,
                error: cleanError,
            });
        }
    });

    return getSingleWalletStatus(norm);
}
function stopSingleWalletAnalysis(address) {
    const norm = address.trim();
    if (!isValidSolanaAddress(norm)) {
        const err = new Error("Invalid Solana address");
        err.statusCode = 400;
        throw err;
    }

    if (!activeSingleWalletChild || activeSingleWalletChild.address !== norm) {
        const recorded = singleWalletStates.get(norm);
        if (recorded?.status === "stopping") {
            return getSingleWalletStatus(norm);
        }
        const err = new Error(
            activeSingleWalletChild
                ? `Cannot stop: active analysis belongs to wallet ${activeSingleWalletChild.address}`
                : "No active analysis running for this wallet"
        );
        err.statusCode = 409;
        throw err;
    }

    const active = activeSingleWalletChild;
    active.isStopping = true;

    const rec = singleWalletStates.get(norm);
    if (rec) {
        rec.status = "stopping";
        rec.stage = "stopping";
        rec.stageDetails = "Stopping single-wallet intelligence analysis...";
    }

    activityLogger.log({
        runId: active.runId,
        source: "single_wallet",
        wallet: norm,
        stage: "stopping",
        level: "INFO",
        message: `Stopping single-wallet analysis for ${norm} by user request...`,
    });

    const child = active.child;
    const pid = child.pid;
    const killTree = (signal) => {
        if (pid && process.platform !== "win32") {
            try { process.kill(-pid, signal); return; } catch { /* Fall back to child */ }
        }
        try { child.kill(signal); } catch { /* Already exited */ }
    };

    killTree("SIGTERM");
    const timer = setTimeout(() => {
        if (activeSingleWalletChild?.child === child) {
            activityLogger.log({
                runId: active.runId,
                source: "single_wallet",
                wallet: norm,
                stage: "stopping",
                level: "WARN",
                message: `Graceful stop timed out for ${norm} (3s). Force-killing with SIGKILL...`,
            });
            killTree("SIGKILL");
        }
    }, 3000);
    timer.unref();

    return getSingleWalletStatus(norm);
}

function isValidAnalyticsPeriod(period) {
    return period === "30D" || period === "90D" || period === "ALL_AVAILABLE";
}

const ANALYTICS_STAGING_ROOT = path.join(ROOT, "data/analytics/.staging");
try {
    if (fs.existsSync(ANALYTICS_STAGING_ROOT)) {
        fs.rmSync(ANALYTICS_STAGING_ROOT, { recursive: true, force: true });
    }
} catch {
    // Ignore startup cleanup error
}

function atomicWriteJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, filePath);
}

function getPositionDatasetPath(wallet, period) {
    return path.join(ROOT, "data/analytics/positions", wallet, `${period}.json`);
}

function getPositionMetricsPath(wallet, period) {
    return path.join(ROOT, "data/analytics/metrics", wallet, `${period}.json`);
}

function getPositionBundlePath(wallet, period) {
    return getBundleFilePath(wallet, period, path.join(ROOT, "data/analytics/bundles"));
}

function getLastAnalyzedAt(wallet, period) {
    try {
        const pair = loadPublishedPositionPair(wallet, period, {
            bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
            metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
        });
        if (pair) {
            return pair.publishedAt || pair.metrics?.generatedAt || pair.metrics?.sourceDatasetFetchedAt || pair.dataset?.fetchedAt || null;
        }
    } catch {
        return null;
    }
    return null;
}

function getPositionAnalyticsStatus(address, period = "30D") {
    const norm = (address || "").trim();
    const key = `${norm}:${period}`;
    const isActive = Boolean(
        activePositionAnalyticsChild &&
        activePositionAnalyticsChild.wallet === norm &&
        activePositionAnalyticsChild.period === period
    );
    const recorded = positionAnalyticsStates.get(key);
    const pair = loadPublishedPositionPair(norm, period, {
        bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
        positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
        metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
    });
    const hasDataset = Boolean(pair?.dataset);
    const hasMetrics = Boolean(pair?.metrics);
    const lastAnalyzedAt = getLastAnalyzedAt(norm, period);

    if (isActive) {
        const isStopping = positionAnalyticsState.status === "stopping" || Boolean(activePositionAnalyticsChild?.isStopping);
        return {
            wallet: norm,
            period,
            status: isStopping ? "stopping" : positionAnalyticsState.status,
            stage: positionAnalyticsState.stage,
            stageDetails: positionAnalyticsState.stageDetails,
            runId: activePositionAnalyticsChild.runId,
            startedAt: activePositionAnalyticsChild.startedAt,
            elapsedMs: Math.max(0, Date.now() - new Date(activePositionAnalyticsChild.startedAt).getTime()),
            finishedAt: null,
            error: null,
            hasDataset,
            hasMetrics,
            lastAnalyzedAt,
        };
    }

    if (recorded) {
        return {
            wallet: norm,
            period,
            status: recorded.status,
            stage: recorded.stage,
            stageDetails: recorded.stageDetails,
            runId: recorded.runId,
            startedAt: recorded.startedAt,
            elapsedMs: recorded.startedAt && recorded.finishedAt
                ? Math.max(0, new Date(recorded.finishedAt).getTime() - new Date(recorded.startedAt).getTime())
                : 0,
            finishedAt: recorded.finishedAt,
            error: recorded.error,
            hasDataset,
            hasMetrics,
            lastAnalyzedAt,
        };
    }

    return {
        wallet: norm,
        period,
        status: hasMetrics ? "completed" : "idle",
        stage: hasMetrics ? "completed" : "idle",
        stageDetails: null,
        runId: null,
        startedAt: null,
        elapsedMs: 0,
        finishedAt: null,
        error: null,
        hasDataset,
        hasMetrics,
        lastAnalyzedAt,
    };
}

function startPositionAnalytics(address, period = "30D", force = false) {
    const norm = (address || "").trim();
    if (!isValidSolanaAddress(norm)) {
        const err = new Error("Invalid Solana address");
        err.statusCode = 400;
        throw err;
    }
    if (!isValidAnalyticsPeriod(period)) {
        const err = new Error('Invalid period. Must be "30D", "90D", or "ALL_AVAILABLE"');
        err.statusCode = 400;
        throw err;
    }

    if (activePositionAnalyticsChild) {
        const isSame = activePositionAnalyticsChild.wallet === norm && activePositionAnalyticsChild.period === period;
        const err = new Error(
            isSame
                ? `Position analysis already running for ${norm} (${period})`
                : `Another position analysis is currently in progress (${activePositionAnalyticsChild.wallet})`
        );
        err.statusCode = 409;
        throw err;
    }

    assertDataPipelineAvailable();

    const key = `${norm}:${period}`;
    const startedAt = new Date().toISOString();
    const pair = loadPublishedPositionPair(norm, period, {
        bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
        positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
        metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
    });
    const datasetExists = Boolean(pair?.dataset);

    // If Step 1 data exists and not forcing refresh, jump directly to metrics builder
    const skipDataset = !force && datasetExists;
    const initialStage = skipDataset ? "metrics" : "dataset";

    const runId = activityLogger.startRun({
        source: "position_analytics",
        wallet: norm,
        stage: initialStage,
    });
    const stagingBaseDir = path.join(ROOT, "data/analytics/.staging", `${norm}-${period}-${runId}`);
    const stagingPositionsDir = path.join(stagingBaseDir, "positions");
    const stagingMetricsDir = path.join(stagingBaseDir, "metrics");

    function cleanupStaging() {
        try {
            if (fs.existsSync(stagingBaseDir)) {
                fs.rmSync(stagingBaseDir, { recursive: true, force: true });
            }
        } catch {
            // Ignore staging cleanup error
        }
    }

    positionAnalyticsState = {
        status: "running",
        wallet: norm,
        period,
        stage: initialStage,
        stageDetails: skipDataset
            ? "Computing position analytics metrics from existing dataset..."
            : "Building position analytics dataset from Fabriq DLMM positions...",
        startedAt,
        finishedAt: null,
        error: null,
        runId,
    };

    positionAnalyticsStates.set(key, { ...positionAnalyticsState });

    activityLogger.log({
        runId,
        source: "position_analytics",
        wallet: norm,
        stage: initialStage,
        level: "INFO",
        message: skipDataset
            ? `Starting Step 2 Metrics Builder for ${norm} (${period}) using existing dataset.`
            : `Starting Step 1 Position Dataset Builder for ${norm} (${period}) (force: ${force}).`,
    });

    function spawnStage(stageType) {
        const scriptName = stageType === "dataset"
            ? "scripts/analytics/build-position-dataset.ts"
            : "scripts/analytics/build-position-metrics.ts";

        const scriptArgs = [
            "--experimental-strip-types",
            scriptName,
            "--wallet", norm,
            "--period", period,
            ...(force ? ["--force"] : []),
        ];

        if (stageType === "dataset") {
            scriptArgs.push("--storage-base-dir", stagingPositionsDir);
        } else {
            if (skipDataset) {
                scriptArgs.push(
                    "--positions-base-dir", path.join(ROOT, "data/analytics/positions"),
                    "--metrics-base-dir", stagingMetricsDir
                );
            } else {
                scriptArgs.push(
                    "--positions-base-dir", stagingPositionsDir,
                    "--metrics-base-dir", stagingMetricsDir
                );
            }
        }

        const child = spawn(
            process.execPath,
            scriptArgs,
            {
                cwd: ROOT,
                env: { ...process.env },
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        activePositionAnalyticsChild = {
            wallet: norm,
            period,
            child,
            startedAt,
            runId,
            stageType,
            isStopping: false,
            abortNextStage: false,
            stagingBaseDir,
        };

        let stdoutBuffer = "";
        let stderrBuffer = "";

        child.stdout.on("data", (chunk) => {
            stdoutBuffer += String(chunk);
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = stripAnsi(line).trim();
                if (!trimmed) continue;
                activityLogger.log({
                    runId,
                    source: "position_analytics",
                    wallet: norm,
                    stage: positionAnalyticsState.stage,
                    level: inferLogLevel(trimmed),
                    message: trimmed,
                });
            }
        });

        child.stderr.on("data", (chunk) => {
            stderrBuffer += String(chunk);
            const lines = stderrBuffer.split("\n");
            stderrBuffer = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = stripAnsi(line).trim();
                if (!trimmed) continue;
                activityLogger.log({
                    runId,
                    source: "position_analytics",
                    wallet: norm,
                    stage: positionAnalyticsState.stage,
                    level: "ERROR",
                    message: trimmed,
                });
            }
        });

        child.on("error", (err) => {
            cleanupStaging();
            const finishedAt = new Date().toISOString();
            const cleanErr = stripAnsi(err.message);
            activityLogger.log({
                runId,
                source: "position_analytics",
                wallet: norm,
                stage: positionAnalyticsState.stage,
                level: "ERROR",
                message: `Process error in ${stageType}: ${cleanErr}`,
            });
            positionAnalyticsState.status = "error";
            positionAnalyticsState.stage = "error";
            positionAnalyticsState.stageDetails = `Process error: ${cleanErr}`;
            positionAnalyticsState.error = cleanErr;
            positionAnalyticsState.finishedAt = finishedAt;
            positionAnalyticsStates.set(key, { ...positionAnalyticsState });
            activityLogger.finishRun(runId, {
                status: "error",
                stage: "error",
                error: cleanErr,
            });
            activePositionAnalyticsChild = null;
        });

        child.on("exit", (code, signal) => {
            if (stdoutBuffer.trim()) {
                const trimmed = stripAnsi(stdoutBuffer).trim();
                activityLogger.log({
                    runId,
                    source: "position_analytics",
                    wallet: norm,
                    stage: positionAnalyticsState.stage,
                    level: inferLogLevel(trimmed),
                    message: trimmed,
                });
            }
            if (stderrBuffer.trim()) {
                const trimmed = stripAnsi(stderrBuffer).trim();
                activityLogger.log({
                    runId,
                    source: "position_analytics",
                    wallet: norm,
                    stage: positionAnalyticsState.stage,
                    level: "ERROR",
                    message: trimmed,
                });
            }

            const wasStopping = Boolean(
                activePositionAnalyticsChild?.isStopping ||
                positionAnalyticsState.status === "stopping"
            );

            if (wasStopping) {
                cleanupStaging();
                const finishedAt = new Date().toISOString();
                positionAnalyticsState.status = "stopped";
                positionAnalyticsState.stage = "stopped";
                positionAnalyticsState.stageDetails = "Analysis stopped by user request.";
                positionAnalyticsState.error = null;
                positionAnalyticsState.finishedAt = finishedAt;
                positionAnalyticsStates.set(key, { ...positionAnalyticsState });
                activityLogger.finishRun(runId, {
                    status: "stopped",
                    stage: "stopped",
                    error: null,
                });
                activePositionAnalyticsChild = null;
                return;
            }

            if (code !== 0) {
                cleanupStaging();
                const finishedAt = new Date().toISOString();
                const cleanErr = extractCleanErrorMessage(stderrBuffer, stdoutBuffer) || `${stageType} stage failed (exit ${code})`;
                positionAnalyticsState.status = "error";
                positionAnalyticsState.stage = "error";
                positionAnalyticsState.stageDetails = `${stageType} failed`;
                positionAnalyticsState.error = cleanErr;
                positionAnalyticsState.finishedAt = finishedAt;
                positionAnalyticsStates.set(key, { ...positionAnalyticsState });
                activityLogger.finishRun(runId, {
                    status: "error",
                    stage: "error",
                    error: cleanErr,
                    exitCode: code,
                });
                activePositionAnalyticsChild = null;
                return;
            }

            // Successful exit of this stage!
            if (stageType === "dataset") {
                if (activePositionAnalyticsChild?.abortNextStage) {
                    cleanupStaging();
                    const finishedAt = new Date().toISOString();
                    positionAnalyticsState.status = "stopped";
                    positionAnalyticsState.stage = "stopped";
                    positionAnalyticsState.stageDetails = "Analysis stopped before metrics calculation.";
                    positionAnalyticsState.finishedAt = finishedAt;
                    positionAnalyticsStates.set(key, { ...positionAnalyticsState });
                    activityLogger.finishRun(runId, {
                        status: "stopped",
                        stage: "stopped",
                        error: null,
                    });
                    activePositionAnalyticsChild = null;
                    return;
                }

                // Verify staged dataset artifact exists before proceeding to stage 2
                const stagedPosPath = path.join(stagingPositionsDir, norm, `${period}.json`);
                if (!fs.existsSync(stagedPosPath)) {
                    cleanupStaging();
                    const finishedAt = new Date().toISOString();
                    const cleanErr = "Step 1 completed but staged dataset artifact was not found.";
                    positionAnalyticsState.status = "error";
                    positionAnalyticsState.stage = "error";
                    positionAnalyticsState.stageDetails = "dataset failed";
                    positionAnalyticsState.error = cleanErr;
                    positionAnalyticsState.finishedAt = finishedAt;
                    positionAnalyticsStates.set(key, { ...positionAnalyticsState });
                    activityLogger.finishRun(runId, {
                        status: "error",
                        stage: "error",
                        error: cleanErr,
                        exitCode: 1,
                    });
                    activePositionAnalyticsChild = null;
                    return;
                }

                // Transition to Stage 2: Metrics Builder
                positionAnalyticsState.stage = "metrics";
                positionAnalyticsState.stageDetails = "Step 1 complete. Computing Step 2 metrics...";
                activityLogger.updateRun(runId, { stage: "metrics" });
                activityLogger.log({
                    runId,
                    source: "position_analytics",
                    wallet: norm,
                    stage: "metrics",
                    level: "INFO",
                    message: `Step 1 Dataset built successfully. Now running Step 2 Metrics Builder...`,
                });

                spawnStage("metrics");
                return;
            }

            // Metrics stage finished successfully. Atomically promote staged artifacts!
            try {
                let datasetToPromote = null;
                let metricsToPromote = null;

                if (skipDataset) {
                    const stagedMetPath = path.join(stagingMetricsDir, norm, `${period}.json`);
                    if (!fs.existsSync(stagedMetPath)) {
                        throw new Error("Staged metrics artifact not found for promotion");
                    }
                    metricsToPromote = JSON.parse(fs.readFileSync(stagedMetPath, "utf8"));
                    const currentPair = loadPublishedPositionPair(norm, period, {
                        bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
                        positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
                        metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
                    });
                    if (!currentPair || !currentPair.dataset) {
                        throw new Error("Base dataset not found for metrics promotion");
                    }
                    datasetToPromote = currentPair.dataset;
                } else {
                    const stagedPosPath = path.join(stagingPositionsDir, norm, `${period}.json`);
                    const stagedMetPath = path.join(stagingMetricsDir, norm, `${period}.json`);
                    if (!fs.existsSync(stagedPosPath) || !fs.existsSync(stagedMetPath)) {
                        throw new Error("Missing staged dataset or metrics artifact for promotion");
                    }
                    datasetToPromote = JSON.parse(fs.readFileSync(stagedPosPath, "utf8"));
                    metricsToPromote = JSON.parse(fs.readFileSync(stagedMetPath, "utf8"));
                }

                publishPositionAnalyticsPair({
                    wallet: norm,
                    period,
                    dataset: datasetToPromote,
                    metrics: metricsToPromote,
                    bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
                });
            } catch (promoteErr) {
                cleanupStaging();
                const finishedAt = new Date().toISOString();
                const cleanErr = `Promotion error: ${promoteErr.message}`;
                positionAnalyticsState.status = "error";
                positionAnalyticsState.stage = "error";
                positionAnalyticsState.stageDetails = "promotion failed";
                positionAnalyticsState.error = cleanErr;
                positionAnalyticsState.finishedAt = finishedAt;
                positionAnalyticsStates.set(key, { ...positionAnalyticsState });
                activityLogger.finishRun(runId, {
                    status: "error",
                    stage: "error",
                    error: cleanErr,
                    exitCode: 1,
                });
                activePositionAnalyticsChild = null;
                return;
            }

            cleanupStaging();

            // Metrics stage finished successfully
            const finishedAt = new Date().toISOString();
            positionAnalyticsState.status = "completed";
            positionAnalyticsState.stage = "completed";
            positionAnalyticsState.stageDetails = "Position analytics complete.";
            positionAnalyticsState.error = null;
            positionAnalyticsState.finishedAt = finishedAt;
            positionAnalyticsStates.set(key, { ...positionAnalyticsState });
            activityLogger.finishRun(runId, {
                status: "completed",
                stage: "completed",
                exitCode: 0,
            });
            activePositionAnalyticsChild = null;
        });
    }

    spawnStage(initialStage);
    return getPositionAnalyticsStatus(norm, period);
}

function stopPositionAnalytics(address) {
    const norm = (address || "").trim();
    if (!isValidSolanaAddress(norm)) {
        const err = new Error("Invalid Solana address");
        err.statusCode = 400;
        throw err;
    }

    if (!activePositionAnalyticsChild || activePositionAnalyticsChild.wallet !== norm) {
        if (positionAnalyticsState.status === "stopping" && positionAnalyticsState.wallet === norm) {
            return getPositionAnalyticsStatus(norm, positionAnalyticsState.period || "30D");
        }
        const err = new Error(
            activePositionAnalyticsChild
                ? `Cannot stop: active position analysis belongs to wallet ${activePositionAnalyticsChild.wallet}`
                : "No active position analysis running for this wallet"
        );
        err.statusCode = 409;
        throw err;
    }

    const active = activePositionAnalyticsChild;
    active.isStopping = true;
    active.abortNextStage = true;
    positionAnalyticsState.status = "stopping";
    positionAnalyticsState.stage = "stopping";
    positionAnalyticsState.stageDetails = "Stopping position analytics pipeline...";

    activityLogger.log({
        runId: active.runId,
        source: "position_analytics",
        wallet: norm,
        stage: "stopping",
        level: "INFO",
        message: `Stopping position analytics for ${norm} by user request...`,
    });

    const child = active.child;
    const pid = child.pid;
    const killTree = (signal) => {
        if (pid && process.platform !== "win32") {
            try { process.kill(-pid, signal); return; } catch { /* Fall back to child */ }
        }
        try { child.kill(signal); } catch { /* Already exited */ }
    };

    killTree("SIGTERM");
    const timer = setTimeout(() => {
        if (activePositionAnalyticsChild?.child === child) {
            activityLogger.log({
                runId: active.runId,
                source: "position_analytics",
                wallet: norm,
                stage: "stopping",
                level: "WARN",
                message: `Graceful stop timed out for ${norm} (3s). Force-killing with SIGKILL...`,
            });
            killTree("SIGKILL");
        }
    }, 3000);
    timer.unref();

    return getPositionAnalyticsStatus(norm, active.period);
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
    // Single Wallet Intelligence endpoints
    const singleStartMatch = url.pathname.match(/^\/api\/wallet-intelligence\/single\/([^/]+)\/start\/?$/);
    if (request.method === "POST" && singleStartMatch) {
        const address = safeDecodeURIComponent(singleStartMatch[1]);
        try {
            const body = await readJson(request).catch(() => ({}));
            const res = startSingleWalletAnalysis(address, Boolean(body?.force));
            json(request, response, 202, res);
        } catch (err) {
            json(request, response, err.statusCode || 500, { error: err.message });
        }
        return;
    }
    const singleStopMatch = url.pathname.match(/^\/api\/wallet-intelligence\/single\/([^/]+)\/stop\/?$/);
    if (request.method === "POST" && singleStopMatch) {
        const address = safeDecodeURIComponent(singleStopMatch[1]);
        try {
            const res = stopSingleWalletAnalysis(address);
            json(request, response, 202, res);
        } catch (err) {
            json(request, response, err.statusCode || 500, {
                error: err.message,
                ...getSingleWalletStatus(address),
            });
        }
        return;
    }


    const singleStatusMatch = url.pathname.match(/^\/api\/wallet-intelligence\/single\/([^/]+)\/status\/?$/);
    if (request.method === "GET" && singleStatusMatch) {
        const address = safeDecodeURIComponent(singleStatusMatch[1]);
        json(request, response, 200, getSingleWalletStatus(address));
        return;
    }

    const singleResultMatch = url.pathname.match(/^\/api\/wallet-intelligence\/single\/([^/]+)\/result\/?$/);
    if (request.method === "GET" && singleResultMatch) {
        const address = safeDecodeURIComponent(singleResultMatch[1]);
        const resPath = getSingleWalletResultPath(address);
        try {
            const content = JSON.parse(await fs.promises.readFile(resPath, "utf8"));
            json(request, response, 200, content);
        } catch {
            json(request, response, 404, { error: "No analysis result found for this wallet" });
        }
        return;
    }

    // ------------------------------------------------------
    // POSITION ANALYTICS API
    // ------------------------------------------------------
    if (url.pathname === "/api/position-analytics/status" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");
        const period = url.searchParams.get("period") || "30D";
        if (!isValidSolanaAddress(wallet)) {
            json(request, response, 400, { error: "Invalid Solana wallet address" });
            return;
        }
        if (!isValidAnalyticsPeriod(period)) {
            json(request, response, 400, { error: 'Invalid period. Must be "30D", "90D", or "ALL_AVAILABLE"' });
            return;
        }
        json(request, response, 200, getPositionAnalyticsStatus(wallet, period));
        return;
    }

    if (url.pathname === "/api/position-analytics/metrics" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");
        const period = url.searchParams.get("period") || "30D";
        if (!isValidSolanaAddress(wallet)) {
            json(request, response, 400, { error: "Invalid Solana wallet address" });
            return;
        }
        if (!isValidAnalyticsPeriod(period)) {
            json(request, response, 400, { error: 'Invalid period. Must be "30D", "90D", or "ALL_AVAILABLE"' });
            return;
        }
        const pair = loadPublishedPositionPair(wallet, period, {
            bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
            metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
        });
        if (!pair || !pair.metrics) {
            json(request, response, 404, { error: "Metrics not found for this wallet and period" });
            return;
        }
        json(request, response, 200, { ...pair.metrics, metrics: pair.metrics });
        return;
    }

    if (url.pathname === "/api/position-analytics/assessment" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");
        const period = url.searchParams.get("period") || "30D";
        if (!isValidSolanaAddress(wallet)) {
            json(request, response, 400, { error: "Invalid Solana wallet address" });
            return;
        }
        if (!isValidAnalyticsPeriod(period)) {
            json(request, response, 400, { error: 'Invalid period. Must be "30D", "90D", or "ALL_AVAILABLE"' });
            return;
        }
        const pair = loadPublishedPositionPair(wallet, period, {
            bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
            metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
        });
        if (!pair || !pair.dataset || !pair.metrics) {
            json(request, response, 404, { error: "Published position dataset or metrics not found for this wallet and period" });
            return;
        }
        if (pair.dataset.fetchedAt !== pair.metrics.sourceDatasetFetchedAt) {
            json(request, response, 404, { error: "Mismatched dataset and metrics versions" });
            return;
        }
        const assessment = computeMonitoringAssessment(pair.dataset, pair.metrics);
        json(request, response, 200, assessment);
        return;
    }

    if (url.pathname === "/api/position-analytics/positions" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");
        const period = url.searchParams.get("period") || "30D";
        if (!isValidSolanaAddress(wallet)) {
            json(request, response, 400, { error: "Invalid Solana wallet address" });
            return;
        }
        if (!isValidAnalyticsPeriod(period)) {
            json(request, response, 400, { error: 'Invalid period. Must be "30D", "90D", or "ALL_AVAILABLE"' });
            return;
        }
        const pair = loadPublishedPositionPair(wallet, period, {
            bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
            metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
        });
        if (!pair || !pair.dataset) {
            json(request, response, 404, { error: "Positions dataset not found for this wallet and period" });
            return;
        }
        const content = pair.dataset;
        const rawPositions = Array.isArray(content?.positions) ? content.positions : [];
        const compactPositions = rawPositions.map((p) => ({
            positionId: p.positionId,
            poolAddress: p.poolAddress,
            pairName: p.pairName,
            tokenXMint: p.tokenXMint,
            tokenYMint: p.tokenYMint,
            tokenXSymbol: p.tokenXSymbol,
            tokenYSymbol: p.tokenYSymbol,
            openedAt: p.openedAt,
            closedAt: p.closedAt,
            holdDurationSeconds: p.holdDurationSeconds,
            initialEntryUsd: p.initialEntryUsd,
            firstObservedAddUsd: p.firstObservedAddUsd,
            additionalLiquidityUsd: p.additionalLiquidityUsd,
            totalDepositsUsd: p.totalDepositsUsd,
            totalWithdrawalsUsd: p.totalWithdrawalsUsd,
            claimedFeesUsd: p.claimedFeesUsd,
            pnlUsd: p.pnlUsd,
            pnlPct: p.pnlPct,
            winLoss: p.winLoss,
            dataQuality: p.dataQuality,
            lifecycleMeta: {
                openingEventObserved: p.lifecycle?.openingEventObserved ?? false,
                closingEventObserved: p.lifecycle?.closingEventObserved ?? false,
                eventCount: p.lifecycle?.eventCount ?? p.lifecycle?.events?.length ?? 0,
            },
        }));
        json(request, response, 200, {
            positions: compactPositions,
            totalCount: compactPositions.length,
            sampling: content.sampling,
            dataQuality: content.dataQuality,
            timeframe: content.timeframe,
            fetchedAt: content.fetchedAt || null,
        });
        return;
    }

    if (url.pathname === "/api/position-analytics/position-detail" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");
        const period = url.searchParams.get("period") || "30D";
        const positionId = url.searchParams.get("positionId");
        const poolAddress = url.searchParams.get("poolAddress");
        if (!isValidSolanaAddress(wallet)) {
            json(request, response, 400, { error: "Invalid Solana wallet address" });
            return;
        }
        if (!isValidAnalyticsPeriod(period)) {
            json(request, response, 400, { error: 'Invalid period. Must be "30D", "90D", or "ALL_AVAILABLE"' });
            return;
        }
        if (!positionId) {
            json(request, response, 400, { error: "Missing positionId parameter" });
            return;
        }
        const pair = loadPublishedPositionPair(wallet, period, {
            bundlesBaseDir: path.join(ROOT, "data/analytics/bundles"),
            positionsBaseDir: path.join(ROOT, "data/analytics/positions"),
            metricsBaseDir: path.join(ROOT, "data/analytics/metrics"),
        });
        if (!pair || !pair.dataset) {
            json(request, response, 404, { error: "Positions dataset not found for this wallet and period" });
            return;
        }
        const content = pair.dataset;
        const rawPositions = Array.isArray(content?.positions) ? content.positions : [];
        const pos = rawPositions.find((p) => {
            if (poolAddress) {
                return p.positionId === positionId && p.poolAddress === poolAddress;
            }
            return p.positionId === positionId;
        });
        if (!pos) {
            json(request, response, 404, { error: "Position not found in dataset" });
            return;
        }
        json(request, response, 200, { position: pos });
        return;
    }

    if (url.pathname === "/api/position-analytics/start" && request.method === "POST") {
        try {
            const body = await readJson(request).catch(() => ({}));
            const wallet = body.wallet;
            const period = body.period || "30D";
            const force = Boolean(body.force);
            const status = startPositionAnalytics(wallet, period, force);
            json(request, response, 202, status);
        } catch (err) {
            json(request, response, err.statusCode || 500, { error: err.message });
        }
        return;
    }

    if (url.pathname === "/api/position-analytics/stop" && request.method === "POST") {
        try {
            const body = await readJson(request).catch(() => ({}));
            const wallet = body.wallet || url.searchParams.get("wallet");
            const status = stopPositionAnalytics(wallet);
            json(request, response, 202, status);
        } catch (err) {
            json(request, response, err.statusCode || 500, { error: err.message });
        }
        return;
    }

    // ------------------------------------------------------
    // ACTIVITY LOGS API
    // ------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/activity-logs/stream") {
        setCors(request, response);
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });

        const filterRunId = url.searchParams.get("runId");
        const filterSource = url.searchParams.get("source");
        const filterWallet = url.searchParams.get("wallet")?.toLowerCase();

        const unsubscribe = activityLogger.subscribe((event) => {
            if (filterRunId && event.runId !== filterRunId) return;
            if (filterSource && event.source !== filterSource) return;
            if (filterWallet && (!event.wallet || !event.wallet.toLowerCase().includes(filterWallet))) return;

            try {
                response.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
                unsubscribe();
            }
        });

        const keepAlive = setInterval(() => {
            try {
                response.write(": keep-alive\n\n");
            } catch {
                clearInterval(keepAlive);
                unsubscribe();
            }
        }, 15000);

        request.on("close", () => {
            clearInterval(keepAlive);
            unsubscribe();
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/activity-logs") {
        const source = url.searchParams.get("source") || undefined;
        const level = url.searchParams.get("level") || undefined;
        const runId = url.searchParams.get("runId") || undefined;
        const wallet = url.searchParams.get("wallet") || undefined;
        const poolAddress = url.searchParams.get("poolAddress") || undefined;
        const search = url.searchParams.get("search") || undefined;
        const since = url.searchParams.get("since") || undefined;
        const afterId = url.searchParams.get("afterId") || undefined;
        const limit = url.searchParams.get("limit") || "200";

        const result = activityLogger.queryLogs({
            source,
            level,
            runId,
            wallet,
            poolAddress,
            search,
            since,
            afterId,
            limit,
        });
        json(request, response, 200, result);
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/activity-runs") {
        const source = url.searchParams.get("source") || undefined;
        const wallet = url.searchParams.get("wallet") || undefined;
        const poolAddress = url.searchParams.get("poolAddress") || undefined;
        const status = url.searchParams.get("status") || undefined;
        const limit = url.searchParams.get("limit") || "50";

        const result = activityLogger.queryRuns({
            source,
            wallet,
            poolAddress,
            status,
            limit,
        });
        json(request, response, 200, result);
        return;
    }

    const activityRunDetailMatch = url.pathname.match(/^\/api\/activity-runs\/([^/]+)\/?$/);
    if (request.method === "GET" && activityRunDetailMatch) {
        const runId = safeDecodeURIComponent(activityRunDetailMatch[1]);
        const run = activityLogger.getRun(runId);
        if (!run) {
            json(request, response, 404, { error: "Run not found" });
            return;
        }
        const logs = activityLogger.queryLogs({ runId, limit: 1000 }).logs;
        json(request, response, 200, { run, logs });
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

    // ------------------------------------------------------
    // GET /api/pool-refresh/status
    // ------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/pool-refresh/status") {
        const queryPool = url.searchParams.get("pool")?.trim() || null;
        json(request, response, 200, poolRefreshPublicState(queryPool));
        return;
    }

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