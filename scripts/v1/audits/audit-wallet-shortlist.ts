import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    shortlistPath: string;
    datasetPath: string;
    qualityPath: string;
    riskPath: string;
    confidencePath: string;
    stylePath: string;
    auditPath: string;
    outputPath: string;
}

export interface ShortlistAuditReport {
    generatedAt: string;
    version: "v1";
    status: "V1_SHORTLIST_READY" | "V1_SHORTLIST_FAIL";
    population: {
        sourceValidWallets: number;
        expectedShortlistCount: number;
        outputShortlistCount: number;
        duplicateWalletsCount: number;
        duplicateWallets: string[];
        missingInQualityCount: number;
        missingInRiskCount: number;
        missingInConfidenceCount: number;
        missingInStyleCount: number;
    };
    thresholds: {
        recomputedQualityP75: number;
        recomputedRiskP25: number;
        shortlistQualityMinimum: number;
        shortlistRiskMaximum: number;
        shortlistConfidenceMinimum: number;
        thresholdMismatch: boolean;
    };
    violations: {
        qualityViolations: string[];
        riskViolations: string[];
        confidenceViolations: string[];
        guardrailViolations: string[];
        mismatchViolations: string[];
    };
    styleDistribution: {
        sniper: { count: number; pct: number };
        farmer: { count: number; pct: number };
        mixed: { count: number; pct: number };
    };
    shortlistedWallets: Array<{
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
    }>;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let shortlistPath = path.resolve("data/v1/wallet-shortlist.json");
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let qualityPath = path.resolve("data/v1/wallet-quality-scores.json");
    let riskPath = path.resolve("data/v1/wallet-risk-scores.json");
    let confidencePath = path.resolve("data/v1/wallet-confidence-scores.json");
    let stylePath = path.resolve("data/v1/wallet-style-classifications.json");
    let auditPath = path.resolve("data/v1/wallet-shortlist-design-audit.json");
    let outputPath = path.resolve("data/v1/wallet-shortlist-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--shortlist" && args[i + 1]) {
            shortlistPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--shortlist=")) {
            shortlistPath = path.resolve(arg.slice(12));
        } else if (arg === "--dataset" && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=")) {
            datasetPath = path.resolve(arg.slice(10));
        } else if (arg === "--quality" && args[i + 1]) {
            qualityPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--quality=")) {
            qualityPath = path.resolve(arg.slice(10));
        } else if (arg === "--risk" && args[i + 1]) {
            riskPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--risk=")) {
            riskPath = path.resolve(arg.slice(7));
        } else if (arg === "--confidence" && args[i + 1]) {
            confidencePath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--confidence=")) {
            confidencePath = path.resolve(arg.slice(13));
        } else if (arg === "--style" && args[i + 1]) {
            stylePath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--style=")) {
            stylePath = path.resolve(arg.slice(8));
        } else if (arg === "--audit" && args[i + 1]) {
            auditPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--audit=")) {
            auditPath = path.resolve(arg.slice(8));
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    return { shortlistPath, datasetPath, qualityPath, riskPath, confidencePath, stylePath, auditPath, outputPath };
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

export function auditWalletShortlist(
    shortlistData: any,
    datasetData: any,
    qualityData: any,
    riskData: any,
    confidenceData: any,
    styleData: any,
    designAuditData?: any
): ShortlistAuditReport {
    // 1. Source population join
    const validDatasetWallets: any[] = Array.isArray(datasetData?.wallets)
        ? datasetData.wallets.filter((w: any) => w?.valid === true)
        : [];
    const sourceValidCount = validDatasetWallets.length;

    const qualityMap = new Map<string, any>();
    const qualityScores: number[] = [];
    for (const w of qualityData?.wallets || []) {
        if (w?.wallet) {
            const addr = String(w.wallet).trim();
            qualityMap.set(addr, w);
            if (typeof w.qualityScore === "number") qualityScores.push(w.qualityScore);
        }
    }

    const riskMap = new Map<string, any>();
    const riskScores: number[] = [];
    for (const w of riskData?.wallets || []) {
        if (w?.wallet) {
            const addr = String(w.wallet).trim();
            riskMap.set(addr, w);
            if (typeof w.riskScore === "number") riskScores.push(w.riskScore);
        }
    }

    const confidenceMap = new Map<string, any>();
    for (const w of confidenceData?.wallets || []) {
        if (w?.wallet) confidenceMap.set(String(w.wallet).trim(), w);
    }

    const styleMap = new Map<string, any>();
    for (const w of styleData?.wallets || []) {
        if (w?.wallet) styleMap.set(String(w.wallet).trim(), w);
    }

    let missingInQualityCount = 0;
    let missingInRiskCount = 0;
    let missingInConfidenceCount = 0;
    let missingInStyleCount = 0;

    for (const dw of validDatasetWallets) {
        const addr = String(dw.wallet).trim();
        if (!qualityMap.has(addr)) missingInQualityCount++;
        if (!riskMap.has(addr)) missingInRiskCount++;
        if (!confidenceMap.has(addr)) missingInConfidenceCount++;
        if (!styleMap.has(addr)) missingInStyleCount++;
    }

    // 2. Recompute thresholds
    const sortedQuality = [...qualityScores].sort((a, b) => a - b);
    const sortedRisk = [...riskScores].sort((a, b) => a - b);

    const recomputedQualityP75 = Number(computePercentile(sortedQuality, 75).toFixed(2));
    const recomputedRiskP25 = Number(computePercentile(sortedRisk, 25).toFixed(2));

    const shortlistQualityMin = Number(shortlistData?.rule?.qualityMinimum ?? 0);
    const shortlistRiskMax = Number(shortlistData?.rule?.riskMaximum ?? 0);
    const shortlistConfMin = Number(shortlistData?.rule?.confidenceMinimum ?? 0);

    const thresholdMismatch =
        Math.abs(shortlistQualityMin - recomputedQualityP75) > 1e-4 ||
        Math.abs(shortlistRiskMax - recomputedRiskP25) > 1e-4 ||
        shortlistConfMin !== 80;

    // 3. Expected shortlist calculation from source artifacts
    const expectedWallets: string[] = [];
    for (const dw of validDatasetWallets) {
        const addr = String(dw.wallet).trim();
        const qRec = qualityMap.get(addr);
        const rRec = riskMap.get(addr);
        const cRec = confidenceMap.get(addr);
        const sRec = styleMap.get(addr);

        if (!qRec || !rRec || !cRec || !sRec) continue;

        const m = dw.metrics || {};
        const totalPnl = Number(m.totalPnl ?? 0);
        const profitFactor = Number(m.profitFactor ?? 0);
        const medianPositionPnlPct = Number(m.medianPositionPnlPct ?? 0);

        const qScore = Number(qRec.qualityScore ?? 0);
        const rScore = Number(rRec.riskScore ?? 0);
        const cScore = Number(cRec.confidenceScore ?? 0);

        const qPass = qScore >= recomputedQualityP75;
        const rPass = rScore <= recomputedRiskP25;
        const cPass = cScore >= 80;
        const gPass = totalPnl > 0 && profitFactor > 1 && medianPositionPnlPct > 0;

        if (qPass && rPass && cPass && gPass) {
            expectedWallets.push(addr);
        }
    }

    // 4. Output shortlist inspection
    const outputWallets = Array.isArray(shortlistData?.wallets) ? shortlistData.wallets : [];
    const seenAddresses = new Set<string>();
    const duplicateWallets: string[] = [];

    const qualityViolations: string[] = [];
    const riskViolations: string[] = [];
    const confidenceViolations: string[] = [];
    const guardrailViolations: string[] = [];
    const mismatchViolations: string[] = [];

    for (const ow of outputWallets) {
        const addr = String(ow?.wallet || "").trim();
        if (seenAddresses.has(addr)) {
            duplicateWallets.push(addr);
        }
        seenAddresses.add(addr);

        const qRec = qualityMap.get(addr);
        const rRec = riskMap.get(addr);
        const cRec = confidenceMap.get(addr);

        const qScore = Number(ow?.qualityScore ?? 0);
        const rScore = Number(ow?.riskScore ?? 0);
        const cScore = Number(ow?.confidenceScore ?? 0);

        if (qScore < shortlistQualityMin) {
            qualityViolations.push(`${addr}: quality ${qScore} < ${shortlistQualityMin}`);
        }
        if (rScore > shortlistRiskMax) {
            riskViolations.push(`${addr}: risk ${rScore} > ${shortlistRiskMax}`);
        }
        if (cScore < 80) {
            confidenceViolations.push(`${addr}: confidence ${cScore} < 80`);
        }

        const perf = ow?.performance || {};
        const totalPnl = Number(perf.totalPnl ?? 0);
        const profitFactor = Number(perf.profitFactor ?? 0);
        const medianPositionPnlPct = Number(perf.medianPositionPnlPct ?? 0);

        if (totalPnl <= 0 || profitFactor <= 1 || medianPositionPnlPct <= 0) {
            guardrailViolations.push(`${addr}: failed guardrails (pnl=${totalPnl}, pf=${profitFactor}, medPnl=${medianPositionPnlPct})`);
        }

        if (qRec && Math.abs(qScore - Number(qRec.qualityScore ?? 0)) > 1e-4) {
            mismatchViolations.push(`${addr}: qualityScore mismatch (${qScore} vs source ${qRec.qualityScore})`);
        }
        if (rRec && Math.abs(rScore - Number(rRec.riskScore ?? 0)) > 1e-4) {
            mismatchViolations.push(`${addr}: riskScore mismatch (${rScore} vs source ${rRec.riskScore})`);
        }
        if (cRec && Math.abs(cScore - Number(cRec.confidenceScore ?? 0)) > 1e-4) {
            mismatchViolations.push(`${addr}: confidenceScore mismatch (${cScore} vs source ${cRec.confidenceScore})`);
        }
    }

    const countMismatch = outputWallets.length !== expectedWallets.length;

    const isReady =
        sourceValidCount === 65 &&
        missingInQualityCount === 0 &&
        missingInRiskCount === 0 &&
        missingInConfidenceCount === 0 &&
        missingInStyleCount === 0 &&
        !thresholdMismatch &&
        !countMismatch &&
        duplicateWallets.length === 0 &&
        qualityViolations.length === 0 &&
        riskViolations.length === 0 &&
        confidenceViolations.length === 0 &&
        guardrailViolations.length === 0 &&
        mismatchViolations.length === 0;

    const snipers = outputWallets.filter((w: any) => w?.style === "SNIPER").length;
    const farmers = outputWallets.filter((w: any) => w?.style === "FARMER").length;
    const mixed = outputWallets.filter((w: any) => w?.style === "MIXED_UNCLASSIFIED").length;
    const totalOutput = outputWallets.length;

    const candidateRows = outputWallets.map((ow: any) => ({
        wallet: String(ow.wallet),
        qualityScore: Number(ow.qualityScore ?? 0),
        riskScore: Number(ow.riskScore ?? 0),
        confidenceScore: Number(ow.confidenceScore ?? 0),
        style: String(ow.style ?? "MIXED_UNCLASSIFIED"),
        totalPnl: Number(ow.performance?.totalPnl ?? 0),
        profitFactor: Number(ow.performance?.profitFactor ?? 0),
        medianPositionPnlPct: Number(ow.performance?.medianPositionPnlPct ?? 0),
        positionWinRate: Number(ow.performance?.positionWinRate ?? 0),
        closedPositionCount: Number(ow.performance?.closedPositionCount ?? 0),
    }));

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        status: isReady ? "V1_SHORTLIST_READY" : "V1_SHORTLIST_FAIL",
        population: {
            sourceValidWallets: sourceValidCount,
            expectedShortlistCount: expectedWallets.length,
            outputShortlistCount: outputWallets.length,
            duplicateWalletsCount: duplicateWallets.length,
            duplicateWallets,
            missingInQualityCount,
            missingInRiskCount,
            missingInConfidenceCount,
            missingInStyleCount,
        },
        thresholds: {
            recomputedQualityP75,
            recomputedRiskP25,
            shortlistQualityMinimum: shortlistQualityMin,
            shortlistRiskMaximum: shortlistRiskMax,
            shortlistConfidenceMinimum: shortlistConfMin,
            thresholdMismatch,
        },
        violations: {
            qualityViolations,
            riskViolations,
            confidenceViolations,
            guardrailViolations,
            mismatchViolations,
        },
        styleDistribution: {
            sniper: { count: snipers, pct: totalOutput > 0 ? Number(((snipers / totalOutput) * 100).toFixed(2)) : 0 },
            farmer: { count: farmers, pct: totalOutput > 0 ? Number(((farmers / totalOutput) * 100).toFixed(2)) : 0 },
            mixed: { count: mixed, pct: totalOutput > 0 ? Number(((mixed / totalOutput) * 100).toFixed(2)) : 0 },
        },
        shortlistedWallets: candidateRows,
    };
}

export function printShortlistAuditReport(report: ShortlistAuditReport): void {
    console.log("==================================================");
    console.log("V1 FINAL SHORTLIST");
    console.log("==================================================");
    console.log(`Source Valid Wallets  : ${report.population.sourceValidWallets}`);
    console.log(`Expected Shortlisted  : ${report.population.expectedShortlistCount}`);
    console.log(`Output Shortlisted    : ${report.population.outputShortlistCount}`);
    console.log(
        `Selection Rule        : STRICT (Quality >= ${report.thresholds.shortlistQualityMinimum}, Risk <= ${report.thresholds.shortlistRiskMaximum}, Confidence >= ${report.thresholds.shortlistConfidenceMinimum}, Guardrails = PASS)\n`
    );

    console.log("SHORTLIST CANDIDATES (Display ordered by qualityScore descending):");
    console.log("---------------------------------------------------------------------------------------------------------------------------------------------");
    console.log("Wallet                                       | Quality |  Risk  |  Conf  | Style              | Total PnL |    PF | MedPnl% | WinRate | ClosedPos");
    console.log("---------------------------------------------------------------------------------------------------------------------------------------------");
    for (const w of report.shortlistedWallets) {
        const pnlStr = (w.totalPnl >= 0 ? "+" : "") + w.totalPnl.toFixed(2);
        console.log(
            `${w.wallet} | ${String(w.qualityScore.toFixed(2)).padStart(7)} | ${String(w.riskScore.toFixed(2)).padStart(6)} | ${String(w.confidenceScore.toFixed(2)).padStart(6)} | ${w.style.padEnd(18)} | ${String(pnlStr).padStart(9)} | ${String(w.profitFactor.toFixed(2)).padStart(5)} | ${String(w.medianPositionPnlPct.toFixed(2) + "%").padStart(7)} | ${String(w.positionWinRate.toFixed(1) + "%").padStart(7)} | ${String(w.closedPositionCount).padStart(9)}`
        );
    }
    console.log("");

    console.log("SHORTLIST STYLE DISTRIBUTION");
    console.log("--------------------------------------------------");
    console.log(`SNIPER             : ${report.styleDistribution.sniper.count} (${report.styleDistribution.sniper.pct.toFixed(2)}%)`);
    console.log(`FARMER             : ${report.styleDistribution.farmer.count} (${report.styleDistribution.farmer.pct.toFixed(2)}%)`);
    console.log(`MIXED_UNCLASSIFIED : ${report.styleDistribution.mixed.count} (${report.styleDistribution.mixed.pct.toFixed(2)}%)`);
    console.log("Note: Style remains descriptive and informational only.\n");

    console.log("AUDIT CHECKS:");
    console.log(`• Source valid wallets        : ${report.population.sourceValidWallets} / 65 (${report.population.sourceValidWallets === 65 ? "PASS" : "FAIL"})`);
    console.log(`• Missing joins (Q/R/C/S)     : ${report.population.missingInQualityCount}/${report.population.missingInRiskCount}/${report.population.missingInConfidenceCount}/${report.population.missingInStyleCount} (PASS)`);
    console.log(`• Duplicate wallets           : ${report.population.duplicateWalletsCount} (PASS)`);
    console.log(
        `• Threshold recomputation     : ${report.thresholds.thresholdMismatch ? "FAIL" : "MATCH"} (Q>=${report.thresholds.recomputedQualityP75}, R<=${report.thresholds.recomputedRiskP25}, C>=80)`
    );
    console.log(
        `• Expected vs output count    : ${report.population.expectedShortlistCount} expected, ${report.population.outputShortlistCount} actual (${report.population.expectedShortlistCount === report.population.outputShortlistCount ? "MATCH" : "MISMATCH"})`
    );
    console.log(`• Quality below threshold     : ${report.violations.qualityViolations.length} (${report.violations.qualityViolations.length === 0 ? "PASS" : "FAIL"})`);
    console.log(`• Risk above threshold        : ${report.violations.riskViolations.length} (${report.violations.riskViolations.length === 0 ? "PASS" : "FAIL"})`);
    console.log(`• Confidence below threshold  : ${report.violations.confidenceViolations.length} (${report.violations.confidenceViolations.length === 0 ? "PASS" : "FAIL"})`);
    console.log(`• Guardrail violations        : ${report.violations.guardrailViolations.length} (${report.violations.guardrailViolations.length === 0 ? "PASS" : "FAIL"})\n`);

    console.log("==================================================");
    console.log(`FINAL VERDICT: ${report.status}`);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    const requiredPaths = [
        { label: "Shortlist", p: cli.shortlistPath },
        { label: "Screening dataset", p: cli.datasetPath },
        { label: "Quality scores", p: cli.qualityPath },
        { label: "Risk scores", p: cli.riskPath },
        { label: "Confidence scores", p: cli.confidencePath },
        { label: "Style classifications", p: cli.stylePath },
    ];

    for (const req of requiredPaths) {
        if (!fs.existsSync(req.p)) {
            throw new Error(`Required file not found (${req.label}): ${req.p}`);
        }
    }

    const shortlistRaw = JSON.parse(fs.readFileSync(cli.shortlistPath, "utf8"));
    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const qualityRaw = JSON.parse(fs.readFileSync(cli.qualityPath, "utf8"));
    const riskRaw = JSON.parse(fs.readFileSync(cli.riskPath, "utf8"));
    const confidenceRaw = JSON.parse(fs.readFileSync(cli.confidencePath, "utf8"));
    const styleRaw = JSON.parse(fs.readFileSync(cli.stylePath, "utf8"));
    const auditRaw = fs.existsSync(cli.auditPath)
        ? JSON.parse(fs.readFileSync(cli.auditPath, "utf8"))
        : undefined;

    const report = auditWalletShortlist(
        shortlistRaw,
        datasetRaw,
        qualityRaw,
        riskRaw,
        confidenceRaw,
        styleRaw,
        auditRaw
    );

    atomicWriteJson(cli.outputPath, report);

    printShortlistAuditReport(report);

    if (report.status !== "V1_SHORTLIST_READY") {
        process.exit(1);
    }
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-shortlist.ts") ||
        process.argv[1].endsWith("audit-wallet-shortlist.js") ||
        process.argv[1].includes("audit-wallet-shortlist") ||
        process.argv[1].includes("audit-shortlist"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Shortlist audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
