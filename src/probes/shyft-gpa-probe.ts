const RPC_URL = process.env.SHYFT_RPC_URL!;

const METEORA_DLMM_PROGRAM =
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

async function main() {
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
                    encoding: "base64",
                    filters: [
                        {
                            // Sengaja ukuran mustahil supaya response tidak besar.
                            dataSize: 999999999
                        }
                    ],
                    dataSlice: {
                        offset: 0,
                        length: 0
                    }
                }
            ]
        })
    });

    console.log("HTTP Status:", response.status);

    const text = await response.text();

    try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
        console.log(text);
    }
}

main().catch(console.error);