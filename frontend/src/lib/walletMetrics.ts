import type { PnlPoint, Wallet } from "../types";

const DAY_MS =
    24 * 60 * 60 * 1000;

export function toFiniteNumber(
    value: unknown,
): number | null {
    if (
        typeof value === "number" &&
        Number.isFinite(value)
    ) {
        return value;
    }

    if (
        typeof value === "string" &&
        value.trim() !== ""
    ) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return null;
}

export function pnlColorClass(
    value: unknown,
): "positive" | "negative" | "" {
    const parsed = toFiniteNumber(value);
    if (parsed === null || parsed === 0) {
        return "";
    }
    return parsed > 0 ? "positive" : "negative";
}

export function formatSolPnl(
    value: unknown,
    digits = 2,
    suffix = "SOL",
): string {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return "—";
    }
    const normalized = Object.is(parsed, -0) ? 0 : parsed;
    const sign = normalized > 0 ? "+" : "";
    const formatted = normalized.toLocaleString("en-US", {
        maximumFractionDigits: digits,
    });
    return suffix ? `${sign}${formatted} ${suffix}` : `${sign}${formatted}`;
}

export function formatUsdMetric(
    value: unknown,
    digits = 0,
): string {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return "—";
    }
    const normalized = Object.is(parsed, -0) ? 0 : parsed;
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: digits,
    }).format(normalized);
}

export function formatPercentMetric(
    value: unknown,
): string {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return "—";
    }
    const normalized = Object.is(parsed, -0) ? 0 : parsed;
    return `${normalized.toFixed(2)}%`;
}

export function formatNumberMetric(
    value: unknown,
    digits = 2,
): string {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return "—";
    }
    const normalized = Object.is(parsed, -0) ? 0 : parsed;
    return normalized.toLocaleString("en-US", {
        maximumFractionDigits: digits,
    });
}

export function formatNativeWinRate(
    value: unknown,
): string {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return "—";
    }
    return formatPercentMetric(parsed * 100);
}

export function derivedOrFallback(
    derived: number | null | undefined,
    fallback: number | null | undefined,
): number | null {
    if (
        typeof derived === "number" &&
        Number.isFinite(derived)
    ) {
        return derived;
    }

    if (
        typeof fallback === "number" &&
        Number.isFinite(fallback)
    ) {
        return fallback;
    }

    return null;
}

export function walletPnl7d(
    wallet: Wallet,
): number | null {
    return derivedOrFallback(
        wallet.fabriqDerived?.pnl7dSol,
        wallet.total_pnl_native_7d,
    );
}

export function walletPnl30d(
    wallet: Wallet,
): number | null {
    return derivedOrFallback(
        wallet.fabriqDerived?.pnl30dSol,
        wallet.total_pnl_native_30d,
    );
}

export function walletAllTimePnl(
    wallet: Wallet,
): number | null {
    return derivedOrFallback(
        wallet.fabriqDerived?.allTimePnlSol,
        wallet.total_pnl_native,
    );
}

export function walletMonthlyPnl(
    wallet: Wallet,
): number | null {
    return derivedOrFallback(
        wallet.fabriqDerived?.monthlyPnlSol,
        wallet.avg_monthly_pnl_native,
    );
}

export function walletWinRatePercent(
    wallet: Wallet,
): number | null {
    const positionWin =
        wallet.fabriq?.stats?.positionWinUsd ??
        wallet.fabriq?.stats?.positionWinSol;

    const derived = toFiniteNumber(
        positionWin?.percentage,
    );

    if (derived !== null) {
        return derived;
    }

    const native = toFiniteNumber(
        wallet.win_rate_native,
    );

    if (native !== null) {
        return native * 100;
    }

    return null;
}

export function walletWinDays(
    wallet: Wallet,
): number | null {
    const dayStats =
        wallet.fabriq?.stats?.dayWinUsd ??
        wallet.fabriq?.stats?.dayWinSol;

    return toFiniteNumber(dayStats?.wins);
}

export function walletLoseDays(
    wallet: Wallet,
): number | null {
    const dayStats =
        wallet.fabriq?.stats?.dayWinUsd ??
        wallet.fabriq?.stats?.dayWinSol;

    return toFiniteNumber(dayStats?.losses);
}

