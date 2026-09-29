import { main } from "./build-wallet-style-readiness.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("compute-wallet-style-readiness.ts") ||
        process.argv[1].endsWith("compute-wallet-style-readiness.js") ||
        process.argv[1].includes("compute-wallet-style-readiness"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to compute V1 wallet style readiness: ${err?.message || err}`);
        process.exit(1);
    });
}
