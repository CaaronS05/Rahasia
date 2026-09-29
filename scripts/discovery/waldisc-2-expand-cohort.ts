import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isFabriqDlmmPool } from "./core/fabriq-position-history.ts";

const DEFAULT_MAX_CLOSED_POSITIONS = 100;
const DEFAULT_HISTORY_DAYS = 90;

type WalletExpansionStatus =
    | "VALIDATED"
    | "ALREADY_VALIDATED"
    | "NO_CLOSED_POSITIONS"
    | "WORKLOAD_GUARD"
    | "MANUAL_REVIEW"
    | "DISCOVERY_FAILED"
    | "STRATEGY_FAILED"
    | "BEHAVIOUR_FAILED";

interface PreflightCandidate {
    wallet: string;
    status: string;
    fabriqPoolCount: number;
    dlmmPoolCount?: number;
    dlmmPools?: string[];
    legacyDlmmPoolCount?: number;
    legacyDlmmPools?: string[];
    closedPositionCount?: number;
    historyDays?: number;
    eligible: boolean;
    pagesFetched?: number;
    checkedAt?: string;
    error?: string | null;
}

interface WalletExpansionResult {
    wallet: string;
    status: WalletExpansionStatus;
    currentStatus?: WalletExpansionStatus;
    previousStatus?: WalletExpansionStatus | null;
    attemptCount?: number;
    lastAttemptAt?: string | null;
    stage?: "discovery" | "strategy" | "behaviour" | null;
    error?: string | null;
    dlmmPoolCount?: number;
    legacyDlmmPoolCount?: number;
    closedPositions?: number;
    maxClosedPositions?: number;
    uniquePools?: number;
    strategyCompleted?: number;
    strategySkipped?: number;
    strategyFailed?: number;
    partialHistoryPositions?: number;
    updatedAt: string;
    recentOutput?: string[];
}

interface CheckpointData {
    generatedAt: string;
    config?: {
        historyDays: number;
        maxClosedPositions: number;
        poolEligibilityRule: "FABRIQ_DLMM";
    };
    attempted: number;
    validated: number;
    manualReview: number;
    noClosedPositions: number;
    workloadGuard?: number;
    failed: number;
    results: WalletExpansionResult[];
}

interface CliArgs {
    limit?: number;
    wallet?: string;
    force: boolean;
    historyDays: number;
    maxClosedPositions: number;
    workers: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestampMs(ts: string | number | null | undefined): number | null {
    if (ts === null || ts === undefined || ts === "") return null;
    if (typeof ts === "number") {
        return ts > 1e11 ? ts : ts * 1000;
    }
    const str = String(ts).trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) {
        const num = Number(str);
        return num > 1e11 ? num : num * 1000;
    }
    const isoStr = str.includes("T") ? str : str.replace(" ", "T") + (str.endsWith("Z") ? "" : "Z");
    const parsed = Date.parse(isoStr);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);
    const options: CliArgs = {
        force: false,
        historyDays: DEFAULT_HISTORY_DAYS,
        maxClosedPositions: DEFAULT_MAX_CLOSED_POSITIONS,
        workers: 1,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--limit") {
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                options.limit = parseInt(next, 10);
                i++;
            }
        } else if (arg.startsWith("--limit=")) {
            options.limit = parseInt(arg.slice(8), 10);
        } else if (arg === "--wallet") {
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                options.wallet = next;
                i++;
            }
        } else if (arg.startsWith("--wallet=")) {
            options.wallet = arg.slice(9);
        } else if (arg === "--force") {
            options.force = true;
        } else if (arg === "--history-days") {
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                const parsed = parseInt(next, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                    options.historyDays = parsed;
                }
                i++;
            }
        } else if (arg.startsWith("--history-days=")) {
            const parsed = parseInt(arg.slice(15), 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                options.historyDays = parsed;
            }
        } else if (arg === "--max-closed-positions") {
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                const parsed = parseInt(next, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                    options.maxClosedPositions = parsed;
                }
                i++;
            }
        } else if (arg.startsWith("--max-closed-positions=")) {
            const parsed = parseInt(arg.slice(23), 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                options.maxClosedPositions = parsed;
            }
        } else if (arg === "--workers") {
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                const parsed = parseInt(next, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                    options.workers = parsed;
                }
                i++;
            }
        } else if (arg.startsWith("--workers=")) {
            const parsed = parseInt(arg.slice(10), 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                options.workers = parsed;
            }
        }
    }

    return options;
}

function loadEnvIfAvailable(): void {
    if (typeof (process as any).loadEnvFile === "function") {
        try {
            (process as any).loadEnvFile();
        } catch {}
    }

    if (!process.env.ALCHEMY_RPC_URL && fs.existsSync(".env")) {
        try {
            const envContent = fs.readFileSync(".env", "utf8");
            for (const line of envContent.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx > 0) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    let val = trimmed.slice(eqIdx + 1).trim();
                    if (
                        (val.startsWith('"') && val.endsWith('"')) ||
                        (val.startsWith("'") && val.endsWith("'"))
                    ) {
                        val = val.slice(1, -1);
                    }
                    if (!process.env[key]) {
                        process.env[key] = val;
                    }
                }
            }
        } catch {}
    }
}

