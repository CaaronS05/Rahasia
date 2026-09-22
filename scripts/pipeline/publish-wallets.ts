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

const TIMEZONE = "Asia/Jakarta";

const DAY_MS =
    24 * 60 * 60 * 1000;

function finiteNumber(
    value: unknown,
): number | null {
    const parsed =
        Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function getCurrentDate(
    timeZone: string,
): string {
    const parts =
        new Intl.DateTimeFormat(
            "en-US",
            {
                timeZone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            },
        ).formatToParts(
            new Date(),
        );

    const year =
        parts.find(
            (part) =>
                part.type === "year",
        )?.value;

    const month =
        parts.find(
            (part) =>
                part.type === "month",
        )?.value;

    const day =
        parts.find(
            (part) =>
                part.type === "day",
        )?.value;

    return `${year}-${month}-${day}`;
}

function dateToDay(
    date: string,
): number {
    return Date.parse(
        `${date}T00:00:00.000Z`,
    );
}

function deriveFabriq(
    wallet: Record<string, any>,
    asOfDate: string,
) {
    const fabriq =
        isObject(wallet.fabriq)
            ? wallet.fabriq
            : {};

    const calendars =
        isObject(fabriq.calendars)
            ? fabriq.calendars
            : {};

    const stats =
        isObject(fabriq.stats)
            ? fabriq.stats
            : {};

    const dailyByDate =
        new Map<
            string,
            Record<string, number | string>
        >();

    for (
        const calendar
        of Object.values(calendars)
    ) {
        if (!isObject(calendar)) {
            continue;
        }

        for (
            const [date, rawDay]
            of Object.entries(calendar)
        ) {
            if (
                !/^\d{4}-\d{2}-\d{2}$/.test(
                    date,
                )
            ) {
                continue;
            }

            if (
                date > asOfDate ||
                !isObject(rawDay)
            ) {
                continue;
            }

            dailyByDate.set(
                date,
                {
                    date,

                    pnlSol:
                        finiteNumber(
                            rawDay.pnlSol,
                        ) ?? 0,

                    pnlUsd:
                        finiteNumber(
                            rawDay.pnlUsd,
                        ) ?? 0,

                    feesSol:
                        finiteNumber(
                            rawDay.feesSol,
                        ) ?? 0,

                    feesUsd:
                        finiteNumber(
                            rawDay.feesUsd,
                        ) ?? 0,

                    positions:
                        finiteNumber(
                            rawDay.positions,
                        ) ?? 0,

                    winRateSol:
                        finiteNumber(
                            rawDay.winRateSol,
                        ) ?? 0,

                    winRateUsd:
                        finiteNumber(
                            rawDay.winRateUsd,
                        ) ?? 0,
                },
            );
        }
    }

    const daily =
        [...dailyByDate.values()]
            .sort(
                (a, b) =>
                    String(a.date)
                        .localeCompare(
                            String(b.date),
                        ),
            );

    const asOfTime =
        dateToDay(
            asOfDate,
        );

    function rollingPnl(
        days: number,
    ) {
        const startTime =
            asOfTime -
            (
                days - 1
            ) *
            DAY_MS;

        return daily.reduce(
            (total, day) => {
                const timestamp =
                    dateToDay(
                        String(
                            day.date,
                        ),
                    );

                if (
                    timestamp <
                    startTime ||
                    timestamp >
                    asOfTime
                ) {
                    return total;
                }

                return (
                    total +
                    Number(
                        day.pnlSol,
                    )
                );
            },
            0,
        );
    }

    const currentMonth =
        asOfDate.slice(
            0,
            7,
        );

    const monthlyPnlSol =
        daily.reduce(
            (total, day) => {
                if (
                    !String(
                        day.date,
                    ).startsWith(
                        `${currentMonth}-`,
                    )
                ) {
                    return total;
                }

                return (
                    total +
                    Number(
                        day.pnlSol,
                    )
                );
            },
            0,
        );

    return {
        asOfDate,
        currentMonth,

        pnl7dSol:
            rollingPnl(7),

        pnl30dSol:
            rollingPnl(30),

        monthlyPnlSol,

        allTimePnlSol:
            finiteNumber(
                stats.netPnlSol,
            ),

        daily,
    };
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

    const derivedAsOfDate =
        getCurrentDate(
            TIMEZONE,
        );

    const wallets =
        payload.wallets.map(
            (
                wallet:
                    Record<string, any>,
            ) => ({
                ...wallet,

                fabriqDerived:
                    deriveFabriq(
                        wallet,
                        derivedAsOfDate,
                    ),
            }),
        );

    const publishedPayload = {
        ...payload,

        meta: {
            ...(isObject(payload.meta)
                ? payload.meta
                : {}),

            publishedAt,

            derivedAsOfDate,
        },

        wallets,
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