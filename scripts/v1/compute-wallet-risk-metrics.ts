import { main } from "./build-wallet-risk-metrics.ts";

export { main };

if (import.meta.url === `file://${process.argv[1]}` ||
    (Boolean(process.argv[1]) && process.argv[1].includes("compute-wallet-risk-metrics"))) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to compute V1 risk metrics: ${err?.message || err}`);
        process.exit(1);
    });
}
