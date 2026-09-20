import fs from "node:fs/promises";

const INPUT =
    "output/verify-decoded-owner.json";

const METEORA_API =
    "https://dlmm.datapi.meteora.ag";

type VerifyRow = {
    position: string;
    status: string;

    expectedActor:
    | string
    | null;

    expectedPool:
    | string
    | null;
};

function normalizeTimestamp(
    value: unknown
): string | null {
    if (
        typeof value === "number"
    ) {
        const ms =
            value > 1e12
                ? value
                : value * 1000;

        return new Date(
            ms
        ).toISOString();
    }

    return null;
}

async function fetchHistorical(
    position: string
) {
    const url =
        `${METEORA_API}/positions/${position}/historical`;

    const response =
        await fetch(url);

    const text =
        await response.text();

    if (!response.ok) {
        return {
            ok: false,
            status:
                response.status,
            data: null,
            raw: text,
        };
    }

    return {
        ok: true,
        status:
            response.status,
        data:
            JSON.parse(text),
        raw: null,
    };
}

function extractEvents(
    data: any
): any[] {
    if (
        Array.isArray(data)
    ) {
        return data;
    }

    if (
        Array.isArray(
            data?.events
        )
    ) {
        return data.events;
    }

    if (
        Array.isArray(
            data?.data
        )
    ) {
        return data.data;
    }

    return [];
}

async function main() {
    const input =
        JSON.parse(
            await fs.readFile(
                INPUT,
                "utf8"
            )
        );

    const source:
        VerifyRow[] =
        input.results ?? [];

    console.log(
        "=== VERIFY DELETED POSITION VIA METEORA ==="
    );

    console.log(
        `Positions : ${source.length}`
    );

    const output: any[] =
        [];

    let actorMatched = 0;
    let actorMismatch = 0;

    let poolMatched = 0;
    let poolMismatch = 0;

    let noHistory = 0;

    for (
        let i = 0;
        i <
        source.length;
        i++
    ) {
        const row =
            source[i];

        console.log(
            `\n[${i + 1}/${source.length}] ${row.position}`
        );

        const response =
            await fetchHistorical(
                row.position
            );

        if (!response.ok) {
            console.log(
                `  HTTP ${response.status}`
            );

            noHistory++;

            output.push({
                ...row,

                historicalFound:
                    false,

                events:
                    0,

                historicalUser:
                    null,

                historicalPool:
                    null,

                actorMatches:
                    null,

                poolMatches:
                    null,
            });

            continue;
        }

        const events =
            extractEvents(
                response.data
            );

        if (
            events.length === 0
        ) {
            console.log(
                "  No events"
            );

            noHistory++;

            output.push({
                ...row,

                historicalFound:
                    true,

                events:
                    0,

                historicalUser:
                    null,

                historicalPool:
                    null,

                actorMatches:
                    null,

                poolMatches:
                    null,
            });

            continue;
        }

        const users =
            [
                ...new Set(
                    events
                        .map(
                            (e) =>
                                e.userAddress
                        )
                        .filter(Boolean)
                ),
            ];

        const pools =
            [
                ...new Set(
                    events
                        .map(
                            (e) =>
                                e.poolAddress
                        )
                        .filter(Boolean)
                ),
            ];

        const historicalUser =
            users.length === 1
                ? users[0]
                : null;

        const historicalPool =
            pools.length === 1
                ? pools[0]
                : null;

        const actorMatches =
            row.expectedActor &&
                historicalUser
                ? row.expectedActor ===
                historicalUser
                : null;

        const poolMatches =
            row.expectedPool &&
                historicalPool
                ? row.expectedPool ===
                historicalPool
                : null;

        if (
            actorMatches ===
            true
        ) {
            actorMatched++;
        }

        if (
            actorMatches ===
            false
        ) {
            actorMismatch++;
        }

        if (
            poolMatches ===
            true
        ) {
            poolMatched++;
        }

        if (
            poolMatches ===
            false
        ) {
            poolMismatch++;
        }

        const first =
            events.reduce(
                (
                    min,
                    event
                ) => {
                    const value =
                        event.blockTime;

                    if (
                        typeof value !==
                        "number"
                    ) {
                        return min;
                    }

                    return min === null ||
                        value < min
                        ? value
                        : min;
                },
                null as number | null
            );

        const last =
            events.reduce(
                (
                    max,
                    event
                ) => {
                    const value =
                        event.blockTime;

                    if (
                        typeof value !==
                        "number"
                    ) {
                        return max;
                    }

                    return max === null ||
                        value > max
                        ? value
                        : max;
                },
                null as number | null
            );

        console.log(
            `  Events        : ${events.length}`
        );

        console.log(
            `  Expected actor: ${row.expectedActor}`
        );

        console.log(
            `  Meteora user  : ${historicalUser}`
        );

        console.log(
            `  Actor match   : ${actorMatches}`
        );

        console.log(
            `  Expected pool : ${row.expectedPool}`
        );

        console.log(
            `  Meteora pool  : ${historicalPool}`
        );

        console.log(
            `  Pool match    : ${poolMatches}`
        );

        console.log(
            `  First event   : ${normalizeTimestamp(first)}`
        );

        console.log(
            `  Last event    : ${normalizeTimestamp(last)}`
        );

        output.push({
            ...row,

            historicalFound:
                true,

            events:
                events.length,

            historicalUsers:
                users,

            historicalPools:
                pools,

            historicalUser,

            historicalPool,

            actorMatches,

            poolMatches,

            eventTypes:
                [
                    ...new Set(
                        events
                            .map(
                                (e) =>
                                    e.eventType
                            )
                            .filter(Boolean)
                    ),
                ],

            firstEventUtc:
                normalizeTimestamp(
                    first
                ),

            lastEventUtc:
                normalizeTimestamp(
                    last
                ),
        });
    }

    console.log(
        "\n========================================"
    );

    console.log(
        "METEORA OWNER VERIFICATION RESULT"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Positions tested     : ${source.length}`
    );

    console.log(
        `Actor matched        : ${actorMatched}`
    );

    console.log(
        `Actor mismatch       : ${actorMismatch}`
    );

    console.log(
        `Pool matched         : ${poolMatched}`
    );

    console.log(
        `Pool mismatch        : ${poolMismatch}`
    );

    console.log(
        `No historical data   : ${noHistory}`
    );

    console.log(
        "========================================"
    );

    await fs.writeFile(
        "output/verify-deleted-owner-meteora.json",
        JSON.stringify(
            {
                generatedAt:
                    new Date()
                        .toISOString(),

                summary: {
                    tested:
                        source.length,

                    actorMatched,

                    actorMismatch,

                    poolMatched,

                    poolMismatch,

                    noHistory,
                },

                results:
                    output,
            },
            null,
            2
        )
    );
}

main().catch(
    (error) => {
        console.error(
            error
        );

        process.exit(1);
    }
);