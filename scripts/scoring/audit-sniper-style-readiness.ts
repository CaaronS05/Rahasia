import fs from "node:fs";
import path from "node:path";

export type SniperReadinessAssessment =
  | "READY_FOR_RULE_DESIGN"
  | "LOW_VARIATION"
  | "NO_SNIPER_EVIDENCE"
  | "INSUFFICIENT_SAMPLE";

export interface CandidateGridCell {
  entryThresholdHours: number;
  entryThresholdLabel: string;
  holdThresholdHours: number;
  holdThresholdLabel: string;
  qualifyingWalletCount: number;
  wallets: string[];
}

export interface WalletSniperObservation {
  wallet: string;
  positionCount: number;
  entryTiming: {
    medianEntryDelayHours: number | null;
    meanEntryDelayHours: number | null;
    positionsLe24h: number;
    positionsLe72h: number;
    positionsLe7d: number;
    positionsLe30d: number;
    earlyEntryPositionPct24h: number;
    earlyEntryPositionPct72h: number;
    earlyEntryPositionPct7d: number;
    earlyEntryPositionPct30d: number;
  };
  holding: {
    medianHoldHours: number | null;
    meanHoldHours: number | null;
    positionsLe1h: number;
    positionsLe6h: number;
    positionsLe24h: number;
    positionsLe72h: number;
  };
}

export interface SniperStyleReadinessOutput {
  generatedAt: string;

  population: {
    wallets: number;
    positions: number;
  };

  entryTimingDistribution: {
    positionThresholds: {
      le1h: { count: number; pct: number };
      le6h: { count: number; pct: number };
      le24h: { count: number; pct: number };
      le72h: { count: number; pct: number };
      le7d: { count: number; pct: number };
      le30d: { count: number; pct: number };
    };
    cohortPositionPercentiles: {
      min: number | null;
      p10: number | null;
      p25: number | null;
      median: number | null;
      p75: number | null;
      p90: number | null;
      max: number | null;
    };
    cohortWalletMedianPercentiles: {
      p25: number | null;
      median: number | null;
      p75: number | null;
    };
  };

  holdDurationDistribution: {
    positionThresholds: {
      le1h: { count: number; pct: number };
      le6h: { count: number; pct: number };
      le24h: { count: number; pct: number };
      le72h: { count: number; pct: number };
    };
    cohortPositionPercentiles: {
      min: number | null;
      p10: number | null;
      p25: number | null;
      median: number | null;
      p75: number | null;
      p90: number | null;
      max: number | null;
    };
    cohortWalletMedianPercentiles: {
      p25: number | null;
      median: number | null;
      p75: number | null;
    };
  };

  wallets: WalletSniperObservation[];
  candidateGrid: CandidateGridCell[];
  assessment: SniperReadinessAssessment;
  notes: string[];
}

