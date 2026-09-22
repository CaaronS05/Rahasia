import type { Wallet } from "../types";

const DAY_MS =
    24 * 60 * 60 * 1000;

function derivedOrFallback(
    derived: number | null | undefined,
    fallback: number,
) {
    if (
        typeof derived === "number" &&
        Number.isFinite(derived)
    ) {
        return derived;
    }

    return fallback;
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
        wallet.win_rate_native *
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