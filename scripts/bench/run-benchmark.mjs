#!/usr/bin/env node
/**
 * CLI Entrypoint for LP Agent Dual-Browser Performance Benchmark.
 */
import {
  runModeA,
  runModeB,
  runModeC,
  runModeD,
  checkCloakBrowserReadiness,
  saveBenchmarkResults,
} from "./runner.mjs";

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = "BD";
  let repeats = 5;
  let pageBudget = 4;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode") {
      mode = args[i + 1]?.toUpperCase() ?? "ALL";
      i++;
    } else if (arg === "--repeats") {
      repeats = parseInt(args[i + 1], 10) || 2;
      i++;
    } else if (arg === "--page-budget") {
      pageBudget = parseInt(args[i + 1], 10) || 4;
      i++;
    }
  }

  return { mode, repeats, pageBudget };
}

function calculateMedian(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  }
  return Number(sorted[mid].toFixed(2));
}

function aggregateRuns(runs) {
  if (!runs || !runs.length) return null;
  const validRuns = runs.filter((r) => r && !r.status);
  if (!validRuns.length) return null;
  return {
    mode: validRuns[0].mode,
    runsCount: validRuns.length,
    durationSec: calculateMedian(validRuns.map((r) => r.extractionDurationSec)),
    totalDurationSec: calculateMedian(validRuns.map((r) => r.totalWallClockSec)),
    startupSec: calculateMedian(validRuns.map((r) => r.startupDurationSec || 0)),
    authReadinessSec: calculateMedian(validRuns.map((r) => r.authReadinessSec || 0)),
    pagesPerMin: calculateMedian(validRuns.map((r) => r.pagesPerMinute)),
    rowsPerMin: calculateMedian(validRuns.map((r) => r.rowsPerMinute)),
    avgLatencyMs: calculateMedian(validRuns.map((r) => r.avgLatencyMs)),
    p95LatencyMs: calculateMedian(validRuns.map((r) => r.p95LatencyMs)),
    http429: validRuns.reduce((sum, r) => sum + (r.http429Count || 0), 0),
    http403: validRuns.reduce((sum, r) => sum + (r.http403Count || 0), 0),
    http401: validRuns.reduce((sum, r) => sum + (r.http401Count || 0), 0),
    retries: validRuns.reduce((sum, r) => sum + (r.retriesCount || 0), 0),
    failedPages: validRuns.reduce((sum, r) => sum + (r.failedPages || 0), 0),
    disconnections: validRuns.reduce((sum, r) => sum + (r.disconnectionsCount || 0), 0),
    peakProcessMemoryMb: calculateMedian(validRuns.map((r) => r.peakBrowserProcessMemoryMb || 0)),
    peakHeapMb: calculateMedian(validRuns.map((r) => r.peakBrowserHeapMb || r.peakMemoryMb || 0)),
    peakMemoryMb: calculateMedian(validRuns.map((r) => r.peakBrowserProcessMemoryMb || r.peakMemoryMb || 0)),
    nodeRssMb: calculateMedian(validRuns.map((r) => r.nodeRssMb || 0)),
    cpuTotalMs: calculateMedian(validRuns.map((r) => r.cpuTotalMs || 0)),
    totalRows: calculateMedian(validRuns.map((r) => r.totalRowsExtracted)),
    uniqueWallets: calculateMedian(validRuns.map((r) => r.deduplicatedWalletCount)),
    extractedWallets: Array.from(new Set(validRuns.flatMap((r) => r.extractedWallets || []))),
    runs: validRuns,
  };
}