export function walletSparkline7d(
    wallet: Wallet,
) {
    const derived =
        wallet.fabriqDerived;

    if (
        !derived?.asOfDate ||
        !Array.isArray(
            derived.daily,
        )
    ) {
        return (
            wallet.pnl_chart ?? []
        )
            .map(
                (point) =>
                    point.cumulative_pnl_native,
            )
            .filter(
                Number.isFinite,
            )
            .slice(-14);
    }

    const endTime =
        Date.parse(
            `${derived.asOfDate}T00:00:00.000Z`,
        );

    if (
        !Number.isFinite(
            endTime,
        )
    ) {
        return [];
    }

    const pnlByDate =
        new Map(
            derived.daily.map(
                (day) => [
                    day.date,
                    Number(day.pnlSol) || 0,
                ],
            ),
        );

    const values: number[] =
        [];

    let cumulative = 0;

    for (
        let offset = 6;
        offset >= 0;
        offset--
    ) {
        const timestamp =
            endTime -
            offset * DAY_MS;

        const date =
            new Date(timestamp)
                .toISOString()
                .slice(0, 10);

        cumulative +=
            pnlByDate.get(date) ??
            0;

        values.push(
            cumulative,
        );
    }

    return values;
}
export function resolveReferenceDate(
    meta?: { derivedAsOfDate?: string; publishedAt?: string } | null,
): string {
    if (meta?.derivedAsOfDate && /^\d{4}-\d{2}-\d{2}$/.test(meta.derivedAsOfDate)) {
        return meta.derivedAsOfDate;
    }
    if (meta?.publishedAt) {
        const ts = Date.parse(meta.publishedAt);
        if (Number.isFinite(ts) && ts > 0) {
            return new Date(ts).toISOString().slice(0, 10);
        }
    }
    return new Date().toISOString().slice(0, 10);
}

export function shiftUtcDays(dateStr: string, days: number): string {
    const ts = Date.parse(`${dateStr}T00:00:00.000Z`);
    if (!Number.isFinite(ts)) return dateStr;
    const d = new Date(ts);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export function extractWalletActivityDates(wallet: Wallet): string[] {
    const dates = new Set<string>();

    if (typeof wallet.last_activity === "string" && wallet.last_activity.trim()) {
        const ts = Date.parse(wallet.last_activity);
        if (Number.isFinite(ts) && ts > 0) {
            dates.add(new Date(ts).toISOString().slice(0, 10));
        }
    }

    if (Array.isArray(wallet.fabriqDerived?.daily)) {
        for (const p of wallet.fabriqDerived.daily) {
            if (
                p?.date &&
                /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
                ((typeof p.positions === "number" && p.positions > 0) ||
                    (typeof p.feesSol === "number" && p.feesSol !== 0) ||
                    (typeof p.feesUsd === "number" && p.feesUsd !== 0) ||
                    (typeof p.pnlSol === "number" && p.pnlSol !== 0) ||
                    (typeof p.pnlUsd === "number" && p.pnlUsd !== 0))
            ) {
                dates.add(p.date);
            }
        }
    }

    if (wallet.fabriq?.calendars && typeof wallet.fabriq.calendars === "object") {
        for (const cal of Object.values(wallet.fabriq.calendars)) {
            if (cal && typeof cal === "object") {
                for (const [dt, rawDay] of Object.entries(cal)) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dt) && rawDay && typeof rawDay === "object") {
                        const day = rawDay as Record<string, unknown>;
                        const positions = Number(day.positions) || 0;
                        const feesSol = Number(day.feesSol) || 0;
                        const pnlSol = Number(day.pnlSol) || 0;
                        const feesUsd = Number(day.feesUsd) || 0;
                        const pnlUsd = Number(day.pnlUsd) || 0;
                        if (positions > 0 || feesSol !== 0 || pnlSol !== 0 || feesUsd !== 0 || pnlUsd !== 0) {
                            dates.add(dt);
                        }
                    }
                }
            }
        }
    }

    if (Array.isArray(wallet.pnl_chart)) {
        for (const pt of wallet.pnl_chart) {
            if (pt?.close_day) {
                const ts = Date.parse(pt.close_day);
                if (
                    Number.isFinite(ts) &&
                    ts > 0 &&
                    ((typeof pt.total_lp === "number" && pt.total_lp > 0) ||
                        (typeof pt.closed_lp === "number" && pt.closed_lp > 0) ||
                        (typeof pt.win_lp === "number" && pt.win_lp > 0) ||
                        (typeof pt.sum === "number" && pt.sum !== 0) ||
                        (typeof pt.sum_native === "number" && pt.sum_native !== 0) ||
                        (typeof pt.total_fee_native === "number" && pt.total_fee_native !== 0))
                ) {
                    dates.add(new Date(ts).toISOString().slice(0, 10));
                }
            }
        }
    }

    return Array.from(dates).sort();
}

