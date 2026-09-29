import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    datasetPath: string;
    outputPath: string;
}

interface MetricSummary {
    field: string;
    availableCount: number;
    nullCount: number;
    coveragePct: number;
}

interface DistributionStats {
    metric: string;
    count: number;
    min: number;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
}

interface SanityIssue {
    severity: "CRITICAL" | "WARNING";
    wallet: string;
    category: string;
    details: string;
    positionId?: string;
}

export interface V1ScreeningAuditReport {
    generatedAt: string;
    datasetPath: string;
    assessment: "READY_FOR_V1_SCORING" | "READY_WITH_LIMITATIONS" | "NOT_READY_FOR_V1_SCORING";
    populationIntegrity: {
        candidateWallets: number;
        validWallets: number;
        invalidWallets: number;
        totalClosedPositions: number;
        uniqueDlmmPools: number;
        duplicateWallets: string[];
        duplicatePositionsCount: number;
        duplicatePositions: Array<{ positionId: string; count: number; wallets: string[] }>;
    };
    metricCompleteness: MetricSummary[];
    distributionSummary: DistributionStats[];
    dailyDataReadiness: {
        walletsWithDaily: number;
        walletsWithoutDaily: number;
        dailyCoveragePct: number;
        totalDailyObservations: number;
        duplicateDailyDatesCount: number;
        outsideWindowObservationsCount: number;
        uniqueDatesPerWallet: {
            min: number;
            p10: number;
            p25: number;
            median: number;
            p75: number;
            p90: number;
            max: number;
        };
        cutoffDateStr: string;
        endDateStr: string;
        sufficientForAnalytics: boolean;
        assessmentDetails: string;
    };
    sanityChecks: {
        totalIssues: number;
        criticalCount: number;
        warningCount: number;
        issues: SanityIssue[];
    };
    scoringReadiness: {
        safeMetrics: string[];
        excludedOrConditionalMetrics: Array<{
            metric: string;
            reason: string;
            recommendation: string;
        }>;
    };
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let outputPath = path.resolve("data/v1/wallet-screening-audit.json");

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
            outputPath = path.resolve(arg.slice(9));
        }
    }

    return { datasetPath, outputPath };
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

function calculateDistribution(metricName: string, rawValues: Array<number | null | undefined>): DistributionStats | null {
    const valid = rawValues.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (valid.length === 0) return null;
    const sorted = [...valid].sort((a, b) => a - b);
    return {
        metric: metricName,
        count: sorted.length,
        min: sorted[0],
        p10: computePercentile(sorted, 10),
        p25: computePercentile(sorted, 25),
        median: computePercentile(sorted, 50),
        p75: computePercentile(sorted, 75),
        p90: computePercentile(sorted, 90),
        max: sorted[sorted.length - 1],
    };
}