export function formatComparisonTable(medB, medD) {
  const formatVal = (val, suffix = "") =>
    val !== null && val !== undefined ? `${val}${suffix}` : "N/A";

  const rows = [
    [
      "Median extraction duration",
      formatVal(medB?.durationSec, "s"),
      formatVal(medD?.durationSec, "s"),
    ],
    [
      "Median total duration",
      formatVal(medB?.totalDurationSec, "s"),
      formatVal(medD?.totalDurationSec, "s"),
    ],
    [
      "Pages/minute",
      formatVal(medB?.pagesPerMin),
      formatVal(medD?.pagesPerMin),
    ],
    [
      "Rows/minute",
      formatVal(medB?.rowsPerMin),
      formatVal(medD?.rowsPerMin),
    ],
    [
      "Average latency",
      formatVal(medB?.avgLatencyMs, "ms"),
      formatVal(medD?.avgLatencyMs, "ms"),
    ],
    [
      "P95 latency",
      formatVal(medB?.p95LatencyMs, "ms"),
      formatVal(medD?.p95LatencyMs, "ms"),
    ],
    [
      "HTTP 429/403/401",
      `${medB ? medB.http429 : 0}/${medB ? medB.http403 : 0}/${medB ? medB.http401 : 0}`,
      `${medD ? medD.http429 : 0}/${medD ? medD.http403 : 0}/${medD ? medD.http401 : 0}`,
    ],
    [
      "Failed pages",
      formatVal(medB?.failedPages),
      formatVal(medD?.failedPages),
    ],
    [
      "Unique wallets",
      formatVal(medB?.uniqueWallets),
      formatVal(medD?.uniqueWallets),
    ],
    [
      "Peak browser memory",
      formatVal(medB?.peakProcessMemoryMb, " MB"),
      formatVal(medD?.peakProcessMemoryMb, " MB"),
    ],
    [
      "Peak browser JS heap",
      formatVal(medB?.peakHeapMb, " MB"),
      formatVal(medD?.peakHeapMb, " MB"),
    ],
    [
      "Authentication reliability",
      medB && medB.http403 === 0 && medB.http401 === 0 ? "100% (No challenge)" : "Degraded",
      medD && medD.http403 === 0 && medD.http401 === 0 ? "100% (No challenge)" : "Degraded",
    ],
    [
      "Node Process RSS",
      formatVal(medB?.nodeRssMb, " MB"),
      formatVal(medD?.nodeRssMb, " MB"),
    ],
    [
      "CPU Time (Extraction)",
      formatVal(medB?.cpuTotalMs, "ms"),
      formatVal(medD?.cpuTotalMs, "ms"),
    ],
    [
      "Retries",
      formatVal(medB?.retries),
      formatVal(medD?.retries),
    ],
  ];

  let md = "| Metric | Brave 2 Tabs | CloakBrowser 2 Tabs |\n";
  md += "|---|---|---|\n";
  for (const r of rows) {
    md += `| ${r[0]} | ${r[1]} | ${r[2]} |\n`;
  }
  return md;
}

