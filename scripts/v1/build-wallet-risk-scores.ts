import fs from "node:fs";
import path from "node:path";

export interface V1RiskScoreFormula {
    cvar10PositionPnlPct: number;
    negativeDayRate: number;
    medianLosingPositionPnlPct: number;
}

export interface V1WalletRiskRaw {
    cvar10PositionPnlPct: number;
    negativeDayRate: number;
    medianLosingPositionPnlPct: number;
}

export interface V1WalletRiskComponents {
    cvar10RiskPercentile: number;
    negativeDayRateRiskPercentile: number;
    medianLosingPnlRiskPercentile: number;
}

export interface V1WalletRiskRecord {
    wallet: string;
    riskScore: number;
    raw: V1WalletRiskRaw;
    components: V1WalletRiskComponents;
}

export interface V1RiskScoresOutput {
    generatedAt: string;
    version: "v1";
    population: {
        wallets: number;
    };
    semantics: {
        higherScoreMeans: string;
    };
    formula: V1RiskScoreFormula;
    wallets: V1WalletRiskRecord[];
}

export const RISK_FORMULA_WEIGHTS: V1RiskScoreFormula = {
    cvar10PositionPnlPct: 0.45,
    negativeDayRate: 0.30,
    medianLosingPositionPnlPct: 0.25,
};

