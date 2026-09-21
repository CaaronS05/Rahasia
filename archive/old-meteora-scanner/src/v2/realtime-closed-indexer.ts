import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import WebSocket from "ws";
import bs58 from "bs58";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada.");
}

const RPC_URL =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WS_URL =
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const IDL_URL =
    "https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json";

const OUTPUT_DIR = "output";

const EVENTS_FILE =
    path.join(
        OUTPUT_DIR,
        "realtime-closed-positions.jsonl"
    );

const STATE_FILE =
    path.join(
        OUTPUT_DIR,
        "realtime-closed-indexer-state.json"
    );

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

type DecodedIx = {
    instruction: string;
    position: string | null;
    pool: string | null;
    actor: string | null;
};

type ClosedEvent = {
    detectedAtUtc: string;

    signature: string;

    slot: number | null;
    blockTimeUtc: string | null;

    positionAddress: string;
    poolAddress: string | null;
    ownerWallet: string;

    closeInstruction: string;

    ownerSource:
    "close_instruction_actor";

    poolSource:
    | "transaction_sibling"
    | "meteora_historical"
    | "unknown";
};

// ============================================================
// IDL
// ============================================================

function flattenAccounts(
    accounts: IdlAccount[] = []
): string[] {

    const output: string[] = [];

    for (const account of accounts) {
        if (account.accounts) {
            output.push(
                ...flattenAccounts(
                    account.accounts
                )
            );

            continue;
        }

        if (account.name) {
            output.push(
                account.name
            );
        }
    }

    return output;
}

async function loadIdl() {
    const response =
        await fetch(IDL_URL);

    if (!response.ok) {
        throw new Error(
            `IDL HTTP ${response.status}`
        );
    }

    const idl: any =
        await response.json();

    const map =
        new Map<
            string,
            IdlInstruction
        >();

    for (
        const ix of
        idl.instructions ?? []
    ) {
        if (
            !ix.name ||
            !Array.isArray(
                ix.discriminator
            )
        ) {
            continue;
        }

        const hex =
            Buffer.from(
                ix.discriminator
            ).toString("hex");

        map.set(
            hex,
            ix
        );
    }

    console.log(
        `Loaded ${map.size} Meteora instruction discriminators`
    );

    return map;
}

// ============================================================
// LOG PARSER
// ============================================================

function getDirectDlmmInstructions(
    logs: string[]
) {
    const stack: string[] =
        [];

    const instructions:
        string[] = [];

    for (const log of logs) {

        const invoke =
            log.match(
                /^Program ([A-Za-z0-9]+) invoke \[(\d+)\]$/
            );

        if (invoke) {
            const program =
                invoke[1];

            const depth =
                Number(
                    invoke[2]
                );

            stack[
                depth - 1
            ] = program;

            stack.length =
                depth;

            continue;
        }

        const finish =
            log.match(
                /^Program ([A-Za-z0-9]+) (success|failed:.*)$/
            );

        if (finish) {
            const index =
                stack.lastIndexOf(
                    finish[1]
                );

            if (
                index >= 0
            ) {
                stack.length =
                    index;
            }

            continue;
        }

        const currentProgram =
            stack[
            stack.length - 1
            ];

        if (
            currentProgram !==
            DLMM_PROGRAM
        ) {
            continue;
        }

        const ix =
            log.match(
                /^Program log: Instruction: (.+)$/
            );

        if (ix) {
            instructions.push(
                ix[1].trim()
            );
        }
    }

    return instructions;
}

function hasCloseInstruction(
    instructions: string[]
) {
    return instructions.some(
        (name) =>
            name.startsWith(
                "ClosePosition"
            )
    );
}

// ============================================================
// RPC
// ============================================================

async function getTransaction(
    signature: string
) {
    for (
        let attempt = 1;
        attempt <= 4;
        attempt++
    ) {
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

                            id: 1,

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

        if (json.result) {
            return json.result;
        }

        // Kadang WebSocket datang sedikit lebih dulu
        // daripada getTransaction tersedia.
        await new Promise(
            (resolve) =>
                setTimeout(
                    resolve,
                    attempt * 500
                )
        );
    }

    return null;
}

// ============================================================
// INSTRUCTION DECODER
// ============================================================

function pubkey(
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

    return null;
}

