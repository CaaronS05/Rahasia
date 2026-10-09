import { fileURLToPath } from "node:url";
import { isValidSolanaAddress } from "../v1/single-wallet-intelligence.ts";
import { loadPublishedPositionPair } from "./position-analytics-storage.ts";
import {
    saveMeteoraVerificationReport,
    verifyPositionAnalyticsWithMeteora,
    DEFAULT_VERIFICATION_STORAGE_BASE,
} from "./meteora-verification-adapter.ts";
import type {
    AnalyticsPeriod,
    MeteoraVerificationReport,
    PositionVerificationDetail,
    RequestBudgetTracker,
} from "./position-analytics-types.ts";

export interface VerificationCliOptions {
    wallet: string;
    period?: AnalyticsPeriod;
    positions: string[];
    maxAttempts?: number;
    timeoutMs?: number;
    verificationBaseDir?: string;
    bundlesDir?: string;
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
    baseUrl?: string;
}

export interface VerificationCliResult {
    success: boolean;
    report?: MeteoraVerificationReport;
    savedPath?: string;
    error?: string;
}

const VALID_PERIODS: readonly AnalyticsPeriod[] = ["30D", "90D", "ALL_AVAILABLE"];

export function parseVerificationCliArgs(rawArgs: string[]): {
    wallet: string | null;
    period: AnalyticsPeriod;
    positions: string[];
    help: boolean;
    verificationBaseDir?: string;
    bundlesDir?: string;
    maxAttempts?: number;
} {
    let wallet: string | null = null;
    let period: AnalyticsPeriod = "30D";
    const positions: string[] = [];
    let help = false;
    let verificationBaseDir: string | undefined;
    let bundlesDir: string | undefined;
    let maxAttempts: number | undefined;

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];

        if (arg === "--help" || arg === "-h") {
            help = true;
        } else if (arg === "--wallet" && rawArgs[i + 1]) {
            wallet = rawArgs[i + 1].trim();
            i++;
        } else if (arg.startsWith("--wallet=")) {
            wallet = arg.slice(9).trim();
        } else if (arg === "--period" && rawArgs[i + 1]) {
            period = rawArgs[i + 1].trim() as AnalyticsPeriod;
            i++;
        } else if (arg.startsWith("--period=")) {
            period = arg.slice(9).trim() as AnalyticsPeriod;
        } else if (arg === "--position" && rawArgs[i + 1]) {
            const val = rawArgs[i + 1].trim();
            if (val.includes(",")) {
                positions.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
            } else if (val) {
                positions.push(val);
            }
            i++;
        } else if (arg.startsWith("--position=")) {
            const val = arg.slice(11).trim();
            if (val.includes(",")) {
                positions.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
            } else if (val) {
                positions.push(val);
            }
        } else if (arg === "--verification-base-dir" && rawArgs[i + 1]) {
            verificationBaseDir = rawArgs[i + 1].trim();
            i++;
        } else if (arg.startsWith("--verification-base-dir=")) {
            verificationBaseDir = arg.slice(24).trim();
        } else if (arg === "--bundles-dir" && rawArgs[i + 1]) {
            bundlesDir = rawArgs[i + 1].trim();
            i++;
        } else if (arg.startsWith("--bundles-dir=")) {
            bundlesDir = arg.slice(14).trim();
        } else if (arg === "--max-attempts" && rawArgs[i + 1]) {
            const parsed = parseInt(rawArgs[i + 1].trim(), 10);
            if (!isNaN(parsed) && parsed > 0) {
                maxAttempts = parsed;
            }
            i++;
        } else if (arg.startsWith("--max-attempts=")) {
            const parsed = parseInt(arg.slice(15).trim(), 10);
            if (!isNaN(parsed) && parsed > 0) {
                maxAttempts = parsed;
            }
        }
    }

    return {
        wallet,
        period,
        positions,
        help,
        verificationBaseDir,
        bundlesDir,
        maxAttempts,
    };
}

