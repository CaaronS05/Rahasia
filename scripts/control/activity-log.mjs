import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const LOGS_DIR = path.join(ROOT, "data/logs/activity");
const EVENTS_FILE = path.join(LOGS_DIR, "events.jsonl");
const RUNS_FILE = path.join(LOGS_DIR, "runs.jsonl");

const MAX_BUFFERED_EVENTS = 5000;
const MAX_RUNS_IN_MEMORY = 500;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

// ANSI escape code regex
const ANSI_REGEX = /\u001b\[[0-9;]*[a-zA-Z]/g;

// Secret redaction patterns
const JWT_REGEX = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g;
const AUTH_HEADER_REGEX = /(?:Authorization:\s*Bearer\s+)[^\s,;]+/gi;
const BEARER_TOKEN_REGEX = /Bearer\s+[a-zA-Z0-9._-]+/gi;
const COOKIE_HEADER_REGEX = /(?:cookie|set-cookie):\s*[^\r\n]+/gi;
const SENSITIVE_PARAM_REGEX = /(api[_-]?key|secret|password|auth_token)=[^\s&"'>]+/gi;

export function stripAnsi(str) {
    if (typeof str !== "string") return String(str ?? "");
    return str.replace(ANSI_REGEX, "");
}

export function sanitizeText(str) {
    if (typeof str !== "string") return String(str ?? "");
    let sanitized = stripAnsi(str);
    sanitized = sanitized.replace(JWT_REGEX, "[REDACTED_JWT]");
    sanitized = sanitized.replace(AUTH_HEADER_REGEX, "Authorization: Bearer [REDACTED]");
    sanitized = sanitized.replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED_TOKEN]");
    sanitized = sanitized.replace(COOKIE_HEADER_REGEX, "cookie: [REDACTED_COOKIE]");
    sanitized = sanitized.replace(SENSITIVE_PARAM_REGEX, "$1=[REDACTED]");
    return sanitized;
}

export class ActivityLogger {
    constructor() {
        this.initialized = false;
        this.eventsBuffer = []; // Ring buffer of recent log events
        this.runs = new Map(); // runId -> RunRecord
        this.activeRuns = new Map(); // runId -> RunRecord
        this.subscribers = new Set(); // SSE listeners: (event) => void
        this.writeQueue = [];
        this.isFlushing = false;
        this.idCounter = 0;
    }

    async init() {
        if (this.initialized) return;
        try {
            if (!fs.existsSync(LOGS_DIR)) {
                fs.mkdirSync(LOGS_DIR, { recursive: true });
            }

            // Load historical runs if runs.jsonl exists
            if (fs.existsSync(RUNS_FILE)) {
                try {
                    const content = fs.readFileSync(RUNS_FILE, "utf8");
                    const lines = content.split("\n").filter((l) => l.trim().length > 0);
                    for (const line of lines) {
                        try {
                            const run = JSON.parse(line);
                            if (run && run.runId) {
                                // If server crashed or restarted, mark previously running runs as interrupted
                                if (run.status === "running") {
                                    run.status = "error";
                                    run.error = run.error || "Process interrupted by server restart";
                                    run.finishedAt = run.finishedAt || new Date().toISOString();
                                }
                                this.runs.set(run.runId, run);
                            }
                        } catch {
                            // Ignore corrupt lines
                        }
                    }
                } catch (err) {
                    console.warn("[ActivityLogger] Failed to load runs history:", err.message);
                }
            }

            // Load recent events if events.jsonl exists
            if (fs.existsSync(EVENTS_FILE)) {
                try {
                    const content = fs.readFileSync(EVENTS_FILE, "utf8");
                    const lines = content.split("\n").filter((l) => l.trim().length > 0);
                    const recentLines = lines.slice(-MAX_BUFFERED_EVENTS);
                    for (const line of recentLines) {
                        try {
                            const ev = JSON.parse(line);
                            if (ev && ev.id) {
                                this.eventsBuffer.push(ev);
                            }
                        } catch {
                            // Ignore corrupt lines
                        }
                    }
                } catch (err) {
                    console.warn("[ActivityLogger] Failed to load events history:", err.message);
                }
            }

            this.initialized = true;
        } catch (err) {
            console.warn("[ActivityLogger] Initialization error:", err.message);
            this.initialized = true;
        }
    }

    generateId(prefix = "log") {
        this.idCounter = (this.idCounter + 1) % 100000;
        const rand = crypto.randomBytes(3).toString("hex");
        return `${prefix}_${Date.now()}_${this.idCounter}_${rand}`;
    }

    startRun({
        source,
        wallet = null,
        poolAddress = null,
        stage = "starting",
        metadata = null,
        runId = null,
    }) {
        const id = runId || this.generateId(`run_${source}`);
        const startedAt = new Date().toISOString();
        const runRecord = {
            runId: id,
            source,
            wallet: wallet ? String(wallet).trim() : null,
            poolAddress: poolAddress ? String(poolAddress).trim() : null,
            status: "running",
            stage,
            startedAt,
            finishedAt: null,
            durationMs: 0,
            error: null,
            exitCode: null,
            logCount: 0,
            metadata: metadata || undefined,
        };

        this.runs.set(id, runRecord);
        this.activeRuns.set(id, runRecord);
        this.queueWrite(RUNS_FILE, JSON.stringify(runRecord) + "\n");

        this.log({
            runId: id,
            source,
            wallet: runRecord.wallet,
            poolAddress: runRecord.poolAddress,
            stage,
            level: "INFO",
            message: `Process started [source: ${source}${wallet ? `, wallet: ${wallet}` : ""}${poolAddress ? `, pool: ${poolAddress}` : ""}]`,
        });

        return id;
    }

    updateRun(runId, updates = {}) {
        const run = this.runs.get(runId);
        if (!run) return;

        if (updates.stage !== undefined) run.stage = updates.stage;
        if (updates.status !== undefined) run.status = updates.status;
        if (updates.error !== undefined) run.error = sanitizeText(updates.error);
        if (updates.metadata !== undefined) run.metadata = { ...run.metadata, ...updates.metadata };

        if (run.startedAt) {
            const startMs = new Date(run.startedAt).getTime();
            run.durationMs = Math.max(0, Date.now() - startMs);
        }

        this.queueWrite(RUNS_FILE, JSON.stringify(run) + "\n");
    }

    finishRun(runId, { status = "completed", stage = "completed", error = null, exitCode = null } = {}) {
        const run = this.runs.get(runId);
        if (!run) return;

        const finishedAt = new Date().toISOString();
        run.status = status;
        run.stage = stage;
        run.finishedAt = finishedAt;
        run.exitCode = exitCode;
        if (error) {
            run.error = sanitizeText(error);
        }

        if (run.startedAt) {
            const startMs = new Date(run.startedAt).getTime();
            const finishMs = new Date(finishedAt).getTime();
            run.durationMs = Math.max(0, finishMs - startMs);
        }

        this.activeRuns.delete(runId);
        this.queueWrite(RUNS_FILE, JSON.stringify(run) + "\n");

        const level = status === "completed" ? "SUCCESS" : status === "error" ? "ERROR" : "WARN";
        const durationSec = ((run.durationMs || 0) / 1000).toFixed(1);
        const completionMsg = status === "completed"
            ? `Process completed successfully in ${durationSec}s`
            : `Process finished with status ${status} in ${durationSec}s${error ? `: ${run.error}` : ""}`;

        this.log({
            runId,
            source: run.source,
            wallet: run.wallet,
            poolAddress: run.poolAddress,
            stage,
            level,
            message: completionMsg,
        });
    }

    log({
        runId,
        source = "system",
        wallet = null,
        poolAddress = null,
        stage = "general",
        level = "INFO",
        message = "",
        details = null,
    }) {
        const id = this.generateId("log");
        const timestamp = new Date().toISOString();

        // Standardize level
        const validLevels = ["DEBUG", "INFO", "SUCCESS", "WARN", "ERROR"];
        const normalizedLevel = validLevels.includes(level?.toUpperCase())
            ? level.toUpperCase()
            : "INFO";

        const cleanMessage = sanitizeText(message);
        if (!cleanMessage.trim()) return null;

        const run = runId ? this.runs.get(runId) : null;
        if (run) {
            run.logCount = (run.logCount || 0) + 1;
            if (stage && stage !== run.stage) {
                run.stage = stage;
            }
        }

        const event = {
            id,
            timestamp,
            runId: runId || null,
            source: source || (run?.source ?? "system"),
            wallet: wallet ? String(wallet).trim() : (run?.wallet ?? null),
            poolAddress: poolAddress ? String(poolAddress).trim() : (run?.poolAddress ?? null),
            stage: stage || (run?.stage ?? "general"),
            level: normalizedLevel,
            message: cleanMessage,
            ...(details ? { details } : {}),
        };

        // Push to memory buffer
        this.eventsBuffer.push(event);
        if (this.eventsBuffer.length > MAX_BUFFERED_EVENTS) {
            this.eventsBuffer.shift();
        }

        // Queue persistent write
        this.queueWrite(EVENTS_FILE, JSON.stringify(event) + "\n");

        // Broadcast to live SSE subscribers
        for (const sub of this.subscribers) {
            try {
                sub(event);
            } catch {
                // Ignore subscriber write errors
            }
        }

        return event;
    }

    queueWrite(filePath, line) {
        this.writeQueue.push({ filePath, line });
        this.scheduleFlush();
    }

    scheduleFlush() {
        if (this.isFlushing) return;
        this.isFlushing = true;
        setImmediate(() => this.flushQueue());
    }

    async flushQueue() {
        if (this.writeQueue.length === 0) {
            this.isFlushing = false;
            return;
        }

        const items = this.writeQueue.splice(0, 100);
        // Group by file
        const byFile = new Map();
        for (const item of items) {
            const list = byFile.get(item.filePath) || [];
            list.push(item.line);
            byFile.set(item.filePath, list);
        }

        for (const [file, lines] of byFile.entries()) {
            try {
                await this.checkAndRotate(file);
                await fsp.appendFile(file, lines.join(""), "utf8");
            } catch (err) {
                console.warn(`[ActivityLogger] Write error on ${file}:`, err.message);
            }
        }

        if (this.writeQueue.length > 0) {
            setImmediate(() => this.flushQueue());
        } else {
            this.isFlushing = false;
        }
    }

    async checkAndRotate(file) {
        try {
            const stats = await fsp.stat(file);
            if (stats.size > MAX_FILE_SIZE_BYTES) {
                const rotated = `${file}.1`;
                try {
                    await fsp.rename(file, rotated);
                } catch {
                    // Ignore rename errors
                }
            }
        } catch {
            // File may not exist yet
        }
    }

    subscribe(listener) {
        this.subscribers.add(listener);
        return () => {
            this.subscribers.delete(listener);
        };
    }

    queryLogs({
        source,
        level,
        runId,
        wallet,
        poolAddress,
        search,
        since,
        afterId,
        limit = 200,
    } = {}) {
        const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 1000);
        let results = this.eventsBuffer;

        if (runId) {
            results = results.filter((ev) => ev.runId === runId);
        }
        if (source) {
            results = results.filter((ev) => ev.source === source);
        }
        if (level) {
            const lvl = level.toUpperCase();
            results = results.filter((ev) => ev.level === lvl);
        }
        if (wallet) {
            const wNorm = wallet.trim().toLowerCase();
            results = results.filter((ev) => ev.wallet && ev.wallet.toLowerCase().includes(wNorm));
        }
        if (poolAddress) {
            const pNorm = poolAddress.trim().toLowerCase();
            results = results.filter((ev) => ev.poolAddress && ev.poolAddress.toLowerCase().includes(pNorm));
        }
        if (since) {
            const sinceMs = new Date(since).getTime();
            if (Number.isFinite(sinceMs)) {
                results = results.filter((ev) => new Date(ev.timestamp).getTime() >= sinceMs);
            }
        }
        if (afterId) {
            const idx = results.findIndex((ev) => ev.id === afterId);
            if (idx !== -1) {
                results = results.slice(idx + 1);
            }
        }
        if (search) {
            const q = search.trim().toLowerCase();
            results = results.filter((ev) =>
                ev.message.toLowerCase().includes(q) ||
                ev.stage.toLowerCase().includes(q)
            );
        }

        const total = results.length;
        const paged = results.slice(-safeLimit);

        return {
            logs: paged,
            total,
            hasMore: total > safeLimit,
            activeProcesses: this.getActiveProcesses(),
        };
    }

    queryRuns({
        source,
        wallet,
        poolAddress,
        status,
        limit = 50,
    } = {}) {
        const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
        let allRuns = Array.from(this.runs.values());

        // Newest runs first
        allRuns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

        if (source) {
            allRuns = allRuns.filter((r) => r.source === source);
        }
        if (wallet) {
            const wNorm = wallet.trim().toLowerCase();
            allRuns = allRuns.filter((r) => r.wallet && r.wallet.toLowerCase().includes(wNorm));
        }
        if (poolAddress) {
            const pNorm = poolAddress.trim().toLowerCase();
            allRuns = allRuns.filter((r) => r.poolAddress && r.poolAddress.toLowerCase().includes(pNorm));
        }
        if (status) {
            allRuns = allRuns.filter((r) => r.status === status);
        }

        return {
            runs: allRuns.slice(0, safeLimit),
            total: allRuns.length,
            activeRunIds: Array.from(this.activeRuns.keys()),
        };
    }

    getRun(runId) {
        return this.runs.get(runId) || null;
    }

    getActiveProcesses() {
        return Array.from(this.activeRuns.values()).map((r) => ({
            runId: r.runId,
            source: r.source,
            wallet: r.wallet,
            poolAddress: r.poolAddress,
            stage: r.stage,
            startedAt: r.startedAt,
            durationMs: r.startedAt ? Math.max(0, Date.now() - new Date(r.startedAt).getTime()) : 0,
        }));
    }
}

export const activityLogger = new ActivityLogger();
activityLogger.init().catch((err) => {
    console.warn("[ActivityLogger] Failed to initialize activityLogger:", err);
});
