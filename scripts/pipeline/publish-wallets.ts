import {
    mkdir,
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";

import path from "node:path";

const MASTER_PATH = path.resolve(
    "data/master/wallets-master.json",
);

const FRONTEND_PATH = path.resolve(
    "frontend/public/data/wallets-14d.json",
);

function isObject(
    value: unknown,
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function validateDataset(payload: unknown) {
    if (!isObject(payload)) {
        throw new Error(
            "Master dataset must be a JSON object.",
        );
    }

    if (!Array.isArray(payload.wallets)) {
        throw new Error(
            'Master dataset must contain a "wallets" array.',
        );
    }

    if (payload.wallets.length === 0) {
        throw new Error(
            "Refusing to publish an empty wallet dataset.",
        );
    }

    for (const [index, wallet] of payload.wallets.entries()) {
        if (!isObject(wallet)) {
            throw new Error(
                `Invalid wallet at index ${index}.`,
            );
        }

        if (
            typeof wallet.owner !== "string" ||
            !wallet.owner.trim()
        ) {
            throw new Error(
                `Wallet at index ${index} has no valid owner.`,
            );
        }
    }

    return payload.wallets.length;
}

async function main() {
    console.log("\nPUBLISH WALLET DATA");
    console.log("===================");

    const raw = await readFile(
        MASTER_PATH,
        "utf8",
    );

    const payload = JSON.parse(raw);

    const walletCount =
        validateDataset(payload);

    const publishedAt =
        new Date().toISOString();

    const publishedPayload = {
        ...payload,

        meta: {
            ...(isObject(payload.meta)
                ? payload.meta
                : {}),

            publishedAt,
        },
    };

    await mkdir(
        path.dirname(FRONTEND_PATH),
        { recursive: true },
    );

    const tempPath =
        `${FRONTEND_PATH}.tmp`;

    await writeFile(
        tempPath,
        JSON.stringify(
            publishedPayload,
            null,
            2,
        ),
        "utf8",
    );

    await rename(
        tempPath,
        FRONTEND_PATH,
    );

    console.log(`Source  : ${MASTER_PATH}`);
    console.log(`Target  : ${FRONTEND_PATH}`);
    console.log(`Wallets : ${walletCount}`);
    console.log("Status  : published successfully");
}

main().catch((error) => {
    console.error("\nPUBLISH FAILED");
    console.error(
        error instanceof Error
            ? error.stack || error.message
            : error,
    );

    process.exitCode = 1;
});