export function printHelp(): void {
    console.log(`
Usage:
  node --experimental-strip-types scripts/analytics/verify-position-analytics.ts --wallet <ADDRESS> --position <ADDRESS> [options]

Required Arguments:
  --wallet <ADDRESS>     Solana wallet address (must be valid base58 address)
  --position <ADDRESS>   Target closed position address (repeatable, maximum 3 positions)

Optional Arguments:
  --period <PERIOD>      Analysis period: 30D | 90D | ALL_AVAILABLE (default: 30D)
  --help, -h             Show this help message and exit

Safety Constraints:
  - Explicit position selection is mandatory. Automatic full-wallet verification is prohibited.
  - Maximum 3 positions per run to preserve hard network budgets and rate limits.
  - Hard network budget defaults to 10 total HTTP attempts including retries.
  - Verification reports are saved exclusively to data/analytics/verification/.
  - Published datasets and bundles are strictly read-only and never modified.
`);
}

function formatUsd(val: number | null | undefined): string {
    if (val === null || val === undefined) return "N/A";
    const prefix = val >= 0 ? "+$" : "-$";
    return `${prefix}${Math.abs(val).toFixed(2)}`;
}

export function printVerificationReport(
    report: MeteoraVerificationReport,
    budgetTracker: RequestBudgetTracker
): void {
    console.log("========================================================================================================================");
    console.log("METEORA POSITION ANALYTICS VERIFICATION REPORT");
    console.log(`Target Wallet : ${report.targetWallet}`);
    console.log(`Period        : ${report.period}`);
    console.log(`Verified At   : ${report.verifiedAt}`);
    console.log(`HTTP Budget   : ${budgetTracker.attempts} / ${budgetTracker.maxAttempts} attempts used`);
    if (report.incompletePagination) {
        console.log("STATUS        : INCOMPLETE PAGINATION (API page cap reached before completing traversal)");
    } else {
        console.log("STATUS        : COMPLETE");
    }
    console.log("========================================================================================================================");

    // Table header
    console.log(
        "Position Address".padEnd(46) +
        "Pool Address".padEnd(46) +
        "Local PnL".padStart(12) +
        "Meteora PnL".padStart(13) +
        "  " +
        "Classification".padEnd(25) +
        "Tokens"
    );
    console.log("-".repeat(154));

    for (const pos of report.positions) {
        const localPnlStr = formatUsd(pos.usdValuations.pnlUsd.localUsd);
        const metPnlStr = formatUsd(pos.usdValuations.pnlUsd.meteoraUsd?.numeric);
        const tokenMatchStr = pos.tokenFlows.allTokensMatch ? "MATCH" : "MISMATCH";

        console.log(
            pos.positionAddress.padEnd(46) +
            pos.poolAddress.padEnd(46) +
            localPnlStr.padStart(12) +
            metPnlStr.padStart(13) +
            "  " +
            pos.classification.padEnd(25) +
            tokenMatchStr
        );
    }

    if (report.missingOrAmbiguousRecords.length > 0) {
        console.log("-".repeat(154));
        console.log("NON-COMPARABLE / UNMATCHED RECORDS:");
        for (const item of report.missingOrAmbiguousRecords) {
            console.log(`  [${item.issue}] Position ${item.positionAddress || "N/A"}: ${item.details}`);
        }
    }

    console.log("========================================================================================================================");
    console.log("CLASSIFICATION SUMMARY");
    console.log(`Total Positions Evaluated  : ${report.summary.totalPositionsEvaluated}`);
    console.log(`MATCH                      : ${report.summary.matchedCount}`);
    console.log(`USD_VALUATION_DIFFERENCE   : ${report.summary.usdValuationDifferenceCount}`);
    console.log(`SIGN_MISMATCH              : ${report.summary.signMismatchCount}`);
    console.log(`MISSING                    : ${report.summary.missingCount}`);
    console.log(`NOT_COMPARABLE             : ${report.summary.notComparableCount}`);
    console.log(`Token Flow Exact Match Rate: ${report.summary.tokenFlowExactMatchRatePct.toFixed(1)}%`);
    console.log(`Timestamp Match Rate       : ${report.summary.closedTimestampMatchRatePct.toFixed(1)}%`);
    console.log("========================================================================================================================");
}

