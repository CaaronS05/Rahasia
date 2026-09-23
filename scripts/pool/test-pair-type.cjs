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

const pools = [
    {
        name: "SOL-USDC OLD",
        address:
            "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    },
    {
        name: "GROK-SOL NEW",
        address:
            "Fjp7aSBLknxyMG1zp8P7hexm8FzGK7DDTBgqMsYGptcX",
    },
];

(async () => {
    for (const item of pools) {
        try {
            const pool = await DLMM.create(
                connection,
                new PublicKey(item.address)
            );

            console.log("\n==============================");
            console.log(item.name);
            console.log("address:", item.address);

            console.log("pairType:");
            console.dir(
                pool.lbPair.pairType,
                { depth: null }
            );

            console.log(
                "binStep:",
                pool.lbPair.binStep
            );

            console.log(
                "tokenX:",
                pool.lbPair.tokenXMint.toBase58()
            );

            console.log(
                "tokenY:",
                pool.lbPair.tokenYMint.toBase58()
            );
        } catch (error) {
            console.error(
                `ERROR ${item.name}:`,
                error
            );
        }
    }
})();