function tryReadJson(filePath: string): any | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function sanitize(text: string): string {
    if (!text) return "";
    let s = text;
    s = s.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");
    s = s.replace(
        /(authorization|api[_-]?key|apikey|token|secret|password|alchemy[_-]?rpc[_-]?url)\s*[:=]\s*['"]?[^\s,'"\\&]+['"]?/gi,
        "$1=[REDACTED]"
    );
    s = s.replace(/ey[A-Za-z0-9-_]+\.ey[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, "[REDACTED_JWT]");
    s = s.replace(
        /https?:\/\/solana-[a-z0-9\-]+\.g\.alchemy\.com\/v2\/[A-Za-z0-9_\-]+/gi,
        "https://solana-mainnet.g.alchemy.com/v2/[REDACTED]"
    );
    s = s.replace(/https?:\/\/[^/\s:@]+:[^/\s:@]+@/gi, "https://[REDACTED]@");
    if (process.env.ALCHEMY_RPC_URL && process.env.ALCHEMY_RPC_URL.length > 10) {
        s = s.replaceAll(process.env.ALCHEMY_RPC_URL, "[REDACTED_ALCHEMY_RPC_URL]");
    }
    return s;
}

function extractErrorDetails(
    result: { status: number | null; stdout?: string; stderr?: string; error?: Error },
    fallback?: string
): { errorMessage: string; recentOutput: string[] } {
    if (result.error) {
        return {
            errorMessage: sanitize(result.error.message),
            recentOutput: [sanitize(result.error.stack || result.error.message)],
        };
    }

    const rawStdout = (result.stdout || "").trim();
    const rawStderr = (result.stderr || "").trim();
    const combined = [rawStderr, rawStdout].filter(Boolean).join("\n");
    const rawLines = combined
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    const nonSeparatorLines = rawLines.filter(
        (l) => !/^[=\-*#_~]{3,}$/.test(l)
    );

    const explicitErrors = nonSeparatorLines.filter((l) => {
        const lower = l.toLowerCase();
        return (
            lower.includes("[fatal error]") ||
            lower.includes("error:") ||
            lower.includes("[error]") ||
            lower.includes("failed:") ||
            lower.includes("unsupported")
        );
    });

    let bestErrorMessage = "";
    if (explicitErrors.length > 0) {
        bestErrorMessage = explicitErrors[explicitErrors.length - 1];
    } else if (nonSeparatorLines.length > 0) {
        bestErrorMessage = nonSeparatorLines[nonSeparatorLines.length - 1];
    } else {
        bestErrorMessage = fallback || `Process exited with code ${result.status ?? "unknown"}`;
    }

    const recentOutput = nonSeparatorLines.slice(-30).map(sanitize);

    return {
        errorMessage: sanitize(bestErrorMessage),
        recentOutput,
    };
}

function isTransientAuthFailure(result: { status: number | null; stdout?: string; stderr?: string; error?: Error }): boolean {
    const text = `${result.error?.message ?? ""} ${result.stderr ?? ""} ${result.stdout ?? ""}`.toLowerCase();
    return text.includes("401") || text.includes("unauthorized");
}

function runChildScript(
    scriptRelativePath: string,
    args: string[]
): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
} {
    const fullPath = path.resolve(scriptRelativePath);
    const spawnArgs = ["--experimental-strip-types", fullPath, ...args];

    const result = spawnSync(process.execPath, spawnArgs, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: "pipe",
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
    });

    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
    };
}

async function runStageWithTransientRetry(
    stageLabel: string,
    scriptPath: string,
    args: string[]
): Promise<{
    result: { status: number | null; stdout: string; stderr: string; error?: Error };
    elapsed: string;
}> {
    console.log(`  ${stageLabel} : RUNNING...`);
    let start = Date.now();
    let result = runChildScript(scriptPath, args);
    let elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if ((result.status !== 0 || result.error) && isTransientAuthFailure(result)) {
        console.log(`  ${stageLabel} : FAILED — transient 401 detected`);
        console.log(`  ${stageLabel} : retrying once with fresh process in 5s...`);
        await sleep(5000);
        console.log(`  ${stageLabel} : RETRY RUNNING...`);
        start = Date.now();
        result = runChildScript(scriptPath, args);
        elapsed = ((Date.now() - start) / 1000).toFixed(1);
    }

    return { result, elapsed };
}

