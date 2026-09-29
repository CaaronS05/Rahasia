import { main } from "./build-wallet-style-classifications.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("compute-wallet-style-classifications.ts") ||
        process.argv[1].endsWith("compute-wallet-style-classifications.js") ||
        process.argv[1].includes("compute-wallet-style-classifications"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to compute V1 wallet style classifications: ${err?.message || err}`);
        process.exit(1);
    });
}
