import fs from "node:fs";

const MASTER =
    "./data/master/wallets-master.json";

const data =
    JSON.parse(
        fs.readFileSync(
            MASTER,
            "utf8",
        ),
    );

const wallets =
    Array.isArray(data.wallets)
        ? data.wallets
        : [];

function number(value) {
    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function chartPoints(wallet) {
    if (!Array.isArray(wallet.pnl_chart)) {
        return [];
    }

    return wallet.pnl_chart
        .map((point) => ({
            date: Date.parse(
                point?.close_day ?? "",
            ),

            pnl:
                number(point?.sum_native),
        }))
        .filter(
            (point) =>
                Number.isFinite(point.date) &&
                point.pnl !== null,
        )
        .sort(
            (a, b) => a.date - b.date,
        );
}

function sum(values) {
    return values.reduce(
        (total, value) =>
            total + value,
        0,
    );
}

function chartWindow(
    points,
    days,
    referenceTime,
) {
    const start =
        referenceTime -
        days * 24 * 60 * 60 * 1000;

    return sum(
        points
            .filter(
                (point) =>
                    point.date >= start &&
                    point.date <= referenceTime,
            )
            .map(
                (point) => point.pnl,
            ),
    );
}

function difference(a, b) {
    if (
        a === null ||
        b === null
    ) {
        return null;
    }

    return Math.abs(a - b);
}

function relativeDifference(
    a,
    b,
) {
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

const now =
    Date.now();

const results =
    wallets.map((wallet) => {
        const points =
            chartPoints(wallet);

        const lp7 =
            number(
                wallet.total_pnl_native_7d,
            );

        const lp30 =
            number(
                wallet.total_pnl_native_30d,
            );

        const lpAll =
            number(
                wallet.total_pnl_native,
            );

        const chart7 =
            chartWindow(
                points,
                7,
                now,
            );

        const chart30 =
            chartWindow(
                points,
                30,
                now,
            );

        const chartAll =
            sum(
                points.map(
                    (point) => point.pnl,
                ),
            );

        const fabriqAll =
            number(
                wallet?.fabriq
                    ?.stats
                    ?.netPnlSol,
            );

        return {
            owner:
                wallet.owner,

            points:
                points.length,

            lp7,
            chart7,

            lp30,
            chart30,

            lpAll,
            chartAll,

            fabriqAll,

            diff7:
                relativeDifference(
                    lp7,
                    chart7,
                ),

            diff30:
                relativeDifference(
                    lp30,
                    chart30,
                ),

            diffAllChart:
                relativeDifference(
                    lpAll,
                    chartAll,
                ),

            diffAllFabriq:
                relativeDifference(
                    lpAll,
                    fabriqAll,
                ),
        };
    });

function count(predicate) {
    return results.filter(
        predicate,
    ).length;
}

function coverage(
    name,
    accessor,
) {
    const available =
        count(
            (row) =>
                accessor(row) !== null,
        );

    console.log(
        `${name.padEnd(22)} ${available}/${results.length}`,
    );
}

function compare(
    label,
    accessor,
) {
    const comparable =
        results.filter(
            (row) =>
                accessor(row) !== null,
        );

    const within5 =
        comparable.filter(
            (row) =>
                accessor(row) <= 0.05,
        ).length;

    const within20 =
        comparable.filter(
            (row) =>
                accessor(row) <= 0.20,
        ).length;

    const over50 =
        comparable.filter(
            (row) =>
                accessor(row) > 0.50,
        ).length;

    console.log(`\n${label}`);
    console.log(
        "Comparable :",
        comparable.length,
    );
    console.log(
        "<= 5%      :",
        within5,
    );
    console.log(
        "<= 20%     :",
        within20,
    );
    console.log(
        "> 50%      :",
        over50,
    );
}

console.log(
    "\n========================================",
);
console.log(
    "PNL DATA AUDIT",
);
console.log(
    "========================================",
);

console.log(
    "\nTotal wallets:",
    results.length,
);

console.log(
    "\nPNL CHART COVERAGE",
);

console.log(
    "0 points     :",
    count(
        (row) =>
            row.points === 0,
    ),
);

console.log(
    "1 point      :",
    count(
        (row) =>
            row.points === 1,
    ),
);

console.log(
    "2-6 points   :",
    count(
        (row) =>
            row.points >= 2 &&
            row.points <= 6,
    ),
);

console.log(
    "7-29 points  :",
    count(
        (row) =>
            row.points >= 7 &&
            row.points <= 29,
    ),
);

console.log(
    "30+ points   :",
    count(
        (row) =>
            row.points >= 30,
    ),
);

console.log(
    "\nFIELD COVERAGE",
);

coverage(
    "LP Agent 7D",
    (row) => row.lp7,
);

coverage(
    "LP Agent 30D",
    (row) => row.lp30,
);

coverage(
    "LP Agent All-Time",
    (row) => row.lpAll,
);

coverage(
    "Fabriq Net PnL SOL",
    (row) => row.fabriqAll,
);

compare(
    "7D: LP Agent vs pnl_chart",
    (row) => row.diff7,
);

compare(
    "30D: LP Agent vs pnl_chart",
    (row) => row.diff30,
);

compare(
    "ALL: LP Agent vs pnl_chart",
    (row) =>
        row.points > 0
            ? row.diffAllChart
            : null,
);

compare(
    "ALL: LP Agent vs Fabriq",
    (row) => row.diffAllFabriq,
);

console.log(
    "\nTOP 10 ALL-TIME DISCREPANCIES",
);

results
    .filter(
        (row) =>
            row.diffAllFabriq !== null,
    )
    .sort(
        (a, b) =>
            b.diffAllFabriq -
            a.diffAllFabriq,
    )
    .slice(0, 10)
    .forEach(
        (row, index) => {
            console.log(
                `\n${index + 1}. ${row.owner}`,
            );

            console.log(
                "LP Agent All:",
                row.lpAll,
            );

            console.log(
                "Fabriq All  :",
                row.fabriqAll,
            );

            console.log(
                "Chart All   :",
                row.chartAll,
            );

            console.log(
                "Chart Points:",
                row.points,
            );

            console.log(
                "Difference  :",
                `${(
                    row.diffAllFabriq *
                    100
                ).toFixed(2)}%`,
            );
        },
    );