function validateWalletBehaviour(data: any): { valid: boolean; reason?: string } {
    if (!data || typeof data !== "object") {
        return { valid: false, reason: "Root is not an object or is null" };
    }

    if (typeof data.wallet !== "string" || data.wallet.trim().length === 0) {
        return { valid: false, reason: "Missing or invalid 'wallet' string" };
    }

    if (!data.coverage || typeof data.coverage !== "object") {
        return { valid: false, reason: "Missing or invalid 'coverage' object" };
    }

    if (
        typeof data.coverage.totalClosedPositions !== "number" ||
        !Number.isFinite(data.coverage.totalClosedPositions) ||
        data.coverage.totalClosedPositions <= 0
    ) {
        return {
            valid: false,
            reason: `coverage.totalClosedPositions must be a positive number (${data.coverage.totalClosedPositions})`,
        };
    }

    if (data.coverage.completeStrategyCoverage !== true) {
        return {
            valid: false,
            reason: `coverage.completeStrategyCoverage is not true (${data.coverage.completeStrategyCoverage})`,
        };
    }

    if (
        typeof data.coverage.strategyCoveragePct !== "number" ||
        data.coverage.strategyCoveragePct < 100
    ) {
        return {
            valid: false,
            reason: `strategy coverage is incomplete (strategyCoveragePct: ${data.coverage.strategyCoveragePct})`,
        };
    }

    if (!Array.isArray(data.positions)) {
        return { valid: false, reason: "Missing 'positions' array" };
    }

    if (data.positions.length !== data.coverage.totalClosedPositions) {
        return {
            valid: false,
            reason: `positions array length (${data.positions.length}) does not match coverage.totalClosedPositions (${data.coverage.totalClosedPositions})`,
        };
    }

    const requiredSections = [
        "rangeBehaviour",
        "placementBehaviour",
        "rebalanceBehaviour",
        "performance",
        "capitalBehaviour",
        "holdingBehaviour",
    ];

    for (const section of requiredSections) {
        if (!data[section] || typeof data[section] !== "object") {
            return {
                valid: false,
                reason: `Missing or invalid required section '${section}'`,
            };
        }
    }

    return { valid: true };
}

function checkExistingWalletBehaviour(wallet: string): {
    valid: boolean;
    reason?: string;
    totalClosedPositions?: number;
    uniquePoolCount?: number;
    generatedAt?: string;
} {
    const behaviourPath = path.resolve(
        "data/discovery/waldisc-2",
        wallet,
        "wallet-behaviour.json"
    );

    if (!fs.existsSync(behaviourPath)) {
        return { valid: false, reason: "wallet-behaviour.json does not exist" };
    }

    let data: any;
    try {
        const raw = fs.readFileSync(behaviourPath, "utf8");
        data = JSON.parse(raw);
    } catch (err: any) {
        return { valid: false, reason: `Failed to read/parse wallet-behaviour.json: ${err.message}` };
    }

    const validation = validateWalletBehaviour(data);
    if (!validation.valid) {
        return { valid: false, reason: validation.reason };
    }

    return {
        valid: true,
        totalClosedPositions: data.coverage.totalClosedPositions,
        uniquePoolCount: data.coverage.uniquePoolCount ?? data.poolDistribution?.length ?? 0,
        generatedAt: data.generatedAt,
    };
}

let activeConfig:
    | {
          historyDays: number;
          maxClosedPositions: number;
          poolEligibilityRule: "FABRIQ_DLMM";
      }
    | undefined;

