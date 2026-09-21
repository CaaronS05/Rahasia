import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY belum ada di .env");
}

const WS_URL =
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const METEORA_DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const ws = new WebSocket(WS_URL);

let txCount = 0;
let interestingCount = 0;

const KEYWORDS = [
    "position",
    "liquidity",
    "claim",
    "close",
    "remove",
    "add",
];

ws.on("open", () => {
    console.log("✅ Helius WebSocket connected");

    ws.send(
        JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                {
                    mentions: [
                        METEORA_DLMM_PROGRAM
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
    const msg = JSON.parse(raw.toString());

    if (msg.id === 1) {
        console.log(
            `✅ Subscription active: ${msg.result}`
        );
        return;
    }

    if (msg.method !== "logsNotification") {
        return;
    }

    const value =
        msg.params?.result?.value;

    if (!value) return;

    txCount++;

    const logs: string[] =
        value.logs ?? [];

    const instructionLogs =
        logs.filter((log) =>
            log.includes("Instruction:")
        );

    const interesting =
        instructionLogs.filter((log) => {
            const lower = log.toLowerCase();

            return KEYWORDS.some((keyword) =>
                lower.includes(keyword)
            );
        });

    if (interesting.length === 0) {
        return;
    }

    interestingCount++;

    console.log("\n====================================");
    console.log(`LP CANDIDATE #${interestingCount}`);
    console.log(`Signature : ${value.signature}`);
    console.log(`Error     : ${JSON.stringify(value.err)}`);

    for (const log of interesting) {
        console.log(log);
    }
});

ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err);
});

setTimeout(() => {
    console.log("\n====================================");
    console.log("PROBE COMPLETE");
    console.log(`DLMM tx observed : ${txCount}`);
    console.log(`LP candidates    : ${interestingCount}`);
    console.log("====================================");

    ws.close();
}, 30_000);