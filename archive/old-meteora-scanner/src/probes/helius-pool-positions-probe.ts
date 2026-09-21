import crypto from "node:crypto";
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

const POOL =
    "5fjmuEN72LQeo9NjvhLyQTV3ezyNgQqUXzSXskD2SCcy";

function anchorDiscriminator(accountName: string) {
    return crypto
        .createHash("sha256")
        .update(`account:${accountName}`)
        .digest()
        .subarray(0, 8);
}

async function main() {
    const discriminator =
        anchorDiscriminator("PositionV2");

    const discriminatorBase58 =
        bs58.encode(discriminator);

    console.log("=== HELIUS gPA METEORA TEST ===");
    console.log(`Pool        : ${POOL}`);
    console.log(`Program     : ${METEORA_DLMM_PROGRAM}`);
    console.log(`Discriminator: ${discriminatorBase58}`);
    console.log("");

    const response = await fetch(RPC_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getProgramAccounts",
            params: [
                METEORA_DLMM_PROGRAM,
                {
                    commitment: "confirmed",
                    encoding: "base64",

                    filters: [
                        // PositionV2 discriminator
                        {
                            memcmp: {
                                offset: 0,
                                bytes: discriminatorBase58,
                            },
                        },

                        // PositionV2.lb_pair
                        {
                            memcmp: {
                                offset: 8,
                                bytes: POOL,
                            },
                        },
                    ],

                    // Kita hanya perlu:
                    // discriminator + lbPair + owner
                    dataSlice: {
                        offset: 0,
                        length: 72,
                    },
                },
            ],
        }),
    });

    console.log(`HTTP Status : ${response.status}`);

    const result = await response.json();

    if (result.error) {
        console.error("\nRPC ERROR:");
        console.error(JSON.stringify(result.error, null, 2));
        return;
    }

    const accounts = result.result ?? [];

    console.log(`Positions   : ${accounts.length}\n`);

    const rows = accounts.map((item: any) => {
        const raw = Buffer.from(
            item.account.data[0],
            "base64"
        );

        const poolBytes = raw.subarray(8, 40);
        const ownerBytes = raw.subarray(40, 72);

        return {
            positionAddress: item.pubkey,
            poolAddress: new PublicKey(
                poolBytes
            ).toBase58(),
            ownerWallet: new PublicKey(
                ownerBytes
            ).toBase58(),
        };
    });

    console.table(rows);

    console.log("\nRAW JSON:");
    console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
    console.error("\nFAILED:");
    console.error(error);
});