function decodeIx(
    ix: any,
    idlMap:
        Map<
            string,
            IdlInstruction
        >
): DecodedIx | null {

    if (
        pubkey(
            ix.programId
        ) !==
        DLMM_PROGRAM
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

    const disc =
        raw
            .subarray(0, 8)
            .toString("hex");

    const definition =
        idlMap.get(
            disc
        );

    if (!definition) {
        return null;
    }

    const names =
        flattenAccounts(
            definition.accounts
        );

    const accounts =
        (ix.accounts ?? [])
            .map(
                (
                    account: any
                ) =>
                    pubkey(
                        account
                    )
            );

    const mapped =
        new Map<
            string,
            string | null
        >();

    names.forEach(
        (
            name,
            index
        ) => {
            mapped.set(
                name,
                accounts[index] ??
                null
            );
        }
    );

    const find =
        (
            candidates:
                string[]
        ) => {
            for (
                const candidate of
                candidates
            ) {
                const value =
                    mapped.get(
                        candidate
                    );

                if (value) {
                    return value;
                }
            }

            return null;
        };

    return {
        instruction:
            definition.name,

        position:
            find([
                "position",
                "position_v2",
            ]),

        pool:
            find([
                "lb_pair",
                "pool",
            ]),

        actor:
            find([
                "sender",
                "owner",
                "user",
                "authority",
                "position_authority",
            ]),
    };
}

function decodeTransaction(
    tx: any,
    idlMap:
        Map<
            string,
            IdlInstruction
        >
) {
    const decoded:
        DecodedIx[] = [];

    const top =
        tx?.transaction
            ?.message
            ?.instructions ??
        [];

    for (const ix of top) {
        const value =
            decodeIx(
                ix,
                idlMap
            );

        if (value) {
            decoded.push(
                value
            );
        }
    }

    for (
        const group of
        tx?.meta
            ?.innerInstructions ??
        []
    ) {
        for (
            const ix of
            group.instructions ??
            []
        ) {
            const value =
                decodeIx(
                    ix,
                    idlMap
                );

            if (value) {
                decoded.push(
                    value
                );
            }
        }
    }

    return decoded;
}

// ============================================================
// METEORA FALLBACK
// ============================================================

async function getPoolFromHistorical(
    position: string
) {
    try {
        const response =
            await fetch(
                `https://dlmm.datapi.meteora.ag/positions/${position}/historical`
            );

        if (!response.ok) {
            return null;
        }

        const json: any =
            await response.json();

        const events =
            Array.isArray(json)
                ? json
                : json.events ??
                json.data ??
                [];

        for (
            const event of events
        ) {
            if (
                event.poolAddress
            ) {
                return String(
                    event.poolAddress
                );
            }
        }

    } catch {
        // fallback gagal tidak boleh
        // mematikan indexer
    }

    return null;
}

// ============================================================
// PERSISTENCE
// ============================================================

const seen =
    new Set<string>();

async function loadExisting() {
    try {
        const text =
            await fs.readFile(
                EVENTS_FILE,
                "utf8"
            );

        for (
            const line of
            text.split("\n")
        ) {
            if (
                !line.trim()
            ) {
                continue;
            }

            try {
                const event =
                    JSON.parse(line);

                seen.add(
                    `${event.signature}:${event.positionAddress}`
                );
            } catch {
                // ignore broken line
            }
        }

    } catch {
        // first run
    }
}

async function saveEvent(
    event: ClosedEvent
) {
    const key =
        `${event.signature}:${event.positionAddress}`;

    if (
        seen.has(key)
    ) {
        return false;
    }

    seen.add(key);

    await fs.appendFile(
        EVENTS_FILE,

        JSON.stringify(
            event
        ) + "\n"
    );

    return true;
}

async function saveState(
    data: any
) {
    await fs.writeFile(
        STATE_FILE,

        JSON.stringify(
            {
                updatedAt:
                    new Date()
                        .toISOString(),

                ...data,
            },
            null,
            2
        )
    );
}

// ============================================================
// RESOLVE CLOSED EVENT
// ============================================================

async function processSignature(
    signature: string,
    idlMap:
        Map<
            string,
            IdlInstruction
        >
) {
    const tx =
        await getTransaction(
            signature
        );

    if (!tx) {
        console.log(
            `[MISS] getTransaction null ${signature}`
        );

        return;
    }

    const decoded =
        decodeTransaction(
            tx,
            idlMap
        );

    const closes =
        decoded.filter(
            (row) =>
                row.instruction
                    .startsWith(
                        "close_position"
                    )
        );

    if (
        closes.length === 0
    ) {
        return;
    }

    for (
        const close of
        closes
    ) {
        if (
            !close.position ||
            !close.actor
        ) {
            console.log(
                `[WARN] close missing position/actor ${signature}`
            );

            continue;
        }

        // Resolve pool from any other DLMM instruction
        // touching the same position.
        let pool =
            close.pool;

        let poolSource:
            ClosedEvent["poolSource"] =
            "transaction_sibling";

        if (!pool) {
            const sibling =
                decoded.find(
                    (row) =>
                        row.position ===
                        close.position &&
                        row.pool
                );

            pool =
                sibling?.pool ??
                null;
        }

        if (!pool) {
            pool =
                await getPoolFromHistorical(
                    close.position
                );

            poolSource =
                pool
                    ? "meteora_historical"
                    : "unknown";
        }

        const blockTimeUtc =
            typeof tx.blockTime ===
                "number"
                ? new Date(
                    tx.blockTime *
                    1000
                ).toISOString()
                : null;

        const event:
            ClosedEvent = {

            detectedAtUtc:
                new Date()
                    .toISOString(),

            signature,

            slot:
                tx.slot ??
                null,

            blockTimeUtc,

            positionAddress:
                close.position,

            poolAddress:
                pool,

            ownerWallet:
                close.actor,

            closeInstruction:
                close.instruction,

            ownerSource:
                "close_instruction_actor",

            poolSource,
        };

        const inserted =
            await saveEvent(
                event
            );

        if (!inserted) {
            continue;
        }

        console.log(
            "\n[CLOSED POSITION]"
        );

        console.log(
            `Wallet   : ${event.ownerWallet}`
        );

        console.log(
            `Position : ${event.positionAddress}`
        );

        console.log(
            `Pool     : ${event.poolAddress}`
        );

        console.log(
            `IX       : ${event.closeInstruction}`
        );

        console.log(
            `Time     : ${event.blockTimeUtc}`
        );

        console.log(
            `TX       : ${event.signature}`
        );
    }
}

// ============================================================
// SIMPLE QUEUE
// ============================================================

const queue:
    string[] = [];

const queued =
    new Set<string>();

let processing = false;

async function drainQueue(
    idlMap:
        Map<
            string,
            IdlInstruction
        >
) {
    if (processing) {
        return;
    }

    processing = true;

    while (
        queue.length >
        0
    ) {
        const signature =
            queue.shift()!;

        queued.delete(
            signature
        );

        try {
            await processSignature(
                signature,
                idlMap
            );
        } catch (error) {
            console.error(
                `[ERROR] ${signature}`,
                error
            );
        }
    }

    processing = false;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    await fs.mkdir(
        OUTPUT_DIR,
        {
            recursive: true,
        }
    );

    await loadExisting();

    const idlMap =
        await loadIdl();

    console.log(
        "========================================"
    );

    console.log(
        "METEORA REALTIME CLOSED POSITION INDEXER V1"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Existing records : ${seen.size}`
    );

    let ws:
        WebSocket;

    let received = 0;
    let closeCandidates = 0;
    let reconnects = 0;
    let lastSlot:
        number | null = null;

    function connect() {
        ws =
            new WebSocket(
                WS_URL
            );

        ws.on(
            "open",
            () => {
                console.log(
                    "✅ WebSocket connected"
                );

                ws.send(
                    JSON.stringify({
                        jsonrpc:
                            "2.0",

                        id:
                            Date.now(),

                        method:
                            "logsSubscribe",

                        params: [
                            {
                                mentions: [
                                    DLMM_PROGRAM,
                                ],
                            },

                            {
                                commitment:
                                    "confirmed",
                            },
                        ],
                    })
                );
            }
        );

        ws.on(
            "message",
            async (
                raw
            ) => {
                const msg =
                    JSON.parse(
                        raw.toString()
                    );

                if (
                    msg.method !==
                    "logsNotification"
                ) {
                    return;
                }

                const result =
                    msg.params
                        ?.result;

                const value =
                    result?.value;

                if (
                    !value ||
                    value.err !==
                    null
                ) {
                    return;
                }

                received++;

                lastSlot =
                    result?.context
                        ?.slot ??
                    lastSlot;

                const instructions =
                    getDirectDlmmInstructions(
                        value.logs ??
                        []
                    );

                if (
                    !hasCloseInstruction(
                        instructions
                    )
                ) {
                    return;
                }

                closeCandidates++;

                const signature =
                    value.signature;

                if (
                    !queued.has(
                        signature
                    )
                ) {
                    queued.add(
                        signature
                    );

                    queue.push(
                        signature
                    );

                    void drainQueue(
                        idlMap
                    );
                }

                if (
                    closeCandidates %
                    25 ===
                    0
                ) {
                    await saveState({
                        receivedDlmmTransactions:
                            received,

                        closeCandidates,

                        storedClosedPositions:
                            seen.size,

                        queueSize:
                            queue.length,

                        lastSlot,

                        reconnects,
                    });
                }
            }
        );

        ws.on(
            "close",
            () => {
                reconnects++;

                console.log(
                    `⚠️ WebSocket closed. Reconnecting in 2s...`
                );

                setTimeout(
                    connect,
                    2000
                );
            }
        );

        ws.on(
            "error",
            (
                error
            ) => {
                console.error(
                    "WebSocket error:",
                    error
                );
            }
        );
    }

    connect();

    setInterval(
        async () => {
            console.log(
                `[STATUS] DLMM=${received}` +
                ` closeTx=${closeCandidates}` +
                ` stored=${seen.size}` +
                ` queue=${queue.length}` +
                ` slot=${lastSlot}`
            );

            await saveState({
                receivedDlmmTransactions:
                    received,

                closeCandidates,

                storedClosedPositions:
                    seen.size,

                queueSize:
                    queue.length,

                lastSlot,

                reconnects,
            });

        },
        30_000
    );
}

main().catch(
    (error) => {
        console.error(error);
        process.exit(1);
    }
);