export type WalletActivityStatus =
    | "CONFIRMED_ACTIVE"
    | "NO_ACTIVITY"
    | "UNKNOWN_ACTIVITY";

export function getWalletActivityStatus(
    wallet: Wallet,
    timeframe: "7d" | "30d" | "all",
    referenceDate: string,
): WalletActivityStatus {
    const dates = extractWalletActivityDates(wallet);
    if (dates.length === 0) {
        return "UNKNOWN_ACTIVITY";
    }

    if (timeframe === "all") {
        return "CONFIRMED_ACTIVE";
    }

    const start7d = shiftUtcDays(referenceDate, -6);
    const start30d = shiftUtcDays(referenceDate, -29);
    const startDate = timeframe === "7d" ? start7d : start30d;

    const hasActivity = dates.some((d) => d >= startDate && d <= referenceDate);
    return hasActivity ? "CONFIRMED_ACTIVE" : "NO_ACTIVITY";
}

export function isWalletTimeframeEligible(
    wallet: Wallet,
    timeframe: "7d" | "30d" | "all",
    referenceDate: string,
): boolean {
    if (timeframe === "all") {
        return true;
    }
    return getWalletActivityStatus(wallet, timeframe, referenceDate) === "CONFIRMED_ACTIVE";
}

export function countUnknownActivityWallets(wallets: Wallet[]): number {
    return wallets.filter((w) => extractWalletActivityDates(w).length === 0).length;
}

export function walletEffectiveLastActivity(wallet: Wallet): string | null {
    if (typeof wallet.last_activity === "string" && wallet.last_activity.trim()) {
        const ts = Date.parse(wallet.last_activity);
        if (Number.isFinite(ts) && ts > 0) {
            return wallet.last_activity;
        }
    }
    const dates = extractWalletActivityDates(wallet);
    if (dates.length > 0) {
        return `${dates[dates.length - 1]}T00:00:00.000Z`;
    }
    return null;
}

export function walletEffectiveFirstActivity(wallet: Wallet): string | null {
    if (typeof wallet.first_activity === "string" && wallet.first_activity.trim()) {
        const ts = Date.parse(wallet.first_activity);
        if (Number.isFinite(ts) && ts > 0) {
            return wallet.first_activity;
        }
    }
    const dates = extractWalletActivityDates(wallet);
    if (dates.length > 0) {
        return `${dates[0]}T00:00:00.000Z`;
    }
    return null;
}

export type WalletSortKey =
    | "wallet"
    | "shortlist"
    | "quality"
    | "risk"
    | "confidence"
    | "style"
    | "pnl7"
    | "win"
    | "winDays"
    | "loseDays"
    | "pnl30"
    | "pnlAll"
    | "positions"
    | "walletAge"
    | "age"
    | "ev"
    | "invested"
    | "monthly"
    | "fees"
    | "last";

export type SortDirection = "asc" | "desc";
export type WalletTimeframe = "7d" | "30d" | "all";

export const WALLET_TABLE_PAGE_SIZE = 25;

export function walletTimeframePnl(
    wallet: Wallet,
    timeframe: WalletTimeframe,
): number | null {
    if (timeframe === "30d") {
        return walletPnl30d(wallet);
    }
    if (timeframe === "all") {
        return walletAllTimePnl(wallet);
    }
    return walletPnl7d(wallet);
}

export function defaultSortKeyForTimeframe(
    timeframe: WalletTimeframe,
): WalletSortKey {
    if (timeframe === "30d") return "pnl30";
    if (timeframe === "all") return "pnlAll";
    return "pnl7";
}

export function resolveSortKeyForTimeframeChange(
    currentSortKey: WalletSortKey,
    nextTimeframe: WalletTimeframe,
): WalletSortKey {
    if (
        currentSortKey === "pnl7" ||
        currentSortKey === "pnl30" ||
        currentSortKey === "pnlAll"
    ) {
        return defaultSortKeyForTimeframe(nextTimeframe);
    }
    return currentSortKey;
}

