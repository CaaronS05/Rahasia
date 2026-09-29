import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";

interface PositionSummaryRecord {
    position: string;
    pool: string;
    status: "completed" | "skipped" | "failed";
    lastCompletedStage: string | null;
    error: string | null;
}

interface BatchSummaryOutput {
    wallet: string;
    generatedAt: string;
    totalClosedPositions: number;
    attempted: number;
    completed: number;
    skipped: number;
    failed: number;
    positions: PositionSummaryRecord[];
}

interface StageDef {
    name: "verification" | "decode" | "range" | "normalize";
    scriptPath: string;
    outputPath: (wallet: string, position: string) => string;
    validate: (data: any, wallet: string, pool: string, position: string) => boolean;
}

function parseCliArgs(): Record<string, string> {
    const args = process.argv.slice(2);
    const options: Record<string, string> = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith("--")) {
                options[key] = next;
                i++;
            } else {
                options[key] = "true";
            }
        }
    }

    return options;
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
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
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

function validateVerificationOutput(
    data: any,
    expectedWallet: string,
    expectedPool: string,
    expectedPosition: string
): boolean {
    if (!data || typeof data !== "object") return false;
    if (data.wallet !== expectedWallet) return false;
    if (data.position !== expectedPosition) return false;
    if (expectedPool && data.pool !== expectedPool) return false;
    if (data.allTransactionsFetched !== true) return false;
    if (data.allEventsVerified !== true) return false;
    if (typeof data.transactionsFailed === "number" && data.transactionsFailed > 0) return false;
    if (typeof data.eventsUnverified === "number" && data.eventsUnverified > 0) return false;
    if (typeof data.eventsVerified !== "number" || data.eventsVerified <= 0) return false;
    if (!Array.isArray(data.results) || data.results.length === 0) return false;
    return true;
}

function validateStrategyOutput(
    data: any,
    expectedWallet: string,
    expectedPool: string,
    expectedPosition: string
): boolean {
    if (!data || typeof data !== "object") return false;
    if (data.wallet !== expectedWallet) return false;
    if (data.position !== expectedPosition) return false;
    if (expectedPool && data.pool !== expectedPool) return false;
    if (typeof data.decodeFailureCount === "number" && data.decodeFailureCount > 0) return false;
    if (!Array.isArray(data.instructions) || data.instructions.length === 0) return false;
    return true;
}

function validateDerivedOutput(
    data: any,
    expectedWallet: string,
    expectedPool: string,
    expectedPosition: string
): boolean {
    if (!data || typeof data !== "object") return false;
    if (data.wallet !== expectedWallet) return false;
    if (data.position !== expectedPosition) return false;
    if (expectedPool && data.pool !== expectedPool) return false;

    if (data.rangeAvailability === "NO_LIQUIDITY") {
        const placement = data.openingBuild || data.initialPlacement;
        if (placement && typeof placement === "object") {
            if (placement.lowerBin !== null || placement.upperBin !== null || placement.binCount !== null) {
                return false;
            }
        }
        if (!Array.isArray(data.timeline) || data.timeline.length === 0) return false;
        return true;
    }

    const placement = data.openingBuild || data.initialPlacement;
    if (!placement || typeof placement !== "object") return false;

    if (
        typeof placement.lowerBin !== "number" ||
        typeof placement.upperBin !== "number" ||
        typeof placement.binCount !== "number" ||
        !Number.isFinite(placement.lowerBin) ||
        !Number.isFinite(placement.upperBin) ||
        !Number.isFinite(placement.binCount)
    ) {
        return false;
    }

    const lowerBin = placement.lowerBin;
    const upperBin = placement.upperBin;
    const binCount = placement.binCount;

    if (lowerBin > upperBin) return false;
    if (binCount <= 0) return false;
    if (!Array.isArray(data.timeline) || data.timeline.length === 0) return false;
    return true;
}

function validateNormalizedOutput(
    data: any,
    expectedWallet: string,
    expectedPool: string,
    expectedPosition: string
): boolean {
    if (!data || typeof data !== "object") return false;
    if (data.wallet !== expectedWallet) return false;
    if (data.position !== expectedPosition) return false;
    if (expectedPool && data.pool !== expectedPool) return false;

    const binStep = Number(data.binStep);
    if (!Number.isFinite(binStep) || binStep <= 0) return false;

    if (data.rangeAvailability === "NO_LIQUIDITY") {
        if (!data.range || typeof data.range !== "object") return false;
        if (data.range.lowerBin !== null || data.range.upperBin !== null || data.range.binCount !== null) {
            return false;
        }
        return true;
    }

    if (!data.range || typeof data.range !== "object") return false;

    if (
        typeof data.range.lowerBin !== "number" ||
        typeof data.range.upperBin !== "number" ||
        typeof data.range.binCount !== "number" ||
        !Number.isFinite(data.range.lowerBin) ||
        !Number.isFinite(data.range.upperBin) ||
        !Number.isFinite(data.range.binCount)
    ) {
        return false;
    }

    const lowerBin = data.range.lowerBin;
    const upperBin = data.range.upperBin;
    const binCount = data.range.binCount;
    const rangeWidthPct = Number(data.range.rangeWidthPct);

    if (lowerBin > upperBin) return false;
    if (binCount <= 0) return false;
    if (!Number.isFinite(rangeWidthPct) || rangeWidthPct < 0) return false;

    return true;
}

