import fs from "node:fs";
import path from "node:path";
import {
    classifyWallets,
    type WalletStyleClassificationOutput,
    type WalletClassificationRecord,
} from "./build-wallet-style-classifications.ts";

interface CliOptions {
    classificationPath: string;
    readinessPath: string;
    outputPath: string;
}

export interface V1StyleClassificationAuditReport {
    generatedAt: string;
    classificationPath: string;
    readinessPath: string;
    status: "PASS" | "FAIL";
    populationAudit: {
        inputWalletCount: number;
        outputWalletCount: number;
        missingWalletsCount: number;
        missingWallets: string[];
        extraWalletsCount: number;
        extraWallets: string[];
        duplicateWalletsCount: number;
        duplicateWallets: string[];
    };
    integrityAudit: {
        invalidStylesCount: number;
        walletsSatisfyingBothStylesCount: number;
        thresholdMismatchCount: number;
        sniperLowCoverageCount: number;
        violations: string[];
    };
    styleDistribution: {
        sniper: { count: number; pct: number };
        farmer: { count: number; pct: number };
        mixedUnclassified: { count: number; pct: number };
    };
    manualEvidence: {
        snipers: WalletClassificationRecord[];
        farmers: WalletClassificationRecord[];
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let classificationPath = path.resolve("data/v1/wallet-style-classifications.json");
    let readinessPath = path.resolve("data/v1/wallet-style-readiness.json");
    let outputPath = path.resolve("data/v1/wallet-style-classifications-audit.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--classifications" && args[i + 1]) {
            classificationPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--classifications=")) {
            classificationPath = path.resolve(arg.slice(17));
        } else if ((arg === "--readiness" || arg === "--input") && args[i + 1]) {
            readinessPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--readiness=") || arg.startsWith("--input=")) {
            readinessPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(args[i + 1]);
        }
    }

