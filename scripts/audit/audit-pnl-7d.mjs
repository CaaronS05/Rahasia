import fs from "node:fs";

const MASTER =
    "./data/master/wallets-master.json";

const data = JSON.parse(
    fs.readFileSync(MASTER, "utf8"),
);

const wallets =
    Array.isArray(data.wallets)
        ? data.wallets
        : [];

// ========================================
// TIME
// ========================================

// Audit memakai tanggal Jakarta.
// Current audit date: 2026-09-21.
const AUDIT_END_DATE =
    "2026-09-21";

function dateToUtcDay(dateString) {
    return Date.parse(
        `${dateString}T00:00:00.000Z`,
    );
}

const endTime =
    dateToUtcDay(AUDIT_END_DATE);

// Inclusive:
// 15,16,17,18,19,20,21 Sep = 7 days.
const startTime =
    endTime -
    6 * 24 * 60 * 60 * 1000;

// ========================================
// HELPERS
// ========================================

function num(value) {
    const parsed =
        Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function relativeDiff(a, b) {
    if (
        a === null ||
        b === null
    ) {
        return null;
    }

    const base =
        Math.max(
            Math.abs(a),
            Math.abs(b),
            0.000001,
        );

    return (
        Math.abs(a - b) /
        base
    );
}

function sign(value) {
    if (value > 0.000001)
        return 1;

    if (value < -0.000001)
        return -1;

    return 0;
}

// ========================================
// FABRIQ 7D
// ========================================

function getFabriq7d(wallet) {
    const calendar =
        wallet?.fabriq?.calendar;

    if (
        !calendar ||
        typeof calendar !== "object" ||
        Array.isArray(calendar)
    ) {
        return {
            available: false,
            pnl: null,
            activeDays: 0,
        };
    }

    let pnl = 0;
    let activeDays = 0;

    for (
        const [date, entry]
        of Object.entries(calendar)
    ) {
        const time =
            dateToUtcDay(date);

        if (
            !Number.isFinite(time) ||
            time < startTime ||
            time > endTime
        ) {
            continue;
        }

        const dailyPnl =
            num(entry?.pnlSol);

        if (dailyPnl === null) {
            continue;
        }

        pnl += dailyPnl;
        activeDays++;
    }

    return {
        available: true,
        pnl,
        activeDays,
    };
}

// ========================================
// LP AGENT CHART 7D
// ========================================

function getChart7d(wallet) {
    if (
        !Array.isArray(wallet.pnl_chart)
    ) {
        return {
            available: false,
            pnl: null,
            points: 0,
        };
    }

    let pnl = 0;
    let points = 0;

    for (
        const point
        of wallet.pnl_chart
    ) {
        const date =
            point?.close_day;

        if (!date)
            continue;

        const time =
            Date.parse(date);

        if (
            !Number.isFinite(time) ||
            time < startTime ||
            time >
            endTime +
            24 * 60 * 60 * 1000 -
            1
        ) {
            continue;
        }

        const dailyPnl =
            num(point?.sum_native);

        if (dailyPnl === null)
            continue;

        pnl += dailyPnl;
        points++;
    }

    return {
        available:
            points > 0,

        pnl:
            points > 0
                ? pnl
                : null,

        points,
    };
}

// ========================================
// BUILD RESULTS
// ========================================

const results =
    wallets.map(
        (wallet) => {
            const lpAgent =
                num(
                    wallet
                        .total_pnl_native_7d,
                );

            const fabriq =
                getFabriq7d(wallet);

            const chart =
                getChart7d(wallet);

            return {
                owner:
                    wallet.owner,

                lpAgent,

                fabriq7d:
                    fabriq.pnl,

                fabriqDays:
                    fabriq.activeDays,

                chart7d:
                    chart.pnl,

                chartPoints:
                    chart.points,

                diffFabriq:
                    fabriq.available
                        ? relativeDiff(
                            lpAgent,
                            fabriq.pnl,
                        )
                        : null,

                diffChart:
                    chart.available
                        ? relativeDiff(
                            lpAgent,
                            chart.pnl,
                        )
                        : null,

                signFabriq:
                    fabriq.available &&
                        lpAgent !== null
                        ? sign(lpAgent) ===
                        sign(fabriq.pnl)
                        : null,

                signChart:
                    chart.available &&
                        lpAgent !== null
                        ? sign(lpAgent) ===
                        sign(chart.pnl)
                        : null,
            };
        },
    );

// ========================================
// REPORT
// ========================================

function compare(
    label,
    diffKey,
    signKey,
) {
    const rows =
        results.filter(
            (row) =>
                row[diffKey] !== null,
        );

    const within1 =
        rows.filter(
            (row) =>
                row[diffKey] <= 0.01,
        ).length;

    const within5 =
        rows.filter(
            (row) =>
                row[diffKey] <= 0.05,
        ).length;

    const within20 =
        rows.filter(
            (row) =>
                row[diffKey] <= 0.20,
        ).length;

    const over50 =
        rows.filter(
            (row) =>
                row[diffKey] > 0.50,
        ).length;

    const signMismatch =
        rows.filter(
            (row) =>
                row[signKey] === false,
        ).length;

    console.log(
        `\n${label}`,
    );

    console.log(
        "Comparable    :",
        rows.length,
    );

    console.log(
        "<= 1%         :",
        within1,
    );

    console.log(
        "<= 5%         :",
        within5,
    );

    console.log(
        "<= 20%        :",
        within20,
    );

    console.log(
        "> 50%         :",
        over50,
    );

    console.log(
        "Sign mismatch :",
        signMismatch,
    );
}

console.log(
    "\n========================================",
);

console.log(
    "PNL 7D AUDIT",
);

console.log(
    "========================================",
);

console.log(
    "Period:",
    "2026-09-15 → 2026-09-21",
);

console.log(
    "Wallets:",
    results.length,
);

console.log(
    "\nFABRIQ CALENDAR COVERAGE",
);

console.log(
    "Calendar available:",
    results.filter(
        (row) =>
            row.fabriq7d !== null,
    ).length,
);

for (
    const days
    of [0, 1, 2, 3, 4, 5, 6, 7]
) {
    console.log(
        `${days} active days:`.padEnd(16),
        results.filter(
            (row) =>
                row.fabriqDays === days,
        ).length,
    );
}

console.log(
    "\nLP AGENT CHART COVERAGE (7D)",
);

console.log(
    "No points:",
    results.filter(
        (row) =>
            row.chartPoints === 0,
    ).length,
);

console.log(
    "1 point:",
    results.filter(
        (row) =>
            row.chartPoints === 1,
    ).length,
);

console.log(
    "2+ points:",
    results.filter(
        (row) =>
            row.chartPoints >= 2,
    ).length,
);

compare(
    "LP Agent 7D vs Fabriq Calendar 7D",
    "diffFabriq",
    "signFabriq",
);

compare(
    "LP Agent 7D vs LP Agent pnl_chart 7D",
    "diffChart",
    "signChart",
);

// ========================================
// DISCREPANCIES
// ========================================

console.log(
    "\nTOP 15 LP AGENT vs FABRIQ DISCREPANCIES",
);

results
    .filter(
        (row) =>
            row.diffFabriq !== null,
    )
    .sort(
        (a, b) =>
            b.diffFabriq -
            a.diffFabriq,
    )
    .slice(0, 15)
    .forEach(
        (row, index) => {
            console.log(
                `\n${index + 1}. ${row.owner}`,
            );

            console.log(
                "LP Agent 7D :",
                row.lpAgent,
            );

            console.log(
                "Fabriq 7D   :",
                row.fabriq7d,
            );

            console.log(
                "Fabriq Days :",
                row.fabriqDays,
            );

            console.log(
                "Chart 7D    :",
                row.chart7d,
            );

            console.log(
                "Chart Points:",
                row.chartPoints,
            );

            console.log(
                "Difference  :",
                `${(
                    row.diffFabriq *
                    100
                ).toFixed(2)}%`,
            );

            console.log(
                "Same sign   :",
                row.signFabriq,
            );
        },
    );