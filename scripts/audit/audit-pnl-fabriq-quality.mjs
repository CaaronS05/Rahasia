import fs from "node:fs";

const MASTER =
    "./data/master/wallets-master.json";

const data = JSON.parse(
    fs.readFileSync(
        MASTER,
        "utf8",
    ),
);

const wallets =
    Array.isArray(data.wallets)
        ? data.wallets
        : [];

// ========================================
// HELPERS
// ========================================

function num(value) {
    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function safeRatio(
    numerator,
    denominator,
) {
    if (
        numerator === null ||
        denominator === null ||
        denominator === 0
    ) {
        return null;
    }

    return numerator / denominator;
}

function relativeDiff(a, b) {
    if (
        a === null ||
        b === null
    ) {
        return null;
    }

    const base = Math.max(
        Math.abs(a),
        Math.abs(b),
        0.000001,
    );

    return (
        Math.abs(a - b) /
        base
    );
}

function pct(value) {
    if (value === null) {
        return "—";
    }

    return `${(
        value * 100
    ).toFixed(2)}%`;
}

function sol(value) {
    if (value === null) {
        return "—";
    }

    return Number(value)
        .toLocaleString(
            "en-US",
            {
                maximumFractionDigits: 4,
            },
        );
}

// ========================================
// BUILD DATASET
// ========================================

const rows =
    wallets.map((wallet) => {
        const stats =
            wallet?.fabriq?.stats ?? {};

        const lpPositions =
            num(wallet.total_lp);

        const fabPositions =
            num(stats.totalPositions);

        const lpPnl =
            num(
                wallet.total_pnl_native,
            );

        const fabPnl =
            num(stats.netPnlSol);

        const deposits =
            num(stats.totalDepositsSol);

        const withdrawals =
            num(stats.totalWithdrawalsSol);

        const fees =
            num(stats.totalFeesSol);

        const positionCoverage =
            safeRatio(
                lpPositions,
                fabPositions,
            );

        const withdrawalDepositRatio =
            safeRatio(
                withdrawals,
                deposits,
            );

        const pnlDepositRatio =
            safeRatio(
                fabPnl,
                deposits,
            );

        const absPnlDepositRatio =
            safeRatio(
                Math.abs(fabPnl ?? 0),
                deposits,
            );

        const pnlDifference =
            relativeDiff(
                lpPnl,
                fabPnl,
            );

        return {
            owner:
                wallet.owner,

            firstActivity:
                wallet.first_activity,

            lastActivity:
                wallet.last_activity,

            lpPositions,
            fabPositions,

            positionCoverage,

            lpPnl,
            fabPnl,

            deposits,
            withdrawals,
            fees,

            withdrawalDepositRatio,

            pnlDepositRatio,

            absPnlDepositRatio,

            pnlDifference,
        };
    });

// ========================================
// FILTER HELPERS
// ========================================

function count(predicate) {
    return rows.filter(
        predicate,
    ).length;
}

function section(title) {
    console.log(
        `\n${"=".repeat(60)}`,
    );

    console.log(title);

    console.log(
        "=".repeat(60),
    );
}

// ========================================
// BASIC COVERAGE
// ========================================

section(
    "FABRIQ PNL QUALITY AUDIT",
);

console.log(
    "Total wallets:",
    rows.length,
);

console.log(
    "\nDATA COVERAGE",
);

console.log(
    "Fabriq PnL:",
    count(
        (r) =>
            r.fabPnl !== null,
    ),
);

console.log(
    "Deposits:",
    count(
        (r) =>
            r.deposits !== null,
    ),
);

console.log(
    "Withdrawals:",
    count(
        (r) =>
            r.withdrawals !== null,
    ),
);

console.log(
    "Fees:",
    count(
        (r) =>
            r.fees !== null,
    ),
);

console.log(
    "Fabriq positions:",
    count(
        (r) =>
            r.fabPositions !== null,
    ),
);

// ========================================
// ZERO / NEGATIVE VALUES
// ========================================

section(
    "ZERO / NEGATIVE CAPITAL FLOW",
);

console.log(
    "Zero deposits:",
    count(
        (r) =>
            r.deposits === 0,
    ),
);

console.log(
    "Zero withdrawals:",
    count(
        (r) =>
            r.withdrawals === 0,
    ),
);

console.log(
    "Negative deposits:",
    count(
        (r) =>
            r.deposits !== null &&
            r.deposits < 0,
    ),
);

console.log(
    "Negative withdrawals:",
    count(
        (r) =>
            r.withdrawals !== null &&
            r.withdrawals < 0,
    ),
);

// ========================================
// WITHDRAWAL / DEPOSIT QUALITY
// ========================================

section(
    "WITHDRAWAL / DEPOSIT RATIOS",
);

console.log(
    "Withdrawal > deposits:",
    count(
        (r) =>
            r.withdrawalDepositRatio !==
            null &&
            r.withdrawalDepositRatio >
            1,
    ),
);

console.log(
    "Withdrawal > 1.5x deposits:",
    count(
        (r) =>
            r.withdrawalDepositRatio !==
            null &&
            r.withdrawalDepositRatio >
            1.5,
    ),
);

console.log(
    "Withdrawal > 2x deposits:",
    count(
        (r) =>
            r.withdrawalDepositRatio !==
            null &&
            r.withdrawalDepositRatio >
            2,
    ),
);

console.log(
    "Withdrawal > 10x deposits:",
    count(
        (r) =>
            r.withdrawalDepositRatio !==
            null &&
            r.withdrawalDepositRatio >
            10,
    ),
);

console.log(
    "Withdrawal > 100x deposits:",
    count(
        (r) =>
            r.withdrawalDepositRatio !==
            null &&
            r.withdrawalDepositRatio >
            100,
    ),
);

// ========================================
// PNL QUALITY
// ========================================

section(
    "FABRIQ PNL OUTLIERS",
);

console.log(
    "|PnL| > 10 SOL:",
    count(
        (r) =>
            r.fabPnl !== null &&
            Math.abs(r.fabPnl) >
            10,
    ),
);

console.log(
    "|PnL| > 100 SOL:",
    count(
        (r) =>
            r.fabPnl !== null &&
            Math.abs(r.fabPnl) >
            100,
    ),
);

console.log(
    "|PnL| > 1,000 SOL:",
    count(
        (r) =>
            r.fabPnl !== null &&
            Math.abs(r.fabPnl) >
            1000,
    ),
);

console.log(
    "Positive PnL > deposits:",
    count(
        (r) =>
            r.fabPnl !== null &&
            r.deposits !== null &&
            r.deposits > 0 &&
            r.fabPnl >
            r.deposits,
    ),
);

console.log(
    "|PnL| > deposits:",
    count(
        (r) =>
            r.fabPnl !== null &&
            r.deposits !== null &&
            r.deposits > 0 &&
            Math.abs(r.fabPnl) >
            r.deposits,
    ),
);

console.log(
    "|PnL| > 50% deposits:",
    count(
        (r) =>
            r.absPnlDepositRatio !==
            null &&
            r.absPnlDepositRatio >
            0.5,
    ),
);

// ========================================
// POSITION SCOPE
// ========================================

section(
    "LP AGENT vs FABRIQ POSITION COVERAGE",
);

console.log(
    "LP < 10% Fabriq:",
    count(
        (r) =>
            r.positionCoverage !==
            null &&
            r.positionCoverage <
            0.10,
    ),
);

console.log(
    "LP < 25% Fabriq:",
    count(
        (r) =>
            r.positionCoverage !==
            null &&
            r.positionCoverage <
            0.25,
    ),
);

console.log(
    "LP < 50% Fabriq:",
    count(
        (r) =>
            r.positionCoverage !==
            null &&
            r.positionCoverage <
            0.50,
    ),
);

console.log(
    "LP positions ~ Fabriq (80%-120%):",
    count(
        (r) =>
            r.positionCoverage !==
            null &&
            r.positionCoverage >=
            0.8 &&
            r.positionCoverage <=
            1.2,
    ),
);

// ========================================
// SAME POSITION SCOPE BUT PNL DIFFERENT
// ========================================

const similarPositionScope =
    rows.filter(
        (r) =>
            r.positionCoverage !==
            null &&
            r.positionCoverage >=
            0.8 &&
            r.positionCoverage <=
            1.2,
    );

section(
    "SIMILAR POSITION COUNT, DIFFERENT PNL",
);

console.log(
    "Comparable wallets:",
    similarPositionScope.length,
);

console.log(
    "PnL difference >20%:",
    similarPositionScope.filter(
        (r) =>
            r.pnlDifference !== null &&
            r.pnlDifference > 0.20,
    ).length,
);

console.log(
    "PnL difference >50%:",
    similarPositionScope.filter(
        (r) =>
            r.pnlDifference !== null &&
            r.pnlDifference > 0.50,
    ).length,
);

console.log(
    "PnL difference >90%:",
    similarPositionScope.filter(
        (r) =>
            r.pnlDifference !== null &&
            r.pnlDifference > 0.90,
    ).length,
);

// ========================================
// EXTREME WITHDRAWAL RATIOS
// ========================================

section(
    "TOP 15 WITHDRAWAL / DEPOSIT RATIOS",
);

rows
    .filter(
        (r) =>
            r.withdrawalDepositRatio !==
            null,
    )
    .sort(
        (a, b) =>
            b.withdrawalDepositRatio -
            a.withdrawalDepositRatio,
    )
    .slice(0, 15)
    .forEach(
        (r, i) => {
            console.log(
                `\n${i + 1}. ${r.owner}`,
            );

            console.log(
                "Deposits      :",
                sol(r.deposits),
            );

            console.log(
                "Withdrawals   :",
                sol(r.withdrawals),
            );

            console.log(
                "W/D Ratio     :",
                `${r.withdrawalDepositRatio.toFixed(
                    2,
                )}x`,
            );

            console.log(
                "Fabriq PnL    :",
                sol(r.fabPnl),
            );

            console.log(
                "Positions     :",
                `${r.lpPositions} / ${r.fabPositions}`,
            );
        },
    );

// ========================================
// EXTREME PNL
// ========================================

section(
    "TOP 15 ABSOLUTE FABRIQ PNL",
);

rows
    .filter(
        (r) =>
            r.fabPnl !== null,
    )
    .sort(
        (a, b) =>
            Math.abs(b.fabPnl) -
            Math.abs(a.fabPnl),
    )
    .slice(0, 15)
    .forEach(
        (r, i) => {
            console.log(
                `\n${i + 1}. ${r.owner}`,
            );

            console.log(
                "Fabriq PnL    :",
                sol(r.fabPnl),
            );

            console.log(
                "Deposits      :",
                sol(r.deposits),
            );

            console.log(
                "Withdrawals   :",
                sol(r.withdrawals),
            );

            console.log(
                "Fees          :",
                sol(r.fees),
            );

            console.log(
                "PnL/Deposit   :",
                pct(
                    r.pnlDepositRatio,
                ),
            );

            console.log(
                "Positions     :",
                `${r.lpPositions} / ${r.fabPositions}`,
            );

            console.log(
                "LP Agent PnL  :",
                sol(r.lpPnl),
            );
        },
    );

// ========================================
// SIMILAR POSITION COUNTS
// ========================================

section(
    "TOP 15 PNL DISCREPANCIES WITH SIMILAR POSITION COUNTS",
);

similarPositionScope
    .filter(
        (r) =>
            r.pnlDifference !== null,
    )
    .sort(
        (a, b) =>
            b.pnlDifference -
            a.pnlDifference,
    )
    .slice(0, 15)
    .forEach(
        (r, i) => {
            console.log(
                `\n${i + 1}. ${r.owner}`,
            );

            console.log(
                "Positions LP/Fab:",
                `${r.lpPositions} / ${r.fabPositions}`,
            );

            console.log(
                "Coverage      :",
                pct(
                    r.positionCoverage,
                ),
            );

            console.log(
                "LP PnL        :",
                sol(r.lpPnl),
            );

            console.log(
                "Fabriq PnL    :",
                sol(r.fabPnl),
            );

            console.log(
                "PnL Difference:",
                pct(
                    r.pnlDifference,
                ),
            );

            console.log(
                "Deposits      :",
                sol(r.deposits),
            );

            console.log(
                "Withdrawals   :",
                sol(r.withdrawals),
            );

            console.log(
                "Fees          :",
                sol(r.fees),
            );
        },
    );

// ========================================
// POTENTIALLY SUSPICIOUS
// ========================================

section(
    "POTENTIALLY SUSPICIOUS FABRIQ RECORDS",
);

const suspicious =
    rows.filter((r) => {
        const hugeWithdrawalRatio =
            r.withdrawalDepositRatio !==
            null &&
            r.withdrawalDepositRatio >
            2;

        const pnlLargerThanCapital =
            r.absPnlDepositRatio !==
            null &&
            r.absPnlDepositRatio >
            1;

        const veryLargePnl =
            r.fabPnl !== null &&
            Math.abs(r.fabPnl) >
            1000;

        return (
            hugeWithdrawalRatio ||
            pnlLargerThanCapital ||
            veryLargePnl
        );
    });

console.log(
    "Suspicious records:",
    suspicious.length,
);

console.log(
    "Percentage:",
    pct(
        suspicious.length /
        Math.max(
            rows.length,
            1,
        ),
    ),
);