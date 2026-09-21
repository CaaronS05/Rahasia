import {
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";

import path from "node:path";

type JsonObject = Record<string, any>;

const MASTER_PATH = path.resolve(
    "data/master/wallets-master.json",
);

const FABRIQ_PATH = path.resolve(
    "data/raw/fabriq/fabriq-enriched.json",
);

function isObject(
    value: unknown,
): value is JsonObject {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function normalizeCalendars(
    fabriq: JsonObject,
): JsonObject {
    const calendars: JsonObject = {};

    // Schema baru
    if (isObject(fabriq.calendars)) {
        for (
            const [month, calendar]
            of Object.entries(
                fabriq.calendars,
            )
        ) {
            if (isObject(calendar)) {
                calendars[month] =
                    calendar;
            }
        }
    }

    // Migrasi schema lama:
    //
    // month: "2026-09"
    // calendar: {...}
    if (
        typeof fabriq.month ===
        "string" &&
        isObject(fabriq.calendar)
    ) {
        calendars[fabriq.month] = {
            ...(isObject(
                calendars[
                fabriq.month
                ],
            )
                ? calendars[
                fabriq.month
                ]
                : {}),

            ...fabriq.calendar,
        };
    }

    return calendars;
}

async function loadJson(
    filePath: string,
): Promise<any> {
    return JSON.parse(
        await readFile(filePath, "utf8"),
    );
}

async function main() {
    console.log("\nMERGE FABRIQ DATA");
    console.log("=================");

    const [master, fabriqRaw] =
        await Promise.all([
            loadJson(MASTER_PATH),
            loadJson(FABRIQ_PATH),
        ]);

    if (!Array.isArray(master?.wallets)) {
        throw new Error(
            'Master file does not contain a "wallets" array.',
        );
    }

    if (!Array.isArray(fabriqRaw?.results)) {
        throw new Error(
            'Fabriq file does not contain a "results" array.',
        );
    }

    const fabriqByOwner =
        new Map<string, JsonObject>();

    for (const row of fabriqRaw.results) {
        if (!isObject(row)) continue;

        const owner = row.owner;

        if (
            typeof owner !== "string" ||
            !owner.trim()
        ) {
            continue;
        }

        if (!isObject(row.fabriq)) {
            continue;
        }

        fabriqByOwner.set(
            owner.trim(),
            row.fabriq,
        );
    }

    let matched = 0;
    let unchanged = 0;

    const wallets = master.wallets.map(
        (wallet: JsonObject) => {
            if (!isObject(wallet)) {
                return wallet;
            }

            const owner = wallet.owner;

            if (typeof owner !== "string") {
                return wallet;
            }

            const fabriq =
                fabriqByOwner.get(owner);

            if (!fabriq) {
                unchanged++;
                return wallet;
            }

            matched++;

            const existingFabriq =
                isObject(wallet.fabriq)
                    ? wallet.fabriq
                    : {};

            const existingCalendars =
                normalizeCalendars(
                    existingFabriq,
                );

            const incomingCalendars =
                normalizeCalendars(
                    fabriq,
                );

            const calendars: JsonObject = {
                ...existingCalendars,
            };

            for (
                const [month, calendar]
                of Object.entries(
                    incomingCalendars,
                )
            ) {
                calendars[month] = {
                    ...(isObject(
                        calendars[month],
                    )
                        ? calendars[month]
                        : {}),

                    ...(isObject(calendar)
                        ? calendar
                        : {}),
                };
            }

            return {
                ...wallet,

                fabriq: {
                    ...existingFabriq,
                    ...fabriq,

                    calendars,
                },
            };
        },
    );

    const output = {
        ...master,

        meta: {
            ...(isObject(master.meta)
                ? master.meta
                : {}),

            fabriqMergedAt:
                new Date().toISOString(),

            fabriqMatchedWallets:
                matched,
        },

        wallets,
    };

    const tempPath =
        `${MASTER_PATH}.tmp`;

    await writeFile(
        tempPath,
        JSON.stringify(output, null, 2),
        "utf8",
    );

    await rename(
        tempPath,
        MASTER_PATH,
    );

    console.log(
        `Master wallets : ${wallets.length}`,
    );

    console.log(
        `Fabriq results : ${fabriqByOwner.size}`,
    );

    console.log(
        `Matched        : ${matched}`,
    );

    console.log(
        `Without Fabriq : ${unchanged}`,
    );

    console.log(
        `Output         : ${MASTER_PATH}`,
    );

    console.log(
        "Status         : merge successful",
    );
}

main().catch((error) => {
    console.error("\nMERGE FABRIQ FAILED");

    console.error(
        error instanceof Error
            ? error.stack || error.message
            : error,
    );

    process.exitCode = 1;
});