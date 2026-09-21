import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const RPC_URL =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const DAYS = Number(process.env.SCAN_DAYS || "7");

const PAGE_SIZE = Number(
    process.env.GPAV2_PAGE_SIZE || "5000"
);

const PAGE_DELAY_MS = Number(
    process.env.GPAV2_DELAY_MS || "300"
);

type PositionRow = {
    positionAddress: string;
    poolAddress: string;
    ownerWallet: string;
};

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function anchorDiscriminator(name: string) {
    return crypto
        .createHash("sha256")
        .update(`account:${name}`)
        .digest()
        .subarray(0, 8);
}

// ============================================================
// BASIC RPC
// ============================================================

async function rpc(method: string, params: any[] = []) {
    const response = await fetch(RPC_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
        }),
    });

    if (!response.ok) {
        throw new Error(
            `${method}: HTTP ${response.status}`
        );
    }

    const json: any = await response.json();

    if (json.error) {
        throw new Error(
            `${method}: ${JSON.stringify(json.error)}`
        );
    }

    return json.result;
}

// ============================================================
// GET BLOCK TIME
// Some Solana slots can be skipped, so probe nearby slots.
// ============================================================

async function getBlockTimeNear(
    slot: number
): Promise<{
    slot: number;
    time: number;
}> {
    const offsets = [
        0,
        -1,
        1,
        -2,
        2,
        -3,
        3,
        -5,
        5,
        -10,
        10,
    ];

    for (const offset of offsets) {
        const candidate =
            slot + offset;

        if (candidate <= 0) {
            continue;
        }

        const result =
            await rpc(
                "getBlockTime",
                [candidate]
            );

        if (
            typeof result === "number"
        ) {
            return {
                slot: candidate,
                time: result,
            };
        }
    }

    throw new Error(
        `Tidak menemukan blockTime dekat slot ${slot}`
    );
}

// ============================================================
// FIND SLOT CLOSEST TO TARGET TIMESTAMP
// ============================================================

async function findSlotForTimestamp(
    targetUnix: number
) {
    console.log(
        "\n=== FIND 7D CUTOFF SLOT ==="
    );

    const currentSlot: number =
        await rpc(
            "getSlot",
            [
                {
                    commitment:
                        "confirmed",
                },
            ]
        );

    const currentBlock =
        await getBlockTimeNear(
            currentSlot
        );

    console.log(
        `Current slot      : ${currentSlot}`
    );

    console.log(
        `Current block UTC : ${new Date(
            currentBlock.time *
            1000
        ).toISOString()
        }`
    );

    console.log(
        `Target UTC        : ${new Date(
            targetUnix *
            1000
        ).toISOString()
        }`
    );

    // Start roughly ~2M slots back.
    let high = currentSlot;

    let low =
        Math.max(
            1,
            currentSlot -
            2_000_000
        );

    // Ensure low really is older
    // than our target.
    while (true) {
        const lowBlock =
            await getBlockTimeNear(
                low
            );

        if (
            lowBlock.time <=
            targetUnix
        ) {
            break;
        }

        low =
            Math.max(
                1,
                low - 1_000_000
            );
    }

    let bestSlot = low;
    let bestDiff =
        Number.MAX_SAFE_INTEGER;

    // Binary search.
    for (
        let i = 0;
        i < 30;
        i++
    ) {
        if (low > high) {
            break;
        }

        const mid =
            Math.floor(
                (low + high) / 2
            );

        const block =
            await getBlockTimeNear(
                mid
            );

        const diff =
            Math.abs(
                block.time -
                targetUnix
            );

        if (diff < bestDiff) {
            bestDiff = diff;
            bestSlot =
                block.slot;
        }

        if (
            block.time <
            targetUnix
        ) {
            low =
                block.slot + 1;
        } else {
            high =
                block.slot - 1;
        }
    }

    const bestBlock =
        await getBlockTimeNear(
            bestSlot
        );

    console.log(
        `Cutoff slot       : ${bestBlock.slot}`
    );

    console.log(
        `Cutoff block UTC  : ${new Date(
            bestBlock.time *
            1000
        ).toISOString()
        }`
    );

    console.log(
        `Timestamp diff    : ${Math.abs(
            bestBlock.time -
            targetUnix
        )
        } sec`
    );

    return bestBlock.slot;
}

// ============================================================
// gPAv2 CHANGED SINCE SLOT
// ============================================================

