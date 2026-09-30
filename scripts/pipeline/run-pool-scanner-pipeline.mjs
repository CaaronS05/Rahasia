import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function getArg(name) {
    const index = process.argv.indexOf(name);

    if (index === -1) {
        return null;
    }

    return process.argv[index + 1] ?? null;
}

const TOKEN_CA =
    getArg("--token") ??
    process.env.TOKEN_CA;

if (!TOKEN_CA) {
    throw new Error(
        "Token CA diperlukan. Gunakan --token <TOKEN_CA>"
    );
}

const rawWorkers =
    getArg("--fabriq-workers") ??
    process.env.POOL_SCANNER_FABRIQ_CONCURRENCY ??
    "2";

const trimmedWorkers = String(rawWorkers).trim();

if (!/^[1-9]\d*$/.test(trimmedWorkers)) {
    throw new Error(
        `Invalid --fabriq-workers: "${rawWorkers}". Must be an integer >= 1.`
    );
}

const FABRIQ_CONCURRENCY = trimmedWorkers;

const BASE_DIR = path.join(
    "data",
    "discovery",
    "pool-scanner",
    TOKEN_CA
);

const WALLETS_PATH =
    path.join(
        BASE_DIR,
        "wallets.json"
    );

const FABRIQ_DIR =
    path.join(
        BASE_DIR,
        "fabriq"
    );

const FABRIQ_OUTPUT =
    path.join(
        FABRIQ_DIR,
        "enriched.json"
    );

const FABRIQ_CHECKPOINT =
    path.join(
        FABRIQ_DIR,
        "checkpoint.jsonl"
    );

const PIPELINE_STATE_PATH =
    path.join(
        BASE_DIR,
        "pipeline-state.json"
    );

async function writePipelineState(state) {
    await fs.mkdir(BASE_DIR, { recursive: true });
    const tempPath = `${PIPELINE_STATE_PATH}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = JSON.stringify(state, null, 2) + "\n";
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, PIPELINE_STATE_PATH);
}

async function readPipelineState() {
    try {
        const text = await fs.readFile(PIPELINE_STATE_PATH, "utf8");
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function run(
    command,
    args,
    env = {}
) {
    return new Promise(
        (resolve, reject) => {
            const child = spawn(
                command,
                args,
                {
                    cwd: process.cwd(),

                    env: {
                        ...process.env,
                        ...env,
                    },

                    stdio: "inherit",
                }
            );

            child.on(
                "error",
                reject
            );

            child.on(
                "exit",
                (code) => {
                    if (code === 0) {
                        resolve();
                        return;
                    }

                    reject(
                        new Error(
                            `Process failed with exit code ${code}`
                        )
                    );
                }
            );
        }
    );
}

async function main() {
    console.log(
        "\n========================================"
    );

    console.log(
        "POOL SCANNER PIPELINE"
    );

    console.log(
        "========================================"
    );

    console.log(
        "Token:",
        TOKEN_CA
    );

    const existingState = await readPipelineState();
    const walletsExist = existsSync(WALLETS_PATH);

    const shouldResumeStage2 =
        Boolean(existingState) &&
        existingState.stage1Complete === true &&
        existingState.stage2Complete !== true &&
        existingState.pipelineComplete !== true &&
        walletsExist;

    if (shouldResumeStage2) {
        console.log(
            "\n[RESUME] Stage 1 already complete — resuming from Stage 2"
        );
    } else {
        await writePipelineState({
            tokenCa: TOKEN_CA,
            stage1Complete: false,
            stage2Complete: false,
            pipelineComplete: false,
            currentStage: "discovery",
            updatedAt: new Date().toISOString(),
        });

        // ==================================================
        // STAGE 1 — DISCOVERY
        // ==================================================

        console.log(
            "\n[STAGE 1/4] POOL + WALLET DISCOVERY"
        );

        await run(
            process.execPath,
            [
                "scripts/pool-scanner-v1.mjs",
                "--token",
                TOKEN_CA,
            ]
        );

        await writePipelineState({
            tokenCa: TOKEN_CA,
            stage1Complete: true,
            stage2Complete: false,
            pipelineComplete: false,
            currentStage: "fabriq",
            updatedAt: new Date().toISOString(),
        });
    }

    // ==================================================
    // STAGE 2 — FABRIQ
    // ==================================================

    console.log(
        "\n[STAGE 2/4] FABRIQ ENRICHMENT"
    );

    console.log(
        `[POOL_SCANNER] Fabriq workers: ${FABRIQ_CONCURRENCY}`
    );

    await run(
        process.execPath,
        [
            "scripts/fabriq/enrich-wallets.mjs",
        ],
        {
            FABRIQ_DATASET:
                WALLETS_PATH,

            FABRIQ_OUTPUT:
                FABRIQ_OUTPUT,

            FABRIQ_CHECKPOINT:
                FABRIQ_CHECKPOINT,

            FABRIQ_LIMIT:
                "0",

            FABRIQ_CONCURRENCY:
                FABRIQ_CONCURRENCY,
        }
    );

    await writePipelineState({
        tokenCa: TOKEN_CA,
        stage1Complete: true,
        stage2Complete: true,
        pipelineComplete: false,
        currentStage: "master_upsert",
        updatedAt: new Date().toISOString(),
    });

    // ==================================================
    // STAGE 3 — MASTER UPSERT
    // ==================================================

    console.log(
        "\n[STAGE 3/4] MASTER UPSERT"
    );

    await run(
        process.execPath,
        [
            "--experimental-strip-types",

            "scripts/pipeline/upsert-pool-scanner.ts",

            FABRIQ_OUTPUT,
        ]
    );

    await writePipelineState({
        tokenCa: TOKEN_CA,
        stage1Complete: true,
        stage2Complete: true,
        pipelineComplete: false,
        currentStage: "publish",
        updatedAt: new Date().toISOString(),
    });

    // ==================================================
    // STAGE 4 — FRONTEND PUBLISH
    // ==================================================

    console.log(
        "\n[STAGE 4/4] FRONTEND PUBLISH"
    );

    await run(
        process.execPath,
        [
            "--experimental-strip-types",

            "scripts/pipeline/publish-wallets.ts",
        ]
    );

    await writePipelineState({
        tokenCa: TOKEN_CA,
        stage1Complete: true,
        stage2Complete: true,
        pipelineComplete: true,
        currentStage: "completed",
        updatedAt: new Date().toISOString(),
    });

    console.log(
        "\n========================================"
    );

    console.log(
        "POOL SCANNER PIPELINE COMPLETE"
    );

    console.log(
        "========================================"
    );

    console.log(
        "Token:",
        TOKEN_CA
    );

    console.log(
        "Discovery:",
        BASE_DIR
    );

    console.log(
        "Fabriq:",
        FABRIQ_OUTPUT
    );

    console.log(
        "Master:",
        "data/master/wallets-master.json"
    );

    console.log(
        "Frontend:",
        "frontend/public/data/wallets-14d.json"
    );
}

main().catch(
    (error) => {
        console.error(
            "\nPOOL SCANNER PIPELINE FAILED"
        );

        console.error(
            error instanceof Error
                ? error.message
                : error
        );

        process.exit(1);
    }
);