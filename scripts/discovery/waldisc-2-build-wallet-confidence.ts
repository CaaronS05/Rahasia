import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    inputFile: string;
    outputFile: string;
}

interface WalletEvidence {
    closedPositions: number;
    uniquePools: number;
    strategyCoveragePct: number;
    positionsWithRange: number;
    positionsWithoutRange: number;
    noLiquidityPositions: number;
    rangeCoveragePct: number;
}

interface ConfidenceComponents {
    positionDepthConfidence: number;
    poolDiversityConfidence: number;
    strategyCoverageConfidence: number;
    rangeCoverageConfidence: number;
}

interface WalletConfidenceScores {
    general: number;
    generalPct: number;
    performance: number;
    performancePct: number;
    range: number;
    rangePct: number;
}

interface WalletConfidenceRecord {
    wallet: string;
    evidence: WalletEvidence;
    components: ConfidenceComponents;
    confidence: WalletConfidenceScores;
}

interface ConfidenceDistributionSummary {
    count: number;
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
    p25: number | null;
    p75: number | null;
}

interface WalletConfidenceOutput {
    generatedAt: string;
    walletCount: number;
    methodology: {
        purpose: "evidence_confidence_only";
        skillIncluded: false;
        rankingIncluded: false;
        positionDepthFunction: "1 - exp(-closedPositions / 10)";
        poolDiversityFunction: "1 - exp(-uniquePools / 3)";
        strategyCoverageFunction: "strategyCoveragePct / 100";
        rangeCoverageFunction: "positionsWithRange / closedPositions";
        weights: {
            general: {
                positionDepth: number;
                poolDiversity: number;
                strategyCoverage: number;
                rangeCoverage: number;
            };
            performance: {
                positionDepth: number;
                poolDiversity: number;
                strategyCoverage: number;
            };
            range: {
                positionDepth: number;
                poolDiversity: number;
                rangeCoverage: number;
            };
        };
    };
    cohortSummary: Record<string, ConfidenceDistributionSummary>;
    wallets: WalletConfidenceRecord[];
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
        inputFile:
            options.input ||
            options.dataset ||
            options["input-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-confidence.json"),
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

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[sorted.length - 1];

    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (lower === upper) {
        return sorted[lower];
    }
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function computeStats(values: number[]): ConfidenceDistributionSummary {
    if (values.length === 0) {
        return {
            count: 0,
            mean: null,
            median: null,
            min: null,
            max: null,
            p25: null,
            p75: null,
        };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    return {
        count: sorted.length,
        mean: Math.round(mean * 10000) / 10000,
        median: Math.round(percentile(sorted, 50) * 10000) / 10000,
        min: Math.round(min * 10000) / 10000,
        max: Math.round(max * 10000) / 10000,
        p25: Math.round(percentile(sorted, 25) * 10000) / 10000,
        p75: Math.round(percentile(sorted, 75) * 10000) / 10000,
    };
}

async function main() {
    const { inputFile, outputFile } = parseCliArgs();

    if (!fs.existsSync(inputFile)) {
        throw new Error(`Input behaviour dataset file not found: ${inputFile}`);
    }

    const dataset = tryReadJson(inputFile);
    if (!dataset || !Array.isArray(dataset.wallets)) {
        throw new Error(`Invalid behaviour dataset schema in ${inputFile}: 'wallets' array missing`);
    }

    const rawWallets: any[] = dataset.wallets;
    const totalWallets = rawWallets.length;

    if (totalWallets === 0) {
        throw new Error(`No wallets found in behaviour dataset: ${inputFile}`);
    }

    // Weights definition
    const WEIGHTS = {
        general: {
            positionDepth: 0.40,
            poolDiversity: 0.25,
            strategyCoverage: 0.25,
            rangeCoverage: 0.10,
        },
        performance: {
            positionDepth: 0.45,
            poolDiversity: 0.30,
            strategyCoverage: 0.25,
        },
        range: {
            positionDepth: 0.35,
            poolDiversity: 0.25,
            rangeCoverage: 0.40,
        },
    };

    const walletRecords: WalletConfidenceRecord[] = [];

    for (const w of rawWallets) {
        if (!w || typeof w.wallet !== "string") continue;

        const walletAddress = w.wallet;
        const closedPositions = typeof w.closedPositions === "number" ? w.closedPositions : 0;
        const uniquePools = typeof w.uniquePools === "number" ? w.uniquePools : 0;

        // Read source wallet-behaviour.json to get authoritative coverage data
        let sourceData: any = null;
        if (typeof w.sourceFile === "string" && w.sourceFile.trim()) {
            const resolvedSourcePath = path.resolve(w.sourceFile);
            sourceData = tryReadJson(resolvedSourcePath);
        }

        // Coverage and position counts
        let positionsWithRange = sourceData?.coverage?.positionsWithRange;
        let positionsWithoutRange = sourceData?.coverage?.positionsWithoutRange;
        let noLiquidityPositions = sourceData?.coverage?.noLiquidityPositions;
        let rangeCoveragePct = sourceData?.coverage?.rangeCoveragePct;
        const strategyCoveragePct = Number(sourceData?.coverage?.strategyCoveragePct ?? 100);

        if (typeof positionsWithRange !== "number" && Array.isArray(sourceData?.positions)) {
            positionsWithRange = sourceData.positions.filter(
                (p: any) => p && typeof p.lowerBin === "number" && typeof p.upperBin === "number"
            ).length;
            positionsWithoutRange = closedPositions - positionsWithRange;
            noLiquidityPositions = sourceData.positions.filter(
                (p: any) =>
                    p &&
                    (p.rangeAvailability === "NO_LIQUIDITY" ||
                        (p.lowerBin === null && p.upperBin === null))
            ).length;
            rangeCoveragePct =
                closedPositions > 0 ? (positionsWithRange / closedPositions) * 100 : 0;
        } else if (typeof positionsWithRange !== "number") {
            if (
                w.rangeBehaviour?.rangeWidthPct?.median !== null &&
                w.rangeBehaviour?.rangeWidthPct?.median !== undefined
            ) {
                positionsWithRange = closedPositions;
                positionsWithoutRange = 0;
                noLiquidityPositions = 0;
                rangeCoveragePct = 100;
            } else {
                positionsWithRange = 0;
                positionsWithoutRange = closedPositions;
                noLiquidityPositions = closedPositions;
                rangeCoveragePct = 0;
            }
        }

        positionsWithRange = Number(positionsWithRange ?? 0);
        positionsWithoutRange = Number(positionsWithoutRange ?? (closedPositions - positionsWithRange));
        noLiquidityPositions = Number(noLiquidityPositions ?? 0);
        rangeCoveragePct = Number(
            rangeCoveragePct ??
            (closedPositions > 0 ? (positionsWithRange / closedPositions) * 100 : 0)
        );

        // ==================================================
        // 1. POSITION DEPTH CONFIDENCE
        // Saturating diminishing returns: 1 - exp(-closedPositions / 10)
        // ==================================================
        const positionDepthConfidence = Math.max(
            0,
            Math.min(1, 1 - Math.exp(-closedPositions / 10))
        );

        // ==================================================
        // 2. POOL DIVERSITY CONFIDENCE
        // Diversity across DLMM pool environments: 1 - exp(-uniquePools / 3)
        // ==================================================
        const poolDiversityConfidence = Math.max(
            0,
            Math.min(1, 1 - Math.exp(-uniquePools / 3))
        );

        // ==================================================
        // 3. STRATEGY COVERAGE CONFIDENCE
        // Pipeline coverage of on-chain operations: strategyCoveragePct / 100
        // ==================================================
        const strategyCoverageConfidence = Math.max(
            0,
            Math.min(1, strategyCoveragePct / 100)
        );

        // ==================================================
        // 4. RANGE COVERAGE CONFIDENCE
        // Position-level occupied range evidence: positionsWithRange / closedPositions
        // ==================================================
        const rangeCoverageConfidence =
            closedPositions > 0
                ? Math.max(0, Math.min(1, positionsWithRange / closedPositions))
                : 0;

        // ==================================================
        // GENERAL EVIDENCE CONFIDENCE
        // 40% Depth + 25% Diversity + 25% Strategy + 10% Range
        // ==================================================
        const generalConfidence = Math.max(
            0,
            Math.min(
                1,
                WEIGHTS.general.positionDepth * positionDepthConfidence +
                WEIGHTS.general.poolDiversity * poolDiversityConfidence +
                WEIGHTS.general.strategyCoverage * strategyCoverageConfidence +
                WEIGHTS.general.rangeCoverage * rangeCoverageConfidence
            )
        );
        const generalConfidencePct = generalConfidence * 100;

        // ==================================================
        // PERFORMANCE CONFIDENCE
        // Evidence for PnL / WinRate (does not require range coverage)
        // 45% Depth + 30% Diversity + 25% Strategy
        // ==================================================
        const performanceConfidence = Math.max(
            0,
            Math.min(
                1,
                WEIGHTS.performance.positionDepth * positionDepthConfidence +
                WEIGHTS.performance.poolDiversity * poolDiversityConfidence +
                WEIGHTS.performance.strategyCoverage * strategyCoverageConfidence
            )
        );
        const performanceConfidencePct = performanceConfidence * 100;

        // ==================================================
        // RANGE CONFIDENCE
        // Evidence for range / placement metrics (requires range coverage)
        // 35% Depth + 25% Diversity + 40% Range
        // ==================================================
        const rangeConfidence = Math.max(
            0,
            Math.min(
                1,
                WEIGHTS.range.positionDepth * positionDepthConfidence +
                WEIGHTS.range.poolDiversity * poolDiversityConfidence +
                WEIGHTS.range.rangeCoverage * rangeCoverageConfidence
            )
        );
        const rangeConfidencePct = rangeConfidence * 100;

        walletRecords.push({
            wallet: walletAddress,
            evidence: {
                closedPositions,
                uniquePools,
                strategyCoveragePct: Math.round(strategyCoveragePct * 100) / 100,
                positionsWithRange,
                positionsWithoutRange,
                noLiquidityPositions,
                rangeCoveragePct: Math.round(rangeCoveragePct * 100) / 100,
            },
            components: {
                positionDepthConfidence: Math.round(positionDepthConfidence * 10000) / 10000,
                poolDiversityConfidence: Math.round(poolDiversityConfidence * 10000) / 10000,
                strategyCoverageConfidence: Math.round(strategyCoverageConfidence * 10000) / 10000,
                rangeCoverageConfidence: Math.round(rangeCoverageConfidence * 10000) / 10000,
            },
            confidence: {
                general: Math.round(generalConfidence * 10000) / 10000,
                generalPct: Math.round(generalConfidencePct * 100) / 100,
                performance: Math.round(performanceConfidence * 10000) / 10000,
                performancePct: Math.round(performanceConfidencePct * 100) / 100,
                range: Math.round(rangeConfidence * 10000) / 10000,
                rangePct: Math.round(rangeConfidencePct * 100) / 100,
            },
        });
    }

    // Preserve deterministic wallet ordering (lexical / dataset order)
    walletRecords.sort((a, b) => a.wallet.localeCompare(b.wallet));

    // Compute cohort confidence distribution summaries
    const cohortSummary: Record<string, ConfidenceDistributionSummary> = {
        positionDepthConfidence: computeStats(
            walletRecords.map((r) => r.components.positionDepthConfidence)
        ),
        poolDiversityConfidence: computeStats(
            walletRecords.map((r) => r.components.poolDiversityConfidence)
        ),
        strategyCoverageConfidence: computeStats(
            walletRecords.map((r) => r.components.strategyCoverageConfidence)
        ),
        rangeCoverageConfidence: computeStats(
            walletRecords.map((r) => r.components.rangeCoverageConfidence)
        ),
        generalConfidence: computeStats(
            walletRecords.map((r) => r.confidence.general)
        ),
        performanceConfidence: computeStats(
            walletRecords.map((r) => r.confidence.performance)
        ),
        rangeConfidence: computeStats(
            walletRecords.map((r) => r.confidence.range)
        ),
    };

    const outputData: WalletConfidenceOutput = {
        generatedAt: new Date().toISOString(),
        walletCount: walletRecords.length,
        methodology: {
            purpose: "evidence_confidence_only",
            skillIncluded: false,
            rankingIncluded: false,
            positionDepthFunction: "1 - exp(-closedPositions / 10)",
            poolDiversityFunction: "1 - exp(-uniquePools / 3)",
            strategyCoverageFunction: "strategyCoveragePct / 100",
            rangeCoverageFunction: "positionsWithRange / closedPositions",
            weights: WEIGHTS,
        },
        cohortSummary,
        wallets: walletRecords,
    };

    atomicWriteJson(outputFile, outputData);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("========================================================================================================");
    console.log("WALDISC-2 STEP 1G.2 — WALLET EVIDENCE CONFIDENCE");
    console.log("========================================================================================================");
    console.log(`Wallets Analyzed    : ${walletRecords.length}`);
    console.log(`Purpose             : Evidence confidence only (NOT skill / quality ranking)`);
    console.log("--------------------------------------------------------------------------------------------------------");

    const colWallet = "Wallet".padEnd(46);
    const colPos = "Positions".padStart(9);
    const colPools = "Pools".padStart(6);
    const colRangeCov = "RangeCov".padStart(9);
    const colGenConf = "GeneralConf".padStart(12);
    const colPerfConf = "PerfConf".padStart(10);
    const colRangeConf = "RangeConf".padStart(10);

    console.log(`${colWallet}${colPos}${colPools}${colRangeCov}${colGenConf}${colPerfConf}${colRangeConf}`);
    console.log("-".repeat(104));

    for (const r of walletRecords) {
        const wStr = r.wallet.padEnd(46);
        const posStr = String(r.evidence.closedPositions).padStart(9);
        const poolsStr = String(r.evidence.uniquePools).padStart(6);
        const rangeCovStr = `${r.evidence.rangeCoveragePct.toFixed(1)}%`.padStart(9);
        const genStr = `${r.confidence.generalPct.toFixed(1)}%`.padStart(12);
        const perfStr = `${r.confidence.performancePct.toFixed(1)}%`.padStart(10);
        const rangeStr = `${r.confidence.rangePct.toFixed(1)}%`.padStart(10);

        console.log(`${wStr}${posStr}${poolsStr}${rangeCovStr}${genStr}${perfStr}${rangeStr}`);
    }

    console.log("-".repeat(104));
    console.log("Cohort Summary (Distribution of Confidence Scores):");

    const statRows = [
        { label: "General Confidence", s: cohortSummary.generalConfidence },
        { label: "Performance Confidence", s: cohortSummary.performanceConfidence },
        { label: "Range Confidence", s: cohortSummary.rangeConfidence },
        { label: "Position Depth Component", s: cohortSummary.positionDepthConfidence },
        { label: "Pool Diversity Component", s: cohortSummary.poolDiversityConfidence },
        { label: "Range Coverage Component", s: cohortSummary.rangeCoverageConfidence },
    ];

    const colMetric = "Component / Score".padEnd(28);
    const colP25 = "P25".padStart(10);
    const colMed = "Median".padStart(10);
    const colP75 = "P75".padStart(10);
    const colMean = "Mean".padStart(10);

    console.log(`${colMetric}${colP25}${colMed}${colP75}${colMean}`);
    console.log("-".repeat(68));

    for (const row of statRows) {
        const mStr = row.label.padEnd(28);
        const p25Str = row.s.p25 !== null ? `${(row.s.p25 * 100).toFixed(1)}%`.padStart(10) : "N/A".padStart(10);
        const medStr = row.s.median !== null ? `${(row.s.median * 100).toFixed(1)}%`.padStart(10) : "N/A".padStart(10);
        const p75Str = row.s.p75 !== null ? `${(row.s.p75 * 100).toFixed(1)}%`.padStart(10) : "N/A".padStart(10);
        const meanStr = row.s.mean !== null ? `${(row.s.mean * 100).toFixed(1)}%`.padStart(10) : "N/A".padStart(10);
        console.log(`${mStr}${p25Str}${medStr}${p75Str}${meanStr}`);
    }

    console.log("\nOutput File         : " + outputFile);
    console.log("========================================================================================================\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Wallet confidence builder failed: ${err.message}`);
    process.exit(1);
});
