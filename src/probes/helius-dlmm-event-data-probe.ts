import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const WS_URL =
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const IDL_URL =
    "https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json";

const TEST_DURATION_MS = 30_000;

type EventInfo = {
    name: string;
    discriminator: number[];
};

function classifyLpInstruction(
    name: string
): string | null {

    if (name.startsWith("InitializePosition")) {
        return "initialize";
    }

    if (name.startsWith("AddLiquidity")) {
        return "add";
    }

    if (name.startsWith("RemoveLiquidity")) {
        return "remove";
    }

    if (name.startsWith("ClaimFee")) {
        return "claim_fee";
    }

    if (name.startsWith("ClaimReward")) {
        return "claim_reward";
    }

    if (name.startsWith("ClosePosition")) {
        return "close";
    }

    if (name === "RebalanceLiquidity") {
        return "rebalance";
    }

    if (
        name.startsWith("IncreasePositionLength") ||
        name.startsWith("DecreasePositionLength")
    ) {
        return "resize";
    }

    return null;
}

// ============================================================
// LOAD OFFICIAL METEORA IDL EVENT DISCRIMINATORS
// ============================================================

async function loadEventMap() {
    const response = await fetch(IDL_URL);

    if (!response.ok) {
        throw new Error(
            `Failed loading IDL: HTTP ${response.status}`
        );
    }

    const idl: any =
        await response.json();

    const map =
        new Map<string, string>();

    const events: EventInfo[] =
        Array.isArray(idl.events)
            ? idl.events
            : [];

    for (const event of events) {
        if (
            !event.name ||
            !Array.isArray(event.discriminator)
        ) {
            continue;
        }

        const hex =
            Buffer.from(
                event.discriminator
            ).toString("hex");

        map.set(
            hex,
            event.name
        );
    }

    console.log(
        `Loaded ${map.size} event discriminators from Meteora IDL`
    );

    return map;
}

// ============================================================
// PARSE DIRECT DLMM LOGS
// ============================================================

