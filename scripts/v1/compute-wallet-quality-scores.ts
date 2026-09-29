import { main } from "./build-wallet-quality-scores.ts";

export { main };

if (import.meta.url === `file://${process.argv[1]}` ||
    (Boolean(process.argv[1]) && process.argv[1].includes("compute-wallet-quality-scores"))) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to compute V1 quality scores: ${err?.message || err}`);
        process.exit(1);
    });
}
