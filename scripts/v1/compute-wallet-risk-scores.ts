import { main } from "./build-wallet-risk-scores.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("compute-wallet-risk-scores.ts") ||
        process.argv[1].endsWith("compute-wallet-risk-scores.js") ||
        process.argv[1].includes("compute-wallet-risk-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to compute V1 risk scores: ${err?.message || err}`);
        process.exit(1);
    });
}
