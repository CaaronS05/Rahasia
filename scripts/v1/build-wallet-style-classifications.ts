import fs from "node:fs";
import path from "node:path";

export type WalletStyle = "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";

export interface SniperThresholds {
    maxMedianEntryDelayHours: number;
    maxMedianHoldHours: number;
    minEntryDelayCoveragePct: number;
}

export interface FarmerThresholds {
    minMedianHoldHours: number;
    maxUniqueDlmmPools: number;
    minPositionsPerPool: number;
}

export interface StyleThresholds {
    sniper: SniperThresholds;
    farmer: FarmerThresholds;
}

export interface WalletEvidence {
    entryDelayCoveragePct: number;
    medianEntryDelayHours: number | null;
    medianHoldHours: number;
    uniqueDlmmPools: number;
    positionsPerPool: number;
    totalFees: number;
    feesToDepositsPct: number;
}

export interface WalletStyleRuleFlags {
    sniperEligible: boolean;
    farmerEligible: boolean;
}

export interface WalletClassificationRecord {
    wallet: string;
    style: WalletStyle;
    evidence: WalletEvidence;
    rules: WalletStyleRuleFlags;
}

export interface WalletStyleClassificationOutput {
    generatedAt: string;
    version: "v1";
    population: {
        wallets: number;
    };
    thresholds: StyleThresholds;
    distribution: {
        sniperCount: number;
        sniperPct: number;
        farmerCount: number;
        farmerPct: number;
        mixedCount: number;
        mixedPct: number;
    };
    wallets: WalletClassificationRecord[];
}

