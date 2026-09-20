import WebSocket from "ws";

const RPC_URL = process.env.SHYFT_RPC_URL;
const WS_URL = process.env.SHYFT_WS_URL;

const METEORA_DLMM_PROGRAM_ID =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

if (!RPC_URL) {
    throw new Error("SHYFT_RPC_URL belum ada di .env");
}

if (!WS_URL) {
    throw new Error("SHYFT_WS_URL belum ada di .env");
}

async function testRpc() {
    console.log("\n=== TEST 1: SHYFT FREE RPC ===");

    const response = await fetch(RPC_URL!, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSlot",
            params: [
                {
                    commitment: "confirmed",
                },
            ],
        }),
    });

    const data = await response.json();

    console.log(JSON.stringify(data, null, 2));

    if (data.result) {
        console.log(`✅ RPC WORKING — current slot: ${data.result}`);
    } else {
        console.log("❌ RPC FAILED");
    }
}

async function testWebSocket() {
    console.log("\n=== TEST 2: SHYFT FREE WEBSOCKET ===");
    console.log(`Subscribing to Meteora DLMM...`);

    const ws = new WebSocket(WS_URL!);

    let notificationCount = 0;
    const MAX_NOTIFICATIONS = 5;

    const timeout = setTimeout(() => {
        console.log("\n⏱ No/insufficient events after 30 seconds.");
        ws.close();
    }, 30_000);

    ws.on("open", () => {
        console.log("✅ WebSocket connected");

        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "programSubscribe",
                params: [
                    METEORA_DLMM_PROGRAM_ID,
                    {
                        commitment: "processed",
                        encoding: "base64",
                    },
                ],
            })
        );
    });

    ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());

        // Subscription confirmation
        if (message.id === 1 && message.result) {
            console.log(
                `✅ programSubscribe active — subscription ID: ${message.result}`
            );
            return;
        }

        if (message.method !== "programNotification") {
            return;
        }

        notificationCount++;

        const value = message.params?.result?.value;
        const context = message.params?.result?.context;

        const pubkey = value?.pubkey;
        const account = value?.account;

        let byteLength: number | null = null;

        if (
            account?.data &&
            Array.isArray(account.data) &&
            typeof account.data[0] === "string"
        ) {
            byteLength = Buffer.from(account.data[0], "base64").length;
        }

        console.log("\n----------------------------------------");
        console.log(`EVENT #${notificationCount}`);
        console.log(`slot       : ${context?.slot}`);
        console.log(`account    : ${pubkey}`);
        console.log(`data bytes : ${byteLength}`);
        console.log(`lamports   : ${account?.lamports}`);

        if (notificationCount >= MAX_NOTIFICATIONS) {
            console.log(
                `\n✅ Received ${MAX_NOTIFICATIONS} Meteora account updates.`
            );

            clearTimeout(timeout);
            ws.close();
        }
    });

    ws.on("error", (error) => {
        clearTimeout(timeout);
        console.error("\n❌ WebSocket error:");
        console.error(error);
    });

    ws.on("close", () => {
        clearTimeout(timeout);
        console.log("\nWebSocket closed.");
    });
}

async function main() {
    await testRpc();
    await testWebSocket();
}

main().catch(console.error);