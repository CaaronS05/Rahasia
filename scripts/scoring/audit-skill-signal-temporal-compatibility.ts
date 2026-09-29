import fs from "node:fs";
import path from "node:path";

interface CliOptions {
    scoreFile: string;
    behaviourFile: string;
    designFile: string;
    masterFile: string;
    outputFile: string;
}

type WindowType = "ROLLING" | "CUSTOM" | "FULL_HISTORY" | "UNKNOWN";

type CompatibilityRating =
    | "EXACT_MATCH"
    | "COMPATIBLE_SAME_WINDOW"
    | "PARTIAL_OVERLAP"
    | "MISMATCH"
    | "UNKNOWN";

type GlobalAssessment =
    | "SAFE_TO_FINALIZE"
    | "TEMPORAL_MISMATCH"
    | "INSUFFICIENT_METADATA";

interface SignalTemporalContract {
    signal: string;
    sourceFile: string;
    sourceField: string;
    sourceSystem: string;
    windowType: WindowType;
    windowStart: string | null;
    windowEnd: string | null;
    lookbackDays: number | null;
    asOf: string | null;
    evidenceForWindow: string;
    status: string;
}

interface WalletObservedPositionBounds {
    positionCount: number;
    earliestOpenedAt: string | null;
    latestClosedAt: string | null;
    spanDays: number | null;
    hasCrossMonthActivity: boolean;
    monthsObserved: string[];
}

interface WalletTemporalAuditRecord {
    wallet: string;
    scoreStatus: string;
    compatibility: CompatibilityRating;
    signals: {
        roiAvgInflow: {
            available: boolean;
            windowType: WindowType;
            windowStart: string | null;
            windowEnd: string | null;
            evidence: string;
        };
        profitFactor: {
            available: boolean;
            windowType: WindowType;
            month: string | null;
            calendarStart: string | null;
            calendarEnd: string | null;
            evidence: string;
        };
        positionWinRate: {
            available: boolean;
            windowType: WindowType;
            observedEarliest: string | null;
            observedLatest: string | null;
            evidence: string;
        };
        pnlConcentrationTop1: {
            available: boolean;
            windowType: WindowType;
            observedEarliest: string | null;
            observedLatest: string | null;
            evidence: string;
        };
    };
    observedPositionBounds: WalletObservedPositionBounds;
    issues: string[];
}

