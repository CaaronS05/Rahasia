import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    behaviourFile: string;
    cohortDistFile: string;
    confidenceFile: string;
    masterFile: string;
    outputFile: string;
}

type SignalRole =
    | "SKILL_CANDIDATE"
    | "STYLE_BEHAVIOUR"
    | "CONFIDENCE_ONLY"
    | "DEFERRED_LOW_VARIATION"
    | "UNAVAILABLE"
    | "SUPPORTING_ONLY";

type SignalDirection = "higher_is_better" | "lower_is_better" | "none";

interface SignalAudit {
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
}

interface SignalRecord {
    id: string;
    name: string;
    source: string;
    sourceField: string;
    role: SignalRole;
    conceptualGroup: string;
    direction: SignalDirection;
    eligibleForSkillV1: boolean;
    normalizationPlan: "cohort_percentile" | null;
    audit: SignalAudit;
    reason: string;
}

interface SkillSignalDesignOutput {
    generatedAt: string;
    walletCount: number;
    methodology: {
        purpose: "skill_signal_design_only";
        skillScoreCalculated: false;
        confidenceSeparatedFromSkill: true;
        fabriqTrusted: true;
        normalizationPlan: "cohort_percentile";
    };
    signals: SignalRecord[];
    skillV1Candidates: SignalRecord[];
    styleSignals: SignalRecord[];
    confidenceOnlySignals: SignalRecord[];
    deferredSignals: SignalRecord[];
    unavailableSignals: SignalRecord[];
    supportingSignals: SignalRecord[];
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
        cohortDistFile:
            options["cohort-dist"] ||
            options.distribution ||
            options["distribution-file"] ||
            path.resolve("data/discovery/waldisc-2/cohort-distribution.json"),
        confidenceFile:
            options.confidence ||
            options["confidence-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-confidence.json"),
        masterFile:
            options.master ||
            options["master-file"] ||
            path.resolve("data/master/wallets-master.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/skill-signal-design.json"),
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

function computeAuditStats(
    values: (number | null | undefined)[],
    walletCount: number
): SignalAudit {
    const valid = values.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v)
    );
    const nonNullCount = valid.length;
    const missingCount = walletCount - nonNullCount;
    const availabilityPct = walletCount > 0 ? (nonNullCount / walletCount) * 100 : 0;
    const uniqueValues = new Set(valid);
    const uniqueValueCount = uniqueValues.size;

    if (valid.length === 0) {
        return {
            nonNullCount,
            missingCount,
            availabilityPct,
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
        nonNullCount,
        missingCount,
        availabilityPct,
        uniqueValueCount,
        min,
        max,
        p25,
        median,
        p75,
        iqr,
    };
}

interface SignalCandidateDef {
    id: string;
    name: string;
    source: string;
    sourceField: string;
    initialRole: SignalRole;
    conceptualGroup: string;
    direction: SignalDirection;
    extractor: (ctx: {
        bw: any;
        mw: any;
        cw: any;
    }) => number | null;
    isUnavailable?: boolean;
    candidateForDiscrimination?: boolean;
    reasonIfEligible: string;
    reasonIfIneligible: string;
}

