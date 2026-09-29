import fs from "node:fs";
import path from "node:path";

export interface PositionRiskMetrics {
    worstPositionPnlPct: number;
    p10PositionPnlPct: number;
    cvar10PositionPnlPct: number;
    downsideDeviationPositionPct: number;
    positionPnlPctStdDev: number;
    medianLosingPositionPnlPct: number | null;
    lossPositionRate: number;
}

export interface DailyRiskMetrics {
    worstDayPnlUsd: number;
    bestDayPnlUsd: number;
    dailyPnlStdDevUsd: number;
    negativeDayRate: number;
    positiveDayRate: number;
    maxCumulativePnlDrawdownUsd: number;
}

export interface RiskContextMetrics {
    totalDeposits: number;
    worstDayPnlToDepositsPct: number | null;
    maxDrawdownToDepositsPct: number | null;
}

export interface WalletRiskRecord {
    wallet: string;
    positionRisk: PositionRiskMetrics;
    dailyRisk: DailyRiskMetrics;
    context: RiskContextMetrics;
}

export interface WalletRiskMetricsOutput {
    generatedAt: string;
    version: "v1";
    population: {
        wallets: number;
    };
    wallets: WalletRiskRecord[];
}

interface CliOptions {
    datasetPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-risk-metrics.json");

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

function computePercentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const rank = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    if (lower === upper) return sortedValues[lower];
    return Number((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight).toFixed(4));
}

function computeSampleStdDev(values: number[]): number {
    if (values.length <= 1) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Number(Math.sqrt(variance).toFixed(4));
}

export function computePositionRisk(positions: any[]): PositionRiskMetrics {
    const validPositions = Array.isArray(positions) ? positions : [];

    // Extract valid position PnL % returns
    const pnlPcts: number[] = [];
    let lossCount = 0;

    for (const p of validPositions) {
        if (typeof p.pnlPct === "number" && Number.isFinite(p.pnlPct)) {
            pnlPcts.push(p.pnlPct);
        }
        if (typeof p.pnl === "number" && p.pnl < 0) {
            lossCount++;
        } else if (p.winLoss === "LOSS") {
            lossCount++;
        }
    }

    const closedPositionCount = validPositions.length;
    const lossPositionRate = closedPositionCount > 0
        ? Number(((lossCount / closedPositionCount) * 100).toFixed(2))
        : 0;

    if (pnlPcts.length === 0) {
        return {
            worstPositionPnlPct: 0,
            p10PositionPnlPct: 0,
            cvar10PositionPnlPct: 0,
            downsideDeviationPositionPct: 0,
            positionPnlPctStdDev: 0,
            medianLosingPositionPnlPct: null,
            lossPositionRate,
        };
    }

    const sortedPnlPcts = [...pnlPcts].sort((a, b) => a - b);
    const worstPositionPnlPct = Number(sortedPnlPcts[0].toFixed(4));
    const p10PositionPnlPct = computePercentile(sortedPnlPcts, 10);

    // CVaR 10%: Mean PnL % of the worst 10% of closed positions
    const worst10Count = Math.max(1, Math.ceil(sortedPnlPcts.length * 0.10));
    const worst10Slice = sortedPnlPcts.slice(0, worst10Count);
    const cvar10PositionPnlPct = Number(
        (worst10Slice.reduce((sum, v) => sum + v, 0) / worst10Count).toFixed(4)
    );

    // Downside deviation: sqrt(mean(min(r, 0)^2))
    const downsideSquaredSum = pnlPcts.reduce((sum, r) => {
        const downside = Math.min(r, 0);
        return sum + downside * downside;
    }, 0);
    const downsideDeviationPositionPct = Number(
        Math.sqrt(downsideSquaredSum / pnlPcts.length).toFixed(4)
    );

    // Position PnL % standard deviation
    const positionPnlPctStdDev = computeSampleStdDev(pnlPcts);

    // Median losing position PnL %
    const losingPnlPcts = sortedPnlPcts.filter((r) => r < 0);
    const medianLosingPositionPnlPct = losingPnlPcts.length > 0
        ? computePercentile(losingPnlPcts, 50)
        : null;

    return {
        worstPositionPnlPct,
        p10PositionPnlPct,
        cvar10PositionPnlPct,
        downsideDeviationPositionPct,
        positionPnlPctStdDev,
        medianLosingPositionPnlPct,
        lossPositionRate,
    };
}

