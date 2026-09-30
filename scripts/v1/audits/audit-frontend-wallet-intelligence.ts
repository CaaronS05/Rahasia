import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOptions {
    publishedPath: string;
    datasetPath: string;
    qualityPath: string;
    riskPath: string;
    confidencePath: string;
    stylePath: string;
    shortlistPath: string;
}

export interface FrontendAuditReport {
    generatedAt: string;
    version: "v1";
    status: "V1_FRONTEND_DATA_READY" | "V1_FRONTEND_DATA_FAIL";
    counts: {
        sourceWallets: number;
        publishedWallets: number;
        shortlistedSource: number;
        shortlistedPublished: number;
        missingScores: number;
        joinMismatches: number;
        shortlistMismatches: number;
        duplicateWallets: number;
    };
    checks: {
        sourceCountPass: boolean;
        publishedCountPass: boolean;
        shortlistSourcePass: boolean;
        shortlistPublishedPass: boolean;
        noDuplicates: boolean;
        noMissingScores: boolean;
        noJoinMismatches: boolean;
        noShortlistMismatches: boolean;
        scoreBoundsPass: boolean;
    };
    details: {
        missingScoresWallets: string[];
        joinMismatchWallets: string[];
        shortlistMismatchWallets: string[];
        invalidScoreWallets: string[];
        duplicateWallets: string[];
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    const getArg = (flag: string, fallback: string): string => {
        const idx = args.indexOf(flag);
        if (idx !== -1 && idx + 1 < args.length) {
            return args[idx + 1];
        }
        return fallback;
    };

    const projectRoot = path.resolve(__dirname, "../../..");
    return {
        publishedPath: getArg(
            "--published",
            path.join(projectRoot, "frontend/public/data/wallet-intelligence-v1.json")
        ),
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
    };
}

export function auditFrontendWalletIntelligence(
    publishedRaw: any,
    datasetRaw: any,
    qualityRaw: any,
    riskRaw: any,
    confidenceRaw: any,
    styleRaw: any,
    shortlistRaw: any
): FrontendAuditReport {
    // 1. Source valid wallets
    const sourceValidWallets: any[] = (datasetRaw.wallets || []).filter(
        (w: any) => w.valid === true
    );
    const sourceWalletsCount = sourceValidWallets.length;

    // 2. Published wallets
    const publishedWallets: any[] = publishedRaw.wallets || [];
    const publishedWalletsCount = publishedWallets.length;

    // 3. Shortlist source
    const sourceShortlistWallets: any[] = shortlistRaw.wallets || [];
    const sourceShortlistSet = new Set(sourceShortlistWallets.map((w: any) => w.wallet));
    const shortlistedSourceCount = sourceShortlistSet.size;

    // 4. Shortlist published
    const publishedShortlistWallets = publishedWallets.filter(
        (w: any) => w.shortlisted === true
    );
    const shortlistedPublishedCount = publishedShortlistWallets.length;

    // 5. Index maps
    const sourceValidSet = new Set(sourceValidWallets.map((w: any) => w.wallet));
    const qualityMap = new Map<string, number>();
    for (const q of qualityRaw.wallets || []) {
        qualityMap.set(q.wallet, q.qualityScore);
    }
    const riskMap = new Map<string, number>();
    for (const r of riskRaw.wallets || []) {
        riskMap.set(r.wallet, r.riskScore);
    }
    const confidenceMap = new Map<string, number>();
    for (const c of confidenceRaw.wallets || []) {
        confidenceMap.set(c.wallet, c.confidenceScore);
    }
    const styleMap = new Map<string, string>();
    for (const s of styleRaw.wallets || []) {
        styleMap.set(s.wallet, s.style);
    }

    // 6. Check duplicates
    const seenAddresses = new Set<string>();
    const duplicateWallets: string[] = [];
    for (const p of publishedWallets) {
        if (seenAddresses.has(p.wallet)) {
            duplicateWallets.push(p.wallet);
        }
        seenAddresses.add(p.wallet);
    }

    // 7. Check each published wallet
    const missingScoresWallets: string[] = [];
    const joinMismatchWallets: string[] = [];
    const shortlistMismatchWallets: string[] = [];
    const invalidScoreWallets: string[] = [];

    for (const p of publishedWallets) {
        const addr = p.wallet;

        // Exact-address join integrity with screening dataset
        if (!sourceValidSet.has(addr)) {
            joinMismatchWallets.push(`${addr} (not in valid screening dataset)`);
        }

        // Check scores presence
        const hasQuality = p.qualityScore !== null && p.qualityScore !== undefined && typeof p.qualityScore === "number";
        const hasRisk = p.riskScore !== null && p.riskScore !== undefined && typeof p.riskScore === "number";
        const hasConfidence = p.confidenceScore !== null && p.confidenceScore !== undefined && typeof p.confidenceScore === "number";
        const hasStyle = p.style === "SNIPER" || p.style === "FARMER" || p.style === "MIXED_UNCLASSIFIED";

        if (!hasQuality || !hasRisk || !hasConfidence || !hasStyle) {
            missingScoresWallets.push(addr);
        }

        // Check score bounds
        const qValid = hasQuality && p.qualityScore >= 0 && p.qualityScore <= 100;
        const rValid = hasRisk && p.riskScore >= 0 && p.riskScore <= 100;
        const cValid = hasConfidence && p.confidenceScore >= 0 && p.confidenceScore <= 100;
        if (!qValid || !rValid || !cValid) {
            invalidScoreWallets.push(addr);
        }

        // Check exact match with source quality / risk / confidence / style
        const sourceQ = qualityMap.get(addr);
        const sourceR = riskMap.get(addr);
        const sourceC = confidenceMap.get(addr);
        const sourceS = styleMap.get(addr);

        if (
            sourceQ === undefined ||
            sourceR === undefined ||
            sourceC === undefined ||
            sourceS === undefined ||
            Math.abs(p.qualityScore - sourceQ) > 0.001 ||
            Math.abs(p.riskScore - sourceR) > 0.001 ||
            Math.abs(p.confidenceScore - sourceC) > 0.001 ||
            p.style !== sourceS
        ) {
            joinMismatchWallets.push(addr);
        }

        // Shortlist flag integrity
        const shouldBeShortlisted = sourceShortlistSet.has(addr);
        if (p.shortlisted !== shouldBeShortlisted) {
            shortlistMismatchWallets.push(
                `${addr} (published=${p.shortlisted}, source=${shouldBeShortlisted})`
            );
        }
    }

    // Verify every wallet in data/v1/wallet-shortlist.json is published with shortlisted = true
    for (const sh of sourceShortlistWallets) {
        const pub = publishedWallets.find((w: any) => w.wallet === sh.wallet);
        if (!pub || pub.shortlisted !== true) {
            if (!shortlistMismatchWallets.includes(sh.wallet)) {
                shortlistMismatchWallets.push(`${sh.wallet} (missing shortlisted=true in published)`);
            }
        }
    }

    // Also verify no valid wallet from source is missing in published
    for (const src of sourceValidWallets) {
        if (!seenAddresses.has(src.wallet)) {
            joinMismatchWallets.push(`${src.wallet} (missing in published dataset)`);
        }
    }

    const missingScores = missingScoresWallets.length;
    const joinMismatches = joinMismatchWallets.length;
    const shortlistMismatches = shortlistMismatchWallets.length;

    const sourceCountPass = sourceWalletsCount === 65;
    const publishedCountPass = publishedWalletsCount === 65;
    const shortlistSourcePass = shortlistedSourceCount === 7;
    const shortlistPublishedPass = shortlistedPublishedCount === 7;
    const noDuplicates = duplicateWallets.length === 0;
    const noMissingScores = missingScores === 0;
    const noJoinMismatches = joinMismatches === 0;
    const noShortlistMismatches = shortlistMismatches === 0;
    const scoreBoundsPass = invalidScoreWallets.length === 0;

    const allPass =
        sourceCountPass &&
        publishedCountPass &&
        shortlistSourcePass &&
        shortlistPublishedPass &&
        noDuplicates &&
        noMissingScores &&
        noJoinMismatches &&
        noShortlistMismatches &&
        scoreBoundsPass;

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        status: allPass ? "V1_FRONTEND_DATA_READY" : "V1_FRONTEND_DATA_FAIL",
        counts: {
            sourceWallets: sourceWalletsCount,
            publishedWallets: publishedWalletsCount,
            shortlistedSource: shortlistedSourceCount,
            shortlistedPublished: shortlistedPublishedCount,
            missingScores,
            joinMismatches,
            shortlistMismatches,
            duplicateWallets: duplicateWallets.length,
        },
        checks: {
            sourceCountPass,
            publishedCountPass,
            shortlistSourcePass,
            shortlistPublishedPass,
            noDuplicates,
            noMissingScores,
            noJoinMismatches,
            noShortlistMismatches,
            scoreBoundsPass,
        },
        details: {
            missingScoresWallets,
            joinMismatchWallets,
            shortlistMismatchWallets,
            invalidScoreWallets,
            duplicateWallets,
        },
    };
}