async function main() {
    const { behaviourFile, cohortDistFile, confidenceFile, masterFile, outputFile } =
        parseCliArgs();

    if (!fs.existsSync(behaviourFile)) {
        throw new Error(`Wallet behaviour dataset not found: ${behaviourFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid behaviour dataset schema in: ${behaviourFile}`);
    }

    const cohortDistData = tryReadJson(cohortDistFile);
    const masterData = tryReadJson(masterFile);

    const cohortWallets: any[] = behaviourData.wallets;
    const walletCount = cohortWallets.length;

    const masterMap = new Map<string, any>();
    if (masterData && Array.isArray(masterData.wallets)) {
        for (const mw of masterData.wallets) {
            if (mw && mw.owner) {
                masterMap.set(mw.owner, mw);
            }
        }
    }

    const cohortDistMap = new Map<string, any>();
    if (cohortDistData && Array.isArray(cohortDistData.wallets)) {
        for (const cw of cohortDistData.wallets) {
            if (cw && cw.wallet) {
                cohortDistMap.set(cw.wallet, cw);
            }
        }
    }

    const signalDefs: SignalCandidateDef[] = [
        // A. Primary Skill Candidates
        {
            id: "roi_avg_inflow_native",
            name: "ROI Avg Inflow",
            source: "data/master/wallets-master.json",
            sourceField: "roi_avg_inflow_native",
            initialRole: "SKILL_CANDIDATE",
            conceptualGroup: "profitability",
            direction: "higher_is_better",
            candidateForDiscrimination: true,
            extractor: ({ mw }) =>
                typeof mw?.roi_avg_inflow_native === "number" && Number.isFinite(mw.roi_avg_inflow_native)
                    ? mw.roi_avg_inflow_native
                    : null,
            reasonIfEligible:
                "Measures profitability relative to deployed capital rather than absolute wallet size.",
            reasonIfIneligible: "Source field unavailable or insufficient cohort observations.",
        },
        {
            id: "profit_factor_usd_ratio",
            name: "Profit Factor",
            source: "data/master/wallets-master.json",
            sourceField: "fabriq.stats.profitFactorUsd.ratio",
            initialRole: "SKILL_CANDIDATE",
            conceptualGroup: "consistency",
            direction: "higher_is_better",
            candidateForDiscrimination: true,
            extractor: ({ mw }) =>
                typeof mw?.fabriq?.stats?.profitFactorUsd?.ratio === "number" &&
                Number.isFinite(mw.fabriq.stats.profitFactorUsd.ratio)
                    ? mw.fabriq.stats.profitFactorUsd.ratio
                    : null,
            reasonIfEligible:
                "Ratio of gross profit to gross loss from trusted Fabriq economic statistics.",
            reasonIfIneligible: "Fabriq profit factor unavailable or zero cohort observations.",
        },
        {
            id: "win_rate_position",
            name: "Position Win Rate",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.winRatePct",
            initialRole: "SKILL_CANDIDATE",
            conceptualGroup: "consistency",
            direction: "higher_is_better",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.performance?.winRatePct === "number" &&
                Number.isFinite(bw.performance.winRatePct)
                    ? bw.performance.winRatePct
                    : null,
            reasonIfEligible:
                "Granular closed position-level win rate reflecting strategy consistency.",
            reasonIfIneligible: "Position win rate not found or zero cohort observations.",
        },
        {
            id: "pnl_concentration_top1",
            name: "PnL Concentration Top1",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.top1PositiveProfitSharePct",
            initialRole: "SKILL_CANDIDATE",
            conceptualGroup: "concentration",
            direction: "lower_is_better",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.performance?.top1PositiveProfitSharePct === "number" &&
                Number.isFinite(bw.performance.top1PositiveProfitSharePct)
                    ? bw.performance.top1PositiveProfitSharePct
                    : null,
            reasonIfEligible:
                "Gross-positive PnL concentration; lower concentration indicates less reliance on a single winning position.",
            reasonIfIneligible: "Concentration metric unavailable or insufficient observations.",
        },
        {
            id: "consistency_daily_pnl",
            name: "Daily PnL Consistency",
            source: "data/master/wallets-master.json",
            sourceField: "consistencyDailyPnl",
            initialRole: "UNAVAILABLE",
            conceptualGroup: "consistency",
            direction: "higher_is_better",
            isUnavailable: true,
            extractor: () => null,
            reasonIfEligible: "Daily PnL consistency metric across active trading days.",
            reasonIfIneligible:
                "NOT_YET_IMPLEMENTED: Source field consistencyDailyPnl not found in master schema.",
        },

        // B. Granular Supporting Performance Signals
        {
            id: "top3_positive_profit_share_pct",
            name: "PnL Concentration Top3",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.top3PositiveProfitSharePct",
            initialRole: "SUPPORTING_ONLY",
            conceptualGroup: "concentration",
            direction: "lower_is_better",
            extractor: ({ bw }) =>
                typeof bw?.performance?.top3PositiveProfitSharePct === "number" &&
                Number.isFinite(bw.performance.top3PositiveProfitSharePct)
                    ? bw.performance.top3PositiveProfitSharePct
                    : null,
            reasonIfEligible: "Supporting gross-positive profit concentration across top 3 wins.",
            reasonIfIneligible:
                "EXCLUDED_REDUNDANT: Strongly correlated with top1 concentration; preserved as supporting only to avoid double-counting.",
        },
        {
            id: "median_position_pnl_pct",
            name: "Median Position PnL Pct",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.pnlPct.median",
            initialRole: "SUPPORTING_ONLY",
            conceptualGroup: "profitability",
            direction: "higher_is_better",
            extractor: ({ bw }) =>
                typeof bw?.performance?.pnlPct?.median === "number" &&
                Number.isFinite(bw.performance.pnlPct.median)
                    ? bw.performance.pnlPct.median
                    : null,
            reasonIfEligible: "Median position return percentage.",
            reasonIfIneligible:
                "EXCLUDED_SUPPORTING_ONLY: Preserved for redundancy analysis; overlaps with roi_avg_inflow_native and winRatePosition.",
        },
        {
            id: "mean_position_pnl_pct",
            name: "Mean Position PnL Pct",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.pnlPct.mean",
            initialRole: "SUPPORTING_ONLY",
            conceptualGroup: "profitability",
            direction: "higher_is_better",
            extractor: ({ bw }) =>
                typeof bw?.performance?.pnlPct?.mean === "number" &&
                Number.isFinite(bw.performance.pnlPct.mean)
                    ? bw.performance.pnlPct.mean
                    : null,
            reasonIfEligible: "Mean position return percentage.",
            reasonIfIneligible:
                "EXCLUDED_SUPPORTING_ONLY: Preserved for redundancy analysis; overlaps with roi_avg_inflow_native and winRatePosition.",
        },

        // C. Descriptive Scale Signals (Not Skill)
        {
            id: "total_pnl_usd",
            name: "Total PnL USD",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.totalPnlUsd",
            initialRole: "SUPPORTING_ONLY",
            conceptualGroup: "scale",
            direction: "none",
            extractor: ({ bw }) =>
                typeof bw?.performance?.totalPnlUsd === "number" &&
                Number.isFinite(bw.performance.totalPnlUsd)
                    ? bw.performance.totalPnlUsd
                    : null,
            reasonIfEligible: "Total net PnL in USD.",
            reasonIfIneligible:
                "SCALE_DESCRIPTIVE: Absolute money scale differs by wallet capital size; not relative skill.",
        },
        {
            id: "total_deposits_usd",
            name: "Total Deposits USD",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "capitalBehaviour.totalDepositsUsd",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "scale",
            direction: "none",
            extractor: ({ bw }) =>
                typeof bw?.capitalBehaviour?.totalDepositsUsd === "number" &&
                Number.isFinite(bw.capitalBehaviour.totalDepositsUsd)
                    ? bw.capitalBehaviour.totalDepositsUsd
                    : null,
            reasonIfEligible: "Total capital deposited across closed positions.",
            reasonIfIneligible:
                "SCALE_DESCRIPTIVE: Capital deployment scale descriptor; not skill.",
        },
        {
            id: "total_fees_usd",
            name: "Total Fees USD",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "capitalBehaviour.totalFeesUsd",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "scale",
            direction: "none",
            extractor: ({ bw }) =>
                typeof bw?.capitalBehaviour?.totalFeesUsd === "number" &&
                Number.isFinite(bw.capitalBehaviour.totalFeesUsd)
                    ? bw.capitalBehaviour.totalFeesUsd
                    : null,
            reasonIfEligible: "Total fee revenue collected in USD.",
            reasonIfIneligible:
                "SCALE_DESCRIPTIVE: Absolute fee earnings scale descriptor; not relative skill.",
        },

        // D. Style / Behaviour Signals
        {
            id: "median_range_width_pct",
            name: "Median Range Width",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "rangeBehaviour.rangeWidthPct.median",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "range_style",
            direction: "none",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.rangeBehaviour?.rangeWidthPct?.median === "number" &&
                Number.isFinite(bw.rangeBehaviour.rangeWidthPct.median)
                    ? bw.rangeBehaviour.rangeWidthPct.median
                    : null,
            reasonIfEligible: "Median price range width percentage.",
            reasonIfIneligible:
                "STYLE_BEHAVIOUR: Operating style preference (width of liquidity band); no monotonic skill direction.",
        },
        {
            id: "median_duration_hours",
            name: "Hold Duration Median",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "holdingBehaviour.medianDurationHours",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "holding_style",
            direction: "none",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.holdingBehaviour?.medianDurationHours === "number" &&
                Number.isFinite(bw.holdingBehaviour.medianDurationHours)
                    ? bw.holdingBehaviour.medianDurationHours
                    : null,
            reasonIfEligible: "Median position holding duration in hours.",
            reasonIfIneligible:
                "STYLE_BEHAVIOUR: Holding duration style; shorter or longer hold does not universally imply skill.",
        },
        {
            id: "fee_to_deposit_pct",
            name: "Fee to Deposit Pct",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "capitalBehaviour.feeToDepositPct",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "capital_style",
            direction: "none",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.capitalBehaviour?.feeToDepositPct === "number" &&
                Number.isFinite(bw.capitalBehaviour.feeToDepositPct)
                    ? bw.capitalBehaviour.feeToDepositPct
                    : null,
            reasonIfEligible: "Ratio of total fees earned to deposits made.",
            reasonIfIneligible:
                "STYLE_BEHAVIOUR: Fee efficiency descriptor; preserved for LP style characterization.",
        },

        // E. Low-Variation / Deferred Signals
        {
            id: "placement_fraction",
            name: "Placement",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "placementBehaviour.placementFraction.median",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "placement_style",
            direction: "none",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.placementBehaviour?.placementFraction?.median === "number" &&
                Number.isFinite(bw.placementBehaviour.placementFraction.median)
                    ? bw.placementBehaviour.placementFraction.median
                    : null,
            reasonIfEligible: "Median placement fraction relative to active bin.",
            reasonIfIneligible:
                "DEFERRED_LOW_VARIATION: Zero interquartile variation (p25 === p75) in current cohort; deferred until cohort expands.",
        },
        {
            id: "true_rebalance_frequency",
            name: "True Rebalance Frequency",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "rebalanceBehaviour.trueRebalancePositionPct",
            initialRole: "STYLE_BEHAVIOUR",
            conceptualGroup: "rebalance_style",
            direction: "none",
            candidateForDiscrimination: true,
            extractor: ({ bw }) =>
                typeof bw?.rebalanceBehaviour?.trueRebalancePositionPct === "number" &&
                Number.isFinite(bw.rebalanceBehaviour.trueRebalancePositionPct)
                    ? bw.rebalanceBehaviour.trueRebalancePositionPct
                    : null,
            reasonIfEligible: "Percentage of closed positions undergoing true rebalance.",
            reasonIfIneligible:
                "DEFERRED_LOW_VARIATION: Zero interquartile variation (p25 === p75) in current cohort; deferred until cohort expands.",
        },

        // F. Confidence-Only Signals
        {
            id: "closed_positions",
            name: "Closed Positions",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "closedPositions",
            initialRole: "CONFIDENCE_ONLY",
            conceptualGroup: "evidence_confidence",
            direction: "none",
            extractor: ({ bw }) =>
                typeof bw?.closedPositions === "number" && Number.isFinite(bw.closedPositions)
                    ? bw.closedPositions
                    : null,
            reasonIfEligible: "Total number of closed LP positions.",
            reasonIfIneligible:
                "CONFIDENCE_ONLY: Sample size metric representing evidence confidence only, never skill.",
        },
        {
            id: "range_coverage",
            name: "Range Coverage",
            source: "data/discovery/waldisc-2/cohort-distribution.json",
            sourceField: "rangeCoveragePct",
            initialRole: "CONFIDENCE_ONLY",
            conceptualGroup: "evidence_confidence",
            direction: "none",
            extractor: ({ cw, bw }) => {
                if (typeof cw?.rangeCoveragePct === "number" && Number.isFinite(cw.rangeCoveragePct)) {
                    return cw.rangeCoveragePct;
                }
                if (cw?.positionsWithRange !== undefined && bw?.closedPositions > 0) {
                    return (cw.positionsWithRange / bw.closedPositions) * 100;
                }
                return null;
            },
            reasonIfEligible: "Percentage of positions with valid price ranges.",
            reasonIfIneligible:
                "CONFIDENCE_ONLY: Range coverage represents observation completeness, not strategy skill.",
        },
        {
            id: "unique_pools",
            name: "Unique Pools",
            source: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "uniquePools",
            initialRole: "CONFIDENCE_ONLY",
            conceptualGroup: "evidence_confidence",
            direction: "none",
            extractor: ({ bw }) =>
                typeof bw?.uniquePools === "number" && Number.isFinite(bw.uniquePools)
                    ? bw.uniquePools
                    : null,
            reasonIfEligible: "Number of unique Meteora pools traded.",
            reasonIfIneligible:
                "CONFIDENCE_ONLY: Pool diversity sample size; evidence confidence only, not skill.",
        },
        {
            id: "strategy_coverage",
            name: "Strategy Coverage",
            source: "data/discovery/waldisc-2/cohort-distribution.json",
            sourceField: "strategyCoveragePct",
            initialRole: "CONFIDENCE_ONLY",
            conceptualGroup: "evidence_confidence",
            direction: "none",
            extractor: ({ cw }) =>
                typeof cw?.strategyCoveragePct === "number" && Number.isFinite(cw.strategyCoveragePct)
                    ? cw.strategyCoveragePct
                    : null,
            reasonIfEligible: "Percentage of positions successfully decoded by strategy builder.",
            reasonIfIneligible:
                "CONFIDENCE_ONLY: Data pipeline decode coverage; evidence confidence only, not skill.",
        },
        {
            id: "no_liquidity_positions",
            name: "No Liquidity Positions",
            source: "data/discovery/waldisc-2/cohort-distribution.json",
            sourceField: "noLiquidityPositions",
            initialRole: "CONFIDENCE_ONLY",
            conceptualGroup: "evidence_confidence",
            direction: "none",
            extractor: ({ cw }) =>
                typeof cw?.noLiquidityPositions === "number" && Number.isFinite(cw.noLiquidityPositions)
                    ? cw.noLiquidityPositions
                    : null,
            reasonIfEligible: "Count of closed positions that never received liquidity.",
            reasonIfIneligible:
                "CONFIDENCE_ONLY: Valid lifecycle information (coverage context); never negative skill or bad performance.",
        },

        // H. Entry Timing (Unavailable)
        {
            id: "entry_timing_profile",
            name: "Entry Timing",
            source: "none",
            sourceField: "entryTimingProfile",
            initialRole: "UNAVAILABLE",
            conceptualGroup: "timing",
            direction: "none",
            isUnavailable: true,
            extractor: () => null,
            reasonIfEligible: "Entry timing relative to pool creation.",
            reasonIfIneligible:
                "NOT_YET_IMPLEMENTED: Pool-age entry timing metric is not yet implemented.",
        },
    ];

    const auditedSignals: SignalRecord[] = [];

    for (const def of signalDefs) {
        const values: (number | null)[] = [];

        if (def.isUnavailable) {
            for (let i = 0; i < walletCount; i++) {
                values.push(null);
            }
        } else {
            for (const bw of cohortWallets) {
                const mw = masterMap.get(bw.wallet);
                const cw = cohortDistMap.get(bw.wallet);
                values.push(def.extractor({ bw, mw, cw }));
            }
        }

        const audit = computeAuditStats(values, walletCount);

        let finalRole: SignalRole = def.initialRole;
        let isEligible = false;
        let finalReason = def.reasonIfIneligible;

        // Check low variation condition: p25 === p75 within numerical tolerance
        const hasLowVariation =
            audit.nonNullCount > 0 &&
            audit.iqr !== null &&
            Math.abs(audit.iqr) < 1e-6;

        if (
            (def.id === "placement_fraction" ||
                def.id === "true_rebalance_frequency" ||
                (def.candidateForDiscrimination && hasLowVariation)) &&
            def.initialRole !== "CONFIDENCE_ONLY" &&
            def.initialRole !== "UNAVAILABLE"
        ) {
            if (hasLowVariation) {
                finalRole = "DEFERRED_LOW_VARIATION";
                isEligible = false;
                finalReason = `DEFERRED_LOW_VARIATION: Zero interquartile variation (p25 = ${audit.p25}, p75 = ${audit.p75}) in current cohort.`;
            }
        }

        // Determine V1 Skill eligibility
        if (
            finalRole === "SKILL_CANDIDATE" &&
            !def.isUnavailable &&
            audit.nonNullCount > 0 &&
            !hasLowVariation
        ) {
            isEligible = true;
            finalReason = def.reasonIfEligible;
        }

        auditedSignals.push({
            id: def.id,
            name: def.name,
            source: def.source,
            sourceField: def.sourceField,
            role: finalRole,
            conceptualGroup: def.conceptualGroup,
            direction: def.direction,
            eligibleForSkillV1: isEligible,
            normalizationPlan: isEligible ? "cohort_percentile" : null,
            audit,
            reason: finalReason,
        });
    }

    const skillV1Candidates = auditedSignals.filter((s) => s.eligibleForSkillV1);
    const styleSignals = auditedSignals.filter((s) => s.role === "STYLE_BEHAVIOUR");
    const confidenceOnlySignals = auditedSignals.filter((s) => s.role === "CONFIDENCE_ONLY");
    const deferredSignals = auditedSignals.filter((s) => s.role === "DEFERRED_LOW_VARIATION");
    const unavailableSignals = auditedSignals.filter((s) => s.role === "UNAVAILABLE");
    const supportingSignals = auditedSignals.filter((s) => s.role === "SUPPORTING_ONLY");

    const output: SkillSignalDesignOutput = {
        generatedAt: new Date().toISOString(),
        walletCount,
        methodology: {
            purpose: "skill_signal_design_only",
            skillScoreCalculated: false,
            confidenceSeparatedFromSkill: true,
            fabriqTrusted: true,
            normalizationPlan: "cohort_percentile",
        },
        signals: auditedSignals,
        skillV1Candidates,
        styleSignals,
        confidenceOnlySignals,
        deferredSignals,
        unavailableSignals,
        supportingSignals,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 1G.3 — SKILL SIGNAL DESIGN\n");
    console.log(`Wallets Audited : ${walletCount}\n`);

    const colSignal = "Signal".padEnd(31);
    const colRole = "Role".padEnd(24);
    const colAvail = "Availability".padEnd(15);
    const colVar = "Variation".padEnd(12);
    const colSkillV1 = "Skill V1".padEnd(8);

    console.log(`${colSignal}${colRole}${colAvail}${colVar}${colSkillV1}`);
    console.log("-".repeat(88));

    for (const s of auditedSignals) {
        const sigStr = s.name.padEnd(31);
        const roleStr = s.role.padEnd(24);
        const availStr =
            s.audit.nonNullCount > 0
                ? `${s.audit.nonNullCount}/${walletCount} (${s.audit.availabilityPct.toFixed(0)}%)`.padEnd(15)
                : `0/${walletCount} (0%)`.padEnd(15);

        let varStr = "N/A";
        if (s.audit.iqr !== null) {
            const iqrVal = s.audit.iqr;
            if (iqrVal === 0) {
                varStr = "IQR: 0.00";
            } else if (iqrVal < 1) {
                varStr = `IQR: ${iqrVal.toFixed(4)}`;
            } else {
                varStr = `IQR: ${iqrVal.toFixed(2)}`;
            }
        }
        varStr = varStr.padEnd(12);

        const v1Str = s.eligibleForSkillV1 ? "YES" : "NO";
        console.log(`${sigStr}${roleStr}${availStr}${varStr}${v1Str}`);
    }

    console.log("-".repeat(88));
    console.log(`\nSkill V1 Candidates : ${skillV1Candidates.length}`);
    console.log(`Style Signals       : ${styleSignals.length}`);
    console.log(`Confidence Only     : ${confidenceOnlySignals.length}`);
    console.log(`Deferred            : ${deferredSignals.length}`);
    console.log(`Unavailable         : ${unavailableSignals.length}`);
    console.log(`Supporting Only     : ${supportingSignals.length}`);
    console.log(`\nOutput File         : ${outputFile}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Skill signal design failed: ${err.message}`);
    process.exit(1);
});