interface CliOptions {
    readinessPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let readinessPath = path.resolve("data/v1/wallet-style-readiness.json");
    let outputPath = path.resolve("data/v1/wallet-style-classifications.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === "--readiness" || arg === "--input") && args[i + 1]) {
            readinessPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--readiness=") || arg.startsWith("--input=")) {
            readinessPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    if (!fs.existsSync(readinessPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-style-readiness.json");
        if (fs.existsSync(alt)) readinessPath = alt;
    }

    return { readinessPath, outputPath };
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

export function classifyWallets(readinessData: any): WalletStyleClassificationOutput {
    if (!readinessData || !Array.isArray(readinessData.wallets)) {
        throw new Error("Invalid style readiness dataset: missing or malformed wallets array");
    }

    const cohortDist = readinessData.cohortDistributions;
    if (!cohortDist) {
        throw new Error("Invalid style readiness dataset: missing cohortDistributions");
    }

    // Read exact percentile thresholds from the readiness artifact
    const p25EntryDelay = Number(cohortDist.medianEntryDelayHours?.p25 ?? 14.24);
    const p25Hold = Number(cohortDist.medianHoldHours?.p25 ?? 0.61);
    const p75Hold = Number(cohortDist.medianHoldHours?.p75 ?? 2.8);
    const p25Pools = Number(cohortDist.uniqueDlmmPools?.p25 ?? 48);
    const p75PositionsPerPool = Number(cohortDist.positionsPerPool?.p75 ?? 3.26);

    const thresholds: StyleThresholds = {
        sniper: {
            maxMedianEntryDelayHours: p25EntryDelay,
            maxMedianHoldHours: p25Hold,
            minEntryDelayCoveragePct: 90,
        },
        farmer: {
            minMedianHoldHours: p75Hold,
            maxUniqueDlmmPools: p25Pools,
            minPositionsPerPool: p75PositionsPerPool,
        },
    };

    const wallets: any[] = readinessData.wallets;
    const classifiedWallets: WalletClassificationRecord[] = [];

    for (const w of wallets) {
        const addr = String(w.wallet).trim();
        const ed = w.entryDelay || {};
        const h = w.holding || {};
        const f = w.farmer || {};

        const coveragePct = Number(ed.entryDelayCoveragePct ?? 0);
        const medianEntryDelay = ed.medianEntryDelayHours !== null && typeof ed.medianEntryDelayHours === "number"
            ? Number(ed.medianEntryDelayHours)
            : null;
        const medianHold = Number(h.medianHoldHours ?? 0);
        const uniquePools = Number(f.uniqueDlmmPools ?? 0);
        const positionsPerPool = Number(f.positionsPerPool ?? 0);
        const totalFees = Number(f.totalFees ?? 0);
        const feesToDepositsPct = Number(f.feesToDepositsPct ?? 0);

        // Evaluation
        // SNIPER: entryDelayCoverage >= 90 AND medianEntryDelay <= P25 AND medianHold <= P25
        const sniperEligible =
            coveragePct >= thresholds.sniper.minEntryDelayCoveragePct &&
            medianEntryDelay !== null &&
            medianEntryDelay <= thresholds.sniper.maxMedianEntryDelayHours &&
            medianHold <= thresholds.sniper.maxMedianHoldHours;

        // FARMER: medianHold >= P75 AND uniqueDlmmPools <= P25 AND positionsPerPool >= P75
        const farmerEligible =
            medianHold >= thresholds.farmer.minMedianHoldHours &&
            uniquePools <= thresholds.farmer.maxUniqueDlmmPools &&
            positionsPerPool >= thresholds.farmer.minPositionsPerPool;

        let style: WalletStyle;
        if (sniperEligible && farmerEligible) {
            // Integrity violation will be caught by audit
            style = "MIXED_UNCLASSIFIED";
        } else if (sniperEligible) {
            style = "SNIPER";
        } else if (farmerEligible) {
            style = "FARMER";
        } else {
            style = "MIXED_UNCLASSIFIED";
        }

        classifiedWallets.push({
            wallet: addr,
            style,
            evidence: {
                entryDelayCoveragePct: coveragePct,
                medianEntryDelayHours: medianEntryDelay,
                medianHoldHours: medianHold,
                uniqueDlmmPools: uniquePools,
                positionsPerPool,
                totalFees,
                feesToDepositsPct,
            },
            rules: {
                sniperEligible,
                farmerEligible,
            },
        });
    }

    // Sort deterministically by wallet address
    classifiedWallets.sort((a, b) => a.wallet.localeCompare(b.wallet));

    const total = classifiedWallets.length;
    const sniperCount = classifiedWallets.filter((w) => w.style === "SNIPER").length;
    const farmerCount = classifiedWallets.filter((w) => w.style === "FARMER").length;
    const mixedCount = classifiedWallets.filter((w) => w.style === "MIXED_UNCLASSIFIED").length;

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        population: {
            wallets: total,
        },
        thresholds,
        distribution: {
            sniperCount,
            sniperPct: total > 0 ? Number(((sniperCount / total) * 100).toFixed(2)) : 0,
            farmerCount,
            farmerPct: total > 0 ? Number(((farmerCount / total) * 100).toFixed(2)) : 0,
            mixedCount,
            mixedPct: total > 0 ? Number(((mixedCount / total) * 100).toFixed(2)) : 0,
        },
        wallets: classifiedWallets,
    };
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.readinessPath)) {
        throw new Error(`Style readiness dataset file not found: ${cli.readinessPath}`);
    }

    const readinessRaw = JSON.parse(fs.readFileSync(cli.readinessPath, "utf8"));
    const output = classifyWallets(readinessRaw);

    atomicWriteJson(cli.outputPath, output);

    console.log("==================================================");
    console.log("V1 — WALLET STYLE CLASSIFICATION GENERATION");
    console.log("==================================================");
    console.log(`Input Readiness Dataset : ${cli.readinessPath}`);
    console.log(`Output Classifications  : ${cli.outputPath}`);
    console.log(`Wallets Classified      : ${output.population.wallets}`);
    console.log(`SNIPER Wallets          : ${output.distribution.sniperCount} (${output.distribution.sniperPct}%)`);
    console.log(`FARMER Wallets          : ${output.distribution.farmerCount} (${output.distribution.farmerPct}%)`);
    console.log(`MIXED_UNCLASSIFIED      : ${output.distribution.mixedCount} (${output.distribution.mixedPct}%)`);
    console.log("==================================================\n");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-style-classifications.ts") ||
        process.argv[1].endsWith("build-wallet-style-classifications.js") ||
        process.argv[1].includes("build-wallet-style-classifications"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Style classification failed: ${err?.message || err}`);
        process.exit(1);
    });
}