function computeCheckpointData(
    results: WalletExpansionResult[],
    config?: {
        historyDays: number;
        maxClosedPositions: number;
        poolEligibilityRule?: string;
    }
): CheckpointData {
    const effectiveConfig = config || activeConfig;
    let validated = 0;
    let manualReview = 0;
    let noClosedPositions = 0;
    let workloadGuard = 0;
    let failed = 0;
    let attempted = 0;

    for (const r of results) {
        if (r.status === "VALIDATED" || r.status === "ALREADY_VALIDATED") {
            validated++;
        }
        if (r.status === "MANUAL_REVIEW") {
            manualReview++;
        }
        if (r.status === "NO_CLOSED_POSITIONS") {
            noClosedPositions++;
        }
        if (r.status === "WORKLOAD_GUARD") {
            workloadGuard++;
        }
        if (
            r.status === "DISCOVERY_FAILED" ||
            r.status === "STRATEGY_FAILED" ||
            r.status === "BEHAVIOUR_FAILED"
        ) {
            failed++;
        }
        if (r.status !== "ALREADY_VALIDATED") {
            attempted++;
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        ...(effectiveConfig
            ? {
                  config: {
                      historyDays: effectiveConfig.historyDays,
                      maxClosedPositions: effectiveConfig.maxClosedPositions,
                      poolEligibilityRule: "FABRIQ_DLMM",
                  },
              }
            : {}),
        attempted,
        validated,
        manualReview,
        noClosedPositions,
        workloadGuard,
        failed,
        results,
    };
}

async function main() {
    loadEnvIfAvailable();
    const cli = parseCliArgs();
    activeConfig = {
        historyDays: cli.historyDays,
        maxClosedPositions: cli.maxClosedPositions,
        poolEligibilityRule: "FABRIQ_DLMM",
    };

    console.log("==================================================");
    console.log("WALDISC-2 STEP 1F.3 — VALIDATED COHORT EXPANSION");
    console.log("==================================================");
    console.log(`History Window         : ${cli.historyDays} days`);
    console.log(`Max Closed Positions   : ${cli.maxClosedPositions}`);
    console.log(`Workers                : ${cli.workers}`);
    if (cli.wallet) {
        console.log(`Target Wallet       : ${cli.wallet}`);
    }
    if (cli.limit !== undefined) {
        console.log(`Limit (New Attempts): ${cli.limit}`);
    }
    console.log(`Force Reprocessing  : ${cli.force ? "YES" : "NO"}`);
    console.log("--------------------------------------------------");

    // 1. Source of Candidates: data/discovery/waldisc-2/legacy-preflight.json
    const preflightPath = path.resolve("data/discovery/waldisc-2/legacy-preflight.json");
    if (!fs.existsSync(preflightPath)) {
        throw new Error(`Preflight file not found: ${preflightPath}`);
    }

    const preflightData = tryReadJson(preflightPath);
    if (!preflightData || !Array.isArray(preflightData.results)) {
        throw new Error(`Invalid preflight schema: 'results' array missing in ${preflightPath}`);
    }

    const preflightConfig = preflightData.config;
    const isPreflightConfigCompatible =
        preflightConfig &&
        preflightConfig.poolEligibilityRule === "FABRIQ_DLMM" &&
        preflightConfig.historyDays === cli.historyDays &&
        preflightConfig.maxClosedPositions === cli.maxClosedPositions;

    if (!isPreflightConfigCompatible && preflightConfig) {
        console.log(
            `[CONFIG MISMATCH] Preflight file config (rule: ${preflightConfig.poolEligibilityRule ?? "CANONICAL_LEGACY"}, ${preflightConfig.historyDays ?? "legacy"}d, max ${preflightConfig.maxClosedPositions ?? "legacy"}) differs from requested (FABRIQ_DLMM, ${cli.historyDays}d, max ${cli.maxClosedPositions}).`
        );
        console.log(`[CONFIG MISMATCH] Candidates will be re-evaluated under new FABRIQ_DLMM configuration.\n`);
    }

    // Determine eligible preflight records:
    // If config matches, trust preflight eligible === true.
    // If config differs, re-evaluate candidate eligibility:
    const eligibleRecords: PreflightCandidate[] = (preflightData.results as any[]).filter(
        (r) => {
            if (!r || typeof r.wallet !== "string" || r.status !== "completed") return false;
            const pools = typeof r.dlmmPoolCount === "number" ? r.dlmmPoolCount : (typeof r.legacyDlmmPoolCount === "number" ? r.legacyDlmmPoolCount : 0);
            if (pools <= 0) return false;

            if (isPreflightConfigCompatible) {
                return r.eligible === true;
            }

            if (preflightConfig && preflightConfig.poolEligibilityRule === "FABRIQ_DLMM" && preflightConfig.historyDays === cli.historyDays) {
                const closed = typeof r.closedPositionCount === "number" ? r.closedPositionCount : 0;
                return closed > 0 && closed <= cli.maxClosedPositions;
            }

            return true;
        }
    );

    // Deterministic sorting: dlmmPoolCount descending then wallet lexical ascending
    eligibleRecords.sort((a, b) => {
        const aPools = a.dlmmPoolCount ?? a.legacyDlmmPoolCount ?? 0;
        const bPools = b.dlmmPoolCount ?? b.legacyDlmmPoolCount ?? 0;
        if (bPools !== aPools) {
            return bPools - aPools;
        }
        return a.wallet.localeCompare(b.wallet);
    });

    console.log(`Eligible Candidates : ${eligibleRecords.length} from preflight`);

    // 2. Load prior checkpoint results if present: data/discovery/waldisc-2/cohort-expansion.json
    const checkpointPath = path.resolve("data/discovery/waldisc-2/cohort-expansion.json");
    const existingCheckpoint: CheckpointData | null = tryReadJson(checkpointPath);

    const resultsMap = new Map<string, WalletExpansionResult>();
    const isCheckpointCompatible =
        existingCheckpoint?.config &&
        existingCheckpoint.config.poolEligibilityRule === "FABRIQ_DLMM" &&
        existingCheckpoint.config.historyDays === cli.historyDays &&
        existingCheckpoint.config.maxClosedPositions === cli.maxClosedPositions;

    if (existingCheckpoint && Array.isArray(existingCheckpoint.results)) {
        if (!isCheckpointCompatible && existingCheckpoint.config) {
            console.log(
                `[CONFIG MISMATCH] Existing expansion checkpoint (rule: ${existingCheckpoint.config.poolEligibilityRule ?? "CANONICAL_LEGACY"}, ${existingCheckpoint.config.historyDays}d, max ${existingCheckpoint.config.maxClosedPositions}) differs from requested (FABRIQ_DLMM, ${cli.historyDays}d, max ${cli.maxClosedPositions}).`
            );
            console.log(`[CONFIG MISMATCH] Prior eligibility/workload guard results will be re-evaluated under new configuration.\n`);
        }

        for (const item of existingCheckpoint.results) {
            if (item && typeof item.wallet === "string") {
                if (isCheckpointCompatible) {
                    resultsMap.set(item.wallet, item);
                } else {
                    if (item.status === "VALIDATED" || item.status === "ALREADY_VALIDATED") {
                        resultsMap.set(item.wallet, item);
                    }
                }
            }
        }
    }

    // 3. Automatically detect already-valid wallets from disk
    let detectedAlreadyValidCount = 0;
    for (const rec of eligibleRecords) {
        const behaviourCheck = checkExistingWalletBehaviour(rec.wallet);
        if (behaviourCheck.valid) {
            detectedAlreadyValidCount++;
            const poolCount = rec.dlmmPoolCount ?? rec.legacyDlmmPoolCount ?? 0;
            if (!resultsMap.has(rec.wallet)) {
                resultsMap.set(rec.wallet, {
                    wallet: rec.wallet,
                    status: "ALREADY_VALIDATED",
                    currentStatus: "ALREADY_VALIDATED",
                    previousStatus: null,
                    attemptCount: 1,
                    lastAttemptAt: null,
                    stage: null,
                    error: null,
                    dlmmPoolCount: poolCount,
                    legacyDlmmPoolCount: poolCount,
                    closedPositions: behaviourCheck.totalClosedPositions,
                    uniquePools: behaviourCheck.uniquePoolCount,
                    updatedAt: behaviourCheck.generatedAt || new Date().toISOString(),
                });
            } else {
                const existing = resultsMap.get(rec.wallet)!;
                if (existing.status !== "VALIDATED" && existing.status !== "ALREADY_VALIDATED") {
                    existing.previousStatus = existing.currentStatus ?? existing.status;
                    existing.status = "VALIDATED";
                    existing.currentStatus = "VALIDATED";
                    existing.closedPositions = behaviourCheck.totalClosedPositions;
                    existing.uniquePools = behaviourCheck.uniquePoolCount;
                    existing.dlmmPoolCount = poolCount;
                    existing.legacyDlmmPoolCount = poolCount;
                    existing.error = null;
                    existing.stage = null;
                    existing.updatedAt = behaviourCheck.generatedAt || new Date().toISOString();
                }
            }
        }
    }

    console.log(`Already Validated   : ${detectedAlreadyValidCount} wallet(s) detected on disk`);

    // Write baseline checkpoint state
    atomicWriteJson(
        checkpointPath,
        computeCheckpointData(Array.from(resultsMap.values()))
    );

    // 4. Select wallets to process
    let selectedCandidates: PreflightCandidate[] = [];

    if (cli.wallet) {
        const found = eligibleRecords.find((r) => r.wallet === cli.wallet);
        if (!found) {
            const anyPreflight = (preflightData.results as any[]).find((r) => r.wallet === cli.wallet);
            if (!anyPreflight) {
                throw new Error(
                    `Wallet '${cli.wallet}' not found in preflight results.`
                );
            }
            const candPools = anyPreflight.dlmmPoolCount ?? anyPreflight.legacyDlmmPoolCount ?? 0;
            if (anyPreflight.status !== "completed" || anyPreflight.eligible !== true || !(candPools > 0)) {
                throw new Error(
                    `Wallet '${cli.wallet}' is ineligible in preflight: status=${anyPreflight.status}, eligible=${anyPreflight.eligible}, dlmmPoolCount=${candPools}`
                );
            }
        }
        selectedCandidates = [found!];
    } else {
        selectedCandidates = eligibleRecords;
    }

    // Filter according to validation status and --limit
    const candidatesToAttempt: PreflightCandidate[] = [];

    for (const cand of selectedCandidates) {
        const isCurrentlyValid = checkExistingWalletBehaviour(cand.wallet).valid;

        if (isCurrentlyValid && !cli.force) {
            console.log(`[SKIP] Wallet ${cand.wallet} is already validated. Use --force to reprocess.`);
            continue;
        }

        // On rerun without --force and without specific --wallet:
        if (!cli.force && !cli.wallet) {
            const prior = resultsMap.get(cand.wallet);
            if (prior) {
                if (prior.status === "VALIDATED" || prior.status === "ALREADY_VALIDATED") {
                    console.log(`[SKIP] Wallet ${cand.wallet} is already validated. Use --force to reprocess.`);
                    continue;
                }
                if (prior.status === "MANUAL_REVIEW") {
                    console.log(`[SKIP] Wallet ${cand.wallet} requires MANUAL_REVIEW. Use --force or --wallet to reprocess.`);
                    continue;
                }
                if (prior.status === "NO_CLOSED_POSITIONS") {
                    if (isCheckpointCompatible) {
                        console.log(`[SKIP] Wallet ${cand.wallet} has NO_CLOSED_POSITIONS. Use --force or --wallet to reprocess.`);
                        continue;
                    }
                    console.log(`[RE-EVALUATE] Wallet ${cand.wallet} previously had NO_CLOSED_POSITIONS under different config. Re-evaluating.`);
                }
                if (prior.status === "WORKLOAD_GUARD") {
                    const knownClosed = prior.closedPositions ?? (DEFAULT_MAX_CLOSED_POSITIONS + 1);
                    if (isCheckpointCompatible && cli.maxClosedPositions < knownClosed) {
                        console.log(
                            `[SKIP] Wallet ${cand.wallet} deferred by WORKLOAD_GUARD (${prior.closedPositions ?? "large"} closed positions exceeds limit of ${cli.maxClosedPositions}). Use higher --max-closed-positions to process.`
                        );
                        continue;
                    }
                    console.log(
                        `[WORKLOAD ELIGIBLE] Wallet ${cand.wallet} previously deferred by WORKLOAD_GUARD, but eligible under requested config (${cli.maxClosedPositions} max positions, ${cli.historyDays}d). Re-evaluating.`
                    );
                }
                // DISCOVERY_FAILED, STRATEGY_FAILED, and BEHAVIOUR_FAILED remain eligible for retry
                console.log(`[RETRY ELIGIBLE] Wallet ${cand.wallet} previously failed (${prior.status}). Eligible for retry.`);
            }
        }

        candidatesToAttempt.push(cand);
        if (cli.limit !== undefined && candidatesToAttempt.length >= cli.limit) {
            break;
        }
    }

    console.log(`Scheduled to Attempt: ${candidatesToAttempt.length} wallet(s)\n`);

    // 5. Execute pipeline sequentially for each scheduled wallet
    let index = 0;
    for (const cand of candidatesToAttempt) {
        index++;
        const wallet = cand.wallet;
        const candidatePoolCount = cand.dlmmPoolCount ?? cand.legacyDlmmPoolCount ?? 0;
        console.log("==================================================");
        console.log(`[${index}/${candidatesToAttempt.length}] WALLET: ${wallet}`);
        console.log(`DLMM Pools          : ${candidatePoolCount}`);
        console.log("--------------------------------------------------");

        const walletOutDir = path.resolve("data/discovery/waldisc-2", wallet);

        // Track attempt history
        const priorRecord = resultsMap.get(wallet);
        const previousStatus = priorRecord ? (priorRecord.currentStatus ?? priorRecord.status) : null;
        const attemptCount = (priorRecord?.attemptCount ?? (priorRecord ? 1 : 0)) + 1;
        const lastAttemptAt = priorRecord?.updatedAt ?? priorRecord?.lastAttemptAt ?? null;

        // ----------------------------------------------------
        // STAGE 1 — DISCOVERY
        // ----------------------------------------------------
        const { result: discResult, elapsed: discElapsed } =
            await runStageWithTransientRetry(
                "Stage 1 (Discovery)",
                "scripts/discovery/waldisc-2-test-one-wallet.ts",
                ["--wallet", wallet, "--position-batch-size", "10"]
            );

        if (discResult.status !== 0 || discResult.error) {
            const err = extractErrorDetails(
                discResult,
                `Discovery script failed with exit code ${discResult.status}`
            );
            console.log(`  Stage 1 (Discovery) : FAILED (${discElapsed}s)`);
            console.log(`  Error               : ${err.errorMessage}`);
            console.log(`  RESULT              : DISCOVERY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "DISCOVERY_FAILED",
                currentStatus: "DISCOVERY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "discovery",
                error: err.errorMessage,
                dlmmPoolCount: candidatePoolCount,
                legacyDlmmPoolCount: candidatePoolCount,
                updatedAt: new Date().toISOString(),
                recentOutput: err.recentOutput,
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        // Validate ACTUAL generated discovery outputs
        const summaryFile = path.join(walletOutDir, "summary.json");
        const poolsFile = path.join(walletOutDir, "pools.json");
        const positionsFile = path.join(walletOutDir, "positions.json");

        const summaryData = tryReadJson(summaryFile);
        const poolsData = tryReadJson(poolsFile);
        const positionsData = tryReadJson(positionsFile);

        if (!summaryData || !Array.isArray(poolsData) || !Array.isArray(positionsData)) {
            console.log(`  Stage 1 (Discovery) : FAILED - Invalid/Missing output JSON files`);
            console.log(`  RESULT              : DISCOVERY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "DISCOVERY_FAILED",
                currentStatus: "DISCOVERY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "discovery",
                error: "Discovery output files (summary.json, pools.json, positions.json) missing or invalid",
                dlmmPoolCount: candidatePoolCount,
                legacyDlmmPoolCount: candidatePoolCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const dlmmPoolIdSet = new Set<string>();
        for (const p of poolsData) {
            if (p && isFabriqDlmmPool(p)) {
                const poolId = p.pool_id || p.poolId || p.pool?.id || p.id;
                if (poolId) dlmmPoolIdSet.add(String(poolId).trim());
            }
        }

        const cutoffMs = Date.now() - cli.historyDays * 86400 * 1000;
        const dlmmPoolsInWindow = new Set<string>();
        let closedPositionCount = 0;

        for (const p of positionsData) {
            if (!p) continue;
            const isClosed = String(p.status || "").toUpperCase() === "CLOSED" || p.hasClose === true;
            if (!isClosed) continue;

            const poolAddr = String(p.pool || p.pool_id || "").trim();
            if (!poolAddr) continue;
            if (!dlmmPoolIdSet.has(poolAddr) && !isFabriqDlmmPool(p)) continue;

            const closeTs = p.closedAt || p.fabriqSummary?.latestCloseAt || p.lastSeenAt;
            const closeMs = parseTimestampMs(closeTs);
            if (closeMs !== null && closeMs >= cutoffMs) {
                closedPositionCount++;
                dlmmPoolsInWindow.add(poolAddr);
            }
        }

        const dlmmPoolCount = dlmmPoolsInWindow.size;
        const partialHistoryCount =
            typeof summaryData.positionsPartialHistory === "number"
                ? summaryData.positionsPartialHistory
                : 0;

        if (dlmmPoolCount <= 0) {
            console.log(`  Stage 1 (Discovery) : FAILED - Fabriq DLMM pool count is ${dlmmPoolCount} in ${cli.historyDays}-day window`);
            console.log(`  RESULT              : DISCOVERY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "DISCOVERY_FAILED",
                currentStatus: "DISCOVERY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "discovery",
                error: `Fabriq DLMM pool count is ${dlmmPoolCount} in ${cli.historyDays}-day window (expected > 0)`,
                dlmmPoolCount: 0,
                legacyDlmmPoolCount: 0,
                closedPositions: closedPositionCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()), cli)
            );
            continue;
        }

        if (partialHistoryCount > 0) {
            console.log(`  Stage 1 (Discovery) : MANUAL_REVIEW (${partialHistoryCount} partial-history position(s))`);
            console.log(`  RESULT              : MANUAL_REVIEW\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "MANUAL_REVIEW",
                currentStatus: "MANUAL_REVIEW",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "discovery",
                error: `Observed ${partialHistoryCount} partial-history position(s); manual review required`,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                partialHistoryPositions: partialHistoryCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()), cli)
            );
            continue;
        }

        if (closedPositionCount === 0) {
            console.log(`  Stage 1 (Discovery) : NO_CLOSED_POSITIONS (${dlmmPoolCount} pools, 0 closed positions in ${cli.historyDays}d)`);
            console.log(`  RESULT              : NO_CLOSED_POSITIONS\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "NO_CLOSED_POSITIONS",
                currentStatus: "NO_CLOSED_POSITIONS",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "discovery",
                error: null,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: 0,
                partialHistoryPositions: 0,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()), cli)
            );
            continue;
        }

        if (closedPositionCount > cli.maxClosedPositions) {
            console.log(`  Workload Guard      : DEFERRED`);
            console.log(
                `  Reason              : ${closedPositionCount} closed positions exceeds limit of ${cli.maxClosedPositions}`
            );
            console.log(`  RESULT              : WORKLOAD_GUARD\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "WORKLOAD_GUARD",
                currentStatus: "WORKLOAD_GUARD",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: null,
                error: null,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                maxClosedPositions: cli.maxClosedPositions,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()), cli)
            );
            continue;
        }

        console.log(
            `  Stage 1 (Discovery) : PASS (${dlmmPoolCount} pools, ${closedPositionCount} closed positions, ${discElapsed}s)`
        );
        console.log(`DLMM Pools             : ${dlmmPoolCount}`);
        console.log(`Closed Positions       : ${closedPositionCount}`);
        console.log(`History Window         : ${cli.historyDays} days\n`);

        // ----------------------------------------------------
        // STAGE 2 — STRATEGY
        // ----------------------------------------------------
        const { result: stratResult, elapsed: stratElapsed } =
            await runStageWithTransientRetry(
                "Stage 2 (Strategy) ",
                "scripts/discovery/waldisc-2-run-wallet-strategy.ts",
                ["--wallet", wallet]
            );

        if (stratResult.status !== 0 || stratResult.error) {
            const err = extractErrorDetails(
                stratResult,
                `Strategy batch runner failed with exit code ${stratResult.status}`
            );
            console.log(`  Stage 2 (Strategy)  : FAILED (${stratElapsed}s)`);
            console.log(`  Error               : ${err.errorMessage}`);
            console.log(`  RESULT              : STRATEGY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "STRATEGY_FAILED",
                currentStatus: "STRATEGY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "strategy",
                error: err.errorMessage,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                updatedAt: new Date().toISOString(),
                recentOutput: err.recentOutput,
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const stratSummaryFile = path.join(walletOutDir, "strategy-batch-summary.json");
        const stratSummaryData = tryReadJson(stratSummaryFile);

        if (!stratSummaryData) {
            console.log(`  Stage 2 (Strategy)  : FAILED - Missing strategy-batch-summary.json`);
            console.log(`  RESULT              : STRATEGY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "STRATEGY_FAILED",
                currentStatus: "STRATEGY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "strategy",
                error: "Missing strategy-batch-summary.json output after strategy stage execution",
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const stratFailed = Number(stratSummaryData.failed ?? 0);
        const stratCompleted = Number(stratSummaryData.completed ?? 0);
        const stratSkipped = Number(stratSummaryData.skipped ?? 0);

        if (stratFailed !== 0) {
            const msg = `Strategy run reported ${stratFailed} failed position(s)`;
            console.log(`  Stage 2 (Strategy)  : FAILED (${msg})`);
            console.log(`  RESULT              : STRATEGY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "STRATEGY_FAILED",
                currentStatus: "STRATEGY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "strategy",
                error: msg,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                strategyCompleted: stratCompleted,
                strategySkipped: stratSkipped,
                strategyFailed: stratFailed,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const totalStratExpected =
            typeof stratSummaryData.totalClosedPositions === "number" && stratSummaryData.totalClosedPositions > 0
                ? stratSummaryData.totalClosedPositions
                : closedPositionCount;

        if (stratCompleted + stratSkipped !== totalStratExpected) {
            const msg = `Strategy coverage mismatch: Completed (${stratCompleted}) + Skipped (${stratSkipped}) !== total closed positions (${totalStratExpected})`;
            console.log(`  Stage 2 (Strategy)  : FAILED (${msg})`);
            console.log(`  RESULT              : STRATEGY_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "STRATEGY_FAILED",
                currentStatus: "STRATEGY_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "strategy",
                error: msg,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                strategyCompleted: stratCompleted,
                strategySkipped: stratSkipped,
                strategyFailed: stratFailed,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        console.log(
            `  Stage 2 (Strategy)  : PASS (${closedPositionCount} positions: ${stratCompleted} completed, ${stratSkipped} skipped, 0 failed, ${stratElapsed}s)`
        );

        // ----------------------------------------------------
        // STAGE 3 — BEHAVIOUR
        // ----------------------------------------------------
        const { result: behResult, elapsed: behElapsed } =
            await runStageWithTransientRetry(
                "Stage 3 (Behaviour)",
                "scripts/discovery/waldisc-2-build-wallet-behaviour.ts",
                ["--wallet", wallet]
            );

        if (behResult.status !== 0 || behResult.error) {
            const err = extractErrorDetails(
                behResult,
                `Behaviour aggregation script failed with exit code ${behResult.status}`
            );
            console.log(`  Stage 3 (Behaviour) : FAILED (${behElapsed}s)`);
            console.log(`  Error               : ${err.errorMessage}`);
            console.log(`  RESULT              : BEHAVIOUR_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "BEHAVIOUR_FAILED",
                currentStatus: "BEHAVIOUR_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "behaviour",
                error: err.errorMessage,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                strategyCompleted: stratCompleted,
                strategySkipped: stratSkipped,
                updatedAt: new Date().toISOString(),
                recentOutput: err.recentOutput,
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const behaviourFile = path.join(walletOutDir, "wallet-behaviour.json");
        const behaviourData = tryReadJson(behaviourFile);

        if (!behaviourData) {
            console.log(`  Stage 3 (Behaviour) : FAILED - Missing wallet-behaviour.json`);
            console.log(`  RESULT              : BEHAVIOUR_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "BEHAVIOUR_FAILED",
                currentStatus: "BEHAVIOUR_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "behaviour",
                error: "Missing wallet-behaviour.json output after behaviour aggregation stage execution",
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const behaviourValidation = validateWalletBehaviour(behaviourData);
        if (!behaviourValidation.valid) {
            console.log(`  Stage 3 (Behaviour) : FAILED - Validation: ${behaviourValidation.reason}`);
            console.log(`  RESULT              : BEHAVIOUR_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "BEHAVIOUR_FAILED",
                currentStatus: "BEHAVIOUR_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "behaviour",
                error: behaviourValidation.reason || "wallet-behaviour.json failed validation",
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        if (behaviourData.coverage?.completeStrategyCoverage !== true) {
            const msg = "wallet-behaviour.json does not satisfy completeStrategyCoverage === true";
            console.log(`  Stage 3 (Behaviour) : FAILED (${msg})`);
            console.log(`  RESULT              : BEHAVIOUR_FAILED\n`);

            resultsMap.set(wallet, {
                wallet,
                status: "BEHAVIOUR_FAILED",
                currentStatus: "BEHAVIOUR_FAILED",
                previousStatus,
                attemptCount,
                lastAttemptAt,
                stage: "behaviour",
                error: msg,
                dlmmPoolCount,
                legacyDlmmPoolCount: dlmmPoolCount,
                closedPositions: closedPositionCount,
                updatedAt: new Date().toISOString(),
            });

            atomicWriteJson(
                checkpointPath,
                computeCheckpointData(Array.from(resultsMap.values()))
            );
            continue;
        }

        const uniquePoolCount =
            behaviourData.coverage?.uniquePoolCount ??
            behaviourData.poolDistribution?.length ??
            dlmmPoolCount;

        console.log(
            `  Stage 3 (Behaviour) : PASS (complete strategy coverage, ${uniquePoolCount} pools, ${behElapsed}s)`
        );
        console.log(`  RESULT              : VALIDATED\n`);

        resultsMap.set(wallet, {
            wallet,
            status: "VALIDATED",
            currentStatus: "VALIDATED",
            previousStatus,
            attemptCount,
            lastAttemptAt,
            stage: null,
            error: null,
            dlmmPoolCount,
            legacyDlmmPoolCount: dlmmPoolCount,
            closedPositions: closedPositionCount,
            uniquePools: uniquePoolCount,
            strategyCompleted: stratCompleted,
            strategySkipped: stratSkipped,
            strategyFailed: 0,
            partialHistoryPositions: 0,
            updatedAt: new Date().toISOString(),
        });

        atomicWriteJson(
            checkpointPath,
            computeCheckpointData(Array.from(resultsMap.values()))
        );
    }

    // 6. Final Summary Report
    const finalCheckpoint = computeCheckpointData(Array.from(resultsMap.values()), cli);
    atomicWriteJson(checkpointPath, finalCheckpoint);

    console.log("==================================================");
    console.log("COHORT EXPANSION SUMMARY");
    console.log("==================================================");
    console.log(`History Window      : ${cli.historyDays} days`);
    console.log(`Max Closed Positions: ${cli.maxClosedPositions}`);
    console.log(`Total Attempted     : ${finalCheckpoint.attempted}`);
    console.log(`Total Validated     : ${finalCheckpoint.validated}`);
    console.log(`Manual Review       : ${finalCheckpoint.manualReview}`);
    console.log(`No Closed Positions : ${finalCheckpoint.noClosedPositions}`);
    console.log(`Workload Guard      : ${finalCheckpoint.workloadGuard ?? 0}`);
    console.log(`Failed              : ${finalCheckpoint.failed}`);
    console.log(`Checkpoint Path     : ${checkpointPath}`);
    console.log("==================================================\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Cohort expansion runner failed: ${err.message}`);
    process.exit(1);
});