export function computeDailyRisk(dailyRecords: any[]): DailyRiskMetrics {
    const rawDaily = Array.isArray(dailyRecords) ? dailyRecords : [];

    // Chronologically sort daily records
    const sortedDaily = [...rawDaily].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const dailyPnls = sortedDaily.map((d) => Number(d.pnlUsd ?? 0));

    if (dailyPnls.length === 0) {
        return {
            worstDayPnlUsd: 0,
            bestDayPnlUsd: 0,
            dailyPnlStdDevUsd: 0,
            negativeDayRate: 0,
            positiveDayRate: 0,
            maxCumulativePnlDrawdownUsd: 0,
        };
    }

    const worstDayPnlUsd = Number(Math.min(...dailyPnls).toFixed(4));
    const bestDayPnlUsd = Number(Math.max(...dailyPnls).toFixed(4));
    const dailyPnlStdDevUsd = computeSampleStdDev(dailyPnls);

    const negativeDays = dailyPnls.filter((p) => p < 0).length;
    const positiveDays = dailyPnls.filter((p) => p > 0).length;
    const totalDays = dailyPnls.length;

    const negativeDayRate = Number(((negativeDays / totalDays) * 100).toFixed(2));
    const positiveDayRate = Number(((positiveDays / totalDays) * 100).toFixed(2));

    // Calculate max cumulative PnL drawdown chronologically
    let cumPnl = 0;
    let runningPeak = 0;
    let maxDrawdown = 0; // drawdowns <= 0

    for (let t = 0; t < dailyPnls.length; t++) {
        cumPnl += dailyPnls[t];
        if (t === 0) {
            runningPeak = cumPnl;
        } else {
            runningPeak = Math.max(runningPeak, cumPnl);
        }
        const drawdown = cumPnl - runningPeak;
        if (drawdown < maxDrawdown) {
            maxDrawdown = drawdown;
        }
    }

    const maxCumulativePnlDrawdownUsd = Number(maxDrawdown.toFixed(4));

    return {
        worstDayPnlUsd,
        bestDayPnlUsd,
        dailyPnlStdDevUsd,
        negativeDayRate,
        positiveDayRate,
        maxCumulativePnlDrawdownUsd,
    };
}

export function buildRiskMetrics(dataset: any): WalletRiskMetricsOutput {
    if (!dataset || !Array.isArray(dataset.wallets)) {
        throw new Error("Invalid screening dataset: missing or malformed wallets array");
    }

    const validWallets: any[] = dataset.wallets.filter((w: any) => w?.valid === true && w?.metrics);

    if (validWallets.length === 0) {
        throw new Error("No valid wallets found in dataset");
    }

    const riskRecords: WalletRiskRecord[] = validWallets.map((w) => {
        const wallet = w.wallet;
        const positionRisk = computePositionRisk(w.positions);
        const dailyRisk = computeDailyRisk(w.daily);

        const totalDeposits = Number(w.metrics?.totalDeposits ?? 0);
        const worstDayPnlToDepositsPct = totalDeposits > 0
            ? Number(((dailyRisk.worstDayPnlUsd / totalDeposits) * 100).toFixed(4))
            : null;
        const maxDrawdownToDepositsPct = totalDeposits > 0
            ? Number(((dailyRisk.maxCumulativePnlDrawdownUsd / totalDeposits) * 100).toFixed(4))
            : null;

        return {
            wallet,
            positionRisk,
            dailyRisk,
            context: {
                totalDeposits,
                worstDayPnlToDepositsPct,
                maxDrawdownToDepositsPct,
            },
        };
    });

    // Sort deterministically by wallet address
    riskRecords.sort((a, b) => a.wallet.localeCompare(b.wallet));

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        population: {
            wallets: riskRecords.length,
        },
        wallets: riskRecords,
    };
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset not found at: ${cli.datasetPath}`);
    }

    console.log("==================================================");
    console.log("V1 — WALLET RISK METRICS BUILDER");
    console.log("==================================================");
    console.log(`Source Dataset          : ${cli.datasetPath}`);
    console.log(`Target Output           : ${cli.outputPath}`);

    const rawData = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const output = buildRiskMetrics(rawData);

    atomicWriteJson(cli.outputPath, output);

    console.log(`Valid Wallets Processed : ${output.population.wallets}`);
    console.log(`Artifact Written To     : ${cli.outputPath}`);
    console.log("==================================================\n");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-risk-metrics.ts") ||
        process.argv[1].endsWith("build-wallet-risk-metrics.js") ||
        process.argv[1].includes("build-wallet-risk-metrics") ||
        process.argv[1].includes("compute-wallet-risk-metrics"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Failed to build V1 risk metrics: ${err?.message || err}`);
        process.exit(1);
    });
}
