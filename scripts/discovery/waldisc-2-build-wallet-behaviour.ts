import fs from "node:fs";
import path from "node:path";

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";

interface NormalizedPositionRecord {
    position: string;
    pool: string;
    source: string;
    rangeAvailability: "AVAILABLE" | "NO_LIQUIDITY";

    openedAt: string | null;
    closedAt: string | null;
    durationSeconds: number | null;

    pnlUsd: number | null;
    pnlPct: number | null;

    depositUsd: number | null;
    withdrawalUsd: number | null;
    feeUsd: number | null;

    binStep: number;

    lowerBin: number | null;
    upperBin: number | null;
    binCount: number | null;

    rangeWidthPct: number | null;
    priceRatio: number | null;

    activeBinAtPlacement: number | null;
    lowerDistanceBins: number | null;
    upperDistanceBins: number | null;

    placementFraction: number | null;

    addOnlyInstructionCount: number;
    removeOnlyInstructionCount: number;
    trueRebalanceCount: number;
    emptyRebalanceInstructionCount: number;
}

interface PoolDistributionItem {
    pool: string;
    positionCount: number;
    pctOfPositions: number;
    binSteps: number[];
}

function parseCliArgs(): Record<string, string> {
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

    return options;
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

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function parseTimestampToMs(ts: any): number | null {
    if (!ts || typeof ts !== "string") return null;
    let s = ts.trim();
    if (!s) return null;
    if (!s.endsWith("Z") && !s.includes("+") && !s.includes("-", 10)) {
        s = s.replace(" ", "T") + "Z";
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
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

function computeStats(values: number[]): {
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
    p25: number | null;
    p75: number | null;
} {
    if (values.length === 0) {
        return { mean: null, median: null, min: null, max: null, p25: null, p75: null };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = percentile(sorted, 50);
    const p25 = percentile(sorted, 25);
    const p75 = percentile(sorted, 75);

    return { mean, median, min, max, p25, p75 };
}

function formatUsd(val: number | null): string {
    if (val === null || !Number.isFinite(val)) return "N/A";
    if (val < 0) {
        return `-$${Math.abs(val).toFixed(2)}`;
    }
    return `$${val.toFixed(2)}`;
}

async function main() {
    const args = parseCliArgs();
    const walletAddress =
        args.wallet || process.env.WALLET_ADDRESS || DEFAULT_WALLET;

    const baseDir = path.resolve("data/discovery/waldisc-2", walletAddress);
    const positionsFilePath = path.resolve(baseDir, "positions.json");

    if (!fs.existsSync(positionsFilePath)) {
        throw new Error(
            `Positions dataset not found for wallet '${walletAddress}': ${positionsFilePath}`
        );
    }

    let rawPositions: any[];
    try {
        const rawContent = fs.readFileSync(positionsFilePath, "utf8");
        rawPositions = JSON.parse(rawContent);
    } catch (err: any) {
        throw new Error(
            `Failed to parse positions file ${positionsFilePath}: ${err.message}`
        );
    }

    if (!Array.isArray(rawPositions)) {
        throw new Error(`Invalid format in ${positionsFilePath}: expected JSON array`);
    }

    // Filter closed positions deduplicating by position pubkey
    const seen = new Set<string>();
    const closedPositions: any[] = [];
    for (const p of rawPositions) {
        const status = String(p.status || "").trim().toUpperCase();
        if (status !== "CLOSED") continue;
        const posAddr = String(p.position || p.id || "").trim();
        if (!posAddr || seen.has(posAddr)) continue;
        seen.add(posAddr);
        closedPositions.push(p);
    }

    const warnings: string[] = [];
    const missingOutputs: string[] = [];
    const records: NormalizedPositionRecord[] = [];

    for (const pos of closedPositions) {
        const positionAddress = String(pos.position || pos.id || "").trim();
        const poolAddress = String(pos.pool || pos.poolId || "").trim();
        const source = String(pos.source || "wallet").trim();

        const derivedPath = path.resolve(
            baseDir,
            "strategy-derived",
            `${positionAddress}.json`
        );
        const normalizedPath = path.resolve(
            baseDir,
            "strategy-normalized",
            `${positionAddress}.json`
        );

        const derivedData = tryReadJson(derivedPath);
        const normalizedData = tryReadJson(normalizedPath);

        const issues: string[] = [];
        if (!derivedData) {
            issues.push(`strategy-derived missing (${derivedPath})`);
        } else {
            if (derivedData.wallet !== walletAddress) {
                issues.push(`strategy-derived wallet mismatch ('${derivedData.wallet}' !== '${walletAddress}')`);
            }
            if (derivedData.position !== positionAddress) {
                issues.push(`strategy-derived position mismatch ('${derivedData.position}' !== '${positionAddress}')`);
            }
            if (poolAddress && derivedData.pool !== poolAddress) {
                issues.push(`strategy-derived pool mismatch ('${derivedData.pool}' !== '${poolAddress}')`);
            }
        }

        if (!normalizedData) {
            issues.push(`strategy-normalized missing (${normalizedPath})`);
        } else {
            if (normalizedData.wallet !== walletAddress) {
                issues.push(`strategy-normalized wallet mismatch ('${normalizedData.wallet}' !== '${walletAddress}')`);
            }
            if (normalizedData.position !== positionAddress) {
                issues.push(`strategy-normalized position mismatch ('${normalizedData.position}' !== '${positionAddress}')`);
            }
            if (poolAddress && normalizedData.pool !== poolAddress) {
                issues.push(`strategy-normalized pool mismatch ('${normalizedData.pool}' !== '${poolAddress}')`);
            }
        }

        if (issues.length > 0) {
            missingOutputs.push(`${positionAddress}: ${issues.join("; ")}`);
            continue;
        }

        // Validate normalized range structure
        const binStep = Number(normalizedData.binStep);
        const isNoLiquidity =
            normalizedData.rangeAvailability === "NO_LIQUIDITY" ||
            derivedData.rangeAvailability === "NO_LIQUIDITY" ||
            (normalizedData.range?.lowerBin === null &&
                normalizedData.range?.upperBin === null &&
                normalizedData.range?.binCount === null);

        let lowerBin: number | null = null;
        let upperBin: number | null = null;
        let binCount: number | null = null;
        let rangeWidthPct: number | null = null;
        let priceRatio: number | null = null;

        let activeBinAtPlacement: number | null = null;
        let lowerDistanceBins: number | null = null;
        let upperDistanceBins: number | null = null;
        let placementFraction: number | null = null;

        if (!Number.isFinite(binStep) || binStep <= 0) {
            missingOutputs.push(`${positionAddress}: invalid binStep (${normalizedData.binStep})`);
            continue;
        }

        if (!isNoLiquidity) {
            if (
                typeof normalizedData.range?.lowerBin !== "number" ||
                typeof normalizedData.range?.upperBin !== "number" ||
                typeof normalizedData.range?.binCount !== "number" ||
                !Number.isFinite(normalizedData.range.lowerBin) ||
                !Number.isFinite(normalizedData.range.upperBin) ||
                !Number.isFinite(normalizedData.range.binCount)
            ) {
                missingOutputs.push(
                    `${positionAddress}: invalid range bounds [${normalizedData.range?.lowerBin}, ${normalizedData.range?.upperBin}] or binCount (${normalizedData.range?.binCount})`
                );
                continue;
            }

            lowerBin = normalizedData.range.lowerBin;
            upperBin = normalizedData.range.upperBin;
            binCount = normalizedData.range.binCount;
            rangeWidthPct = Number(normalizedData.range.rangeWidthPct);
            priceRatio = Number(normalizedData.range.priceRatio);

            if (lowerBin > upperBin) {
                missingOutputs.push(`${positionAddress}: invalid range bounds [${lowerBin}, ${upperBin}]`);
                continue;
            }
            if (binCount <= 0) {
                missingOutputs.push(`${positionAddress}: invalid binCount (${binCount})`);
                continue;
            }
            if (!Number.isFinite(rangeWidthPct) || rangeWidthPct < 0) {
                missingOutputs.push(`${positionAddress}: invalid rangeWidthPct (${rangeWidthPct})`);
                continue;
            }
            if (!Number.isFinite(priceRatio) || priceRatio < 1) {
                missingOutputs.push(`${positionAddress}: invalid priceRatio (${priceRatio})`);
                continue;
            }

            // Placement context
            const rawActiveBin = normalizedData.placementContext?.activeBinAtPlacement;
            activeBinAtPlacement =
                rawActiveBin !== null && rawActiveBin !== undefined && Number.isFinite(Number(rawActiveBin))
                    ? Number(rawActiveBin)
                    : null;

            const rawLowerDistance = normalizedData.placementContext?.lowerDistanceBins;
            lowerDistanceBins =
                rawLowerDistance !== null && rawLowerDistance !== undefined && Number.isFinite(Number(rawLowerDistance))
                    ? Number(rawLowerDistance)
                    : null;

            const rawUpperDistance = normalizedData.placementContext?.upperDistanceBins;
            upperDistanceBins =
                rawUpperDistance !== null && rawUpperDistance !== undefined && Number.isFinite(Number(rawUpperDistance))
                    ? Number(rawUpperDistance)
                    : null;

            // Placement fraction
            if (activeBinAtPlacement !== null) {
                if (upperBin === lowerBin) {
                    placementFraction = null;
                } else {
                    placementFraction = (activeBinAtPlacement - lowerBin) / (upperBin - lowerBin);
                    if (activeBinAtPlacement < lowerBin || activeBinAtPlacement > upperBin) {
                        warnings.push(
                            `Position '${positionAddress}': activeBinAtPlacement (${activeBinAtPlacement}) is outside range [${lowerBin}, ${upperBin}] (placementFraction: ${placementFraction.toFixed(4)})`
                        );
                    }
                }
            }
        }

        // Timestamps and duration
        const openedAt = pos.openedAt || pos.fabriqSummary?.openedAt || null;
        const closedAt = pos.closedAt || pos.fabriqSummary?.latestCloseAt || null;

        let durationSeconds: number | null = null;
        if (typeof pos.durationSeconds === "number" && Number.isFinite(pos.durationSeconds) && pos.durationSeconds >= 0) {
            durationSeconds = pos.durationSeconds;
        } else if (typeof pos.duration === "number" && Number.isFinite(pos.duration) && pos.duration >= 0) {
            durationSeconds = pos.duration;
        } else {
            const openMs = parseTimestampToMs(openedAt);
            const closeMs = parseTimestampToMs(closedAt);
            if (openMs !== null && closeMs !== null && closeMs >= openMs) {
                durationSeconds = (closeMs - openMs) / 1000;
            }
        }

        // Economics
        const fabriqSummary = pos.fabriqSummary || {};
        const pnlUsd =
            typeof fabriqSummary.totalPnlUsd === "number" && Number.isFinite(fabriqSummary.totalPnlUsd)
                ? fabriqSummary.totalPnlUsd
                : null;

        const depositUsd =
            typeof fabriqSummary.totalAddUsd === "number" && Number.isFinite(fabriqSummary.totalAddUsd)
                ? fabriqSummary.totalAddUsd
                : null;

        const withdrawalUsd =
            typeof fabriqSummary.totalRemoveUsd === "number" && Number.isFinite(fabriqSummary.totalRemoveUsd)
                ? fabriqSummary.totalRemoveUsd
                : null;

        const feeUsd =
            typeof fabriqSummary.totalFeeUsd === "number" && Number.isFinite(fabriqSummary.totalFeeUsd)
                ? fabriqSummary.totalFeeUsd
                : null;

        let pnlPct: number | null = null;
        if (pnlUsd !== null && depositUsd !== null && depositUsd > 0) {
            pnlPct = (pnlUsd / depositUsd) * 100;
        }

        // Rebalance instruction counts
        const addOnlyInstructionCount = Number(
            derivedData.addOnlyInstructionCount ?? derivedData.behaviour?.addOnlyInstructionCount ?? 0
        );
        const removeOnlyInstructionCount = Number(
            derivedData.removeOnlyInstructionCount ?? derivedData.behaviour?.removeOnlyInstructionCount ?? 0
        );
        const trueRebalanceCount = Number(
            derivedData.trueRebalanceCount ?? derivedData.behaviour?.trueRebalanceCount ?? 0
        );
        const emptyRebalanceInstructionCount = Number(
            derivedData.emptyRebalanceInstructionCount ?? derivedData.behaviour?.emptyRebalanceInstructionCount ?? 0
        );

        records.push({
            position: positionAddress,
            pool: poolAddress,
            source,
            rangeAvailability: isNoLiquidity ? "NO_LIQUIDITY" : "AVAILABLE",
            openedAt,
            closedAt,
            durationSeconds,
            pnlUsd,
            pnlPct,
            depositUsd,
            withdrawalUsd,
            feeUsd,
            binStep,
            lowerBin,
            upperBin,
            binCount,
            rangeWidthPct,
            priceRatio,
            activeBinAtPlacement,
            lowerDistanceBins,
            upperDistanceBins,
            placementFraction,
            addOnlyInstructionCount,
            removeOnlyInstructionCount,
            trueRebalanceCount,
            emptyRebalanceInstructionCount,
        });
    }

    if (missingOutputs.length > 0) {
        throw new Error(
            `Missing or invalid strategy outputs for ${missingOutputs.length} closed position(s):\n` +
                missingOutputs.map((msg) => `  - ${msg}`).join("\n")
        );
    }

    // 1. Coverage
    const totalClosedPositions = closedPositions.length;
    const strategyDerivedAvailable = records.length;
    const strategyNormalizedAvailable = records.length;
    const strategyCoveragePct =
        totalClosedPositions > 0 ? (strategyNormalizedAvailable / totalClosedPositions) * 100 : 0;
    const completeStrategyCoverage =
        strategyDerivedAvailable === totalClosedPositions &&
        strategyNormalizedAvailable === totalClosedPositions;

    // 2. Range aggregates
    const rangeWidths = records
        .map((r) => r.rangeWidthPct)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const binCounts = records
        .map((r) => r.binCount)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const priceRatios = records
        .map((r) => r.priceRatio)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

    const rangeWidthStats = computeStats(rangeWidths);
    const binCountStats = computeStats(binCounts);
    const priceRatioStats = computeStats(priceRatios);

    const rangeBehaviour = {
        rangeWidthPct: {
            mean: rangeWidthStats.mean,
            median: rangeWidthStats.median,
            min: rangeWidthStats.min,
            max: rangeWidthStats.max,
            p25: rangeWidthStats.p25,
            p75: rangeWidthStats.p75,
        },
        binCount: {
            mean: binCountStats.mean,
            median: binCountStats.median,
            min: binCountStats.min,
            max: binCountStats.max,
        },
        priceRatio: {
            mean: priceRatioStats.mean,
            median: priceRatioStats.median,
        },
    };

    // 3. Placement aggregates
    const placementFractions = records
        .map((r) => r.placementFraction)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const placementStats = computeStats(placementFractions);

    const positionsWithActiveAtOrNearLowerEdge = placementFractions.filter(
        (f) => f <= 0.05
    ).length;
    const positionsWithActiveAtOrNearUpperEdge = placementFractions.filter(
        (f) => f >= 0.95
    ).length;

    const placementBehaviour = {
        placementFraction: {
            mean: placementStats.mean,
            median: placementStats.median,
            min: placementStats.min,
            max: placementStats.max,
        },
        positionsWithActiveAtOrNearLowerEdge,
        positionsWithActiveAtOrNearUpperEdge,
    };

    // 4. Rebalance aggregates
    const totalAddOnlyInstructions = records.reduce(
        (sum, r) => sum + r.addOnlyInstructionCount,
        0
    );
    const totalRemoveOnlyInstructions = records.reduce(
        (sum, r) => sum + r.removeOnlyInstructionCount,
        0
    );
    const totalTrueRebalances = records.reduce(
        (sum, r) => sum + r.trueRebalanceCount,
        0
    );
    const totalEmptyRebalanceInstructions = records.reduce(
        (sum, r) => sum + r.emptyRebalanceInstructionCount,
        0
    );

    const positionsWithTrueRebalance = records.filter(
        (r) => r.trueRebalanceCount > 0
    ).length;
    const meanTrueRebalancesPerPosition =
        records.length > 0 ? totalTrueRebalances / records.length : 0;
    const medianTrueRebalancesPerPosition =
        computeStats(records.map((r) => r.trueRebalanceCount)).median ?? 0;
    const trueRebalancePositionPct =
        records.length > 0 ? (positionsWithTrueRebalance / records.length) * 100 : 0;

    const rebalanceBehaviour = {
        totalAddOnlyInstructions,
        totalRemoveOnlyInstructions,
        totalTrueRebalances,
        totalEmptyRebalanceInstructions,
        positionsWithTrueRebalance,
        meanTrueRebalancesPerPosition,
        medianTrueRebalancesPerPosition,
        trueRebalancePositionPct,
    };

    // 5. Performance aggregates
    const pnlUsdList = records
        .map((r) => r.pnlUsd)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const pnlStats = computeStats(pnlUsdList);

    const winningPositions = pnlUsdList.filter((p) => p > 0).length;
    const losingPositions = pnlUsdList.filter((p) => p < 0).length;
    const breakevenPositions = pnlUsdList.filter((p) => p === 0).length;
    const positionsWithPnl = pnlUsdList.length;
    const positionsMissingPnl = records.length - positionsWithPnl;

    const winRatePct =
        positionsWithPnl > 0 ? (winningPositions / positionsWithPnl) * 100 : null;

    const pnlPcts = records
        .map((r) => r.pnlPct)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const pnlPctStats = computeStats(pnlPcts);

    // PnL Concentration using GROSS POSITIVE PROFITS only
    const positiveProfits = pnlUsdList.filter((p) => p > 0).sort((a, b) => b - a);
    const positiveProfitTotalUsd = positiveProfits.reduce((sum, v) => sum + v, 0);

    let top1PositiveProfitSharePct: number | null = null;
    let top3PositiveProfitSharePct: number | null = null;

    if (positiveProfitTotalUsd > 0 && positiveProfits.length > 0) {
        const top1Sum = positiveProfits[0];
        const top3Sum = positiveProfits.slice(0, 3).reduce((sum, v) => sum + v, 0);
        top1PositiveProfitSharePct = (top1Sum / positiveProfitTotalUsd) * 100;
        top3PositiveProfitSharePct = (top3Sum / positiveProfitTotalUsd) * 100;
    }

    const performance = {
        totalPnlUsd: pnlUsdList.reduce((sum, v) => sum + v, 0),
        meanPnlUsd: pnlStats.mean,
        medianPnlUsd: pnlStats.median,
        minPnlUsd: pnlStats.min,
        maxPnlUsd: pnlStats.max,
        winningPositions,
        losingPositions,
        breakevenPositions,
        winRatePct,
        pnlPct: {
            mean: pnlPctStats.mean,
            median: pnlPctStats.median,
            min: pnlPctStats.min,
            max: pnlPctStats.max,
        },
        positiveProfitTotalUsd: positiveProfitTotalUsd > 0 ? positiveProfitTotalUsd : null,
        top1PositiveProfitSharePct,
        top3PositiveProfitSharePct,
        positionsWithPnl,
        positionsMissingPnl,
    };

    // 6. Capital / Fee aggregates
    const deposits = records
        .map((r) => r.depositUsd)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const withdrawals = records
        .map((r) => r.withdrawalUsd)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const fees = records
        .map((r) => r.feeUsd)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

    const totalDepositsUsd = deposits.reduce((sum, v) => sum + v, 0);
    const totalWithdrawalsUsd = withdrawals.reduce((sum, v) => sum + v, 0);
    const totalFeesUsd = fees.reduce((sum, v) => sum + v, 0);

    const depositStats = computeStats(deposits);
    const feeStats = computeStats(fees);

    const feeToDepositPct =
        totalDepositsUsd > 0 ? (totalFeesUsd / totalDepositsUsd) * 100 : null;

    const capitalBehaviour = {
        totalDepositsUsd,
        totalWithdrawalsUsd,
        totalFeesUsd,
        meanDepositUsd: depositStats.mean,
        medianDepositUsd: depositStats.median,
        meanFeeUsd: feeStats.mean,
        medianFeeUsd: feeStats.median,
        feeToDepositPct,
        positionsWithDeposits: deposits.length,
        positionsMissingDeposits: records.length - deposits.length,
        positionsWithWithdrawals: withdrawals.length,
        positionsMissingWithdrawals: records.length - withdrawals.length,
        positionsWithFees: fees.length,
        positionsMissingFees: records.length - fees.length,
    };

    // 7. Holding behaviour
    const durations = records
        .map((r) => r.durationSeconds)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const durationStats = computeStats(durations);

    const holdingBehaviour = {
        meanDurationSeconds: durationStats.mean,
        medianDurationSeconds: durationStats.median,
        minDurationSeconds: durationStats.min,
        maxDurationSeconds: durationStats.max,
        meanDurationHours:
            durationStats.mean !== null ? durationStats.mean / 3600 : null,
        medianDurationHours:
            durationStats.median !== null ? durationStats.median / 3600 : null,
        minDurationHours:
            durationStats.min !== null ? durationStats.min / 3600 : null,
        maxDurationHours:
            durationStats.max !== null ? durationStats.max / 3600 : null,
        positionsWithDuration: durations.length,
        positionsMissingDuration: records.length - durations.length,
    };

    // 8. Pool distribution
    const poolMap = new Map<string, { positionCount: number; binSteps: Set<number> }>();
    for (const r of records) {
        let entry = poolMap.get(r.pool);
        if (!entry) {
            entry = { positionCount: 0, binSteps: new Set<number>() };
            poolMap.set(r.pool, entry);
        }
        entry.positionCount++;
        if (typeof r.binStep === "number" && Number.isFinite(r.binStep)) {
            entry.binSteps.add(r.binStep);
        }
    }

    const poolDistribution: PoolDistributionItem[] = Array.from(poolMap.entries())
        .map(([pool, data]) => ({
            pool,
            positionCount: data.positionCount,
            pctOfPositions:
                records.length > 0 ? (data.positionCount / records.length) * 100 : 0,
            binSteps: Array.from(data.binSteps).sort((a, b) => a - b),
        }))
        .sort((a, b) => b.positionCount - a.positionCount);

    const uniquePoolCount = poolMap.size;

    const positionsWithRange = rangeWidths.length;
    const positionsWithoutRange = records.length - positionsWithRange;
    const positionsWithPlacement = placementFractions.length;
    const positionsWithoutPlacement = records.length - positionsWithPlacement;
    const noLiquidityPositions = records.filter(
        (r) => r.rangeAvailability === "NO_LIQUIDITY" || (r.lowerBin === null && r.upperBin === null)
    ).length;
    const rangeCoveragePct =
        totalClosedPositions > 0 ? (positionsWithRange / totalClosedPositions) * 100 : 0;
    const placementCoveragePct =
        totalClosedPositions > 0 ? (positionsWithPlacement / totalClosedPositions) * 100 : 0;

    const coverage = {
        totalClosedPositions,
        uniquePoolCount,
        strategyDerivedAvailable,
        strategyNormalizedAvailable,
        strategyCoveragePct,
        rangeCoveragePct,
        placementCoveragePct,
        positionsWithPnl,
        positionsWithDuration: durations.length,
        positionsWithRange,
        positionsWithoutRange,
        positionsWithPlacement,
        positionsWithoutPlacement,
        noLiquidityPositions,
        completeStrategyCoverage,
        warnings,
    };

    const outputData = {
        wallet: walletAddress,
        generatedAt: new Date().toISOString(),

        coverage,
        rangeBehaviour,
        placementBehaviour,
        rebalanceBehaviour,
        performance,
        capitalBehaviour,
        holdingBehaviour,
        poolDistribution,
        positions: records,
    };

    const outputFilePath = path.resolve(baseDir, "wallet-behaviour.json");
    atomicWriteJson(outputFilePath, outputData);

    // Terminal compact summary
    const medianRangeWidthStr =
        rangeWidthStats.median !== null
            ? `${rangeWidthStats.median.toFixed(2)}%`
            : "N/A";

    const medianPlacementStr =
        placementStats.median !== null
            ? placementStats.median.toFixed(4)
            : "N/A";

    const winRateStr =
        winRatePct !== null ? `${winRatePct.toFixed(1)}%` : "N/A";

    const medianHoldStr =
        holdingBehaviour.medianDurationHours !== null
            ? `${holdingBehaviour.medianDurationHours.toFixed(1)} h`
            : "N/A";

    console.log("========================================");
    console.log("WALDISC-2 STEP 1E — WALLET BEHAVIOUR");
    console.log("========================================");
    console.log(`Wallet              : ${walletAddress}`);
    console.log(`Closed Positions    : ${totalClosedPositions}`);
    console.log(`Strategy Coverage   : ${strategyCoveragePct.toFixed(1)}%`);
    console.log(
        `Positions w/ Range  : ${positionsWithRange} (${positionsWithoutRange} without range, ${noLiquidityPositions} no-liquidity)`
    );
    console.log(`Unique Pools        : ${uniquePoolCount}\n`);

    console.log(`Median Range Width  : ${medianRangeWidthStr}`);
    console.log(`Median Placement    : ${medianPlacementStr}`);
    console.log(`True Rebalances     : ${totalTrueRebalances}`);
    console.log(
        `Positions Rebalanced: ${positionsWithTrueRebalance} (${trueRebalancePositionPct.toFixed(1)}%)\n`
    );

    console.log(`Win Rate            : ${winRateStr}`);
    console.log(`Total PnL           : ${formatUsd(performance.totalPnlUsd)}`);
    console.log(`Median PnL          : ${formatUsd(performance.medianPnlUsd)}\n`);

    console.log(`Median Hold         : ${medianHoldStr}`);
    console.log(`Total Fees          : ${formatUsd(capitalBehaviour.totalFeesUsd)}`);
    console.log("========================================\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Wallet behaviour aggregation failed: ${err.message}`);
    process.exit(1);
});