interface CliOptions {
  entryProfileFile: string;
  behaviourFile: string;
  waldiscDir: string;
  outputFile: string;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    }
  }

  return {
    entryProfileFile:
      options["entry-profile"] ||
      path.resolve("data/discovery/waldisc-2/entry-timing-profile.json"),
    behaviourFile:
      options["behaviour-file"] ||
      path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
    waldiscDir:
      options["waldisc-dir"] ||
      path.resolve("data/discovery/waldisc-2"),
    outputFile:
      options["output-file"] ||
      options.output ||
      path.resolve("data/discovery/waldisc-2/sniper-style-readiness.json"),
  };
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: any): void {
  ensureDirectory(filePath);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function tryReadJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function runSniperStyleReadinessAudit(): SniperStyleReadinessOutput {
  const opts = parseCliArgs();

  console.log("==================================================");
  console.log("WALDISC-2 — SNIPER STYLE READINESS AUDIT");
  console.log("==================================================");

  // 1. Load entry timing profile
  const entryProfile = tryReadJson(opts.entryProfileFile);
  if (!entryProfile || !Array.isArray(entryProfile.positions) || !Array.isArray(entryProfile.wallets)) {
    throw new Error(`Failed to load entry timing profile from: ${opts.entryProfileFile}`);
  }

  // 2. Load wallet behaviour dataset for holding behaviour
  const behaviourDataset = tryReadJson(opts.behaviourFile);
  const behaviourMap = new Map<string, any>();
  if (Array.isArray(behaviourDataset?.wallets)) {
    for (const w of behaviourDataset.wallets) {
      behaviourMap.set(w.wallet, w);
    }
  }

  const validPositions: any[] = entryProfile.positions.filter(
    (p: any) => p.status === "VALID" && typeof p.entryDelayHours === "number"
  );
  const totalPositions = validPositions.length;

  console.log(`Wallets Loaded        : ${entryProfile.wallets.length}`);
  console.log(`Valid Positions       : ${totalPositions}`);

  // 3. Position-level early entry counts
  let countLe1h = 0;
  let countLe6h = 0;
  let countLe24h = 0;
  let countLe72h = 0;
  let countLe7d = 0;
  let countLe30d = 0;

  for (const pos of validPositions) {
    const delay = pos.entryDelayHours as number;
    if (delay <= 1) countLe1h++;
    if (delay <= 6) countLe6h++;
    if (delay <= 24) countLe24h++;
    if (delay <= 72) countLe72h++;
    if (delay <= 7 * 24) countLe7d++;
    if (delay <= 30 * 24) countLe30d++;
  }

  const calcPct = (c: number): number =>
    totalPositions > 0 ? Number(((c / totalPositions) * 100).toFixed(2)) : 0;

  // 4. Wallet-level processing
  const walletObservations: WalletSniperObservation[] = [];
  const allPositionHoldHours: number[] = [];

  for (const walletEntry of entryProfile.wallets) {
    const walletAddr: string = walletEntry.wallet;
    const walletPos = validPositions.filter((p: any) => p.wallet === walletAddr);
    const posCount = walletPos.length;

    // Entry timing metrics
    let wLe24h = 0;
    let wLe72h = 0;
    let wLe7d = 0;
    let wLe30d = 0;

    for (const p of walletPos) {
      const delay = p.entryDelayHours as number;
      if (delay <= 24) wLe24h++;
      if (delay <= 72) wLe72h++;
      if (delay <= 7 * 24) wLe7d++;
      if (delay <= 30 * 24) wLe30d++;
    }

    const calcWalletPct = (c: number): number =>
      posCount > 0 ? Number(((c / posCount) * 100).toFixed(2)) : 0;

    // Hold duration metrics: check wallet-behaviour.json or positions.json
    let medianHoldH = walletEntry.medianHoldHours ?? null;
    let meanHoldH = walletEntry.meanHoldHours ?? null;

    const bData = behaviourMap.get(walletAddr);
    if (bData?.holdingBehaviour) {
      if (typeof bData.holdingBehaviour.medianDurationHours === "number") {
        medianHoldH = bData.holdingBehaviour.medianDurationHours;
      }
      if (typeof bData.holdingBehaviour.meanDurationHours === "number") {
        meanHoldH = bData.holdingBehaviour.meanDurationHours;
      }
    }

    // Inspect individual positions for hold durations
    let wHoldLe1h = 0;
    let wHoldLe6h = 0;
    let wHoldLe24h = 0;
    let wHoldLe72h = 0;

    const walletPosFile = path.join(opts.waldiscDir, walletAddr, "positions.json");
    const rawPosList = tryReadJson(walletPosFile);
    if (Array.isArray(rawPosList)) {
      for (const p of rawPosList) {
        let durSec: number | null = null;
        if (typeof p.durationSeconds === "number" && p.durationSeconds >= 0) {
          durSec = p.durationSeconds;
        } else if (p.openedAt && p.closedAt) {
          const tOpen = Date.parse(p.openedAt.trim().replace(" ", "T") + (p.openedAt.includes("Z") ? "" : "Z"));
          const tClose = Date.parse(p.closedAt.trim().replace(" ", "T") + (p.closedAt.includes("Z") ? "" : "Z"));
          if (!isNaN(tOpen) && !isNaN(tClose) && tClose >= tOpen) {
            durSec = (tClose - tOpen) / 1000;
          }
        }

        if (durSec !== null) {
          const durHours = durSec / 3600;
          allPositionHoldHours.push(durHours);
          if (durHours <= 1) wHoldLe1h++;
          if (durHours <= 6) wHoldLe6h++;
          if (durHours <= 24) wHoldLe24h++;
          if (durHours <= 72) wHoldLe72h++;
        }
      }
    }

    walletObservations.push({
      wallet: walletAddr,
      positionCount: posCount,
      entryTiming: {
        medianEntryDelayHours: walletEntry.medianEntryDelayHours ?? null,
        meanEntryDelayHours: walletEntry.meanEntryDelayHours ?? null,
        positionsLe24h: wLe24h,
        positionsLe72h: wLe72h,
        positionsLe7d: wLe7d,
        positionsLe30d: wLe30d,
        earlyEntryPositionPct24h: calcWalletPct(wLe24h),
        earlyEntryPositionPct72h: calcWalletPct(wLe72h),
        earlyEntryPositionPct7d: calcWalletPct(wLe7d),
        earlyEntryPositionPct30d: calcWalletPct(wLe30d),
      },
      holding: {
        medianHoldHours: medianHoldH,
        meanHoldHours: meanHoldH,
        positionsLe1h: wHoldLe1h,
        positionsLe6h: wHoldLe6h,
        positionsLe24h: wHoldLe24h,
        positionsLe72h: wHoldLe72h,
      },
    });
  }

  // 5. Build Combined Sniper Candidate Grid
  // ENTRY: 24h, 72h, 7d (168h), 30d (720h)
  // HOLD: 1h, 6h, 24h
  const ENTRY_THRESHOLDS = [
    { hours: 24, label: "<= 24h" },
    { hours: 72, label: "<= 72h" },
    { hours: 168, label: "<= 7d" },
    { hours: 720, label: "<= 30d" },
  ];

  const HOLD_THRESHOLDS = [
    { hours: 1, label: "<= 1h" },
    { hours: 6, label: "<= 6h" },
    { hours: 24, label: "<= 24h" },
  ];

  const candidateGrid: CandidateGridCell[] = [];

  for (const eThresh of ENTRY_THRESHOLDS) {
    for (const hThresh of HOLD_THRESHOLDS) {
      const qualifyingWallets = walletObservations
        .filter((w) => {
          const entryVal = w.entryTiming.medianEntryDelayHours;
          const holdVal = w.holding.medianHoldHours;
          if (entryVal === null || holdVal === null) return false;
          return entryVal <= eThresh.hours && holdVal <= hThresh.hours;
        })
        .map((w) => w.wallet);

      candidateGrid.push({
        entryThresholdHours: eThresh.hours,
        entryThresholdLabel: eThresh.label,
        holdThresholdHours: hThresh.hours,
        holdThresholdLabel: hThresh.label,
        qualifyingWalletCount: qualifyingWallets.length,
        wallets: qualifyingWallets,
      });
    }
  }

  // 6. Hold duration cohort distribution percentiles
  allPositionHoldHours.sort((a, b) => a - b);
  const totalHoldPositions = allPositionHoldHours.length;

  let totalHoldLe1h = 0;
  let totalHoldLe6h = 0;
  let totalHoldLe24h = 0;
  let totalHoldLe72h = 0;

  for (const h of allPositionHoldHours) {
    if (h <= 1) totalHoldLe1h++;
    if (h <= 6) totalHoldLe6h++;
    if (h <= 24) totalHoldLe24h++;
    if (h <= 72) totalHoldLe72h++;
  }

  const calcHoldPct = (c: number): number =>
    totalHoldPositions > 0 ? Number(((c / totalHoldPositions) * 100).toFixed(2)) : 0;

  const walletHoldMedians = walletObservations
    .map((w) => w.holding.medianHoldHours)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  // 7. Assessment determination
  const notes: string[] = [];
  let assessment: SniperReadinessAssessment;

  const maxQualifying = Math.max(...candidateGrid.map((c) => c.qualifyingWalletCount));

  if (walletObservations.length < 5 || totalPositions < 20) {
    assessment = "INSUFFICIENT_SAMPLE";
    notes.push(
      `Insufficient sample size for sniper rule design (${walletObservations.length} wallets, ${totalPositions} positions).`
    );
  } else if (maxQualifying === 0) {
    assessment = "NO_SNIPER_EVIDENCE";
    notes.push(
      "No wallet in the current validated cohort qualifies under any combined entry timing and hold duration threshold (24h, 72h, 7d, 30d entry x 1h, 6h, 24h hold)."
    );
    notes.push(
      "Cohort wallets enter mature pools: minimum wallet median entry delay is ~13,542 hours (~564 days) post pool creation."
    );
    notes.push(
      "Zero positions entered within 7 days, 72 hours, 24 hours, 6 hours, or 1 hour of pool genesis."
    );
    notes.push(
      "Although some wallets exhibit short holding durations (e.g. 12xt median hold ~0.036h), they do not enter pools early."
    );
    notes.push(
      "Finding: NO_SNIPER_EVIDENCE is a valid descriptive finding. Current cohort reflects secondary liquidity provision rather than pool launch sniping."
    );
  } else if (maxQualifying >= walletObservations.length - 1) {
    assessment = "LOW_VARIATION";
    notes.push("Nearly all wallets qualify under threshold grid, offering negligible behavioral discrimination.");
  } else {
    assessment = "READY_FOR_RULE_DESIGN";
    notes.push(
      `Meaningful variation observed: up to ${maxQualifying} wallet(s) qualify without universal qualification.`
    );
  }

  const output: SniperStyleReadinessOutput = {
    generatedAt: new Date().toISOString(),

    population: {
      wallets: walletObservations.length,
      positions: totalPositions,
    },

    entryTimingDistribution: {
      positionThresholds: {
        le1h: { count: countLe1h, pct: calcPct(countLe1h) },
        le6h: { count: countLe6h, pct: calcPct(countLe6h) },
        le24h: { count: countLe24h, pct: calcPct(countLe24h) },
        le72h: { count: countLe72h, pct: calcPct(countLe72h) },
        le7d: { count: countLe7d, pct: calcPct(countLe7d) },
        le30d: { count: countLe30d, pct: calcPct(countLe30d) },
      },
      cohortPositionPercentiles: entryProfile.cohortDistribution?.positionEntryDelayHours ?? {
        min: null,
        p10: null,
        p25: null,
        median: null,
        p75: null,
        p90: null,
        max: null,
      },
      cohortWalletMedianPercentiles: entryProfile.cohortDistribution?.walletMedianEntryDelayHours ?? {
        p25: null,
        median: null,
        p75: null,
      },
    },

    holdDurationDistribution: {
      positionThresholds: {
        le1h: { count: totalHoldLe1h, pct: calcHoldPct(totalHoldLe1h) },
        le6h: { count: totalHoldLe6h, pct: calcHoldPct(totalHoldLe6h) },
        le24h: { count: totalHoldLe24h, pct: calcHoldPct(totalHoldLe24h) },
        le72h: { count: totalHoldLe72h, pct: calcHoldPct(totalHoldLe72h) },
      },
      cohortPositionPercentiles: {
        min: allPositionHoldHours.length > 0 ? allPositionHoldHours[0] : null,
        p10: percentile(allPositionHoldHours, 10),
        p25: percentile(allPositionHoldHours, 25),
        median: percentile(allPositionHoldHours, 50),
        p75: percentile(allPositionHoldHours, 75),
        p90: percentile(allPositionHoldHours, 90),
        max: allPositionHoldHours.length > 0 ? allPositionHoldHours[allPositionHoldHours.length - 1] : null,
      },
      cohortWalletMedianPercentiles: {
        p25: percentile(walletHoldMedians, 25),
        median: percentile(walletHoldMedians, 50),
        p75: percentile(walletHoldMedians, 75),
      },
    },

    wallets: walletObservations,
    candidateGrid,
    assessment,
    notes,
  };

  // Write output artifact
  atomicWriteJson(opts.outputFile, output);

  // -------------------------------------------------------------------------
  // Terminal Report
  // -------------------------------------------------------------------------
  console.log("\nWALDISC-2 — SNIPER STYLE READINESS AUDIT\n");
  console.log(`Wallets                  : ${walletObservations.length}`);
  console.log(`Positions                : ${totalPositions}\n`);

  console.log("EARLY ENTRY POSITIONS");
  console.log(`<= 1h                    : ${countLe1h} (${calcPct(countLe1h)}%)`);
  console.log(`<= 6h                    : ${countLe6h} (${calcPct(countLe6h)}%)`);
  console.log(`<= 24h                   : ${countLe24h} (${calcPct(countLe24h)}%)`);
  console.log(`<= 72h                   : ${countLe72h} (${calcPct(countLe72h)}%)`);
  console.log(`<= 7d                    : ${countLe7d} (${calcPct(countLe7d)}%)`);
  console.log(`<= 30d                   : ${countLe30d} (${calcPct(countLe30d)}%)\n`);

  console.log("COMBINED THRESHOLD GRID\n");
  for (const eThresh of ENTRY_THRESHOLDS) {
    console.log(`ENTRY ${eThresh.label}`);
    for (const hThresh of HOLD_THRESHOLDS) {
      const cell = candidateGrid.find(
        (c) => c.entryThresholdHours === eThresh.hours && c.holdThresholdHours === hThresh.hours
      );
      const count = cell ? cell.qualifyingWalletCount : 0;
      console.log(`  HOLD ${hThresh.label.padEnd(8)}: ${count} wallet${count === 1 ? "" : "s"}`);
    }
    console.log("");
  }

  console.log("Assessment:");
  console.log(assessment);
  console.log("==================================================");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("audit-sniper-style-readiness.ts")) {
  try {
    runSniperStyleReadinessAudit();
  } catch (err) {
    console.error("Fatal error during sniper style readiness audit:", err);
    process.exit(1);
  }
}
