import {
    mkdir,
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MASTER_PATH = path.resolve(
    "data/master/wallets-master.json",
);

const POOL_REGISTRY_PATH = path.resolve(
    "data/master/pool-wallets-registry.json",
);

const FABRIQ_PATH = path.resolve(
    "data/master/wallets-fabriq.json",
);

const FRONTEND_PATH = path.resolve(
    "frontend/public/data/wallets-14d.json",
);

function isObject(
    value: unknown,
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

const TIMEZONE = "Asia/Jakarta";

const DAY_MS =
    24 * 60 * 60 * 1000;

function finiteNumber(
    value: unknown,
): number | null {
    const parsed =
        Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function getCurrentDate(
    timeZone: string,
): string {
    const parts =
        new Intl.DateTimeFormat(
            "en-US",
            {
                timeZone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            },
        ).formatToParts(
            new Date(),
        );

    const year =
        parts.find(
            (part) =>
                part.type === "year",
        )?.value;

    const month =
        parts.find(
            (part) =>
                part.type === "month",
        )?.value;

    const day =
        parts.find(
            (part) =>
                part.type === "day",
        )?.value;

    return `${year}-${month}-${day}`;
}

function dateToDay(
    date: string,
): number {
    return Date.parse(
        `${date}T00:00:00.000Z`,
    );
}

export interface FabriqDailyPoint {
    date: string;
    pnlSol: number;
    pnlUsd: number;
    feesSol: number;
    feesUsd: number;
    positions: number;
    winRateSol: number;
    winRateUsd: number;
}

export interface FabriqDerived {
    asOfDate: string;
    currentMonth: string;
    pnl7dSol: number;
    pnl30dSol: number;
    monthlyPnlSol: number;
    allTimePnlSol: number | null;
    daily: FabriqDailyPoint[];
}

function deriveFabriq(
    canonicalFabriq: Record<string, unknown> | undefined | null,
    asOfDate: string,
): FabriqDerived | undefined {
    if (!isObject(canonicalFabriq)) {
        return undefined;
    }

    const fabriq = canonicalFabriq;
    const calendars =
        isObject(fabriq.calendars)
            ? fabriq.calendars
            : {};

    const stats =
        isObject(fabriq.stats)
            ? fabriq.stats
            : {};

    const dailyByDate =
        new Map<
            string,
            FabriqDailyPoint
        >();

    for (
        const calendar
        of Object.values(calendars)
    ) {
        if (!isObject(calendar)) {
            continue;
        }

        for (
            const [date, rawDay]
            of Object.entries(calendar)
        ) {
            if (
                !/^\d{4}-\d{2}-\d{2}$/.test(
                    date,
                )
            ) {
                continue;
            }

            if (
                date > asOfDate ||
                !isObject(rawDay)
            ) {
                continue;
            }

            dailyByDate.set(
                date,
                {
                    date,
                    pnlSol:
                        finiteNumber(
                            rawDay.pnlSol,
                        ) ?? 0,
                    pnlUsd:
                        finiteNumber(
                            rawDay.pnlUsd,
                        ) ?? 0,
                    feesSol:
                        finiteNumber(
                            rawDay.feesSol,
                        ) ?? 0,
                    feesUsd:
                        finiteNumber(
                            rawDay.feesUsd,
                        ) ?? 0,
                    positions:
                        finiteNumber(
                            rawDay.positions,
                        ) ?? 0,
                    winRateSol:
                        finiteNumber(
                            rawDay.winRateSol,
                        ) ?? 0,
                    winRateUsd:
                        finiteNumber(
                            rawDay.winRateUsd,
                        ) ?? 0,
                },
            );
        }
    }

    const daily =
        [...dailyByDate.values()]
            .sort(
                (a, b) =>
                    String(a.date)
                        .localeCompare(
                            String(b.date),
                        ),
            );

    const asOfTime =
        dateToDay(
            asOfDate,
        );

    function rollingPnl(
        days: number,
    ) {
        const startTime =
            asOfTime -
            (
                days - 1
            ) *
            DAY_MS;

        return daily.reduce(
            (total, day) => {
                const timestamp =
                    dateToDay(
                        String(
                            day.date,
                        ),
                    );

                if (
                    timestamp <
                    startTime ||
                    timestamp >
                    asOfTime
                ) {
                    return total;
                }

                return (
                    total +
                    Number(
                        day.pnlSol,
                    )
                );
            },
            0,
        );
    }

    const currentMonth =
        asOfDate.slice(
            0,
            7,
        );

    const monthlyPnlSol =
        daily.reduce(
            (total, day) => {
                if (
                    !String(
                        day.date,
                    ).startsWith(
                        `${currentMonth}-`,
                    )
                ) {
                    return total;
                }

                return (
                    total +
                    Number(
                        day.pnlSol,
                    )
                );
            },
            0,
        );

    return {
        asOfDate,
        currentMonth,
        pnl7dSol:
            rollingPnl(7),
        pnl30dSol:
            rollingPnl(30),
        monthlyPnlSol,
        allTimePnlSol:
            finiteNumber(
                stats.netPnlSol,
            ),
        daily,
    };
}

async function loadJsonOrDefault<T>(filePath: string, defaultVal: T): Promise<T> {
    try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content) as T;
    } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
            return defaultVal;
        }
        throw err;
    }
}

