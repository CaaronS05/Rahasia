import fs from "node:fs";
import path from "node:path";

export interface V1QualityScoreFormula {
    medianPositionPnlPct: number;
    profitFactor: number;
    positionWinRate: number;
    inversePnlConcentrationTop1: number;
}

export interface V1WalletQualityRaw {
    medianPositionPnlPct: number;
    profitFactor: number;
    positionWinRate: number;
    pnlConcentrationTop1: number;
    totalPnl: number;
    closedPositionCount: number;
}

export interface V1WalletQualityComponents {
    medianPositionPnlPctPercentile: number;
    profitFactorPercentile: number;
    positionWinRatePercentile: number;
    inverseConcentrationPercentile: number;
}

export interface V1WalletQualityRecord {
    wallet: string;
    qualityScore: number;
    raw: V1WalletQualityRaw;
    components: V1WalletQualityComponents;
}

export interface V1QualityScoresOutput {
    generatedAt: string;
    version: "v1";
    population: {
        wallets: number;
    };
    formula: V1QualityScoreFormula;
    wallets: V1WalletQualityRecord[];
}

export const FORMULA_WEIGHTS: V1QualityScoreFormula = {
    medianPositionPnlPct: 0.35,
    profitFactor: 0.25,
    positionWinRate: 0.20,
    inversePnlConcentrationTop1: 0.20,
};

interface CliOptions {
    datasetPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-quality-scores.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dataset" && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=")) {
            datasetPath = path.resolve(arg.slice(10));
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(args[i + 1]);
        }
    }

    return { datasetPath, outputPath };
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

/**
 * Computes cohort-relative mid-rank percentiles for an array of (wallet, value) tuples.
 * Ranks are scaled to [0, 100].
 * direction "higher_is_better": highest value -> 100, lowest value -> 0
 * direction "lower_is_better": lowest value -> 100, highest value -> 0
 */
function computeSignalPercentiles(
    observations: Array<{ wallet: string; value: number }>,
    direction: "higher_is_better" | "lower_is_better"
): Map<string, number> {
    const N = observations.length;
    const resultMap = new Map<string, number>();

    if (N === 0) return resultMap;
    if (N === 1) {
        resultMap.set(observations[0].wallet, 100);
        return resultMap;
    }

    // Sort ascending by raw value
    const sorted = [...observations].sort((a, b) => a.value - b.value);

    let i = 0;
    while (i < N) {
        let j = i;
        while (j < N && Math.abs(sorted[j].value - sorted[i].value) < 1e-12) {
            j++;
        }
        // Fractional average rank (1-indexed)
        const avgRank = (i + 1 + j) / 2;
        const percentile0To1 = (avgRank - 1) / (N - 1);
        const percentile100 = direction === "higher_is_better"
            ? percentile0To1 * 100
            : (1 - percentile0To1) * 100;

        const normalized = Number(Math.max(0, Math.min(100, percentile100)).toFixed(4));

        for (let k = i; k < j; k++) {
            resultMap.set(sorted[k].wallet, normalized);
        }

        i = j;
    }

    return resultMap;
}

