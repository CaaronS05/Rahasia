import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

// ============================================================
// CONFIG
// ============================================================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const HELIUS_RPC_URL =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_API =
    "https://dlmm.datapi.meteora.ag";

const METEORA_DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const POOL =
    process.env.POOL_ADDRESS ||
    "5fjmuEN72LQeo9NjvhLyQTV3ezyNgQqUXzSXskD2SCcy";

const DAYS = Number(process.env.SCAN_DAYS || "7");

const HISTORY_CONCURRENCY = Number(
    process.env.HISTORY_CONCURRENCY || "6"
);

const REQUEST_RETRIES = Number(
    process.env.REQUEST_RETRIES || "4"
);

// ============================================================
// TYPES
// ============================================================

type PositionRow = {
    positionAddress: string;
    poolAddress: string;
    ownerWallet: string;
};

type HistoricalEvent = {
    signature?: string;
    ixIndex?: number;
    eventType?: string;
    positionAddress?: string;
    blockTime?: number;
    slot?: number;
    poolAddress?: string;
    userAddress?: string;

    tokenX?: string;
    tokenY?: string;

    amountX?: string;
    amountY?: string;

    amountXUsd?: string;
    amountYUsd?: string;
    totalUsd?: string;

    createdAt?: string;
};

type WalletAggregate = {
    wallet_address: string;

    event_count_7d: number;
    positions_count_7d: number;

    event_types: Set<string>;
    positions: Set<string>;

    first_activity_ms: number;
    last_activity_ms: number;
};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function anchorDiscriminator(accountName: string) {
    return crypto
        .createHash("sha256")
        .update(`account:${accountName}`)
        .digest()
        .subarray(0, 8);
}

async function fetchWithRetry(
    url: string,
    options?: RequestInit
): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt++) {
        try {
            const response = await fetch(url, options);

            if (
                response.ok ||
                (response.status >= 400 && response.status < 500 &&
                    response.status !== 429)
            ) {
                return response;
            }

            lastError = new Error(
                `HTTP ${response.status} ${response.statusText}`
            );
        } catch (error) {
            lastError = error;
        }

        if (attempt < REQUEST_RETRIES) {
            const delay = 500 * Math.pow(2, attempt - 1);

            console.log(
                `[retry] attempt=${attempt}/${REQUEST_RETRIES} wait=${delay}ms`
            );

            await sleep(delay);
        }
    }

    throw lastError;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);

    let cursor = 0;

    async function runner() {
        while (true) {
            const index = cursor++;

            if (index >= items.length) {
                return;
            }

            results[index] = await worker(
                items[index],
                index
            );
        }
    }

    const workers = Array.from(
        {
            length: Math.min(
                concurrency,
                items.length
            ),
        },
        () => runner()
    );

    await Promise.all(workers);

    return results;
}

// ============================================================
// STEP 1
// HELIUS GPA → POSITION + OWNER
// ============================================================

async function getPoolPositions(): Promise<PositionRow[]> {
    const discriminator =
        anchorDiscriminator("PositionV2");

    const discriminatorBase58 =
        bs58.encode(discriminator);

    console.log("\n=== STEP 1: HELIUS getProgramAccounts ===");
    console.log(`Pool        : ${POOL}`);
    console.log(`Scan days   : ${DAYS}`);
    console.log("");

    const response = await fetchWithRetry(
        HELIUS_RPC_URL,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,

                method: "getProgramAccounts",

                params: [
                    METEORA_DLMM_PROGRAM,

                    {
                        commitment: "confirmed",
                        encoding: "base64",

                        filters: [
                            {
                                memcmp: {
                                    offset: 0,
                                    bytes: discriminatorBase58,
                                },
                            },

                            {
                                memcmp: {
                                    offset: 8,
                                    bytes: POOL,
                                },
                            },
                        ],

                        // discriminator + lbPair + owner
                        dataSlice: {
                            offset: 0,
                            length: 72,
                        },
                    },
                ],
            }),
        }
    );

    const json: any =
        await response.json();

    if (json.error) {
        throw new Error(
            `Helius RPC error: ${JSON.stringify(
                json.error
            )}`
        );
    }

    const accounts =
        json.result ?? [];

    const rows: PositionRow[] =
        accounts.map((item: any) => {
            const raw = Buffer.from(
                item.account.data[0],
                "base64"
            );

            const poolBytes =
                raw.subarray(8, 40);

            const ownerBytes =
                raw.subarray(40, 72);

            return {
                positionAddress:
                    item.pubkey,

                poolAddress:
                    new PublicKey(
                        poolBytes
                    ).toBase58(),

                ownerWallet:
                    new PublicKey(
                        ownerBytes
                    ).toBase58(),
            };
        });

    const uniqueOwners =
        new Set(
            rows.map(
                (row) =>
                    row.ownerWallet
            )
        );

    console.log(
        `Positions found : ${rows.length}`
    );

    console.log(
        `Current owners  : ${uniqueOwners.size}`
    );

    return rows;
}

