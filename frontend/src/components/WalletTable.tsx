import {
  Check,
  ChevronDown,
  Copy,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { useMemo, useState } from "react";
import { fmt, shortWallet, timeAgo, walletAge } from "../lib/format";
import type { Wallet } from "../types";
import { Sparkline } from "./Sparkline";
import {
  walletAllTimePnl,
  walletMonthlyPnl,
  walletPnl30d,
  walletPnl7d,
  walletSparkline7d,
  walletWinRatePercent,
} from "../lib/walletMetrics";

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

type ColumnKey =
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

type Props = {
  wallets: Wallet[];
  sortKey: WalletSortKey;
  sortDir: "asc" | "desc";
  onSort: (key: WalletSortKey) => void;
  onOpenWallet: (wallet: Wallet) => void;
  trackedOwners?: Set<string>;
  onToggleTrack?: (owner: string) => void;
};

const labels: Record<ColumnKey, string> = {
  wallet: "Wallet",
  shortlist: "Shortlist",
  quality: "Quality",
  risk: "Risk",
  confidence: "Confidence",
  style: "Style",
  pnl7: "7D PnL",
  win: "Win Rate",
  winDays: "Win Days",
  loseDays: "Lose Days",
  pnl30: "30D PnL",
  pnlAll: "All-Time PnL",
  positions: "Positions",
  walletAge: "Wallet Age",
  age: "Avg Age",
  ev: "EV",
  invested: "Avg Invested",
  monthly: "Monthly PnL",
  fees: "Fees",
  last: "Last Active",
};

const defaultVisible: Record<ColumnKey, boolean> = {
  wallet: true,
  shortlist: true,
  quality: true,
  risk: true,
  confidence: true,
  style: true,
  pnl7: true,
  win: true,
  winDays: true,
  loseDays: true,
  pnl30: true,
  pnlAll: true,
  positions: true,
  walletAge: true,
  age: true,
  ev: true,
  invested: true,
  monthly: true,
  fees: true,
  last: false,
};

function formatQualityScore(wallet: Wallet): string {
  const val = wallet.intelligenceV1?.qualityScore;
  if (val === null || val === undefined) return "—";
  return fmt(val, 1);
}

function formatRiskScore(wallet: Wallet): string {
  const val = wallet.intelligenceV1?.riskScore;
  if (val === null || val === undefined) return "—";
  return fmt(val, 1);
}

function formatV1ConfidenceScore(wallet: Wallet): string {
  const val = wallet.intelligenceV1?.confidenceScore;
  if (val !== null && val !== undefined) return fmt(val, 1);
  return "—";
}

function formatV1StyleTag(wallet: Wallet): string {
  const style = wallet.intelligenceV1?.style;
  if (style) {
    if (style === "SNIPER" || style === "sniper") return "Sniper";
    if (style === "FARMER" || style === "farmer") return "Farmer";
    if (style === "MIXED_UNCLASSIFIED" || style === "mixed_unclassified" || style === "mixed") {
      return "Mixed / Unclassified";
    }
    return style;
  }
  return "—";
}

function signed(value: number, digits = 2) {
  return `${value >= 0 ? "+" : ""}${fmt(value, digits)}`;
}

function duration(hours: number) {
  if (!Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${fmt(hours, 1)}h`;
  return `${fmt(hours / 24, 1)}d`;
}

function getDayStats(wallet: Wallet) {
  const stats =
    wallet.fabriq?.stats;

  const dayStats =
    stats?.dayWinUsd ??
    stats?.dayWinSol;

  return {
    wins:
      Number(dayStats?.wins) || 0,

    losses:
      Number(dayStats?.losses) || 0,
  };
}

export function WalletTable({
  wallets,
  sortKey,
  sortDir,
  onSort,
  onOpenWallet,
  trackedOwners = new Set(),
  onToggleTrack,
}: Props) {
  const [page, setPage] = useState(1);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visible, setVisible] = useState(defaultVisible);
  const [copiedWallet, setCopiedWallet] = useState<string | null>(null);
  const pageSize = 25;

  const pageCount = Math.max(1, Math.ceil(wallets.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const rows = useMemo(
    () => wallets.slice((safePage - 1) * pageSize, safePage * pageSize),
    [safePage, wallets],
  );

  const visibleColumns = (Object.keys(visible) as ColumnKey[]).filter(
    (key) => visible[key],
  );

  function header(key: WalletSortKey) {
    return (
      <button className="table-sort" onClick={() => onSort(key)}>
        {labels[key].toUpperCase()}
        <span className={sortKey === key ? "active-sort" : ""}>
          {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    );
  }

  async function handleCopyWallet(
    event: React.MouseEvent,
    address: string,
  ) {
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(address);

      setCopiedWallet(address);

      window.setTimeout(() => {
        setCopiedWallet((current) =>
          current === address ? null : current,
        );
      }, 1500);
    } catch (error) {
      console.error("Failed to copy wallet:", error);
    }
  }

  return (
    <section className="wallet-table-card">
      <div className="table-toolbar">
        <div>
          <strong>{wallets.length.toLocaleString()} wallets</strong>
          <span>on Solana</span>
        </div>

        <div className="table-toolbar-right">
          <span>Values in SOL</span>
          <div className="columns-wrap">
            <button
              className="columns-button"
              onClick={() => setColumnsOpen((current) => !current)}
            >
              <SlidersHorizontal size={14} />
              Columns
              <ChevronDown size={13} />
            </button>

            {columnsOpen ? (
              <div className="columns-menu">
                {(Object.keys(labels) as ColumnKey[]).map((key) => (
                  <button
                    key={key}
                    onClick={() =>
                      setVisible((current) => ({
                        ...current,
                        [key]: !current[key],
                      }))
                    }
                  >
                    <span>{labels[key]}</span>
                    {visible[key] ? <Check size={13} /> : <span />}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="table-scroll">
        <table className="wallet-table">
          <thead>
            <tr>
              <th className="rank-col">#</th>
              {visible.wallet ? <th>{header("wallet")}</th> : null}
              {visible.shortlist ? <th>{header("shortlist")}</th> : null}
              {visible.quality ? <th>{header("quality")}</th> : null}
              {visible.risk ? (
                <th title="0–100. Higher means higher observed historical risk.">
                  {header("risk")}
                </th>
              ) : null}
              {visible.confidence ? <th>{header("confidence")}</th> : null}
              {visible.style ? <th>{header("style")}</th> : null}
              {visible.pnl7 ? <th>{header("pnl7")}</th> : null}
              {visible.win ? <th>{header("win")}</th> : null}
              {visible.winDays ? (
                <th>{header("winDays")}</th>
              ) : null}

              {visible.loseDays ? (
                <th>{header("loseDays")}</th>
              ) : null}
              {visible.pnl30 ? <th>{header("pnl30")}</th> : null}
              {visible.pnlAll ? <th>{header("pnlAll")}</th> : null}
              {visible.positions ? <th>{header("positions")}</th> : null}
              {visible.walletAge ? <th>{header("walletAge")}</th> : null}
              {visible.age ? <th>{header("age")}</th> : null}
              {visible.ev ? <th>{header("ev")}</th> : null}
              {visible.invested ? <th>{header("invested")}</th> : null}
              {visible.monthly ? <th>{header("monthly")}</th> : null}
              {visible.fees ? <th>{header("fees")}</th> : null}
              {visible.last ? <th>{header("last")}</th> : null}
            </tr>
          </thead>

          <tbody>
            {rows.map((wallet, index) => {
              const pnl7 =
                walletPnl7d(
                  wallet,
                );

              const pnl30 =
                walletPnl30d(
                  wallet,
                );

              const pnlAll =
                walletAllTimePnl(
                  wallet,
                );

              const monthlyPnl =
                walletMonthlyPnl(
                  wallet,
                );

              const sparkValues =
                walletSparkline7d(
                  wallet,
                );


              const dayStats =
                getDayStats(wallet);

              return (
                <tr
                  key={wallet.owner}
                  className="wallet-row"
                  onClick={() => onOpenWallet(wallet)}
                >
                  <td className="rank-col">
                    {(safePage - 1) * pageSize + index + 1}
                  </td>

                  {visible.wallet ? (
                    <td>
                      <div className="wallet-cell">
                        <button
                          className={`track-wallet-button ${trackedOwners.has(wallet.owner) ? "tracked" : ""
                            }`}
                          title={
                            trackedOwners.has(wallet.owner)
                              ? "Remove from Track"
                              : "Add to Track"
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleTrack?.(wallet.owner);
                          }}
                        >
                          <Star
                            size={13}
                            fill={
                              trackedOwners.has(wallet.owner)
                                ? "currentColor"
                                : "none"
                            }
                          />
                        </button>
                        <strong>{shortWallet(wallet.owner)}</strong>
                        <button
                          className={`copy-wallet ${copiedWallet === wallet.owner ? "copied" : ""
                            }`}
                          title={
                            copiedWallet === wallet.owner
                              ? "Copied"
                              : "Copy wallet"
                          }
                          onClick={(event) =>
                            handleCopyWallet(event, wallet.owner)
                          }
                        >
                          <span className="copy-wallet-icon">
                            {copiedWallet === wallet.owner ? (
                              <Check size={12} />
                            ) : (
                              <Copy size={12} />
                            )}
                          </span>

                          {copiedWallet === wallet.owner ? (
                            <span className="copy-wallet-text">
                              Copied
                            </span>
                          ) : null}
                        </button>
                      </div>
                    </td>
                  ) : null}

                  {visible.shortlist ? (
                    <td style={{ textAlign: "center" }}>
                      {wallet.intelligenceV1?.shortlisted ? (
                        <span
                          className="v1-shortlist-badge"
                          title="Passes V1 historical monitoring criteria"
                        >
                          Shortlisted
                        </span>
                      ) : (
                        <span className="v1-unshortlist">—</span>
                      )}
                    </td>
                  ) : null}

                  {visible.quality ? (
                    <td className="numeric">{formatQualityScore(wallet)}</td>
                  ) : null}

                  {visible.risk ? (
                    <td
                      className="numeric"
                      title="0–100. Higher means higher observed historical risk."
                    >
                      {formatRiskScore(wallet)}
                    </td>
                  ) : null}

                  {visible.confidence ? (
                    <td className="numeric">{formatV1ConfidenceScore(wallet)}</td>
                  ) : null}

                  {visible.style ? (
                    <td>
                      <span className="v1-style-tag">
                        {formatV1StyleTag(wallet)}
                      </span>
                    </td>
                  ) : null}

                  {visible.pnl7 ? (
                    <td>
                      <div className="pnl-cell">
                        <Sparkline values={sparkValues.slice(-14)} />
                        <strong
                          className={
                            pnl7 >= 0 ? "positive" : "negative"
                          }
                        >
                          {signed(pnl7)}
                        </strong>
                      </div>
                    </td>
                  ) : null}

                  {visible.win ? (() => {
                    const winRate =
                      walletWinRatePercent(
                        wallet,
                      );

                    return (
                      <td>
                        <div className="win-rate-cell">
                          <span>
                            {fmt(winRate, 1)}%
                          </span>

                          <div className="win-rate-bar">
                            <span
                              style={{
                                width: `${Math.max(
                                  0,
                                  Math.min(100, winRate),
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                    );
                  })() : null}

                  {visible.winDays ? (
                    <td className="day-stat win-day-stat">
                      {dayStats.wins}
                    </td>
                  ) : null}

                  {visible.loseDays ? (
                    <td className="day-stat lose-day-stat">
                      {dayStats.losses}
                    </td>
                  ) : null}

                  {visible.pnl30 ? (
                    <td
                      className={
                        pnl30 >= 0 ? "positive" : "negative"
                      }
                    >
                      {signed(pnl30)}
                    </td>
                  ) : null}

                  {visible.pnlAll ? (
                    <td
                      className={pnlAll >= 0 ? "positive" : "negative"}
                    >
                      <strong>{signed(pnlAll)}</strong>
                    </td>
                  ) : null}

                  {visible.positions ? (
                    <td className="numeric">
                      <strong>{wallet.total_lp}</strong>
                      <small>
                        {wallet.total_lp_7d} in 7D · {wallet.total_pool} pools
                      </small>
                    </td>
                  ) : null}

                  {visible.walletAge ? (
                    <td className="numeric">{walletAge(wallet.first_activity)}</td>
                  ) : null}

                  {visible.age ? (
                    <td className="numeric">{duration(wallet.avg_age_hour)}</td>
                  ) : null}

                  {visible.ev ? (
                    <td
                      className={
                        wallet.expected_value_native >= 0 ? "positive" : "negative"
                      }
                    >
                      {signed(wallet.expected_value_native)}
                    </td>
                  ) : null}

                  {visible.invested ? (
                    <td className="numeric">{fmt(wallet.avg_inflow_native, 2)}</td>
                  ) : null}

                  {visible.monthly ? (
                    <td
                      className={
                        monthlyPnl >= 0 ? "positive" : "negative"
                      }
                    >
                      {signed(monthlyPnl)}
                    </td>
                  ) : null}

                  {visible.fees ? (
                    <td className="numeric">{fmt(wallet.total_fee_native, 2)}</td>
                  ) : null}

                  {visible.last ? (
                    <td className="numeric">{timeAgo(wallet.last_activity)}</td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="table-pagination">
        <span>
          Page {safePage} of {pageCount}
        </span>

        <div>
          <button
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <button
            disabled={safePage >= pageCount}
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          >
            Next
          </button>
        </div>
      </footer>
    </section>
  );
}