interface CliOptions {
    riskMetricsPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let riskMetricsPath = path.resolve("data/v1/wallet-risk-metrics.json");
    let outputPath = path.resolve("data/v1/wallet-risk-scores.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === "--risk" || arg === "--input") && args[i + 1]) {
            riskMetricsPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--risk=") || arg.startsWith("--input=")) {
            riskMetricsPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    if (!fs.existsSync(riskMetricsPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-risk-metrics.json");
        if (fs.existsSync(alt)) riskMetricsPath = alt;
    }

    return { riskMetricsPath, outputPath };
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
 * 
 * Direction semantics:
 * - "lower_is_riskier": more negative / lower raw value -> 100 (highest risk), highest raw value -> 0 (lowest risk)
 *   Used for cvar10PositionPnlPct and medianLosingPositionPnlPct.
 * - "higher_is_riskier": higher raw value -> 100 (highest risk), lowest raw value -> 0 (lowest risk)
 *   Used for negativeDayRate.
 */
export function computeRiskPercentiles(
    observations: Array<{ wallet: string; value: number }>,
    direction: "higher_is_riskier" | "lower_is_riskier"
): Map<string, number> {
    const N = observations.length;
    const resultMap = new Map<string, number>();

    if (N === 0) return resultMap;
    if (N === 1) {
        resultMap.set(observations[0].wallet, 50);
        return resultMap;
    }

    // Sort ascending by raw value, tie-break deterministically by wallet address
    const sorted = [...observations].sort((a, b) => {
        if (Math.abs(a.value - b.value) > 1e-12) {
            return a.value - b.value;
        }
        return a.wallet.localeCompare(b.wallet);
    });

    let i = 0;
    while (i < N) {
        let j = i;
        while (j < N && Math.abs(sorted[j].value - sorted[i].value) < 1e-12) {
            j++;
        }
        // Fractional average rank (1-indexed)
        const avgRank = (i + 1 + j) / 2;
        const percentile0To1 = (avgRank - 1) / (N - 1);

        // For lower_is_riskier, lowest (most negative) gets 100% risk
        const riskPercentile100 = direction === "higher_is_riskier"
            ? percentile0To1 * 100
            : (1 - percentile0To1) * 100;

        const normalized = Number(Math.max(0, Math.min(100, riskPercentile100)).toFixed(4));

        for (let k = i; k < j; k++) {
            resultMap.set(sorted[k].wallet, normalized);
        }

        i = j;
    }

    return resultMap;
}

export function buildRiskScores(riskData: any): V1RiskScoresOutput {
    if (!riskData || !Array.isArray(riskData.wallets)) {
        throw new Error("Invalid risk metrics data: missing or malformed wallets array");
    }

    const wallets: any[] = riskData.wallets;
    if (wallets.length === 0) {
        throw new Error("No wallets found in risk metrics data");
    }

    // Prepare observations for each of the 3 candidate signals
    const cvarObs: Array<{ wallet: string; value: number }> = [];
    const negDayObs: Array<{ wallet: string; value: number }> = [];
    const medLossObs: Array<{ wallet: string; value: number }> = [];

    for (const w of wallets) {
        const wallet = String(w.wallet).trim();
        const pRisk = w.positionRisk || {};
        const dRisk = w.dailyRisk || {};

        const cvarVal = Number(pRisk.cvar10PositionPnlPct ?? 0);
        const negDayVal = Number(dRisk.negativeDayRate ?? 0);
        const medLossVal = Number(pRisk.medianLosingPositionPnlPct ?? 0);

        cvarObs.push({ wallet, value: cvarVal });
        negDayObs.push({ wallet, value: negDayVal });
        medLossObs.push({ wallet, value: medLossVal });
    }

    // Compute cohort percentiles
    // cvar10: lower / more negative = higher risk
    const cvarRankMap = computeRiskPercentiles(cvarObs, "lower_is_riskier");
    // negativeDayRate: higher = higher risk
    const negDayRankMap = computeRiskPercentiles(negDayObs, "higher_is_riskier");
    // medianLosingPositionPnlPct: lower / more negative = higher risk
    const medLossRankMap = computeRiskPercentiles(medLossObs, "lower_is_riskier");

    // Assemble wallet risk records
    const scoredWallets: V1WalletRiskRecord[] = wallets.map((w) => {
        const wallet = String(w.wallet).trim();
        const pRisk = w.positionRisk || {};
        const dRisk = w.dailyRisk || {};

        const cvarRaw = Number(pRisk.cvar10PositionPnlPct ?? 0);
        const negDayRaw = Number(dRisk.negativeDayRate ?? 0);
        const medLossRaw = Number(pRisk.medianLosingPositionPnlPct ?? 0);

        const cvarPctile = cvarRankMap.get(wallet) ?? 0;
        const negDayPctile = negDayRankMap.get(wallet) ?? 0;
        const medLossPctile = medLossRankMap.get(wallet) ?? 0;

        const rawScore =
            cvarPctile * RISK_FORMULA_WEIGHTS.cvar10PositionPnlPct +
            negDayPctile * RISK_FORMULA_WEIGHTS.negativeDayRate +
            medLossPctile * RISK_FORMULA_WEIGHTS.medianLosingPositionPnlPct;

        const riskScore = Number(Math.max(0, Math.min(100, rawScore)).toFixed(2));

        return {
            wallet,
            riskScore,
            raw: {
                cvar10PositionPnlPct: cvarRaw,
                negativeDayRate: negDayRaw,
                medianLosingPositionPnlPct: medLossRaw,
            },
            components: {
                cvar10RiskPercentile: cvarPctile,
                negativeDayRateRiskPercentile: negDayPctile,
                medianLosingPnlRiskPercentile: medLossPctile,
            },
        };
    });

    // Sort descending by riskScore (highest risk first), tie-break by wallet
    scoredWallets.sort((a, b) => {
        if (Math.abs(b.riskScore - a.riskScore) > 1e-6) {
            return b.riskScore - a.riskScore;
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
            higherScoreMeans: "higher_observed_historical_risk",
        },
        formula: { ...RISK_FORMULA_WEIGHTS },
        wallets: scoredWallets,
    };
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.riskMetricsPath)) {
        throw new Error(`Risk metrics file not found: ${cli.riskMetricsPath}`);
    }

    const riskRaw = JSON.parse(fs.readFileSync(cli.riskMetricsPath, "utf8"));
    const output = buildRiskScores(riskRaw);

    atomicWriteJson(cli.outputPath, output);

    console.log("==================================================");
    console.log("V1 — WALLET RISK SCORE GENERATION");
    console.log("==================================================");
    console.log(`Input Risk Metrics  : ${cli.riskMetricsPath}`);
    console.log(`Output Risk Scores  : ${cli.outputPath}`);
    console.log(`Wallets Scored      : ${output.population.wallets}`);
    console.log(`Formula Weights     : CVaR10 (${RISK_FORMULA_WEIGHTS.cvar10PositionPnlPct * 100}%), NegativeDayRate (${RISK_FORMULA_WEIGHTS.negativeDayRate * 100}%), MedianLoss (${RISK_FORMULA_WEIGHTS.medianLosingPositionPnlPct * 100}%)`);
    if (output.wallets.length > 0) {
        const scores = output.wallets.map((w) => w.riskScore);
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        console.log(`Risk Score Range    : ${min} -> ${max}`);
    }
    console.log("==================================================\n");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-risk-scores.ts") ||
        process.argv[1].endsWith("build-wallet-risk-scores.js") ||
        process.argv[1].includes("build-wallet-risk-scores"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to build V1 risk scores: ${err?.message || err}`);
        process.exit(1);
    });
}