// ============================================================
// STEP 2
// METEORA POSITION HISTORY
// ============================================================

async function getPositionHistory(
    position: string
): Promise<HistoricalEvent[]> {
    const url =
        `${METEORA_API}/positions/${position}/historical`;

    const response =
        await fetchWithRetry(url);

    if (!response.ok) {
        const text =
            await response.text();

        console.log(
            `[history-error] position=${position} status=${response.status} ${text}`
        );

        return [];
    }

    const json: any =
        await response.json();

    return Array.isArray(
        json.events
    )
        ? json.events
        : [];
}

// ============================================================
// STEP 3
// FILTER LAST 7 DAYS
// ============================================================

function aggregateEvents(
    events: HistoricalEvent[],
    cutoffMs: number
) {
    const wallets =
        new Map<
            string,
            WalletAggregate
        >();

    let eventsInWindow = 0;

    for (const event of events) {
        if (
            !event.userAddress ||
            !event.positionAddress ||
            !event.blockTime
        ) {
            continue;
        }

        if (
            event.blockTime <
            cutoffMs
        ) {
            continue;
        }

        eventsInWindow++;

        const wallet =
            event.userAddress;

        let row =
            wallets.get(wallet);

        if (!row) {
            row = {
                wallet_address:
                    wallet,

                event_count_7d: 0,
                positions_count_7d: 0,

                event_types:
                    new Set(),

                positions:
                    new Set(),

                first_activity_ms:
                    event.blockTime,

                last_activity_ms:
                    event.blockTime,
            };

            wallets.set(
                wallet,
                row
            );
        }

        row.event_count_7d++;

        row.positions.add(
            event.positionAddress
        );

        if (event.eventType) {
            row.event_types.add(
                event.eventType
            );
        }

        row.first_activity_ms =
            Math.min(
                row.first_activity_ms,
                event.blockTime
            );

        row.last_activity_ms =
            Math.max(
                row.last_activity_ms,
                event.blockTime
            );
    }

    for (const row of wallets.values()) {
        row.positions_count_7d =
            row.positions.size;
    }

    return {
        wallets,
        eventsInWindow,
    };
}

// ============================================================
// OUTPUT
// ============================================================

function csvEscape(value: unknown) {
    const text =
        String(value ?? "");

    if (
        text.includes(",") ||
        text.includes('"') ||
        text.includes("\n")
    ) {
        return `"${text.replace(
            /"/g,
            '""'
        )}"`;
    }

    return text;
}

