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

(async () => {
    const url = new URL(
        "https://dlmm.datapi.meteora.ag/pools"
    );

    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "500");
    url.searchParams.set(
        "filter_by",
        "is_blacklisted=false && tvl>50"
    );
    url.searchParams.set(
        "sort_by",
        "volume_24h:desc"
    );

    console.log("[API] Fetching pools...");

    const response = await fetch(url);
    const json = await response.json();

    const sourcePools = json.data;

    const pubkeys = sourcePools.map(
        (pool) => new PublicKey(pool.address)
    );

    console.log(
        `[RPC] Loading ${pubkeys.length} pools with createMultiple()...`
    );

    const CHUNK_SIZE = 50;
    const DELAY_MS = 2500;

    const dlmmPools = [];

    for (
        let start = 0;
        start < pubkeys.length;
        start += CHUNK_SIZE
    ) {
        const end = Math.min(
            start + CHUNK_SIZE,
            pubkeys.length
        );

        const chunk =
            pubkeys.slice(start, end);

        console.log(
            `[RPC] Batch ${start + 1}-${end}/${pubkeys.length}`
        );

        const result =
            await DLMM.createMultiple(
                connection,
                chunk
            );

        dlmmPools.push(...result);

        if (end < pubkeys.length) {
            await new Promise(
                (resolve) =>
                    setTimeout(resolve, DELAY_MS)
            );
        }
    }

    console.log("\n============================");
    console.log("RESULT");
    console.log("============================");

    let legacy = 0;
    let excluded = 0;

    for (let i = 0; i < dlmmPools.length; i++) {
        const pool = dlmmPools[i];
        const source = sourcePools[i];

        const pairType =
            Number(pool.lbPair.pairType);

        const include =
            pairType === 0;

        if (include) {
            legacy++;
        } else {
            excluded++;
        }

        console.log(
            source.name,
            "| pairType =",
            pairType,
            "|",
            include ? "INCLUDE" : "EXCLUDE"
        );
    }

    console.log("\nLegacy included:", legacy);
    console.log("Excluded:", excluded);
})();