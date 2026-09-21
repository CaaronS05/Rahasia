import fs from "node:fs/promises";
import path from "node:path";
import bs58 from "bs58";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const RPC_URL =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const IDL_URL =
    "https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json";

/*
  5 sample dari strict probe kita:

  1. initialize + add
  2. remove + claim + close
  3. claim fee
  4. rebalance
  5. add liquidity 2
*/
const DEFAULT_SIGNATURES = [
    "4g7vtt5Jm9QCpFZ6xfxRmRySUS2WJTYymxwd2KCRBXiyDNCL9yhzCBngeyFS2fG9k3pJas6UGcEMjov6gDsTwkvf",
    "2NmL5D9D2omrUYgiv6gvQTCafni7p4j2jAMZofizRpqSA45BvwafmwkTAkKcG2R6t7b8P1ZZmUSXm9rsKoGKvkMj",
    "5ZndVjhfotVGex7Dnt2wgJ2nkc4X4dA7cWCu51g2HHbhXJxH3AM9nA4a6gdT8YfbyJZXWxaMxm8DusBPkzphbDQv",
    "2KDvrGjXRP8b12LL1N2qXkxXugF48wZN3pUjLqoKCNbjMUavnvzTrcGhqQ3cX6CZ89hpXiaEk72p4wbCYJo5mc7X",
    "4KYrWp3n7QprFyUeea6ttrCgW6GHu1aeSUX6hx2drbVmGWCk2k3V2UpTdyWUFSJLdGoSxmdAZD9RLByP4k8duDLC",
];

const SIGNATURES =
    process.env.TEST_SIGNATURES
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    ?? DEFAULT_SIGNATURES;

// ============================================================
// TYPES
// ============================================================

type IdlAccount = {
    name?: string;
    accounts?: IdlAccount[];
};

type IdlInstruction = {
    name: string;
    discriminator: number[];
    accounts?: IdlAccount[];
};

type DecodedInstruction = {
    signature: string;
    source: string;
    instructionIndex: number;
    instruction: string;
    category: string;
    position: string | null;
    pool: string | null;
    actor: string | null;
    mappedAccounts: Record<string, string | null>;
};

// ============================================================
// IDL
// ============================================================

async function loadIdl() {
    const response = await fetch(IDL_URL);

    if (!response.ok) {
        throw new Error(
            `IDL HTTP ${response.status}`
        );
    }

    const idl: any =
        await response.json();

    const instructions: IdlInstruction[] =
        idl.instructions ?? [];

    const discriminatorMap =
        new Map<string, IdlInstruction>();

    for (const ix of instructions) {
        if (
            !ix.name ||
            !Array.isArray(ix.discriminator)
        ) {
            continue;
        }

        const hex =
            Buffer.from(
                ix.discriminator
            ).toString("hex");

        discriminatorMap.set(
            hex,
            ix
        );
    }

    console.log(
        `Loaded ${discriminatorMap.size} instruction discriminators`
    );

    return discriminatorMap;
}

// ============================================================
// FLATTEN IDL ACCOUNTS
// ============================================================

function flattenAccounts(
    accounts: IdlAccount[] = [],
    prefix = ""
): string[] {
    const result: string[] = [];

    for (const account of accounts) {
        if (account.accounts) {
            result.push(
                ...flattenAccounts(
                    account.accounts,
                    prefix
                )
            );

            continue;
        }

        if (!account.name) {
            result.push(
                `${prefix}unknown`
            );

            continue;
        }

        result.push(
            prefix
                ? `${prefix}.${account.name}`
                : account.name
        );
    }

    return result;
}

// ============================================================
// CATEGORY
// ============================================================

function classifyInstruction(
    name: string
) {
    if (
        name.startsWith(
            "initialize_position"
        )
    ) {
        return "initialize";
    }

    if (
        name.startsWith(
            "add_liquidity"
        )
    ) {
        return "add";
    }

    if (
        name.startsWith(
            "remove_liquidity"
        )
    ) {
        return "remove";
    }

    if (
        name.startsWith(
            "claim_fee"
        )
    ) {
        return "claim_fee";
    }

    if (
        name.startsWith(
            "claim_reward"
        )
    ) {
        return "claim_reward";
    }

    if (
        name.startsWith(
            "close_position"
        )
    ) {
        return "close";
    }

    if (
        name ===
        "rebalance_liquidity"
    ) {
        return "rebalance";
    }

    if (
        name.includes(
            "position_length"
        )
    ) {
        return "resize";
    }

    return "other";
}

