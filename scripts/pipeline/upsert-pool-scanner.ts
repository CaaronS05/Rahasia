import {
    mkdir,
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";

import path from "node:path";

type JsonObject = Record<string, any>;

const MASTER_PATH = path.resolve(
    "data/master/wallets-master.json"
);

function isObject(
    value: unknown
): value is JsonObject {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function normalizeCalendars(
    fabriq: JsonObject
): JsonObject {
    const calendars: JsonObject = {};

    if (isObject(fabriq.calendars)) {
        for (
            const [month, calendar]
            of Object.entries(fabriq.calendars)
        ) {
            if (isObject(calendar)) {
                calendars[month] = calendar;
            }
        }
    }

    return calendars;
}

async function loadJson(
    filePath: string
) {
    return JSON.parse(
        await readFile(filePath, "utf8")
    );
}

async function main() {
    const inputArg =
        process.argv[2];

    if (!inputArg) {
        throw new Error(
            "Usage: node --experimental-strip-types scripts/pipeline/upsert-pool-scanner.ts <enriched.json>"
        );
    }

    const inputPath =
        path.resolve(inputArg);

    const now =
        new Date().toISOString();

    console.log("\nPOOL SCANNER → MASTER UPSERT");
    console.log("============================");

    const [master, enriched] =
        await Promise.all([
            loadJson(MASTER_PATH),
            loadJson(inputPath),
        ]);

    if (!Array.isArray(master?.wallets)) {
        throw new Error(
            "Master wallets array tidak ditemukan."
        );
    }

    if (!Array.isArray(enriched?.results)) {
        throw new Error(
            "Fabriq results array tidak ditemukan."
        );
    }

    // --------------------------------------------
    // Valid Fabriq results only
    // --------------------------------------------

    const incoming =
        enriched.results.filter(
            (row: any) =>
                row?.status === "ok" &&
                typeof row?.owner === "string" &&
                row.owner.trim() &&
                isObject(row.fabriq)
        );

    const incomingByOwner =
        new Map<string, JsonObject>();

    for (const row of incoming) {
        incomingByOwner.set(
            row.owner.trim(),
            row
        );
    }

    // --------------------------------------------
    // Existing master index
    // --------------------------------------------

    const masterByOwner =
        new Map<string, JsonObject>();

    for (const wallet of master.wallets) {
        if (
            isObject(wallet) &&
            typeof wallet.owner === "string"
        ) {
            masterByOwner.set(
                wallet.owner,
                wallet
            );
        }
    }

    const beforeCount =
        masterByOwner.size;

    let added = 0;
    let updated = 0;

    // --------------------------------------------
    // UPSERT
    // --------------------------------------------

    for (
        const [owner, row]
        of incomingByOwner
    ) {
        const existing =
            masterByOwner.get(owner);

        const incomingFabriq =
            row.fabriq;

        // ========================================
        // NEW WALLET
        // ========================================

        if (!existing) {
            masterByOwner.set(
                owner,
                {
                    owner,

                    fabriq: {
                        ...incomingFabriq,

                        calendars:
                            normalizeCalendars(
                                incomingFabriq
                            ),
                    },

                    _local: {
                        firstSeenAt: now,
                        lastSeenAt: now,
                        scrapeCount: 1,
                    },
                }
            );

            added++;
            continue;
        }

        // ========================================
        // EXISTING WALLET
        // ========================================

        const existingFabriq =
            isObject(existing.fabriq)
                ? existing.fabriq
                : {};

        const existingCalendars =
            normalizeCalendars(
                existingFabriq
            );

        const incomingCalendars =
            normalizeCalendars(
                incomingFabriq
            );

        const calendars = {
            ...existingCalendars,
        };

        for (
            const [month, calendar]
            of Object.entries(
                incomingCalendars
            )
        ) {
            calendars[month] = {
                ...(isObject(
                    calendars[month]
                )
                    ? calendars[month]
                    : {}),

                ...(isObject(calendar)
                    ? calendar
                    : {}),
            };
        }

        masterByOwner.set(
            owner,
            {
                ...existing,

                owner,

                fabriq: {
                    ...existingFabriq,
                    ...incomingFabriq,

                    calendars,
                },

                _local: {
                    ...(isObject(
                        existing._local
                    )
                        ? existing._local
                        : {}),

                    firstSeenAt:
                        existing._local
                            ?.firstSeenAt ??
                        now,

                    lastSeenAt: now,

                    scrapeCount:
                        (
                            existing._local
                                ?.scrapeCount ??
                            0
                        ) + 1,
                },
            }
        );

        updated++;
    }

    const wallets =
        [...masterByOwner.values()];

    const output = {
        ...master,

        meta: {
            ...(isObject(master.meta)
                ? master.meta
                : {}),

            updatedAt: now,

            uniqueWallets:
                wallets.length,

            lastPoolScannerImport: {
                importedAt: now,

                sourceFile:
                    path.basename(
                        inputPath
                    ),

                incoming:
                    incomingByOwner.size,

                added,

                updated,
            },
        },

        wallets,
    };

    // --------------------------------------------
    // WRITE SAFELY
    // --------------------------------------------

    await mkdir(
        path.dirname(MASTER_PATH),
        {
            recursive: true,
        }
    );

    const tempPath =
        `${MASTER_PATH}.tmp`;

    await writeFile(
        tempPath,
        JSON.stringify(
            output,
            null,
            2
        ) + "\n",
        "utf8"
    );

    await rename(
        tempPath,
        MASTER_PATH
    );

    console.log(
        `Master before   : ${beforeCount}`
    );

    console.log(
        `Incoming wallets: ${incomingByOwner.size}`
    );

    console.log(
        `Updated existing: ${updated}`
    );

    console.log(
        `Added new       : ${added}`
    );

    console.log(
        `Master after    : ${wallets.length}`
    );

    console.log(
        `Output          : ${MASTER_PATH}`
    );

    console.log(
        "\nPOOL SCANNER UPSERT COMPLETE"
    );
}

main().catch(
    (error) => {
        console.error(
            "\nPOOL SCANNER UPSERT FAILED"
        );

        console.error(error);

        process.exitCode = 1;
    }
);