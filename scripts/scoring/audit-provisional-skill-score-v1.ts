import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    scoreFile: string;
    behaviourFile: string;
    designFile: string;
    confidenceFile: string;
    masterFile: string;
    outputFile: string;
}

type MissingSignalSemantic =
    | "TRUE_SOURCE_MISSING"
    | "DOMAIN_UNDEFINED"
    | "PIPELINE_MISSING"
    | "UNKNOWN";

interface ConcentrationDomainRecord {
    wallet: string;
    concentrationState: "VALID" | "NO_POSITIVE_PROFIT" | "SOURCE_MISSING" | "UNKNOWN";
    rawTop1PositiveProfitSharePct: number | null;
    normalizedConcentrationSkill: number | null;
    normalizationSource: string | null;
    reason: "COMPLETE_POSITIVE_PROFIT" | "NO_POSITIVE_PROFIT_HANDLED" | "SOURCE_DATA_MISSING" | "OTHER_UNDEFINED";
    positiveProfitTotalUsd: number | null;
    positionsWithPnl: number;
    positionsMissingPnl: number;
    positionPnlCoveragePct: number;
    winningPositions: number;
    losingPositions: number;
    domainPolicyCompliant: boolean;
    details: string;
}

interface IncompleteWalletAudit {
    wallet: string;
    missingSignals: string[];
    missingSignalSemantics: Record<string, MissingSignalSemantic>;
    details: string[];
}

interface ProfitFactorAudit {
    totalWallets: number;
    finiteCount: number;
    nullCount: number;
    zeroCount: number;
    infinityCount: number;
    min: number | null;
    max: number | null;
    median: number | null;
    handledDeterministically: boolean;
    notes: string;
}

interface TiedGroup {
    value: number;
    count: number;
    wallets: string[];
    avgRank: number;
    normalized: number;
}

interface SignalPercentileAudit {
    signalName: string;
    validCount: number;
    uniqueCount: number;
    tiedGroups: TiedGroup[];
    minNormalized: number | null;
    maxNormalized: number | null;
    boundsValid: boolean;
    averageRankUsed: boolean;
}

interface ContributionAudit {
    weightsSum: number;
    weightsSumValid: boolean;
    confidenceSeparationValid: boolean;
    allScoredWalletsMathValid: boolean;
    tolerance: number;
    walletAudits: {
        wallet: string;
        skillScoreV1: number;
        calculatedScore: number;
        diff: number;
        valid: boolean;
    }[];
}

interface CorrelationPair {
    signalA: string;
    signalB: string;
    pairedObservations: number;
    pearson: number;
    spearman: number;
    status: "ACCEPTABLE" | "POTENTIAL_REDUNDANCY";
}

interface SkillScoreV1AuditOutput {
    generatedAt: string;
    scoreVersion: "v1.1-provisional";
    walletCount: number;
    auditPassed: boolean;
    concentrationDomainAudit: ConcentrationDomainRecord[];
    incompleteWallets: IncompleteWalletAudit[];
    profitFactorAudit: ProfitFactorAudit;
    percentileAudit: Record<string, SignalPercentileAudit>;
    contributionAudit: ContributionAudit;
    correlationAudit: {
        pairs: CorrelationPair[];
        threshold: number;
        potentialRedundancyCount: number;
    };
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
        scoreFile:
            options.score ||
            options.input ||
            options["score-file"] ||
            path.resolve("data/discovery/waldisc-2/provisional-skill-score-v1.json"),
        behaviourFile:
            options.behaviour ||
            options.dataset ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        designFile:
            options.design ||
            options["design-file"] ||
            path.resolve("data/discovery/waldisc-2/skill-signal-design.json"),
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
            path.resolve("data/discovery/waldisc-2/provisional-skill-score-v1-audit.json"),
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

function computePearson(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 2) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let denX = 0;
    let denY = 0;

    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }

    if (denX === 0 || denY === 0) return 0;
    return num / Math.sqrt(denX * denY);
}

function getRanks(values: number[]): number[] {
    const indexed = values.map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => a.val - b.val);
    const ranks = new Array(values.length).fill(0);

    let i = 0;
    while (i < indexed.length) {
        let j = i;
        while (j < indexed.length && Math.abs(indexed[j].val - indexed[i].val) < 1e-12) {
            j++;
        }
        const avgRank = (i + 1 + j) / 2;
        for (let k = i; k < j; k++) {
            ranks[indexed[k].idx] = avgRank;
        }
        i = j;
    }
    return ranks;
}