async function saveOutput(
    positions: PositionRow[],
    allEvents: HistoricalEvent[],
    aggregates: Map<
        string,
        WalletAggregate
    >,
    cutoffMs: number
) {
    const outputDir =
        path.resolve("output");

    await fs.mkdir(
        outputDir,
        {
            recursive: true,
        }
    );

    const wallets =
        [...aggregates.values()]
            .map((row) => ({
                wallet_address:
                    row.wallet_address,

                event_count_7d:
                    row.event_count_7d,

                positions_count_7d:
                    row.positions_count_7d,

                event_types:
                    [...row.event_types]
                        .sort(),

                position_addresses:
                    [...row.positions],

                first_activity_utc:
                    new Date(
                        row.first_activity_ms
                    ).toISOString(),

                last_activity_utc:
                    new Date(
                        row.last_activity_ms
                    ).toISOString(),
            }))
            .sort(
                (a, b) =>
                    b.event_count_7d -
                    a.event_count_7d
            );

    const jsonOutput = {
        generated_at_utc:
            new Date().toISOString(),

        pool_address:
            POOL,

        scan_days:
            DAYS,

        cutoff_utc:
            new Date(
                cutoffMs
            ).toISOString(),

        current_position_count:
            positions.length,

        current_owner_count:
            new Set(
                positions.map(
                    (p) =>
                        p.ownerWallet
                )
            ).size,

        historical_events_fetched:
            allEvents.length,

        lp_events_in_window:
            allEvents.filter(
                (event) =>
                    event.blockTime &&
                    event.blockTime >=
                    cutoffMs
            ).length,

        unique_lp_wallets_7d:
            wallets.length,

        wallets,
    };

    const jsonPath =
        path.join(
            outputDir,
            "v2_pool_wallets_7d.json"
        );

    await fs.writeFile(
        jsonPath,
        JSON.stringify(
            jsonOutput,
            null,
            2
        )
    );

    const csvHeader = [
        "wallet_address",
        "event_count_7d",
        "positions_count_7d",
        "event_types",
        "first_activity_utc",
        "last_activity_utc",
    ];

    const csvRows = [
        csvHeader.join(","),

        ...wallets.map(
            (row) =>
                [
                    row.wallet_address,
                    row.event_count_7d,
                    row.positions_count_7d,
                    row.event_types.join(
                        "|"
                    ),
                    row.first_activity_utc,
                    row.last_activity_utc,
                ]
                    .map(csvEscape)
                    .join(",")
        ),
    ];

    const csvPath =
        path.join(
            outputDir,
            "v2_pool_wallets_7d.csv"
        );

    await fs.writeFile(
        csvPath,
        csvRows.join("\n")
    );

    return {
        wallets,
        jsonPath,
        csvPath,
    };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const startMs =
        Date.now();

    const cutoffMs =
        Date.now() -
        DAYS *
        24 *
        60 *
        60 *
        1000;

    // ------------------------
    // STEP 1
    // ------------------------

    const positions =
        await getPoolPositions();

    if (
        positions.length === 0
    ) {
        console.log(
            "\nNo PositionV2 found."
        );

        return;
    }

    // ------------------------
    // STEP 2
    // ------------------------

    console.log(
        "\n=== STEP 2: METEORA POSITION HISTORY ==="
    );

    const histories =
        await mapWithConcurrency(
            positions,

            HISTORY_CONCURRENCY,

            async (
                position,
                index
            ) => {
                const events =
                    await getPositionHistory(
                        position.positionAddress
                    );

                console.log(
                    `[history] ${index + 1}/${positions.length}` +
                    ` events=${events.length}` +
                    ` position=${position.positionAddress}`
                );

                return events;
            }
        );

    const allEvents =
        histories.flat();

    // ------------------------
    // STEP 3
    // ------------------------

    console.log(
        "\n=== STEP 3: FILTER LAST 7 DAYS ==="
    );

    const {
        wallets,
        eventsInWindow,
    } = aggregateEvents(
        allEvents,
        cutoffMs
    );

    // ------------------------
    // OUTPUT
    // ------------------------

    const output =
        await saveOutput(
            positions,
            allEvents,
            wallets,
            cutoffMs
        );

    const elapsedSec =
        (
            (Date.now() -
                startMs) /
            1000
        ).toFixed(2);

    console.log(
        "\n========================================"
    );

    console.log(
        "V2 — ONE POOL COMPLETE"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Pool                    : ${POOL}`
    );

    console.log(
        `Current positions       : ${positions.length}`
    );

    console.log(
        `Current unique owners   : ${new Set(
            positions.map(
                (p) =>
                    p.ownerWallet
            )
        ).size
        }`
    );

    console.log(
        `Historical events       : ${allEvents.length}`
    );

    console.log(
        `Events within ${DAYS} days   : ${eventsInWindow}`
    );

    console.log(
        `Unique LP wallets ${DAYS}d   : ${output.wallets.length}`
    );

    console.log(
        `Elapsed                 : ${elapsedSec}s`
    );

    console.log(
        `JSON                    : ${output.jsonPath}`
    );

    console.log(
        `CSV                     : ${output.csvPath}`
    );

    console.log(
        "========================================\n"
    );

    console.table(
        output.wallets
            .slice(0, 20)
            .map((wallet) => ({
                wallet:
                    wallet.wallet_address,

                events:
                    wallet.event_count_7d,

                positions:
                    wallet.positions_count_7d,

                types:
                    wallet.event_types.join(
                        ","
                    ),

                lastActivity:
                    wallet.last_activity_utc,
            }))
    );
}

main().catch(
    (error) => {
        console.error(
            "\n[V2 FAILED]"
        );

        console.error(error);

        process.exit(1);
    }
);