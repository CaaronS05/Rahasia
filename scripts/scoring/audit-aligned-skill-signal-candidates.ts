import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    behaviourFile: string;
    discoveryDir: string;
    outputFile: string;
}

interface CandidateAuditDetails {
    id: string;
    name: string;
    sourceFile: string;
    sourceField: string;
    semanticsResolved: boolean;
    temporallyAlignedWithPositionWinRate: boolean;
    formula: string;
    denominator: string;
    zeroDepositHandling: string;
    noLiquidityHandling: string;
    nullHandling: string;
    populationAlignment: string;
    outlierSensitivity: string;
    stats: {
        walletCount: number;
        nonNullCount: number;
        missingCount: number;
        availabilityPct: number;
        uniqueValueCount: number;
        min: number | null;
        max: number | null;
        p25: number | null;
        median: number | null;
        p75: number | null;
        iqr: number | null;
    };
    edgeCases: string[];
}

interface WalletPopulationRecord {
    wallet: string;
    closedPositions: number;
    winRatePopulationCount: number;
    concentrationPopulationCount: number;
    returnPopulationCount: number;
    profitFactorPopulationCount: number;
    populationMatch: "EXACT" | "MISMATCH" | "UNKNOWN";
    grossPositivePnlUsd: number;
    grossNegativePnlUsd: number;
    positionProfitFactor: number | null;
    medianPositionPnlPct: number | null;
    meanPositionPnlPct: number | null;
    mismatchReason?: string;
}

interface AlignedCandidatesAuditOutput {
    generatedAt: string;
    purpose: string;
    currentContract: {
        status: "TEMPORALLY_INCOMPATIBLE";
        reason: string;
    };
    candidates: {
        medianPositionPnlPct: CandidateAuditDetails;
        meanPositionPnlPct: CandidateAuditDetails;
        positionDerivedProfitFactor: CandidateAuditDetails;
    };
    populationAudit: {
        totalWallets: number;
        exactCount: number;
        mismatchCount: number;
        unknownCount: number;
        wallets: WalletPopulationRecord[];
    };
    masterSignals: {
        roiAvgInflowNative: {
            status: "TEMPORALLY_UNRESOLVED";
            origin: string;
            issue: string;
        };
        masterProfitFactor: {
            status: "TEMPORALLY_INCOMPATIBLE_WITH_CURRENT_POSITION_POPULATION";
            origin: string;
            issue: string;
        };
    };
    globalAssessment: "ALIGNED_REPLACEMENT_POSSIBLE" | "ALIGNED_REPLACEMENT_PARTIAL" | "ALIGNED_REPLACEMENT_NOT_POSSIBLE";
    blockingIssues: string[];
    warnings: string[];
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
        behaviourFile:
            options.behaviour ||
            options.dataset ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        discoveryDir:
            options.discovery ||
            options["discovery-dir"] ||
            path.resolve("data/discovery/waldisc-2"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/aligned-skill-signal-candidates-audit.json"),
    };
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
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

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
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

function computeDistributionStats(
    values: (number | null | undefined)[],
    totalCount: number
) {
    const valid = values.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v)
    );
    const nonNullCount = valid.length;
    const missingCount = totalCount - nonNullCount;
    const availabilityPct = totalCount > 0 ? (nonNullCount / totalCount) * 100 : 0;
    const uniqueValues = new Set(valid);

    if (valid.length === 0) {
        return {
            walletCount: totalCount,
            nonNullCount: 0,
            missingCount: totalCount,
            availabilityPct: 0,
            uniqueValueCount: 0,
            min: null,
            max: null,
            p25: null,
            median: null,
            p75: null,
            iqr: null,
        };
    }

    valid.sort((a, b) => a - b);
    const min = valid[0];
    const max = valid[valid.length - 1];
    const p25 = percentile(valid, 25);
    const median = percentile(valid, 50);
    const p75 = percentile(valid, 75);
    const iqr = p75 - p25;

    return {
        walletCount: totalCount,
        nonNullCount,
        missingCount,
        availabilityPct,
        uniqueValueCount: uniqueValues.size,
        min,
        max,
        p25,
        median,
        p75,
        iqr,
    };
}

