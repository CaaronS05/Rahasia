import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8787;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const MAX_CONCURRENCY = 10;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

let currentChild = null;
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

  logs: [],
};

function sanitizeConcurrency(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(MAX_CONCURRENCY, parsed));
}

function publicState() {
  return {
    ...state,
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
  // [DATASET] 1458 total wallets
  const datasetMatch = line.match(/\[DATASET\]\s+(\d+)\s+total wallets/i);
  if (datasetMatch) {
    state.total = parseInt(datasetMatch[1], 10);
    broadcastState("progress");
    return;
  }

  // [RESUME] 426/1458 already completed
  const resumeMatch = line.match(/\[RESUME\]\s+(\d+)\/(\d+)\s+already completed/i);
  if (resumeMatch) {
    const done = parseInt(resumeMatch[1], 10);
    state.skipped = done;
    state.completed = Math.max(state.completed, done);
    broadcastState("progress");
    return;
  }

  // [W1] [427/1458] SKIP 0x...
  const skipMatch = line.match(/\[W\d+\]\s+\[(\d+)\/(\d+)\]\s+SKIP/i);
  if (skipMatch) {
    state.skipped++;
    state.completed = Math.min(state.total || 999999, Math.max(state.completed + 1, parseInt(skipMatch[1], 10)));
    broadcastState("progress");
    return;
  }

  // [W1] [OK] positions=...
  const okMatch = line.match(/\[W\d+\]\s+\[OK\]/i);
  if (okMatch) {
    state.success++;
    state.completed = Math.min(state.total || 999999, state.completed + 1);
    broadcastState("progress");
    return;
  }

  // [W1] [FAIL] ...
  const failMatch = line.match(/\[W\d+\]\s+\[FAIL\]/i);
  if (failMatch) {
    state.failed++;
    state.completed = Math.min(state.total || 999999, state.completed + 1);
    broadcastState("progress");
    return;
  }

  // Final summary lines:
  const totalMatch = line.match(/^Total\s*:\s*(\d+)$/i);
  if (totalMatch) {
    state.total = parseInt(totalMatch[1], 10);
  }

  const successMatch = line.match(/^Success\s*:\s*(\d+)$/i);
  if (successMatch) {
    state.success = parseInt(successMatch[1], 10);
  }

  const failedMatch = line.match(/^Failed\s*:\s*(\d+)$/i);
  if (failedMatch) {
    state.failed = parseInt(failedMatch[1], 10);
  }

  const skippedMatch = line.match(/^Skipped\s*:\s*(\d+)$/i);
  if (skippedMatch) {
    state.skipped = parseInt(skippedMatch[1], 10);
  }

  const runtimeMatch = line.match(/^Runtime\s*:\s*([\d.]+)\s*sec$/i);
  if (runtimeMatch) {
    state.runtimeSeconds = parseFloat(runtimeMatch[1]);
    broadcastState("progress");
  }
}

function runChildProcess(command, args, env, lineParser = null) {
  return new Promise((resolve, reject) => {
    currentChild = spawn(command, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleChunk = (chunk) => {
      const lines = String(chunk).split("\n");
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          addLog(trimmed);
          if (lineParser) {
            lineParser(trimmed);
          }
        }
      }
    };

    currentChild.stdout.on("data", handleChunk);
    currentChild.stderr.on("data", handleChunk);

    currentChild.on("error", (error) => {
      currentChild = null;
      reject(error);
    });

    currentChild.on("exit", (code, signal) => {
      currentChild = null;
      resolve({ code, signal });
    });
  });
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

  if (!isResume) {
    state.total = 0;
    state.completed = 0;
    state.success = 0;
    state.failed = 0;
    state.skipped = 0;
    state.runtimeSeconds = 0;
    state.logs = [];
  }

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

    const enrichResult = await runChildProcess("npm", ["run", "enrich:fabriq"], enrichEnv, parseEnrichLine);

    if (state.status === "stopping") {
      state.status = "stopped";
      state.finishedAt = new Date().toISOString();
      addLog("[CONTROL] Enrichment stopped by user.");
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

    if (state.total > 0) {
      state.completed = state.total;
    }

    // ----------------------------------------------------
    // 2. Stage: merge
    // ----------------------------------------------------
    state.stage = "merge";
    addLog("[CONTROL] Enrichment completed. Running merge:fabriq...");
    broadcastState("stage");

    const mergeResult = await runChildProcess("npm", ["run", "merge:fabriq"], {});

    if (state.status === "stopping") {
      state.status = "stopped";
      state.finishedAt = new Date().toISOString();
      addLog("[CONTROL] Pipeline stopped by user during merge.");
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
    state.stage = "publish";
    addLog("[CONTROL] Merge completed. Running publish:wallets...");
    broadcastState("stage");

    const publishResult = await runChildProcess("npm", ["run", "publish:wallets"], {});

    if (state.status === "stopping") {
      state.status = "stopped";
      state.finishedAt = new Date().toISOString();
      addLog("[CONTROL] Pipeline stopped by user during publish.");
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

function stopPipeline() {
  if (!currentChild && state.status !== "running" && state.status !== "stopping") {
    return false;
  }

  state.status = "stopping";
  addLog("[CONTROL] Stopping Fabriq pipeline...");
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
        } catch {}
      }
    }, 4000);
  } else {
    state.status = "stopped";
    broadcastState("status");
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
    if (currentChild || state.status === "running" || state.status === "stopping") {
      json(request, response, 409, {
        error: "Fabriq refresh is already running",
        ...publicState(),
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
    if (currentChild || state.status === "running" || state.status === "stopping") {
      json(request, response, 409, {
        error: "Fabriq update is already running",
        ...publicState(),
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
  console.log(`Max workers: ${MAX_CONCURRENCY}`);
});