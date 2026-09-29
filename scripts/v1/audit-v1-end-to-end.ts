import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CliOptions {
    datasetPath: string;
    qualityPath: string;
    riskPath: string;
    confidencePath: string;
    stylePath: string;
    shortlistPath: string;
    publishedPath: string;
    frontendDir: string;
    outputPath: string;
}

export interface EndToEndAuditReport {
    generatedAt: string;
    version: "v1";
    status: "V1_COMPLETE" | "V1_NOT_COMPLETE";
    check1Population: {
        pass: boolean;
        candidateCount: number;
        validCount: number;
        invalidCount: number;
        sumMatches: boolean;
        duplicateValidCount: number;
        blockers: string[];
    };
    check2AnalyticsCoverage: {
        pass: boolean;
        qualityCoverage: number;
        riskCoverage: number;
        confidenceCoverage: number;
        styleCoverage: number;
        expectedCount: number;
        blockers: string[];
    };
    check3Shortlist: {
        pass: boolean;
        computedQualityP75: number;
        computedRiskP25: number;
        computedConfidenceMin: number;
        dynamicShortlistCount: number;
        artifactShortlistCount: number;
        dynamicShortlistWallets: string[];
        artifactShortlistWallets: string[];
        thresholdsMatch: boolean;
        blockers: string[];
    };
    check4PublishedData: {
        pass: boolean;
        publishedWalletsCount: number;
        publishedShortlistedCount: number;
        scoreMismatchesCount: number;
        performanceMismatchesCount: number;
        blockers: string[];
    };
    check5ScoreSemantics: {
        pass: boolean;
        scoreBoundsPass: boolean;
        forbiddenCompositeFieldsFound: string[];
        styleValuesValid: boolean;
        shortlistBooleanValid: boolean;
        semanticsSeparationPass: boolean;
        blockers: string[];
    };
    check6FrontendIntegration: {
        pass: boolean;
        consumesPublishedJson: boolean;
        v1FieldsWired: boolean;
        noFakeZeroFallback: boolean;
        missingIntelligenceGraceful: boolean;
        defaultOrderingPreserved: boolean;
        noAutoRankingByV1Scores: boolean;
        noAutoShortlistReorder: boolean;
        blockers: string[];
    };
    allBlockers: string[];
}

export function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    const getArg = (flag: string, fallback: string): string => {
        for (let i = 0; i < args.length; i++) {
            if (args[i] === flag && i + 1 < args.length) {
                return path.resolve(args[i + 1]);
            }
            if (args[i].startsWith(`${flag}=`)) {
                return path.resolve(args[i].slice(flag.length + 1));
            }
        }
        return fallback;
    };

    const projectRoot = path.resolve(__dirname, "../..");
    return {
        datasetPath: getArg(
            "--dataset",
            path.join(projectRoot, "data/v1/wallet-screening-dataset.json")
        ),
        qualityPath: getArg(
            "--quality",
            path.join(projectRoot, "data/v1/wallet-quality-scores.json")
        ),
        riskPath: getArg(
            "--risk",
            path.join(projectRoot, "data/v1/wallet-risk-scores.json")
        ),
        confidencePath: getArg(
            "--confidence",
            path.join(projectRoot, "data/v1/wallet-confidence-scores.json")
        ),
        stylePath: getArg(
            "--style",
            path.join(projectRoot, "data/v1/wallet-style-classifications.json")
        ),
        shortlistPath: getArg(
            "--shortlist",
            path.join(projectRoot, "data/v1/wallet-shortlist.json")
        ),
        publishedPath: getArg(
            "--published",
            path.join(projectRoot, "frontend/public/data/wallet-intelligence-v1.json")
        ),
        frontendDir: getArg(
            "--frontend",
            path.join(projectRoot, "frontend/src")
        ),
        outputPath: getArg(
            "--output",
            path.join(projectRoot, "data/v1/audit-v1-end-to-end.json")
        ),
    };
}

export function computePercentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const rank = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    if (lower === upper) return sortedValues[lower];
    return Number((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight).toFixed(4));
}

function atomicWriteJson(targetPath: string, payload: unknown): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, targetPath);
}