export function walletPositions(
    wallet: Wallet,
): number | null {
    return derivedOrFallback(
        toFiniteNumber(wallet.total_lp),
        toFiniteNumber(wallet.fabriq?.stats?.totalPositions),
    );
}
export function walletTimeframeLp(
    wallet: Wallet,
    timeframe: "7d" | "30d" | "all" | string,
): number | null {
    switch (timeframe) {
        case "7d":
            return toFiniteNumber(wallet.total_lp_7d);
        case "30d":
            return toFiniteNumber(wallet.total_lp_30d);
        case "all":
            return walletPositions(wallet);
        default:
            return toFiniteNumber(wallet.total_lp_7d);
    }
}


export function walletAgeMs(
    wallet: Wallet,
    nowMs: number = Date.now(),
): number | null {
    const firstIso = walletEffectiveFirstActivity(wallet);
    if (!firstIso) return null;
    const ts = Date.parse(firstIso);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return Math.max(0, nowMs - ts);
}

export function walletLastActivityTimestamp(
    wallet: Wallet,
): number | null {
    const lastIso = walletEffectiveLastActivity(wallet);
    if (!lastIso) return null;
    const ts = Date.parse(lastIso);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
}

export function walletSortValue(
    wallet: Wallet,
    key: WalletSortKey,
    nowMs: number = Date.now(),
): string | number | null {
    switch (key) {
        case "wallet":
            return typeof wallet.owner === "string" && wallet.owner.trim() !== ""
                ? wallet.owner.trim()
                : null;
        case "shortlist":
            if (typeof wallet.intelligenceV1?.shortlisted !== "boolean") {
                return null;
            }
            return wallet.intelligenceV1.shortlisted ? 1 : 0;
        case "quality":
            return toFiniteNumber(wallet.intelligenceV1?.qualityScore);
        case "risk":
            return toFiniteNumber(wallet.intelligenceV1?.riskScore);
        case "confidence":
            return toFiniteNumber(wallet.intelligenceV1?.confidenceScore);
        case "style": {
            const raw = wallet.intelligenceV1?.style;
            return typeof raw === "string" && raw.trim() !== ""
                ? raw.trim().toUpperCase()
                : null;
        }
        case "pnl7":
            return walletPnl7d(wallet);
        case "win":
            return walletWinRatePercent(wallet);
        case "winDays":
            return walletWinDays(wallet);
        case "loseDays":
            return walletLoseDays(wallet);
        case "pnl30":
            return walletPnl30d(wallet);
        case "pnlAll":
            return walletAllTimePnl(wallet);
        case "positions":
            return walletPositions(wallet);
        case "walletAge":
            return walletAgeMs(wallet, nowMs);
        case "age":
            return toFiniteNumber(wallet.avg_age_hour);
        case "ev":
            return toFiniteNumber(wallet.expected_value_native);
        case "invested":
            return toFiniteNumber(wallet.avg_inflow_native);
        case "monthly":
            return walletMonthlyPnl(wallet);
        case "fees":
            return toFiniteNumber(wallet.total_fee_native);
        case "last":
            return walletLastActivityTimestamp(wallet);
    }
}

export function compareNullableNumbers(
    a: number | null | undefined,
    b: number | null | undefined,
    dir: SortDirection = "desc",
): number {
    const na = toFiniteNumber(a);
    const nb = toFiniteNumber(b);

    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;

    const valA = Object.is(na, -0) ? 0 : na;
    const valB = Object.is(nb, -0) ? 0 : nb;

    if (valA === valB) return 0;
    return dir === "asc" ? valA - valB : valB - valA;
}

export function compareNullableStrings(
    a: string | null | undefined,
    b: string | null | undefined,
    dir: SortDirection = "asc",
): number {
    const sa = typeof a === "string" && a.trim() !== "" ? a.trim() : null;
    const sb = typeof b === "string" && b.trim() !== "" ? b.trim() : null;

    if (sa === null && sb === null) return 0;
    if (sa === null) return 1;
    if (sb === null) return -1;

    if (sa === sb) return 0;
    return dir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
}

export function compareWalletMetricValues(
    a: Wallet,
    b: Wallet,
    sortKey: WalletSortKey,
    sortDir: SortDirection = "desc",
    nowMs: number = Date.now(),
): number {
    const av = walletSortValue(a, sortKey, nowMs);
    const bv = walletSortValue(b, sortKey, nowMs);

    if (sortKey === "wallet" || sortKey === "style") {
        return compareNullableStrings(
            av as string | null,
            bv as string | null,
            sortDir,
        );
    }

    return compareNullableNumbers(
        av as number | null,
        bv as number | null,
        sortDir,
    );
}

