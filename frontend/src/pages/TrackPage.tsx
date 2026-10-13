import { Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { WalletTable, type WalletSortKey } from "../components/WalletTable";
import type { Wallet } from "../types";
import { sortWallets } from "../lib/walletMetrics";

type Props = {
  wallets: Wallet[];
  trackedOwners: Set<string>;
  onToggleTrack: (owner: string) => void;
  onOpenWallet: (wallet: Wallet) => void;
};


export function TrackPage({
  wallets,
  trackedOwners,
  onToggleTrack,
  onOpenWallet,
}: Props) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<WalletSortKey>("pnl7");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = wallets.filter(
      (wallet) =>
        trackedOwners.has(wallet.owner) &&
        (!needle || wallet.owner.toLowerCase().includes(needle)),
    );
    return sortWallets(filtered, sortKey, sortDir);
  }, [wallets, trackedOwners, search, sortKey, sortDir]);

  function handleSort(key: WalletSortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(key);
    setSortDir("desc");
  }

  return (
    <div className="track-page">
      <div className="page-heading track-heading">
        <div>
          <h1>Tracked Wallets</h1>
          <p>Wallets you marked from Wallet Explorer or Portfolio.</p>
        </div>

        <div className="track-search">
          <Search size={15} />
          <input
            placeholder="Search tracked wallet..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <div className="track-summary">
        <span className="track-summary-icon">
          <Star size={16} fill="currentColor" />
        </span>
        <div>
          <strong>{trackedOwners.size} tracked wallets</strong>
          <small>Saved locally in this browser</small>
        </div>
      </div>

      {trackedOwners.size === 0 ? (
        <section className="portfolio-empty track-empty">
          <Star size={32} />
          <h2>No tracked wallets yet</h2>
          <p>Mark a wallet with the star icon in Wallet Explorer or Portfolio.</p>
        </section>
      ) : (
        <WalletTable
          wallets={rows}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          onOpenWallet={onOpenWallet}
          trackedOwners={trackedOwners}
          onToggleTrack={onToggleTrack}
        />
      )}
    </div>
  );
}
