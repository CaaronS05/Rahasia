import { main } from "./build-wallet-confidence-scores.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("compute-wallet-confidence-scores.ts") ||
        process.argv[1].endsWith("compute-wallet-confidence-scores.js") ||
        process.argv[1].includes("compute-wallet-confidence-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to compute V1 confidence scores: ${err?.message || err}`);
        process.exit(1);
    });
}