export async function runVerificationCli(options: VerificationCliOptions): Promise<VerificationCliResult> {
    const rawWallet = options.wallet?.trim();
    if (!rawWallet || !isValidSolanaAddress(rawWallet)) {
        return {
            success: false,
            error: `INVALID_WALLET: "${options.wallet}" is not a valid Solana address.`,
        };
    }

    const period = options.period || "30D";
    if (!VALID_PERIODS.includes(period)) {
        return {
            success: false,
            error: `INVALID_PERIOD: "${period}" is not valid. Must be one of: ${VALID_PERIODS.join(", ")}.`,
        };
    }

    if (!options.positions || options.positions.length === 0) {
        return {
            success: false,
            error: "EXPLICIT_POSITION_REQUIRED: Explicit position selection is mandatory. Provide at least one position via --position.",
        };
    }

    // Deduplicate while preserving order
    const uniquePositions: string[] = [];
    const seen = new Set<string>();
    for (const p of options.positions) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            uniquePositions.push(trimmed);
        }
    }

    if (uniquePositions.length === 0) {
        return {
            success: false,
            error: "EXPLICIT_POSITION_REQUIRED: No non-empty position addresses provided.",
        };
    }

    for (const posAddr of uniquePositions) {
        if (!isValidSolanaAddress(posAddr)) {
            return {
                success: false,
                error: `INVALID_POSITION: "${posAddr}" is not a valid Solana position address.`,
            };
        }
    }

    if (uniquePositions.length > 3) {
        return {
            success: false,
            error: `POSITION_LIMIT_EXCEEDED: Maximum 3 positions allowed per run. Received ${uniquePositions.length} positions.`,
        };
    }

    // Load published pair
    const publishedPair = loadPublishedPositionPair(rawWallet, period, {
        baseDir: options.bundlesDir,
    });

    if (!publishedPair || !publishedPair.dataset) {
        return {
            success: false,
            error: `DATASET_NOT_FOUND: Published Position Analytics dataset not found for wallet ${rawWallet} and period ${period}.`,
        };
    }

    // Check that requested positions exist in the dataset
    const availablePositionIds = new Set(publishedPair.dataset.positions.map((p) => p.positionId));
    const absentPositionIds = uniquePositions.filter((id) => !availablePositionIds.has(id));

    if (absentPositionIds.length > 0) {
        return {
            success: false,
            error: `POSITION_NOT_IN_DATASET: Position(s) not found in published dataset: ${absentPositionIds.join(", ")}.`,
        };
    }

    // Hard request budget (default 10)
    const budgetTracker: RequestBudgetTracker = {
        attempts: 0,
        maxAttempts: options.maxAttempts ?? 10,
    };

    try {
        const report = await verifyPositionAnalyticsWithMeteora({
            datasetOrBundle: publishedPair.bundle || publishedPair.dataset,
            clientOptions: {
                targetPositionIds: uniquePositions,
                requestBudgetTracker: budgetTracker,
                timeoutMs: options.timeoutMs ?? 8000,
                fetchFn: options.fetchFn,
                baseUrl: options.baseUrl,
            },
        });

        if (report.incompletePagination) {
            printVerificationReport(report, budgetTracker);
            return {
                success: false,
                report,
                error: "INCOMPLETE_PAGINATION: Official Meteora API pagination hit page cap before completing traversal. Report will not be saved.",
            };
        }

        const savedPath = saveMeteoraVerificationReport(
            report,
            options.verificationBaseDir || DEFAULT_VERIFICATION_STORAGE_BASE
        );

        printVerificationReport(report, budgetTracker);
        console.log(`SUCCESS: Verification report atomically persisted to:\n  ${savedPath}\n`);

        return {
            success: true,
            report,
            savedPath,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            error: `VERIFICATION_FAILED: ${msg}`,
        };
    }
}

// CLI Execution Entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const parsed = parseVerificationCliArgs(process.argv.slice(2));

    if (parsed.help) {
        printHelp();
        process.exit(0);
    }

    if (!parsed.wallet) {
        console.error("Error: --wallet <ADDRESS> is required.");
        printHelp();
        process.exit(1);
    }

    if (parsed.positions.length === 0) {
        console.error("Error: --position <ADDRESS> is required (at least 1 position).");
        printHelp();
        process.exit(1);
    }

    runVerificationCli({
        wallet: parsed.wallet,
        period: parsed.period,
        positions: parsed.positions,
        verificationBaseDir: parsed.verificationBaseDir,
        bundlesDir: parsed.bundlesDir,
        maxAttempts: parsed.maxAttempts,
    }).then((res) => {
        if (!res.success) {
            console.error(`\nFAILED: ${res.error}`);
            process.exit(1);
        }
        process.exit(0);
    }).catch((err: unknown) => {
        console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
}