function parseTimestampMs(ts: string | number | null | undefined): number | null {
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

export function auditScreeningDataset(dataset: any, datasetPath: string): V1ScreeningAuditReport {
    const wallets: any[] = Array.isArray(dataset?.wallets) ? dataset.wallets : [];
    const validWallets = wallets.filter((w) => w?.valid === true);
    const invalidWallets = wallets.filter((w) => !w?.valid);

    // ----------------------------------------------------
    // 1. Population Integrity
    // ----------------------------------------------------
    const walletCountMap = new Map<string, number>();
    for (const w of wallets) {
        const addr = String(w.wallet || "").trim();
        if (addr) {
            walletCountMap.set(addr, (walletCountMap.get(addr) ?? 0) + 1);
        }
    }
    const duplicateWallets = Array.from(walletCountMap.entries())
        .filter(([_, count]) => count > 1)
        .map(([addr]) => addr);

    const positionOccurrences = new Map<string, Set<string>>();
    let totalClosedPositions = 0;
    const uniqueDlmmPoolsSet = new Set<string>();

    for (const w of validWallets) {
        const positions: any[] = Array.isArray(w.positions) ? w.positions : [];
        totalClosedPositions += positions.length;

        for (const p of positions) {
            if (p.pool) {
                uniqueDlmmPoolsSet.add(String(p.pool).trim());
            }
            if (p.positionId) {
                const pId = String(p.positionId).trim();
                if (!positionOccurrences.has(pId)) {
                    positionOccurrences.set(pId, new Set<string>());
                }
                positionOccurrences.get(pId)!.add(w.wallet);
            }
        }
    }

    const duplicatePositions: Array<{ positionId: string; count: number; wallets: string[] }> = [];
    for (const [pId, walletSet] of positionOccurrences.entries()) {
        if (walletSet.size > 1) {
            duplicatePositions.push({
                positionId: pId,
                count: walletSet.size,
                wallets: Array.from(walletSet),
            });
        }
    }

    // ----------------------------------------------------
    // 2. Metric Completeness Across Valid Wallets
    // ----------------------------------------------------
    const targetFields = [
        "totalPnl",
        "grossProfit",
        "grossLoss",
        "profitFactor",
        "positionWinRate",
        "medianPositionPnlPct",
        "meanPositionPnlPct",
        "medianHoldHours",
        "meanHoldHours",
        "totalDeposits",
        "totalWithdrawals",
        "totalFees",
        "pnlConcentrationTop1",
        "pnlConcentrationTop3",
    ];

    const metricCompleteness: MetricSummary[] = targetFields.map((field) => {
        let availableCount = 0;
        let nullCount = 0;

        for (const w of validWallets) {
            const metrics = w.metrics;
            const val = metrics ? metrics[field] : null;
            if (val !== null && val !== undefined && typeof val === "number" && !Number.isNaN(val)) {
                availableCount++;
            } else {
                nullCount++;
            }
        }

        const coveragePct = validWallets.length > 0
            ? Number(((availableCount / validWallets.length) * 100).toFixed(2))
            : 0;

        return { field, availableCount, nullCount, coveragePct };
    });

    // ----------------------------------------------------
    // 3. Distribution Summary
    // ----------------------------------------------------
    const distributionSummary: DistributionStats[] = [];

    const distMetricsToAnalyze: Array<{ name: string; extractor: (w: any) => number | null | undefined }> = [
        { name: "closedPositionCount", extractor: (w) => w.metrics?.closedPositionCount ?? w.positions?.length },
        { name: "uniqueDlmmPools", extractor: (w) => w.metrics?.uniqueDlmmPools },
        { name: "totalPnl", extractor: (w) => w.metrics?.totalPnl },
        { name: "profitFactor", extractor: (w) => w.metrics?.profitFactor },
        { name: "positionWinRate", extractor: (w) => w.metrics?.positionWinRate },
        { name: "medianPositionPnlPct", extractor: (w) => w.metrics?.medianPositionPnlPct },
        { name: "meanPositionPnlPct", extractor: (w) => w.metrics?.meanPositionPnlPct },
        { name: "medianHoldHours", extractor: (w) => w.metrics?.medianHoldHours },
        { name: "meanHoldHours", extractor: (w) => w.metrics?.meanHoldHours },
        { name: "pnlConcentrationTop1", extractor: (w) => w.metrics?.pnlConcentrationTop1 },
        { name: "pnlConcentrationTop3", extractor: (w) => w.metrics?.pnlConcentrationTop3 },
        { name: "totalDeposits", extractor: (w) => w.metrics?.totalDeposits },
        { name: "totalWithdrawals", extractor: (w) => w.metrics?.totalWithdrawals },
        { name: "totalFees", extractor: (w) => w.metrics?.totalFees },
    ];

    for (const item of distMetricsToAnalyze) {
        const values = validWallets.map(item.extractor);
        const dist = calculateDistribution(item.name, values);
        if (dist) distributionSummary.push(dist);
    }

    // ----------------------------------------------------
    // 4. Daily Data Readiness
    // ----------------------------------------------------
    const referenceEnd = dataset?.generatedAt ? new Date(dataset.generatedAt) : new Date();
    const historyDays = dataset?.contract?.historyDays || 30;
    const cutoffMs = referenceEnd.getTime() - historyDays * 86400 * 1000;
    const cutoffDateStr = new Date(cutoffMs).toISOString().slice(0, 10);
    const endDateStr = referenceEnd.toISOString().slice(0, 10);

    let walletsWithDaily = 0;
    let walletsWithoutDaily = 0;
    let totalDailyObservations = 0;
    let totalDuplicateDailyDates = 0;
    let totalOutsideWindowObservations = 0;
    const uniqueDateCounts: number[] = [];

    for (const w of validWallets) {
        const dailyArr = Array.isArray(w.daily) ? w.daily : [];
        if (dailyArr.length > 0) {
            walletsWithDaily++;
            totalDailyObservations += dailyArr.length;
            const seenDates = new Set<string>();

            for (const d of dailyArr) {
                if (!d || !d.date) continue;
                const dateStr = String(d.date).slice(0, 10);
                if (dateStr < cutoffDateStr || dateStr > endDateStr) {
                    totalOutsideWindowObservations++;
                    sanityIssues.push({
                        severity: "WARNING",
                        wallet: w.wallet,
                        category: "DAILY_OBSERVATION_OUTSIDE_WINDOW",
                        details: `Daily date ${dateStr} is outside V1 window [${cutoffDateStr}, ${endDateStr}]`,
                    });
                }
                if (seenDates.has(dateStr)) {
                    totalDuplicateDailyDates++;
                    sanityIssues.push({
                        severity: "WARNING",
                        wallet: w.wallet,
                        category: "DUPLICATE_DAILY_DATE",
                        details: `Daily date ${dateStr} is duplicated in wallet daily records`,
                    });
                }
                seenDates.add(dateStr);
            }
            uniqueDateCounts.push(seenDates.size);
        } else {
            walletsWithoutDaily++;
            uniqueDateCounts.push(0);
        }
    }

    uniqueDateCounts.sort((a, b) => a - b);
    const uniqueDatesPerWallet = {
        min: uniqueDateCounts.length > 0 ? uniqueDateCounts[0] : 0,
        p10: computePercentile(uniqueDateCounts, 10),
        p25: computePercentile(uniqueDateCounts, 25),
        median: computePercentile(uniqueDateCounts, 50),
        p75: computePercentile(uniqueDateCounts, 75),
        p90: computePercentile(uniqueDateCounts, 90),
        max: uniqueDateCounts.length > 0 ? uniqueDateCounts[uniqueDateCounts.length - 1] : 0,
    };

    const dailyCoveragePct = validWallets.length > 0
        ? Number(((walletsWithDaily / validWallets.length) * 100).toFixed(2))
        : 0;

    const sufficientForAnalytics =
        dailyCoveragePct >= 95 &&
        totalDailyObservations > 0 &&
        totalDuplicateDailyDates === 0 &&
        totalOutsideWindowObservations === 0;

    const assessmentDetails = sufficientForAnalytics
        ? `Daily calendar PnL has ${dailyCoveragePct}% coverage across valid wallets (${totalDailyObservations} observations, 0 duplicates, 0 outside-window, median ${uniqueDatesPerWallet.median} unique days/wallet). Consistent with the 30-day V1 window [${cutoffDateStr} to ${endDateStr}]. Sufficient for rolling worst-day, drawdown, and daily consistency analysis.`
        : `Daily calendar observations have integrity issues: ${totalDuplicateDailyDates} duplicate daily dates, ${totalOutsideWindowObservations} outside-window observations. Requires deduplication/normalization before drawdown/consistency scoring.`;

    // ----------------------------------------------------
    // 5. Sanity Checks
    // ----------------------------------------------------
    const sanityIssues: SanityIssue[] = [];

    for (const w of validWallets) {
        const walletAddr = w.wallet;
        const metrics = w.metrics;

        if (!metrics) {
            sanityIssues.push({
                severity: "CRITICAL",
                wallet: walletAddr,
                category: "MISSING_METRICS",
                details: "Valid wallet has null metrics object",
            });
            continue;
        }

        // Check for NaN or Infinite values
        for (const [k, v] of Object.entries(metrics)) {
            if (typeof v === "number" && (!Number.isFinite(v) || Number.isNaN(v))) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "NAN_OR_INFINITY",
                    details: `Metric ${k} is non-finite: ${v}`,
                });
            }
        }

        // Win rate bounds
        if (typeof metrics.positionWinRate === "number") {
            if (metrics.positionWinRate < 0 || metrics.positionWinRate > 100) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "INVALID_WIN_RATE",
                    details: `Win rate outside [0, 100]: ${metrics.positionWinRate}%`,
                });
            }
        }

        // PnL Concentration bounds
        if (metrics.pnlConcentrationTop1 !== null && typeof metrics.pnlConcentrationTop1 === "number") {
            if (metrics.pnlConcentrationTop1 < 0 || metrics.pnlConcentrationTop1 > 100) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "INVALID_CONCENTRATION",
                    details: `pnlConcentrationTop1 outside [0, 100]: ${metrics.pnlConcentrationTop1}%`,
                });
            }
        }

        if (metrics.pnlConcentrationTop3 !== null && typeof metrics.pnlConcentrationTop3 === "number") {
            if (metrics.pnlConcentrationTop3 < 0 || metrics.pnlConcentrationTop3 > 100) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "INVALID_CONCENTRATION",
                    details: `pnlConcentrationTop3 outside [0, 100]: ${metrics.pnlConcentrationTop3}%`,
                });
            }
        }

        // Position level checks
        const positions: any[] = Array.isArray(w.positions) ? w.positions : [];
        const seenWalletPositionIds = new Set<string>();

        for (const pos of positions) {
            const posId = pos.positionId || "UNKNOWN";

            // Intra-wallet duplicate check
            if (seenWalletPositionIds.has(posId)) {
                sanityIssues.push({
                    severity: "WARNING",
                    wallet: walletAddr,
                    category: "INTRA_WALLET_DUPLICATE_POSITION",
                    details: `Position ID ${posId} duplicated in wallet positions`,
                    positionId: posId,
                });
            }
            seenWalletPositionIds.add(posId);

            // Hold duration check
            if (typeof pos.holdDuration === "number" && pos.holdDuration < 0) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "NEGATIVE_HOLD_DURATION",
                    details: `holdDuration is negative: ${pos.holdDuration}s`,
                    positionId: posId,
                });
            }

            if (typeof pos.holdDurationHours === "number" && pos.holdDurationHours < 0) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "NEGATIVE_HOLD_HOURS",
                    details: `holdDurationHours is negative: ${pos.holdDurationHours}`,
                    positionId: posId,
                });
            }

            // Timestamp sanity
            const openMs = parseTimestampMs(pos.openedAt);
            const closeMs = parseTimestampMs(pos.closedAt);

            if (pos.openedAt && openMs === null) {
                sanityIssues.push({
                    severity: "WARNING",
                    wallet: walletAddr,
                    category: "UNPARSEABLE_OPEN_TIMESTAMP",
                    details: `openedAt timestamp unparseable: ${pos.openedAt}`,
                    positionId: posId,
                });
            }

            if (pos.closedAt && closeMs === null) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "UNPARSEABLE_CLOSE_TIMESTAMP",
                    details: `closedAt timestamp unparseable: ${pos.closedAt}`,
                    positionId: posId,
                });
            }

            if (openMs !== null && closeMs !== null && closeMs < openMs) {
                sanityIssues.push({
                    severity: "CRITICAL",
                    wallet: walletAddr,
                    category: "CLOSED_BEFORE_OPENED",
                    details: `closedAt (${pos.closedAt}) is before openedAt (${pos.openedAt})`,
                    positionId: posId,
                });
            }
        }
    }

    const criticalIssues = sanityIssues.filter((i) => i.severity === "CRITICAL");
    const warningIssues = sanityIssues.filter((i) => i.severity === "WARNING");

    // ----------------------------------------------------
    // 6. Safe Metrics & Exclusion Analysis
    // ----------------------------------------------------
    const safeMetrics: string[] = [];
    const excludedOrConditionalMetrics: Array<{ metric: string; reason: string; recommendation: string }> = [];

    for (const m of metricCompleteness) {
        if (m.coveragePct === 100) {
            safeMetrics.push(m.field);
        } else if (m.field === "profitFactor") {
            excludedOrConditionalMetrics.push({
                metric: "profitFactor",
                reason: `Coverage is ${m.coveragePct}% (${m.nullCount} nulls). Occurs legitimately when wallet has 0 losses in the window (division by zero).`,
                recommendation: "Use with fallback cap (e.g. 50.0 or 100.0) when grossLoss == 0 and grossProfit > 0, rather than raw null.",
            });
        } else if (m.field === "pnlConcentrationTop1" || m.field === "pnlConcentrationTop3") {
            excludedOrConditionalMetrics.push({
                metric: m.field,
                reason: `Coverage is ${m.coveragePct}% (${m.nullCount} nulls). Occurs legitimately when total positive profits are zero or negative.`,
                recommendation: "Treat as non-applicable / default 0 when wallet has no positive winning positions.",
            });
        } else if (m.field === "medianPositionPnlPct" || m.field === "meanPositionPnlPct") {
            excludedOrConditionalMetrics.push({
                metric: m.field,
                reason: `Coverage is ${m.coveragePct}%. Null when position deposit/inflow was 0 or unrecorded.`,
                recommendation: "Use totalPnl / totalDeposits as wallet-level ROI instead of averaging per-position ROI if missing.",
            });
        } else {
            excludedOrConditionalMetrics.push({
                metric: m.field,
                reason: `Coverage is ${m.coveragePct}% (${m.nullCount} nulls).`,
                recommendation: "Exclude from primary linear scoring or require imputation rule.",
            });
        }
    }

    // ----------------------------------------------------
    // Overall Assessment
    // ----------------------------------------------------
    let assessment: "READY_FOR_V1_SCORING" | "READY_WITH_LIMITATIONS" | "NOT_READY_FOR_V1_SCORING";

    if (validWallets.length < 50 || criticalIssues.length > 0) {
        assessment = "NOT_READY_FOR_V1_SCORING";
    } else if (warningIssues.length > 0 || excludedOrConditionalMetrics.length > 0) {
        assessment = "READY_WITH_LIMITATIONS";
    } else {
        assessment = "READY_FOR_V1_SCORING";
    }

    return {
        generatedAt: new Date().toISOString(),
        datasetPath,
        assessment,
        populationIntegrity: {
            candidateWallets: wallets.length,
            validWallets: validWallets.length,
            invalidWallets: invalidWallets.length,
            totalClosedPositions,
            uniqueDlmmPools: uniqueDlmmPoolsSet.size,
            duplicateWallets,
            duplicatePositionsCount: duplicatePositions.length,
            duplicatePositions,
        },
        metricCompleteness,
        distributionSummary,
        dailyDataReadiness: {
            walletsWithDaily,
            walletsWithoutDaily,
            dailyCoveragePct,
            totalDailyObservations,
            duplicateDailyDatesCount: totalDuplicateDailyDates,
            outsideWindowObservationsCount: totalOutsideWindowObservations,
            uniqueDatesPerWallet,
            cutoffDateStr,
            endDateStr,
            sufficientForAnalytics,
            assessmentDetails,
        },
        sanityChecks: {
            totalIssues: sanityIssues.length,
            criticalCount: criticalIssues.length,
            warningCount: warningIssues.length,
            issues: sanityIssues.slice(0, 50), // cap to 50 for reporting
        },
        scoringReadiness: {
            safeMetrics,
            excludedOrConditionalMetrics,
        },
    };
}