interface PoolRegistryEntry {
    owner: string;
    firstSeenAt?: string;
    lastSeenAt?: string;
    tokens?: string[];
    pools?: string[];
    [key: string]: unknown;
}

interface PoolRegistryFile {
    wallets?: PoolRegistryEntry[];
    [key: string]: unknown;
}

interface MasterFile {
    meta?: Record<string, unknown>;
    wallets?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

interface FabriqFile {
    wallets?: Array<{ owner?: string; fabriq?: Record<string, unknown>; [key: string]: unknown }>;
    [key: string]: unknown;
}

export interface PublishResult {
    masterCount: number;
    poolRegistryCount: number;
    publishedCount: number;
    missingFabriqCount: number;
    publishedAt: string;
}

export async function publishWallets(): Promise<PublishResult> {
    console.log("\nPUBLISH WALLET DATA");
    console.log("===================");

    const [masterPayload, poolRegistryPayload, fabriqPayload] = await Promise.all([
        loadJsonOrDefault<MasterFile>(MASTER_PATH, { wallets: [] }),
        loadJsonOrDefault<PoolRegistryFile>(POOL_REGISTRY_PATH, { wallets: [] }),
        loadJsonOrDefault<FabriqFile>(FABRIQ_PATH, { wallets: [] }),
    ]);

    const masterWallets = Array.isArray(masterPayload.wallets) ? masterPayload.wallets : [];
    const poolWallets = Array.isArray(poolRegistryPayload.wallets) ? poolRegistryPayload.wallets : [];

    const fabriqByOwner = new Map<string, Record<string, unknown>>();
    if (isObject(fabriqPayload) && Array.isArray(fabriqPayload.wallets)) {
        for (const row of fabriqPayload.wallets) {
            if (isObject(row) && typeof row.owner === "string" && row.owner.trim()) {
                if (isObject(row.fabriq)) {
                    fabriqByOwner.set(row.owner.trim(), row.fabriq);
                }
            }
        }
    }

    const publishedAt = new Date().toISOString();
    const derivedAsOfDate = getCurrentDate(TIMEZONE);

    let missingFabriqCount = 0;
    const publishedWallets: Array<Record<string, unknown>> = [];
    const seenOwners = new Set<string>();

    // 1. Process Master LP Agent Wallets (preserve all existing LP Agent fields)
    for (const rawWallet of masterWallets) {
        if (!isObject(rawWallet) || typeof rawWallet.owner !== "string" || !rawWallet.owner.trim()) {
            continue;
        }

        const owner = rawWallet.owner.trim();
        seenOwners.add(owner);

        const canonicalFabriq = fabriqByOwner.get(owner);
        if (!canonicalFabriq) {
            missingFabriqCount++;
        }

        const cleanWallet = { ...rawWallet, owner };
        delete cleanWallet.fabriq;

        publishedWallets.push({
            ...cleanWallet,
            source: cleanWallet.source ?? "lpagent",
            fabriq: canonicalFabriq ?? undefined,
            fabriqDerived: deriveFabriq(
                canonicalFabriq,
                derivedAsOfDate,
            ),
        });
    }

    // 2. Process Pool Scanner Registry Wallets (pool-only wallets)
    let poolOnlyCount = 0;
    for (const poolWallet of poolWallets) {
        if (!isObject(poolWallet) || typeof poolWallet.owner !== "string" || !poolWallet.owner.trim()) {
            continue;
        }

        const owner = poolWallet.owner.trim();
        if (seenOwners.has(owner)) {
            // Already processed via Master (which takes precedence for LP Agent fields)
            continue;
        }

        seenOwners.add(owner);
        poolOnlyCount++;

        const canonicalFabriq = fabriqByOwner.get(owner);
        if (!canonicalFabriq) {
            missingFabriqCount++;
        }

        const derived = deriveFabriq(canonicalFabriq, derivedAsOfDate);

        // Synthesize sparkline daily PnL chart from genuine Fabriq daily points if available
        const pnlChart: Array<Record<string, unknown>> = [];
        if (derived && Array.isArray(derived.daily) && derived.daily.length > 0) {
            let cumulative = 0;
            for (const day of derived.daily) {
                cumulative += Number(day.pnlSol) || 0;
                pnlChart.push({
                    close_day: String(day.date),
                    sum: Number(day.pnlUsd) || 0,
                    sum_native: Number(day.pnlSol) || 0,
                    cumulative_pnl: 0,
                    cumulative_pnl_native: cumulative,
                    win_lp: Number(day.positions) || 0,
                    total_lp: Number(day.positions) || 0,
                });
            }
        }

        const stats = isObject(canonicalFabriq?.stats) ? canonicalFabriq.stats : {};
        const winUsd = isObject(stats.positionWinUsd) ? stats.positionWinUsd : {};
        const winSol = isObject(stats.positionWinSol) ? stats.positionWinSol : {};

        // Sourced strictly from genuine Fabriq data.
        // Unknown LP Agent metrics are left null/missing (NOT fabricated, NOT default 0).
        publishedWallets.push({
            owner,
            chain: "SOL",
            protocol: "meteora",
            source: "pool-scanner",

            // Global PnL from Fabriq
            total_pnl: finiteNumber(stats.netPnlUsd),
            total_pnl_native: finiteNumber(stats.netPnlSol),
            total_pnl_7d: null,
            total_pnl_native_7d: derived?.pnl7dSol ?? null,
            total_pnl_30d: null,
            total_pnl_native_30d: derived?.pnl30dSol ?? null,

            // Volume & fees from Fabriq
            total_fee: finiteNumber(stats.totalFeesUsd),
            total_fee_native: finiteNumber(stats.totalFeesSol),
            total_inflow: finiteNumber(stats.totalDepositsUsd),
            total_inflow_native: finiteNumber(stats.totalDepositsSol),
            total_outflow: finiteNumber(stats.totalWithdrawalsUsd),
            total_outflow_native: finiteNumber(stats.totalWithdrawalsSol),
            avg_inflow: finiteNumber(stats.avgAddLiquidityUsd),
            avg_inflow_native: finiteNumber(stats.avgAddLiquiditySol),

            // Position & win rate from Fabriq
            total_lp: finiteNumber(stats.totalPositions),
            win_lp: finiteNumber(winSol.wins),
            win_rate: finiteNumber(winUsd.percentage) !== null
                ? Number(winUsd.percentage) / 100
                : null,
            win_rate_native: finiteNumber(winSol.percentage) !== null
                ? Number(winSol.percentage) / 100
                : null,

            // Unknown LP Agent metrics strictly null:
            total_pool: null,
            total_lp_7d: null,
            total_lp_30d: null,
            closed_lp: null,
            opening_lp: null,
            avg_age_hour: null,
            total_reward: null,
            total_reward_native: null,
            expected_value: null,
            expected_value_native: null,
            fee_percent: null,
            fee_percent_native: null,
            apr: null,
            roi: null,
            roi_avg_inflow: null,
            roi_avg_inflow_native: null,
            avg_pos_profit: null,
            avg_pos_profit_native: null,
            avg_monthly_profit_percent: null,
            avg_monthly_pnl: null,
            avg_monthly_inflow: null,
            avg_monthly_profit_percent_native: null,
            avg_monthly_pnl_native: null,
            avg_monthly_inflow_native: null,

            // Do not use rolling-90d Fabriq dates as true wallet creation age:
            first_activity: null,
            last_activity: null,

            updated_at: typeof canonicalFabriq?.fetchedAt === "string" ? canonicalFabriq.fetchedAt : publishedAt,
            pnl_chart: pnlChart,

            _discovery: {
                firstSeenAt: poolWallet.firstSeenAt,
                lastSeenAt: poolWallet.lastSeenAt,
                pools: poolWallet.pools,
                tokens: poolWallet.tokens,
            },

            fabriq: canonicalFabriq ?? undefined,
            fabriqDerived: derived,
            intelligenceV1: null, // explicitly unjoined
        });
    }

    if (publishedWallets.length === 0) {
        throw new Error("Refusing to publish an empty wallet dataset.");
    }

    const publishedPayload = {
        meta: {
            ...(isObject(masterPayload.meta) ? masterPayload.meta : {}),
            publishedAt,
            derivedAsOfDate,
            masterCount: masterWallets.length,
            poolRegistryCount: poolWallets.length,
            poolOnlyCount,
            totalUniqueWallets: publishedWallets.length,
        },
        wallets: publishedWallets,
    };

    await mkdir(
        path.dirname(FRONTEND_PATH),
        { recursive: true },
    );

    const tempPath = `${FRONTEND_PATH}.tmp.${Date.now()}`;

    await writeFile(
        tempPath,
        JSON.stringify(
            publishedPayload,
            null,
            2,
        ),
        "utf8",
    );

    await rename(
        tempPath,
        FRONTEND_PATH,
    );

    console.log(`Source Master : ${MASTER_PATH} (${masterWallets.length})`);
    console.log(`Source Pool   : ${POOL_REGISTRY_PATH} (${poolWallets.length})`);
    console.log(`Fabriq Store  : ${FABRIQ_PATH} (${fabriqByOwner.size})`);
    console.log(`Target File   : ${FRONTEND_PATH}`);
    console.log(`Total Wallets : ${publishedWallets.length} (Master: ${masterWallets.length}, Pool-only: ${poolOnlyCount})`);
    console.log(`Missing Fabriq: ${missingFabriqCount}`);
    console.log("Status        : published successfully");

    return {
        masterCount: masterWallets.length,
        poolRegistryCount: poolWallets.length,
        publishedCount: publishedWallets.length,
        missingFabriqCount,
        publishedAt,
    };
}

async function main() {
    await publishWallets();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error("\nPUBLISH FAILED");
        console.error(
            error instanceof Error
                ? error.stack || error.message
                : error,
        );
        process.exitCode = 1;
    });
}
