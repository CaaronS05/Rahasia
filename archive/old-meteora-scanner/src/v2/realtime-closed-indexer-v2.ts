import fs from "node:fs/promises";
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

const METEORA_API =
    "https://dlmm.datapi.meteora.ag";

const OUTPUT_DIR = "output";

const EVENTS_FILE =
    path.join(
        OUTPUT_DIR,
        "realtime-closed-positions-v2.jsonl"
    );

const STATE_FILE =
    path.join(
        OUTPUT_DIR,
        "realtime-closed-indexer-v2-state.json"
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

type CloseVerification = {
    verified: boolean;
    actuallyClosed: boolean;

    reason:
    | "LAMPORTS_DRAINED_TO_ZERO"
    | "ACCOUNT_STILL_FUNDED"
    | "POSITION_NOT_IN_ACCOUNT_KEYS"
    | "BALANCE_DATA_MISSING";

    preLamports: number | null;
    postLamports: number | null;
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

    closeVerified: true;

    verificationMethod:
    "position_lamports_zero";

    preLamports: number;
    postLamports: 0;
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
// STRICT DLMM LOG PARSER
// ============================================================

function getDirectDlmmInstructions(
    logs: string[]
) {
    const stack: string[] = [];
    const instructions: string[] = [];

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

            if (index >= 0) {
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

function sleep(ms: number) {
    return new Promise(
        (resolve) =>
            setTimeout(
                resolve,
                ms
            )
    );
}

async function getTransaction(
    signature: string
) {
    for (
        let attempt = 1;
        attempt <= 6;
        attempt++
    ) {
        try {
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

            if (!response.ok) {
                console.log(
                    `[RPC RETRY] HTTP ${response.status} attempt=${attempt} ${signature}`
                );

                await sleep(
                    attempt * 750
                );

                continue;
            }

            const json: any =
                await response.json();

            if (json.error) {
                console.log(
                    `[RPC RETRY] ${JSON.stringify(
                        json.error
                    )} attempt=${attempt} ${signature}`
                );

                await sleep(
                    attempt * 750
                );

                continue;
            }

            if (json.result) {
                return json.result;
            }

            // WebSocket bisa datang lebih cepat daripada RPC
            await sleep(
                attempt * 500
            );

        } catch (error) {
            console.log(
                `[RPC RETRY] network error attempt=${attempt} ${signature}`,
                error
            );

            await sleep(
                attempt * 750
            );
        }
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
            .subarray(
                0,
                8
            )
            .toString(
                "hex"
            );

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
// ACTUAL CLOSE VERIFICATION
// ============================================================

function getAccountKeys(
    tx: any
): string[] {

    return (
        tx?.transaction
            ?.message
            ?.accountKeys ??
        []
    )
        .map(
            (
                account: any
            ) => {

                if (
                    typeof account ===
                    "string"
                ) {
                    return account;
                }

                if (
                    typeof account?.pubkey ===
                    "string"
                ) {
                    return account.pubkey;
                }

                return null;
            }
        )
        .filter(
            (
                value: string | null
            ): value is string =>
                Boolean(value)
        );
}

function verifyPositionClosed(
    tx: any,
    position: string
): CloseVerification {

    const keys =
        getAccountKeys(
            tx
        );

    const index =
        keys.indexOf(
            position
        );

    if (
        index === -1
    ) {
        return {
            verified:
                false,

            actuallyClosed:
                false,

            reason:
                "POSITION_NOT_IN_ACCOUNT_KEYS",

            preLamports:
                null,

            postLamports:
                null,
        };
    }

    const pre =
        tx?.meta
            ?.preBalances?.[
        index
        ];

    const post =
        tx?.meta
            ?.postBalances?.[
        index
        ];

    if (
        typeof pre !==
        "number" ||
        typeof post !==
        "number"
    ) {

        return {
            verified:
                false,

            actuallyClosed:
                false,

            reason:
                "BALANCE_DATA_MISSING",

            preLamports:
                typeof pre ===
                    "number"
                    ? pre
                    : null,

            postLamports:
                typeof post ===
                    "number"
                    ? post
                    : null,
        };
    }

    const actuallyClosed =
        pre > 0 &&
        post === 0;

    return {
        verified:
            true,

        actuallyClosed,

        reason:
            actuallyClosed
                ? "LAMPORTS_DRAINED_TO_ZERO"
                : "ACCOUNT_STILL_FUNDED",

        preLamports:
            pre,

        postLamports:
            post,
    };
}

// ============================================================
// METEORA FALLBACK FOR POOL
// ============================================================

async function getPoolFromHistorical(
    position: string
) {

    try {
        const response =
            await fetch(
                `${METEORA_API}/positions/${position}/historical`
            );

        if (!response.ok) {
            return null;
        }

        const json: any =
            await response.json();

        const events =
            Array.isArray(
                json
            )
                ? json
                : json.events ??
                json.data ??
                [];

        for (
            const event of
            events
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
        // fallback gagal tidak boleh mematikan indexer
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
            text.split(
                "\n"
            )
        ) {

            if (
                !line.trim()
            ) {
                continue;
            }

            try {
                const event =
                    JSON.parse(
                        line
                    );

                seen.add(
                    `${event.signature}:${event.positionAddress}`
                );

            } catch {
                // abaikan broken line
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
        seen.has(
            key
        )
    ) {
        return false;
    }

    seen.add(
        key
    );

    await fs.appendFile(
        EVENTS_FILE,

        JSON.stringify(
            event
        ) +
        "\n"
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
// COUNTERS
// ============================================================

let receivedDlmmTransactions = 0;

let closeCandidates = 0;

let actualClosed = 0;

let noOpClose = 0;

let unverifiedClose = 0;

let transactionMiss = 0;

let poolFromSibling = 0;

let poolFromMeteora = 0;

let poolUnknown = 0;

let lastSlot:
    number | null =
    null;

let reconnects = 0;

// ============================================================
// PROCESS CLOSED TX
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
        transactionMiss++;

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

            unverifiedClose++;

            console.log(
                `[UNVERIFIED] missing position/actor ${signature}`
            );

            continue;
        }

        // ========================================================
        // IMPORTANT V2 FIX
        //
        // ClosePositionIfEmpty bisa no-op.
        // Kita hanya menyimpan event jika lamports position:
        //
        // sebelum > 0
        // sesudah = 0
        // ========================================================

        const closure =
            verifyPositionClosed(
                tx,
                close.position
            );

        if (
            !closure.verified
        ) {

            unverifiedClose++;

            console.log(
                `[UNVERIFIED] ${close.position} ${closure.reason}`
            );

            continue;
        }

        if (
            !closure.actuallyClosed
        ) {

            noOpClose++;

            console.log(
                `[NO-OP CLOSE] ${close.position}` +
                ` pre=${closure.preLamports}` +
                ` post=${closure.postLamports}`
            );

            continue;
        }

        // ========================================================
        // RESOLVE POOL
        // ========================================================

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
                        Boolean(
                            row.pool
                        )
                );

            pool =
                sibling?.pool ??
                null;
        }

        if (
            pool
        ) {
            poolFromSibling++;
        }

        if (!pool) {

            pool =
                await getPoolFromHistorical(
                    close.position
                );

            if (
                pool
            ) {

                poolSource =
                    "meteora_historical";

                poolFromMeteora++;

            } else {

                poolSource =
                    "unknown";

                poolUnknown++;
            }
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

            closeVerified:
                true,

            verificationMethod:
                "position_lamports_zero",

            preLamports:
                closure.preLamports!,

            postLamports:
                0,
        };

        const inserted =
            await saveEvent(
                event
            );

        if (
            !inserted
        ) {
            continue;
        }

        actualClosed++;

        console.log(
            "\n[CLOSED VERIFIED]"
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
            `Lamports : ${event.preLamports} -> 0`
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
// QUEUE
// ============================================================

const queue:
    string[] = [];

const queued =
    new Set<string>();

let processing =
    false;

async function drainQueue(
    idlMap:
        Map<
            string,
            IdlInstruction
        >
) {

    if (
        processing
    ) {
        return;
    }

    processing =
        true;

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

    processing =
        false;
}

// ============================================================
// STATUS
// ============================================================

async function writeStatus() {

    const state = {

        receivedDlmmTransactions,

        closeCandidates,

        actualClosed,

        noOpClose,

        unverifiedClose,

        transactionMiss,

        storedClosedPositions:
            seen.size,

        queueSize:
            queue.length,

        lastSlot,

        reconnects,

        poolResolution: {

            transactionSibling:
                poolFromSibling,

            meteoraHistorical:
                poolFromMeteora,

            unknown:
                poolUnknown,
        },
    };

    console.log(
        "[STATUS]" +
        ` DLMM=${receivedDlmmTransactions}` +
        ` closeCandidates=${closeCandidates}` +
        ` actualClosed=${actualClosed}` +
        ` noOp=${noOpClose}` +
        ` unverified=${unverifiedClose}` +
        ` txMiss=${transactionMiss}` +
        ` stored=${seen.size}` +
        ` queue=${queue.length}` +
        ` slot=${lastSlot}`
    );

    await saveState(
        state
    );
}

// ============================================================
// MAIN
// ============================================================

async function main() {

    await fs.mkdir(
        OUTPUT_DIR,
        {
            recursive:
                true,
        }
    );

    await loadExisting();

    const idlMap =
        await loadIdl();

    console.log(
        "========================================"
    );

    console.log(
        "METEORA REALTIME CLOSED POSITION INDEXER V2"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Existing verified records : ${seen.size}`
    );

    console.log(
        `Output                    : ${EVENTS_FILE}`
    );

    console.log(
        `State                     : ${STATE_FILE}`
    );

    let ws:
        WebSocket | null =
        null;

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

                ws!.send(
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
            (
                raw
            ) => {

                let msg: any;

                try {

                    msg =
                        JSON.parse(
                            raw.toString()
                        );

                } catch {
                    return;
                }

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
                    result
                        ?.value;

                if (
                    !value ||
                    value.err !==
                    null
                ) {
                    return;
                }

                receivedDlmmTransactions++;

                lastSlot =
                    result
                        ?.context
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
            }
        );

        ws.on(
            "close",
            () => {

                reconnects++;

                console.log(
                    "⚠️ WebSocket closed. Reconnecting in 2s..."
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
        () => {

            void writeStatus();

        },
        30_000
    );

    const shutdown =
        async (
            signal: string
        ) => {

            console.log(
                `\n${signal} received. Saving final state...`
            );

            await writeStatus();

            try {

                ws?.close();

            } catch {
                // ignore
            }

            process.exit(
                0
            );
        };

    process.on(
        "SIGINT",
        () => {

            void shutdown(
                "SIGINT"
            );
        }
    );

    process.on(
        "SIGTERM",
        () => {

            void shutdown(
                "SIGTERM"
            );
        }
    );
}

main().catch(
    (error) => {

        console.error(
            error
        );

        process.exit(
            1
        );
    }
);