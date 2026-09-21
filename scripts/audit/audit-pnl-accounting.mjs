import fs from "node:fs";

const data = JSON.parse(
    fs.readFileSync(
        "./data/master/wallets-master.json",
        "utf8",
    ),
);

const wallets =
    Array.isArray(data.wallets)
        ? data.wallets
        : [];

function num(value) {
    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function absDiff(a, b) {
    if (a === null || b === null) {
        return null;
    }

    return Math.abs(a - b);
}

const rows = wallets.map((wallet) => {
    // LP Agent
    const lpPnl =
        num(wallet.total_pnl_native);

    const lpIn =
        num(wallet.total_inflow_native);

    const lpOut =
        num(wallet.total_outflow_native);

    const lpFees =
        num(wallet.total_fee_native);

    const lpCashflow =
        lpIn !== null &&
            lpOut !== null &&
            lpFees !== null
            ? lpOut + lpFees - lpIn
            : null;

    // Fabriq
    const stats =
        wallet?.fabriq?.stats ?? {};

    const fabPnl =
        num(stats.netPnlSol);

    const fabDeposits =
        num(stats.totalDepositsSol);

    const fabWithdrawals =
        num(stats.totalWithdrawalsSol);

    const fabFees =
        num(stats.totalFeesSol);

    const fabCashflow =
        fabDeposits !== null &&
            fabWithdrawals !== null &&
            fabFees !== null
            ? fabWithdrawals +
            fabFees -
            fabDeposits
            : null;

    return {
        owner: wallet.owner,

        lpPnl,
        lpCashflow,
        lpResidual:
            absDiff(
                lpPnl,
                lpCashflow,
            ),

        fabPnl,
        fabCashflow,
        fabResidual:
            absDiff(
                fabPnl,
                fabCashflow,
            ),

        depositDiff:
            fabDeposits !== null &&
                lpIn !== null
                ? fabDeposits - lpIn
                : null,

        withdrawalDiff:
            fabWithdrawals !== null &&
                lpOut !== null
                ? fabWithdrawals - lpOut
                : null,

        feeDiff:
            fabFees !== null &&
                lpFees !== null
                ? fabFees - lpFees
                : null,
    };
});

function residualReport(
    label,
    key,
) {
    const valid = rows.filter(
        (row) =>
            row[key] !== null,
    );

    const exact =
        valid.filter(
            (row) =>
                row[key] <= 0.000001,
        ).length;

    const tiny =
        valid.filter(
            (row) =>
                row[key] <= 0.01,
        ).length;

    const medium =
        valid.filter(
            (row) =>
                row[key] <= 0.1,
        ).length;

    console.log(`\n${label}`);
    console.log(
        "Comparable :",
        valid.length,
    );
    console.log(
        "<= 0.000001 SOL :",
        exact,
    );
    console.log(
        "<= 0.01 SOL     :",
        tiny,
    );
    console.log(
        "<= 0.10 SOL     :",
        medium,
    );
}

console.log(
    "\n========================================",
);

console.log(
    "PNL ACCOUNTING AUDIT",
);

console.log(
    "========================================",
);

console.log(
    "Wallets:",
    rows.length,
);

residualReport(
    "FABRIQ: netPnlSol vs withdrawals + fees - deposits",
    "fabResidual",
);

residualReport(
    "LP AGENT: totalPnl vs outflow + fees - inflow",
    "lpResidual",
);

const depositDifferent =
    rows.filter(
        (row) =>
            row.depositDiff !== null &&
            Math.abs(row.depositDiff) >
            0.01,
    );

const withdrawalDifferent =
    rows.filter(
        (row) =>
            row.withdrawalDiff !== null &&
            Math.abs(
                row.withdrawalDiff,
            ) > 0.01,
    );

const feeDifferent =
    rows.filter(
        (row) =>
            row.feeDiff !== null &&
            Math.abs(row.feeDiff) >
            0.01,
    );

console.log(
    "\nPROVIDER FLOW DIFFERENCES (> 0.01 SOL)",
);

console.log(
    "Deposits/Inflow :",
    depositDifferent.length,
);

console.log(
    "Withdrawals     :",
    withdrawalDifferent.length,
);

console.log(
    "Fees            :",
    feeDifferent.length,
);

console.log(
    "\nTOP 15 DEPOSIT DIFFERENCES",
);

rows
    .filter(
        (row) =>
            row.depositDiff !== null,
    )
    .sort(
        (a, b) =>
            Math.abs(b.depositDiff) -
            Math.abs(a.depositDiff),
    )
    .slice(0, 15)
    .forEach(
        (row, index) => {
            console.log(
                `${index + 1}.`,
                row.owner,
            );

            console.log(
                "Deposit diff:",
                row.depositDiff,
            );

            console.log(
                "Withdrawal diff:",
                row.withdrawalDiff,
            );

            console.log(
                "Fee diff:",
                row.feeDiff,
            );

            console.log(
                "LP PnL:",
                row.lpPnl,
            );

            console.log(
                "Fabriq PnL:",
                row.fabPnl,
            );

            console.log("");
        },
    );