export function runV1EndToEndAudit(
    datasetRaw: any,
    qualityRaw: any,
    riskRaw: any,
    confidenceRaw: any,
    styleRaw: any,
    shortlistRaw: any,
    publishedRaw: any,
    frontendDir: string
): EndToEndAuditReport {
    const allBlockers: string[] = [];

    // =========================================================================
    // CHECK 1 — SOURCE POPULATION
    // =========================================================================
    const check1Blockers: string[] = [];
    const allDatasetWallets: any[] = datasetRaw?.wallets || [];
    const candidateCount = allDatasetWallets.length;
    const validWallets = allDatasetWallets.filter((w: any) => w?.valid === true);
    const invalidWallets = allDatasetWallets.filter((w: any) => w?.valid === false);
    const validCount = validWallets.length;
    const invalidCount = invalidWallets.length;

    if (candidateCount !== 83) {
        check1Blockers.push(`Expected 83 candidate wallets, found ${candidateCount}`);
    }
    if (validCount !== 65) {
        check1Blockers.push(`Expected 65 valid wallets, found ${validCount}`);
    }
    if (invalidCount !== 18) {
        check1Blockers.push(`Expected 18 invalid wallets, found ${invalidCount}`);
    }
    const sumMatches = validCount + invalidCount === candidateCount;
    if (!sumMatches) {
        check1Blockers.push(`valid (${validCount}) + invalid (${invalidCount}) != candidates (${candidateCount})`);
    }

    const validAddresses = validWallets.map((w: any) => String(w.wallet).trim());
    const validAddressSet = new Set<string>();
    const duplicateValidAddresses: string[] = [];
    for (const addr of validAddresses) {
        if (!addr) {
            check1Blockers.push("Empty valid wallet address detected in screening dataset");
            continue;
        }
        if (validAddressSet.has(addr)) {
            duplicateValidAddresses.push(addr);
        }
        validAddressSet.add(addr);
    }
    if (duplicateValidAddresses.length > 0) {
        check1Blockers.push(`Found ${duplicateValidAddresses.length} duplicate valid wallet addresses: ${duplicateValidAddresses.join(", ")}`);
    }

    // Cross-verify population metadata block if present
    if (datasetRaw?.population) {
        if (datasetRaw.population.candidateWallets !== 83) {
            check1Blockers.push(`Screening metadata candidateWallets is ${datasetRaw.population.candidateWallets}, expected 83`);
        }
        if (datasetRaw.population.validWallets !== 65) {
            check1Blockers.push(`Screening metadata validWallets is ${datasetRaw.population.validWallets}, expected 65`);
        }
        if (datasetRaw.population.invalidWallets !== 18) {
            check1Blockers.push(`Screening metadata invalidWallets is ${datasetRaw.population.invalidWallets}, expected 18`);
        }
    }

    const check1Pass = check1Blockers.length === 0;
    allBlockers.push(...check1Blockers);

    // =========================================================================
    // CHECK 2 — ANALYTICS COVERAGE
    // =========================================================================
    const check2Blockers: string[] = [];
    const qualityWallets: any[] = qualityRaw?.wallets || [];
    const riskWallets: any[] = riskRaw?.wallets || [];
    const confidenceWallets: any[] = confidenceRaw?.wallets || [];
    const styleWallets: any[] = styleRaw?.wallets || [];

    const indexArtifact = (records: any[], name: string): Map<string, any> => {
        const map = new Map<string, any>();
        const seen = new Set<string>();
        for (const item of records) {
            if (!item?.wallet) {
                check2Blockers.push(`Invalid record missing 'wallet' in ${name}`);
                continue;
            }
            const addr = String(item.wallet).trim();
            if (seen.has(addr)) {
                check2Blockers.push(`Duplicate wallet ${addr} detected in ${name}`);
            }
            if (!validAddressSet.has(addr)) {
                check2Blockers.push(`Wallet ${addr} in ${name} is not in valid screening cohort`);
            }
            seen.add(addr);
            map.set(addr, item);
        }
        if (records.length !== 65) {
            check2Blockers.push(`${name} total record count is ${records.length}, expected 65`);
        }
        return map;
    };

    const qualityMap = indexArtifact(qualityWallets, "Quality scores");
    const riskMap = indexArtifact(riskWallets, "Risk scores");
    const confidenceMap = indexArtifact(confidenceWallets, "Confidence scores");
    const styleMap = indexArtifact(styleWallets, "Style classifications");

    let qualityCoverage = 0;
    let riskCoverage = 0;
    let confidenceCoverage = 0;
    let styleCoverage = 0;

    for (const addr of validAddressSet) {
        const q = qualityMap.get(addr);
        if (q && typeof q.qualityScore === "number" && !Number.isNaN(q.qualityScore)) {
            qualityCoverage++;
        } else {
            check2Blockers.push(`Wallet ${addr} missing or invalid in Quality scores`);
        }

        const r = riskMap.get(addr);
        if (r && typeof r.riskScore === "number" && !Number.isNaN(r.riskScore)) {
            riskCoverage++;
        } else {
            check2Blockers.push(`Wallet ${addr} missing or invalid in Risk scores`);
        }

        const c = confidenceMap.get(addr);
        if (c && typeof c.confidenceScore === "number" && !Number.isNaN(c.confidenceScore)) {
            confidenceCoverage++;
        } else {
            check2Blockers.push(`Wallet ${addr} missing or invalid in Confidence scores`);
        }

        const s = styleMap.get(addr);
        if (s && (s.style === "SNIPER" || s.style === "FARMER" || s.style === "MIXED_UNCLASSIFIED")) {
            styleCoverage++;
        } else {
            check2Blockers.push(`Wallet ${addr} missing or invalid in Style classifications`);
        }
    }

    if (qualityCoverage !== 65) check2Blockers.push(`Quality coverage is ${qualityCoverage}/65, expected 65`);
    if (riskCoverage !== 65) check2Blockers.push(`Risk coverage is ${riskCoverage}/65, expected 65`);
    if (confidenceCoverage !== 65) check2Blockers.push(`Confidence coverage is ${confidenceCoverage}/65, expected 65`);
    if (styleCoverage !== 65) check2Blockers.push(`Style coverage is ${styleCoverage}/65, expected 65`);

    const check2Pass = check2Blockers.length === 0;
    allBlockers.push(...check2Blockers);

    // =========================================================================
    // CHECK 3 — SHORTLIST INTEGRITY
    // =========================================================================
    const check3Blockers: string[] = [];
    const qualityScores = validWallets
        .map((w: any) => qualityMap.get(String(w.wallet).trim())?.qualityScore)
        .filter((v): v is number => typeof v === "number" && !Number.isNaN(v))
        .sort((a, b) => a - b);
    const riskScores = validWallets
        .map((w: any) => riskMap.get(String(w.wallet).trim())?.riskScore)
        .filter((v): v is number => typeof v === "number" && !Number.isNaN(v))
        .sort((a, b) => a - b);

    const computedQualityP75 = Number(computePercentile(qualityScores, 75).toFixed(2));
    const computedRiskP25 = Number(computePercentile(riskScores, 25).toFixed(2));
    const computedConfidenceMin = 80;

    // Dynamically calculate shortlist candidates
    const dynamicShortlistWallets: string[] = [];
    for (const w of validWallets) {
        const addr = String(w.wallet).trim();
        const q = qualityMap.get(addr)?.qualityScore ?? 0;
        const r = riskMap.get(addr)?.riskScore ?? 100;
        const c = confidenceMap.get(addr)?.confidenceScore ?? 0;
        const m = w.metrics || {};
        const totalPnl = Number(m.totalPnl ?? 0);
        const profitFactor = Number(m.profitFactor ?? 0);
        const medianPositionPnlPct = Number(m.medianPositionPnlPct ?? 0);

        const qualityPass = q >= computedQualityP75;
        const riskPass = r <= computedRiskP25;
        const confidencePass = c >= computedConfidenceMin;
        const guardrailsPass = totalPnl > 0 && profitFactor > 1 && medianPositionPnlPct > 0;

        if (qualityPass && riskPass && confidencePass && guardrailsPass) {
            dynamicShortlistWallets.push(addr);
        }
    }

    const artifactShortlistRaw: any[] = shortlistRaw?.wallets || [];
    const artifactShortlistWallets = artifactShortlistRaw.map((w: any) => String(w.wallet).trim());

    if (dynamicShortlistWallets.length !== 7) {
        check3Blockers.push(`Dynamic shortlist calculated ${dynamicShortlistWallets.length} wallets, expected 7`);
    }
    if (artifactShortlistWallets.length !== 7) {
        check3Blockers.push(`Shortlist artifact contains ${artifactShortlistWallets.length} wallets, expected 7`);
    }

    // Cross-check thresholds recorded in shortlist artifact against dynamic calculation
    const artifactQualityMin = Number(shortlistRaw?.rule?.qualityMinimum);
    const artifactRiskMax = Number(shortlistRaw?.rule?.riskMaximum);
    const artifactConfMin = Number(shortlistRaw?.rule?.confidenceMinimum);

    const qualityThresholdMatch = Math.abs(artifactQualityMin - computedQualityP75) <= 0.01;
    const riskThresholdMatch = Math.abs(artifactRiskMax - computedRiskP25) <= 0.01;
    const confThresholdMatch = artifactConfMin === computedConfidenceMin;
    const thresholdsMatch = qualityThresholdMatch && riskThresholdMatch && confThresholdMatch;

    if (!qualityThresholdMatch) {
        check3Blockers.push(`Shortlist artifact qualityMinimum (${artifactQualityMin}) != computed P75 (${computedQualityP75})`);
    }
    if (!riskThresholdMatch) {
        check3Blockers.push(`Shortlist artifact riskMaximum (${artifactRiskMax}) != computed P25 (${computedRiskP25})`);
    }
    if (!confThresholdMatch) {
        check3Blockers.push(`Shortlist artifact confidenceMinimum (${artifactConfMin}) != required threshold (${computedConfidenceMin})`);
    }

    const dynamicSet = new Set(dynamicShortlistWallets);
    for (const addr of artifactShortlistWallets) {
        if (!dynamicSet.has(addr)) {
            check3Blockers.push(`Shortlist artifact wallet ${addr} does not match dynamically calculated qualifiers`);
        }
    }
    for (const addr of dynamicShortlistWallets) {
        if (!artifactShortlistWallets.includes(addr)) {
            check3Blockers.push(`Dynamically calculated qualifier ${addr} missing from shortlist artifact`);
        }
    }

    const check3Pass = check3Blockers.length === 0;
    allBlockers.push(...check3Blockers);

    // =========================================================================
    // CHECK 4 — PUBLISHED FRONTEND DATA
    // =========================================================================
    const check4Blockers: string[] = [];
    const publishedWallets: any[] = publishedRaw?.wallets || [];
    const publishedWalletsCount = publishedWallets.length;
    let publishedShortlistedCount = 0;
    let scoreMismatchesCount = 0;
    let performanceMismatchesCount = 0;

    if (publishedWalletsCount !== 65) {
        check4Blockers.push(`Published wallet count is ${publishedWalletsCount}, expected 65`);
    }

    const publishedMap = new Map<string, any>();
    for (const pw of publishedWallets) {
        const addr = String(pw.wallet).trim();
        publishedMap.set(addr, pw);
        if (pw.shortlisted === true) {
            publishedShortlistedCount++;
        }
    }

    if (publishedShortlistedCount !== 7) {
        check4Blockers.push(`Published shortlist count is ${publishedShortlistedCount}, expected 7`);
    }

    for (const w of validWallets) {
        const addr = String(w.wallet).trim();
        const pub = publishedMap.get(addr);
        if (!pub) {
            check4Blockers.push(`Valid wallet ${addr} missing from published intelligence`);
            continue;
        }

        const sourceQ = qualityMap.get(addr)?.qualityScore;
        const sourceR = riskMap.get(addr)?.riskScore;
        const sourceC = confidenceMap.get(addr)?.confidenceScore;
        const sourceS = styleMap.get(addr)?.style;
        const expectedShortlisted = artifactShortlistWallets.includes(addr);

        const qDiff = Math.abs(Number(pub.qualityScore) - Number(sourceQ));
        const rDiff = Math.abs(Number(pub.riskScore) - Number(sourceR));
        const cDiff = Math.abs(Number(pub.confidenceScore) - Number(sourceC));

        if (qDiff > 0.001 || rDiff > 0.001 || cDiff > 0.001 || pub.style !== sourceS || pub.shortlisted !== expectedShortlisted) {
            scoreMismatchesCount++;
            check4Blockers.push(`Score/style/shortlist mismatch on wallet ${addr}`);
        }

        // Verify contextual performance fields
        const m = w.metrics || {};
        const p = pub.performance || {};
        const pnlDiff = Math.abs(Number(p.totalPnl) - Number(m.totalPnl));
        const pfDiff = Math.abs(Number(p.profitFactor) - Number(m.profitFactor));
        const medDiff = Math.abs(Number(p.medianPositionPnlPct) - Number(m.medianPositionPnlPct));
        const winDiff = Math.abs(Number(p.positionWinRate) - Number(m.positionWinRate));
        const posDiff = Math.abs(Number(p.closedPositionCount) - Number(m.closedPositionCount));
        const concDiff = Math.abs(Number(p.pnlConcentrationTop1) - Number(m.pnlConcentrationTop1));

        if (pnlDiff > 0.001 || pfDiff > 0.001 || medDiff > 0.001 || winDiff > 0.001 || posDiff > 0 || concDiff > 0.001) {
            performanceMismatchesCount++;
            check4Blockers.push(`Contextual performance mismatch on wallet ${addr}`);
        }
    }

    const check4Pass = check4Blockers.length === 0;
    allBlockers.push(...check4Blockers);

    // =========================================================================
    // CHECK 5 — SCORE SEMANTICS
    // =========================================================================
    const check5Blockers: string[] = [];
    let scoreBoundsPass = true;
    let styleValuesValid = true;
    let shortlistBooleanValid = true;
    const forbiddenCompositeFields = [
        "finalScore",
        "copyScore",
        "qualityMinusRisk",
        "weightedScore",
        "confidenceWeightedQuality",
        "compositeScore",
        "rankScore",
        "totalScore",
        "rankingScore",
        "blendedScore",
    ];
    const forbiddenCompositeFieldsFound: string[] = [];

    for (const pw of publishedWallets) {
        if (
            typeof pw.qualityScore !== "number" ||
            pw.qualityScore < 0 ||
            pw.qualityScore > 100 ||
            typeof pw.riskScore !== "number" ||
            pw.riskScore < 0 ||
            pw.riskScore > 100 ||
            typeof pw.confidenceScore !== "number" ||
            pw.confidenceScore < 0 ||
            pw.confidenceScore > 100
        ) {
            scoreBoundsPass = false;
            check5Blockers.push(`Score out of [0, 100] bounds for wallet ${pw.wallet}`);
        }

        if (pw.style !== "SNIPER" && pw.style !== "FARMER" && pw.style !== "MIXED_UNCLASSIFIED") {
            styleValuesValid = false;
            check5Blockers.push(`Invalid style '${pw.style}' for wallet ${pw.wallet}`);
        }

        if (typeof pw.shortlisted !== "boolean") {
            shortlistBooleanValid = false;
            check5Blockers.push(`Shortlisted field is not boolean for wallet ${pw.wallet}`);
        }

        for (const forbidden of forbiddenCompositeFields) {
            if (forbidden in pw && !forbiddenCompositeFieldsFound.includes(forbidden)) {
                forbiddenCompositeFieldsFound.push(forbidden);
                check5Blockers.push(`Forbidden composite field '${forbidden}' detected in wallet record`);
            }
        }
    }

    // Check top-level dataset keys for forbidden composite scores
    for (const forbidden of forbiddenCompositeFields) {
        if (forbidden in publishedRaw && !forbiddenCompositeFieldsFound.includes(forbidden)) {
            forbiddenCompositeFieldsFound.push(forbidden);
            check5Blockers.push(`Forbidden composite field '${forbidden}' detected in published dataset`);
        }
    }

    // Check semantics definitions in source artifacts
    let semanticsSeparationPass = true;
    if (riskRaw?.semantics?.higherScoreMeans !== "higher_observed_historical_risk") {
        semanticsSeparationPass = false;
        check5Blockers.push("Risk scores artifact semantics missing or incorrect (expected 'higher_observed_historical_risk')");
    }
    if (confidenceRaw?.semantics?.higherScoreMeans !== "stronger_historical_evidence") {
        semanticsSeparationPass = false;
        check5Blockers.push("Confidence scores artifact semantics missing or incorrect (expected 'stronger_historical_evidence')");
    }
    if (!shortlistRaw?.semantics?.styleNote || !shortlistRaw.semantics.styleNote.includes("descriptive")) {
        semanticsSeparationPass = false;
        check5Blockers.push("Shortlist artifact missing descriptive style semantics note");
    }
    if (!shortlistRaw?.semantics?.orderingNote || !shortlistRaw.semantics.orderingNote.includes("No composite ranking")) {
        semanticsSeparationPass = false;
        check5Blockers.push("Shortlist artifact missing no composite ranking semantics note");
    }

    const check5Pass = check5Blockers.length === 0;
    allBlockers.push(...check5Blockers);

    // =========================================================================
    // CHECK 6 — FRONTEND INTEGRATION
    // =========================================================================
    const check6Blockers: string[] = [];
    const walletDataTsPath = path.join(frontendDir, "lib/walletData.ts");
    const appTsxPath = path.join(frontendDir, "App.tsx");
    const walletTableTsxPath = path.join(frontendDir, "components/WalletTable.tsx");
    const portfolioPageTsxPath = path.join(frontendDir, "pages/PortfolioPage.tsx");

    let walletDataContent = "";
    let appContent = "";
    let walletTableContent = "";
    let portfolioPageContent = "";

    try {
        walletDataContent = fs.readFileSync(walletDataTsPath, "utf8");
    } catch {
        check6Blockers.push(`Cannot read ${walletDataTsPath}`);
    }
    try {
        appContent = fs.readFileSync(appTsxPath, "utf8");
    } catch {
        check6Blockers.push(`Cannot read ${appTsxPath}`);
    }
    try {
        walletTableContent = fs.readFileSync(walletTableTsxPath, "utf8");
    } catch {
        check6Blockers.push(`Cannot read ${walletTableTsxPath}`);
    }
    try {
        portfolioPageContent = fs.readFileSync(portfolioPageTsxPath, "utf8");
    } catch {
        check6Blockers.push(`Cannot read ${portfolioPageTsxPath}`);
    }

    const consumesPublishedJson =
        walletDataContent.includes("/data/wallet-intelligence-v1.json") &&
        appContent.includes("loadWalletIntelligenceV1") &&
        appContent.includes("joinWalletsWithIntelligenceV1");

    if (!consumesPublishedJson) {
        check6Blockers.push("Frontend does not consume /data/wallet-intelligence-v1.json properly");
    }

    const tableWired =
        walletTableContent.includes("shortlist") &&
        walletTableContent.includes("quality") &&
        walletTableContent.includes("risk") &&
        walletTableContent.includes("confidence") &&
        walletTableContent.includes("style");

    const portfolioWired =
        portfolioPageContent.includes("qualityScore") &&
        portfolioPageContent.includes("riskScore") &&
        portfolioPageContent.includes("confidenceScore") &&
        portfolioPageContent.includes("shortlisted") &&
        portfolioPageContent.includes("performance");

    const v1FieldsWired = tableWired && portfolioWired;
    if (!v1FieldsWired) {
        check6Blockers.push("V1 fields (Quality/Risk/Confidence/Style/Shortlist) are not fully wired into UI");
    }

    // Verify no fake zero fallback (unscored wallets should display '—', null preserved)
    const noFakeZeroFallback =
        walletDataContent.includes("intelligenceV1: null") &&
        walletTableContent.includes('"—"');
    if (!noFakeZeroFallback) {
        check6Blockers.push("Fake zero fallback detected or null not preserved for unscored wallets");
    }

    // Verify missing intelligence does not crash existing wallet data
    const missingIntelligenceGraceful =
        walletDataContent.includes("loadWalletIntelligenceV1") &&
        walletDataContent.includes("catch") &&
        (appContent.includes("loadWalletIntelligenceV1().catch") || appContent.includes("loadWalletIntelligenceV1()"));
    if (!missingIntelligenceGraceful) {
        check6Blockers.push("Missing intelligence error handling not found (could crash wallet data)");
    }

    // Verify existing default sort is preserved in App.tsx (default is "pnl7", not auto-ranked by V1 scores)
    const defaultOrderingPreserved =
        appContent.includes('useState<WalletSortKey>("pnl7")') &&
        !appContent.includes('useState<WalletSortKey>("quality")') &&
        !appContent.includes('useState<WalletSortKey>("shortlist")');
    if (!defaultOrderingPreserved) {
        check6Blockers.push("Default table ordering not preserved (auto-ranking detected)");
    }

    const noAutoRankingByV1Scores = defaultOrderingPreserved;

    // Verify shortlist status does not automatically reorder wallets
    const noAutoShortlistReorder =
        appContent.includes('useState<WalletSortKey>("pnl7")') &&
        !appContent.includes('useState<WalletSortKey>("shortlist")') &&
        !appContent.includes('filter((w) => w.intelligenceV1?.shortlisted)');
    if (!noAutoShortlistReorder) {
        check6Blockers.push("Shortlist status automatically filters or reorders wallets");
    }

    const check6Pass = check6Blockers.length === 0;
    allBlockers.push(...check6Blockers);

    const overallPass =
        check1Pass &&
        check2Pass &&
        check3Pass &&
        check4Pass &&
        check5Pass &&
        check6Pass;

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        status: overallPass ? "V1_COMPLETE" : "V1_NOT_COMPLETE",
        check1Population: {
            pass: check1Pass,
            candidateCount,
            validCount,
            invalidCount,
            sumMatches,
            duplicateValidCount: duplicateValidAddresses.length,
            blockers: check1Blockers,
        },
        check2AnalyticsCoverage: {
            pass: check2Pass,
            qualityCoverage,
            riskCoverage,
            confidenceCoverage,
            styleCoverage,
            expectedCount: 65,
            blockers: check2Blockers,
        },
        check3Shortlist: {
            pass: check3Pass,
            computedQualityP75,
            computedRiskP25,
            computedConfidenceMin,
            dynamicShortlistCount: dynamicShortlistWallets.length,
            artifactShortlistCount: artifactShortlistWallets.length,
            dynamicShortlistWallets,
            artifactShortlistWallets,
            thresholdsMatch,
            blockers: check3Blockers,
        },
        check4PublishedData: {
            pass: check4Pass,
            publishedWalletsCount,
            publishedShortlistedCount,
            scoreMismatchesCount,
            performanceMismatchesCount,
            blockers: check4Blockers,
        },
        check5ScoreSemantics: {
            pass: check5Pass,
            scoreBoundsPass,
            forbiddenCompositeFieldsFound,
            styleValuesValid,
            shortlistBooleanValid,
            semanticsSeparationPass,
            blockers: check5Blockers,
        },
        check6FrontendIntegration: {
            pass: check6Pass,
            consumesPublishedJson,
            v1FieldsWired,
            noFakeZeroFallback,
            missingIntelligenceGraceful,
            defaultOrderingPreserved,
            noAutoRankingByV1Scores,
            noAutoShortlistReorder,
            blockers: check6Blockers,
        },
        allBlockers,
    };
}

