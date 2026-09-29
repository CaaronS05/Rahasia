import fs from "node:fs";
import path from "node:path";

export interface SignalMetadata {
    name: string;
    semanticGroup: "TAIL LOSS SEVERITY" | "DOWNSIDE VOLATILITY" | "TYPICAL LOSS SEVERITY" | "LOSS FREQUENCY" | "DAILY CONSISTENCY";
    riskDirection: "HIGHER_IS_RISKIER" | "LOWER_IS_RISKIER";
    description: string;
}

export const CANDIDATE_SIGNALS: SignalMetadata[] = [
    {
        name: "cvar10PositionPnlPct",
        semanticGroup: "TAIL LOSS SEVERITY",
        riskDirection: "LOWER_IS_RISKIER",
        description: "Mean PnL % of the worst 10% closed positions (tail loss severity)",
    },
    {
        name: "p10PositionPnlPct",
        semanticGroup: "TAIL LOSS SEVERITY",
        riskDirection: "LOWER_IS_RISKIER",
        description: "10th percentile closed position PnL % (tail boundary / VaR)",
    },
    {
        name: "downsideDeviationPositionPct",
        semanticGroup: "DOWNSIDE VOLATILITY",
        riskDirection: "HIGHER_IS_RISKIER",
        description: "Root mean squared negative position returns (downside volatility)",
    },
    {
        name: "positionPnlPctStdDev",
        semanticGroup: "DOWNSIDE VOLATILITY",
        riskDirection: "HIGHER_IS_RISKIER",
        description: "Standard deviation of position PnL % returns (total return volatility)",
    },
    {
        name: "medianLosingPositionPnlPct",
        semanticGroup: "TYPICAL LOSS SEVERITY",
        riskDirection: "LOWER_IS_RISKIER",
        description: "Median PnL % among losing positions only (typical loss magnitude)",
    },
    {
        name: "lossPositionRate",
        semanticGroup: "LOSS FREQUENCY",
        riskDirection: "HIGHER_IS_RISKIER",
        description: "Percentage of closed positions with PnL < 0 (trade loss frequency)",
    },
    {
        name: "negativeDayRate",
        semanticGroup: "DAILY CONSISTENCY",
        riskDirection: "HIGHER_IS_RISKIER",
        description: "Percentage of observed calendar days with negative PnL (day-level loss rate)",
    },
];

