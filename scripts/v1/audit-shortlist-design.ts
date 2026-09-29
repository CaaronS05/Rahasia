import { main } from "./audit-wallet-shortlist-design.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-shortlist-design.ts") ||
        process.argv[1].endsWith("audit-shortlist-design.js") ||
        process.argv[1].includes("audit-shortlist-design"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Shortlist design audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