// ============================================================
// HELPER
// ============================================================

function pubkeyString(
    value: any
): string | null {
    if (!value) {
        return null;
    }

    if (
        typeof value ===
        "string"
    ) {
        return value;
    }

    if (
        typeof value.pubkey ===
        "string"
    ) {
        return value.pubkey;
    }

    return String(value);
}

function findMapped(
    mapped: Record<
        string,
        string | null
    >,
    names: string[]
) {
    for (const name of names) {
        if (mapped[name]) {
            return mapped[name];
        }
    }

    return null;
}

// ============================================================
// BATCH GET TRANSACTION
// ============================================================

async function fetchTransactions(
    signatures: string[]
) {
    const payload =
        signatures.map(
            (
                signature,
                index
            ) => ({
                jsonrpc: "2.0",
                id: index + 1,

                method:
                    "getTransaction",

                params: [
                    signature,
                    {
                        commitment:
                            "confirmed",

                        encoding:
                            "jsonParsed",

                        maxSupportedTransactionVersion:
                            0,
                    },
                ],
            })
        );

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
                    JSON.stringify(
                        payload
                    ),
            }
        );

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}`
        );
    }

    const json: any[] =
        await response.json();

    return json.sort(
        (a, b) =>
            Number(a.id) -
            Number(b.id)
    );
}

// ============================================================
// DECODE ONE DLMM IX
// ============================================================

function decodeInstruction(
    ix: any,
    signature: string,
    source: string,
    instructionIndex: number,
    discriminatorMap:
        Map<string, IdlInstruction>
): DecodedInstruction | null {

    const programId =
        pubkeyString(
            ix.programId
        );

    if (
        programId !==
        METEORA_PROGRAM
    ) {
        return null;
    }

    if (
        typeof ix.data !==
        "string"
    ) {
        return null;
    }

    const raw =
        Buffer.from(
            bs58.decode(
                ix.data
            )
        );

    if (
        raw.length < 8
    ) {
        return null;
    }

    const discriminator =
        raw
            .subarray(0, 8)
            .toString("hex");

    const definition =
        discriminatorMap.get(
            discriminator
        );

    if (!definition) {
        return null;
    }

    const accountNames =
        flattenAccounts(
            definition.accounts
        );

    const actualAccounts:
        string[] =
        Array.isArray(
            ix.accounts
        )
            ? ix.accounts.map(
                (
                    account: any
                ) =>
                    pubkeyString(
                        account
                    ) ?? ""
            )
            : [];

    const mappedAccounts:
        Record<
            string,
            string | null
        > = {};

    for (
        let i = 0;
        i <
        accountNames.length;
        i++
    ) {
        mappedAccounts[
            accountNames[i]
        ] =
            actualAccounts[i] ??
            null;
    }

    const position =
        findMapped(
            mappedAccounts,
            [
                "position",
                "position_v2",
            ]
        );

    const pool =
        findMapped(
            mappedAccounts,
            [
                "lb_pair",
                "pool",
            ]
        );

    const actor =
        findMapped(
            mappedAccounts,
            [
                "sender",
                "owner",
                "user",
                "authority",
                "position_authority",
            ]
        );

    return {
        signature,

        source,

        instructionIndex,

        instruction:
            definition.name,

        category:
            classifyInstruction(
                definition.name
            ),

        position,

        pool,

        actor,

        mappedAccounts,
    };
}

// ============================================================
// EXTRACT TX
// ============================================================

function decodeTransaction(
    signature: string,
    tx: any,
    discriminatorMap:
        Map<string, IdlInstruction>
) {
    const decoded:
        DecodedInstruction[] =
        [];

    // ----------------------------
    // TOP LEVEL
    // ----------------------------

    const topInstructions =
        tx?.transaction
            ?.message
            ?.instructions ?? [];

    topInstructions.forEach(
        (
            ix: any,
            index: number
        ) => {
            const result =
                decodeInstruction(
                    ix,
                    signature,
                    "top-level",
                    index,
                    discriminatorMap
                );

            if (result) {
                decoded.push(
                    result
                );
            }
        }
    );

    // ----------------------------
    // INNER / CPI
    // ----------------------------

    const innerGroups =
        tx?.meta
            ?.innerInstructions ??
        [];

    for (
        const group of
        innerGroups
    ) {
        const instructions =
            group.instructions ??
            [];

        instructions.forEach(
            (
                ix: any,
                index: number
            ) => {
                const result =
                    decodeInstruction(
                        ix,
                        signature,
                        `inner(parent=${group.index})`,
                        index,
                        discriminatorMap
                    );

                if (result) {
                    decoded.push(
                        result
                    );
                }
            }
        );
    }

    return decoded;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log(
        "=== DECODE 5 METEORA LP TRANSACTIONS ==="
    );

    console.log(
        `Transactions : ${SIGNATURES.length}`
    );

    const discriminatorMap =
        await loadIdl();

    const responses =
        await fetchTransactions(
            SIGNATURES
        );

    const allDecoded:
        DecodedInstruction[] =
        [];

    for (
        let i = 0;
        i <
        responses.length;
        i++
    ) {
        const response =
            responses[i];

        const signature =
            SIGNATURES[i];

        console.log(
            "\n========================================"
        );

        console.log(
            `TX ${i + 1}/${SIGNATURES.length}`
        );

        console.log(
            `Signature : ${signature}`
        );

        if (
            response.error
        ) {
            console.log(
                `RPC ERROR: ${JSON.stringify(
                    response.error
                )}`
            );

            continue;
        }

        if (
            !response.result
        ) {
            console.log(
                "Transaction result = null"
            );

            continue;
        }

        const decoded =
            decodeTransaction(
                signature,
                response.result,
                discriminatorMap
            );

        allDecoded.push(
            ...decoded
        );

        if (
            decoded.length ===
            0
        ) {
            console.log(
                "No Meteora instruction decoded."
            );

            continue;
        }

        console.table(
            decoded.map(
                (row) => ({
                    source:
                        row.source,

                    category:
                        row.category,

                    instruction:
                        row.instruction,

                    position:
                        row.position,

                    pool:
                        row.pool,

                    actor:
                        row.actor,
                })
            )
        );

        for (
            const row of
            decoded
        ) {
            console.log(
                `\n[${row.instruction}] mapped accounts`
            );

            console.table(
                Object.entries(
                    row.mappedAccounts
                ).map(
                    ([
                        name,
                        address,
                    ]) => ({
                        name,
                        address,
                    })
                )
            );
        }
    }

    await fs.mkdir(
        "output",
        {
            recursive: true,
        }
    );

    const outputPath =
        path.resolve(
            "output/decode-5-lp-transactions.json"
        );

    await fs.writeFile(
        outputPath,
        JSON.stringify(
            {
                generatedAt:
                    new Date()
                        .toISOString(),

                signatures:
                    SIGNATURES,

                decoded:
                    allDecoded,
            },
            null,
            2
        )
    );

    const uniquePositions =
        new Set(
            allDecoded
                .map(
                    (x) =>
                        x.position
                )
                .filter(Boolean)
        );

    const uniquePools =
        new Set(
            allDecoded
                .map(
                    (x) =>
                        x.pool
                )
                .filter(Boolean)
        );

    const uniqueActors =
        new Set(
            allDecoded
                .map(
                    (x) =>
                        x.actor
                )
                .filter(Boolean)
        );

    console.log(
        "\n========================================"
    );

    console.log(
        "DECODER PROBE COMPLETE"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Transactions tested : ${SIGNATURES.length}`
    );

    console.log(
        `DLMM instructions    : ${allDecoded.length}`
    );

    console.log(
        `Unique positions     : ${uniquePositions.size}`
    );

    console.log(
        `Unique pools         : ${uniquePools.size}`
    );

    console.log(
        `Unique actors        : ${uniqueActors.size}`
    );

    console.log(
        `Output               : ${outputPath}`
    );

    console.log(
        "========================================"
    );
}

main().catch(
    (error) => {
        console.error(
            "\n[DECODER FAILED]"
        );

        console.error(error);

        process.exit(1);
    }
);