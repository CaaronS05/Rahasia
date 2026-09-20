import fs from "node:fs/promises";
import crypto from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const RPC_URL =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const INPUT =
    "output/decode-5-lp-transactions.json";

type DecodedRow = {
    signature: string;
    instruction: string;
    category: string;
    position: string | null;
    pool: string | null;
    actor: string | null;
};

function anchorDiscriminator(name: string) {
    return crypto
        .createHash("sha256")
        .update(`account:${name}`)
        .digest()
        .subarray(0, 8);
}

async function getMultipleAccounts(
    addresses: string[]
) {
    const response = await fetch(
        RPC_URL,
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
                        commitment:
                            "confirmed",

                        encoding:
                            "base64",
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
    const raw =
        JSON.parse(
            await fs.readFile(
                INPUT,
                "utf8"
            )
        );

    const decoded:
        DecodedRow[] =
        raw.decoded ?? [];

    // ==========================================================
    // ONE EXPECTED RECORD PER POSITION
    // ==========================================================

    const positionMap =
        new Map<
            string,
            {
                position: string;
                expectedActor: string | null;
                expectedPool: string | null;
            }
        >();

    for (const row of decoded) {
        if (!row.position) {
            continue;
        }

        const existing =
            positionMap.get(
                row.position
            );

        if (!existing) {
            positionMap.set(
                row.position,
                {
                    position:
                        row.position,

                    expectedActor:
                        row.actor,

                    expectedPool:
                        row.pool,
                }
            );

            continue;
        }

        // Fill missing context from sibling instructions.
        if (
            !existing.expectedActor &&
            row.actor
        ) {
            existing.expectedActor =
                row.actor;
        }

        if (
            !existing.expectedPool &&
            row.pool
        ) {
            existing.expectedPool =
                row.pool;
        }
    }

    const rows =
        [...positionMap.values()];

    const addresses =
        rows.map(
            (x) =>
                x.position
        );

    console.log(
        "=== VERIFY ACTOR VS POSITION OWNER ==="
    );

    console.log(
        `Positions : ${addresses.length}`
    );

    // ==========================================================
    // SINGLE RPC REQUEST
    // ==========================================================

    const accounts =
        await getMultipleAccounts(
            addresses
        );

    const positionV2Disc =
        anchorDiscriminator(
            "PositionV2"
        );

    const positionDisc =
        anchorDiscriminator(
            "Position"
        );

    let matched = 0;
    let mismatched = 0;
    let deleted = 0;
    let nonV2 = 0;

    const results =
        rows.map(
            (
                row,
                index
            ) => {
                const account =
                    accounts[index];

                if (!account) {
                    deleted++;

                    return {
                        position:
                            row.position,

                        status:
                            "DELETED",

                        expectedActor:
                            row.expectedActor,

                        onchainOwner:
                            null,

                        actorMatches:
                            null,

                        expectedPool:
                            row.expectedPool,

                        onchainPool:
                            null,

                        poolMatches:
                            null,
                    };
                }

                const data =
                    Buffer.from(
                        account.data[0],
                        "base64"
                    );

                if (
                    data.length < 8
                ) {
                    nonV2++;

                    return {
                        position:
                            row.position,

                        status:
                            "INVALID_DATA",

                        expectedActor:
                            row.expectedActor,

                        onchainOwner:
                            null,

                        actorMatches:
                            null,

                        expectedPool:
                            row.expectedPool,

                        onchainPool:
                            null,

                        poolMatches:
                            null,
                    };
                }

                const disc =
                    data.subarray(
                        0,
                        8
                    );

                const isV2 =
                    disc.equals(
                        positionV2Disc
                    );

                const isLegacy =
                    disc.equals(
                        positionDisc
                    );

                if (!isV2) {
                    nonV2++;

                    return {
                        position:
                            row.position,

                        status:
                            isLegacy
                                ? "LEGACY_POSITION"
                                : "UNKNOWN_ACCOUNT",

                        expectedActor:
                            row.expectedActor,

                        onchainOwner:
                            null,

                        actorMatches:
                            null,

                        expectedPool:
                            row.expectedPool,

                        onchainPool:
                            null,

                        poolMatches:
                            null,
                    };
                }

                if (
                    data.length < 72
                ) {
                    nonV2++;

                    return {
                        position:
                            row.position,

                        status:
                            "POSITIONV2_TOO_SHORT",

                        expectedActor:
                            row.expectedActor,

                        onchainOwner:
                            null,

                        actorMatches:
                            null,

                        expectedPool:
                            row.expectedPool,

                        onchainPool:
                            null,

                        poolMatches:
                            null,
                    };
                }

                const onchainPool =
                    new PublicKey(
                        data.subarray(
                            8,
                            40
                        )
                    ).toBase58();

                const onchainOwner =
                    new PublicKey(
                        data.subarray(
                            40,
                            72
                        )
                    ).toBase58();

                const actorMatches =
                    row.expectedActor
                        ? row.expectedActor ===
                        onchainOwner
                        : null;

                const poolMatches =
                    row.expectedPool
                        ? row.expectedPool ===
                        onchainPool
                        : null;

                if (
                    actorMatches ===
                    true
                ) {
                    matched++;
                }

                if (
                    actorMatches ===
                    false
                ) {
                    mismatched++;
                }

                return {
                    position:
                        row.position,

                    status:
                        "POSITIONV2",

                    expectedActor:
                        row.expectedActor,

                    onchainOwner,

                    actorMatches,

                    expectedPool:
                        row.expectedPool,

                    onchainPool,

                    poolMatches,
                };
            }
        );

    console.table(results);

    console.log(
        "\n========================================"
    );

    console.log(
        "OWNER VERIFICATION RESULT"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Positions tested      : ${results.length}`
    );

    console.log(
        `Owner matches actor   : ${matched}`
    );

    console.log(
        `Owner mismatch actor  : ${mismatched}`
    );

    console.log(
        `Deleted positions     : ${deleted}`
    );

    console.log(
        `Legacy / unknown      : ${nonV2}`
    );

    console.log(
        "========================================"
    );

    await fs.writeFile(
        "output/verify-decoded-owner.json",
        JSON.stringify(
            {
                generatedAt:
                    new Date()
                        .toISOString(),

                summary: {
                    tested:
                        results.length,

                    matched,

                    mismatched,

                    deleted,

                    nonV2,
                },

                results,
            },
            null,
            2
        )
    );
}

main().catch(
    (error) => {
        console.error(error);
        process.exit(1);
    }
);