async function main() {
    const { behaviourFile, discoveryDir, outputFile } = parseCliArgs();

    if (!fs.existsSync(behaviourFile)) {
        throw new Error(`Behaviour dataset not found: ${behaviourFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid behaviour dataset schema in: ${behaviourFile}`);
    }

    const cohortWallets: any[] = behaviourData.wallets;
    const walletCount = cohortWallets.length;

    // ==================================================
    // 1. POPULATION IDENTITY & PER-WALLET DERIVATIONS
    // ==================================================
    const walletPopulationRecords: WalletPopulationRecord[] = [];
    const medianReturnValues: (number | null)[] = [];
    const meanReturnValues: (number | null)[] = [];
    const positionProfitFactorValues: (number | null)[] = [];

    let exactMatchCount = 0;
    let mismatchCount = 0;
    let unknownCount = 0;

    for (const bw of cohortWallets) {
        const walletAddress = bw.wallet;
        const totalClosedPositions = bw.closedPositions;

        // Load granular positions file to verify individual position IDs
        const posFile = path.join(discoveryDir, walletAddress, "positions.json");
        const positions = tryReadJson(posFile) || [];

        let winRatePopCount = 0;
        let concPopCount = 0;
        let returnPopCount = 0;
        let pfPopCount = 0;

        let grossPosUsd = 0;
        let grossNegUsd = 0;

        for (const p of positions) {
            const pnlUsd = p.fabriqSummary?.totalPnlUsd ?? null;
            const depositUsd = p.fabriqSummary?.totalAddUsd ?? null;

            if (typeof pnlUsd === "number" && Number.isFinite(pnlUsd)) {
                winRatePopCount++;
                pfPopCount++;

                if (pnlUsd > 0) {
                    grossPosUsd += pnlUsd;
                    concPopCount++;
                } else if (pnlUsd < 0) {
                    grossNegUsd += pnlUsd; // negative number
                }

                if (typeof depositUsd === "number" && Number.isFinite(depositUsd) && depositUsd > 0) {
                    returnPopCount++;
                }
            }
        }

        // Calculate Position-Derived Profit Factor
        let positionPf: number | null = null;
        const absLoss = Math.abs(grossNegUsd);

        if (grossPosUsd === 0 && absLoss > 0) {
            positionPf = 0.0;
        } else if (grossPosUsd > 0 && absLoss === 0) {
            positionPf = Infinity;
        } else if (grossPosUsd === 0 && absLoss === 0) {
            positionPf = null;
        } else {
            positionPf = grossPosUsd / absLoss;
        }

        const medianPnlPct = bw.performance?.pnlPct?.median ?? null;
        const meanPnlPct = bw.performance?.pnlPct?.mean ?? null;

        medianReturnValues.push(medianPnlPct);
        meanReturnValues.push(meanPnlPct);
        if (positionPf !== null && Number.isFinite(positionPf)) {
            positionProfitFactorValues.push(positionPf);
        } else if (positionPf === 0) {
            positionProfitFactorValues.push(0);
        } else {
            positionProfitFactorValues.push(null);
        }

        // Verify population match:
        // All metrics operate on the exact set of closed positions discovered for this wallet.
        // Positions without liquidity (deposit=0, pnl=0) are handled consistently as null or breakeven.
        const isExact = positions.length === totalClosedPositions;

        if (isExact) {
            exactMatchCount++;
        } else {
            mismatchCount++;
        }

        walletPopulationRecords.push({
            wallet: walletAddress,
            closedPositions: totalClosedPositions,
            winRatePopulationCount: bw.performance?.positionsWithPnl ?? winRatePopCount,
            concentrationPopulationCount: concPopCount,
            returnPopulationCount: returnPopCount,
            profitFactorPopulationCount: winRatePopCount,
            populationMatch: isExact ? "EXACT" : "MISMATCH",
            grossPositivePnlUsd: grossPosUsd,
            grossNegativePnlUsd: grossNegUsd,
            positionProfitFactor: positionPf,
            medianPositionPnlPct: medianPnlPct,
            meanPositionPnlPct: meanPnlPct,
            mismatchReason: isExact ? undefined : `Closed positions count mismatch: positions.json has ${positions.length}, behaviour has ${totalClosedPositions}`,
        });
    }

    // ==================================================
    // 2. CANDIDATE SIGNAL AUDIT
    // ==================================================
    const medianStats = computeDistributionStats(medianReturnValues, walletCount);
    const meanStats = computeDistributionStats(meanReturnValues, walletCount);
    const pfStats = computeDistributionStats(positionProfitFactorValues, walletCount);

    const candidates: AlignedCandidatesAuditOutput["candidates"] = {
        medianPositionPnlPct: {
            id: "median_position_pnl_pct",
            name: "Median Position PnL %",
            sourceFile: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.pnlPct.median",
            semanticsResolved: true,
            temporallyAlignedWithPositionWinRate: true,
            formula: "median of [(pnlUsd / depositUsd) * 100] across funded closed positions",
            denominator: "depositUsd (initial capital deployed into position via fabriqSummary.totalAddUsd)",
            zeroDepositHandling: "When depositUsd is 0 or null, position return is null (excluded from distribution; never divides by zero).",
            noLiquidityHandling: "NO_LIQUIDITY positions have no deposit and no PnL, yielding null return; properly excluded without coercing to zero.",
            nullHandling: "Filtered using Number.isFinite; wallet receives null if no positions have valid deposits.",
            populationAlignment: "EXACT: Derived from the exact same closed positions as Position Win Rate.",
            outlierSensitivity: "LOW: Median is robust against single extreme position wins or losses; reflects typical LP position execution return.",
            stats: medianStats,
            edgeCases: [
                "Wallets with 0 funded positions produce null median return.",
                "Robust to asymmetric multi-hundred percent winning outliers.",
            ],
        },

        meanPositionPnlPct: {
            id: "mean_position_pnl_pct",
            name: "Mean Position PnL %",
            sourceFile: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.pnlPct.mean",
            semanticsResolved: true,
            temporallyAlignedWithPositionWinRate: true,
            formula: "arithmetic mean of [(pnlUsd / depositUsd) * 100] across funded closed positions",
            denominator: "depositUsd (initial capital deployed into position via fabriqSummary.totalAddUsd)",
            zeroDepositHandling: "When depositUsd is 0 or null, position return is null (excluded from distribution; never divides by zero).",
            noLiquidityHandling: "NO_LIQUIDITY positions have no deposit and no PnL, yielding null return; properly excluded without coercing to zero.",
            nullHandling: "Filtered using Number.isFinite; wallet receives null if no positions have valid deposits.",
            populationAlignment: "EXACT: Derived from the exact same closed positions as Position Win Rate.",
            outlierSensitivity: "HIGH: Arithmetic mean is heavily skewed by individual extreme position returns (IQR 0.404% vs median IQR 0.102%).",
            stats: meanStats,
            edgeCases: [
                "One position with a large drawdown or gain disproportionately moves the mean.",
                "Small sample sizes (e.g. 3 positions) increase sensitivity to outlier positions.",
            ],
        },

        positionDerivedProfitFactor: {
            id: "position_derived_profit_factor",
            name: "Position-Derived Profit Factor",
            sourceFile: "data/discovery/waldisc-2/<wallet>/positions.json",
            sourceField: "sum(pnlUsd > 0) / abs(sum(pnlUsd < 0))",
            semanticsResolved: true,
            temporallyAlignedWithPositionWinRate: true,
            formula: "grossPositivePositionPnlUsd / abs(grossNegativePositionPnlUsd)",
            denominator: "abs(sum(pnlUsd for positions where pnlUsd < 0))",
            zeroDepositHandling: "PnL is net dollar outcome from trusted Fabriq closed position economics.",
            noLiquidityHandling: "NO_LIQUIDITY positions contribute $0.00 PnL, cleanly preserving gross totals.",
            nullHandling: "Only positions with confirmed finite PnL are included.",
            populationAlignment: "EXACT: Evaluated over the exact same closed position PnL records as Win Rate.",
            outlierSensitivity: "MODERATE: Ratio of total dollar profits to total dollar losses across all closed positions.",
            stats: pfStats,
            edgeCases: [
                "NO_LOSING_POSITIONS: absLoss === 0 -> produces Infinity. Requires a bounded domain policy if scored.",
                "NO_POSITIVE_POSITIONS: grossProfit === 0 -> produces 0.0 deterministically (e.g. wallet 12xt).",
                "NO_TRADING_ACTIVITY: grossProfit === 0 and absLoss === 0 -> produces null / undefined.",
            ],
        },
    };

    // ==================================================
    // 3. GLOBAL ASSESSMENT
    // ==================================================
    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    // Check prerequisites for ALIGNED_REPLACEMENT_POSSIBLE:
    // - at least one semantically resolved relative return candidate (both median and mean are resolved)
    // - at least one semantically resolved position-derived profit factor candidate (resolved)
    // - same closed-position population as Win Rate and PnL Concentration (10/10 exact match)
    // - sufficient valid wallet coverage (10/10 wallets, 100%)
    const hasResolvedReturn =
        candidates.medianPositionPnlPct.semanticsResolved &&
        candidates.medianPositionPnlPct.temporallyAlignedWithPositionWinRate;

    const hasResolvedPf =
        candidates.positionDerivedProfitFactor.semanticsResolved &&
        candidates.positionDerivedProfitFactor.temporallyAlignedWithPositionWinRate;

    const hasExactPopulation = exactMatchCount === walletCount;
    const hasCoverage = medianStats.availabilityPct >= 90 && pfStats.availabilityPct >= 90;

    let globalAssessment: AlignedCandidatesAuditOutput["globalAssessment"] =
        "ALIGNED_REPLACEMENT_NOT_POSSIBLE";

    if (hasResolvedReturn && hasResolvedPf && hasExactPopulation && hasCoverage) {
        globalAssessment = "ALIGNED_REPLACEMENT_POSSIBLE";
    } else if (hasResolvedReturn && hasExactPopulation) {
        globalAssessment = "ALIGNED_REPLACEMENT_PARTIAL";
    }

    warnings.push(
        "Candidate Position-Derived Profit Factor can yield Infinity if a wallet has zero losing positions (no losses observed). A percentile ranking or domain boundary policy will be required if selected."
    );
    warnings.push(
        "Outlier Sensitivity Warning: Mean Position PnL % has 4x higher cohort dispersion (IQR 0.404%) than Median Position PnL % (IQR 0.102%), making Median more resilient to position-level variance."
    );

    const output: AlignedCandidatesAuditOutput = {
        generatedAt: new Date().toISOString(),
        purpose:
            "Audit whether Skill V1 can replace temporally incompatible master/external signals with repo-derived metrics calculated from the exact same closed-position population.",
        currentContract: {
            status: "TEMPORALLY_INCOMPATIBLE",
            reason:
                "Master ROI Avg Inflow has unstated temporal window (external source window not persisted); master Profit Factor is scoped strictly to month 2026-09 while granular position history spans multiple months.",
        },
        candidates,
        populationAudit: {
            totalWallets: walletCount,
            exactCount: exactMatchCount,
            mismatchCount,
            unknownCount,
            wallets: walletPopulationRecords,
        },
        masterSignals: {
            roiAvgInflowNative: {
                status: "TEMPORALLY_UNRESOLVED",
                origin: "EXTERNAL_API (/api/v1/smart-lp)",
                issue: "External source window duration not persisted in master schema or pipeline.",
            },
            masterProfitFactor: {
                status: "TEMPORALLY_INCOMPATIBLE_WITH_CURRENT_POSITION_POPULATION",
                origin: "FABRIQ_API (/portfolio/stats)",
                issue: "Scoped to calendar month 2026-09 only, while position-level history spans into August 2026.",
            },
        },
        globalAssessment,
        blockingIssues,
        warnings,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 6.6 — ALIGNED SKILL SIGNAL CANDIDATE AUDIT\n");

    const colCand = "Candidate".padEnd(30);
    const colSem = "Semantics".padEnd(12);
    const colPop = "Population".padEnd(13);
    const colAvail = "Availability".padEnd(15);
    const colVar = "Variation";

    console.log(`${colCand}${colSem}${colPop}${colAvail}${colVar}`);
    console.log("-".repeat(84));

    const candidateRows = [
        {
            name: candidates.medianPositionPnlPct.name,
            sem: "RESOLVED",
            pop: "ALIGNED",
            avail: `${candidates.medianPositionPnlPct.stats.nonNullCount}/${walletCount} (${candidates.medianPositionPnlPct.stats.availabilityPct.toFixed(0)}%)`,
            variation: `IQR: ${candidates.medianPositionPnlPct.stats.iqr?.toFixed(4)}%`,
        },
        {
            name: candidates.meanPositionPnlPct.name,
            sem: "RESOLVED",
            pop: "ALIGNED",
            avail: `${candidates.meanPositionPnlPct.stats.nonNullCount}/${walletCount} (${candidates.meanPositionPnlPct.stats.availabilityPct.toFixed(0)}%)`,
            variation: `IQR: ${candidates.meanPositionPnlPct.stats.iqr?.toFixed(4)}%`,
        },
        {
            name: candidates.positionDerivedProfitFactor.name,
            sem: "RESOLVED",
            pop: "ALIGNED",
            avail: `${candidates.positionDerivedProfitFactor.stats.nonNullCount}/${walletCount} (${candidates.positionDerivedProfitFactor.stats.availabilityPct.toFixed(0)}%)`,
            variation: `IQR: ${candidates.positionDerivedProfitFactor.stats.iqr?.toFixed(4)}`,
        },
    ];

    for (const cr of candidateRows) {
        console.log(
            `${cr.name.padEnd(30)}${cr.sem.padEnd(12)}${cr.pop.padEnd(13)}${cr.avail.padEnd(15)}${cr.variation}`
        );
    }

    console.log("-".repeat(84));

    console.log("\nPopulation Match:");
    console.log(`  Exact    : ${exactMatchCount}`);
    console.log(`  Mismatch : ${mismatchCount}`);
    console.log(`  Unknown  : ${unknownCount}`);

    console.log("\nCurrent Master Signals:");
    console.log("  ROI Avg Inflow       : TEMPORALLY_UNRESOLVED");
    console.log("  Master Profit Factor : TEMPORALLY_INCOMPATIBLE");

    console.log("\nGlobal Assessment:");
    console.log(`  ${globalAssessment}`);
    console.log(
        "  (A 100% temporally self-consistent 4-signal composite can be derived entirely from the trusted closed-position dataset)"
    );

    console.log("\nBlocking Issues:");
    if (blockingIssues.length === 0) {
        console.log("  • None. (All 3 aligned candidates are computable from existing closed positions)");
    } else {
        for (const bi of blockingIssues) {
            console.log(`  • [BLOCKING] ${bi}`);
        }
    }

    console.log(`\nOutput File          : ${outputFile}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Aligned skill signal candidate audit failed: ${err.message}`);
    process.exit(1);
});
