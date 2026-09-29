import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    datasetPath: string;
    qualityPath: string;
    riskPath: string;
    confidencePath: string;
    stylePath: string;
    auditPath: string;
    outputPath: string;
}

export interface ShortlistedWalletRecord {
    wallet: string;
    qualityScore: number;
    riskScore: number;
    confidenceScore: number;
    style: "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";
    performance: {
        totalPnl: number;
        profitFactor: number;
        medianPositionPnlPct: number;
        positionWinRate: number;
        closedPositionCount: number;
        pnlConcentrationTop1: number;
    };
    shortlistReasons: {
        qualityPass: boolean;
        riskPass: boolean;
        confidencePass: boolean;
        profitabilityGuardrailsPass: boolean;
    };
}

export interface ShortlistOutput {
    generatedAt: string;
    version: "v1";
    semantics: {
        description: string;
        warning: string;
        styleNote: string;
        orderingNote: string;
    };
    rule: {
        name: "STRICT";
        qualityMinimum: number;
        qualityPercentile: string;
        riskMaximum: number;
        riskPercentile: string;
        confidenceMinimum: number;
        guardrails: {
            totalPnlPositive: boolean;
            profitFactorAboveOne: boolean;
            medianPositionPnlPctPositive: boolean;
        };
    };
    population: {
        validWallets: number;
        shortlistedWallets: number;
        shortlistPct: number;
    };
    styleDistribution: {
        sniper: { count: number; pct: number };
        farmer: { count: number; pct: number };
        mixed: { count: number; pct: number };
    };
    wallets: ShortlistedWalletRecord[];
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let qualityPath = path.resolve("data/v1/wallet-quality-scores.json");
    let riskPath = path.resolve("data/v1/wallet-risk-scores.json");
    let confidencePath = path.resolve("data/v1/wallet-confidence-scores.json");
    let stylePath = path.resolve("data/v1/wallet-style-classifications.json");
    let auditPath = path.resolve("data/v1/wallet-shortlist-design-audit.json");
    let outputPath = path.resolve("data/v1/wallet-shortlist.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dataset" && args[i + 1]) {
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

    return { datasetPath, qualityPath, riskPath, confidencePath, stylePath, auditPath, outputPath };
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

export function buildShortlist(
    datasetData: any,
    qualityData: any,
    riskData: any,
    confidenceData: any,
    styleData: any,
    designAuditData?: any
): ShortlistOutput {
    const validDatasetWallets: any[] = Array.isArray(datasetData?.wallets)
        ? datasetData.wallets.filter((w: any) => w?.valid === true)
        : [];

    const qualityMap = new Map<string, any>();
    const qualityScores: number[] = [];
    for (const w of qualityData?.wallets || []) {
        if (w?.wallet) {
            const addr = String(w.wallet).trim();
            qualityMap.set(addr, w);
            if (typeof w.qualityScore === "number") {
                qualityScores.push(w.qualityScore);
            }
        }
    }

    const riskMap = new Map<string, any>();
    const riskScores: number[] = [];
    for (const w of riskData?.wallets || []) {
        if (w?.wallet) {
            const addr = String(w.wallet).trim();
            riskMap.set(addr, w);
            if (typeof w.riskScore === "number") {
                riskScores.push(w.riskScore);
            }
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

    // Determine exact thresholds: read from design audit if available, else recompute dynamically
    const sortedQuality = [...qualityScores].sort((a, b) => a - b);
    const sortedRisk = [...riskScores].sort((a, b) => a - b);

    const computedQualityP75 = Number(computePercentile(sortedQuality, 75).toFixed(2));
    const computedRiskP25 = Number(computePercentile(sortedRisk, 25).toFixed(2));

    const qualityMinimum = Number(designAuditData?.cohortPercentiles?.qualityP75 ?? computedQualityP75);
    const riskMaximum = Number(designAuditData?.cohortPercentiles?.riskP25 ?? computedRiskP25);
    const confidenceMinimum = 80;

    const shortlisted: ShortlistedWalletRecord[] = [];

    for (const dw of validDatasetWallets) {
        const addr = String(dw.wallet).trim();
        const qRecord = qualityMap.get(addr);
        const rRecord = riskMap.get(addr);
        const cRecord = confidenceMap.get(addr);
        const sRecord = styleMap.get(addr);

        if (!qRecord || !rRecord || !cRecord || !sRecord) {
            continue;
        }

        const m = dw.metrics || {};
        const totalPnl = Number(m.totalPnl ?? 0);
        const profitFactor = Number(m.profitFactor ?? 0);
        const medianPositionPnlPct = Number(m.medianPositionPnlPct ?? 0);
        const positionWinRate = Number(m.positionWinRate ?? 0);
        const closedPositionCount = Number(m.closedPositionCount ?? dw.positions?.length ?? 0);
        const pnlConcentrationTop1 = Number(m.pnlConcentrationTop1 ?? 0);

        const qualityScore = Number(qRecord.qualityScore ?? 0);
        const riskScore = Number(rRecord.riskScore ?? 0);
        const confidenceScore = Number(cRecord.confidenceScore ?? 0);
        const style = sRecord.style ?? "MIXED_UNCLASSIFIED";

        const qualityPass = qualityScore >= qualityMinimum;
        const riskPass = riskScore <= riskMaximum;
        const confidencePass = confidenceScore >= confidenceMinimum;
        const profitabilityGuardrailsPass = totalPnl > 0 && profitFactor > 1 && medianPositionPnlPct > 0;

        if (qualityPass && riskPass && confidencePass && profitabilityGuardrailsPass) {
            shortlisted.push({
                wallet: addr,
                qualityScore,
                riskScore,
                confidenceScore,
                style,
                performance: {
                    totalPnl,
                    profitFactor,
                    medianPositionPnlPct,
                    positionWinRate,
                    closedPositionCount,
                    pnlConcentrationTop1,
                },
                shortlistReasons: {
                    qualityPass,
                    riskPass,
                    confidencePass,
                    profitabilityGuardrailsPass,
                },
            });
        }
    }

    // Deterministic display sorting only (by qualityScore descending)
    shortlisted.sort((a, b) => {
        if (Math.abs(b.qualityScore - a.qualityScore) > 1e-4) {
            return b.qualityScore - a.qualityScore;
        }
        return a.wallet.localeCompare(b.wallet);
    });

    const snipers = shortlisted.filter((w) => w.style === "SNIPER").length;
    const farmers = shortlisted.filter((w) => w.style === "FARMER").length;
    const mixed = shortlisted.filter((w) => w.style === "MIXED_UNCLASSIFIED").length;
    const totalShortlisted = shortlisted.length;
    const totalValid = validDatasetWallets.length;

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        semantics: {
            description: "Wallets that satisfy the V1 historical screening criteria and are candidates for later live monitoring.",
            warning: "Does NOT guarantee profitability, safety, or suitability for automated execution or copy-trading.",
            styleNote: "Style is descriptive and informational only. SNIPER, FARMER, and MIXED_UNCLASSIFIED do not affect inclusion or ranking.",
            orderingNote: "Wallets are sorted strictly by qualityScore descending for display inspection only. No composite ranking or score weighting is applied.",
        },
        rule: {
            name: "STRICT",
            qualityMinimum,
            qualityPercentile: "cohort P75",
            riskMaximum,
            riskPercentile: "cohort P25",
            confidenceMinimum,
            guardrails: {
                totalPnlPositive: true,
                profitFactorAboveOne: true,
                medianPositionPnlPctPositive: true,
            },
        },
        population: {
            validWallets: totalValid,
            shortlistedWallets: totalShortlisted,
            shortlistPct: totalValid > 0 ? Number(((totalShortlisted / totalValid) * 100).toFixed(2)) : 0,
        },
        styleDistribution: {
            sniper: {
                count: snipers,
                pct: totalShortlisted > 0 ? Number(((snipers / totalShortlisted) * 100).toFixed(2)) : 0,
            },
            farmer: {
                count: farmers,
                pct: totalShortlisted > 0 ? Number(((farmers / totalShortlisted) * 100).toFixed(2)) : 0,
            },
            mixed: {
                count: mixed,
                pct: totalShortlisted > 0 ? Number(((mixed / totalShortlisted) * 100).toFixed(2)) : 0,
            },
        },
        wallets: shortlisted,
    };
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
            throw new Error(`Required input artifact not found (${req.label}): ${req.p}`);
        }
    }

    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const qualityRaw = JSON.parse(fs.readFileSync(cli.qualityPath, "utf8"));
    const riskRaw = JSON.parse(fs.readFileSync(cli.riskPath, "utf8"));
    const confidenceRaw = JSON.parse(fs.readFileSync(cli.confidencePath, "utf8"));
    const styleRaw = JSON.parse(fs.readFileSync(cli.stylePath, "utf8"));
    const auditRaw = fs.existsSync(cli.auditPath)
        ? JSON.parse(fs.readFileSync(cli.auditPath, "utf8"))
        : undefined;

    const shortlist = buildShortlist(datasetRaw, qualityRaw, riskRaw, confidenceRaw, styleRaw, auditRaw);

    atomicWriteJson(cli.outputPath, shortlist);

    console.log(`[V1 SHORTLIST] Successfully created ${cli.outputPath}`);
    console.log(`  Rule: STRICT (Quality >= ${shortlist.rule.qualityMinimum}, Risk <= ${shortlist.rule.riskMaximum}, Conf >= ${shortlist.rule.confidenceMinimum})`);
    console.log(`  Shortlisted: ${shortlist.population.shortlistedWallets} / ${shortlist.population.validWallets} wallets (${shortlist.population.shortlistPct}%)`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-shortlist.ts") ||
        process.argv[1].endsWith("build-wallet-shortlist.js") ||
        process.argv[1].includes("build-wallet-shortlist"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Shortlist generation failed: ${err?.message || err}`);
        process.exit(1);
    });
}