    if (!fs.existsSync(readinessPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-style-readiness.json");
        if (fs.existsSync(alt)) readinessPath = alt;
    }

    return { classificationPath, readinessPath, outputPath };
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

export function auditStyleClassifications(
    classificationData: WalletStyleClassificationOutput,
    readinessData: any,
    classificationPath: string,
    readinessPath: string
): V1StyleClassificationAuditReport {
    const violations: string[] = [];

    // 1. Population check
    const readinessWallets: any[] = Array.isArray(readinessData?.wallets) ? readinessData.wallets : [];
    const readinessWalletSet = new Set<string>(readinessWallets.map((w) => String(w.wallet).trim()));

    const classifiedWallets: WalletClassificationRecord[] = Array.isArray(classificationData?.wallets)
        ? classificationData.wallets
        : [];
    const classifiedWalletMap = new Map<string, number>();

    for (const cw of classifiedWallets) {
        const addr = String(cw.wallet || "").trim();
        if (addr) {
            classifiedWalletMap.set(addr, (classifiedWalletMap.get(addr) ?? 0) + 1);
        }
    }

    const missingWallets: string[] = [];
    for (const w of readinessWalletSet) {
        if (!classifiedWalletMap.has(w)) {
            missingWallets.push(w);
            violations.push(`Wallet in readiness dataset missing from classifications: ${w}`);
        }
    }

    const extraWallets: string[] = [];
    for (const [w] of classifiedWalletMap.entries()) {
        if (!readinessWalletSet.has(w)) {
            extraWallets.push(w);
            violations.push(`Extra wallet in classifications not present in readiness dataset: ${w}`);
        }
    }

    const duplicateWallets: string[] = [];
    for (const [w, count] of classifiedWalletMap.entries()) {
        if (count > 1) {
            duplicateWallets.push(w);
            violations.push(`Duplicate wallet in classifications: ${w} (${count} occurrences)`);
        }
    }

    // 2. Integrity checks
    let invalidStylesCount = 0;
    let walletsSatisfyingBothStylesCount = 0;
    let thresholdMismatchCount = 0;
    let sniperLowCoverageCount = 0;

    const validStyles = new Set(["SNIPER", "FARMER", "MIXED_UNCLASSIFIED"]);
    const thresholds = classificationData.thresholds;

    for (const cw of classifiedWallets) {
        const w = cw.wallet;

        // Check style validity
        if (!validStyles.has(cw.style)) {
            invalidStylesCount++;
            violations.push(`Wallet ${w} has invalid style: ${cw.style}`);
        }

        const ev = cw.evidence;
        if (!ev) {
            violations.push(`Wallet ${w} missing evidence object`);
            continue;
        }

        // Recompute rule eligibility
        const recomputedSniperEligible =
            ev.entryDelayCoveragePct >= thresholds.sniper.minEntryDelayCoveragePct &&
            ev.medianEntryDelayHours !== null &&
            ev.medianEntryDelayHours <= thresholds.sniper.maxMedianEntryDelayHours &&
            ev.medianHoldHours <= thresholds.sniper.maxMedianHoldHours;

        const recomputedFarmerEligible =
            ev.medianHoldHours >= thresholds.farmer.minMedianHoldHours &&
            ev.uniqueDlmmPools <= thresholds.farmer.maxUniqueDlmmPools &&
            ev.positionsPerPool >= thresholds.farmer.minPositionsPerPool;

        // Check for both styles satisfied
        if (recomputedSniperEligible && recomputedFarmerEligible) {
            walletsSatisfyingBothStylesCount++;
            violations.push(`INTEGRITY ERROR: Wallet ${w} satisfies both SNIPER and FARMER conditions!`);
        }

        let expectedStyle: "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";
        if (recomputedSniperEligible && recomputedFarmerEligible) {
            expectedStyle = "MIXED_UNCLASSIFIED";
        } else if (recomputedSniperEligible) {
            expectedStyle = "SNIPER";
        } else if (recomputedFarmerEligible) {
            expectedStyle = "FARMER";
        } else {
            expectedStyle = "MIXED_UNCLASSIFIED";
        }

        if (cw.style !== expectedStyle) {
            thresholdMismatchCount++;
            violations.push(
                `Wallet ${w} style mismatch: reported ${cw.style} vs recomputed ${expectedStyle}`
            );
        }

        // Check sniper coverage >= 90%
        if (cw.style === "SNIPER" && ev.entryDelayCoveragePct < 90) {
            sniperLowCoverageCount++;
            violations.push(
                `Wallet ${w} classified as SNIPER but entryDelayCoveragePct is below 90%: ${ev.entryDelayCoveragePct}%`
            );
        }
    }

    const total = classifiedWallets.length;
    const snipers = classifiedWallets.filter((w) => w.style === "SNIPER");
    const farmers = classifiedWallets.filter((w) => w.style === "FARMER");
    const mixed = classifiedWallets.filter((w) => w.style === "MIXED_UNCLASSIFIED");

    const status: "PASS" | "FAIL" =
        missingWallets.length === 0 &&
        extraWallets.length === 0 &&
        duplicateWallets.length === 0 &&
        invalidStylesCount === 0 &&
        walletsSatisfyingBothStylesCount === 0 &&
        thresholdMismatchCount === 0 &&
        sniperLowCoverageCount === 0 &&
        total === 65
            ? "PASS"
            : "FAIL";

    return {
        generatedAt: new Date().toISOString(),
        classificationPath,
        readinessPath,
        status,
        populationAudit: {
            inputWalletCount: readinessWallets.length,
            outputWalletCount: classifiedWallets.length,
            missingWalletsCount: missingWallets.length,
            missingWallets,
            extraWalletsCount: extraWallets.length,
            extraWallets,
            duplicateWalletsCount: duplicateWallets.length,
            duplicateWallets,
        },
        integrityAudit: {
            invalidStylesCount,
            walletsSatisfyingBothStylesCount,
            thresholdMismatchCount,
            sniperLowCoverageCount,
            violations,
        },
        styleDistribution: {
            sniper: {
                count: snipers.length,
                pct: total > 0 ? Number(((snipers.length / total) * 100).toFixed(2)) : 0,
            },
            farmer: {
                count: farmers.length,
                pct: total > 0 ? Number(((farmers.length / total) * 100).toFixed(2)) : 0,
            },
            mixedUnclassified: {
                count: mixed.length,
                pct: total > 0 ? Number(((mixed.length / total) * 100).toFixed(2)) : 0,
            },
        },
        manualEvidence: {
            snipers,
            farmers,
        },
    };
}

function printAuditReport(report: V1StyleClassificationAuditReport): void {
    console.log("==================================================");
    console.log("V1 — WALLET STYLE CLASSIFICATION AUDIT");
    console.log("==================================================");
    console.log(`Input Readiness Dataset : ${report.readinessPath}`);
    console.log(`Output Classifications  : ${report.classificationPath}\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Input Wallets (Readiness) : ${report.populationAudit.inputWalletCount}`);
    console.log(`Output Wallets (Styles)   : ${report.populationAudit.outputWalletCount}`);
    console.log(`Missing Wallets           : ${report.populationAudit.missingWalletsCount}`);
    console.log(`Extra Wallets             : ${report.populationAudit.extraWalletsCount}`);
    console.log(`Duplicate Wallets         : ${report.populationAudit.duplicateWalletsCount}\n`);

    console.log("2. CLASSIFIER INTEGRITY & MUTUAL EXCLUSIVITY");
    console.log("--------------------------------------------------");
    console.log(`Invalid Styles Reported          : ${report.integrityAudit.invalidStylesCount}`);
    console.log(`Wallets Satisfying Both Styles   : ${report.integrityAudit.walletsSatisfyingBothStylesCount}`);
    console.log(`Threshold Recomputation Mismatches: ${report.integrityAudit.thresholdMismatchCount}`);
    console.log(`Snipers with Coverage <90%       : ${report.integrityAudit.sniperLowCoverageCount}`);
    if (report.integrityAudit.violations.length > 0) {
        console.log("\nViolations:");
        for (const v of report.integrityAudit.violations) {
            console.log(`  - ${v}`);
        }
    } else {
        console.log("  All classification logic and mutual exclusivity verified successfully.\n");
    }

    console.log("STYLE DISTRIBUTION");
    console.log("--------------------------------------------------");
    const sd = report.styleDistribution;
    console.log(`SNIPER              : ${sd.sniper.count} (${sd.sniper.pct}%)`);
    console.log(`FARMER              : ${sd.farmer.count} (${sd.farmer.pct}%)`);
    console.log(`MIXED_UNCLASSIFIED  : ${sd.mixedUnclassified.count} (${sd.mixedUnclassified.pct}%)\n`);

    console.log(`MANUAL EVIDENCE — SNIPER WALLETS (N=${report.manualEvidence.snipers.length})`);
    console.log("---------------------------------------------------------------------------------------------------------");
    console.log("Wallet                                       | EntryDelay | HoldHours | DelayCov % | Pools | Pos/Pool");
    console.log("---------------------------------------------------------------------------------------------------------");
    if (report.manualEvidence.snipers.length === 0) {
        console.log("  None");
    } else {
        for (const s of report.manualEvidence.snipers) {
            const ev = s.evidence;
            console.log(
                `${s.wallet} | ${String(ev.medianEntryDelayHours + "h").padStart(10)} | ${String(ev.medianHoldHours + "h").padStart(9)} | ${String(ev.entryDelayCoveragePct + "%").padStart(10)} | ${String(ev.uniqueDlmmPools).padStart(5)} | ${String(ev.positionsPerPool).padStart(8)}`
            );
        }
    }
    console.log("");

    console.log(`MANUAL EVIDENCE — FARMER WALLETS (N=${report.manualEvidence.farmers.length})`);
    console.log("---------------------------------------------------------------------------------------------------------");
    console.log("Wallet                                       | EntryDelay | HoldHours | DelayCov % | Pools | Pos/Pool");
    console.log("---------------------------------------------------------------------------------------------------------");
    if (report.manualEvidence.farmers.length === 0) {
        console.log("  None");
    } else {
        for (const f of report.manualEvidence.farmers) {
            const ev = f.evidence;
            console.log(
                `${f.wallet} | ${String((ev.medianEntryDelayHours !== null ? ev.medianEntryDelayHours + "h" : "N/A")).padStart(10)} | ${String(ev.medianHoldHours + "h").padStart(9)} | ${String(ev.entryDelayCoveragePct + "%").padStart(10)} | ${String(ev.uniqueDlmmPools).padStart(5)} | ${String(ev.positionsPerPool).padStart(8)}`
            );
        }
    }
    console.log("");

    console.log("==================================================");
    console.log(`AUDIT VERDICT: ${report.status}`);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.readinessPath)) {
        throw new Error(`Style readiness dataset file not found: ${cli.readinessPath}`);
    }

    if (!fs.existsSync(cli.classificationPath)) {
        console.log(`Style classifications artifact not found at: ${cli.classificationPath}`);
        console.log(`Auto-building from ${cli.readinessPath}...`);
        const readinessRaw = JSON.parse(fs.readFileSync(cli.readinessPath, "utf8"));
        const generated = classifyWallets(readinessRaw);
        atomicWriteJson(cli.classificationPath, generated);
        console.log(`Generated ${cli.classificationPath} successfully.\n`);
    }

    const classificationRaw = JSON.parse(fs.readFileSync(cli.classificationPath, "utf8"));
    const readinessRaw = JSON.parse(fs.readFileSync(cli.readinessPath, "utf8"));

    const report = auditStyleClassifications(
        classificationRaw,
        readinessRaw,
        cli.classificationPath,
        cli.readinessPath
    );

    atomicWriteJson(cli.outputPath, report);

    printAuditReport(report);
    console.log(`Audit report JSON written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-style-classifications.ts") ||
        process.argv[1].endsWith("audit-wallet-style-classifications.js") ||
        process.argv[1].includes("audit-wallet-style-classifications"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Style classifications audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