const STAGES: StageDef[] = [
    {
        name: "verification",
        scriptPath: path.resolve("scripts/discovery/waldisc-2-verify-one-position.ts"),
        outputPath: (w, p) =>
            path.resolve("data/discovery/waldisc-2", w, "verification", `${p}.json`),
        validate: validateVerificationOutput,
    },
    {
        name: "decode",
        scriptPath: path.resolve(
            "scripts/discovery/waldisc-2-decode-one-position-strategy.ts"
        ),
        outputPath: (w, p) =>
            path.resolve("data/discovery/waldisc-2", w, "strategy", `${p}.json`),
        validate: validateStrategyOutput,
    },
    {
        name: "range",
        scriptPath: path.resolve("scripts/discovery/waldisc-2-build-one-position-range.ts"),
        outputPath: (w, p) =>
            path.resolve("data/discovery/waldisc-2", w, "strategy-derived", `${p}.json`),
        validate: validateDerivedOutput,
    },
    {
        name: "normalize",
        scriptPath: path.resolve(
            "scripts/discovery/waldisc-2-build-one-position-price-range.ts"
        ),
        outputPath: (w, p) =>
            path.resolve("data/discovery/waldisc-2", w, "strategy-normalized", `${p}.json`),
        validate: validateNormalizedOutput,
    },
];