function parseMeteoraLogs(
    logs: string[]
) {
    const stack: string[] = [];

    const instructions: string[] = [];
    const programData: string[] = [];

    for (const log of logs) {

        const invoke =
            log.match(
                /^Program ([A-Za-z0-9]+) invoke \[(\d+)\]$/
            );

        if (invoke) {
            const program =
                invoke[1];

            const depth =
                Number(invoke[2]);

            stack[depth - 1] =
                program;

            stack.length =
                depth;

            continue;
        }

        const finish =
            log.match(
                /^Program ([A-Za-z0-9]+) (success|failed:.*)$/
            );

        if (finish) {
            const program =
                finish[1];

            const index =
                stack.lastIndexOf(
                    program
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
            METEORA_DLMM_PROGRAM
        ) {
            continue;
        }

        const instruction =
            log.match(
                /^Program log: Instruction: (.+)$/
            );

        if (instruction) {
            instructions.push(
                instruction[1].trim()
            );

            continue;
        }

        if (
            log.startsWith(
                "Program data: "
            )
        ) {
            const payload =
                log.substring(
                    "Program data: ".length
                );

            // sol_log_data can technically contain
            // multiple base64 chunks.
            for (
                const part of
                payload.split(/\s+/)
            ) {
                if (part.length > 0) {
                    programData.push(part);
                }
            }
        }
    }

    return {
        instructions,
        programData,
    };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const eventMap =
        await loadEventMap();

    const ws =
        new WebSocket(
            WS_URL
        );

    let dlmmTx = 0;
    let strictLpTx = 0;

    let lpTxWithProgramData = 0;

    let totalProgramData = 0;
    let knownEvents = 0;
    let unknownPayloads = 0;

    const eventCounts =
        new Map<string, number>();

    ws.on(
        "open",
        () => {
            console.log(
                "✅ Helius WebSocket connected"
            );

            ws.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,

                    method:
                        "logsSubscribe",

                    params: [
                        {
                            mentions: [
                                METEORA_DLMM_PROGRAM,
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
        (raw) => {
            const msg =
                JSON.parse(
                    raw.toString()
                );

            if (
                msg.id === 1 &&
                msg.result
            ) {
                console.log(
                    `✅ Subscription active: ${msg.result}`
                );

                return;
            }

            if (
                msg.method !==
                "logsNotification"
            ) {
                return;
            }

            const value =
                msg.params
                    ?.result?.value;

            if (
                !value ||
                value.err !== null
            ) {
                return;
            }

            dlmmTx++;

            const {
                instructions,
                programData,
            } =
                parseMeteoraLogs(
                    value.logs ?? []
                );

            const lpInstructions =
                instructions
                    .map((instruction) => ({
                        instruction,

                        category:
                            classifyLpInstruction(
                                instruction
                            ),
                    }))
                    .filter(
                        (
                            item
                        ): item is {
                            instruction: string;
                            category: string;
                        } =>
                            item.category !==
                            null
                    );

            if (
                lpInstructions.length ===
                0
            ) {
                return;
            }

            strictLpTx++;

            if (
                programData.length >
                0
            ) {
                lpTxWithProgramData++;
            }

            const decodedEvents: {
                eventName: string;
                bytes: number;
            }[] = [];

            for (
                const payload of
                programData
            ) {
                totalProgramData++;

                try {
                    const buffer =
                        Buffer.from(
                            payload,
                            "base64"
                        );

                    if (
                        buffer.length < 8
                    ) {
                        unknownPayloads++;
                        continue;
                    }

                    const discriminator =
                        buffer
                            .subarray(
                                0,
                                8
                            )
                            .toString(
                                "hex"
                            );

                    const eventName =
                        eventMap.get(
                            discriminator
                        );

                    if (
                        eventName
                    ) {
                        knownEvents++;

                        eventCounts.set(
                            eventName,
                            (
                                eventCounts.get(
                                    eventName
                                ) ?? 0
                            ) + 1
                        );

                        decodedEvents.push({
                            eventName,
                            bytes:
                                buffer.length,
                        });
                    } else {
                        unknownPayloads++;
                    }

                } catch {
                    unknownPayloads++;
                }
            }

            // Print hanya jika kita benar-benar mendapatkan
            // Program data dari strict LP transaction.
            if (
                programData.length >
                0
            ) {
                console.log(
                    "\n===================================="
                );

                console.log(
                    `STRICT LP TX #${strictLpTx}`
                );

                console.log(
                    `Signature : ${value.signature}`
                );

                console.log(
                    `LP instructions:`
                );

                for (
                    const item of
                    lpInstructions
                ) {
                    console.log(
                        `  ${item.category.padEnd(12)} ${item.instruction}`
                    );
                }

                console.log(
                    `Program data payloads : ${programData.length}`
                );

                if (
                    decodedEvents.length >
                    0
                ) {
                    console.log(
                        `Known Meteora events:`
                    );

                    for (
                        const event of
                        decodedEvents
                    ) {
                        console.log(
                            `  ${event.eventName} (${event.bytes} bytes)`
                        );
                    }
                } else {
                    console.log(
                        "No payload matched IDL events."
                    );
                }
            }
        }
    );

    ws.on(
        "error",
        (error) => {
            console.error(
                "❌ WebSocket error:",
                error
            );
        }
    );

    setTimeout(
        () => {
            console.log(
                "\n===================================="
            );

            console.log(
                "EVENT DATA PROBE COMPLETE"
            );

            console.log(
                "===================================="
            );

            console.log(
                `DLMM tx observed          : ${dlmmTx}`
            );

            console.log(
                `Strict LP tx              : ${strictLpTx}`
            );

            console.log(
                `LP tx with Program data   : ${lpTxWithProgramData}`
            );

            console.log(
                `Program data payloads     : ${totalProgramData}`
            );

            console.log(
                `Known Meteora events      : ${knownEvents}`
            );

            console.log(
                `Unknown payloads          : ${unknownPayloads}`
            );

            console.log(
                "\nEvent types:"
            );

            console.table(
                [
                    ...eventCounts.entries(),
                ]
                    .map(
                        ([
                            event,
                            count,
                        ]) => ({
                            event,
                            count,
                        })
                    )
                    .sort(
                        (a, b) =>
                            b.count -
                            a.count
                    )
            );

            console.log(
                "===================================="
            );

            ws.close();

        },
        TEST_DURATION_MS
    );
}

main().catch(
    console.error
);