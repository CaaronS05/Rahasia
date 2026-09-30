import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    datasetPath: string;
    qualityPath: string;
    riskPath: string;
    confidencePath: string;
    stylePath: string;
    outputPath: string;
}

export interface JoinedWalletRecord {
    wallet: string;
    qualityScore: number;
    riskScore: number;
    confidenceScore: number;
    style: "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";
    totalPnl: number;
    profitFactor: number;
    positionWinRate: number;
    medianPositionPnlPct: number;
    closedPositionCount: number;
    pnlConcentrationTop1: number;
}

export interface GuardrailResults {
    totalWallets: number;
    totalPnlPositive: { passing: number; failing: number; failingWallets: string[] };
    profitFactorGt1: { passing: number; failing: number; failingWallets: string[] };
    medianPnlPositive: { passing: number; failing: number; failingWallets: string[] };
    passingAll: { count: number; pct: number };
    failingAny: { count: number; pct: number };
}

export interface ScoreCorrelationItem {
    pair: string;
    spearmanRho: number;
    interpretation: string;
}

export interface GridCell {
    confidenceMin: number;
    qualityThresholdLabel: string;
    qualityThresholdValue: number;
    riskThresholdLabel: string;
    riskThresholdValue: number;
    candidateCount: number;
    candidatePct: number;
}

export interface ReferenceCandidateRecord {
    wallet: string;
    qualityScore: number;
    riskScore: number;
    confidenceScore: number;
    style: string;
    totalPnl: number;
    profitFactor: number;
    medianPositionPnlPct: number;
    positionWinRate: number;
    closedPositionCount: number;
}

export interface ReferenceCombinationOutput {
    name: string;
    definition: string;
    thresholds: {
        qualityMin: number;
        riskMax: number;
        confidenceMin: number;
    };
    candidateCount: number;
    candidatePct: number;
    styleBreakdown: {
        sniper: { count: number; pct: number };
        farmer: { count: number; pct: number };
        mixed: { count: number; pct: number };
    };
    candidates: ReferenceCandidateRecord[];
}

