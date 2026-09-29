import fs from "node:fs";
import path from "node:path";

export interface V1ConfidenceFormula {
    positionSampleScore: number;
    historySpanScore: number;
    positionSampleSaturation: number;
    historyWindowDays: number;
}

export interface V1WalletConfidenceRaw {
    closedPositionCount: number;
    historySpanDays: number;
    earliestRelevantTimestamp: string | null;
    latestRelevantTimestamp: string | null;
}

export interface V1WalletConfidenceComponents {
    positionSampleScore: number;
    historySpanScore: number;
}

export interface V1WalletConfidenceRecord {
    wallet: string;
    confidenceScore: number;
    raw: V1WalletConfidenceRaw;
    components: V1WalletConfidenceComponents;
}

export interface V1ConfidenceScoresOutput {
    generatedAt: string;
    version: "v1";
    population: {
        wallets: number;
    };
    semantics: {
        higherScoreMeans: string;
    };
    formula: V1ConfidenceFormula;
    wallets: V1WalletConfidenceRecord[];
}

export const CONFIDENCE_FORMULA: V1ConfidenceFormula = {
    positionSampleScore: 0.75,
    historySpanScore: 0.25,
    positionSampleSaturation: 200,
    historyWindowDays: 30,
};

interface CliOptions {
    datasetPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-confidence-scores.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === "--dataset" || arg === "--input") && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=") || arg.startsWith("--input=")) {
            datasetPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(args[i + 1]);
        }
    }

    if (!fs.existsSync(datasetPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-screening-dataset.json");
        if (fs.existsSync(alt)) datasetPath = alt;
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

export function parseTimestampMs(ts: string | number | null | undefined): number | null {
    if (ts === null || ts === undefined || ts === "") return null;
    if (typeof ts === "number") {
        return ts > 1e11 ? ts : ts * 1000;
    }
    const str = String(ts).trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) {
        const num = Number(str);
        return num > 1e11 ? num : num * 1000;
    }
    const isoStr = str.includes("T") ? str : str.replace(" ", "T") + (str.endsWith("Z") ? "" : "Z");
    const parsed = Date.parse(isoStr);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Calculates absolute evidence-based confidence score for valid wallets.
 */
export function buildConfidenceScores(dataset: any): V1ConfidenceScoresOutput {
    if (!dataset || !Array.isArray(dataset.wallets)) {
        throw new Error("Invalid screening dataset: missing or malformed wallets array");
    }

    const validWallets: any[] = dataset.wallets.filter((w: any) => w?.valid === true);
    if (validWallets.length === 0) {
        throw new Error("No valid wallets found in screening dataset");
    }

    const scoredWallets: V1WalletConfidenceRecord[] = validWallets.map((w) => {
        const wallet = String(w.wallet).trim();
        const positions: any[] = Array.isArray(w.positions) ? w.positions : [];
        const closedPositionCount = Number(w.metrics?.closedPositionCount ?? positions.length);

        // Component 1: Position Sample Size
        // positionSampleScore = min(100, sqrt(closedPositionCount / 200) * 100)
        const rawSampleScore = Math.min(
            100,
            Math.sqrt(Math.max(0, closedPositionCount) / CONFIDENCE_FORMULA.positionSampleSaturation) * 100
        );
        const positionSampleScore = Number(rawSampleScore.toFixed(2));

        // Component 2: History Span
        // Find earliest openedAt and latest closedAt across closed positions
        let minOpenedMs = Infinity;
        let maxClosedMs = -Infinity;
        let minAnyMs = Infinity;
        let maxAnyMs = -Infinity;

        for (const p of positions) {
            const openMs = parseTimestampMs(p.openedAt);
            const closeMs = parseTimestampMs(p.closedAt);

            if (openMs !== null) {
                if (openMs < minOpenedMs) minOpenedMs = openMs;
                if (openMs < minAnyMs) minAnyMs = openMs;
                if (openMs > maxAnyMs) maxAnyMs = openMs;
            }
            if (closeMs !== null) {
                if (closeMs > maxClosedMs) maxClosedMs = closeMs;
                if (closeMs < minAnyMs) minAnyMs = closeMs;
                if (closeMs > maxAnyMs) maxAnyMs = closeMs;
            }
        }

        const earliestMs = Number.isFinite(minOpenedMs)
            ? minOpenedMs
            : Number.isFinite(minAnyMs)
            ? minAnyMs
            : null;
        const latestMs = Number.isFinite(maxClosedMs)
            ? maxClosedMs
            : Number.isFinite(maxAnyMs)
            ? maxAnyMs
            : null;

        let historySpanDays = 0;
        let earliestRelevantTimestamp: string | null = null;
        let latestRelevantTimestamp: string | null = null;

        if (earliestMs !== null && latestMs !== null) {
            earliestRelevantTimestamp = new Date(earliestMs).toISOString();
            latestRelevantTimestamp = new Date(latestMs).toISOString();

            const rawSpanDays = (latestMs - earliestMs) / 86400000;
            // Clamp: 0 <= historySpanDays <= 30
            const clampedSpanDays = Math.max(0, Math.min(CONFIDENCE_FORMULA.historyWindowDays, rawSpanDays));
            historySpanDays = Number(clampedSpanDays.toFixed(2));
        }

        // historySpanScore = min(100, historySpanDays / 30 * 100)
        const rawSpanScore = Math.min(
            100,
            (historySpanDays / CONFIDENCE_FORMULA.historyWindowDays) * 100
        );
        const historySpanScore = Number(Math.max(0, rawSpanScore).toFixed(2));

        // Final Confidence Formula:
        // confidenceScore = positionSampleScore * 0.75 + historySpanScore * 0.25
        const rawConfidence =
            positionSampleScore * CONFIDENCE_FORMULA.positionSampleScore +
            historySpanScore * CONFIDENCE_FORMULA.historySpanScore;

        const confidenceScore = Number(Math.max(0, Math.min(100, rawConfidence)).toFixed(2));

        return {
            wallet,
            confidenceScore,
            raw: {
                closedPositionCount,
                historySpanDays,
                earliestRelevantTimestamp,
                latestRelevantTimestamp,
            },
            components: {
                positionSampleScore,
                historySpanScore,
            },
        };
    });

    // Sort descending by confidenceScore (highest confidence first), tie-break by wallet
    scoredWallets.sort((a, b) => {
        if (Math.abs(b.confidenceScore - a.confidenceScore) > 1e-6) {
            return b.confidenceScore - a.confidenceScore;
        }
        return a.wallet.localeCompare(b.wallet);
    });

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        population: {
            wallets: scoredWallets.length,
        },
        semantics: {
            higherScoreMeans: "stronger_historical_evidence",
        },
        formula: { ...CONFIDENCE_FORMULA },
        wallets: scoredWallets,
    };
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset file not found: ${cli.datasetPath}`);
    }

    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const output = buildConfidenceScores(datasetRaw);

    atomicWriteJson(cli.outputPath, output);

    console.log("==================================================");
    console.log("V1 — WALLET CONFIDENCE SCORE GENERATION");
    console.log("==================================================");
    console.log(`Input Screening Dataset: ${cli.datasetPath}`);
    console.log(`Output Confidence Scores: ${cli.outputPath}`);
    console.log(`Wallets Scored         : ${output.population.wallets}`);
    console.log(`Formula Weights        : SampleSize (${CONFIDENCE_FORMULA.positionSampleScore * 100}%), HistorySpan (${CONFIDENCE_FORMULA.historySpanScore * 100}%)`);
    if (output.wallets.length > 0) {
        const scores = output.wallets.map((w) => w.confidenceScore);
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        console.log(`Confidence Score Range : ${min} -> ${max}`);
    }
    console.log("==================================================\n");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-confidence-scores.ts") ||
        process.argv[1].endsWith("build-wallet-confidence-scores.js") ||
        process.argv[1].includes("build-wallet-confidence-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to build V1 confidence scores: ${err?.message || err}`);
        process.exit(1);
    });
}