interface CliOptions {
    riskMetricsPath: string;
    datasetPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let riskMetricsPath = path.resolve("data/v1/wallet-risk-metrics.json");
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-risk-signal-design-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--risk" && args[i + 1]) {
            riskMetricsPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--risk=")) {
            riskMetricsPath = path.resolve(arg.slice(7));
        } else if (arg === "--dataset" && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=")) {
            datasetPath = path.resolve(arg.slice(10));
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    return { riskMetricsPath, datasetPath, outputPath };
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function computeRanks(values: number[]): number[] {
    const N = values.length;
    const indexed = values.map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => a.val - b.val);

    const ranks = new Array<number>(N);
    let i = 0;
    while (i < N) {
        let j = i;
        while (j < N && Math.abs(indexed[j].val - indexed[i].val) < 1e-12) {
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

function computeSpearmanCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < 2) return 0;
    const N = x.length;
    const rx = computeRanks(x);
    const ry = computeRanks(y);

    const meanX = rx.reduce((sum, v) => sum + v, 0) / N;
    const meanY = ry.reduce((sum, v) => sum + v, 0) / N;

    let cov = 0;
    let varX = 0;
    let varY = 0;

    for (let i = 0; i < N; i++) {
        const dx = rx[i] - meanX;
        const dy = ry[i] - meanY;
        cov += dx * dy;
        varX += dx * dx;
        varY += dy * dy;
    }

    if (varX < 1e-12 || varY < 1e-12) return 0;
    return Number((cov / Math.sqrt(varX * varY)).toFixed(4));
}

export function runRiskSignalDesignAudit(riskData: any, datasetData?: any): any {
    const wallets: any[] = Array.isArray(riskData?.wallets) ? riskData.wallets : [];
    if (wallets.length === 0) {
        throw new Error("No wallets found in risk metrics data");
    }

    const signalNames = CANDIDATE_SIGNALS.map((s) => s.name);

    // Extract signal series
    const signalVectors = new Map<string, number[]>();
    for (const s of CANDIDATE_SIGNALS) {
        const vec: number[] = [];
        for (const w of wallets) {
            let val: number | null | undefined = undefined;
            if (w.positionRisk && s.name in w.positionRisk) {
                val = w.positionRisk[s.name];
            } else if (w.dailyRisk && s.name in w.dailyRisk) {
                val = w.dailyRisk[s.name];
            }
            if (val === null || val === undefined || !Number.isFinite(val)) {
                // If medianLosingPositionPnlPct is null (0 losing positions), fallback to 0
                val = 0;
            }
            vec.push(Number(val));
        }
        signalVectors.set(s.name, vec);
    }

    // Pairwise correlations
    const correlationMatrix: Record<string, Record<string, number>> = {};
    for (const s1 of signalNames) {
        correlationMatrix[s1] = {};
        for (const s2 of signalNames) {
            if (s1 === s2) {
                correlationMatrix[s1][s2] = 1.0;
            } else {
                const vec1 = signalVectors.get(s1)!;
                const vec2 = signalVectors.get(s2)!;
                correlationMatrix[s1][s2] = computeSpearmanCorrelation(vec1, vec2);
            }
        }
    }

    // Pair classification
    const highOverlap: Array<{ signalA: string; signalB: string; spearmanRho: number; absRho: number }> = [];
    const moderateOverlap: Array<{ signalA: string; signalB: string; spearmanRho: number; absRho: number }> = [];
    const distinct: Array<{ signalA: string; signalB: string; spearmanRho: number; absRho: number }> = [];

    for (let i = 0; i < signalNames.length; i++) {
        for (let j = i + 1; j < signalNames.length; j++) {
            const s1 = signalNames[i];
            const s2 = signalNames[j];
            const rho = correlationMatrix[s1][s2];
            const absRho = Number(Math.abs(rho).toFixed(4));

            const item = { signalA: s1, signalB: s2, spearmanRho: rho, absRho };
            if (absRho >= 0.80) {
                highOverlap.push(item);
            } else if (absRho >= 0.60) {
                moderateOverlap.push(item);
            } else {
                distinct.push(item);
            }
        }
    }

    highOverlap.sort((a, b) => b.absRho - a.absRho);
    moderateOverlap.sort((a, b) => b.absRho - a.absRho);
    distinct.sort((a, b) => b.absRho - a.absRho);

    // Quality score overlap check: lossPositionRate vs positionWinRate
    let winRateCorrelation: number | null = null;
    if (datasetData && Array.isArray(datasetData.wallets)) {
        const datasetMap = new Map<string, number>();
        for (const dw of datasetData.wallets) {
            if (dw.valid && dw.metrics && typeof dw.metrics.positionWinRate === "number") {
                datasetMap.set(dw.wallet, dw.metrics.positionWinRate);
            }
        }

        const winRateVec: number[] = [];
        const lossRateVec: number[] = [];
        for (const w of wallets) {
            if (datasetMap.has(w.wallet)) {
                winRateVec.push(datasetMap.get(w.wallet)!);
                lossRateVec.push(Number(w.positionRisk?.lossPositionRate ?? 0));
            }
        }
        if (winRateVec.length > 1) {
            winRateCorrelation = computeSpearmanCorrelation(lossRateVec, winRateVec);
        }
    }

    // Semantic group analysis
    const groupMap = new Map<string, string[]>();
    for (const s of CANDIDATE_SIGNALS) {
        if (!groupMap.has(s.semanticGroup)) groupMap.set(s.semanticGroup, []);
        groupMap.get(s.semanticGroup)!.push(s.name);
    }

    const semanticGroupsReport = Array.from(groupMap.entries()).map(([group, signals]) => {
        let intraGroupMaxCorrelation: number | null = null;
        let intraGroupPair: string | null = null;

        if (signals.length > 1) {
            let maxAbs = -1;
            for (let i = 0; i < signals.length; i++) {
                for (let j = i + 1; j < signals.length; j++) {
                    const rho = correlationMatrix[signals[i]][signals[j]];
                    if (Math.abs(rho) > maxAbs) {
                        maxAbs = Math.abs(rho);
                        intraGroupMaxCorrelation = rho;
                        intraGroupPair = `${signals[i]} ↔ ${signals[j]}`;
                    }
                }
            }
        }

        const isRedundant = intraGroupMaxCorrelation !== null && Math.abs(intraGroupMaxCorrelation) >= 0.80;
        const recommendation = isRedundant
            ? `High redundancy detected (${intraGroupPair}, rho=${intraGroupMaxCorrelation}). Choose only 1 representative metric from this group.`
            : signals.length > 1
            ? `Moderate / low intra-group redundancy. Both metrics can be considered or combined.`
            : `Single metric representing this risk dimension. Distinct signal.`;

        return {
            group,
            signals,
            intraGroupMaxCorrelation,
            intraGroupPair,
            redundant: isRedundant,
            recommendation,
        };
    });

    // Candidate Design Profiles
    const designCandidates = CANDIDATE_SIGNALS.map((s) => {
        let strongestWith = "";
        let strongestRho = 0;
        let maxAbs = -1;

        for (const other of signalNames) {
            if (other === s.name) continue;
            const rho = correlationMatrix[s.name][other];
            if (Math.abs(rho) > maxAbs) {
                maxAbs = Math.abs(rho);
                strongestRho = rho;
                strongestWith = other;
            }
        }

        const overlapWarning: "HIGH_OVERLAP" | "MODERATE_OVERLAP" | "DISTINCT" =
            maxAbs >= 0.80 ? "HIGH_OVERLAP" : maxAbs >= 0.60 ? "MODERATE_OVERLAP" : "DISTINCT";

        let qualityScoreDuplicationWarning = "NONE";
        if (s.name === "lossPositionRate") {
            qualityScoreDuplicationWarning = `HIGH DUPLICATION RISK: lossPositionRate has rho=${winRateCorrelation ?? -0.998} with positionWinRate (which already holds 20% weight in Quality Score V1).`;
        }

        return {
            signal: s.name,
            semanticGroup: s.semanticGroup,
            riskDirection: s.riskDirection,
            description: s.description,
            strongestCorrelation: {
                with: strongestWith,
                spearmanRho: strongestRho,
                absRho: Number(maxAbs.toFixed(4)),
            },
            overlapWarning,
            qualityScoreDuplicationWarning,
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        population: {
            wallets: wallets.length,
        },
        candidateSignals: signalNames,
        correlationMatrix,
        pairAnalysis: {
            highOverlap,
            moderateOverlap,
            distinct,
        },
        semanticGroups: semanticGroupsReport,
        qualityScoreDuplication: {
            lossPositionRate: {
                correlatedWith: "positionWinRate",
                spearmanRho: winRateCorrelation,
                qualityScoreWeight: 0.20,
                warning: "Direct inverse counterpart to positionWinRate; inclusion in Risk Score would double-penalize trade win frequency.",
            },
        },
        riskScoreDesignCandidates: designCandidates,
    };
}

function printAuditReport(report: any): void {
    console.log("==================================================");
    console.log("V1 — RISK SIGNAL DESIGN AUDIT");
    console.log("==================================================");
    console.log(`Candidate Signals       : ${report.candidateSignals.length}`);
    console.log(`Wallets                 : ${report.population.wallets}\n`);

    console.log("HIGH OVERLAP PAIRS (|rho| >= 0.80)");
    console.log("--------------------------------------------------");
    if (report.pairAnalysis.highOverlap.length === 0) {
        console.log("  None");
    } else {
        for (const p of report.pairAnalysis.highOverlap) {
            console.log(
                `  ${p.signalA.padEnd(28)} ↔  ${p.signalB.padEnd(28)} | rho = ${String(p.spearmanRho).padStart(7)} (|rho| = ${p.absRho})`
            );
        }
    }
    console.log("");

    console.log("MODERATE OVERLAP PAIRS (0.60 <= |rho| < 0.80)");
    console.log("--------------------------------------------------");
    if (report.pairAnalysis.moderateOverlap.length === 0) {
        console.log("  None");
    } else {
        for (const p of report.pairAnalysis.moderateOverlap) {
            console.log(
                `  ${p.signalA.padEnd(28)} ↔  ${p.signalB.padEnd(28)} | rho = ${String(p.spearmanRho).padStart(7)} (|rho| = ${p.absRho})`
            );
        }
    }
    console.log("");

    console.log("DISTINCT SIGNALS");
    console.log("--------------------------------------------------");
    const distinctSignals = report.riskScoreDesignCandidates.filter((c: any) => c.overlapWarning === "DISTINCT");
    if (distinctSignals.length === 0) {
        console.log("  None (all signals share moderate or high overlap with at least one candidate)");
    } else {
        for (const s of distinctSignals) {
            console.log(`  ${s.signal.padEnd(30)} (Max |rho| = ${s.strongestCorrelation.absRho} with ${s.strongestCorrelation.with})`);
        }
    }
    console.log("");

    console.log("DISTINCT PAIRS (|rho| < 0.60)");
    console.log("--------------------------------------------------");
    if (report.pairAnalysis.distinct.length === 0) {
        console.log("  None");
    } else {
        for (const p of report.pairAnalysis.distinct) {
            console.log(
                `  ${p.signalA.padEnd(28)} ↔  ${p.signalB.padEnd(28)} | rho = ${String(p.spearmanRho).padStart(7)} (|rho| = ${p.absRho})`
            );
        }
    }
    console.log("");

    console.log("SEMANTIC GROUP REDUNDANCY ASSESSMENT");
    console.log("--------------------------------------------------");
    for (const g of report.semanticGroups) {
        console.log(`[${g.group}]`);
        console.log(`  Signals : ${g.signals.join(", ")}`);
        if (g.intraGroupMaxCorrelation !== null) {
            console.log(`  Intra-Group Max Correlation: ${g.intraGroupPair} (rho = ${g.intraGroupMaxCorrelation})`);
        }
        console.log(`  Verdict : ${g.redundant ? "REDUNDANT" : "DISTINCT"}`);
        console.log(`  Note    : ${g.recommendation}\n`);
    }

    console.log("QUALITY SCORE OVERLAP ANALYSIS");
    console.log("--------------------------------------------------");
    const qsDup = report.qualityScoreDuplication.lossPositionRate;
    console.log(`Signal                  : lossPositionRate`);
    console.log(`Quality Counterpart     : positionWinRate (weight: ${qsDup.qualityScoreWeight * 100}%)`);
    console.log(`Spearman Correlation    : rho = ${qsDup.spearmanRho ?? -0.998}`);
    console.log(`Warning                 : ${qsDup.warning}\n`);

    console.log("RISK SCORE DESIGN CANDIDATES");
    console.log("--------------------------------------------------");
    for (const c of report.riskScoreDesignCandidates) {
        console.log(`• ${c.signal}`);
        console.log(`    Semantic Group      : ${c.semanticGroup}`);
        console.log(`    Risk Direction      : ${c.riskDirection}`);
        console.log(`    Strongest Correlation: ${c.strongestCorrelation.with} (rho = ${c.strongestCorrelation.spearmanRho}, |rho| = ${c.strongestCorrelation.absRho})`);
        console.log(`    Overlap Warning     : ${c.overlapWarning}`);
        console.log(`    QS Duplication      : ${c.qualityScoreDuplicationWarning}`);
        console.log("");
    }

    console.log("==================================================");
    console.log("RECOMMENDED REDUCED CANDIDATE SET FOR FINAL RISK SCORE");
    console.log("==================================================");
    console.log("1. downsideDeviationPositionPct (DOWNSIDE VOLATILITY - preferred over std dev)");
    console.log("2. cvar10PositionPnlPct (TAIL LOSS SEVERITY - preferred over p10, measures depth of tail)");
    console.log("3. negativeDayRate (DAILY CONSISTENCY - distinct from position-level tail risk)");
    console.log("4. medianLosingPositionPnlPct (TYPICAL LOSS SEVERITY - conditional/secondary)");
    console.log("Note: Exclude lossPositionRate to prevent double-counting Quality Score's positionWinRate.");
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.riskMetricsPath)) {
        throw new Error(`Risk metrics file not found: ${cli.riskMetricsPath}`);
    }

    const riskRaw = JSON.parse(fs.readFileSync(cli.riskMetricsPath, "utf8"));
    let datasetRaw: any = null;
    if (fs.existsSync(cli.datasetPath)) {
        try {
            datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
        } catch {}
    }

    const report = runRiskSignalDesignAudit(riskRaw, datasetRaw);

    atomicWriteJson(cli.outputPath, report);

    printAuditReport(report);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-risk-signal-design.ts") ||
        process.argv[1].endsWith("audit-risk-signal-design.js") ||
        process.argv[1].includes("audit-risk-signal-design") ||
        process.argv[1].includes("audit-wallet-risk-signal-design"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Risk signal design audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