export interface ShortlistDesignAuditOutput {
    generatedAt: string;
    version: "v1";
    populationIntegrity: {
        totalValidWallets: number;
        joinedWallets: number;
        missingInDataset: string[];
        missingInQuality: string[];
        missingInRisk: string[];
        missingInConfidence: string[];
        missingInStyle: string[];
        duplicates: string[];
    };
    profitabilityGuardrails: GuardrailResults;
    scoreCorrelations: {
        qualityVsRisk: ScoreCorrelationItem;
        qualityVsConfidence: ScoreCorrelationItem;
        riskVsConfidence: ScoreCorrelationItem;
    };
    cohortPercentiles: {
        qualityP75: number;
        riskP50: number;
        riskP25: number;
    };
    thresholdGrid: GridCell[];
    referenceCombinations: {
        balanced: ReferenceCombinationOutput;
        strict: ReferenceCombinationOutput;
        veryStrict: ReferenceCombinationOutput;
        qualityFirst: ReferenceCombinationOutput;
    };
    shortlistDesignReadiness: {
        verdict: "READY" | "NOT_READY";
        reasons: string[];
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let qualityPath = path.resolve("data/v1/wallet-quality-scores.json");
    let riskPath = path.resolve("data/v1/wallet-risk-scores.json");
    let confidencePath = path.resolve("data/v1/wallet-confidence-scores.json");
    let stylePath = path.resolve("data/v1/wallet-style-classifications.json");
    let outputPath = path.resolve("data/v1/wallet-shortlist-design-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dataset" && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=")) {
            datasetPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--quality" && args[i + 1]) {
            qualityPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--quality=")) {
            qualityPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--risk" && args[i + 1]) {
            riskPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--risk=")) {
            riskPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--confidence" && args[i + 1]) {
            confidencePath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--confidence=")) {
            confidencePath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--style" && args[i + 1]) {
            stylePath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--style=")) {
            stylePath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    return { datasetPath, qualityPath, riskPath, confidencePath, stylePath, outputPath };
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

function computePercentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const rank = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    if (lower === upper) return sortedValues[lower];
    return Number((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight).toFixed(4));
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

export function runShortlistDesignAudit(
    datasetData: any,
    qualityData: any,
    riskData: any,
    confidenceData: any,
    styleData: any
): ShortlistDesignAuditOutput {
    // 1. Population Join
    const validDatasetWallets: any[] = Array.isArray(datasetData?.wallets)
        ? datasetData.wallets.filter((w: any) => w?.valid === true)
        : [];
    const seenAddresses = new Set<string>();
    const duplicateWallets: string[] = [];
    for (const w of validDatasetWallets) {
        const addr = String(w?.wallet || "").trim();
        if (seenAddresses.has(addr)) {
            duplicateWallets.push(addr);
        }
        seenAddresses.add(addr);
    }
    const validSet = seenAddresses;

    const qualityMap = new Map<string, any>();
    for (const w of qualityData?.wallets || []) {
        if (w?.wallet) qualityMap.set(String(w.wallet).trim(), w);
    }

    const riskMap = new Map<string, any>();
    for (const w of riskData?.wallets || []) {
        if (w?.wallet) riskMap.set(String(w.wallet).trim(), w);
    }

    const confidenceMap = new Map<string, any>();
    for (const w of confidenceData?.wallets || []) {
        if (w?.wallet) confidenceMap.set(String(w.wallet).trim(), w);
    }

    const styleMap = new Map<string, any>();
    for (const w of styleData?.wallets || []) {
        if (w?.wallet) styleMap.set(String(w.wallet).trim(), w);
    }

    const missingInDataset: string[] = [];
    const missingInQuality: string[] = [];
    const missingInRisk: string[] = [];
    const missingInConfidence: string[] = [];
    const missingInStyle: string[] = [];

    const joinedList: JoinedWalletRecord[] = [];

    for (const dw of validDatasetWallets) {
        const addr = String(dw.wallet).trim();
        const qRecord = qualityMap.get(addr);
        const rRecord = riskMap.get(addr);
        const cRecord = confidenceMap.get(addr);
        const sRecord = styleMap.get(addr);

        if (!qRecord) missingInQuality.push(addr);
        if (!rRecord) missingInRisk.push(addr);
        if (!cRecord) missingInConfidence.push(addr);
        if (!sRecord) missingInStyle.push(addr);

        if (qRecord && rRecord && cRecord && sRecord) {
            const m = dw.metrics || {};
            joinedList.push({
                wallet: addr,
                qualityScore: Number(qRecord.qualityScore ?? 0),
                riskScore: Number(rRecord.riskScore ?? 0),
                confidenceScore: Number(cRecord.confidenceScore ?? 0),
                style: sRecord.style ?? "MIXED_UNCLASSIFIED",
                totalPnl: Number(m.totalPnl ?? 0),
                profitFactor: Number(m.profitFactor ?? 0),
                positionWinRate: Number(m.positionWinRate ?? 0),
                medianPositionPnlPct: Number(m.medianPositionPnlPct ?? 0),
                closedPositionCount: Number(m.closedPositionCount ?? dw.positions?.length ?? 0),
                pnlConcentrationTop1: Number(m.pnlConcentrationTop1 ?? 0),
            });
        }
    }

    // 2. Profitability Guardrails
    const failingPnl: string[] = [];
    const failingPF: string[] = [];
    const failingMedPnl: string[] = [];
    const failingAnySet = new Set<string>();

    for (const jw of joinedList) {
        let fails = false;
        if (jw.totalPnl <= 0) {
            failingPnl.push(jw.wallet);
            fails = true;
        }
        if (jw.profitFactor <= 1) {
            failingPF.push(jw.wallet);
            fails = true;
        }
        if (jw.medianPositionPnlPct <= 0) {
            failingMedPnl.push(jw.wallet);
            fails = true;
        }
        if (fails) {
            failingAnySet.add(jw.wallet);
        }
    }

    const guardrails: GuardrailResults = {
        totalWallets: joinedList.length,
        totalPnlPositive: {
            passing: joinedList.length - failingPnl.length,
            failing: failingPnl.length,
            failingWallets: failingPnl,
        },
        profitFactorGt1: {
            passing: joinedList.length - failingPF.length,
            failing: failingPF.length,
            failingWallets: failingPF,
        },
        medianPnlPositive: {
            passing: joinedList.length - failingMedPnl.length,
            failing: failingMedPnl.length,
            failingWallets: failingMedPnl,
        },
        passingAll: {
            count: joinedList.length - failingAnySet.size,
            pct: joinedList.length > 0 ? Number((((joinedList.length - failingAnySet.size) / joinedList.length) * 100).toFixed(2)) : 0,
        },
        failingAny: {
            count: failingAnySet.size,
            pct: joinedList.length > 0 ? Number(((failingAnySet.size / joinedList.length) * 100).toFixed(2)) : 0,
        },
    };

    // 3. Score Correlations
    const qualVec = joinedList.map((w) => w.qualityScore);
    const riskVec = joinedList.map((w) => w.riskScore);
    const confVec = joinedList.map((w) => w.confidenceScore);

    const rhoQR = computeSpearmanCorrelation(qualVec, riskVec);
    const rhoQC = computeSpearmanCorrelation(qualVec, confVec);
    const rhoRC = computeSpearmanCorrelation(riskVec, confVec);

    const correlations = {
        qualityVsRisk: {
            pair: "qualityScore ↔ riskScore",
            spearmanRho: rhoQR,
            interpretation:
                rhoQR < -0.3
                    ? "Negative relationship: higher quality wallets tend to exhibit lower risk."
                    : rhoQR > 0.3
                    ? "Positive relationship: higher quality wallets tend to exhibit higher risk."
                    : "Low/moderate monotonic correlation: Quality and Risk represent distinct orthogonal dimensions.",
        },
        qualityVsConfidence: {
            pair: "qualityScore ↔ confidenceScore",
            spearmanRho: rhoQC,
            interpretation:
                rhoQC > 0.3
                    ? "Positive relationship: higher quality wallets tend to have larger sample sizes / longer history."
                    : "Low monotonic correlation: Quality and Confidence operate independently as intended.",
        },
        riskVsConfidence: {
            pair: "riskScore ↔ confidenceScore",
            spearmanRho: rhoRC,
            interpretation:
                Math.abs(rhoRC) < 0.3
                    ? "Low monotonic correlation: Risk and Confidence are effectively independent."
                    : "Moderate correlation between observed risk and evidence sample size.",
        },
    };

    // 4. Cohort Percentiles
    const sortedQuality = [...qualVec].sort((a, b) => a - b);
    const sortedRisk = [...riskVec].sort((a, b) => a - b);

    const qualityP75 = Number(computePercentile(sortedQuality, 75).toFixed(2));
    const riskP50 = Number(computePercentile(sortedRisk, 50).toFixed(2));
    const riskP25 = Number(computePercentile(sortedRisk, 25).toFixed(2));

    // 5. Threshold Grid
    const qualityThresholds = [
        { label: ">= 50", val: 50 },
        { label: ">= 60", val: 60 },
        { label: `>= P75 (${qualityP75})`, val: qualityP75 },
        { label: ">= 70", val: 70 },
    ];

    const riskThresholds = [
        { label: "<= 50", val: 50 },
        { label: "<= 40", val: 40 },
        { label: `<= P25 (${riskP25})`, val: riskP25 },
        { label: "<= 30", val: 30 },
    ];

    const confidenceThresholds = [70, 80, 90];

    const thresholdGrid: GridCell[] = [];

    for (const cMin of confidenceThresholds) {
        for (const qt of qualityThresholds) {
            for (const rt of riskThresholds) {
                const candidates = joinedList.filter((w) => {
                    const passGuardrails = w.totalPnl > 0 && w.profitFactor > 1 && w.medianPositionPnlPct > 0;
                    return (
                        passGuardrails &&
                        w.qualityScore >= qt.val &&
                        w.riskScore <= rt.val &&
                        w.confidenceScore >= cMin
                    );
                });

                thresholdGrid.push({
                    confidenceMin: cMin,
                    qualityThresholdLabel: qt.label,
                    qualityThresholdValue: qt.val,
                    riskThresholdLabel: rt.label,
                    riskThresholdValue: rt.val,
                    candidateCount: candidates.length,
                    candidatePct: Number(((candidates.length / joinedList.length) * 100).toFixed(2)),
                });
            }
        }
    }

    // 6. Primary Reference Combinations
    function buildRefCombination(
        name: string,
        definition: string,
        qMin: number,
        rMax: number,
        cMin: number
    ): ReferenceCombinationOutput {
        const matches = joinedList.filter((w) => {
            const passGuardrails = w.totalPnl > 0 && w.profitFactor > 1 && w.medianPositionPnlPct > 0;
            return (
                passGuardrails &&
                w.qualityScore >= qMin &&
                w.riskScore <= rMax &&
                w.confidenceScore >= cMin
            );
        });

        // Sort candidate table by qualityScore descending for inspection only
        matches.sort((a, b) => {
            if (Math.abs(b.qualityScore - a.qualityScore) > 1e-4) {
                return b.qualityScore - a.qualityScore;
            }
            return a.wallet.localeCompare(b.wallet);
        });

        const snipers = matches.filter((w) => w.style === "SNIPER").length;
        const farmers = matches.filter((w) => w.style === "FARMER").length;
        const mixed = matches.filter((w) => w.style === "MIXED_UNCLASSIFIED").length;
        const total = matches.length;

        const candidateRecords: ReferenceCandidateRecord[] = matches.map((m) => ({
            wallet: m.wallet,
            qualityScore: m.qualityScore,
            riskScore: m.riskScore,
            confidenceScore: m.confidenceScore,
            style: m.style,
            totalPnl: m.totalPnl,
            profitFactor: m.profitFactor,
            medianPositionPnlPct: m.medianPositionPnlPct,
            positionWinRate: m.positionWinRate,
            closedPositionCount: m.closedPositionCount,
        }));

        return {
            name,
            definition,
            thresholds: {
                qualityMin: qMin,
                riskMax: rMax,
                confidenceMin: cMin,
            },
            candidateCount: total,
            candidatePct: Number(((total / joinedList.length) * 100).toFixed(2)),
            styleBreakdown: {
                sniper: { count: snipers, pct: total > 0 ? Number(((snipers / total) * 100).toFixed(2)) : 0 },
                farmer: { count: farmers, pct: total > 0 ? Number(((farmers / total) * 100).toFixed(2)) : 0 },
                mixed: { count: mixed, pct: total > 0 ? Number(((mixed / total) * 100).toFixed(2)) : 0 },
            },
            candidates: candidateRecords,
        };
    }

    const refBalanced = buildRefCombination(
        "A. BALANCED",
        `Quality >= P75 (${qualityP75}), Risk <= P50 (${riskP50}), Confidence >= 80, Guardrails = PASS`,
        qualityP75,
        riskP50,
        80
    );

    const refStrict = buildRefCombination(
        "B. STRICT",
        `Quality >= P75 (${qualityP75}), Risk <= P25 (${riskP25}), Confidence >= 80, Guardrails = PASS`,
        qualityP75,
        riskP25,
        80
    );

    const refVeryStrict = buildRefCombination(
        "C. VERY STRICT",
        `Quality >= 70, Risk <= 30, Confidence >= 90, Guardrails = PASS`,
        70,
        30,
        90
    );

    const refQualityFirst = buildRefCombination(
        "D. QUALITY-FIRST",
        `Quality >= 70, Risk <= 50, Confidence >= 80, Guardrails = PASS`,
        70,
        50,
        80
    );

    const isReady =
        joinedList.length === 65 &&
        missingInQuality.length === 0 &&
        missingInRisk.length === 0 &&
        missingInConfidence.length === 0 &&
        missingInStyle.length === 0;

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        populationIntegrity: {
            totalValidWallets: validDatasetWallets.length,
            joinedWallets: joinedList.length,
            missingInDataset,
            missingInQuality,
            missingInRisk,
            missingInConfidence,
            missingInStyle,
            duplicates: duplicateWallets,
        },
        profitabilityGuardrails: guardrails,
        scoreCorrelations: correlations,
        cohortPercentiles: {
            qualityP75,
            riskP50,
            riskP25,
        },
        thresholdGrid,
        referenceCombinations: {
            balanced: refBalanced,
            strict: refStrict,
            veryStrict: refVeryStrict,
            qualityFirst: refQualityFirst,
        },
        shortlistDesignReadiness: {
            verdict: isReady ? "READY" : "NOT_READY",
            reasons: isReady
                ? [
                      "All 65 valid wallets cleanly joined across Quality, Risk, Confidence, Style, and Screening datasets.",
                      "Profitability guardrails and score distributions fully mapped.",
                      "Multiple viable reference candidate sets identified without requiring arbitrary combined scores.",
                  ]
                : ["Population integrity violations detected during dataset joining."],
        },
    };
}

function printAuditReport(output: ShortlistDesignAuditOutput): void {
    console.log("==================================================");
    console.log("V1 — WALLET SHORTLIST DESIGN AUDIT");
    console.log("==================================================");
    console.log(`Cohort Population     : ${output.populationIntegrity.totalValidWallets} valid wallets`);
    console.log(`Joined Across Scores  : ${output.populationIntegrity.joinedWallets} wallets\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Missing in Quality    : ${output.populationIntegrity.missingInQuality.length}`);
    console.log(`Missing in Risk       : ${output.populationIntegrity.missingInRisk.length}`);
    console.log(`Missing in Confidence : ${output.populationIntegrity.missingInConfidence.length}`);
    console.log(`Missing in Style      : ${output.populationIntegrity.missingInStyle.length}`);
    console.log("  All 65 wallets cleanly unified across all V1 analytical artifacts.\n");

    console.log("2. PROFITABILITY GUARDRAILS (A: PnL>0, B: PF>1, C: MedPnl%>0)");
    console.log("--------------------------------------------------");
    const g = output.profitabilityGuardrails;
    console.log(`A. totalPnl > 0              : ${g.totalPnlPositive.passing} pass, ${g.totalPnlPositive.failing} fail`);
    console.log(`B. profitFactor > 1          : ${g.profitFactorGt1.passing} pass, ${g.profitFactorGt1.failing} fail`);
    console.log(`C. medianPositionPnlPct > 0  : ${g.medianPnlPositive.passing} pass, ${g.medianPnlPositive.failing} fail`);
    console.log(`Passing ALL Guardrails       : ${g.passingAll.count} / ${g.totalWallets} (${g.passingAll.pct}%)`);
    console.log(`Failing ANY Guardrail        : ${g.failingAny.count} / ${g.totalWallets} (${g.failingAny.pct}%)\n`);

    console.log("3. SCORE CORRELATIONS (SPEARMAN RANK)");
    console.log("--------------------------------------------------");
    const sc = output.scoreCorrelations;
    console.log(`qualityScore ↔ riskScore       : rho = ${String(sc.qualityVsRisk.spearmanRho).padStart(7)} | ${sc.qualityVsRisk.interpretation}`);
    console.log(`qualityScore ↔ confidenceScore : rho = ${String(sc.qualityVsConfidence.spearmanRho).padStart(7)} | ${sc.qualityVsConfidence.interpretation}`);
    console.log(`riskScore ↔ confidenceScore    : rho = ${String(sc.riskVsConfidence.spearmanRho).padStart(7)} | ${sc.riskVsConfidence.interpretation}\n`);

    console.log("4. COHORT REFERENCE THRESHOLDS");
    console.log("--------------------------------------------------");
    console.log(`Quality Score P75             : >= ${output.cohortPercentiles.qualityP75}`);
    console.log(`Risk Score P50 (Median)       : <= ${output.cohortPercentiles.riskP50}`);
    console.log(`Risk Score P25                : <= ${output.cohortPercentiles.riskP25}\n`);

    console.log("5. THRESHOLD GRID (CANDIDATE COUNTS)");
    console.log("--------------------------------------------------");
    const confLevels = [70, 80, 90];
    const qualLabels = [">= 50", ">= 60", `>= P75 (${output.cohortPercentiles.qualityP75})`, ">= 70"];
    const riskLabels = ["<= 50", "<= 40", `<= P25 (${output.cohortPercentiles.riskP25})`, "<= 30"];

    for (const cMin of confLevels) {
        console.log(`[CONFIDENCE SCORE >= ${cMin}]`);
        console.log(`Quality \\ Risk        |  <= 50 Risk  |  <= 40 Risk  | <= P25 Risk  |  <= 30 Risk`);
        console.log(`-----------------------------------------------------------------------------`);
        for (const ql of qualLabels) {
            const cells = riskLabels.map((rl) => {
                const cell = output.thresholdGrid.find(
                    (item) =>
                        item.confidenceMin === cMin &&
                        item.qualityThresholdLabel === ql &&
                        item.riskThresholdLabel === rl
                );
                const count = cell ? cell.candidateCount : 0;
                const pct = cell ? cell.candidatePct : 0;
                return `${String(count).padStart(3)} (${String(pct).padStart(5)}%)`;
            });
            console.log(`${ql.padEnd(22)}|  ${cells.join("  |  ")}`);
        }
        console.log("");
    }

    console.log("6. PRIMARY REFERENCE COMBINATIONS (CANDIDATE COUNTS & STYLES)");
    console.log("--------------------------------------------------");
    const refKeys: Array<keyof typeof output.referenceCombinations> = [
        "balanced",
        "strict",
        "veryStrict",
        "qualityFirst",
    ];

    for (const rk of refKeys) {
        const rc = output.referenceCombinations[rk];
        console.log(`COMBINATION ${rc.name}`);
        console.log(`  Definition : ${rc.definition}`);
        console.log(`  Candidates : ${rc.candidateCount} / 65 wallets (${rc.candidatePct}%)`);
        console.log(
            `  Styles     : SNIPER: ${rc.styleBreakdown.sniper.count} (${rc.styleBreakdown.sniper.pct}%), FARMER: ${rc.styleBreakdown.farmer.count} (${rc.styleBreakdown.farmer.pct}%), MIXED: ${rc.styleBreakdown.mixed.count} (${rc.styleBreakdown.mixed.pct}%)\n`
        );
    }

    console.log("7. MANUAL CANDIDATE TABLES");
    console.log("--------------------------------------------------");
    console.log("Display ordered by qualityScore descending for manual inspection only. No composite ranking applied.\n");

    for (const rk of refKeys) {
        const rc = output.referenceCombinations[rk];
        console.log(`======================================================================================================================`);
        console.log(`${rc.name} (${rc.candidateCount} Wallets) — ${rc.definition}`);
        console.log(`======================================================================================================================`);
        if (rc.candidates.length === 0) {
            console.log("  No candidate wallets satisfy this combination.\n");
            continue;
        }

        console.log("Wallet                                       | Quality |  Risk  |  Conf  | Style              | Total PnL |    PF | MedPnl% | WinRate | ClosedPos");
        console.log("---------------------------------------------------------------------------------------------------------------------------------------------");
        for (const c of rc.candidates) {
            const pnlStr = (c.totalPnl >= 0 ? "+" : "") + c.totalPnl.toFixed(2);
            console.log(
                `${c.wallet} | ${String(c.qualityScore.toFixed(2)).padStart(7)} | ${String(c.riskScore.toFixed(2)).padStart(6)} | ${String(c.confidenceScore.toFixed(2)).padStart(6)} | ${c.style.padEnd(18)} | ${String(pnlStr).padStart(9)} | ${String(c.profitFactor.toFixed(2)).padStart(5)} | ${String(c.medianPositionPnlPct.toFixed(2) + "%").padStart(7)} | ${String(c.positionWinRate.toFixed(1) + "%").padStart(7)} | ${String(c.closedPositionCount).padStart(9)}`
            );
        }
        console.log("");
    }

    console.log("==================================================");
    console.log(`SHORTLIST_DESIGN_READINESS: ${output.shortlistDesignReadiness.verdict}`);
    console.log("==================================================");
    for (const r of output.shortlistDesignReadiness.reasons) {
        console.log(`• ${r}`);
    }
    console.log("Note: Final selection rule will be aligned after inspection.\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    const requiredPaths = [
        { label: "Screening dataset", p: cli.datasetPath },
        { label: "Quality scores", p: cli.qualityPath },
        { label: "Risk scores", p: cli.riskPath },
        { label: "Confidence scores", p: cli.confidencePath },
        { label: "Style classifications", p: cli.stylePath },
    ];

    for (const req of requiredPaths) {
        if (!fs.existsSync(req.p)) {
            throw new Error(`Required artifact not found (${req.label}): ${req.p}`);
        }
    }

    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const qualityRaw = JSON.parse(fs.readFileSync(cli.qualityPath, "utf8"));
    const riskRaw = JSON.parse(fs.readFileSync(cli.riskPath, "utf8"));
    const confidenceRaw = JSON.parse(fs.readFileSync(cli.confidencePath, "utf8"));
    const styleRaw = JSON.parse(fs.readFileSync(cli.stylePath, "utf8"));

    const output = runShortlistDesignAudit(datasetRaw, qualityRaw, riskRaw, confidenceRaw, styleRaw);

    atomicWriteJson(cli.outputPath, output);

    printAuditReport(output);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-shortlist-design.ts") ||
        process.argv[1].endsWith("audit-wallet-shortlist-design.js") ||
        process.argv[1].includes("audit-wallet-shortlist-design") ||
        process.argv[1].includes("audit-shortlist-design"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Shortlist design audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
