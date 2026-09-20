import fs from "node:fs/promises";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const HELIUS_RPC_URL =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_API =
    "https://dlmm.datapi.meteora.ag";

// Wallet yang sebelumnya terbukti:
// banyak closed positions + 0 open positions
const WALLET =
    process.env.TEST_WALLET ||
    "5Rc6NgqCUenHp13s2TJf21pr88siak9vTtf1xb7FTENi";

function isPubkey(value: unknown): value is string {
    if (typeof value !== "string") return false;

    try {
        new PublicKey(value);
        return true;
    } catch {
        return false;
    }
}

// Cari field seperti:
// position
// positionAddress
// position_address
// positionPubkey
// dst.
function findPositionAddresses(
    value: unknown,
    found = new Set<string>()
): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) {
            findPositionAddresses(item, found);
        }

        return found;
    }

    if (
        value &&
        typeof value === "object"
    ) {
        for (const [key, child] of Object.entries(value)) {
            const normalized =
                key.toLowerCase();

            if (
                normalized.includes("position") &&
                isPubkey(child)
            ) {
                found.add(child);
            }

            findPositionAddresses(child, found);
        }
    }

    return found;
}

async function getJson(url: string) {
    const response = await fetch(url);

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}\n${text}`
        );
    }

    return JSON.parse(text);
}

async function heliusGetMultipleAccounts(
    addresses: string[]
) {
    const response = await fetch(
        HELIUS_RPC_URL,
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",
            },

            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,

                method:
                    "getMultipleAccounts",

                params: [
                    addresses,

                    {
                        encoding: "base64",
                        commitment: "confirmed",
                    },
                ],
            }),
        }
    );

    const json: any =
        await response.json();

    if (json.error) {
        throw new Error(
            JSON.stringify(
                json.error
            )
        );
    }

    return json.result?.value ?? [];
}

async function main() {
    console.log(
        "=== CLOSED POSITION GAP TEST ==="
    );

    console.log(
        `Wallet : ${WALLET}`
    );

    // ==========================================================
    // STEP 1 — CLOSED PORTFOLIO
    // ==========================================================

    console.log(
        "\n=== STEP 1: CLOSED PORTFOLIO ==="
    );

    const closedPortfolio =
        await getJson(
            `${METEORA_API}/portfolio?user=${WALLET}&page=1&page_size=20`
        );

    console.log(
        `Total positions : ${closedPortfolio.totalPositions ??
        "unknown"
        }`
    );

    console.log(
        `Total pools     : ${closedPortfolio.totalCount ??
        "unknown"
        }`
    );

    const closedPools =
        Array.isArray(
            closedPortfolio.pools
        )
            ? closedPortfolio.pools
            : [];

    if (
        closedPools.length === 0
    ) {
        throw new Error(
            "Tidak ada closed pool pada portfolio."
        );
    }

    // Pilih pool dengan lastClosedAt terbaru.
    closedPools.sort(
        (a: any, b: any) => {
            const ta =
                new Date(
                    a.lastClosedAt ?? 0
                ).getTime();

            const tb =
                new Date(
                    b.lastClosedAt ?? 0
                ).getTime();

            return tb - ta;
        }
    );

    const selectedPool =
        closedPools[0];

    const poolAddress =
        selectedPool.poolAddress;

    if (
        !poolAddress ||
        !isPubkey(poolAddress)
    ) {
        throw new Error(
            "Pool address tidak ditemukan."
        );
    }

    console.log(
        `Selected pool   : ${poolAddress}`
    );

    console.log(
        `Last closed     : ${selectedPool.lastClosedAt ??
        "unknown"
        }`
    );

    // ==========================================================
    // STEP 2 — CHECK CURRENT OPEN POSITIONS
    // ==========================================================

    console.log(
        "\n=== STEP 2: OPEN PORTFOLIO CHECK ==="
    );

    const openPortfolio =
        await getJson(
            `${METEORA_API}/portfolio/open?user=${WALLET}`
        );

    console.log(
        `Current open positions : ${openPortfolio.totalPositions ??
        0
        }`
    );

    // ==========================================================
    // STEP 3 — PNL FOR CLOSED POOL
    // ==========================================================

    console.log(
        "\n=== STEP 3: POSITION PNL ==="
    );

    const pnl =
        await getJson(
            `${METEORA_API}/positions/${poolAddress}/pnl?user=${WALLET}`
        );

    const positionAddresses =
        [
            ...findPositionAddresses(
                pnl
            ),
        ];

    console.log(
        `Position addresses discovered : ${positionAddresses.length}`
    );

    // Save raw response supaya kalau struktur API beda,
    // kita tetap bisa inspect tanpa request ulang.
    await fs.mkdir(
        "output",
        {
            recursive: true,
        }
    );

    const rawPath =
        path.resolve(
            "output/closed-position-pnl-raw.json"
        );

    await fs.writeFile(
        rawPath,
        JSON.stringify(
            pnl,
            null,
            2
        )
    );

    if (
        positionAddresses.length === 0
    ) {
        console.log(
            "\n⚠️ Tidak menemukan position address otomatis."
        );

        console.log(
            `Raw PnL disimpan di: ${rawPath}`
        );

        console.log(
            "Kirim file tersebut ke aku, kita baca struktur responsenya."
        );

        return;
    }

    console.log(
        "\nSample positions:"
    );

    console.table(
        positionAddresses
            .slice(0, 10)
            .map(
                (
                    position,
                    index
                ) => ({
                    index:
                        index + 1,

                    position,
                })
            )
    );

    // ==========================================================
    // STEP 4 — CHECK WHETHER CLOSED ACCOUNTS STILL EXIST
    // ==========================================================

    console.log(
        "\n=== STEP 4: HELIUS getMultipleAccounts ==="
    );

    // Cukup test max 20 position dalam SATU RPC request.
    const testPositions =
        positionAddresses.slice(
            0,
            20
        );

    const accounts =
        await heliusGetMultipleAccounts(
            testPositions
        );

    const results =
        testPositions.map(
            (
                position,
                index
            ) => {
                const account =
                    accounts[index];

                return {
                    position,
                    existsNow:
                        account !== null,

                    lamports:
                        account?.lamports ??
                        null,

                    dataLength:
                        account?.data?.[0]
                            ? Buffer.from(
                                account.data[0],
                                "base64"
                            ).length
                            : null,
                };
            }
        );

    const existing =
        results.filter(
            (x) =>
                x.existsNow
        ).length;

    const deleted =
        results.length -
        existing;

    console.table(results);

    // ==========================================================
    // SUMMARY
    // ==========================================================

    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        "CLOSED POSITION GAP RESULT"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Wallet                 : ${WALLET}`
    );

    console.log(
        `Pool                   : ${poolAddress}`
    );

    console.log(
        `Current open positions : ${openPortfolio.totalPositions ??
        0
        }`
    );

    console.log(
        `Closed positions found : ${positionAddresses.length}`
    );

    console.log(
        `Positions tested       : ${results.length}`
    );

    console.log(
        `Accounts still exist   : ${existing}`
    );

    console.log(
        `Accounts deleted/null  : ${deleted}`
    );

    console.log(
        `Raw Meteora PnL        : ${rawPath}`
    );

    console.log(
        "========================================"
    );

    const resultPath =
        path.resolve(
            "output/closed-position-gap-result.json"
        );

    await fs.writeFile(
        resultPath,
        JSON.stringify(
            {
                wallet:
                    WALLET,

                poolAddress,

                currentOpenPositions:
                    openPortfolio.totalPositions ??
                    0,

                closedPositionsDiscovered:
                    positionAddresses.length,

                positionsTested:
                    results.length,

                existingAccounts:
                    existing,

                deletedAccounts:
                    deleted,

                results,
            },
            null,
            2
        )
    );
}

main().catch(
    (error) => {
        console.error(
            "\n[TEST FAILED]"
        );

        console.error(error);

        process.exit(1);
    }
);