async function getRecentPositions(
    cutoffSlot: number
) {
    console.log(
        "\n=== HELIUS gPAv2 — CHANGED POSITIONV2 ==="
    );

    const discriminator =
        bs58.encode(
            anchorDiscriminator(
                "PositionV2"
            )
        );

    const rows: PositionRow[] =
        [];

    let paginationKey:
        | string
        | null = null;

    let page = 0;

    let firstContextSlot:
        | number
        | null = null;

    let lastContextSlot:
        | number
        | null = null;

    do {
        page++;

        const config: any = {
            commitment:
                "confirmed",

            encoding:
                "base64",

            withContext:
                true,

            limit:
                PAGE_SIZE,

            changedSinceSlot:
                cutoffSlot,

            filters: [
                {
                    memcmp: {
                        offset: 0,
                        bytes:
                            discriminator,
                    },
                },
            ],

            dataSlice: {
                offset: 0,
                length: 72,
            },
        };

        if (paginationKey) {
            config.paginationKey =
                paginationKey;
        }

        const started =
            Date.now();

        const response =
            await fetch(
                RPC_URL,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body:
                        JSON.stringify({
                            jsonrpc:
                                "2.0",

                            id:
                                `recent-${page}`,

                            method:
                                "getProgramAccountsV2",

                            params: [
                                METEORA_DLMM_PROGRAM,
                                config,
                            ],
                        }),
                }
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const json: any =
            await response.json();

        if (json.error) {
            throw new Error(
                JSON.stringify(
                    json.error
                )
            );
        }

        const contextSlot =
            json.result
                ?.context?.slot ??
            null;

        const value =
            json.result?.value;

        const accounts =
            value?.accounts ??
            [];

        paginationKey =
            value?.paginationKey ??
            null;

        if (
            firstContextSlot ===
            null
        ) {
            firstContextSlot =
                contextSlot;
        }

        lastContextSlot =
            contextSlot;

        for (
            const item of accounts
        ) {
            const raw =
                Buffer.from(
                    item.account.data[0],
                    "base64"
                );

            if (
                raw.length <
                72
            ) {
                continue;
            }

            rows.push({
                positionAddress:
                    item.pubkey,

                poolAddress:
                    new PublicKey(
                        raw.subarray(
                            8,
                            40
                        )
                    ).toBase58(),

                ownerWallet:
                    new PublicKey(
                        raw.subarray(
                            40,
                            72
                        )
                    ).toBase58(),
            });
        }

        console.log(
            `[page ${page}]` +
            ` accounts=${accounts.length}` +
            ` total=${rows.length}` +
            ` slot=${contextSlot}` +
            ` time=${(
                (Date.now() -
                    started) /
                1000
            ).toFixed(2)}s`
        );

        if (
            paginationKey
        ) {
            await sleep(
                PAGE_DELAY_MS
            );
        }
    } while (
        paginationKey
    );

    return {
        rows,
        pages: page,
        firstContextSlot,
        lastContextSlot,
    };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const started =
        Date.now();

    const targetUnix =
        Math.floor(
            (
                Date.now() -
                DAYS *
                24 *
                60 *
                60 *
                1000
            ) / 1000
        );

    const cutoffSlot =
        await findSlotForTimestamp(
            targetUnix
        );

    const result =
        await getRecentPositions(
            cutoffSlot
        );

    // Safety dedup.
    const positionMap =
        new Map<
            string,
            PositionRow
        >();

    for (
        const row of
        result.rows
    ) {
        positionMap.set(
            row.positionAddress,
            row
        );
    }

    const positions =
        [
            ...positionMap.values(),
        ];

    const uniquePools =
        new Set(
            positions.map(
                (x) =>
                    x.poolAddress
            )
        );

    const uniqueWallets =
        new Set(
            positions.map(
                (x) =>
                    x.ownerWallet
            )
        );

    const output = {
        generatedAt:
            new Date().toISOString(),

        scanDays:
            DAYS,

        cutoffTimestampUtc:
            new Date(
                targetUnix *
                1000
            ).toISOString(),

        cutoffSlot,

        pagesFetched:
            result.pages,

        rowsFetched:
            result.rows.length,

        uniquePositions:
            positions.length,

        uniquePools:
            uniquePools.size,

        uniqueWallets:
            uniqueWallets.size,

        firstContextSlot:
            result.firstContextSlot,

        lastContextSlot:
            result.lastContextSlot,

        positions,
    };

    await fs.mkdir(
        "output",
        {
            recursive: true,
        }
    );

    const outputPath =
        path.resolve(
            "output/meteora-positionv2-changed-7d.json"
        );

    await fs.writeFile(
        outputPath,
        JSON.stringify(
            output,
            null,
            2
        )
    );

    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        "POSITIONV2 CHANGED 7D COMPLETE"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Cutoff slot       : ${cutoffSlot}`
    );

    console.log(
        `Pages fetched     : ${result.pages}`
    );

    console.log(
        `Rows fetched      : ${result.rows.length}`
    );

    console.log(
        `Unique positions  : ${positions.length}`
    );

    console.log(
        `Unique pools      : ${uniquePools.size}`
    );

    console.log(
        `Unique wallets    : ${uniqueWallets.size}`
    );

    console.log(
        `Elapsed           : ${(
            (Date.now() -
                started) /
            1000
        ).toFixed(2)}s`
    );

    console.log(
        `Output            : ${outputPath}`
    );

    console.log(
        "========================================"
    );
}

main().catch(
    (error) => {
        console.error(
            "\n[RECENT SCAN FAILED]"
        );

        console.error(error);

        process.exit(1);
    }
);