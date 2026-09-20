import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const WS_URL =
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const TEST_DURATION_MS = 30_000;

// ============================================================
// CLASSIFY DIRECT METEORA INSTRUCTIONS
// ============================================================

function classifyLpInstruction(name: string): string | null {
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

    return null;
}

// ============================================================
// PARSE LOG PROGRAM STACK
// ============================================================

function getDirectMeteoraInstructions(logs: string[]) {
    const stack: string[] = [];

    const allDirectInstructions: string[] = [];
    const lpInstructions: {
        instruction: string;
        category: string;
    }[] = [];

    for (const log of logs) {
        // Example:
        // Program ABC... invoke [2]
        const invokeMatch =
            log.match(/^Program ([A-Za-z0-9]+) invoke \[(\d+)\]$/);

        if (invokeMatch) {
            const program = invokeMatch[1];
            const depth = Number(invokeMatch[2]);

            stack[depth - 1] = program;
            stack.length = depth;

            continue;
        }

        // Example:
        // Program ABC... success
        // Program ABC... failed: ...
        const finishMatch =
            log.match(/^Program ([A-Za-z0-9]+) (success|failed:.*)$/);

        if (finishMatch) {
            const program = finishMatch[1];

            const index =
                stack.lastIndexOf(program);

            if (index >= 0) {
                stack.length = index;
            }

            continue;
        }

        const instructionMatch =
            log.match(/^Program log: Instruction: (.+)$/);

        if (!instructionMatch) {
            continue;
        }

        const currentProgram =
            stack[stack.length - 1];

        // CRITICAL:
        // only instruction emitted while DLMM program is active
        if (currentProgram !== METEORA_DLMM_PROGRAM) {
            continue;
        }

        const instruction =
            instructionMatch[1].trim();

        allDirectInstructions.push(instruction);

        const category =
            classifyLpInstruction(instruction);

        if (category) {
            lpInstructions.push({
                instruction,
                category,
            });
        }
    }

    return {
        allDirectInstructions,
        lpInstructions,
    };
}

// ============================================================
// MAIN
// ============================================================

const ws =
    new WebSocket(WS_URL);

let dlmmTxCount = 0;
let strictLpTxCount = 0;

const instructionCounts =
    new Map<string, number>();

const categoryCounts =
    new Map<string, number>();

const signatures =
    new Set<string>();

ws.on("open", () => {
    console.log(
        "✅ Helius WebSocket connected"
    );

    ws.send(
        JSON.stringify({
            jsonrpc: "2.0",
            id: 1,

            method: "logsSubscribe",

            params: [
                {
                    mentions: [
                        METEORA_DLMM_PROGRAM,
                    ],
                },

                {
                    commitment: "confirmed",
                },
            ],
        })
    );
});

ws.on("message", (raw) => {
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

    if (!value) {
        return;
    }

    if (value.err !== null) {
        return;
    }

    dlmmTxCount++;

    const logs: string[] =
        value.logs ?? [];

    const {
        allDirectInstructions,
        lpInstructions,
    } =
        getDirectMeteoraInstructions(
            logs
        );

    // Inventory ALL instructions truly emitted
    // by Meteora DLMM.
    for (
        const instruction of
        allDirectInstructions
    ) {
        instructionCounts.set(
            instruction,
            (
                instructionCounts.get(
                    instruction
                ) ?? 0
            ) + 1
        );
    }

    if (
        lpInstructions.length ===
        0
    ) {
        return;
    }

    strictLpTxCount++;

    signatures.add(
        value.signature
    );

    console.log(
        "\n===================================="
    );

    console.log(
        `STRICT LP #${strictLpTxCount}`
    );

    console.log(
        `Signature : ${value.signature}`
    );

    for (
        const item of
        lpInstructions
    ) {
        console.log(
            `${item.category.padEnd(12)} : ${item.instruction}`
        );

        categoryCounts.set(
            item.category,
            (
                categoryCounts.get(
                    item.category
                ) ?? 0
            ) + 1
        );
    }
});

ws.on(
    "error",
    (error) => {
        console.error(
            "❌ WebSocket error:",
            error
        );
    }
);

setTimeout(() => {
    console.log(
        "\n===================================="
    );

    console.log(
        "STRICT PROBE COMPLETE"
    );

    console.log(
        "===================================="
    );

    console.log(
        `DLMM transactions : ${dlmmTxCount}`
    );

    console.log(
        `Strict LP tx      : ${strictLpTxCount}`
    );

    console.log(
        `Unique signatures : ${signatures.size}`
    );

    console.log(
        "\nLP categories:"
    );

    console.table(
        [...categoryCounts.entries()]
            .map(
                ([category, count]) => ({
                    category,
                    count,
                })
            )
            .sort(
                (a, b) =>
                    b.count - a.count
            )
    );

    console.log(
        "\nALL direct Meteora instructions:"
    );

    console.table(
        [...instructionCounts.entries()]
            .map(
                ([instruction, count]) => ({
                    instruction,
                    count,
                })
            )
            .sort(
                (a, b) =>
                    b.count - a.count
            )
    );

    console.log(
        "===================================="
    );

    ws.close();
}, TEST_DURATION_MS);