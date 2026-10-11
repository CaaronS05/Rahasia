import type { Wallet } from "../types";

const DAY_MS =
    24 * 60 * 60 * 1000;

function derivedOrFallback(
    derived: number | null | undefined,
    fallback: number | null | undefined,
): number {
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

    return 0;
}

export function walletPnl7d(
    wallet: Wallet,
) {
    return derivedOrFallback(
        wallet.fabriqDerived?.pnl7dSol,
        wallet.total_pnl_native_7d,
    );
}

export function walletPnl30d(
    wallet: Wallet,
) {
    return derivedOrFallback(
        wallet.fabriqDerived?.pnl30dSol,
        wallet.total_pnl_native_30d,
    );
}

export function walletAllTimePnl(
    wallet: Wallet,
) {
    return derivedOrFallback(
        wallet.fabriqDerived?.allTimePnlSol,
        wallet.total_pnl_native,
    );
}

export function walletMonthlyPnl(
    wallet: Wallet,
) {
    return derivedOrFallback(
        wallet.fabriqDerived?.monthlyPnlSol,
        wallet.avg_monthly_pnl_native,
    );
}

export function walletWinRatePercent(
    wallet: Wallet,
) {
    const positionWin =
        wallet.fabriq?.stats?.positionWinUsd ??
        wallet.fabriq?.stats?.positionWinSol;

    const derived =
        Number(
            positionWin?.percentage,
        );

    if (
        Number.isFinite(derived)
    ) {
        return derived;
    }

    return (
        (wallet.win_rate_native ?? 0) *
        100
    );
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