export function buildQualityScores(dataset: any): V1QualityScoresOutput {
    if (!dataset || !Array.isArray(dataset.wallets)) {
        throw new Error("Invalid screening dataset: missing or malformed wallets array");
    }

    // Filter to valid wallets only (target cohort)
    const validWallets: any[] = dataset.wallets.filter((w: any) => w?.valid === true && w?.metrics);

    if (validWallets.length === 0) {
        throw new Error("No valid wallets found in dataset");
    }

    // Prepare observations for each of the 4 signals
    const medianPnlPctObs: Array<{ wallet: string; value: number }> = [];
    const profitFactorObs: Array<{ wallet: string; value: number }> = [];
    const winRateObs: Array<{ wallet: string; value: number }> = [];
    const concentrationObs: Array<{ wallet: string; value: number }> = [];

    for (const w of validWallets) {
        const m = w.metrics;
        medianPnlPctObs.push({ wallet: w.wallet, value: Number(m.medianPositionPnlPct ?? 0) });
        profitFactorObs.push({ wallet: w.wallet, value: Number(m.profitFactor ?? 0) });
        winRateObs.push({ wallet: w.wallet, value: Number(m.positionWinRate ?? 0) });
        concentrationObs.push({ wallet: w.wallet, value: Number(m.pnlConcentrationTop1 ?? 0) });
    }

    // Calculate percentiles
    const medianPnlPctRankMap = computeSignalPercentiles(medianPnlPctObs, "higher_is_better");
    const profitFactorRankMap = computeSignalPercentiles(profitFactorObs, "higher_is_better");
    const winRateRankMap = computeSignalPercentiles(winRateObs, "higher_is_better");
    const concentrationRankMap = computeSignalPercentiles(concentrationObs, "lower_is_better");

    // Assemble wallet quality records
    const scoredWallets: V1WalletQualityRecord[] = validWallets.map((w) => {
        const m = w.metrics;
        const wallet = w.wallet;

        const pnlPctPctile = medianPnlPctRankMap.get(wallet) ?? 0;
        const pfPctile = profitFactorRankMap.get(wallet) ?? 0;
        const winRatePctile = winRateRankMap.get(wallet) ?? 0;
        const invConcPctile = concentrationRankMap.get(wallet) ?? 0;

        const rawScore =
            pnlPctPctile * FORMULA_WEIGHTS.medianPositionPnlPct +
            pfPctile * FORMULA_WEIGHTS.profitFactor +
            winRatePctile * FORMULA_WEIGHTS.positionWinRate +
            invConcPctile * FORMULA_WEIGHTS.inversePnlConcentrationTop1;

        const qualityScore = Number(rawScore.toFixed(2));

        return {
            wallet,
            qualityScore,
            raw: {
                medianPositionPnlPct: Number(m.medianPositionPnlPct ?? 0),
                profitFactor: Number(m.profitFactor ?? 0),
                positionWinRate: Number(m.positionWinRate ?? 0),
                pnlConcentrationTop1: Number(m.pnlConcentrationTop1 ?? 0),
                totalPnl: Number(m.totalPnl ?? 0),
                closedPositionCount: Number(m.closedPositionCount ?? w.positions?.length ?? 0),
            },
            components: {
                medianPositionPnlPctPercentile: pnlPctPctile,
                profitFactorPercentile: pfPctile,
                positionWinRatePercentile: winRatePctile,
                inverseConcentrationPercentile: invConcPctile,
            },
        };
    });

    // Deterministic sort: qualityScore desc, wallet asc
    scoredWallets.sort((a, b) => {
        if (b.qualityScore !== a.qualityScore) {
            return b.qualityScore - a.qualityScore;
        }
        return a.wallet.localeCompare(b.wallet);
    });

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        population: {
            wallets: scoredWallets.length,
        },
        formula: FORMULA_WEIGHTS,
        wallets: scoredWallets,
    };
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset not found at: ${cli.datasetPath}`);
    }

    console.log("==================================================");
    console.log("V1 — WALLET QUALITY SCORE BUILDER");
    console.log("==================================================");
    console.log(`Source Dataset          : ${cli.datasetPath}`);
    console.log(`Target Output           : ${cli.outputPath}`);

    const rawData = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const output = buildQualityScores(rawData);

    atomicWriteJson(cli.outputPath, output);

    console.log(`Valid Wallets Scored    : ${output.population.wallets}`);
    console.log(`Quality Score Range     : [${output.wallets[output.wallets.length - 1]?.qualityScore} .. ${output.wallets[0]?.qualityScore}]`);
    console.log(`Artifact Written To     : ${cli.outputPath}`);
    console.log("==================================================\n");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-quality-scores.ts") ||
        process.argv[1].endsWith("build-wallet-quality-scores.js") ||
        process.argv[1].includes("build-wallet-quality-scores") ||
        process.argv[1].includes("compute-wallet-quality-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to build V1 quality scores: ${err?.message || err}`);
        process.exit(1);
    });
}