export function compareWallets(
    a: Wallet,
    b: Wallet,
    sortKey: WalletSortKey,
    sortDir: SortDirection = "desc",
    nowMs: number = Date.now(),
): number {
    const primary = compareWalletMetricValues(a, b, sortKey, sortDir, nowMs);
    if (primary !== 0) return primary;

    const ownerA = typeof a.owner === "string" ? a.owner : "";
    const ownerB = typeof b.owner === "string" ? b.owner : "";
    if (ownerA === ownerB) return 0;
    return ownerA.localeCompare(ownerB);
}

export function sortWallets(
    wallets: readonly Wallet[],
    sortKey: WalletSortKey = "pnl7",
    sortDir: SortDirection = "desc",
    nowMs: number = Date.now(),
): Wallet[] {
    return [...wallets].sort((a, b) =>
        compareWallets(a, b, sortKey, sortDir, nowMs),
    );
}

export function paginateWallets<T>(
    items: readonly T[],
    page: number,
    pageSize: number = WALLET_TABLE_PAGE_SIZE,
): {
    rows: T[];
    safePage: number;
    pageCount: number;
} {
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
    const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount);
    const start = (safePage - 1) * safePageSize;
    return {
        rows: items.slice(start, start + safePageSize),
        safePage,
        pageCount,
    };
}

export type ChartTimeframe = "7D" | "30D" | "ALL" | "7d" | "30d" | "all";

export type NormalizedDailyPnlPoint = {
    date: string;
    pnl: number;
};

export type CumulativePnlPoint = {
    date: string;
    dailyPnl: number;
    cumulativePnl: number;
};

function parsePointDate(raw: unknown): string | null {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
    const ts = Date.parse(raw);
    if (Number.isFinite(ts) && ts > 0) {
        return new Date(ts).toISOString().slice(0, 10);
    }
    return null;
}

export function extractNormalizedDailyPnl(
    source: Wallet | PnlPoint[] | unknown[] | undefined | null,
    currency: "SOL" | "USD" = "SOL",
): NormalizedDailyPnlPoint[] {
    if (!source) return [];

    let rawItems: unknown[] = [];
    if (Array.isArray(source)) {
        rawItems = source;
    } else if (typeof source === "object" && source !== null) {
        const w = source as Wallet;
        if (Array.isArray(w.pnl_chart) && w.pnl_chart.length > 0) {
            rawItems = w.pnl_chart;
        } else if (Array.isArray(w.fabriqDerived?.daily) && w.fabriqDerived.daily.length > 0) {
            rawItems = w.fabriqDerived.daily;
        }
    }

    const byDate = new Map<string, NormalizedDailyPnlPoint>();

    for (const item of rawItems) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;

        const date = parsePointDate(record.close_day ?? record.date);
        if (!date) continue;

        let rawValue: unknown;
        if (currency === "SOL") {
            rawValue = record.sum_native !== undefined ? record.sum_native : record.pnlSol;
        } else {
            rawValue = record.sum !== undefined ? record.sum : record.pnlUsd;
        }

        const pnl = toFiniteNumber(rawValue);
        if (pnl === null) continue;

        byDate.set(date, { date, pnl });
    }

    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function filterDailyPnlByTimeframe(
    points: readonly NormalizedDailyPnlPoint[],
    timeframe: ChartTimeframe = "30D",
    referenceDate?: string,
): NormalizedDailyPnlPoint[] {
    const tf = String(timeframe).toUpperCase();
    const ref = (referenceDate && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate))
        ? referenceDate
        : resolveReferenceDate(null);

    const start7d = shiftUtcDays(ref, -6);
    const start30d = shiftUtcDays(ref, -29);

    return points
        .filter((point) => {
            if (!point.date || point.date > ref) return false;
            if (tf === "7D") {
                return point.date >= start7d && point.date <= ref;
            }
            if (tf === "30D") {
                return point.date >= start30d && point.date <= ref;
            }
            return point.date <= ref;
        })
        .sort((a, b) => a.date.localeCompare(b.date));
}

export function computePeriodCumulativePnl(
    dailyPoints: readonly NormalizedDailyPnlPoint[],
): CumulativePnlPoint[] {
    let cumulative = 0;
    return dailyPoints.map((point) => {
        cumulative += point.pnl;
        return {
            date: point.date,
            dailyPnl: point.pnl,
            cumulativePnl: cumulative,
        };
    });
}