import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const MASTER =
    "data/master/wallets-master.json";

const LPAGENT_RAW =
    "data/raw/lpagent/smart-lp-latest.json";

const STALE_AFTER_HOURS = 24;

function run(command, args = []) {
    return new Promise((resolve, reject) => {
        console.log(
            `\n▶ ${command} ${args.join(" ")}\n`
        );

        const child = spawn(
            command,
            args,
            {
                stdio: "inherit",
                shell: false,
            }
        );

        child.on("error", reject);

        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(
                new Error(
                    `${command} exited with code ${code}`
                )
            );
        });
    });
}

async function loadMaster() {
    return JSON.parse(
        await readFile(
            MASTER,
            "utf8"
        )
    );
}

function countFabriqStatus(wallets) {
    const now = Date.now();

    let fresh = 0;
    let staleOrMissing = 0;

    for (const wallet of wallets) {
        const fetchedAt =
            wallet?.fabriq?.fetchedAt;

        const timestamp =
            Date.parse(fetchedAt ?? "");

        const isFresh =
            Number.isFinite(timestamp) &&
            now - timestamp <
            STALE_AFTER_HOURS *
            60 *
            60 *
            1000;

        if (isFresh) {
            fresh++;
        } else {
            staleOrMissing++;
        }
    }

    return {
        fresh,
        staleOrMissing,
    };
}

async function showMasterStatus(label) {
    const master =
        await loadMaster();

    const wallets =
        Array.isArray(master.wallets)
            ? master.wallets
            : [];

    const {
        fresh,
        staleOrMissing,
    } = countFabriqStatus(wallets);

    console.log(
        `\n${label}`
    );

    console.log(
        "========================================"
    );

    console.log(
        `Wallets        : ${wallets.length}`
    );

    console.log(
        `Fabriq fresh   : ${fresh}`
    );

    console.log(
        `Fabriq needed  : ${staleOrMissing}`
    );

    return {
        total: wallets.length,
        fresh,
        staleOrMissing,
    };
}

async function main() {
    console.log(
        "\n========================================"
    );

    console.log(
        "METEORA WALLET DATA PIPELINE"
    );

    console.log(
        "========================================"
    );

    // -------------------------------------
    // 1. LP AGENT
    // -------------------------------------

    console.log(
        "\n[1/5] LP Agent scrape"
    );

    await run(
        process.execPath,
        [
            "scripts/lpagent/scrape-smart-lp.mjs",
        ]
    );

    // -------------------------------------
    // 2. MERGE LP AGENT
    // -------------------------------------

    console.log(
        "\n[2/5] Merge LP Agent → master"
    );

    await run(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/pipeline/merge-wallets.ts",
            LPAGENT_RAW,
        ]
    );

    const afterLp =
        await showMasterStatus(
            "MASTER AFTER LP AGENT"
        );

    // -------------------------------------
    // 3. FABRIQ
    // -------------------------------------

    if (
        afterLp.staleOrMissing > 0
    ) {
        console.log(
            `\n[3/5] Fabriq enrichment (${afterLp.staleOrMissing} wallets)`
        );

        await run(
            process.execPath,
            [
                "scripts/fabriq/enrich-wallets.mjs",
            ]
        );

        // -----------------------------------
        // 4. MERGE FABRIQ
        // -----------------------------------

        console.log(
            "\n[4/5] Merge Fabriq → master"
        );

        await run(
            process.execPath,
            [
                "--experimental-strip-types",
                "scripts/pipeline/merge-fabriq.ts",
            ]
        );
    } else {
        console.log(
            "\n[3/5] Fabriq enrichment"
        );

        console.log(
            "SKIP — all wallets have fresh Fabriq data"
        );

        console.log(
            "\n[4/5] Merge Fabriq"
        );

        console.log(
            "SKIP — no Fabriq refresh needed"
        );
    }

    // -------------------------------------
    // 5. PUBLISH
    // -------------------------------------

    console.log(
        "\n[5/5] Publish → frontend"
    );

    await run(
        process.execPath,
        [
            "--experimental-strip-types",
            "scripts/pipeline/publish-wallets.ts",
        ]
    );

    const final =
        await showMasterStatus(
            "FINAL MASTER"
        );

    console.log(
        "\n========================================"
    );

    console.log(
        "PIPELINE COMPLETE"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Wallets      : ${final.total}`
    );

    console.log(
        `Fabriq fresh : ${final.fresh}`
    );

    console.log(
        `Fabriq needed: ${final.staleOrMissing}`
    );

    console.log(
        "\nFrontend dataset updated."
    );
}

main().catch((error) => {
    console.error(
        "\n========================================"
    );

    console.error(
        "PIPELINE FAILED"
    );

    console.error(
        "========================================"
    );

    console.error(
        error instanceof Error
            ? error.stack || error.message
            : error
    );

    process.exitCode = 1;
});