function printAuditReport(report: V1ScreeningAuditReport): void {
    console.log("==================================================");
    console.log("V1 — WALLET SCREENING DATASET AUDIT REPORT");
    console.log("==================================================");
    console.log(`Generated At            : ${report.generatedAt}`);
    console.log(`Dataset Path            : ${report.datasetPath}`);
    console.log(`Overall Assessment      : ${report.assessment}\n`);

    console.log("1. POPULATION INTEGRITY");
    console.log("--------------------------------------------------");
    console.log(`Candidate Wallets       : ${report.populationIntegrity.candidateWallets}`);
    console.log(`Valid Wallets (Target>=50): ${report.populationIntegrity.validWallets}`);
    console.log(`Invalid Wallets         : ${report.populationIntegrity.invalidWallets}`);
    console.log(`Total Closed Positions  : ${report.populationIntegrity.totalClosedPositions}`);
    console.log(`Unique DLMM Pools       : ${report.populationIntegrity.uniqueDlmmPools}`);
    console.log(`Duplicate Wallet Addrs  : ${report.populationIntegrity.duplicateWallets.length}`);
    if (report.populationIntegrity.duplicateWallets.length > 0) {
        console.log(`  Duplicates: ${report.populationIntegrity.duplicateWallets.join(", ")}`);
    }
    console.log(`Cross-Wallet Dupe Pos   : ${report.populationIntegrity.duplicatePositionsCount}\n`);

    console.log("2. METRIC COMPLETENESS ACROSS VALID WALLETS");
    console.log("--------------------------------------------------");
    console.log(
        "Field".padEnd(25) +
        "Available".padStart(12) +
        "Null".padStart(8) +
        "Coverage %".padStart(14)
    );
    console.log("-".repeat(59));
    for (const m of report.metricCompleteness) {
        console.log(
            m.field.padEnd(25) +
            String(m.availableCount).padStart(12) +
            String(m.nullCount).padStart(8) +
            `${m.coveragePct}%`.padStart(14)
        );
    }
    console.log("");

    console.log("3. DISTRIBUTION SUMMARY (VALID WALLETS)");
    console.log("--------------------------------------------------");
    console.log(
        "Metric".padEnd(23) +
        "Min".padStart(11) +
        "P10".padStart(11) +
        "P25".padStart(11) +
        "Median".padStart(11) +
        "P75".padStart(11) +
        "P90".padStart(11) +
        "Max".padStart(13)
    );
    console.log("-".repeat(102));
    for (const d of report.distributionSummary) {
        console.log(
            d.metric.padEnd(23) +
            String(d.min).padStart(11) +
            String(d.p10).padStart(11) +
            String(d.p25).padStart(11) +
            String(d.median).padStart(11) +
            String(d.p75).padStart(11) +
            String(d.p90).padStart(11) +
            String(d.max).padStart(13)
        );
    }
    console.log("");

    console.log("4. DAILY-DATA READINESS");
    console.log("--------------------------------------------------");
    console.log(`V1 History Window       : [${report.dailyDataReadiness.cutoffDateStr} to ${report.dailyDataReadiness.endDateStr}] (30 rolling days)`);
    console.log(`Wallets With Daily Data : ${report.dailyDataReadiness.walletsWithDaily} / ${report.populationIntegrity.validWallets}`);
    console.log(`Wallets Without Daily   : ${report.dailyDataReadiness.walletsWithoutDaily}`);
    console.log(`Daily Coverage %        : ${report.dailyDataReadiness.dailyCoveragePct}%`);
    console.log(`Total Daily Observations: ${report.dailyDataReadiness.totalDailyObservations}`);
    console.log(`Duplicate Daily Dates   : ${report.dailyDataReadiness.duplicateDailyDatesCount}`);
    console.log(`Outside-Window Observs  : ${report.dailyDataReadiness.outsideWindowObservationsCount}`);
    console.log(`Unique Dates/Wallet     : Min ${report.dailyDataReadiness.uniqueDatesPerWallet.min} | Median ${report.dailyDataReadiness.uniqueDatesPerWallet.median} | Max ${report.dailyDataReadiness.uniqueDatesPerWallet.max} (P25: ${report.dailyDataReadiness.uniqueDatesPerWallet.p25}, P75: ${report.dailyDataReadiness.uniqueDatesPerWallet.p75})`);
    console.log(`Sufficient for Analytics: ${report.dailyDataReadiness.sufficientForAnalytics ? "YES" : "NO"}`);
    console.log(`Note                    : ${report.dailyDataReadiness.assessmentDetails}\n`);

    console.log("5. SANITY CHECKS");
    console.log("--------------------------------------------------");
    console.log(`Critical Issues (Fatal) : ${report.sanityChecks.criticalCount}`);
    console.log(`Warning Issues          : ${report.sanityChecks.warningCount}`);
    if (report.sanityChecks.issues.length > 0) {
        console.log("Sample Issues:");
        for (const issue of report.sanityChecks.issues.slice(0, 10)) {
            console.log(`  [${issue.severity}] [${issue.category}] Wallet ${issue.wallet}: ${issue.details}`);
        }
    } else {
        console.log("  No sanity violations detected (timestamps, hold durations, win rates, and concentration all in valid bounds).");
    }
    console.log("");

    console.log("6. SCORING READINESS & RECOMMENDATIONS");
    console.log("--------------------------------------------------");
    console.log(`Safe Metrics (100% Coverage, No Edge Imputation Required):`);
    for (const sm of report.scoringReadiness.safeMetrics) {
        console.log(`  - ${sm}`);
    }
    console.log(`\nConditional / Excluded Metrics:`);
    for (const em of report.scoringReadiness.excludedOrConditionalMetrics) {
        console.log(`  - ${em.metric}:`);
        console.log(`      Reason: ${em.reason}`);
        console.log(`      Rule  : ${em.recommendation}`);
    }

    console.log("\n==================================================");
    console.log("AUDIT VERDICT:");
    console.log(report.assessment);
    console.log("==================================================\n");
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset file not found: ${cli.datasetPath}`);
    }

    console.log(`Loading dataset from ${cli.datasetPath}...`);
    const rawContent = fs.readFileSync(cli.datasetPath, "utf8");
    const dataset = JSON.parse(rawContent);

    const report = auditScreeningDataset(dataset, cli.datasetPath);

    // Save report artifact
    const outDir = path.dirname(cli.outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(cli.outputPath, JSON.stringify(report, null, 2), "utf8");

    printAuditReport(report);
    console.log(`Detailed audit JSON artifact written to: ${cli.outputPath}`);
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("audit-wallet-screening-dataset.ts") ||
        process.argv[1].endsWith("audit-wallet-screening-dataset.js") ||
        process.argv[1].includes("audit-wallet-screening-dataset"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Dataset audit failed: ${err?.message || err}`);
        process.exit(1);
    });
}
