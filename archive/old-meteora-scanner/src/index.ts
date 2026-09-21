import { loadConfig } from "./config.ts";
import { writeOutputs } from "./output.ts";
import { scanWallets } from "./scanner.ts";

function fmt(epoch: number) {
  return new Date(epoch * 1000).toISOString();
}

async function main() {
  const config = loadConfig();

  console.log("\nMETEORA DLMM — 7 DAY WALLET SCANNER");
  console.log("====================================");
  console.log(`Program : ${config.programId}`);
  console.log(`Days    : ${config.scanDays}`);
  console.log(`Mode    : ${config.mode}`);
  console.log(
    `Limit   : ${config.maxTransactions === 0 ? "unlimited" : config.maxTransactions + " tx"}`,
  );
  console.log("");

  const summary = await scanWallets(config);
  const { csvPath, jsonPath, rows } = await writeOutputs(summary);

  console.log("\nDONE");
  console.log("====");
  console.log(`Source               : ${summary.source}`);
  console.log(`Period               : ${fmt(summary.startTime)} -> ${fmt(summary.endTime)}`);
  console.log(`Transactions scanned : ${summary.transactionsScanned}`);
  console.log(`Unique signer wallets: ${summary.uniqueWallets}`);
  console.log(`CSV                  : ${csvPath}`);
  console.log(`JSON                 : ${jsonPath}`);

  if (rows.length) {
    console.log("\nTop wallets by transaction count:");
    for (const w of rows.slice(0, 10)) {
      console.log(
        `${String(w.txCount).padStart(7)} tx | fee payer ${String(w.feePayerCount).padStart(7)} | ${w.address}`,
      );
    }
  }
}

main().catch((error) => {
  console.error("\nSCAN FAILED");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
