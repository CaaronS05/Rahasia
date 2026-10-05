import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOptions {
    datasetPath: string;
    qualityPath: string;
    riskPath: string;
    confidencePath: string;
    stylePath: string;
    shortlistPath: string;
    outputPath: string;
}

export interface PublishedWalletRecord {
    wallet: string;
    qualityScore: number;
    riskScore: number;
    confidenceScore: number;
    style: "SNIPER" | "FARMER" | "MIXED_UNCLASSIFIED";
    shortlisted: boolean;
    performance: {
        totalPnl: number;
        profitFactor: number;
        medianPositionPnlPct: number;
        positionWinRate: number;
        closedPositionCount: number;
        pnlConcentrationTop1: number;
    };
}

export interface PublishedIntelligenceDataset {
    generatedAt: string;
    version: "v1";
    population: {
        validWallets: number;
        shortlistedWallets: number;
    };
    shortlistRule: {
        qualityMinimum: number;
        riskMaximum: number;
        confidenceMinimum: number;
    };
    wallets: PublishedWalletRecord[];
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
        outputPath: getArg(
            "--output",
            path.join(projectRoot, "frontend/public/data/wallet-intelligence-v1.json")
        ),
    };
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

export function buildPublishedWalletIntelligence(
    datasetRaw: any,
    qualityRaw: any,
    riskRaw: any,
    confidenceRaw: any,
    styleRaw: any,
    shortlistRaw: any
): PublishedIntelligenceDataset {
    // 1. Extract valid wallets from dataset
    const validWalletsFromDataset: any[] = (datasetRaw.wallets || []).filter(
        (w: any) => w.valid === true
    );
    if (validWalletsFromDataset.length === 0) {
        throw new Error("Screening dataset contains 0 valid wallets to publish");
    }

    // 2. Build index maps by exact address
    const qualityMap = new Map<string, any>();
    for (const q of qualityRaw.wallets || []) {
        if (q?.wallet) qualityMap.set(String(q.wallet).trim(), q);
    }

    const riskMap = new Map<string, any>();
    for (const r of riskRaw.wallets || []) {
        if (r?.wallet) riskMap.set(String(r.wallet).trim(), r);
    }

    const confidenceMap = new Map<string, any>();
    for (const c of confidenceRaw.wallets || []) {
        if (c?.wallet) confidenceMap.set(String(c.wallet).trim(), c);
    }

    const styleMap = new Map<string, any>();
    for (const s of styleRaw.wallets || []) {
        if (s?.wallet) styleMap.set(String(s.wallet).trim(), s);
    }

    const shortlistMap = new Map<string, any>();
    for (const sh of shortlistRaw.wallets || []) {
        if (sh?.wallet) shortlistMap.set(String(sh.wallet).trim(), sh);
    }

    // 3. Read exact shortlist rules from shortlist artifact
    const qualityMinimum = Number(shortlistRaw.rule?.qualityMinimum);
    const riskMaximum = Number(shortlistRaw.rule?.riskMaximum);
    const confidenceMinimum = Number(shortlistRaw.rule?.confidenceMinimum);

    if (
        !Number.isFinite(qualityMinimum) ||
        !Number.isFinite(riskMaximum) ||
        !Number.isFinite(confidenceMinimum)
    ) {
        throw new Error("Invalid or missing shortlist thresholds in shortlist artifact");
    }

    // 4. Join all valid wallets preserving deterministic dataset order
    const publishedWallets: PublishedWalletRecord[] = [];
    let shortlistedCount = 0;

    for (const d of validWalletsFromDataset) {
        const address = String(d.wallet).trim();
        const q = qualityMap.get(address);
        const r = riskMap.get(address);
        const c = confidenceMap.get(address);
        const s = styleMap.get(address);
        const isShortlisted = shortlistMap.has(address);

        if (!q) throw new Error(`Missing Quality score for wallet ${address}`);
        if (!r) throw new Error(`Missing Risk score for wallet ${address}`);
        if (!c) throw new Error(`Missing Confidence score for wallet ${address}`);
        if (!s) throw new Error(`Missing Style classification for wallet ${address}`);

        if (isShortlisted) {
            shortlistedCount++;
        }

        const metrics = d.metrics || q.raw;
        if (!metrics) {
            throw new Error(`Missing performance metrics for wallet ${address}`);
        }

        publishedWallets.push({
            wallet: address,
            qualityScore: Number(q.qualityScore),
            riskScore: Number(r.riskScore),
            confidenceScore: Number(c.confidenceScore),
            style: s.style,
            shortlisted: isShortlisted,
            performance: {
                totalPnl: Number(metrics.totalPnl),
                profitFactor: Number(metrics.profitFactor),
                medianPositionPnlPct: Number(metrics.medianPositionPnlPct),
                positionWinRate: Number(metrics.positionWinRate),
                closedPositionCount: Number(metrics.closedPositionCount),
                pnlConcentrationTop1: Number(metrics.pnlConcentrationTop1),
            },
        });
    }

    if (publishedWallets.length !== validWalletsFromDataset.length) {
        throw new Error(
            `Expected ${validWalletsFromDataset.length} published records matching dataset, got ${publishedWallets.length}`
        );
    }

    const expectedShortlisted = Array.isArray(shortlistRaw.wallets)
        ? shortlistRaw.wallets.length
        : Number(shortlistRaw.population?.shortlistedWallets ?? 0);

    if (shortlistedCount !== expectedShortlisted) {
        throw new Error(
            `Expected ${expectedShortlisted} shortlisted records matching shortlist artifact, got ${shortlistedCount}`
        );
    }

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        population: {
            validWallets: publishedWallets.length,
            shortlistedWallets: shortlistedCount,
        },
        shortlistRule: {
            qualityMinimum,
            riskMaximum,
            confidenceMinimum,
        },
        wallets: publishedWallets,
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
        { label: "Shortlist", p: cli.shortlistPath },
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

    const dataset = buildPublishedWalletIntelligence(
        datasetRaw,
        qualityRaw,
        riskRaw,
        confidenceRaw,
        styleRaw,
        shortlistRaw
    );

    atomicWriteJson(cli.outputPath, dataset);

    console.log("==================================================");
    console.log("V1 WALLET INTELLIGENCE PUBLISHED");
    console.log("==================================================");
    console.log(`Output Path          : ${cli.outputPath}`);
    console.log(`Valid Wallets        : ${dataset.population.validWallets}`);
    console.log(`Shortlisted Wallets  : ${dataset.population.shortlistedWallets}`);
    console.log(`Quality Threshold    : >= ${dataset.shortlistRule.qualityMinimum}`);
    console.log(`Risk Threshold       : <= ${dataset.shortlistRule.riskMaximum}`);
    console.log(`Confidence Threshold : >= ${dataset.shortlistRule.confidenceMinimum}`);
    console.log("==================================================");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("publish-wallet-intelligence.ts") ||
        process.argv[1].endsWith("publish-wallet-intelligence.js") ||
        process.argv[1].includes("publish-wallet-intelligence"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Publish failed: ${err?.message || err}`);
        process.exit(1);
    });
}
