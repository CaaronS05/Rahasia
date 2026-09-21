import fs from "node:fs";

const data = JSON.parse(
    fs.readFileSync(
        "./data/master/wallets-master.json",
        "utf8",
    ),
);

const wallets = data.wallets ?? [];

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

const rows = wallets.map((w) => {
    const chart =
        Array.isArray(w.pnl_chart)
            ? w.pnl_chart
            : [];

    const firstChart =
        chart.length
            ? chart[0]?.close_day
            : null;

    const lastChart =
        chart.length
            ? chart[chart.length - 1]?.close_day
            : null;

    const fab =
        w?.fabriq?.stats ?? {};

    const lpPnl =
        num(w.total_pnl_native);

    const fabPnl =
        num(fab.netPnlSol);

    return {
        owner: w.owner,

        firstActivity:
            w.first_activity,

        lastActivity:
            w.last_activity,

        chartPoints:
            chart.length,

        firstChart,
        lastChart,

        lpPositions:
            num(w.total_lp),

        fabPositions:
            num(fab.totalPositions),

        lpInflow:
            num(w.total_inflow_native),

        fabDeposits:
            num(fab.totalDepositsSol),

        lpOutflow:
            num(w.total_outflow_native),

        fabWithdrawals:
            num(fab.totalWithdrawalsSol),

        lpFees:
            num(w.total_fee_native),

        fabFees:
            num(fab.totalFeesSol),

        lpPnl,
        fabPnl,

        pnlDiff:
            lpPnl !== null &&
                fabPnl !== null
                ? Math.abs(
                    fabPnl - lpPnl,
                )
                : 0,
    };
});

rows
    .sort(
        (a, b) =>
            b.pnlDiff -
            a.pnlDiff,
    )
    .slice(0, 20)
    .forEach((r, i) => {
        console.log(
            `\n==============================`,
        );

        console.log(
            `${i + 1}. ${r.owner}`,
        );

        console.log(
            "First activity :",
            r.firstActivity,
        );

        console.log(
            "Last activity  :",
            r.lastActivity,
        );

        console.log(
            "Chart range    :",
            r.firstChart,
            "→",
            r.lastChart,
        );

        console.log(
            "Chart points   :",
            r.chartPoints,
        );

        console.log(
            "Positions      :",
            r.lpPositions,
            "/",
            r.fabPositions,
        );

        console.log(
            "Inflow/Deposit :",
            r.lpInflow,
            "/",
            r.fabDeposits,
        );

        console.log(
            "Out/Withdraw   :",
            r.lpOutflow,
            "/",
            r.fabWithdrawals,
        );

        console.log(
            "Fees           :",
            r.lpFees,
            "/",
            r.fabFees,
        );

        console.log(
            "PnL            :",
            r.lpPnl,
            "/",
            r.fabPnl,
        );
    });