async function main() {
  const { mode, repeats, pageBudget } = parseArgs();

  console.log("=================================================");
  console.log("DLLM — LP Agent Dual-Browser Performance Benchmark");
  console.log("=================================================");
  console.log(`Target Mode: ${mode}`);
  console.log(`Repeats: ${repeats}`);
  console.log(`Page Budget per Pool: ${pageBudget} pages (Total: ${pageBudget * 2} pages/run)`);

  const cloakReadiness = await checkCloakBrowserReadiness();
  console.log("\n[Preflight] CloakBrowser readiness check:");
  console.log(`  Installed: ${cloakReadiness.isInstalled}`);
  console.log(`  Session: ${cloakReadiness.hasSession}`);
  console.log(`  Ready: ${cloakReadiness.ready}`);
  for (const r of cloakReadiness.reasons) {
    console.log(`  - ${r}`);
  }

  const rawResults = {
    startedAt: new Date().toISOString(),
    config: { mode, repeats, pageBudget },
    cloakReadiness,
    runs: [],
  };

  const runsB = [];
  const runsD = [];
  const runsA = [];
  const runsC = [];

  // Interleave runs: B1 -> D1, D2 -> B2, B3 -> D3, D4 -> B4, B5 -> D5
  for (let r = 1; r <= repeats; r++) {
    console.log(`\n=================================================`);
    console.log(`TRIAL ROUND ${r} OF ${repeats}`);
    console.log(`=================================================`);

    if (mode === "BD" || mode === "ALL") {
      // Alternate order across rounds
      if (r % 2 === 1) {
        console.log(`\n>>> EXECUTING MODE B (Trial B${r}/${repeats}) <<<`);
        const bRes = await runModeB({ pageBudget, runIndex: r });
        runsB.push(bRes);
        rawResults.runs.push(bRes);

        console.log(`\n>>> EXECUTING MODE D (Trial D${r}/${repeats}) <<<`);
        const dRes = await runModeD({ pageBudget, runIndex: r });
        runsD.push(dRes);
        rawResults.runs.push(dRes);
      } else {
        console.log(`\n>>> EXECUTING MODE D (Trial D${r}/${repeats}) <<<`);
        const dRes = await runModeD({ pageBudget, runIndex: r });
        runsD.push(dRes);
        rawResults.runs.push(dRes);

        console.log(`\n>>> EXECUTING MODE B (Trial B${r}/${repeats}) <<<`);
        const bRes = await runModeB({ pageBudget, runIndex: r });
        runsB.push(bRes);
        rawResults.runs.push(bRes);
      }
    } else {
      if (mode === "B") {
        console.log(`\n>>> EXECUTING MODE B (Trial ${r}/${repeats}) <<<`);
        const bRes = await runModeB({ pageBudget, runIndex: r });
        runsB.push(bRes);
        rawResults.runs.push(bRes);
      }
      if (mode === "D") {
        console.log(`\n>>> EXECUTING MODE D (Trial ${r}/${repeats}) <<<`);
        const dRes = await runModeD({ pageBudget, runIndex: r });
        runsD.push(dRes);
        rawResults.runs.push(dRes);
      }
    }
  }

  const medB = aggregateRuns(runsB);
  const medD = aggregateRuns(runsD);

  rawResults.medians = { medB, medD };
  const savedPath = await saveBenchmarkResults(rawResults);
  console.log(`\n[Results] Saved raw benchmark results to: ${savedPath}`);

  console.log("\n=================================================");
  console.log("BENCHMARK COMPARISON TABLE");
  console.log("=================================================\n");
  const table = formatComparisonTable(medB, medD);
  console.log(table);

  // Speedup calculations
  console.log("\n=================================================");
  console.log("SPEEDUP & OVERHEAD ANALYSIS");
  console.log("=================================================");
  if (medB && medD && medB.durationSec > 0 && medD.durationSec > 0) {
    const cloakExtractionSpeedup = (medB.durationSec / medD.durationSec).toFixed(2);
    const cloakTotalSpeedup = (medB.totalDurationSec / medD.totalDurationSec).toFixed(2);
    const pagesSpeedup = (medD.pagesPerMin / medB.pagesPerMin).toFixed(2);
    const rowsSpeedup = (medD.rowsPerMin / medB.rowsPerMin).toFixed(2);
    const pctDiffExtraction = (((medD.durationSec - medB.durationSec) / medB.durationSec) * 100).toFixed(1);
    const pctDiffTotal = (((medD.totalDurationSec - medB.totalDurationSec) / medB.totalDurationSec) * 100).toFixed(1);
    const memDiffMb = (medD.peakProcessMemoryMb - medB.peakProcessMemoryMb).toFixed(1);

    console.log(`CloakBrowser 2 Tabs vs Brave 2 Tabs:`);
    console.log(`  Extraction Speedup:        ${cloakExtractionSpeedup}x`);
    console.log(`  Total Wallclock Speedup:   ${cloakTotalSpeedup}x`);
    console.log(`  Pages/min Ratio:           ${pagesSpeedup}x`);
    console.log(`  Rows/min Ratio:            ${rowsSpeedup}x`);
    console.log(`  Extraction Time Difference: ${pctDiffExtraction}% (negative = faster)`);
    console.log(`  Total Time Difference:      ${pctDiffTotal}% (including setup)`);
    console.log(`  Peak Browser Memory Delta:  ${memDiffMb} MB`);
  }

  // Data parity verification
  console.log("\n=================================================");
  console.log("WALLET DATA PARITY VERIFICATION");
  console.log("=================================================");
  if (medB && medD) {
    const setB = new Set(medB.extractedWallets || []);
    const setD = new Set(medD.extractedWallets || []);

    const intersectionBD = [...setB].filter((w) => setD.has(w)).length;
    const unionBD = new Set([...setB, ...setD]).size;
    const jaccardBD = unionBD > 0 ? ((intersectionBD / unionBD) * 100).toFixed(1) : "100.0";

    console.log(`Mode B Unique Wallets: ${setB.size}`);
    console.log(`Mode D Unique Wallets: ${setD.size}`);
    console.log(`Mode B vs Mode D Wallet Parity (Jaccard): ${jaccardBD}% (${intersectionBD}/${unionBD} wallets shared)`);
    rawResults.dataParity = {
      modeBWalletsCount: setB.size,
      modeDWalletsCount: setD.size,
      intersection: intersectionBD,
      union: unionBD,
      jaccardBD: Number(jaccardBD),
    };
  }
  return rawResults;
}

export { main, aggregateRuns };

if (process.argv[1] && process.argv[1].endsWith("run-benchmark.mjs")) {
  main().catch((err) => {
    console.error("\n[Benchmark Failure]", err);
    process.exit(1);
  });
}
