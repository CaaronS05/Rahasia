import { main } from "./audit-wallet-shortlist.ts";

export { main };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-shortlist.ts") ||
        process.argv[1].endsWith("audit-shortlist.js") ||
        process.argv[1].includes("audit-shortlist"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Shortlist audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