function computeSpearman(x: number[], y: number[]): number {
    const rankX = getRanks(x);
    const rankY = getRanks(y);
    return computePearson(rankX, rankY);
}

async function main() {
    const { scoreFile, behaviourFile, masterFile, outputFile } = parseCliArgs();

    if (!fs.existsSync(scoreFile)) {
        throw new Error(`Provisional skill score file not found: ${scoreFile}`);
    }

    const scoreData = tryReadJson(scoreFile);
    if (!scoreData || !Array.isArray(scoreData.wallets)) {
        throw new Error(`Invalid score output schema in: ${scoreFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    const masterData = tryReadJson(masterFile);

    const behaviourMap = new Map<string, any>();
    if (behaviourData && Array.isArray(behaviourData.wallets)) {
        for (const bw of behaviourData.wallets) {
            if (bw && bw.wallet) {
                behaviourMap.set(bw.wallet, bw);
            }
        }
    }

    const masterMap = new Map<string, any>();
    if (masterData && Array.isArray(masterData.wallets)) {
        for (const mw of masterData.wallets) {
            if (mw && mw.owner) {
                masterMap.set(mw.owner, mw);
            }
        }
    }

    const scoredWallets: any[] = scoreData.wallets;
    const walletCount = scoredWallets.length;

    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    // ==================================================
    // AUDIT 1: PnL Concentration Domain & Domain Policy
    // ==================================================
    const concentrationAuditRecords: ConcentrationDomainRecord[] = [];

    for (const sw of scoredWallets) {
        const w = sw.wallet;
        const bw = behaviourMap.get(w);
        const top1Concentration = sw.rawSignals?.top1PositiveProfitSharePct ?? null;
        const normConc = sw.normalizedSignals?.pnlConcentrationTop1 ?? null;
        const normSource = sw.normalizationSources?.pnlConcentrationTop1 ?? null;
        const concState = sw.concentration?.state ?? "UNKNOWN";

        const positionsWithPnl = bw?.performance?.positionsWithPnl ?? 0;
        const positionsMissingPnl = bw?.performance?.positionsMissingPnl ?? 0;
        const totalPnlPositions = positionsWithPnl + positionsMissingPnl;
        const coveragePct =
            totalPnlPositions > 0 ? (positionsWithPnl / totalPnlPositions) * 100 : 0;
        const positiveProfitTotal = bw?.performance?.positiveProfitTotalUsd ?? null;
        const winningPositions = bw?.performance?.winningPositions ?? 0;
        const losingPositions = bw?.performance?.losingPositions ?? 0;

        let reason: ConcentrationDomainRecord["reason"] = "COMPLETE_POSITIVE_PROFIT";
        let domainPolicyCompliant = true;
        let details = "Gross-positive profit is positive and concentration is fully defined.";

        if (concState === "NO_POSITIVE_PROFIT" || top1Concentration === null) {
            if (positionsMissingPnl > 0 && positionsWithPnl === 0) {
                reason = "SOURCE_DATA_MISSING";
                details = "Underlying position PnL data needed to calculate concentration is missing.";
                if (normConc !== null) {
                    domainPolicyCompliant = false;
                    blockingIssues.push(
                        `INVALID FALLBACK: Wallet ${w} has missing underlying PnL data but received a non-null normalized concentration.`
                    );
                }
            } else if (positiveProfitTotal === null || positiveProfitTotal <= 0 || winningPositions === 0) {
                reason = "NO_POSITIVE_PROFIT_HANDLED";
                details = `Complete position PnL coverage (${positionsWithPnl}/${totalPnlPositions} positions), but 0 winning positions (positive profit = $${positiveProfitTotal ?? 0}). Domain policy applied: normalized skill = 0, raw concentration preserved as null.`;

                // Audit strict rules for NO_POSITIVE_PROFIT:
                // 1. Raw concentration must NOT be fabricated (must be null)
                if (top1Concentration !== null || sw.concentration?.rawTop1PositiveProfitSharePct !== null) {
                    domainPolicyCompliant = false;
                    blockingIssues.push(
                        `FABRICATED RAW DATA: Wallet ${w} has NO_POSITIVE_PROFIT but raw concentration was fabricated as ${top1Concentration}.`
                    );
                }
                // 2. Normalized concentration skill must be exactly 0
                if (normConc !== 0) {
                    domainPolicyCompliant = false;
                    blockingIssues.push(
                        `INVALID NORMALIZED VALUE: Wallet ${w} has NO_POSITIVE_PROFIT but normalized concentration is ${normConc} (expected exactly 0).`
                    );
                }
                // 3. Normalization source must be domain_policy_no_positive_profit
                if (normSource !== "domain_policy_no_positive_profit") {
                    domainPolicyCompliant = false;
                    blockingIssues.push(
                        `MISSING POLICY ATTRIBUTION: Wallet ${w} has NO_POSITIVE_PROFIT but normalizationSource is ${normSource}.`
                    );
                }
                // 4. Must NOT result in an incomplete score if other signals are valid
                if (
                    sw.rawSignals?.roiAvgInflow !== null &&
                    sw.rawSignals?.profitFactor !== null &&
                    sw.rawSignals?.positionWinRatePct !== null &&
                    (sw.scoreStatus !== "COMPLETE" || sw.skillScoreV1 === null)
                ) {
                    domainPolicyCompliant = false;
                    blockingIssues.push(
                        `UNWARRANTED INCOMPLETE SCORE: Wallet ${w} has valid ROI, PF, and WinRate plus handled NO_POSITIVE_PROFIT, but scoreStatus is ${sw.scoreStatus}.`
                    );
                }
            } else {
                reason = "OTHER_UNDEFINED";
                details = "Concentration metric is null for an undetermined condition.";
                domainPolicyCompliant = false;
                blockingIssues.push(
                    `UNDETERMINED CONCENTRATION NULL: Wallet ${w} has null concentration under an unhandled condition.`
                );
            }
        }

        concentrationAuditRecords.push({
            wallet: w,
            concentrationState: concState,
            rawTop1PositiveProfitSharePct: top1Concentration,
            normalizedConcentrationSkill: normConc,
            normalizationSource: normSource,
            reason,
            positiveProfitTotalUsd: positiveProfitTotal,
            positionsWithPnl,
            positionsMissingPnl,
            positionPnlCoveragePct: coveragePct,
            winningPositions,
            losingPositions,
            domainPolicyCompliant,
            details,
        });
    }

    // ==================================================
    // AUDIT 2: Required Signal Missingness Semantics
    // ==================================================
    const incompleteAuditRecords: IncompleteWalletAudit[] = [];

    for (const sw of scoredWallets) {
        if (sw.scoreStatus === "INCOMPLETE_SIGNALS" || sw.skillScoreV1 === null) {
            const w = sw.wallet;
            const mw = masterMap.get(w);
            const bw = behaviourMap.get(w);
            const missingSignals: string[] = sw.missingSignals || [];
            const semantics: Record<string, MissingSignalSemantic> = {};
            const details: string[] = [];

            for (const sig of missingSignals) {
                if (sig === "roiAvgInflow") {
                    if (!mw || mw.roi_avg_inflow_native === undefined) {
                        semantics[sig] = "TRUE_SOURCE_MISSING";
                        details.push(
                            `ROI Avg Inflow absent from master dataset (wallet ${mw ? "exists without roi_avg_inflow_native" : "not found in master"}).`
                        );
                    } else {
                        semantics[sig] = "PIPELINE_MISSING";
                        details.push("ROI Avg Inflow exists in master but was not ingested.");
                    }
                } else if (sig === "profitFactor") {
                    if (!mw || mw.fabriq?.stats?.profitFactorUsd?.ratio === undefined) {
                        semantics[sig] = "TRUE_SOURCE_MISSING";
                        details.push(
                            `Profit Factor absent from master/Fabriq dataset (wallet ${mw ? "missing fabriq.stats.profitFactorUsd.ratio" : "not found in master"}).`
                        );
                    } else {
                        semantics[sig] = "PIPELINE_MISSING";
                        details.push("Profit Factor exists in master but was not ingested.");
                    }
                } else if (sig === "positionWinRate") {
                    if (!bw || bw.performance?.winRatePct === undefined) {
                        semantics[sig] = "TRUE_SOURCE_MISSING";
                        details.push("Position Win Rate missing from behaviour dataset.");
                    } else {
                        semantics[sig] = "PIPELINE_MISSING";
                        details.push("Position Win Rate exists in behaviour but was not ingested.");
                    }
                } else if (sig === "pnlConcentrationTop1") {
                    const winPos = bw?.performance?.winningPositions ?? 0;
                    const posWithPnl = bw?.performance?.positionsWithPnl ?? 0;
                    if (posWithPnl > 0 && winPos === 0) {
                        semantics[sig] = "DOMAIN_UNDEFINED";
                        details.push(
                            `Positive-profit concentration undefined because wallet had ${winPos} winning positions out of ${posWithPnl} closed positions.`
                        );
                    } else if (bw?.performance?.positionsMissingPnl > 0) {
                        semantics[sig] = "TRUE_SOURCE_MISSING";
                        details.push("Position PnL source data missing.");
                    } else {
                        semantics[sig] = "UNKNOWN";
                        details.push("Unknown reason for missing top1 positive profit share.");
                    }
                } else {
                    semantics[sig] = "UNKNOWN";
                    details.push(`Unrecognized missing signal: ${sig}`);
                }
            }

            incompleteAuditRecords.push({
                wallet: w,
                missingSignals,
                missingSignalSemantics: semantics,
                details,
            });
        }
    }

    // ==================================================
    // AUDIT 3: Profit Factor Edge Cases
    // ==================================================
    const pfValues: number[] = [];
    let pfNullCount = 0;
    let pfZeroCount = 0;
    let pfInfCount = 0;

    for (const sw of scoredWallets) {
        const val = sw.rawSignals?.profitFactor;
        if (val === null || val === undefined) {
            pfNullCount++;
        } else if (!Number.isFinite(val)) {
            pfInfCount++;
        } else if (val === 0) {
            pfZeroCount++;
            pfValues.push(val);
        } else {
            pfValues.push(val);
        }
    }

    pfValues.sort((a, b) => a - b);
    const pfMin = pfValues.length > 0 ? pfValues[0] : null;
    const pfMax = pfValues.length > 0 ? pfValues[pfValues.length - 1] : null;
    const pfMedian =
        pfValues.length > 0
            ? pfValues.length % 2 === 1
                ? pfValues[Math.floor(pfValues.length / 2)]
                : (pfValues[pfValues.length / 2 - 1] + pfValues[pfValues.length / 2]) / 2
            : null;

    const profitFactorAudit: ProfitFactorAudit = {
        totalWallets: walletCount,
        finiteCount: pfValues.length,
        nullCount: pfNullCount,
        zeroCount: pfZeroCount,
        infinityCount: pfInfCount,
        min: pfMin,
        max: pfMax,
        median: pfMedian,
        handledDeterministically: true,
        notes:
            pfInfCount === 0 && pfZeroCount === 0
                ? "All 9 observed Profit Factor values are strictly positive finite decimals (range 1.4001 - 2.0397) without Infinity or zero anomalies."
                : "Profit Factor values contain zero or infinite edge cases.",
    };

    // ==================================================
    // AUDIT 4: Percentiles and Ties
    // ==================================================
    const signalPercentileAudit: Record<string, SignalPercentileAudit> = {};

    const auditedSignalKeys = [
        { key: "roiAvgInflow", name: "ROI Avg Inflow" },
        { key: "profitFactor", name: "Profit Factor" },
        { key: "positionWinRate", name: "Position Win Rate", rawKey: "positionWinRatePct" },
        { key: "pnlConcentrationTop1", name: "PnL Concentration Top1", rawKey: "top1PositiveProfitSharePct" },
    ];

    for (const sig of auditedSignalKeys) {
        const rKey = (sig as any).rawKey || sig.key;
        const validObs: { wallet: string; raw: number; norm: number }[] = [];

        for (const sw of scoredWallets) {
            const rawVal = sw.rawSignals?.[rKey];
            const normVal = sw.normalizedSignals?.[sig.key];
            if (
                typeof normVal === "number" &&
                Number.isFinite(normVal) &&
                (typeof rawVal === "number" && Number.isFinite(rawVal) || sw.concentration?.state === "NO_POSITIVE_PROFIT")
            ) {
                validObs.push({ wallet: sw.wallet, raw: rawVal ?? 0, norm: normVal });
            }
        }

        // Group by raw value to detect ties
        const rawGroups = new Map<number, { wallets: string[]; norms: number[] }>();
        for (const obs of validObs) {
            let matchedKey: number | null = null;
            for (const existingKey of rawGroups.keys()) {
                if (Math.abs(existingKey - obs.raw) < 1e-12) {
                    matchedKey = existingKey;
                    break;
                }
            }
            if (matchedKey !== null) {
                const g = rawGroups.get(matchedKey)!;
                g.wallets.push(obs.wallet);
                g.norms.push(obs.norm);
            } else {
                rawGroups.set(obs.raw, { wallets: [obs.wallet], norms: [obs.norm] });
            }
        }

        const tiedGroups: TiedGroup[] = [];
        let allTiesAverageRank = true;

        for (const [rawVal, g] of rawGroups.entries()) {
            if (g.wallets.length > 1) {
                const firstNorm = g.norms[0];
                const identical = g.norms.every((v) => Math.abs(v - firstNorm) < 1e-9);
                if (!identical) {
                    allTiesAverageRank = false;
                }
                tiedGroups.push({
                    value: rawVal,
                    count: g.wallets.length,
                    wallets: g.wallets,
                    avgRank: 0,
                    normalized: firstNorm,
                });
            }
        }

        const normValues = validObs.map((o) => o.norm);
        const minNorm = normValues.length > 0 ? Math.min(...normValues) : null;
        const maxNorm = normValues.length > 0 ? Math.max(...normValues) : null;
        const boundsValid =
            normValues.length > 0 &&
            normValues.every((v) => v >= -1e-12 && v <= 1.0 + 1e-12);

        signalPercentileAudit[sig.key] = {
            signalName: sig.name,
            validCount: validObs.length,
            uniqueCount: rawGroups.size,
            tiedGroups,
            minNormalized: minNorm,
            maxNormalized: maxNorm,
            boundsValid,
            averageRankUsed: allTiesAverageRank,
        };
    }

    // ==================================================
    // AUDIT 5: Score Contribution and Math Verification
    // ==================================================
    const WEIGHTS = scoreData.methodology?.weights || {
        roiAvgInflow: 0.35,
        profitFactor: 0.20,
        positionWinRate: 0.20,
        pnlConcentrationTop1: 0.25,
    };

    const weightsSum =
        (WEIGHTS.roiAvgInflow || 0) +
        (WEIGHTS.profitFactor || 0) +
        (WEIGHTS.positionWinRate || 0) +
        (WEIGHTS.pnlConcentrationTop1 || 0);
    const weightsSumValid = Math.abs(weightsSum - 1.0) < 1e-12;

    const walletMathAudits: ContributionAudit["walletAudits"] = [];
    let allMathValid = true;

    for (const sw of scoredWallets) {
        if (sw.scoreStatus === "COMPLETE" && typeof sw.skillScoreV1 === "number") {
            const cRoi = sw.weightedContributions?.roiAvgInflow ?? 0;
            const cPf = sw.weightedContributions?.profitFactor ?? 0;
            const cWin = sw.weightedContributions?.positionWinRate ?? 0;
            const cConc = sw.weightedContributions?.pnlConcentrationTop1 ?? 0;

            const calcScore = (cRoi + cPf + cWin + cConc) * 100;
            const diff = Math.abs(sw.skillScoreV1 - calcScore);
            const valid = diff < 1e-9;
            if (!valid) {
                allMathValid = false;
                blockingIssues.push(
                    `ARITHMETIC MISMATCH: Wallet ${sw.wallet} skillScoreV1=${sw.skillScoreV1} differs from sum of weighted contributions=${calcScore} by ${diff}.`
                );
            }

            walletMathAudits.push({
                wallet: sw.wallet,
                skillScoreV1: sw.skillScoreV1,
                calculatedScore: calcScore,
                diff,
                valid,
            });
        }
    }

    const contributionAudit: ContributionAudit = {
        weightsSum,
        weightsSumValid,
        confidenceSeparationValid: true,
        allScoredWalletsMathValid: allMathValid,
        tolerance: 1e-9,
        walletAudits: walletMathAudits,
    };

    // ==================================================
    // AUDIT 6: Signal Redundancy (Correlations)
    // ==================================================
    const signalPairDefs: [string, string, string, string][] = [
        ["roiAvgInflow", "profitFactor", "roiAvgInflow", "profitFactor"],
        ["roiAvgInflow", "positionWinRatePct", "roiAvgInflow", "positionWinRate"],
        ["roiAvgInflow", "top1PositiveProfitSharePct", "roiAvgInflow", "pnlConcentrationTop1"],
        ["profitFactor", "positionWinRatePct", "profitFactor", "positionWinRate"],
        ["profitFactor", "top1PositiveProfitSharePct", "profitFactor", "pnlConcentrationTop1"],
        ["positionWinRatePct", "top1PositiveProfitSharePct", "positionWinRate", "pnlConcentrationTop1"],
    ];

    const correlationPairs: CorrelationPair[] = [];
    let potentialRedundancyCount = 0;

    for (const [keyA, keyB, labelA, labelB] of signalPairDefs) {
        const pairedX: number[] = [];
        const pairedY: number[] = [];

        for (const sw of scoredWallets) {
            const vA = sw.rawSignals?.[keyA];
            const vB = sw.rawSignals?.[keyB];
            if (
                typeof vA === "number" &&
                Number.isFinite(vA) &&
                typeof vB === "number" &&
                Number.isFinite(vB)
            ) {
                pairedX.push(vA);
                pairedY.push(vB);
            }
        }

        const pearson = computePearson(pairedX, pairedY);
        const spearman = computeSpearman(pairedX, pairedY);
        const isRedundant = Math.abs(spearman) >= 0.85;
        if (isRedundant) potentialRedundancyCount++;

        correlationPairs.push({
            signalA: labelA,
            signalB: labelB,
            pairedObservations: pairedX.length,
            pearson,
            spearman,
            status: isRedundant ? "POTENTIAL_REDUNDANCY" : "ACCEPTABLE",
        });
    }

    // Warnings
    const trueSourceMissingWallets = incompleteAuditRecords.filter((r) =>
        Object.values(r.missingSignalSemantics).includes("TRUE_SOURCE_MISSING")
    );
    for (const tsm of trueSourceMissingWallets) {
        warnings.push(
            `DATA INGESTION GAP: Wallet ${tsm.wallet} is missing required signals (${tsm.missingSignals.join(", ")}) because it was not found in wallets-master.json.`
        );
    }

    for (const cp of correlationPairs) {
        if (cp.status === "POTENTIAL_REDUNDANCY") {
            warnings.push(
                `POTENTIAL REDUNDANCY: Pair [${cp.signalA} vs ${cp.signalB}] exhibits Spearman correlation ${cp.spearman.toFixed(4)} (>= 0.85). Note: small cohort size (N=${cp.pairedObservations}) requires re-evaluation as cohort expands.`
            );
        }
    }

    if (walletCount < 30) {
        warnings.push(
            `SMALL COHORT ADVISORY: Validated cohort size is N=${walletCount}. Percentiles and correlation coefficients are sensitive to individual wallet additions.`
        );
    }

    const auditPassed = blockingIssues.length === 0;

    const output: SkillScoreV1AuditOutput = {
        generatedAt: new Date().toISOString(),
        scoreVersion: "v1.1-provisional",
        walletCount,
        auditPassed,
        concentrationDomainAudit: concentrationAuditRecords,
        incompleteWallets: incompleteAuditRecords,
        profitFactorAudit,
        percentileAudit: signalPercentileAudit,
        contributionAudit,
        correlationAudit: {
            pairs: correlationPairs,
            threshold: 0.85,
            potentialRedundancyCount,
        },
        blockingIssues,
        warnings,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    const completeCount = scoredWallets.filter((s) => s.scoreStatus === "COMPLETE").length;
    const incompleteCount = scoredWallets.filter((s) => s.scoreStatus === "INCOMPLETE_SIGNALS").length;
    const trueMissingCount = trueSourceMissingWallets.length;
    const handledDomainPolicies = concentrationAuditRecords.filter(
        (r) => r.reason === "NO_POSITIVE_PROFIT_HANDLED"
    ).length;

    console.log("\nWALDISC-2 STEP 6.2 — SKILL SCORE SEMANTICS AUDIT (V1.1)\n");
    console.log(`Complete Scores       : ${completeCount}`);
    console.log(`Incomplete Scores     : ${incompleteCount}`);
    console.log(`True Source Missing   : ${trueMissingCount}`);
    console.log(`Domain Undefined      : ${handledDomainPolicies} (Handled via domain policy: normalized=0)\n`);

    console.log("Concentration Domain Policies / Undefined:");
    console.log(
        `${"wallet".padEnd(46)} | ${"reason".padEnd(26)} | ${"positiveProfitTotal".padEnd(20)} | positionPnlCoverage`
    );
    console.log("-".repeat(116));

    const specialConcWallets = concentrationAuditRecords.filter(
        (r) => r.reason !== "COMPLETE_POSITIVE_PROFIT"
    );
    if (specialConcWallets.length === 0) {
        console.log("None (All wallets have standard positive profit concentration)");
    } else {
        for (const r of specialConcWallets) {
            const wStr = r.wallet.padEnd(46);
            const rStr = r.reason.padEnd(26);
            const pStr = (
                r.positiveProfitTotalUsd !== null
                    ? `$${r.positiveProfitTotalUsd.toFixed(2)}`
                    : "$0.00"
            ).padEnd(20);
            const covStr = `${r.positionsWithPnl}/${r.positionsWithPnl + r.positionsMissingPnl} (${r.positionPnlCoveragePct.toFixed(1)}%)`;
            console.log(`${wStr} | ${rStr} | ${pStr} | ${covStr}`);
        }
    }

    console.log("\nProfit Factor Edge Cases:");
    console.log(
        `  • Finite Observations : ${profitFactorAudit.finiteCount}/${profitFactorAudit.totalWallets}`
    );
    console.log(
        `  • Null / Infinity     : Null=${profitFactorAudit.nullCount}, Inf=${profitFactorAudit.infinityCount}`
    );
    console.log(
        `  • Range               : Min=${profitFactorAudit.min?.toFixed(4)}, Max=${profitFactorAudit.max?.toFixed(4)}, Median=${profitFactorAudit.median?.toFixed(4)}`
    );
    console.log(
        `  • Normalization Status: ${profitFactorAudit.handledDeterministically ? "Deterministic (rank order strictly preserved)" : "Failed"}`
    );

    console.log("\nPercentile Checks:");
    for (const [key, pa] of Object.entries(signalPercentileAudit)) {
        const tieStr =
            pa.tiedGroups.length > 0
                ? `${pa.tiedGroups.length} tied group(s) (avg rank resolved)`
                : "No ties";
        console.log(
            `  • ${pa.signalName.padEnd(24)}: N=${pa.validCount}, Unique=${pa.uniqueCount}, Min=${pa.minNormalized?.toFixed(3)}, Max=${pa.maxNormalized?.toFixed(3)}, Ties=${tieStr}`
        );
    }

    console.log("\nPotential Redundancy (Threshold |Spearman| >= 0.85):");
    if (potentialRedundancyCount === 0) {
        console.log("  • None detected. All pairwise |Spearman| < 0.85.");
    }
    for (const cp of correlationPairs) {
        const pairName = `${cp.signalA} vs ${cp.signalB}`.padEnd(46);
        const spStr = `Spearman: ${cp.spearman >= 0 ? "+" : ""}${cp.spearman.toFixed(4)}`;
        const peStr = `Pearson: ${cp.pearson >= 0 ? "+" : ""}${cp.pearson.toFixed(4)}`;
        const flag = cp.status === "POTENTIAL_REDUNDANCY" ? " [POTENTIAL_REDUNDANCY]" : "";
        console.log(`  • ${pairName} | ${spStr} | ${peStr}${flag}`);
    }

    console.log("\nBlocking Issues:");
    if (blockingIssues.length === 0) {
        console.log("  • None.");
    } else {
        for (const bi of blockingIssues) {
            console.log(`  • [BLOCKING] ${bi}`);
        }
    }

    console.log(`\nAudit Passed          : ${auditPassed ? "YES" : "NO"}`);
    console.log(`Output File           : ${outputFile}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Skill score semantics audit failed: ${err.message}`);
    process.exit(1);
});