export function printEndToEndAuditReport(report: EndToEndAuditReport): void {
    console.log("==================================================");
    console.log("V1 — FINAL END-TO-END AUDIT");
    console.log("==================================================");
    console.log("");
    console.log(`Population                     : ${report.check1Population.pass ? "PASS" : "FAIL"}`);
    console.log(`  • Candidates                 : ${report.check1Population.candidateCount} / 83`);
    console.log(`  • Valid Wallets              : ${report.check1Population.validCount} / 65`);
    console.log(`  • Invalid Wallets            : ${report.check1Population.invalidCount} / 18`);
    console.log(`  • Valid + Invalid = Total    : ${report.check1Population.sumMatches ? "PASS" : "FAIL"}`);
    console.log(`  • Duplicate Valid Wallets    : ${report.check1Population.duplicateValidCount}`);
    console.log("");
    console.log(`Analytics Coverage             : ${report.check2AnalyticsCoverage.pass ? "PASS" : "FAIL"}`);
    console.log(`  • Quality Scores Coverage    : ${report.check2AnalyticsCoverage.qualityCoverage} / 65`);
    console.log(`  • Risk Scores Coverage       : ${report.check2AnalyticsCoverage.riskCoverage} / 65`);
    console.log(`  • Confidence Scores Coverage : ${report.check2AnalyticsCoverage.confidenceCoverage} / 65`);
    console.log(`  • Style Classifications      : ${report.check2AnalyticsCoverage.styleCoverage} / 65`);
    console.log("");
    console.log(`Shortlist Integrity            : ${report.check3Shortlist.pass ? "PASS" : "FAIL"}`);
    console.log(`  • Dynamic STRICT Qualifiers  : ${report.check3Shortlist.dynamicShortlistCount}`);
    console.log(`  • Artifact Shortlist Count   : ${report.check3Shortlist.artifactShortlistCount}`);
    console.log(`  • Quality Threshold (P75)    : >= ${report.check3Shortlist.computedQualityP75}`);
    console.log(`  • Risk Threshold (P25)       : <= ${report.check3Shortlist.computedRiskP25}`);
    console.log(`  • Confidence Threshold       : >= ${report.check3Shortlist.computedConfidenceMin}`);
    console.log(`  • Thresholds Match Artifact  : ${report.check3Shortlist.thresholdsMatch ? "PASS" : "FAIL"}`);
    console.log("");
    console.log(`Published Artifact Integrity   : ${report.check4PublishedData.pass ? "PASS" : "FAIL"}`);
    console.log(`  • Published Valid Wallets    : ${report.check4PublishedData.publishedWalletsCount} / 65`);
    console.log(`  • Published Shortlisted      : ${report.check4PublishedData.publishedShortlistedCount} / 7`);
    console.log(`  • Score/Style Join Mismatches: ${report.check4PublishedData.scoreMismatchesCount}`);
    console.log(`  • Contextual Perf Mismatches : ${report.check4PublishedData.performanceMismatchesCount}`);
    console.log("");
    console.log(`Frontend Integration           : ${report.check6FrontendIntegration.pass ? "PASS" : "FAIL"}`);
    console.log(`  • Consumes /data/...-v1.json : ${report.check6FrontendIntegration.consumesPublishedJson ? "PASS" : "FAIL"}`);
    console.log(`  • V1 Fields Wired in UI      : ${report.check6FrontendIntegration.v1FieldsWired ? "PASS" : "FAIL"}`);
    console.log(`  • No Fake Zero Fallback      : ${report.check6FrontendIntegration.noFakeZeroFallback ? "PASS" : "FAIL"}`);
    console.log(`  • Missing Intel Handled      : ${report.check6FrontendIntegration.missingIntelligenceGraceful ? "PASS" : "FAIL"}`);
    console.log(`  • Default Ordering Preserved : ${report.check6FrontendIntegration.defaultOrderingPreserved ? "PASS" : "FAIL"}`);
    console.log(`  • No Auto-Ranking by Scores  : ${report.check6FrontendIntegration.noAutoRankingByV1Scores ? "PASS" : "FAIL"}`);
    console.log(`  • No Auto-Shortlist Reorder  : ${report.check6FrontendIntegration.noAutoShortlistReorder ? "PASS" : "FAIL"}`);
    console.log("");
    console.log(`Score Semantics                : ${report.check5ScoreSemantics.pass ? "PASS" : "FAIL"}`);
    console.log(`  • Score Bounds (0..100)      : ${report.check5ScoreSemantics.scoreBoundsPass ? "PASS" : "FAIL"}`);
    console.log(`  • Forbidden Composite Fields : ${report.check5ScoreSemantics.forbiddenCompositeFieldsFound.length === 0 ? "NONE (PASS)" : report.check5ScoreSemantics.forbiddenCompositeFieldsFound.join(", ")}`);
    console.log(`  • Style Values Valid         : ${report.check5ScoreSemantics.styleValuesValid ? "PASS" : "FAIL"}`);
    console.log(`  • Shortlist Boolean Valid    : ${report.check5ScoreSemantics.shortlistBooleanValid ? "PASS" : "FAIL"}`);
    console.log(`  • Semantics Separation Valid : ${report.check5ScoreSemantics.semanticsSeparationPass ? "PASS" : "FAIL"}`);
    console.log("");
    console.log("==================================================");
    console.log("FINAL VERDICT:");
    console.log(report.status);
    console.log("==================================================");

    if (report.allBlockers.length > 0) {
        console.log("\nEXACT BLOCKERS:");
        for (const b of report.allBlockers) {
            console.log(`• ${b}`);
        }
    }
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    const requiredPaths = [
        { label: "Screening dataset", p: cli.datasetPath },
        { label: "Quality scores", p: cli.qualityPath },
        { label: "Risk scores", p: cli.riskPath },
        { label: "Confidence scores", p: cli.confidencePath },
        { label: "Style classifications", p: cli.stylePath },
        { label: "Shortlist", p: cli.shortlistPath },
        { label: "Published intelligence", p: cli.publishedPath },
    ];

    for (const req of requiredPaths) {
        if (!fs.existsSync(req.p)) {
            throw new Error(`Required file not found (${req.label}): ${req.p}`);
        }
    }

    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const qualityRaw = JSON.parse(fs.readFileSync(cli.qualityPath, "utf8"));
    const riskRaw = JSON.parse(fs.readFileSync(cli.riskPath, "utf8"));
    const confidenceRaw = JSON.parse(fs.readFileSync(cli.confidencePath, "utf8"));
    const styleRaw = JSON.parse(fs.readFileSync(cli.stylePath, "utf8"));
    const shortlistRaw = JSON.parse(fs.readFileSync(cli.shortlistPath, "utf8"));
    const publishedRaw = JSON.parse(fs.readFileSync(cli.publishedPath, "utf8"));

    const report = runV1EndToEndAudit(
        datasetRaw,
        qualityRaw,
        riskRaw,
        confidenceRaw,
        styleRaw,
        shortlistRaw,
        publishedRaw,
        cli.frontendDir
    );

    atomicWriteJson(cli.outputPath, report);

    printEndToEndAuditReport(report);

    if (report.status !== "V1_COMPLETE") {
        process.exit(1);
    }
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-v1-end-to-end.ts") ||
        process.argv[1].endsWith("audit-v1-end-to-end.js") ||
        process.argv[1].includes("audit-v1-end-to-end"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] End-to-end audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
