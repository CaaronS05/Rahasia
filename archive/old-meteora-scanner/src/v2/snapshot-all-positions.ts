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

const PAGE_SIZE = Number(
    process.env.GPAV2_PAGE_SIZE || "5000"
);

// Kita sengaja jalan sekitar 4 request/detik.
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

function discriminator(name: string) {
    return crypto
        .createHash("sha256")
        .update(`account:${name}`)
        .digest()
        .subarray(0, 8);
}

async function main() {
    const started = Date.now();

    const positionV2Discriminator =
        bs58.encode(discriminator("PositionV2"));

    const positions: PositionRow[] = [];

    let paginationKey: string | null = null;
    let page = 0;

    let firstSlot: number | null = null;
    let lastSlot: number | null = null;

    console.log(
        "=== METEORA DLMM — FULL CURRENT POSITIONV2 SNAPSHOT ==="
    );

    console.log(`Page size : ${PAGE_SIZE}`);
    console.log("");

    do {
        page++;

        const config: any = {
            commitment: "confirmed",
            encoding: "base64",
            withContext: true,

            limit: PAGE_SIZE,

            filters: [
                {
                    memcmp: {
                        offset: 0,
                        bytes: positionV2Discriminator,
                    },
                },
            ],

            dataSlice: {
                offset: 0,
                length: 72,
            },
        };

        if (paginationKey) {
            config.paginationKey = paginationKey;
        }

        const pageStarted = Date.now();

        const response = await fetch(RPC_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                jsonrpc: "2.0",
                id: `meteora-page-${page}`,
                method: "getProgramAccountsV2",

                params: [
                    METEORA_DLMM_PROGRAM,
                    config,
                ],
            }),
        });

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status} ${response.statusText}`
            );
        }

        const json: any = await response.json();

        if (json.error) {
            throw new Error(
                `RPC error: ${JSON.stringify(json.error)}`
            );
        }

        const slot =
            json.result?.context?.slot ?? null;

        const value =
            json.result?.value;

        const accounts =
            value?.accounts ?? [];

        paginationKey =
            value?.paginationKey ?? null;

        if (firstSlot === null) {
            firstSlot = slot;
        }

        lastSlot = slot;

        for (const item of accounts) {
            const raw = Buffer.from(
                item.account.data[0],
                "base64"
            );

            if (raw.length < 72) {
                continue;
            }

            positions.push({
                positionAddress:
                    item.pubkey,

                poolAddress:
                    new PublicKey(
                        raw.subarray(8, 40)
                    ).toBase58(),

                ownerWallet:
                    new PublicKey(
                        raw.subarray(40, 72)
                    ).toBase58(),
            });
        }

        const uniquePools =
            new Set(
                positions.map(
                    (x) => x.poolAddress
                )
            ).size;

        const uniqueWallets =
            new Set(
                positions.map(
                    (x) => x.ownerWallet
                )
            ).size;

        console.log(
            `[page ${page}]` +
            ` accounts=${accounts.length}` +
            ` total=${positions.length}` +
            ` pools=${uniquePools}` +
            ` wallets=${uniqueWallets}` +
            ` slot=${slot}` +
            ` time=${(
                (Date.now() - pageStarted) /
                1000
            ).toFixed(2)}s`
        );

        // Save cursor supaya kalau proses stop,
        // kita punya informasi progress.
        await fs.mkdir("output", {
            recursive: true,
        });

        await fs.writeFile(
            "output/gpav2-progress.json",
            JSON.stringify(
                {
                    page,
                    total_positions:
                        positions.length,
                    pagination_key:
                        paginationKey,
                    last_slot:
                        slot,
                    updated_at:
                        new Date().toISOString(),
                },
                null,
                2
            )
        );

        if (paginationKey) {
            await sleep(PAGE_DELAY_MS);
        }

    } while (paginationKey);

    // ==========================================================
    // DEDUP SAFETY
    // ==========================================================

    const positionMap =
        new Map<string, PositionRow>();

    for (const row of positions) {
        positionMap.set(
            row.positionAddress,
            row
        );
    }

    const uniquePositions =
        [...positionMap.values()];

    const uniquePools =
        new Set(
            uniquePositions.map(
                (x) => x.poolAddress
            )
        );

    const uniqueWallets =
        new Set(
            uniquePositions.map(
                (x) => x.ownerWallet
            )
        );

    // ==========================================================
    // AGGREGATE POOLS
    // ==========================================================

    const poolStats =
        new Map<
            string,
            {
                positions: number;
                wallets: Set<string>;
            }
        >();

    for (const row of uniquePositions) {
        let pool =
            poolStats.get(
                row.poolAddress
            );

        if (!pool) {
            pool = {
                positions: 0,
                wallets: new Set(),
            };

            poolStats.set(
                row.poolAddress,
                pool
            );
        }

        pool.positions++;
        pool.wallets.add(
            row.ownerWallet
        );
    }

    const pools = [
        ...poolStats.entries(),
    ]
        .map(
            ([
                poolAddress,
                stats,
            ]) => ({
                poolAddress,
                positionCount:
                    stats.positions,
                uniqueWallets:
                    stats.wallets.size,
            })
        )
        .sort(
            (a, b) =>
                b.positionCount -
                a.positionCount
        );

    const elapsed =
        (
            (Date.now() -
                started) /
            1000
        ).toFixed(2);

    const output = {
        generatedAt:
            new Date().toISOString(),

        program:
            METEORA_DLMM_PROGRAM,

        accountType:
            "PositionV2",

        firstSlot,
        lastSlot,

        pageSize:
            PAGE_SIZE,

        pagesFetched:
            page,

        totalRowsFetched:
            positions.length,

        uniquePositions:
            uniquePositions.length,

        uniquePools:
            uniquePools.size,

        uniqueWallets:
            uniqueWallets.size,

        elapsedSeconds:
            Number(elapsed),

        positions:
            uniquePositions,

        pools,
    };

    const outputPath =
        path.resolve(
            "output/meteora-current-positionv2-snapshot.json"
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
        "FULL POSITIONV2 SNAPSHOT COMPLETE"
    );
    console.log(
        "========================================"
    );

    console.log(
        `Pages fetched     : ${page}`
    );

    console.log(
        `Rows fetched      : ${positions.length}`
    );

    console.log(
        `Unique positions  : ${uniquePositions.length}`
    );

    console.log(
        `Unique pools      : ${uniquePools.size}`
    );

    console.log(
        `Unique wallets    : ${uniqueWallets.size}`
    );

    console.log(
        `First slot        : ${firstSlot}`
    );

    console.log(
        `Last slot         : ${lastSlot}`
    );

    console.log(
        `Elapsed           : ${elapsed}s`
    );

    console.log(
        `Output            : ${outputPath}`
    );

    console.log(
        "========================================"
    );

    console.log(
        "\nTop 20 pools by current positions:"
    );

    console.table(
        pools.slice(0, 20)
    );
}

main().catch((error) => {
    console.error("\n[SNAPSHOT FAILED]");
    console.error(error);
    process.exit(1);
});