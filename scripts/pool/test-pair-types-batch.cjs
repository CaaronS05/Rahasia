const dlmmModule = require("@meteora-ag/dlmm");
const DLMM = dlmmModule.default ?? dlmmModule;

const {
    Connection,
    PublicKey,
} = require("@solana/web3.js");

const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
);

const TYPES = {
    0: "Permissionless (Legacy DLMM)",
    1: "Permissioned",
    2: "CustomizablePermissionless",
    3: "PermissionlessV2",
};

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const url = new URL(
        "https://dlmm.datapi.meteora.ag/pools"
    );

    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "20");
    url.searchParams.set(
        "filter_by",
        "is_blacklisted=false && tvl>50"
    );
    url.searchParams.set(
        "sort_by",
        "volume_24h:desc"
    );

    console.log("[API] Fetching 20 pools...");

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Meteora API failed: ${response.status}`
        );
    }

    const json = await response.json();
    const pools = json.data;

    const summary = {
        0: 0,
        1: 0,
        2: 0,
        3: 0,
        error: 0,
    };

    for (let i = 0; i < pools.length; i++) {
        const item = pools[i];

        try {
            const pool = await DLMM.create(
                connection,
                new PublicKey(item.address)
            );

            const pairType =
                Number(pool.lbPair.pairType);

            summary[pairType] =
                (summary[pairType] ?? 0) + 1;

            console.log(
                `[${i + 1}/${pools.length}]`,
                item.name,
                "|",
                item.address,
                "| pairType =",
                pairType,
                "|",
                TYPES[pairType] ?? "UNKNOWN"
            );
        } catch (error) {
            summary.error++;

            console.log(
                `[${i + 1}/${pools.length}]`,
                item.name,
                "| ERROR:",
                error.message
            );
        }

        // sedikit delay supaya public RPC tidak terlalu agresif
        await sleep(200);
    }

    console.log("\n============================");
    console.log("SUMMARY");
    console.log("============================");

    console.log(
        "0 Legacy Permissionless:",
        summary[0]
    );

    console.log(
        "1 Permissioned:",
        summary[1]
    );

    console.log(
        "2 Customizable:",
        summary[2]
    );

    console.log(
        "3 Permissionless V2:",
        summary[3]
    );

    console.log(
        "Errors:",
        summary.error
    );
})();