async function main() {
    loadEnvIfAvailable();
    const args = parseCliArgs();

    const walletAddress =
        args.wallet || process.env.WALLET_ADDRESS || DEFAULT_WALLET;
    const force = args.force === "true";
    const positionFilter = args.position ? String(args.position).trim() : null;
    const limitArg = args.limit ? Number(args.limit) : 0;

    // Check that stage scripts exist
    for (const stage of STAGES) {
        if (!fs.existsSync(stage.scriptPath)) {
            throw new Error(`Required stage script not found: ${stage.scriptPath}`);
        }
    }

    // Read positions dataset
    const positionsFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "positions.json"
    );

    if (!fs.existsSync(positionsFilePath)) {
        throw new Error(
            `Positions dataset not found for wallet '${walletAddress}': ${positionsFilePath}`
        );
    }

    let rawPositions: any[];
    try {
        const rawContent = fs.readFileSync(positionsFilePath, "utf8");
        rawPositions = JSON.parse(rawContent);
    } catch (err: any) {
        throw new Error(`Failed to parse positions file ${positionsFilePath}: ${err.message}`);
    }

    if (!Array.isArray(rawPositions)) {
        throw new Error(`Invalid format in ${positionsFilePath}: expected JSON array`);
    }

    // Filter closed positions
    const seen = new Set<string>();
    const closedPositions: any[] = [];
    for (const p of rawPositions) {
        const status = String(p.status || "").trim().toUpperCase();
        if (status !== "CLOSED") continue;
        const posAddr = String(p.position || p.id || "").trim();
        if (!posAddr || seen.has(posAddr)) continue;
        seen.add(posAddr);
        closedPositions.push(p);
    }

    let targetPositions = closedPositions;

    if (positionFilter) {
        targetPositions = closedPositions.filter(
            (p: any) => p.position === positionFilter || p.id === positionFilter
        );
        if (targetPositions.length === 0) {
            const foundAny = rawPositions.find(
                (p: any) => p.position === positionFilter || p.id === positionFilter
            );
            if (!foundAny) {
                throw new Error(
                    `Position '${positionFilter}' not found in wallet dataset (${positionsFilePath})`
                );
            }
            throw new Error(
                `Position '${positionFilter}' found in wallet dataset, but status is '${foundAny.status}' (only CLOSED positions are supported)`
            );
        }
    }

    if (Number.isFinite(limitArg) && limitArg > 0) {
        targetPositions = targetPositions.slice(0, limitArg);
    }

    const summaryPositions: PositionSummaryRecord[] = [];
    let completedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < targetPositions.length; i++) {
        const pos = targetPositions[i];
        const positionAddress = String(pos.position || pos.id || "").trim();
        const poolAddress = String(pos.pool || pos.poolId || "").trim();

        console.log(`[${i + 1}/${targetPositions.length}] ${positionAddress}`);

        // Determine resume starting stage
        let startStageIndex = 0;

        if (!force) {
            let allValid = true;
            for (let s = 0; s < STAGES.length; s++) {
                const stage = STAGES[s];
                const outPath = stage.outputPath(walletAddress, positionAddress);
                const data = tryReadJson(outPath);
                if (data && stage.validate(data, walletAddress, poolAddress, positionAddress)) {
                    // valid
                } else {
                    allValid = false;
                    startStageIndex = s;
                    break;
                }
            }
            if (allValid) {
                startStageIndex = STAGES.length; // all 4 valid -> skip
            }
        }

        if (startStageIndex === STAGES.length) {
            for (const stage of STAGES) {
                console.log(`  ${stage.name.padEnd(12)} : SKIP`);
            }
            console.log(`  RESULT       : SKIPPED\n`);
            skippedCount++;
            summaryPositions.push({
                position: positionAddress,
                pool: poolAddress,
                status: "skipped",
                lastCompletedStage: "normalize",
                error: null,
            });
            continue;
        }

        let lastCompletedStage: string | null =
            startStageIndex > 0 ? STAGES[startStageIndex - 1].name : null;

        for (let s = 0; s < startStageIndex; s++) {
            console.log(`  ${STAGES[s].name.padEnd(12)} : SKIP`);
        }

        let positionFailed = false;
        let failedStageName = "";
        let failedErrorMessage = "";

        for (let s = startStageIndex; s < STAGES.length; s++) {
            const stage = STAGES[s];
            console.log(`  ${stage.name.padEnd(12)} : RUN`);

            try {
                const result = spawnSync(
                    process.execPath,
                    [
                        "--experimental-strip-types",
                        stage.scriptPath,
                        "--wallet",
                        walletAddress,
                        "--position",
                        positionAddress,
                    ],
                    {
                        env: { ...process.env },
                        stdio: "pipe",
                        encoding: "utf8",
                        maxBuffer: 50 * 1024 * 1024,
                    }
                );

                if (result.error) {
                    throw new Error(`Failed to spawn child process: ${result.error.message}`);
                }

                if (result.status !== 0) {
                    const stderr = (result.stderr || "").trim();
                    const stdout = (result.stdout || "").trim();
                    const combined = [stderr, stdout].filter(Boolean).join("\n");
                    const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
                    const nonSeparatorLines = lines.filter((l) => !/^[=\-*#_~]{3,}$/.test(l));

                    const fatalLine =
                        nonSeparatorLines.find((l) => l.includes("[FATAL ERROR]")) ||
                        nonSeparatorLines.find((l) => l.includes("Error:") || l.includes("[ERROR]")) ||
                        nonSeparatorLines.slice().reverse().find((l) => l.includes("Overall Verification") || l.includes("FAILED")) ||
                        nonSeparatorLines.slice().reverse().find((l) => l.toLowerCase().includes("failed") || l.includes("FAIL")) ||
                        nonSeparatorLines[nonSeparatorLines.length - 1] ||
                        `Process exited with code ${result.status}`;

                    throw new Error(fatalLine);
                }

                const outPath = stage.outputPath(walletAddress, positionAddress);
                const data = tryReadJson(outPath);
                if (!data || !stage.validate(data, walletAddress, poolAddress, positionAddress)) {
                    throw new Error(
                        `Output file '${outPath}' missing or failed validation after stage execution`
                    );
                }

                lastCompletedStage = stage.name;
            } catch (err: any) {
                positionFailed = true;
                failedStageName = stage.name;
                failedErrorMessage = err.message || String(err);
                break;
            }
        }

        if (positionFailed) {
            console.log(
                `  RESULT       : FAILED (stage: ${failedStageName}, error: ${failedErrorMessage})\n`
            );
            failedCount++;
            summaryPositions.push({
                position: positionAddress,
                pool: poolAddress,
                status: "failed",
                lastCompletedStage,
                error: failedErrorMessage,
            });
        } else {
            console.log(`  RESULT       : COMPLETED\n`);
            completedCount++;
            summaryPositions.push({
                position: positionAddress,
                pool: poolAddress,
                status: "completed",
                lastCompletedStage: "normalize",
                error: null,
            });
        }
    }

    const summaryFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy-batch-summary.json"
    );

    const summaryData: BatchSummaryOutput = {
        wallet: walletAddress,
        generatedAt: new Date().toISOString(),
        totalClosedPositions: closedPositions.length,
        attempted: targetPositions.length,
        completed: completedCount,
        skipped: skippedCount,
        failed: failedCount,
        positions: summaryPositions,
    };

    atomicWriteJson(summaryFilePath, summaryData);

    console.log("========================================");
    console.log("WALDISC-2 STEP 1D — WALLET STRATEGY BATCH");
    console.log("========================================");
    console.log(`Closed Positions : ${targetPositions.length}`);
    console.log(`Completed        : ${completedCount}`);
    console.log(`Skipped          : ${skippedCount}`);
    console.log(`Failed           : ${failedCount}`);
    console.log("========================================\n");

    if (failedCount > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Strategy batch runner failed: ${err.message}`);
    process.exit(1);
});
