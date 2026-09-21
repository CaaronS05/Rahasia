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

function anchorDiscriminator(accountName: string) {
    return crypto
        .createHash("sha256")
        .update(`account:${accountName}`)
        .digest()
        .subarray(0, 8);
}

async function main() {
    const discriminator = anchorDiscriminator("PositionV2");
    const discriminatorBase58 = bs58.encode(discriminator);

    console.log("=== HELIUS gPAv2 — FIRST PAGE ===");
    console.log(`Program       : ${METEORA_DLMM_PROGRAM}`);
    console.log(`Discriminator : ${discriminatorBase58}`);
    console.log(`Limit         : 1000`);
    console.log("");

    const started = Date.now();

    const response = await fetch(RPC_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "meteora-position-v2",
            method: "getProgramAccountsV2",

            params: [
                METEORA_DLMM_PROGRAM,
                {
                    commitment: "confirmed",
                    encoding: "base64",

                    // Penting: ambil slot snapshot juga
                    withContext: true,

                    // Untuk tes pertama jangan terlalu besar
                    limit: 1000,

                    filters: [
                        {
                            memcmp: {
                                offset: 0,
                                bytes: discriminatorBase58,
                            },
                        },
                    ],

                    // Hanya:
                    // 8 discriminator
                    // 32 lbPair
                    // 32 owner
                    dataSlice: {
                        offset: 0,
                        length: 72,
                    },
                },
            ],
        }),
    });

    console.log(`HTTP Status : ${response.status}`);

    const json: any = await response.json();

    if (json.error) {
        console.error("\nRPC ERROR:");
        console.error(JSON.stringify(json.error, null, 2));
        return;
    }

    /*
      withContext=true:
  
      result: {
        context: { slot, apiVersion },
        value: {
          accounts: [],
          paginationKey
        }
      }
    */

    const slot = json.result?.context?.slot;

    const accounts =
        json.result?.value?.accounts ?? [];

    const paginationKey =
        json.result?.value?.paginationKey ?? null;

    const rows = accounts.map((item: any) => {
        const raw = Buffer.from(
            item.account.data[0],
            "base64"
        );

        return {
            positionAddress: item.pubkey,

            poolAddress: new PublicKey(
                raw.subarray(8, 40)
            ).toBase58(),

            ownerWallet: new PublicKey(
                raw.subarray(40, 72)
            ).toBase58(),
        };
    });

    const uniquePools = new Set(
        rows.map((x: any) => x.poolAddress)
    );

    const uniqueWallets = new Set(
        rows.map((x: any) => x.ownerWallet)
    );

    console.log("\n====================================");
    console.log("FIRST PAGE RESULT");
    console.log("====================================");

    console.log(`Snapshot slot      : ${slot}`);
    console.log(`Positions returned : ${rows.length}`);
    console.log(`Unique pools       : ${uniquePools.size}`);
    console.log(`Unique wallets     : ${uniqueWallets.size}`);
    console.log(
        `Has next page      : ${paginationKey ? "YES" : "NO"}`
    );

    console.log(
        `Pagination key     : ${paginationKey
            ? paginationKey.slice(0, 20) + "..."
            : "null"
        }`
    );

    console.log(
        `Elapsed            : ${(
            (Date.now() - started) /
            1000
        ).toFixed(2)}s`
    );

    console.log("====================================");

    console.log("\nSample first 10:");
    console.table(rows.slice(0, 10));
}

main().catch(console.error);