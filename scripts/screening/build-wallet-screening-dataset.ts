import { runHistoricalCohortScreening } from "../v1/build-historical-cohort-dataset.ts";

export { runHistoricalCohortScreening };

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-screening-dataset.ts") ||
        process.argv[1].endsWith("build-wallet-screening-dataset.js") ||
        process.argv[1].includes("build-wallet-screening-dataset"));

if (isMain) {
    runHistoricalCohortScreening().catch((err) => {
        console.error(`\n[FATAL ERROR] V1 screening failed: ${err?.message || err}`);
        process.exit(1);
    });
}
