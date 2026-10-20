import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Filter,
  Layers3,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import React, { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPoolDetail,
  fetchPoolWallets,
  fetchPoolWalletTrades,
  fetchScannedPools,
  filterPoolTrades,
  filterTokenGroups,
  formatPct,
  formatUsd,
  getPoolRefreshStatus,
  groupPoolsByToken,
  refreshWalletCumulative,
  startPoolRefresh,
  type MatchedCumulativeGroup,
  type PoolDetailResponse,
  type PoolRefreshStage,
  type PoolTradeFilterResponse,
  type PoolTradeMatchMode,
  type PoolWalletItem,
  type PoolWalletSortKey,
  type PoolWalletTradeItem,
  type ScannedPoolItem,
  type SortOrder,
  type TokenPoolGroup,
} from "../lib/poolInsight";

export { formatUsd, formatPct, groupPoolsByToken, filterTokenGroups, type TokenPoolGroup };
import { shortWallet } from "../lib/format";
import "../pool-insight.css";

type Subnav = "explorer" | "intelligence";

function parseNavFromUrl(): { tab: Subnav; poolAddress: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const pool = params.get("pool")?.trim() || null;
    const tabParam = params.get("tab")?.trim().toLowerCase();

    if (pool) {
      return {
        tab: tabParam === "explorer" ? "explorer" : "intelligence",
        poolAddress: pool,
      };
    }

    if (tabParam === "intelligence") {
      return {
        tab: "intelligence",
        poolAddress: null,
      };
    }
  } catch {
    // fallback if window is undefined or url error
  }

  return { tab: "explorer", poolAddress: null };
}
function formatTimestamp(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function getRefreshStageLabel(stage: PoolRefreshStage | null): string {
  switch (stage) {
    case "starting": return "Starting refresh…";
    case "scanning": return "Scanning LP wallets…";
    case "enriching": return "Refreshing Fabriq…";
    case "trade_history": return "Building trade history…";
    case "persisting": return "Persisting snapshot…";
    case "completed": return "Updated";
    case "failed": return "Refresh failed";
    default: return "Refreshing Pool…";
  }
}


function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const sec = Math.floor(seconds);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) {
    return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) {
    const parts = [`${hours}h`];
    if (remMin > 0) parts.push(`${remMin}m`);
    if (remSec > 0) parts.push(`${remSec}s`);
    return parts.join(" ");
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function CopyButton({ text, label = "Copy address" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : label}
      aria-label={label}
      type="button"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

export function PoolInsightPage() {
  const [subnav, setSubnav] = useState<Subnav>(() => parseNavFromUrl().tab);
  const [selectedPoolAddress, setSelectedPoolAddress] = useState<string | null>(
    () => parseNavFromUrl().poolAddress
  );

  const updateNav = useCallback(
    (newTab: Subnav, newPool: string | null = selectedPoolAddress) => {
      setSubnav(newTab);
      setSelectedPoolAddress(newPool);

      try {
        const params = new URLSearchParams(window.location.search);
        if (newTab === "intelligence") {
          params.set("tab", "intelligence");
          if (newPool) {
            params.set("pool", newPool);
          } else {
            params.delete("pool");
          }
        } else {
          params.delete("tab");
          if (newPool) {
            params.set("pool", newPool);
          } else {
            params.delete("pool");
          }
        }

        const search = params.toString();
        const newUrl = `${window.location.pathname}${search ? `?${search}` : ""}`;
        if (newUrl !== `${window.location.pathname}${window.location.search}`) {
          window.history.pushState(null, "", newUrl);
        }
      } catch {
        // Safe fallback
      }
    },
    [selectedPoolAddress]
  );

  useEffect(() => {
    const handlePopState = () => {
      const parsed = parseNavFromUrl();
      setSubnav(parsed.tab);
      setSelectedPoolAddress(parsed.poolAddress);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // View 1: Pools list state
  const [pools, setPools] = useState<ScannedPoolItem[]>([]);
  const [loadingPools, setLoadingPools] = useState(true);
  const [poolsError, setPoolsError] = useState<string | null>(null);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  const tokenGroups = useMemo(() => groupPoolsByToken(pools), [pools]);
  const visibleGroups = useMemo(
    () => filterTokenGroups(tokenGroups, searchQuery),
    [tokenGroups, searchQuery]
  );

  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  const allVisibleExpanded = useMemo(() => {
    if (visibleGroups.length === 0) return false;
    return visibleGroups.every((g) => expandedGroupKeys.has(g.groupKey));
  }, [visibleGroups, expandedGroupKeys]);

  const handleToggleAllGroups = useCallback(() => {
    if (visibleGroups.length === 0) return;
    if (allVisibleExpanded) {
      setExpandedGroupKeys((prev) => {
        const next = new Set(prev);
        for (const g of visibleGroups) {
          next.delete(g.groupKey);
        }
        return next;
      });
    } else {
      setExpandedGroupKeys((prev) => {
        const next = new Set(prev);
        for (const g of visibleGroups) {
          next.add(g.groupKey);
        }
        return next;
      });
    }
  }, [visibleGroups, allVisibleExpanded]);

  // Keep token group expanded if a pool within it is currently selected
  useEffect(() => {
    if (selectedPoolAddress && tokenGroups.length > 0) {
      const groupWithPool = tokenGroups.find((g) =>
        g.pools.some((p) => p.poolAddress === selectedPoolAddress)
      );
      if (groupWithPool) {
        setExpandedGroupKeys((prev) => {
          if (prev.has(groupWithPool.groupKey)) return prev;
          const next = new Set(prev);
          next.add(groupWithPool.groupKey);
          return next;
        });
      }
    }
  }, [selectedPoolAddress, tokenGroups]);

  // View 2: Selected Pool Detail & Wallets state
  const [poolDetail, setPoolDetail] = useState<ScannedPoolItem | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [wallets, setWallets] = useState<PoolWalletItem[]>([]);
  const [loadingWallets, setLoadingWallets] = useState(false);
  const [walletsError, setWalletsError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<PoolWalletSortKey>("pnlUsd");
  const [sortDir, setSortDir] = useState<SortOrder>("desc");

  // Drilldown View: Selected Wallet Trade History state
  const [selectedWalletForTrades, setSelectedWalletForTrades] = useState<string | null>(null);
  const [walletTrades, setWalletTrades] = useState<PoolWalletTradeItem[]>([]);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);

  // Refresh Pool state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshStage, setRefreshStage] = useState<PoolRefreshStage | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);


  // Trade Filter state
  const [minDurationHours, setMinDurationHours] = useState<string>("");
  const [minDurationMinutes, setMinDurationMinutes] = useState<string>("");
  const [maxDurationHours, setMaxDurationHours] = useState<string>("");
  const [maxDurationMinutes, setMaxDurationMinutes] = useState<string>("");
  const [minPnlUsdInput, setMinPnlUsdInput] = useState<string>("");
  const [maxPnlUsdInput, setMaxPnlUsdInput] = useState<string>("");
  const [minPnlPctInput, setMinPnlPctInput] = useState<string>("");
  const [maxPnlPctInput, setMaxPnlPctInput] = useState<string>("");
  const [matchMode, setMatchMode] = useState<PoolTradeMatchMode>("individual");
  const [bothResultsTab, setBothResultsTab] = useState<"individual" | "cumulative">("individual");

  const [isFiltering, setIsFiltering] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterValidationMsg, setFilterValidationMsg] = useState<string | null>(null);
  const [filterResponse, setFilterResponse] = useState<PoolTradeFilterResponse | null>(null);
  const [expandedWallets, setExpandedWallets] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [targetedWalletInput, setTargetedWalletInput] = useState<string>("");
  const [isRefreshingCumulative, setIsRefreshingCumulative] = useState<boolean>(false);
  const [targetedRefreshStatus, setTargetedRefreshStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  // Reset drilldown and refresh state whenever selected pool changes or is deselected
  useEffect(() => {
    setSelectedWalletForTrades(null);
    setWalletTrades([]);
    setTradesError(null);
    setLoadingTrades(false);
    setIsRefreshing(false);
    setRefreshStage(null);
    setRefreshError(null);
    setRefreshSuccess(false);
    setMinDurationHours("");
    setMinDurationMinutes("");
    setMaxDurationHours("");
    setMaxDurationMinutes("");
    setMinPnlUsdInput("");
    setMaxPnlUsdInput("");
    setMinPnlPctInput("");
    setMaxPnlPctInput("");
    setMatchMode("individual");
    setBothResultsTab("individual");
    setFilterError(null);
    setFilterValidationMsg(null);
    setFilterResponse(null);
    setIsFiltering(false);
    setExpandedWallets(new Set());
    setExpandedGroups(new Set());
    setTargetedWalletInput("");
    setIsRefreshingCumulative(false);
    setTargetedRefreshStatus(null);
  }, [selectedPoolAddress]);

  // Load trades for selected pool + wallet with stale-response protection
  useEffect(() => {
    if (!selectedPoolAddress || !selectedWalletForTrades) {
      setWalletTrades([]);
      setTradesError(null);
      setLoadingTrades(false);
      return;
    }

    let active = true;
    setLoadingTrades(true);
    setTradesError(null);
    setWalletTrades([]); // Invariant: no flash of old data

    fetchPoolWalletTrades(selectedPoolAddress, selectedWalletForTrades)
      .then((res) => {
        if (!active) return;
        if (res.poolAddress === selectedPoolAddress && res.wallet === selectedWalletForTrades) {
          setWalletTrades(res.trades || []);
        }
      })
      .catch((err) => {
        if (!active) return;
        setTradesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) {
          setLoadingTrades(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedPoolAddress, selectedWalletForTrades]);

  const handleOpenTrades = (wallet: string) => {
    setSelectedWalletForTrades(wallet);
  };

  const handleCloseTrades = () => {
    setSelectedWalletForTrades(null);
    setWalletTrades([]);
    setTradesError(null);
    setLoadingTrades(false);
  };

  // Close drilldown on Escape key
  useEffect(() => {
    if (!selectedWalletForTrades) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCloseTrades();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedWalletForTrades]);

  // Load scanned pools for View 1
  const loadPools = useCallback(async () => {
    setLoadingPools(true);
    setPoolsError(null);
    try {
      const response = await fetchScannedPools();
      setPools(response.pools || []);
    } catch (err) {
      setPoolsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPools(false);
    }
  }, []);

  useEffect(() => {
    loadPools();
  }, [loadPools]);

  // Load selected pool detail & wallets for View 2
  const loadDetail = useCallback(async (address: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await fetchPoolDetail(address);
      setPoolDetail(response.pool);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadWallets = useCallback(async (address: string, key: PoolWalletSortKey, dir: SortOrder) => {
    setLoadingWallets(true);
    setWalletsError(null);
    try {
      const response = await fetchPoolWallets(address, key, dir);
      setWallets(response.wallets || []);
    } catch (err) {
      setWalletsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingWallets(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPoolAddress) {
      loadDetail(selectedPoolAddress);
      loadWallets(selectedPoolAddress, sortKey, sortDir);
    } else {
      setPoolDetail(null);
      setWallets([]);
      setDetailError(null);
      setWalletsError(null);
    }
  }, [selectedPoolAddress, loadDetail, loadWallets, sortKey, sortDir]);

  const handleSort = (key: PoolWalletSortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Status polling for active pool refresh with stale-response protection
  useEffect(() => {
    if (!isRefreshing || !selectedPoolAddress) return;

    const currentTargetPool = selectedPoolAddress;
    let active = true;

    const interval = setInterval(async () => {
      try {
        const status = await getPoolRefreshStatus(currentTargetPool);
        if (!active || selectedPoolAddress !== currentTargetPool) return;

        setRefreshStage(status.stage);

        if (status.status === "completed") {
          setIsRefreshing(false);
          setRefreshSuccess(true);
          setTimeout(() => {
            if (active) setRefreshSuccess(false);
          }, 3000);

          // Refetch fresh canonical pool data
          loadDetail(currentTargetPool);
          loadWallets(currentTargetPool, sortKey, sortDir);
          loadPools();

          // Reset open trade drilldown so stale detail is not shown
          setSelectedWalletForTrades(null);
          setWalletTrades([]);
          // Reset trade filter results on pool refresh completion
          setFilterResponse(null);
          setFilterError(null);
          setFilterValidationMsg(null);
          setExpandedWallets(new Set());
        } else if (status.status === "failed") {
          setIsRefreshing(false);
          setRefreshError(status.error || "Pool refresh failed");
        }
      } catch (err) {
        if (!active) return;
        console.warn("Refresh status poll error:", err);
      }
    }, 1500);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isRefreshing, selectedPoolAddress, loadDetail, loadWallets, loadPools, sortKey, sortDir]);

  const handleRefreshPool = async () => {
    if (!selectedPoolAddress || isRefreshing) return;
    setIsRefreshing(true);
    setRefreshStage("starting");
    setRefreshError(null);
    setRefreshSuccess(false);

    try {
      await startPoolRefresh(selectedPoolAddress);
    } catch (err) {
      setIsRefreshing(false);
      setRefreshStage(null);
      setRefreshError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApplyFilter = async () => {
    setFilterValidationMsg(null);
    setFilterError(null);

    const minHStr = minDurationHours.trim();
    const minMStr = minDurationMinutes.trim();
    const maxHStr = maxDurationHours.trim();
    const maxMStr = maxDurationMinutes.trim();
    const minUsdStr = minPnlUsdInput.trim();
    const maxUsdStr = maxPnlUsdInput.trim();
    const minPctStr = minPnlPctInput.trim();
    const maxPctStr = maxPnlPctInput.trim();

    const hasMinDur = Boolean(minHStr || minMStr);
    const hasMaxDur = Boolean(maxHStr || maxMStr);

    // Empty filter validation: require at least one filter
    if (!hasMinDur && !hasMaxDur && !minUsdStr && !maxUsdStr && !minPctStr && !maxPctStr) {
      setFilterValidationMsg("Set at least one filter.");
      return;
    }

    const parseDurationField = (
      valStr: string,
      fieldName: string,
      maxVal?: number
    ): number => {
      if (!/^\d+$/.test(valStr)) {
        throw new Error(`${fieldName} must be a non-negative integer`);
      }
      const val = Number(valStr);
      if (!Number.isSafeInteger(val) || val < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
      }
      if (maxVal !== undefined && val > maxVal) {
        throw new Error(`${fieldName} must be between 0 and ${maxVal}`);
      }
      return val;
    };

    const parseNum = (str: string, fieldName: string): number | null => {
      if (!str) return null;
      const val = Number(str);
      if (!Number.isFinite(val)) {
        throw new Error(`${fieldName} must be a valid number`);
      }
      return val;
    };

    let minDur: number | null = null;
    let maxDur: number | null = null;
    let minUsd: number | null = null;
    let maxUsd: number | null = null;
    let minPct: number | null = null;
    let maxPct: number | null = null;

    try {
      if (hasMinDur) {
        const h = minHStr ? parseDurationField(minHStr, "Minimum hours") : 0;
        const m = minMStr ? parseDurationField(minMStr, "Minimum minutes", 59) : 0;
        minDur = h * 60 + m;
      }
      if (hasMaxDur) {
        const h = maxHStr ? parseDurationField(maxHStr, "Maximum hours") : 0;
        const m = maxMStr ? parseDurationField(maxMStr, "Maximum minutes", 59) : 0;
        maxDur = h * 60 + m;
      }
      if (minDur !== null && maxDur !== null && minDur > maxDur) {
        throw new Error("Minimum duration cannot be greater than maximum duration");
      }
      minUsd = parseNum(minUsdStr, "Min PnL USD");
      maxUsd = parseNum(maxUsdStr, "Max PnL USD");
      minPct = parseNum(minPctStr, "Min PnL %");
      maxPct = parseNum(maxPctStr, "Max PnL %");
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!selectedPoolAddress) return;

    setIsFiltering(true);
    try {
      const response = await filterPoolTrades(selectedPoolAddress, {
        minDurationMinutes: minDur,
        maxDurationMinutes: maxDur,
        minPnlUsd: minUsd,
        maxPnlUsd: maxUsd,
        minPnlPct: minPct,
        maxPnlPct: maxPct,
        matchMode,
      });
      setFilterResponse(response);
      setExpandedWallets(new Set());
      setExpandedGroups(new Set());
      if (matchMode === "cumulative") {
        setBothResultsTab("cumulative");
      } else if (matchMode === "both") {
        const indCount = response.wallets?.length ?? response.matchedTradeCount ?? 0;
        const cumCount = response.cumulativeGroups?.length ?? response.matchedGroupCount ?? 0;
        if (indCount > 0) {
          setBothResultsTab("individual");
        } else if (cumCount > 0) {
          setBothResultsTab("cumulative");
        } else {
          setBothResultsTab("individual");
        }
      } else {
        setBothResultsTab("individual");
      }
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsFiltering(false);
    }
  };

  const handleClearFilter = () => {
    setMinDurationHours("");
    setMinDurationMinutes("");
    setMaxDurationHours("");
    setMaxDurationMinutes("");
    setMinPnlUsdInput("");
    setMaxPnlUsdInput("");
    setMinPnlPctInput("");
    setMaxPnlPctInput("");
    setMatchMode("individual");
    setBothResultsTab("individual");
    setFilterValidationMsg(null);
    setFilterError(null);
    setFilterResponse(null);
    setExpandedWallets(new Set());
    setExpandedGroups(new Set());
  };

  const handleTargetedCumulativeRefresh = async (walletOverride?: string) => {
    if (!selectedPoolAddress) return;
    const targetWallet = (walletOverride || targetedWalletInput).trim();
    if (!targetWallet) {
      setTargetedRefreshStatus({
        type: "error",
        message: "Please enter a valid wallet address to refresh.",
      });
      return;
    }

    setIsRefreshingCumulative(true);
    setTargetedRefreshStatus(null);

    try {
      await refreshWalletCumulative(selectedPoolAddress, targetWallet);
      setTargetedRefreshStatus({
        type: "success",
        message: `Successfully refreshed Fabriq cumulative aggregate for ${shortWallet(targetWallet, 6, 4)}.`,
      });
      await handleApplyFilter();
    } catch (err) {
      setTargetedRefreshStatus({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsRefreshingCumulative(false);
    }
  };

  const toggleWalletExpanded = (wallet: string) => {
    setExpandedWallets((prev) => {
      const next = new Set(prev);
      if (next.has(wallet)) {
        next.delete(wallet);
      } else {
        next.add(wallet);
      }
      return next;
    });
  };

  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleToggleAllExpanded = () => {
    if (!filterResponse) return;
    const activeMode: PoolTradeMatchMode =
      filterResponse.filters?.matchMode ?? matchMode ?? "individual";
    const isViewingCumulative =
      activeMode === "cumulative" ||
      (activeMode === "both" && bothResultsTab === "cumulative");

    if (isViewingCumulative) {
      const groups = Array.isArray(filterResponse.cumulativeGroups)
        ? filterResponse.cumulativeGroups
        : [];
      if (expandedGroups.size === groups.length) {
        setExpandedGroups(new Set());
      } else {
        setExpandedGroups(new Set(groups.map((g) => g.groupId)));
      }
    } else {
      const wList = Array.isArray(filterResponse.wallets)
        ? filterResponse.wallets
        : [];
      if (expandedWallets.size === wList.length) {
        setExpandedWallets(new Set());
      } else {
        setExpandedWallets(new Set(wList.map((w) => w.wallet)));
      }
    }
  };

  return (
    <div className="pool-insight-page">
      <header className="pool-insight-header">
        <div>
          <h2>Pool Explorer</h2>
          <p>Analyze scanned DLMM pools and LP activity.</p>
        </div>
        <nav className="pool-insight-subnav" aria-label="Pool Explorer navigation">
          <button
            className={subnav === "explorer" ? "active" : ""}
            onClick={() => updateNav("explorer")}
            type="button"
          >
            Pool Explorer
          </button>
          <button
            className={subnav === "intelligence" ? "active" : ""}
            onClick={() => updateNav("intelligence")}
            type="button"
          >
            Pool Intelligence
          </button>
        </nav>
      </header>

      {subnav === "intelligence" ? (
        !selectedPoolAddress ? (
          /* POOL INTELLIGENCE: EMPTY STATE WHEN NO POOL SELECTED */
          <section className="pool-insight-empty-state" aria-label="No Pool Selected">
            <div className="pool-insight-placeholder-icon">
              <Layers3 size={20} />
            </div>
            <h3>No Pool Selected</h3>
            <p>
              Select a pool from the Pool Explorer to view detailed pool metadata, active wallets,
              closed trade history, and real-time refresh options.
            </p>
            <button
              className="secondary-button"
              onClick={() => updateNav("explorer", null)}
              type="button"
            >
              <ArrowLeft size={13} /> Back to Pool Explorer
            </button>
          </section>
        ) : (
          /* POOL INTELLIGENCE: SELECTED POOL WORKSPACE */
          <div className="pool-detail-view">
            <div className="pool-detail-nav">
              <button
                className="secondary-button"
                onClick={() => updateNav("explorer", null)}
                type="button"
              >
                <ArrowLeft size={13} /> Back to Pool Explorer
              </button>
            </div>

            {refreshError && (
              <div className="state-card error" style={{ marginBottom: 16 }} role="alert">
                <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                <span>{refreshError}</span>
                <button
                  type="button"
                  onClick={() => setRefreshError(null)}
                  style={{ marginLeft: "auto", background: "transparent", border: 0, color: "inherit", cursor: "pointer" }}
                  title="Dismiss"
                >
                  <X size={13} />
                </button>
              </div>
            )}

          {loadingDetail ? (
            <div className="state-card">
              <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              Loading pool details…
            </div>
          ) : detailError ? (
            <div className="state-card error" role="alert">
              <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              {detailError}
            </div>
          ) : poolDetail ? (
            <section className="pool-detail-card" aria-label="Pool Details">
              <div className="pool-detail-card-header">
                <div className="pool-detail-card-title">
                  <h3>{poolDetail.pair}</h3>
                  <span className="pool-detail-badge">DLMM</span>
                </div>
                <button
                  className={`refresh-pool-btn ${isRefreshing ? "refreshing" : ""} ${refreshSuccess ? "success" : ""}`}
                  onClick={handleRefreshPool}
                  disabled={isRefreshing}
                  type="button"
                  title={isRefreshing ? getRefreshStageLabel(refreshStage) : "Refresh pool data from source"}
                >
                  <RefreshCw size={12} className={isRefreshing ? "spin" : ""} />
                  <span>
                    {isRefreshing
                      ? getRefreshStageLabel(refreshStage)
                      : refreshSuccess
                      ? "Updated"
                      : "Refresh Pool Data"}
                  </span>
                </button>
              </div>
              <dl className="pool-detail-grid">
                <div className="pool-detail-item">
                  <dt>Pair</dt>
                  <dd>{poolDetail.pair}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Pool Address</dt>
                  <dd className="pool-detail-address" title={poolDetail.poolAddress}>
                    <span>{shortWallet(poolDetail.poolAddress, 6, 4)}</span>
                    <CopyButton text={poolDetail.poolAddress} label="Copy pool address" />
                  </dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Token Mint</dt>
                  <dd className="pool-detail-address" title={poolDetail.tokenMint}>
                    <span>{shortWallet(poolDetail.tokenMint, 6, 4)}</span>
                    <CopyButton text={poolDetail.tokenMint} label="Copy token mint" />
                  </dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Bin Step</dt>
                  <dd>{poolDetail.binStep}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Base Fee</dt>
                  <dd>{poolDetail.baseFeePct}%</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Wallet Count</dt>
                  <dd>{poolDetail.walletCount.toLocaleString()}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Trade Count</dt>
                  <dd>{poolDetail.tradeCount.toLocaleString()}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>First Scanned</dt>
                  <dd>{formatTimestamp(poolDetail.firstScannedAt)}</dd>
                </div>
                <div className="pool-detail-item">
                  <dt>Last Scanned</dt>
                  <dd>{formatTimestamp(poolDetail.lastScannedAt)}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          {/* TRADE FILTER SECTION */}
          <section className="pool-trade-filter-card" aria-label="Trade Filter">
            <div className="pool-trade-filter-header">
              <div className="pool-trade-filter-title">
                <Filter size={14} />
                <h4>Trade Filter</h4>
              </div>
              <span className="pool-trade-filter-subtitle">
                {matchMode === "individual"
                  ? "Find wallets based on individual trade characteristics. All active conditions must be satisfied by the same trade."
                  : matchMode === "cumulative"
                  ? "Find wallets based on official Fabriq cumulative DLMM position performance for this pool. All active conditions apply to the same Fabriq aggregate."
                  : "Find wallets based on individual trades and Fabriq cumulative pool aggregates."}
              </span>
            </div>

            <div className="pool-trade-filter-mode-row">
              <div className="pool-trade-filter-group">
                <label className="pool-trade-filter-label">Match Mode</label>
                <div className="pool-mode-buttons" role="group" aria-label="Match Mode">
                  <button
                    type="button"
                    className={`pool-mode-btn ${matchMode === "individual" ? "active" : ""}`}
                    onClick={() => setMatchMode("individual")}
                  >
                    Individual
                  </button>
                  <button
                    type="button"
                    className={`pool-mode-btn ${matchMode === "cumulative" ? "active" : ""}`}
                    onClick={() => setMatchMode("cumulative")}
                  >
                    Cumulative
                  </button>
                  <button
                    type="button"
                    className={`pool-mode-btn ${matchMode === "both" ? "active" : ""}`}
                    onClick={() => setMatchMode("both")}
                  >
                    Both
                  </button>
                </div>
              </div>

            </div>

            <div className="pool-trade-filter-grid">
              <div className="pool-trade-filter-group">
                <label className="pool-trade-filter-label">
                  {matchMode === "individual" ? "Trade Duration" : matchMode === "cumulative" ? "Fabriq Duration" : "Duration"}
                </label>
                <div className="pool-range-inputs pool-duration-range-inputs">
                  <div className="pool-duration-pair">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Min h"
                      value={minDurationHours}
                      onChange={(e) => setMinDurationHours(e.target.value)}
                      className="pool-filter-input pool-duration-input"
                      aria-label="Minimum duration hours"
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      step="1"
                      placeholder="Min m"
                      value={minDurationMinutes}
                      onChange={(e) => setMinDurationMinutes(e.target.value)}
                      className="pool-filter-input pool-duration-input"
                      aria-label="Minimum duration minutes"
                    />
                  </div>
                  <span className="pool-range-sep">–</span>
                  <div className="pool-duration-pair">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Max h"
                      value={maxDurationHours}
                      onChange={(e) => setMaxDurationHours(e.target.value)}
                      className="pool-filter-input pool-duration-input"
                      aria-label="Maximum duration hours"
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      step="1"
                      placeholder="Max m"
                      value={maxDurationMinutes}
                      onChange={(e) => setMaxDurationMinutes(e.target.value)}
                      className="pool-filter-input pool-duration-input"
                      aria-label="Maximum duration minutes"
                    />
                  </div>
                </div>
              </div>

              <div className="pool-trade-filter-group">
                <label className="pool-trade-filter-label">
                  {matchMode === "individual" ? "Trade PnL (USD)" : matchMode === "cumulative" ? "Cumulative PnL (USD)" : "PnL (USD)"}
                </label>
                <div className="pool-range-inputs">
                  <input
                    type="number"
                    step="any"
                    placeholder="Min $"
                    value={minPnlUsdInput}
                    onChange={(e) => setMinPnlUsdInput(e.target.value)}
                    className="pool-filter-input"
                    aria-label="Minimum PnL in USD"
                  />
                  <span className="pool-range-sep">–</span>
                  <input
                    type="number"
                    step="any"
                    placeholder="Max $"
                    value={maxPnlUsdInput}
                    onChange={(e) => setMaxPnlUsdInput(e.target.value)}
                    className="pool-filter-input"
                    aria-label="Maximum PnL in USD"
                  />
                </div>
              </div>

              <div className="pool-trade-filter-group">
                <label className="pool-trade-filter-label">
                  {matchMode === "individual" ? "Trade PnL %" : matchMode === "cumulative" ? "Cumulative PnL %" : "PnL %"}
                </label>
                <div className="pool-range-inputs">
                  <input
                    type="number"
                    step="any"
                    placeholder="Min %"
                    value={minPnlPctInput}
                    onChange={(e) => setMinPnlPctInput(e.target.value)}
                    className="pool-filter-input"
                    aria-label="Minimum PnL percentage"
                  />
                  <span className="pool-range-sep">–</span>
                  <input
                    type="number"
                    step="any"
                    placeholder="Max %"
                    value={maxPnlPctInput}
                    onChange={(e) => setMaxPnlPctInput(e.target.value)}
                    className="pool-filter-input"
                    aria-label="Maximum PnL percentage"
                  />
                </div>
              </div>
            </div>

            <div className="pool-trade-filter-actions">
              <button
                type="button"
                className="primary-button"
                onClick={handleApplyFilter}
                disabled={isFiltering}
              >
                {isFiltering ? (
                  <>
                    <Loader2 size={12} className="spin" style={{ marginRight: 6 }} />
                    <span>Filtering…</span>
                  </>
                ) : (
                  "Apply Filter"
                )}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleClearFilter}
                disabled={isFiltering}
              >
                Clear
              </button>

              {filterValidationMsg && (
                <span className="pool-filter-validation-msg" role="status">
                  {filterValidationMsg}
                </span>
              )}
            </div>

            {filterError && (
              <div className="state-card error" style={{ marginTop: 14 }} role="alert">
                <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                <span>{filterError}</span>
                <button
                  type="button"
                  onClick={() => setFilterError(null)}
                  style={{
                    marginLeft: "auto",
                    background: "transparent",
                    border: 0,
                    color: "inherit",
                    cursor: "pointer",
                  }}
                  title="Dismiss"
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </section>

          {/* TRADE FILTER RESULTS SECTION */}
          {isFiltering ? (
            <div className="state-card" style={{ marginTop: 16 }}>
              <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              Filtering trades...
            </div>
          ) : filterResponse ? (() => {
            const activeMode: PoolTradeMatchMode =
              filterResponse.filters?.matchMode ?? matchMode ?? "individual";
            const filterWallets = Array.isArray(filterResponse.wallets) ? filterResponse.wallets : [];
            const filterGroups = Array.isArray(filterResponse.cumulativeGroups) ? filterResponse.cumulativeGroups : [];

            const isCompletelyEmpty =
              activeMode === "individual"
                ? filterWallets.length === 0
                : activeMode === "cumulative"
                ? filterGroups.length === 0
                : filterWallets.length === 0 && filterGroups.length === 0;

            if (isCompletelyEmpty) {
              if (activeMode === "cumulative") {
                if (filterResponse.cumulativeStatus === "unavailable") {
                  return (
                    <div className="state-card" style={{ marginTop: 16 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", padding: "14px 0" }}>
                        <strong style={{ color: "var(--text)", fontSize: 13 }}>
                          Fabriq Cumulative Aggregates Unavailable
                        </strong>
                        <span style={{ color: "var(--muted)", fontSize: 12, maxWidth: 500, textAlign: "center" }}>
                          Official Fabriq cumulative aggregate data has not been extracted for this pool yet. You can refresh a single wallet's aggregate directly from Fabriq via CDP bridge without rescanning the pool.
                        </span>
                        <div style={{ display: "flex", gap: 8, marginTop: 4, width: "100%", maxWidth: 460 }}>
                          <input
                            type="text"
                            placeholder="Wallet address to refresh (e.g. 73ZALH...)"
                            value={targetedWalletInput}
                            onChange={(e) => setTargetedWalletInput(e.target.value)}
                            className="pool-filter-input"
                            style={{ fontSize: 12, height: 34 }}
                            disabled={isRefreshingCumulative}
                          />
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => handleTargetedCumulativeRefresh()}
                            disabled={isRefreshingCumulative || !targetedWalletInput.trim()}
                            style={{ height: 34, fontSize: 11, padding: "0 12px", whiteSpace: "nowrap" }}
                          >
                            {isRefreshingCumulative ? (
                              <>
                                <Loader2 className="spin" size={12} style={{ marginRight: 5 }} />
                                Refreshing...
                              </>
                            ) : (
                              <>
                                <RefreshCw size={12} style={{ marginRight: 5 }} />
                                Refresh Fabriq Aggregate
                              </>
                            )}
                          </button>
                        </div>
                        {targetedRefreshStatus && (
                          <div style={{ fontSize: 12, color: targetedRefreshStatus.type === "success" ? "var(--green)" : "#ef4444" }}>
                            {targetedRefreshStatus.message}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="state-card" style={{ marginTop: 16 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", padding: "14px 0" }}>
                      <strong style={{ color: "var(--text)", fontSize: 13 }}>
                        No Fabriq cumulative groups match these filters
                      </strong>
                      <span style={{ color: "var(--muted)", fontSize: 12, maxWidth: 480, textAlign: "center" }}>
                        {(filterResponse.totalPoolAggregates ?? 0).toLocaleString()} Fabriq cumulative {filterResponse.totalPoolAggregates === 1 ? "record" : "records"} evaluated for this pool, but none satisfied all active filter conditions.
                      </span>
                      {filterResponse.cumulativeStatus === "stale" && (
                        <span className="alerts-badge alerts-badge-amber" style={{ fontSize: 10, padding: "2px 8px" }}>
                          Stored aggregates are older than 24h
                        </span>
                      )}
                      <div style={{ display: "flex", gap: 8, marginTop: 4, width: "100%", maxWidth: 460 }}>
                        <input
                          type="text"
                          placeholder="Refresh specific wallet (e.g. 73ZALH...)"
                          value={targetedWalletInput}
                          onChange={(e) => setTargetedWalletInput(e.target.value)}
                          className="pool-filter-input"
                          style={{ fontSize: 12, height: 34 }}
                          disabled={isRefreshingCumulative}
                        />
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => handleTargetedCumulativeRefresh()}
                          disabled={isRefreshingCumulative || !targetedWalletInput.trim()}
                          style={{ height: 34, fontSize: 11, padding: "0 12px", whiteSpace: "nowrap" }}
                        >
                          {isRefreshingCumulative ? (
                            <>
                              <Loader2 className="spin" size={12} style={{ marginRight: 5 }} />
                              Refreshing...
                            </>
                          ) : (
                            <>
                              <RefreshCw size={12} style={{ marginRight: 5 }} />
                              Refresh Fabriq Aggregate
                            </>
                          )}
                        </button>
                      </div>
                      {targetedRefreshStatus && (
                        <div style={{ fontSize: 12, color: targetedRefreshStatus.type === "success" ? "var(--green)" : "#ef4444" }}>
                          {targetedRefreshStatus.message}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              if (activeMode === "individual") {
                return (
                  <div className="state-card" style={{ marginTop: 16 }}>
                    No individual trades match these filters.
                  </div>
                );
              }

              return (
                <div className="state-card" style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", padding: "14px 0" }}>
                    <strong style={{ color: "var(--text)", fontSize: 13 }}>
                      No trades or Fabriq cumulative groups match these filters
                    </strong>
                    {filterResponse.cumulativeStatus === "unavailable" && (
                      <span style={{ color: "var(--muted)", fontSize: 12, maxWidth: 480, textAlign: "center" }}>
                        Fabriq cumulative aggregates have not been extracted for this pool yet.
                      </span>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 4, width: "100%", maxWidth: 460 }}>
                      <input
                        type="text"
                        placeholder="Refresh specific wallet (e.g. 73ZALH...)"
                        value={targetedWalletInput}
                        onChange={(e) => setTargetedWalletInput(e.target.value)}
                        className="pool-filter-input"
                        style={{ fontSize: 12, height: 34 }}
                        disabled={isRefreshingCumulative}
                      />
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => handleTargetedCumulativeRefresh()}
                        disabled={isRefreshingCumulative || !targetedWalletInput.trim()}
                        style={{ height: 34, fontSize: 11, padding: "0 12px", whiteSpace: "nowrap" }}
                      >
                        {isRefreshingCumulative ? (
                          <>
                            <Loader2 className="spin" size={12} style={{ marginRight: 5 }} />
                            Refreshing...
                          </>
                        ) : (
                          <>
                            <RefreshCw size={12} style={{ marginRight: 5 }} />
                            Refresh Fabriq Aggregate
                          </>
                        )}
                      </button>
                    </div>
                    {targetedRefreshStatus && (
                      <div style={{ fontSize: 12, color: targetedRefreshStatus.type === "success" ? "var(--green)" : "#ef4444" }}>
                        {targetedRefreshStatus.message}
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            const uniqueCumWallets = new Set(filterGroups.map((g) => g.wallet));
            const uniqueIndWallets = new Set(filterWallets.map((w) => w.wallet));
            const combinedWalletCount =
              activeMode === "individual"
                ? filterWallets.length
                : activeMode === "cumulative"
                ? uniqueCumWallets.size
                : new Set([...uniqueIndWallets, ...uniqueCumWallets]).size;

            const isViewingCumulative =
              activeMode === "cumulative" ||
              (activeMode === "both" && bothResultsTab === "cumulative");

            return (
              <section
                className="pool-insight-table-card"
                style={{ marginTop: 16 }}
                aria-label="Trade Filter Results"
              >
                <div className="pool-insight-table-toolbar">
                  <div className="pool-insight-table-toolbar-left">
                    <strong>
                      {combinedWalletCount.toLocaleString()}{" "}
                      {combinedWalletCount === 1 ? "wallet" : "wallets"} found
                    </strong>
                    {activeMode === "individual" && (
                      <span>
                        {(filterResponse.matchedTradeCount ?? 0).toLocaleString()} matching{" "}
                        {filterResponse.matchedTradeCount === 1 ? "trade" : "trades"}
                      </span>
                    )}
                    {activeMode === "cumulative" && (
                      <span>
                        {filterGroups.length.toLocaleString()} matching Fabriq cumulative{" "}
                        {filterGroups.length === 1 ? "group" : "groups"}
                      </span>
                    )}
                    {activeMode === "both" && (
                      <span>
                        {(filterResponse.matchedTradeCount ?? 0).toLocaleString()} individual trades,{" "}
                        {filterGroups.length.toLocaleString()} cumulative groups
                      </span>
                    )}
                  </div>
                  <div className="pool-insight-table-toolbar-right" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {isViewingCumulative && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="text"
                          placeholder="Target wallet..."
                          value={targetedWalletInput}
                          onChange={(e) => setTargetedWalletInput(e.target.value)}
                          className="pool-filter-input"
                          style={{ height: 28, fontSize: 11, width: 140 }}
                          disabled={isRefreshingCumulative}
                        />
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleTargetedCumulativeRefresh()}
                          disabled={isRefreshingCumulative || !targetedWalletInput.trim()}
                          style={{ height: 28, fontSize: 11, padding: "0 8px" }}
                          title="Refresh Fabriq cumulative aggregate for entered wallet"
                        >
                          {isRefreshingCumulative ? (
                            <Loader2 className="spin" size={12} />
                          ) : (
                            <>
                              <RefreshCw size={11} style={{ marginRight: 4 }} />
                              Refresh
                            </>
                          )}
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="secondary-button filter-toggle-all-btn"
                      onClick={handleToggleAllExpanded}
                    >
                      {isViewingCumulative
                        ? expandedGroups.size === filterGroups.length
                          ? "Collapse All"
                          : "Expand All"
                        : expandedWallets.size === filterWallets.length
                        ? "Collapse All"
                        : "Expand All"}
                    </button>
                  </div>
                </div>

                {activeMode === "both" && (
                  <div className="pool-filter-subtabs">
                    <button
                      type="button"
                      className={`pool-filter-subtab-btn ${bothResultsTab === "individual" ? "active" : ""}`}
                      onClick={() => setBothResultsTab("individual")}
                    >
                      Individual Trades ({filterWallets.length > 0 ? (filterResponse.matchedTradeCount ?? 0) : 0})
                    </button>
                    <button
                      type="button"
                      className={`pool-filter-subtab-btn ${bothResultsTab === "cumulative" ? "active" : ""}`}
                      onClick={() => setBothResultsTab("cumulative")}
                    >
                      Fabriq Cumulative ({filterGroups.length})
                    </button>
                  </div>
                )}

                {/* Individual View */}
                {(activeMode === "individual" ||
                  (activeMode === "both" && bothResultsTab === "individual")) && (
                  filterWallets.length === 0 ? (
                    <div className="state-card" style={{ margin: 16 }}>
                      No individual trades match these filters.
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="pool-insight-table filter-results-table">
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}></th>
                            <th>WALLET</th>
                            <th className="cell-number">MATCHED TRADES</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filterWallets.map((item) => {
                            const isExpanded = expandedWallets.has(item.wallet);
                            return (
                              <Fragment key={item.wallet}>
                                <tr
                                  className={`filter-wallet-row ${isExpanded ? "expanded" : ""}`}
                                  onClick={() => toggleWalletExpanded(item.wallet)}
                                  style={{ cursor: "pointer" }}
                                >
                                  <td style={{ width: 40, textAlign: "center" }}>
                                    <button
                                      type="button"
                                      className="filter-expand-btn"
                                      aria-label={isExpanded ? "Collapse trades" : "Expand trades"}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleWalletExpanded(item.wallet);
                                      }}
                                    >
                                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    </button>
                                  </td>
                                  <td>
                                    <div className="cell-address">
                                      <span>{shortWallet(item.wallet, 6, 4)}</span>
                                      <CopyButton text={item.wallet} label="Copy wallet address" />
                                      <button
                                        type="button"
                                        title="Fetch / Refresh Fabriq cumulative aggregate for this wallet"
                                        style={{ background: "transparent", border: 0, color: "var(--muted)", cursor: "pointer", padding: "0 2px" }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleTargetedCumulativeRefresh(item.wallet);
                                        }}
                                        disabled={isRefreshingCumulative}
                                      >
                                        <RefreshCw size={11} className={isRefreshingCumulative ? "spin" : ""} />
                                      </button>
                                    </div>
                                  </td>
                                  <td className="cell-number">
                                    <span className="matched-trades-badge">
                                      {item.matchedTradeCount}{" "}
                                      {item.matchedTradeCount === 1 ? "trade" : "trades"}
                                    </span>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr className="filter-wallet-details-row">
                                    <td colSpan={3} style={{ padding: 0 }}>
                                      <div className="filter-wallet-trades-wrapper">
                                        <table className="filter-nested-trades-table">
                                          <thead>
                                            <tr>
                                              <th>POSITION</th>
                                              <th>OPENED</th>
                                              <th>CLOSED</th>
                                              <th className="cell-number">DURATION</th>
                                              <th className="cell-number">PNL</th>
                                              <th className="cell-number">PNL %</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {item.trades.map((t) => (
                                              <tr key={t.positionId}>
                                                <td>
                                                  <div className="cell-address">
                                                    <span title={t.positionId}>
                                                      {shortWallet(t.positionId, 6, 4)}
                                                    </span>
                                                    <CopyButton
                                                      text={t.positionId}
                                                      label="Copy position ID"
                                                    />
                                                  </div>
                                                </td>
                                                <td>{formatTimestamp(t.openedAt)}</td>
                                                <td>{formatTimestamp(t.closedAt)}</td>
                                                <td className="cell-number">
                                                  {formatDuration(t.durationSeconds)}
                                                </td>
                                                <td
                                                  className={`cell-number ${
                                                    t.pnlUsd > 0
                                                      ? "positive"
                                                      : t.pnlUsd < 0
                                                      ? "negative"
                                                      : ""
                                                  }`}
                                                >
                                                  {formatUsd(t.pnlUsd)}
                                                </td>
                                                <td
                                                  className={`cell-number ${
                                                    t.pnlPct > 0
                                                      ? "positive"
                                                      : t.pnlPct < 0
                                                      ? "negative"
                                                      : ""
                                                  }`}
                                                >
                                                  {formatPct(t.pnlPct)}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                )}

                {/* Cumulative View */}
                {(activeMode === "cumulative" ||
                  (activeMode === "both" && bothResultsTab === "cumulative")) && (
                  filterResponse.cumulativeStatus === "unavailable" ? (
                    <div className="state-card" style={{ margin: 16 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", padding: "14px 0" }}>
                        <strong style={{ color: "var(--text)", fontSize: 13 }}>Fabriq Cumulative Aggregate Unavailable</strong>
                        <span style={{ color: "var(--muted)", fontSize: 12, maxWidth: 480, textAlign: "center" }}>
                          Official Fabriq cumulative data has not been extracted for this pool yet. You can refresh a single wallet's aggregate directly from Fabriq via CDP bridge without rescanning the pool.
                        </span>
                        <div style={{ display: "flex", gap: 8, marginTop: 4, width: "100%", maxWidth: 460 }}>
                          <input
                            type="text"
                            placeholder="Wallet address to refresh (e.g. 73ZALH...)"
                            value={targetedWalletInput}
                            onChange={(e) => setTargetedWalletInput(e.target.value)}
                            className="pool-filter-input"
                            style={{ fontSize: 12, height: 34 }}
                            disabled={isRefreshingCumulative}
                          />
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => handleTargetedCumulativeRefresh()}
                            disabled={isRefreshingCumulative || !targetedWalletInput.trim()}
                            style={{ height: 34, fontSize: 11, padding: "0 12px", whiteSpace: "nowrap" }}
                          >
                            {isRefreshingCumulative ? (
                              <>
                                <Loader2 className="spin" size={12} style={{ marginRight: 5 }} />
                                Refreshing...
                              </>
                            ) : (
                              <>
                                <RefreshCw size={12} style={{ marginRight: 5 }} />
                                Refresh Fabriq Aggregate
                              </>
                            )}
                          </button>
                        </div>
                        {targetedRefreshStatus && (
                          <div style={{ fontSize: 12, color: targetedRefreshStatus.type === "success" ? "var(--green)" : "#ef4444" }}>
                            {targetedRefreshStatus.message}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : filterGroups.length === 0 ? (
                    <div className="state-card" style={{ margin: 16 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", padding: "14px 0" }}>
                        <strong style={{ color: "var(--text)", fontSize: 13 }}>No Fabriq cumulative groups match these filters</strong>
                        <span style={{ color: "var(--muted)", fontSize: 12, maxWidth: 480, textAlign: "center" }}>
                          {(filterResponse.totalPoolAggregates ?? 0).toLocaleString()} Fabriq cumulative {filterResponse.totalPoolAggregates === 1 ? "record" : "records"} evaluated for this pool.
                        </span>
                        <div style={{ display: "flex", gap: 8, marginTop: 4, width: "100%", maxWidth: 460 }}>
                          <input
                            type="text"
                            placeholder="Refresh specific wallet (e.g. 73ZALH...)"
                            value={targetedWalletInput}
                            onChange={(e) => setTargetedWalletInput(e.target.value)}
                            className="pool-filter-input"
                            style={{ fontSize: 12, height: 34 }}
                            disabled={isRefreshingCumulative}
                          />
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => handleTargetedCumulativeRefresh()}
                            disabled={isRefreshingCumulative || !targetedWalletInput.trim()}
                            style={{ height: 34, fontSize: 11, padding: "0 12px", whiteSpace: "nowrap" }}
                          >
                            {isRefreshingCumulative ? (
                              <>
                                <Loader2 className="spin" size={12} style={{ marginRight: 5 }} />
                                Refreshing...
                              </>
                            ) : (
                              <>
                                <RefreshCw size={12} style={{ marginRight: 5 }} />
                                Refresh Fabriq Aggregate
                              </>
                            )}
                          </button>
                        </div>
                        {targetedRefreshStatus && (
                          <div style={{ fontSize: 12, color: targetedRefreshStatus.type === "success" ? "var(--green)" : "#ef4444" }}>
                            {targetedRefreshStatus.message}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="pool-insight-table filter-results-table">
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}></th>
                            <th>WALLET</th>
                            <th>PAIR / POOL</th>
                            <th className="cell-number">POSITIONS</th>
                            <th className="cell-number">FABRIQ DURATION</th>
                            <th className="cell-number">CUMULATIVE PNL</th>
                            <th className="cell-number">CUMULATIVE PNL %</th>
                            <th>CAPITAL FLOWS & FEES</th>
                            <th>LAST CLOSE</th>
                            <th>SOURCE</th>
                            <th>LAST UPDATED</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filterGroups.map((group) => {
                            const hasPositions = Boolean(group.positions && group.positions.length > 0);
                            const isExpanded = expandedGroups.has(group.groupId);
                            return (
                              <Fragment key={group.groupId}>
                                <tr
                                  className={`filter-wallet-row ${isExpanded ? "expanded" : ""}`}
                                  onClick={() => hasPositions && toggleGroupExpanded(group.groupId)}
                                  style={{ cursor: hasPositions ? "pointer" : "default" }}
                                >
                                  <td style={{ width: 40, textAlign: "center" }}>
                                    {hasPositions ? (
                                      <button
                                        type="button"
                                        className="filter-expand-btn"
                                        aria-label={isExpanded ? "Collapse positions" : "Expand positions"}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleGroupExpanded(group.groupId);
                                        }}
                                      >
                                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                      </button>
                                    ) : null}
                                  </td>
                                  <td>
                                    <div className="cell-address">
                                      <span>{shortWallet(group.wallet, 6, 4)}</span>
                                      <CopyButton text={group.wallet} label="Copy wallet address" />
                                    </div>
                                  </td>
                                  <td>
                                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                                      {group.pair || poolDetail?.pair || shortWallet(group.poolAddress || "", 6, 4)}
                                    </span>
                                  </td>
                                  <td className="cell-number">
                                    <span className="matched-trades-badge">
                                      {group.positionCount !== null ? `${group.positionCount} pos` : "—"}
                                    </span>
                                  </td>
                                  <td className="cell-number">
                                    {formatDuration(group.cumulativeDurationSeconds)}
                                  </td>
                                  <td
                                    className={`cell-number ${
                                      group.cumulativePnlUsd !== null && group.cumulativePnlUsd > 0
                                        ? "positive"
                                        : group.cumulativePnlUsd !== null && group.cumulativePnlUsd < 0
                                        ? "negative"
                                        : ""
                                    }`}
                                  >
                                    {formatUsd(group.cumulativePnlUsd)}
                                  </td>
                                  <td
                                    className={`cell-number ${
                                      group.cumulativePnlPct !== null && group.cumulativePnlPct > 0
                                        ? "positive"
                                        : group.cumulativePnlPct !== null && group.cumulativePnlPct < 0
                                        ? "negative"
                                        : ""
                                    }`}
                                  >
                                    {group.cumulativePnlPct !== null
                                      ? formatPct(group.cumulativePnlPct)
                                      : "—"}
                                  </td>
                                  <td>
                                    <div className="filter-capital-flows">
                                      {group.totalAddUsd !== null && group.totalAddUsd !== undefined && (
                                        <span className="flow-add" title="Total Deposits">+{formatUsd(group.totalAddUsd)}</span>
                                      )}
                                      {group.totalRemUsd !== null && group.totalRemUsd !== undefined && (
                                        <span className="flow-rem" title="Total Withdrawals">-{formatUsd(group.totalRemUsd)}</span>
                                      )}
                                      {group.totalFeeUsd !== null && group.totalFeeUsd !== undefined && group.totalFeeUsd > 0 && (
                                        <span className="fee-badge" title="Total Fees Earned">fee {formatUsd(group.totalFeeUsd)}</span>
                                      )}
                                      {group.totalAddUsd === null && group.totalRemUsd === null && group.totalFeeUsd === null && (
                                        <span style={{ color: "var(--muted)" }}>—</span>
                                      )}
                                    </div>
                                  </td>
                                  <td>
                                    <span>{formatTimestamp(group.latestClosedAt)}</span>
                                  </td>
                                  <td>
                                    <span className="filter-source-badge">{group.source || "Fabriq"}</span>
                                  </td>
                                  <td>
                                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                      <span style={{ color: "var(--muted)", fontSize: 11 }}>{formatTimestamp(group.lastUpdated)}</span>
                                      {group.isStale && (
                                        <span className="alerts-badge alerts-badge-amber" style={{ fontSize: 9, padding: "1px 4px" }} title="Record is older than 24h">
                                          STALE
                                        </span>
                                      )}
                                      <button
                                        type="button"
                                        title="Refresh Fabriq cumulative aggregate for this wallet"
                                        style={{ background: "transparent", border: 0, color: "var(--muted)", cursor: "pointer", padding: 2 }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleTargetedCumulativeRefresh(group.wallet);
                                        }}
                                        disabled={isRefreshingCumulative}
                                      >
                                        <RefreshCw size={11} className={isRefreshingCumulative ? "spin" : ""} />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                                {isExpanded && hasPositions && (
                                  <tr className="filter-wallet-details-row">
                                    <td colSpan={11} style={{ padding: 0 }}>
                                      <div className="filter-wallet-trades-wrapper">
                                        <table className="filter-nested-trades-table">
                                          <thead>
                                            <tr>
                                              <th>POSITION</th>
                                              <th>OPENED</th>
                                              <th>CLOSED</th>
                                              <th className="cell-number">DURATION</th>
                                              <th className="cell-number">PNL</th>
                                              <th className="cell-number">PNL %</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {(group.positions || []).map((pos) => (
                                              <tr key={pos.positionId}>
                                                <td>
                                                  <div className="cell-address">
                                                    <span title={pos.positionId}>
                                                      {shortWallet(pos.positionId, 6, 4)}
                                                    </span>
                                                    <CopyButton
                                                      text={pos.positionId}
                                                      label="Copy position ID"
                                                    />
                                                  </div>
                                                </td>
                                                <td>{formatTimestamp(pos.openedAt)}</td>
                                                <td>{formatTimestamp(pos.closedAt)}</td>
                                                <td className="cell-number">
                                                  {formatDuration(pos.durationSeconds)}
                                                </td>
                                                <td
                                                  className={`cell-number ${
                                                    pos.pnlUsd > 0
                                                      ? "positive"
                                                      : pos.pnlUsd < 0
                                                      ? "negative"
                                                      : ""
                                                  }`}
                                                >
                                                  {formatUsd(pos.pnlUsd)}
                                                </td>
                                                <td
                                                  className={`cell-number ${
                                                    pos.pnlPct > 0
                                                      ? "positive"
                                                      : pos.pnlPct < 0
                                                      ? "negative"
                                                      : ""
                                                  }`}
                                                >
                                                  {formatPct(pos.pnlPct)}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
              </section>
            );
          })() : null}

          {/* POOL WALLET TABLE */}
          <section className="pool-insight-table-card" style={{ marginTop: 20 }} aria-label="Pool Wallets">
            <div className="pool-insight-table-toolbar">
              <div className="pool-insight-table-toolbar-left">
                <strong>{wallets.length.toLocaleString()} Wallets</strong>
                <span>active in {poolDetail?.pair ?? "pool"}</span>
              </div>
              <div className="pool-insight-table-toolbar-right">
                <span>Values in USD</span>
              </div>
            </div>

            {loadingWallets ? (
              <div className="state-card">
                <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                Loading pool wallets…
              </div>
            ) : walletsError ? (
              <div className="state-card error" role="alert">
                <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                {walletsError}
              </div>
            ) : wallets.length === 0 ? (
              <div className="state-card">No wallets found for this pool.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="pool-insight-table">
                  <thead>
                    <tr>
                      <th>WALLET</th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("pnlUsd")}
                        >
                          POOL PNL
                          <span className={`sort-indicator ${sortKey === "pnlUsd" ? "active" : ""}`}>
                            {sortKey === "pnlUsd" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("winRate")}
                        >
                          WIN RATE
                          <span className={`sort-indicator ${sortKey === "winRate" ? "active" : ""}`}>
                            {sortKey === "winRate" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("positions")}
                        >
                          POSITIONS
                          <span className={`sort-indicator ${sortKey === "positions" ? "active" : ""}`}>
                            {sortKey === "positions" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="table-sort-btn"
                          onClick={() => handleSort("tradeCount")}
                        >
                          TRADES
                          <span className={`sort-indicator ${sortKey === "tradeCount" ? "active" : ""}`}>
                            {sortKey === "tradeCount" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((w) => (
                      <tr
                        key={w.wallet}
                        className="clickable-row"
                        onClick={() => handleOpenTrades(w.wallet)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleOpenTrades(w.wallet);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        title={`View trade history for ${w.wallet}`}
                        aria-label={`View trade history for wallet ${shortWallet(w.wallet, 6, 4)}`}
                      >
                        <td>
                          <div className="cell-address">
                            <span>{shortWallet(w.wallet, 6, 4)}</span>
                            <CopyButton text={w.wallet} label="Copy wallet address" />
                          </div>
                        </td>
                        <td
                          className={`cell-number ${
                            w.pnlUsd > 0 ? "positive" : w.pnlUsd < 0 ? "negative" : ""
                          }`}
                        >
                          {formatUsd(w.pnlUsd)}
                        </td>
                        <td className="cell-number">
                          {w.winRate !== null && Number.isFinite(w.winRate)
                            ? `${w.winRate.toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="cell-number">{w.positions.toLocaleString()}</td>
                        <td className="cell-number">
                          <div className="cell-trades-cta">
                            <span>{w.tradeCount.toLocaleString()}</span>
                            <span className="view-trades-pill">View Trades →</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )) : (
        /* POOL EXPLORER: SCANNED POOLS LIST GROUPED BY TOKEN */
        <section className="pool-insight-table-card" aria-label="Scanned Pools">
          <div className="pool-insight-table-toolbar">
            <div className="pool-insight-table-toolbar-left">
              <strong>
                {searchQuery.trim()
                  ? `${visibleGroups.length.toLocaleString()} of ${tokenGroups.length.toLocaleString()} Token ${tokenGroups.length === 1 ? "Group" : "Groups"}`
                  : `${tokenGroups.length.toLocaleString()} Token ${tokenGroups.length === 1 ? "Group" : "Groups"}`}
              </strong>
              <span>({pools.length.toLocaleString()} Scanned DLMM {pools.length === 1 ? "Pool" : "Pools"})</span>
            </div>
            <div className="pool-insight-table-toolbar-right">
              <div className="pool-search-box">
                <Search size={13} className="pool-search-icon" aria-hidden="true" />
                <input
                  type="text"
                  className="pool-search-input"
                  placeholder="Search pool name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search pool name"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="pool-search-clear-btn"
                    onClick={() => setSearchQuery("")}
                    aria-label="Clear search"
                    title="Clear search"
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
              {visibleGroups.length > 0 && (
                <button
                  type="button"
                  className="secondary-button token-group-toggle-all-btn"
                  onClick={handleToggleAllGroups}
                >
                  {allVisibleExpanded ? "Collapse All" : "Expand All"}
                </button>
              )}
              <button
                className="icon-btn"
                onClick={loadPools}
                title="Refresh pools"
                type="button"
              >
                <RefreshCw size={13} className={loadingPools ? "spin" : ""} />
              </button>
            </div>
          </div>

          {loadingPools ? (
            <div className="state-card">
              <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              Loading scanned pools…
            </div>
          ) : poolsError ? (
            <div className="state-card error" role="alert">
              <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
              {poolsError}
            </div>
          ) : pools.length === 0 ? (
            <div className="state-card">No scanned pools found.</div>
          ) : visibleGroups.length === 0 ? (
            <div className="state-card pool-search-empty-state">
              <span>No pools found matching your search.</span>
              <button
                type="button"
                className="secondary-button pool-search-reset-btn"
                onClick={() => setSearchQuery("")}
              >
                Clear search
              </button>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="pool-insight-table token-groups-table">
                <thead>
                  <tr>
                    <th style={{ width: 44, textAlign: "center" }}></th>
                    <th>TOKEN / PAIR</th>
                    <th>TOKEN MINT</th>
                    <th className="cell-number">SCANNED POOLS</th>
                    <th>LAST SCANNED</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups.map((group) => {
                    const isExpanded = expandedGroupKeys.has(group.groupKey);
                    return (
                      <Fragment key={group.groupKey}>
                        <tr
                          className={`token-group-row clickable-row ${isExpanded ? "expanded" : ""}`}
                          onClick={() => toggleGroup(group.groupKey)}
                          title={`${isExpanded ? "Collapse" : "Expand"} ${group.tokenName} pools`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleGroup(group.groupKey);
                            }
                          }}
                        >
                          <td style={{ width: 44, textAlign: "center" }}>
                            <button
                              type="button"
                              className="token-group-expand-btn"
                              aria-label={isExpanded ? `Collapse ${group.tokenName}` : `Expand ${group.tokenName}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGroup(group.groupKey);
                              }}
                            >
                              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td>
                            <span className="cell-pair">{group.tokenName}</span>
                          </td>
                          <td>
                            {group.tokenMint ? (
                              <div className="cell-address">
                                <span>{shortWallet(group.tokenMint, 6, 4)}</span>
                                <CopyButton text={group.tokenMint} label="Copy token mint" />
                              </div>
                            ) : (
                              <span className="cell-muted">—</span>
                            )}
                          </td>
                          <td className="cell-number">
                            <span className="token-pools-badge">
                              {group.poolCount} {group.poolCount === 1 ? "Pool" : "Pools"}
                            </span>
                          </td>
                          <td>{formatTimestamp(group.mostRecentScanAt)}</td>
                        </tr>

                        {isExpanded && (
                          <tr className="token-group-details-row">
                            <td colSpan={5} style={{ padding: 0 }}>
                              <div className="token-group-pools-wrapper">
                                <table className="token-group-nested-pools-table">
                                  <thead>
                                    <tr>
                                      <th>POOL ADDRESS</th>
                                      <th className="cell-number">BIN STEP</th>
                                      <th className="cell-number">BASE FEE</th>
                                      <th className="cell-number">WALLETS</th>
                                      <th className="cell-number">TRADES</th>
                                      <th>LAST SCANNED</th>
                                      <th style={{ width: 50 }}></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {group.pools.map((pool) => {
                                      const isSelected = selectedPoolAddress === pool.poolAddress;
                                      return (
                                        <tr
                                          key={pool.poolAddress}
                                          className={`token-pool-row clickable-row ${isSelected ? "selected-pool" : ""}`}
                                          onClick={() => updateNav("intelligence", pool.poolAddress)}
                                          title={`Open ${pool.pair} (${shortWallet(pool.poolAddress, 6, 4)}) pool intelligence`}
                                          role="button"
                                          tabIndex={0}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                              e.preventDefault();
                                              updateNav("intelligence", pool.poolAddress);
                                            }
                                          }}
                                        >
                                          <td>
                                            <div className="cell-address">
                                              <span>{shortWallet(pool.poolAddress, 6, 4)}</span>
                                              <CopyButton text={pool.poolAddress} label="Copy pool address" />
                                            </div>
                                          </td>
                                          <td className="cell-number">{pool.binStep}</td>
                                          <td className="cell-number">{pool.baseFeePct}%</td>
                                          <td className="cell-number">{pool.walletCount.toLocaleString()}</td>
                                          <td className="cell-number">{pool.tradeCount.toLocaleString()}</td>
                                          <td>{formatTimestamp(pool.lastScannedAt)}</td>
                                          <td style={{ textAlign: "right" }}>
                                            <span className="token-pool-open-link">
                                              View <ArrowRight size={11} />
                                            </span>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* WALLET TRADE HISTORY DRILLDOWN MODAL */}
      {selectedWalletForTrades && (
        <div
          className="pool-insight-modal-overlay"
          onClick={handleCloseTrades}
          role="presentation"
        >
          <div
            className="pool-insight-modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-drilldown-title"
          >
            <div className="pool-insight-modal-header">
              <div className="pool-insight-modal-header-main">
                <div className="pool-insight-modal-title-row">
                  <h3 id="trade-drilldown-title">Trade History</h3>
                  {poolDetail?.pair && (
                    <span className="pool-detail-badge">{poolDetail.pair}</span>
                  )}
                  <span className="pool-modal-count-badge">
                    {loadingTrades
                      ? "Loading…"
                      : `${walletTrades.length} Trade${walletTrades.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                <div className="pool-insight-modal-wallet-row">
                  <span className="pool-insight-modal-wallet-label">WALLET</span>
                  <span className="pool-insight-modal-wallet-addr" title={selectedWalletForTrades}>
                    {selectedWalletForTrades}
                  </span>
                  <CopyButton text={selectedWalletForTrades} label="Copy wallet address" />
                </div>
              </div>
              <button
                type="button"
                className="pool-insight-modal-close-btn"
                onClick={handleCloseTrades}
                aria-label="Close trade history"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>

            <div className="pool-insight-modal-body">
              {loadingTrades ? (
                <div className="state-card">
                  <Loader2 className="spin" size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                  Loading trade history…
                </div>
              ) : tradesError ? (
                <div className="state-card error" role="alert">
                  <AlertCircle size={15} style={{ marginRight: 8, verticalAlign: "middle" }} />
                  {tradesError}
                </div>
              ) : walletTrades.length === 0 ? (
                <div className="state-card">
                  No closed-position trades recorded for this wallet in {poolDetail?.pair || "this pool"}.
                </div>
              ) : (
                <div className="pool-insight-modal-table-wrap">
                  <table className="pool-insight-table">
                    <thead>
                      <tr>
                        <th>POSITION</th>
                        <th>OPENED</th>
                        <th>CLOSED</th>
                        <th>DURATION</th>
                        <th>PNL</th>
                        <th>PNL %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {walletTrades.map((t) => (
                        <tr key={t.positionId}>
                          <td>
                            <div className="cell-address">
                              <span title={t.positionId}>{shortWallet(t.positionId, 6, 4)}</span>
                              <CopyButton text={t.positionId} label="Copy position ID" />
                            </div>
                          </td>
                          <td>{formatTimestamp(t.openedAt)}</td>
                          <td>{formatTimestamp(t.closedAt)}</td>
                          <td className="cell-number">{formatDuration(t.durationSeconds)}</td>
                          <td
                            className={`cell-number ${
                              t.pnlUsd > 0 ? "positive" : t.pnlUsd < 0 ? "negative" : ""
                            }`}
                          >
                            {formatUsd(t.pnlUsd)}
                          </td>
                          <td
                            className={`cell-number ${
                              t.pnlPct > 0 ? "positive" : t.pnlPct < 0 ? "negative" : ""
                            }`}
                          >
                            {formatPct(t.pnlPct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
