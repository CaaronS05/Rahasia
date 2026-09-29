import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    scoresFile: string;
    skillFile: string;
    confidenceFile: string;
    styleFile: string;
    behaviourFile: string;
    masterFile: string;
    outputFile: string;
}

interface Discrepancy {
    wallet: string;
    field: string;
    stored: any;
    expected: any;
    diff?: number | null;
    message: string;
}

interface WalletScoresAuditOutput {
    generatedAt: string;
    artifact: string;
    auditPassed: boolean;

    membershipAudit: {
        status: "PASS" | "FAIL";
        walletScoresCount: number;
        skillCount: number;
        confidenceCount: number;
        styleCount: number;
        behaviourCount: number;
        missingWallets: string[];
        extraWallets: string[];
        duplicateWallets: string[];
        deterministicOrderPreserved: boolean;
    };

    skillIntegrityAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        versionValid: boolean;
        provisionalFlagValid: boolean;
        discrepancies: Discrepancy[];
    };

    confidenceIntegrityAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        confidenceSeparatedFromSkill: boolean;
        confidenceMixingDetected: boolean;
        discrepancies: Discrepancy[];
    };

    styleIntegrityAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        versionValid: boolean;
        provisionalFlagValid: boolean;
        disallowedStylesDetected: string[];
        discrepancies: Discrepancy[];
    };

    metricsIntegrityAudit: {
        status: "PASS" | "FAIL";
        walletsAudited: number;
        discrepancies: Discrepancy[];
    };

    temporalContractAudit: {
        status: "PASS" | "FAIL";
        temporalContract: string;
        isSameClosedPositionPopulation: boolean;
        externalMetricsIncluded: boolean;
    };

    provisionalStatusAudit: {
        status: "PASS" | "FAIL";
        declaredStatus: string;
        isProvisional: boolean;
        skillVersion: string;
        styleVersion: string;
    };

    masterSafetyAudit: {
        status: "PASS" | "FAIL";
        masterFileExists: boolean;
        masterFileSeparated: boolean;
        masterFileModifiedByScoring: boolean;
    };

    frontendSafetyAudit: {
        status: "PASS" | "FAIL";
        frontendPublished: boolean;
        safePrePublishState: boolean;
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
        scoresFile:
            options.scores ||
            options["scores-file"] ||
            path.resolve("data/master/wallet-scores.json"),
        skillFile:
            options.skill ||
            options["skill-file"] ||
            path.resolve("data/discovery/waldisc-2/aligned-skill-score-v1-2.json"),
        confidenceFile:
            options.confidence ||
            options["confidence-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-confidence.json"),
        styleFile:
            options.style ||
            options["style-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-style-v0-1.json"),
        behaviourFile:
            options.behaviour ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        masterFile:
            options.master ||
            options["master-file"] ||
            path.resolve("data/master/wallets-master.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-scores-audit.json"),
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

async function main() {
    const {
        scoresFile,
        skillFile,
        confidenceFile,
        styleFile,
        behaviourFile,
        masterFile,
        outputFile,
    } = parseCliArgs();

    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    // Load inputs
    const scoresData = tryReadJson(scoresFile);
    if (!scoresData || !Array.isArray(scoresData.scores)) {
        throw new Error(`Invalid or missing scores master artifact: ${scoresFile}`);
    }

    const skillData = tryReadJson(skillFile);
    if (!skillData || !Array.isArray(skillData.wallets)) {
        throw new Error(`Invalid or missing skill source: ${skillFile}`);
    }

    const confidenceData = tryReadJson(confidenceFile);
    if (!confidenceData || !Array.isArray(confidenceData.wallets)) {
        throw new Error(`Invalid or missing confidence source: ${confidenceFile}`);
    }

    const styleData = tryReadJson(styleFile);
    if (!styleData || !Array.isArray(styleData.wallets)) {
        throw new Error(`Invalid or missing style source: ${styleFile}`);
    }

    const behaviourData = tryReadJson(behaviourFile);
    if (!behaviourData || !Array.isArray(behaviourData.wallets)) {
        throw new Error(`Invalid or missing behaviour source: ${behaviourFile}`);
    }

    const scoresList: any[] = scoresData.scores;
    const scoreWallets = scoresList.map((s) => s.wallet);

    const skillMap = new Map<string, any>();
    for (const w of skillData.wallets) skillMap.set(w.wallet, w);

    const confidenceMap = new Map<string, any>();
    for (const w of confidenceData.wallets) confidenceMap.set(w.wallet, w);

    const styleMap = new Map<string, any>();
    for (const w of styleData.wallets) styleMap.set(w.wallet, w);

    const behaviourMap = new Map<string, any>();
    for (const w of behaviourData.wallets) behaviourMap.set(w.wallet, w);

    // ==================================================
    // AUDIT 1 — COHORT MEMBERSHIP
    // ==================================================
    const behaviourWallets = behaviourData.wallets.map((w: any) => w.wallet);
    const skillWallets = skillData.wallets.map((w: any) => w.wallet);
    const confidenceWallets = confidenceData.wallets.map((w: any) => w.wallet);
    const styleWallets = styleData.wallets.map((w: any) => w.wallet);

    const missingWallets: string[] = [];
    const extraWallets: string[] = [];

    for (const bw of behaviourWallets) {
        if (!scoreWallets.includes(bw)) missingWallets.push(bw);
    }
    for (const sw of scoreWallets) {
        if (!behaviourWallets.includes(sw)) extraWallets.push(sw);
    }

    const duplicateWallets = scoreWallets.filter(
        (w, idx) => scoreWallets.indexOf(w) !== idx
    );

    let deterministicOrderPreserved = true;
    for (let i = 0; i < Math.min(behaviourWallets.length, scoreWallets.length); i++) {
        if (behaviourWallets[i] !== scoreWallets[i]) {
            deterministicOrderPreserved = false;
            break;
        }
    }

    if (missingWallets.length > 0) {
        blockingIssues.push(`Wallets missing from wallet-scores: ${missingWallets.join(", ")}`);
    }
    if (extraWallets.length > 0) {
        blockingIssues.push(`Extra wallets in wallet-scores: ${extraWallets.join(", ")}`);
    }
    if (duplicateWallets.length > 0) {
        blockingIssues.push(`Duplicate wallets in wallet-scores: ${duplicateWallets.join(", ")}`);
    }
    if (!deterministicOrderPreserved) {
        blockingIssues.push("Deterministic wallet order from behaviour dataset was not preserved in wallet-scores.");
    }

    const membershipAuditStatus =
        missingWallets.length === 0 &&
        extraWallets.length === 0 &&
        duplicateWallets.length === 0 &&
        deterministicOrderPreserved
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 2 — SKILL INTEGRITY
    // ==================================================
    const skillDiscrepancies: Discrepancy[] = [];
    let skillVersionValid = true;
    let skillProvisionalFlagValid = true;

    for (const item of scoresList) {
        const addr = item.wallet;
        const sourceSkill = skillMap.get(addr);

        if (!sourceSkill) {
            skillDiscrepancies.push({
                wallet: addr,
                field: "skill",
                stored: item.skill,
                expected: null,
                message: "Wallet missing from source skill artifact",
            });
            blockingIssues.push(`[${addr}] Missing from source skill artifact.`);
            continue;
        }

        const storedScore = item.skill?.score;
        const expectedScore = sourceSkill.skillScoreV1_2;

        if (storedScore === null && expectedScore === null) {
            // Match
        } else if (
            typeof storedScore === "number" &&
            typeof expectedScore === "number" &&
            Math.abs(storedScore - expectedScore) < 1e-9
        ) {
            // Match
        } else {
            const diff =
                storedScore !== null && expectedScore !== null
                    ? Math.abs(storedScore - expectedScore)
                    : null;
            skillDiscrepancies.push({
                wallet: addr,
                field: "skill.score",
                stored: storedScore,
                expected: expectedScore,
                diff,
                message: `Stored skill score ${storedScore} does not match authoritative source ${expectedScore}`,
            });
            blockingIssues.push(`[${addr}] Skill score mismatch: stored=${storedScore}, expected=${expectedScore}`);
        }

        if (item.skill?.version !== "v1.2-provisional") {
            skillVersionValid = false;
            blockingIssues.push(`[${addr}] Invalid skill version: ${item.skill?.version}`);
        }
        if (item.skill?.provisional !== true) {
            skillProvisionalFlagValid = false;
            blockingIssues.push(`[${addr}] Skill provisional flag must be true.`);
        }
    }

    const skillIntegrityAuditStatus =
        skillDiscrepancies.length === 0 &&
        skillVersionValid &&
        skillProvisionalFlagValid
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 3 — CONFIDENCE INTEGRITY
    // ==================================================
    const confidenceDiscrepancies: Discrepancy[] = [];
    let confidenceMixingDetected = false;

    for (const item of scoresList) {
        const addr = item.wallet;
        const sourceConf = confidenceMap.get(addr);

        if (!sourceConf) {
            confidenceDiscrepancies.push({
                wallet: addr,
                field: "confidence",
                stored: item.confidence,
                expected: null,
                message: "Wallet missing from source confidence artifact",
            });
            blockingIssues.push(`[${addr}] Missing from source confidence artifact.`);
            continue;
        }

        const expectedGen = sourceConf.confidence?.generalPct ?? null;
        const expectedPerf = sourceConf.confidence?.performancePct ?? null;
        const expectedRange = sourceConf.confidence?.rangePct ?? null;

        const storedGen = item.confidence?.generalPct ?? null;
        const storedPerf = item.confidence?.performancePct ?? null;
        const storedRange = item.confidence?.rangePct ?? null;

        if (
            (storedGen !== null || expectedGen !== null) &&
            Math.abs((storedGen ?? -1) - (expectedGen ?? -2)) > 1e-6
        ) {
            confidenceDiscrepancies.push({
                wallet: addr,
                field: "confidence.generalPct",
                stored: storedGen,
                expected: expectedGen,
                message: `General confidence mismatch: stored=${storedGen}, expected=${expectedGen}`,
            });
            blockingIssues.push(`[${addr}] General confidence mismatch.`);
        }

        if (
            (storedPerf !== null || expectedPerf !== null) &&
            Math.abs((storedPerf ?? -1) - (expectedPerf ?? -2)) > 1e-6
        ) {
            confidenceDiscrepancies.push({
                wallet: addr,
                field: "confidence.performancePct",
                stored: storedPerf,
                expected: expectedPerf,
                message: `Performance confidence mismatch: stored=${storedPerf}, expected=${expectedPerf}`,
            });
            blockingIssues.push(`[${addr}] Performance confidence mismatch.`);
        }

        if (
            (storedRange !== null || expectedRange !== null) &&
            Math.abs((storedRange ?? -1) - (expectedRange ?? -2)) > 1e-6
        ) {
            confidenceDiscrepancies.push({
                wallet: addr,
                field: "confidence.rangePct",
                stored: storedRange,
                expected: expectedRange,
                message: `Range confidence mismatch: stored=${storedRange}, expected=${expectedRange}`,
            });
            blockingIssues.push(`[${addr}] Range confidence mismatch.`);
        }

        // Verify no confidence mixing
        if (
            "adjustedSkillScore" in item ||
            "confidenceWeightedScore" in item ||
            "combinedScore" in item
        ) {
            confidenceMixingDetected = true;
            blockingIssues.push(`[${addr}] Confidence mixing detected: forbidden fields found.`);
        }
    }

    const confidenceIntegrityAuditStatus =
        confidenceDiscrepancies.length === 0 && !confidenceMixingDetected
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 4 — STYLE INTEGRITY
    // ==================================================
    const styleDiscrepancies: Discrepancy[] = [];
    const disallowedStyles: string[] = [];
    let styleVersionValid = true;
    let styleProvisionalFlagValid = true;

    for (const item of scoresList) {
        const addr = item.wallet;
        const sourceStyle = styleMap.get(addr);

        if (!sourceStyle) {
            styleDiscrepancies.push({
                wallet: addr,
                field: "style",
                stored: item.style,
                expected: null,
                message: "Wallet missing from source style artifact",
            });
            blockingIssues.push(`[${addr}] Missing from source style artifact.`);
            continue;
        }

        const storedTag = item.style?.tag;
        const expectedTag = sourceStyle.styleTag;

        if (storedTag !== expectedTag) {
            styleDiscrepancies.push({
                wallet: addr,
                field: "style.tag",
                stored: storedTag,
                expected: expectedTag,
                message: `Style tag mismatch: stored=${storedTag}, expected=${expectedTag}`,
            });
            blockingIssues.push(`[${addr}] Style tag mismatch: stored=${storedTag}, expected=${expectedTag}`);
        }

        if (storedTag !== "farmer" && storedTag !== "mixed_unclassified") {
            disallowedStyles.push(`${addr}: ${storedTag}`);
            blockingIssues.push(`[${addr}] Disallowed style tag assigned: ${storedTag}`);
        }

        if (item.style?.version !== "v0.1-provisional") {
            styleVersionValid = false;
            blockingIssues.push(`[${addr}] Invalid style version: ${item.style?.version}`);
        }
        if (item.style?.provisional !== true) {
            styleProvisionalFlagValid = false;
            blockingIssues.push(`[${addr}] Style provisional flag must be true.`);
        }
    }

    const styleIntegrityAuditStatus =
        styleDiscrepancies.length === 0 &&
        disallowedStyles.length === 0 &&
        styleVersionValid &&
        styleProvisionalFlagValid
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 5 — SUPPORTING METRICS
    // ==================================================
    const metricsDiscrepancies: Discrepancy[] = [];

    for (const item of scoresList) {
        const addr = item.wallet;
        const bw = behaviourMap.get(addr);

        if (!bw) continue;

        const m = item.metrics;
        if (!m) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics",
                stored: null,
                expected: {},
                message: "Missing metrics block",
            });
            blockingIssues.push(`[${addr}] Missing metrics block.`);
            continue;
        }

        // 1. winRatePosition
        const expWin = bw.performance?.winRatePct ?? null;
        if (
            (m.winRatePosition !== null || expWin !== null) &&
            Math.abs((m.winRatePosition ?? -1) - (expWin ?? -2)) > 1e-6
        ) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics.winRatePosition",
                stored: m.winRatePosition,
                expected: expWin,
                message: `winRatePosition mismatch: stored=${m.winRatePosition}, expected=${expWin}`,
            });
            blockingIssues.push(`[${addr}] winRatePosition mismatch.`);
        }

        // 2. pnlConcentrationTop1Pct
        const expConc = bw.performance?.top1PositiveProfitSharePct ?? null;
        if (
            (m.pnlConcentrationTop1Pct !== null || expConc !== null) &&
            Math.abs((m.pnlConcentrationTop1Pct ?? -1) - (expConc ?? -2)) > 1e-6
        ) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics.pnlConcentrationTop1Pct",
                stored: m.pnlConcentrationTop1Pct,
                expected: expConc,
                message: `pnlConcentrationTop1Pct mismatch: stored=${m.pnlConcentrationTop1Pct}, expected=${expConc}`,
            });
            blockingIssues.push(`[${addr}] pnlConcentrationTop1Pct mismatch.`);
        }

        // 3. medianHoldDurationHours
        const expHold = bw.holdingBehaviour?.medianDurationHours ?? null;
        if (
            (m.medianHoldDurationHours !== null || expHold !== null) &&
            Math.abs((m.medianHoldDurationHours ?? -1) - (expHold ?? -2)) > 1e-6
        ) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics.medianHoldDurationHours",
                stored: m.medianHoldDurationHours,
                expected: expHold,
                message: `medianHoldDurationHours mismatch: stored=${m.medianHoldDurationHours}, expected=${expHold}`,
            });
            blockingIssues.push(`[${addr}] medianHoldDurationHours mismatch.`);
        }

        // 4. trueRebalanceFrequency
        const expRebal = bw.rebalanceBehaviour?.trueRebalancePositionPct ?? null;
        if (
            (m.trueRebalanceFrequency !== null || expRebal !== null) &&
            Math.abs((m.trueRebalanceFrequency ?? -1) - (expRebal ?? -2)) > 1e-6
        ) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics.trueRebalanceFrequency",
                stored: m.trueRebalanceFrequency,
                expected: expRebal,
                message: `trueRebalanceFrequency mismatch: stored=${m.trueRebalanceFrequency}, expected=${expRebal}`,
            });
            blockingIssues.push(`[${addr}] trueRebalanceFrequency mismatch.`);
        }

        // 5. sampleSize
        const expSample = bw.closedPositions;
        if (m.sampleSize !== expSample) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics.sampleSize",
                stored: m.sampleSize,
                expected: expSample,
                message: `sampleSize mismatch: stored=${m.sampleSize}, expected=${expSample}`,
            });
            blockingIssues.push(`[${addr}] sampleSize mismatch.`);
        }

        // 6. uniquePools
        const expPools = bw.uniquePools;
        if (m.uniquePools !== expPools) {
            metricsDiscrepancies.push({
                wallet: addr,
                field: "metrics.uniquePools",
                stored: m.uniquePools,
                expected: expPools,
                message: `uniquePools mismatch: stored=${m.uniquePools}, expected=${expPools}`,
            });
            blockingIssues.push(`[${addr}] uniquePools mismatch.`);
        }
    }

    const metricsIntegrityAuditStatus =
        metricsDiscrepancies.length === 0 ? "PASS" : "FAIL";

    // ==================================================
    // AUDIT 7 — TEMPORAL CONTRACT METADATA
    // ==================================================
    const temporalContract = scoresData.methodology?.skillTemporalContract;
    const isSameClosedPositionPopulation =
        temporalContract === "same_closed_position_population";

    let externalMetricsIncluded = false;
    for (const item of scoresList) {
        if ("roiAvgInflow" in (item.metrics || {}) || "masterProfitFactor" in (item.metrics || {})) {
            externalMetricsIncluded = true;
            blockingIssues.push(`[${item.wallet}] External master metrics leaked into wallet-scores metrics.`);
        }
    }

    if (!isSameClosedPositionPopulation) {
        blockingIssues.push(`Temporal contract must be "same_closed_position_population", got: ${temporalContract}`);
    }

    const temporalContractAuditStatus =
        isSameClosedPositionPopulation && !externalMetricsIncluded
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 8 — PROVISIONAL STATUS
    // ==================================================
    const declaredStatus = scoresData.status;
    const isProvisional = declaredStatus === "PROVISIONAL";

    const skillVersion = scoresData.versions?.skill;
    const styleVersion = scoresData.versions?.style;

    if (!isProvisional) {
        blockingIssues.push(`Status must be "PROVISIONAL", got: ${declaredStatus}`);
    }
    if (skillVersion !== "v1.2-provisional") {
        blockingIssues.push(`Skill version must be "v1.2-provisional", got: ${skillVersion}`);
    }
    if (styleVersion !== "v0.1-provisional") {
        blockingIssues.push(`Style version must be "v0.1-provisional", got: ${styleVersion}`);
    }

    const provisionalStatusAuditStatus =
        isProvisional &&
        skillVersion === "v1.2-provisional" &&
        styleVersion === "v0.1-provisional"
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 9 — MASTER SAFETY
    // ==================================================
    const masterFileExists = fs.existsSync(masterFile);
    const masterFileSeparated =
        path.resolve(scoresFile) !== path.resolve(masterFile);

    let masterFileModifiedByScoring = false;
    if (masterFileExists) {
        try {
            const masterStat = fs.statSync(masterFile);
            // Verify master file is still large and intact
            if (masterStat.size < 1000000) {
                masterFileModifiedByScoring = true;
                blockingIssues.push("wallets-master.json appears corrupted or truncated.");
            }
        } catch {
            masterFileModifiedByScoring = true;
            blockingIssues.push("Could not stat wallets-master.json.");
        }
    } else {
        blockingIssues.push("wallets-master.json not found.");
    }

    const masterSafetyAuditStatus =
        masterFileExists && masterFileSeparated && !masterFileModifiedByScoring
            ? "PASS"
            : "FAIL";

    // ==================================================
    // AUDIT 10 — FRONTEND SAFETY
    // ==================================================
    const frontendPublished = scoresData.methodology?.frontendPublished ?? true;
    const safePrePublishState = frontendPublished === false;

    if (frontendPublished !== false) {
        blockingIssues.push("frontendPublished flag in methodology must be explicitly false (pre-publish state).");
    }

    const frontendSafetyAuditStatus = safePrePublishState ? "PASS" : "FAIL";

    // ==================================================
    // GLOBAL AUDIT PASS RULE
    // ==================================================
    const auditPassed =
        membershipAuditStatus === "PASS" &&
        skillIntegrityAuditStatus === "PASS" &&
        confidenceIntegrityAuditStatus === "PASS" &&
        styleIntegrityAuditStatus === "PASS" &&
        metricsIntegrityAuditStatus === "PASS" &&
        temporalContractAuditStatus === "PASS" &&
        provisionalStatusAuditStatus === "PASS" &&
        masterSafetyAuditStatus === "PASS" &&
        frontendSafetyAuditStatus === "PASS" &&
        blockingIssues.length === 0;

    const output: WalletScoresAuditOutput = {
        generatedAt: new Date().toISOString(),
        artifact: "data/master/wallet-scores.json",
        auditPassed,
        membershipAudit: {
            status: membershipAuditStatus,
            walletScoresCount: scoreWallets.length,
            skillCount: skillWallets.length,
            confidenceCount: confidenceWallets.length,
            styleCount: styleWallets.length,
            behaviourCount: behaviourWallets.length,
            missingWallets,
            extraWallets,
            duplicateWallets,
            deterministicOrderPreserved,
        },
        skillIntegrityAudit: {
            status: skillIntegrityAuditStatus,
            walletsAudited: scoreWallets.length,
            versionValid: skillVersionValid,
            provisionalFlagValid: skillProvisionalFlagValid,
            discrepancies: skillDiscrepancies,
        },
        confidenceIntegrityAudit: {
            status: confidenceIntegrityAuditStatus,
            walletsAudited: scoreWallets.length,
            confidenceSeparatedFromSkill: true,
            confidenceMixingDetected,
            discrepancies: confidenceDiscrepancies,
        },
        styleIntegrityAudit: {
            status: styleIntegrityAuditStatus,
            walletsAudited: scoreWallets.length,
            versionValid: styleVersionValid,
            provisionalFlagValid: styleProvisionalFlagValid,
            disallowedStylesDetected: disallowedStyles,
            discrepancies: styleDiscrepancies,
        },
        metricsIntegrityAudit: {
            status: metricsIntegrityAuditStatus,
            walletsAudited: scoreWallets.length,
            discrepancies: metricsDiscrepancies,
        },
        temporalContractAudit: {
            status: temporalContractAuditStatus,
            temporalContract: temporalContract || "UNKNOWN",
            isSameClosedPositionPopulation,
            externalMetricsIncluded,
        },
        provisionalStatusAudit: {
            status: provisionalStatusAuditStatus,
            declaredStatus: declaredStatus || "UNKNOWN",
            isProvisional,
            skillVersion: skillVersion || "UNKNOWN",
            styleVersion: styleVersion || "UNKNOWN",
        },
        masterSafetyAudit: {
            status: masterSafetyAuditStatus,
            masterFileExists,
            masterFileSeparated,
            masterFileModifiedByScoring,
        },
        frontendSafetyAudit: {
            status: frontendSafetyAuditStatus,
            frontendPublished,
            safePrePublishState,
        },
        blockingIssues,
        warnings,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 7.2 — WALLET SCORES MASTER AUDIT\n");
    console.log(`Wallets Audited       : ${scoreWallets.length}\n`);

    console.log(`Membership Integrity : ${membershipAuditStatus}`);
    console.log(`Skill Integrity      : ${skillIntegrityAuditStatus}`);
    console.log(`Confidence Integrity : ${confidenceIntegrityAuditStatus}`);
    console.log(`Style Integrity      : ${styleIntegrityAuditStatus}`);
    console.log(`Metrics Integrity    : ${metricsIntegrityAuditStatus}`);
    console.log(`Temporal Contract    : ${temporalContractAuditStatus}`);
    console.log(`Provisional Status   : ${provisionalStatusAuditStatus}`);
    console.log(`Master Safety        : ${masterSafetyAuditStatus}`);
    console.log(`Frontend Safety      : ${frontendSafetyAuditStatus}\n`);

    console.log("Blocking Issues:");
    if (blockingIssues.length === 0) {
        console.log("  None. Master artifact passes all integrity gates.");
    } else {
        for (const issue of blockingIssues) {
            console.log(`  • ${issue}`);
        }
    }

    console.log(`\nAudit Passed         : ${auditPassed ? "YES" : "NO"}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Wallet scores master audit failed: ${err.message}`);
    process.exit(1);
});