export function printFrontendAuditReport(report: FrontendAuditReport): void {
    console.log("==================================================");
    console.log("V1 FRONTEND INTELLIGENCE AUDIT");
    console.log("==================================================");
    console.log(`Source Wallets       : ${report.counts.sourceWallets}`);
    console.log(`Published Wallets    : ${report.counts.publishedWallets}`);
    console.log(`Shortlisted Source   : ${report.counts.shortlistedSource}`);
    console.log(`Shortlisted Published: ${report.counts.shortlistedPublished}`);
    console.log("");
    console.log(`Missing Scores       : ${report.counts.missingScores}`);
    console.log(`Join Mismatches      : ${report.counts.joinMismatches}`);
    console.log(`Shortlist Mismatches : ${report.counts.shortlistMismatches}`);
    console.log("");
    console.log("AUDIT CHECKS:");
    console.log(`• Source valid wallets = 65    : ${report.checks.sourceCountPass ? "PASS" : "FAIL"}`);
    console.log(`• Published wallets = 65       : ${report.checks.publishedCountPass ? "PASS" : "FAIL"}`);
    console.log(`• Source shortlist = 7         : ${report.checks.shortlistSourcePass ? "PASS" : "FAIL"}`);
    console.log(`• Published shortlist = 7      : ${report.checks.shortlistPublishedPass ? "PASS" : "FAIL"}`);
    console.log(`• Duplicate wallets = 0        : ${report.checks.noDuplicates ? "PASS" : "FAIL"}`);
    console.log(`• Missing Quality/Risk/Conf/St : ${report.checks.noMissingScores ? "PASS" : "FAIL"}`);
    console.log(`• Exact-address join integrity : ${report.checks.noJoinMismatches ? "PASS" : "FAIL"}`);
    console.log(`• Shortlist flag integrity     : ${report.checks.noShortlistMismatches ? "PASS" : "FAIL"}`);
    console.log(`• Score bounds (0..100)        : ${report.checks.scoreBoundsPass ? "PASS" : "FAIL"}`);
    console.log("");
    console.log("==================================================");
    console.log("FINAL VERDICT:");
    console.log(report.status);
    console.log("==================================================");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    const requiredPaths = [
        { label: "Published intelligence", p: cli.publishedPath },
        { label: "Screening dataset", p: cli.datasetPath },
        { label: "Quality scores", p: cli.qualityPath },
        { label: "Risk scores", p: cli.riskPath },
        { label: "Confidence scores", p: cli.confidencePath },
        { label: "Style classifications", p: cli.stylePath },
        { label: "Shortlist", p: cli.shortlistPath },
    ];

    for (const req of requiredPaths) {
        if (!fs.existsSync(req.p)) {
            throw new Error(`Required file not found (${req.label}): ${req.p}`);
        }
    }

    const publishedRaw = JSON.parse(fs.readFileSync(cli.publishedPath, "utf8"));
    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const qualityRaw = JSON.parse(fs.readFileSync(cli.qualityPath, "utf8"));
    const riskRaw = JSON.parse(fs.readFileSync(cli.riskPath, "utf8"));
    const confidenceRaw = JSON.parse(fs.readFileSync(cli.confidencePath, "utf8"));
    const styleRaw = JSON.parse(fs.readFileSync(cli.stylePath, "utf8"));
    const shortlistRaw = JSON.parse(fs.readFileSync(cli.shortlistPath, "utf8"));

    const report = auditFrontendWalletIntelligence(
        publishedRaw,
        datasetRaw,
        qualityRaw,
        riskRaw,
        confidenceRaw,
        styleRaw,
        shortlistRaw
    );

    printFrontendAuditReport(report);

    if (report.status !== "V1_FRONTEND_DATA_READY") {
        process.exit(1);
    }
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-frontend-wallet-intelligence.ts") ||
        process.argv[1].endsWith("audit-frontend-wallet-intelligence.js") ||
        process.argv[1].includes("audit-frontend-wallet-intelligence"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Frontend intelligence audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
