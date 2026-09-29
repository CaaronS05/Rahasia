import { main } from "./audit-risk-signal-design.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-risk-signal-design.ts") ||
        process.argv[1].endsWith("audit-wallet-risk-signal-design.js") ||
        process.argv[1].includes("audit-wallet-risk-signal-design"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Risk signal design audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