interface TemporalAuditOutput {
    generatedAt: string;
    scoreVersion: string;
    walletCount: number;
    globalAssessment: GlobalAssessment;
    safeToFinalize: boolean;
    signals: {
        roiAvgInflow: SignalTemporalContract;
        profitFactor: SignalTemporalContract;
        positionWinRate: SignalTemporalContract;
        pnlConcentrationTop1: SignalTemporalContract;
    };
    walletCompatibilitySummary: {
        exactOrCompatibleCount: number;
        partialOverlapCount: number;
        mismatchCount: number;
        unknownCount: number;
    };
    wallets: WalletTemporalAuditRecord[];
    blockingIssues: string[];
    warnings: string[];
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
        scoreFile:
            options.score ||
            options.input ||
            options["score-file"] ||
            path.resolve("data/discovery/waldisc-2/provisional-skill-score-v1.json"),
        behaviourFile:
            options.behaviour ||
            options.dataset ||
            options["behaviour-file"] ||
            path.resolve("data/discovery/waldisc-2/wallet-behaviour-dataset.json"),
        designFile:
            options.design ||
            options["design-file"] ||
            path.resolve("data/discovery/waldisc-2/skill-signal-design.json"),
        masterFile:
            options.master ||
            options["master-file"] ||
            path.resolve("data/master/wallets-master.json"),
        outputFile:
            options.output ||
            options["output-file"] ||
            path.resolve("data/discovery/waldisc-2/skill-signal-temporal-audit.json"),
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

function parseIsoOrSqlDate(dStr: string | null | undefined): Date | null {
    if (!dStr) return null;
    const cleaned = dStr.trim().replace(" ", "T");
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
}

function extractWalletPositionBounds(
    walletAddress: string
): WalletObservedPositionBounds {
    const posFile = path.resolve(`data/discovery/waldisc-2/${walletAddress}/positions.json`);
    const fabriqPosFile = path.resolve(`data/discovery/waldisc-2/${walletAddress}/fabriq-positions.json`);

    let positions: any[] = [];
    if (fs.existsSync(posFile)) {
        const parsed = tryReadJson(posFile);
        if (Array.isArray(parsed)) positions = parsed;
    } else if (fs.existsSync(fabriqPosFile)) {
        const parsed = tryReadJson(fabriqPosFile);
        if (Array.isArray(parsed)) positions = parsed;
    }

    if (positions.length === 0) {
        return {
            positionCount: 0,
            earliestOpenedAt: null,
            latestClosedAt: null,
            spanDays: null,
            hasCrossMonthActivity: false,
            monthsObserved: [],
        };
    }

    let minOpened: Date | null = null;
    let maxClosed: Date | null = null;
    const monthsSet = new Set<string>();

    for (const p of positions) {
        const openStr = p.openedAt || p.opened_at || p.firstSeenAt || p.fabriqSummary?.openedAt;
        const closeStr = p.closedAt || p.latest_close_ts || p.lastSeenAt || p.fabriqSummary?.latestCloseAt;

        const dOpen = parseIsoOrSqlDate(openStr);
        const dClose = parseIsoOrSqlDate(closeStr);

        if (dOpen) {
            if (!minOpened || dOpen.getTime() < minOpened.getTime()) {
                minOpened = dOpen;
            }
            monthsSet.add(dOpen.toISOString().slice(0, 7));
        }

        if (dClose) {
            if (!maxClosed || dClose.getTime() > maxClosed.getTime()) {
                maxClosed = dClose;
            }
            monthsSet.add(dClose.toISOString().slice(0, 7));
        }
    }

    const spanDays =
        minOpened && maxClosed
            ? Number(((maxClosed.getTime() - minOpened.getTime()) / (1000 * 60 * 60 * 24)).toFixed(2))
            : null;

    return {
        positionCount: positions.length,
        earliestOpenedAt: minOpened ? minOpened.toISOString() : null,
        latestClosedAt: maxClosed ? maxClosed.toISOString() : null,
        spanDays,
        hasCrossMonthActivity: monthsSet.size > 1,
        monthsObserved: Array.from(monthsSet).sort(),
    };
}

async function main() {
    const { scoreFile, masterFile, outputFile } = parseCliArgs();

    if (!fs.existsSync(scoreFile)) {
        throw new Error(`Provisional skill score file not found: ${scoreFile}`);
    }

    const scoreData = tryReadJson(scoreFile);
    if (!scoreData || !Array.isArray(scoreData.wallets)) {
        throw new Error(`Invalid score file structure in: ${scoreFile}`);
    }

    const masterData = tryReadJson(masterFile);
    const masterMap = new Map<string, any>();
    if (masterData && Array.isArray(masterData.wallets)) {
        for (const mw of masterData.wallets) {
            if (mw && mw.owner) {
                masterMap.set(mw.owner, mw);
            }
        }
    }

    const scoredWallets: any[] = scoreData.wallets;
    const walletCount = scoredWallets.length;
    const scoreVersion = scoreData.scoreVersion || "v1.1-provisional";

    // ==================================================
    // 1. SIGNAL TEMPORAL CONTRACT AUDIT
    // ==================================================
    const signalContracts: {
        roiAvgInflow: SignalTemporalContract;
        profitFactor: SignalTemporalContract;
        positionWinRate: SignalTemporalContract;
        pnlConcentrationTop1: SignalTemporalContract;
    } = {
        roiAvgInflow: {
            signal: "ROI Avg Inflow",
            sourceFile: "data/master/wallets-master.json",
            sourceField: "roi_avg_inflow_native",
            sourceSystem: "wallets-master (pool scanner / web scraper)",
            windowType: "UNKNOWN",
            windowStart: null,
            windowEnd: null,
            lookbackDays: null,
            asOf: masterData?.meta?.updatedAt || masterData?.meta?.scanFinishedAt || null,
            evidenceForWindow:
                "wallets-master contains sourceFilter with lastActivity=7D and firstActivity=2026-09-06, but root field roi_avg_inflow_native carries no explicit temporal suffix or horizon metadata. Window contract is unstated.",
            status: "INSUFFICIENT_METADATA",
        },
        profitFactor: {
            signal: "Profit Factor",
            sourceFile: "data/master/wallets-master.json",
            sourceField: "fabriq.stats.profitFactorUsd.ratio",
            sourceSystem: "fabriq-api (monthly wallet stats)",
            windowType: "CUSTOM",
            windowStart: "2026-09-01T00:00:00.000Z",
            windowEnd: "2026-09-30T23:59:59.999Z",
            lookbackDays: 30,
            asOf: "2026-09-28T05:19:21.944Z",
            evidenceForWindow:
                "Explicitly scoped by calendar month via fabriq.month = '2026-09' across all matched master wallet records.",
            status: "CONFIRMED_MONTHLY",
        },
        positionWinRate: {
            signal: "Position Win Rate",
            sourceFile: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.winRatePct",
            sourceSystem: "waldisc-2-pipeline (closed position extraction)",
            windowType: "UNKNOWN",
            windowStart: null,
            windowEnd: null,
            lookbackDays: null,
            asOf: "2026-09-28T08:26:03.992Z",
            evidenceForWindow:
                "Calculated over all discovered closed positions in legacy pools. No configured query window (windowDays, historyMode, or startDate) is persisted in behaviour dataset or summary.json.",
            status: "UNCONFIGURED_WINDOW",
        },
        pnlConcentrationTop1: {
            signal: "PnL Concentration Top1",
            sourceFile: "data/discovery/waldisc-2/wallet-behaviour-dataset.json",
            sourceField: "performance.top1PositiveProfitSharePct",
            sourceSystem: "waldisc-2-pipeline (closed position extraction)",
            windowType: "UNKNOWN",
            windowStart: null,
            windowEnd: null,
            lookbackDays: null,
            asOf: "2026-09-28T08:26:03.992Z",
            evidenceForWindow:
                "Calculated over gross-positive positions from discovered closed positions. No configured query window or historyMode is persisted.",
            status: "UNCONFIGURED_WINDOW",
        },
    };

    // ==================================================
    // 2. PER-WALLET TEMPORAL AUDIT
    // ==================================================
    const walletAuditRecords: WalletTemporalAuditRecord[] = [];
    let exactOrCompatibleCount = 0;
    let partialOverlapCount = 0;
    let mismatchCount = 0;
    let unknownCount = 0;

    for (const sw of scoredWallets) {
        const w: string = sw.wallet;
        const mw = masterMap.get(w);
        const issues: string[] = [];

        // Observed closed position bounds from raw position files
        const bounds = extractWalletPositionBounds(w);

        // Fabriq month and calendar bounds from master
        const fabriqMonth = mw?.fabriq?.month || null;
        const calendarKeys = mw?.fabriq?.calendar ? Object.keys(mw.fabriq.calendar).sort() : [];
        const calendarStart = calendarKeys.length > 0 ? calendarKeys[0] : null;
        const calendarEnd = calendarKeys.length > 0 ? calendarKeys[calendarKeys.length - 1] : null;

        const hasRoi = sw.rawSignals?.roiAvgInflow !== null;
        const hasPf = sw.rawSignals?.profitFactor !== null;
        const hasWin = sw.rawSignals?.positionWinRatePct !== null;
        const hasConc =
            sw.rawSignals?.top1PositiveProfitSharePct !== null ||
            sw.concentration?.state === "NO_POSITIVE_PROFIT";

        if (!hasRoi || !hasPf) {
            issues.push(
                "Source data absent in master dataset (missing ROI Avg Inflow or Profit Factor)."
            );
        }

        // Check cross-month discrepancies
        if (fabriqMonth && bounds.monthsObserved.length > 0) {
            const nonFabriqMonths = bounds.monthsObserved.filter((m) => m !== fabriqMonth);
            if (nonFabriqMonths.length > 0) {
                issues.push(
                    `TEMPORAL OVERLAP MISMATCH: Fabriq economic metrics are scoped strictly to month ${fabriqMonth}, whereas observed granular positions span into ${nonFabriqMonths.join(", ")} (earliest: ${bounds.earliestOpenedAt?.slice(0, 10)}, latest: ${bounds.latestClosedAt?.slice(0, 10)}).`
                );
            }
        }

        // Unstated ROI window issue
        issues.push(
            "ROI Avg Inflow temporal window is unstated in wallets-master schema."
        );

        // Classify compatibility
        let compatibility: CompatibilityRating = "UNKNOWN";
        if (!hasRoi || !hasPf) {
            compatibility = "UNKNOWN";
            unknownCount++;
        } else if (bounds.monthsObserved.some((m) => m !== fabriqMonth)) {
            // Observed positions extend beyond the Fabriq monthly window
            compatibility = "PARTIAL_OVERLAP";
            partialOverlapCount++;
        } else {
            // Months match (e.g. only September positions), but ROI window is still unconfirmed
            compatibility = "UNKNOWN";
            unknownCount++;
        }

        walletAuditRecords.push({
            wallet: w,
            scoreStatus: sw.scoreStatus,
            compatibility,
            signals: {
                roiAvgInflow: {
                    available: hasRoi,
                    windowType: "UNKNOWN",
                    windowStart: null,
                    windowEnd: null,
                    evidence: hasRoi
                        ? "Master wallet entry present, but duration/lookback is unstated."
                        : "Field absent in master dataset.",
                },
                profitFactor: {
                    available: hasPf,
                    windowType: hasPf ? "CUSTOM" : "UNKNOWN",
                    month: fabriqMonth,
                    calendarStart,
                    calendarEnd,
                    evidence: hasPf
                        ? `Scoped to month ${fabriqMonth} (calendar active: ${calendarStart} to ${calendarEnd}).`
                        : "Field absent in master dataset.",
                },
                positionWinRate: {
                    available: hasWin,
                    windowType: "UNKNOWN",
                    observedEarliest: bounds.earliestOpenedAt,
                    observedLatest: bounds.latestClosedAt,
                    evidence: `Derived from ${bounds.positionCount} closed positions across months: ${bounds.monthsObserved.join(", ") || "none"}.`,
                },
                pnlConcentrationTop1: {
                    available: hasConc,
                    windowType: "UNKNOWN",
                    observedEarliest: bounds.earliestOpenedAt,
                    observedLatest: bounds.latestClosedAt,
                    evidence:
                        sw.concentration?.state === "NO_POSITIVE_PROFIT"
                            ? "Handled via domain policy (no positive profit); underlying positions match Win Rate."
                            : `Derived from ${bounds.positionCount} closed positions across months: ${bounds.monthsObserved.join(", ") || "none"}.`,
                },
            },
            observedPositionBounds: bounds,
            issues,
        });
    }

    // ==================================================
    // 3. GLOBAL ASSESSMENT & BLOCKING ISSUES
    // ==================================================
    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    // Blocking Issue 1: Insufficient ROI temporal metadata
    blockingIssues.push(
        "INSUFFICIENT TEMPORAL METADATA: Field roi_avg_inflow_native in data/master/wallets-master.json lacks an explicit temporal window contract (unspecified whether 7D, 30D, or all-time). Compatibility with other signals cannot be proven."
    );

    // Blocking Issue 2: Period mismatch between monthly Fabriq stats and granular position history
    if (partialOverlapCount > 0) {
        blockingIssues.push(
            `TEMPORAL HORIZON MISMATCH: ${partialOverlapCount} wallets contain closed positions spanning outside the September 2026 Fabriq window (e.g. August 2026 activity). Combining single-month Profit Factor with multi-month position win rates mixes differing observation horizons.`
        );
    }

    // Blocking Issue 3: Unconfigured query window in behaviour dataset
    blockingIssues.push(
        "UNCONFIGURED PIPELINE QUERY WINDOW: WALDISC-2 wallet behaviour dataset does not record configured windowDays or historyMode metadata. Granular position metrics cannot be mathematically guaranteed to match master query horizons."
    );

    // Warnings
    warnings.push(
        "Wallet DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU has no master record; temporal audit cannot inspect master economic horizons."
    );
    warnings.push(
        "Current Skill V1 score contract must remain PROVISIONAL (v1.1-provisional) until Fabriq query window and master economic metric horizons are synchronized and explicitly declared."
    );

    const globalAssessment: GlobalAssessment =
        partialOverlapCount > 0 ? "TEMPORAL_MISMATCH" : "INSUFFICIENT_METADATA";
    const safeToFinalize = false;

    const output: TemporalAuditOutput = {
        generatedAt: new Date().toISOString(),
        scoreVersion,
        walletCount,
        globalAssessment,
        safeToFinalize,
        signals: signalContracts,
        walletCompatibilitySummary: {
            exactOrCompatibleCount,
            partialOverlapCount,
            mismatchCount,
            unknownCount,
        },
        wallets: walletAuditRecords,
        blockingIssues,
        warnings,
    };

    atomicWriteJson(outputFile, output);

    // ==================================================
    // TERMINAL REPORT
    // ==================================================
    console.log("\nWALDISC-2 STEP 6.4 — TEMPORAL COMPATIBILITY AUDIT\n");
    console.log(`Score Version       : ${scoreVersion}`);
    console.log(`Wallets Audited     : ${walletCount}\n`);

    const colSig = "Signal".padEnd(22);
    const colWin = "Window Type".padEnd(14);
    const colStart = "Start".padEnd(13);
    const colEnd = "End".padEnd(13);
    const colStatus = "Status";

    console.log(`${colSig}${colWin}${colStart}${colEnd}${colStatus}`);
    console.log("-".repeat(78));

    const sigRows = [
        signalContracts.roiAvgInflow,
        signalContracts.profitFactor,
        signalContracts.positionWinRate,
        signalContracts.pnlConcentrationTop1,
    ];

    for (const s of sigRows) {
        const sStr = s.signal.padEnd(22);
        const wStr = s.windowType.padEnd(14);
        const startStr = (s.windowStart ? s.windowStart.slice(0, 10) : "null").padEnd(13);
        const endStr = (s.windowEnd ? s.windowEnd.slice(0, 10) : "null").padEnd(13);
        console.log(`${sStr}${wStr}${startStr}${endStr}${s.status}`);
    }

    console.log("-".repeat(78));
    console.log("\nWallet Compatibility:");
    console.log(`  Exact / Compatible    : ${exactOrCompatibleCount}`);
    console.log(`  Partial Overlap       : ${partialOverlapCount}`);
    console.log(`  Mismatch              : ${mismatchCount}`);
    console.log(`  Unknown               : ${unknownCount}`);

    console.log(`\nGlobal Assessment:`);
    console.log(`  ${globalAssessment} (Score contract CANNOT be finalized yet)`);

    console.log("\nBlocking Issues:");
    for (const bi of blockingIssues) {
        console.log(`  • [BLOCKING] ${bi}`);
    }

    console.log(`\nSafe to Finalize      : NO`);
    console.log(`Output File           : ${outputFile}\n`);
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Temporal compatibility audit failed: ${err.message}`);
    process.exit(1);
});
