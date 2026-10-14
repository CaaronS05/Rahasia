import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Bell,
  Play,
  Pause,
  RotateCw,
  Plus,
  Trash2,
  ExternalLink,
  Copy,
  Check,
  AlertTriangle,
  ShieldAlert,
  Info,
  Radio,
  Clock,
  Layers,
  Database,
  Search,
  Filter,
  X,
} from "lucide-react";
import {
  fetchAlertsStatus,
  fetchWatchlist,
  fetchActivePositions,
  fetchAlertEvents,
  fetchTelegramPreviews,
  addWatchlistWallet,
  startWalletMonitoring,
  pauseWalletMonitoring,
  resumeWalletMonitoring,
  removeWatchlistWallet,
  startAlertsEngine,
  pauseAlertsEngine,
  resumeAlertsEngine,
  isValidSolanaAddress,
  type AlertsStatus,
  type WatchlistWallet,
  type ActivePosition,
  type DlmmAlertEvent,
  type TelegramPreview,
  type DlmmEventType,
  type EngineStatus,
} from "../lib/alertsApi";
import "../alerts-view.css";

type TabId = "watchlist" | "positions" | "events" | "telegram";

function truncateAddress(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail) return addr || "—";
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

function formatWib(timestamp: number | null | undefined): string {
  if (!timestamp || timestamp <= 0) return "—";
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "—";
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d) + " WIB"
  );
}

function getEventTypeBadgeClass(eventType: DlmmEventType): string {
  switch (eventType) {
    case "POSITION_OPENED":
      return "alerts-badge-green";
    case "LIQUIDITY_ADDED":
      return "alerts-badge-blue";
    case "LIQUIDITY_REMOVED":
      return "alerts-badge-amber";
    case "POSITION_CLOSED":
      return "alerts-badge-purple";
    case "FEES_CLAIMED":
      return "alerts-badge-green";
    default:
      return "alerts-badge-muted";
  }
}

export function AlertsView() {
  const [activeTab, setActiveTab] = useState<TabId>("watchlist");

  // State from server
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [wallets, setWallets] = useState<WatchlistWallet[]>([]);
  const [positions, setPositions] = useState<ActivePosition[]>([]);
  const [events, setEvents] = useState<DlmmAlertEvent[]>([]);
  const [previews, setPreviews] = useState<TelegramPreview[]>([]);

  // Loading & error states
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Auto-refresh (5s default)
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  // Wallet form inputs
  const [newAddress, setNewAddress] = useState<string>("");
  const [newAlias, setNewAlias] = useState<string>("");
  const [addingWallet, setAddingWallet] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // In-flight mutations (addresses being modified)
  const [mutatingWallets, setMutatingWallets] = useState<Set<string>>(new Set());
  const [engineMutating, setEngineMutating] = useState<boolean>(false);

  // Modals & Drawers
  const [resumeModalWallet, setResumeModalWallet] = useState<WatchlistWallet | null>(null);
  const [deleteModalWallet, setDeleteModalWallet] = useState<WatchlistWallet | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<DlmmAlertEvent | null>(null);

  // Filters
  const [walletFilter, setWalletFilter] = useState<string>("ALL");
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Clipboard feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  }, []);

  const showFeedback = useCallback((type: "success" | "error", message: string) => {
    setActionFeedback({ type, message });
    setTimeout(() => {
      setActionFeedback((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  }, []);

  // Main data loader
  const loadData = useCallback(async (isBackground = false) => {
    if (!isBackground) setRefreshing(true);
    setServerError(null);

    try {
      const [statusRes, walletsRes, positionsRes, eventsRes, previewsRes] = await Promise.allSettled([
        fetchAlertsStatus(),
        fetchWatchlist(),
        fetchActivePositions(),
        fetchAlertEvents({ limit: 100 }),
        fetchTelegramPreviews({ limit: 100 }),
      ]);

      if (statusRes.status === "fulfilled") {
        setStatus(statusRes.value);
      } else {
        setStatus({
          status: "OFFLINE",
          isDegraded: false,
          sdkCompatible: false,
          monitoredWalletsCount: 0,
          activePositionsCount: 0,
          totalPolls: 0,
          totalEventsEmitted: 0,
          lastPollAt: null,
          retryCount: 0,
          errorCount: 0,
          coverageGaps: [],
          bufferedEventsCount: 0,
          bufferedPreviewsCount: 0,
        });
        setServerError("Control Server is unreachable at http://127.0.0.1:8787. Make sure it is running.");
      }

      if (walletsRes.status === "fulfilled") {
        setWallets(walletsRes.value);
      }

      if (positionsRes.status === "fulfilled") {
        setPositions(positionsRes.value);
        setPositionsError(null);
      } else {
        setPositionsError(positionsRes.reason instanceof Error ? positionsRes.reason.message : "Failed to discover active positions");
      }

      if (eventsRes.status === "fulfilled") {
        setEvents(eventsRes.value);
      }

      if (previewsRes.status === "fulfilled") {
        setPreviews(previewsRes.value);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Mobile viewport class toggle
  useEffect(() => {
    document.body.classList.add("viewing-alerts");
    return () => {
      document.body.classList.remove("viewing-alerts");
    };
  }, []);

  // Initial load
  useEffect(() => {
    loadData(false);
  }, [loadData]);

  // Periodic polling without extra RPC scans (only local control API in-memory reads)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      loadData(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  // Wallet address validation
  const isAddressValid = useMemo(() => {
    if (!newAddress.trim()) return false;
    return isValidSolanaAddress(newAddress.trim());
  }, [newAddress]);

  // Add wallet handler
  const handleAddWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedAddress = newAddress.trim();
    if (!isValidSolanaAddress(trimmedAddress)) {
      setFormError("Invalid Solana wallet address (must be valid Base58 public key)");
      return;
    }

    setAddingWallet(true);
    try {
      const added = await addWatchlistWallet(trimmedAddress, newAlias);
      showFeedback("success", `Added wallet ${truncateAddress(added.address)} to watchlist (disabled by default)`);
      setNewAddress("");
      setNewAlias("");
      await loadData(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to add wallet");
    } finally {
      setAddingWallet(false);
    }
  };

  // Wallet lifecycle actions
  const handleStartWallet = async (address: string) => {
    setMutatingWallets((prev) => new Set(prev).add(address));
    try {
      await startWalletMonitoring(address);
      showFeedback("success", `Started monitoring wallet ${truncateAddress(address)}`);
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to start monitoring");
    } finally {
      setMutatingWallets((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
    }
  };

  const handlePauseWallet = async (address: string) => {
    setMutatingWallets((prev) => new Set(prev).add(address));
    try {
      await pauseWalletMonitoring(address);
      showFeedback("success", `Paused monitoring wallet ${truncateAddress(address)}`);
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to pause monitoring");
    } finally {
      setMutatingWallets((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
    }
  };

  const handleConfirmFreshResume = async () => {
    if (!resumeModalWallet) return;
    const address = resumeModalWallet.address;
    setResumeModalWallet(null);
    setMutatingWallets((prev) => new Set(prev).add(address));
    try {
      await resumeWalletMonitoring(address);
      showFeedback("success", `Fresh resume executed for wallet ${truncateAddress(address)}. Missed activity was not replayed.`);
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to resume monitoring");
    } finally {
      setMutatingWallets((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteModalWallet) return;
    const address = deleteModalWallet.address;
    setDeleteModalWallet(null);
    setMutatingWallets((prev) => new Set(prev).add(address));
    try {
      await removeWatchlistWallet(address);
      showFeedback("success", `Removed wallet ${truncateAddress(address)} from watchlist`);
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to remove wallet");
    } finally {
      setMutatingWallets((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
    }
  };

  // Engine control actions
  const handleEngineStart = async () => {
    setEngineMutating(true);
    try {
      await startAlertsEngine();
      showFeedback("success", "Alerts engine started");
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to start engine");
    } finally {
      setEngineMutating(false);
    }
  };

  const handleEnginePause = async () => {
    setEngineMutating(true);
    try {
      await pauseAlertsEngine();
      showFeedback("success", "Alerts engine paused");
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to pause engine");
    } finally {
      setEngineMutating(false);
    }
  };

  const handleEngineResume = async () => {
    setEngineMutating(true);
    try {
      await resumeAlertsEngine();
      showFeedback("success", "Alerts engine resumed from current chain tip");
      await loadData(true);
    } catch (err) {
      showFeedback("error", err instanceof Error ? err.message : "Failed to resume engine");
    } finally {
      setEngineMutating(false);
    }
  };

  // Computed engine display state
  const effectiveStatus: EngineStatus = useMemo(() => {
    if (!status) return "OFFLINE";
    if (status.status === "OFFLINE") return "OFFLINE";
    if (status.isDegraded || status.status === "DEGRADED") return "DEGRADED";
    return status.status;
  }, [status]);

  const statusBadgeClass = useMemo(() => {
    switch (effectiveStatus) {
      case "RUNNING":
        return "alerts-status-running";
      case "PAUSED":
        return "alerts-status-paused";
      case "INITIALIZING":
        return "alerts-status-initializing";
      case "DEGRADED":
        return "alerts-status-degraded";
      case "STOPPED":
        return "alerts-status-stopped";
      case "OFFLINE":
        return "alerts-status-offline";
      default:
        return "alerts-status-idle";
    }
  }, [effectiveStatus]);

  // Filtered positions
  const filteredPositions = useMemo(() => {
    if (walletFilter === "ALL") return positions;
    return positions.filter((p) => p.owner === walletFilter);
  }, [positions, walletFilter]);

  // Filtered events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (walletFilter !== "ALL" && e.walletAddress !== walletFilter) return false;
      if (eventTypeFilter !== "ALL" && e.eventType !== eventTypeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchSig = e.signature.toLowerCase().includes(q);
        const matchPool = e.poolAddress.toLowerCase().includes(q);
        const matchPos = e.positionAddress.toLowerCase().includes(q);
        const matchWallet = e.walletAddress.toLowerCase().includes(q);
        if (!matchSig && !matchPool && !matchPos && !matchWallet) return false;
      }
      return true;
    });
  }, [events, walletFilter, eventTypeFilter, searchQuery]);

  // Filtered previews
  const filteredPreviews = useMemo(() => {
    return previews.filter((p) => {
      if (walletFilter !== "ALL" && p.walletAddress !== walletFilter) return false;
      if (eventTypeFilter !== "ALL" && p.eventType !== eventTypeFilter) return false;
      return true;
    });
  }, [previews, walletFilter, eventTypeFilter]);

  // Unique monitored wallet addresses for filter dropdown
  const uniqueWallets = useMemo(() => {
    const list: Array<{ address: string; alias: string | null }> = [];
    const seen = new Set<string>();
    for (const w of wallets) {
      if (!seen.has(w.address)) {
        seen.add(w.address);
        list.push({ address: w.address, alias: w.alias });
      }
    }
    return list;
  }, [wallets]);

  return (
    <div className="alerts-page">
      {/* Top Header */}
      <header className="alerts-header">
        <div className="alerts-title">
          <h1>
            <Bell size={22} color="var(--green, #55d69d)" />
            Alerts & Active Positions
          </h1>
          <p>Real-time Meteora DLMM active-position monitoring & dry-run alert engine</p>
        </div>

        <div className="alerts-header-actions">
          {/* Status Indicator */}
          <div className={`alerts-status-indicator ${statusBadgeClass}`}>
            <span
              className={`alerts-status-dot ${
                effectiveStatus === "RUNNING" || effectiveStatus === "INITIALIZING" ? "pulse" : ""
              }`}
            />
            <span>{effectiveStatus}</span>
          </div>

          {/* Engine Lifecycle Controls */}
          {effectiveStatus === "RUNNING" && (
            <button
              className="alerts-btn alerts-btn-warning"
              onClick={handleEnginePause}
              disabled={engineMutating}
              title="Pause monitoring for all wallets"
            >
              <Pause size={13} />
              Pause Engine
            </button>
          )}

          {effectiveStatus === "PAUSED" && (
            <button
              className="alerts-btn alerts-btn-primary"
              onClick={handleEngineResume}
              disabled={engineMutating}
              title="Fresh resume monitoring from chain tip"
            >
              <Play size={13} />
              Resume Engine
            </button>
          )}

          {(effectiveStatus === "IDLE" || effectiveStatus === "STOPPED") && (
            <button
              className="alerts-btn alerts-btn-primary"
              onClick={handleEngineStart}
              disabled={engineMutating}
              title="Start alerts monitoring engine"
            >
              <Play size={13} />
              Start Engine
            </button>
          )}

          {/* Auto Refresh Toggle */}
          <button
            className={`alerts-btn ${autoRefresh ? "alerts-btn-primary" : ""}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            title="Auto-refresh UI every 5 seconds (reads local control server RAM only)"
          >
            <Radio size={13} className={autoRefresh ? "pulse" : ""} />
            {autoRefresh ? "Auto (5s)" : "Auto: Off"}
          </button>

          {/* Manual Refresh */}
          <button
            className="alerts-btn"
            onClick={() => loadData(false)}
            disabled={refreshing}
            title="Refresh alerts state"
          >
            <RotateCw size={13} className={refreshing ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </header>

      {/* Notifications / Feedback Banner */}
      {actionFeedback && (
        <div
          className={`alerts-banner ${
            actionFeedback.type === "success" ? "alerts-banner-info" : "alerts-banner-error"
          }`}
        >
          <span>{actionFeedback.message}</span>
          <button
            className="alerts-link-btn"
            onClick={() => setActionFeedback(null)}
            aria-label="Close notification"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Server Offline / Error Banner */}
      {serverError && (
        <div className="alerts-banner alerts-banner-error">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={16} />
            <span>{serverError}</span>
          </div>
          <button className="alerts-btn" onClick={() => loadData(false)}>
            Retry Connection
          </button>
        </div>
      )}

      {/* Coverage Gaps / Degraded Warning */}
      {status && status.coverageGaps && status.coverageGaps.length > 0 && (
        <div className="alerts-banner alerts-banner-warning">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldAlert size={16} />
            <span>
              <strong>Monitoring Coverage Notice:</strong> {status.coverageGaps.length} coverage gap
              {status.coverageGaps.length === 1 ? "" : "s"} reported during polling (
              {status.coverageGaps.map((g) => `${truncateAddress(g.walletAddress)}: ${g.reason}`).join("; ")}
              ). Cursor was not advanced across gaps to preserve data integrity.
            </span>
          </div>
        </div>
      )}

      {/* Overview Metric Cards */}
      <div className="alerts-overview-grid">
        <div className="alerts-card">
          <div className="alerts-card-label">
            <Radio size={13} />
            Monitoring State
          </div>
          <div className="alerts-card-value" style={{ color: effectiveStatus === "RUNNING" ? "var(--green)" : "inherit" }}>
            {effectiveStatus}
          </div>
          <div className="alerts-card-subtext">
            {status?.sdkCompatible ? "SDK Compatible: Yes" : "Meteora DLMM Program Verified"}
          </div>
        </div>

        <div className="alerts-card">
          <div className="alerts-card-label">
            <Layers size={13} />
            Monitored Wallets
          </div>
          <div className="alerts-card-value">
            {status ? status.monitoredWalletsCount : 0}{" "}
            <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)" }}>
              / {wallets.length} in watchlist
            </span>
          </div>
          <div className="alerts-card-subtext">
            {wallets.filter((w) => w.enabled).length} configured enabled
          </div>
        </div>

        <div className="alerts-card">
          <div className="alerts-card-label">
            <Database size={13} />
            Active Positions
          </div>
          <div className="alerts-card-value">
            {status ? status.activePositionsCount : positions.length}
          </div>
          <div className="alerts-card-subtext">
            Open DLMM positions across active wallets
          </div>
        </div>

        <div className="alerts-card">
          <div className="alerts-card-label">
            <Bell size={13} />
            Recent Activity Buffer
          </div>
          <div className="alerts-card-value">
            {status ? status.bufferedEventsCount : events.length}{" "}
            <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)" }}>/ 100 max</span>
          </div>
          <div className="alerts-card-subtext">
            {status ? status.bufferedPreviewsCount : previews.length} Telegram previews in RAM
          </div>
        </div>

        <div className="alerts-card">
          <div className="alerts-card-label">
            <Clock size={13} />
            Last Successful Poll
          </div>
          <div className="alerts-card-value" style={{ fontSize: 15, paddingTop: 3 }}>
            {formatWib(status?.lastPollAt)}
          </div>
          <div className="alerts-card-subtext">
            Total engine polls: {status ? status.totalPolls : 0}
          </div>
        </div>

        <div className="alerts-card">
          <div className="alerts-card-label">
            <ShieldAlert size={13} />
            RPC Health & Retries
          </div>
          <div className="alerts-card-value">
            {status ? `${status.errorCount} err / ${status.retryCount} retries` : "0 / 0"}
          </div>
          <div className="alerts-card-subtext">
            {status?.coverageGaps ? `${status.coverageGaps.length} coverage gaps` : "0 gaps"}
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="alerts-tabs">
        <button
          className={`alerts-tab ${activeTab === "watchlist" ? "active" : ""}`}
          onClick={() => setActiveTab("watchlist")}
        >
          Wallet Watchlist
          <span className="alerts-tab-badge">{wallets.length}</span>
        </button>

        <button
          className={`alerts-tab ${activeTab === "positions" ? "active" : ""}`}
          onClick={() => setActiveTab("positions")}
        >
          Active Positions
          <span className="alerts-tab-badge">{positions.length}</span>
        </button>

        <button
          className={`alerts-tab ${activeTab === "events" ? "active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          Recent Activity
          <span className="alerts-tab-badge">{events.length}</span>
        </button>

        <button
          className={`alerts-tab ${activeTab === "telegram" ? "active" : ""}`}
          onClick={() => setActiveTab("telegram")}
        >
          Telegram Dry-Run Previews
          <span className="alerts-tab-badge">{previews.length}</span>
        </button>
      </div>

      {/* TAB 1: WATCHLIST */}
      {activeTab === "watchlist" && (
        <div className="alerts-section">
          {/* Add Wallet Form */}
          <form className="alerts-form-panel" onSubmit={handleAddWallet}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                Add Solana Wallet to Watchlist
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                New wallets default to disabled. Explicitly start monitoring to enroll.
              </div>
            </div>

            <div className="alerts-form-row">
              <input
                type="text"
                className="alerts-input alerts-input-address"
                placeholder="Enter Solana Base58 public key (32-44 characters)"
                value={newAddress}
                onChange={(e) => {
                  setNewAddress(e.target.value);
                  setFormError(null);
                }}
                disabled={addingWallet}
              />

              <input
                type="text"
                className="alerts-input alerts-input-alias"
                placeholder="Optional Alias (e.g. Whale 1)"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                disabled={addingWallet}
              />

              <button
                type="submit"
                className="alerts-btn alerts-btn-primary"
                disabled={!isAddressValid || addingWallet}
              >
                <Plus size={13} />
                {addingWallet ? "Adding..." : "Add Wallet"}
              </button>
            </div>

            {formError && (
              <div style={{ fontSize: 11.5, color: "var(--red)" }}>
                {formError}
              </div>
            )}
          </form>

          {/* Watchlist Table */}
          <div className="alerts-table-container">
            <table className="alerts-table">
              <thead>
                <tr>
                  <th>Wallet Address</th>
                  <th>Alias</th>
                  <th>Config State</th>
                  <th>Engine Runtime</th>
                  <th>Added At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {wallets.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: "32px 14px", color: "var(--muted)" }}>
                      No wallets in watchlist yet. Add a Solana address above to monitor active DLMM positions.
                    </td>
                  </tr>
                ) : (
                  wallets.map((w) => {
                    const isMutating = mutatingWallets.has(w.address);
                    const isMonitoredInRuntime =
                      w.enabled && effectiveStatus === "RUNNING";

                    return (
                      <tr key={w.address}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="alerts-monospace" title={w.address}>
                              {truncateAddress(w.address, 6, 6)}
                            </span>
                            <button
                              className="alerts-link-btn"
                              onClick={() => copyToClipboard(w.address, `w_${w.address}`)}
                              title="Copy full address"
                            >
                              {copiedKey === `w_${w.address}` ? (
                                <Check size={12} color="var(--green)" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                            <a
                              href={`https://explorer.solana.com/address/${w.address}`}
                              target="_blank"
                              rel="noreferrer"
                              className="alerts-link-btn"
                              title="View on Solana Explorer"
                            >
                              <ExternalLink size={12} />
                            </a>
                          </div>
                        </td>
                        <td>{w.alias ? w.alias : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                        <td>
                          {w.enabled ? (
                            <span className="alerts-badge alerts-badge-green">Config: Enabled</span>
                          ) : (
                            <span className="alerts-badge alerts-badge-muted">Config: Disabled</span>
                          )}
                        </td>
                        <td>
                          {effectiveStatus === "OFFLINE" ? (
                            <span className="alerts-badge alerts-badge-red">Server Offline</span>
                          ) : isMonitoredInRuntime ? (
                            <span className="alerts-badge alerts-badge-green">
                              <span className="alerts-status-dot pulse" style={{ width: 5, height: 5 }} />
                              Actively Monitored
                            </span>
                          ) : w.enabled && effectiveStatus === "PAUSED" ? (
                            <span className="alerts-badge alerts-badge-amber">Engine Paused</span>
                          ) : (
                            <span className="alerts-badge alerts-badge-muted">Not Enrolled</span>
                          )}
                        </td>
                        <td style={{ color: "var(--muted)" }}>{formatWib(w.addedAt)}</td>
                        <td>
                          <div className="alerts-actions-cell">
                            {w.enabled ? (
                              <button
                                className="alerts-btn alerts-btn-warning"
                                onClick={() => handlePauseWallet(w.address)}
                                disabled={isMutating}
                                title="Pause monitoring for this wallet"
                              >
                                <Pause size={11} />
                                Pause
                              </button>
                            ) : (
                              <>
                                <button
                                  className="alerts-btn alerts-btn-primary"
                                  onClick={() => handleStartWallet(w.address)}
                                  disabled={isMutating}
                                  title="Start monitoring for this wallet"
                                >
                                  <Play size={11} />
                                  Start
                                </button>
                                <button
                                  className="alerts-btn"
                                  onClick={() => setResumeModalWallet(w)}
                                  disabled={isMutating}
                                  title="Fresh resume monitoring without replaying missed events"
                                >
                                  <RotateCw size={11} />
                                  Fresh Resume
                                </button>
                              </>
                            )}

                            <button
                              className="alerts-btn alerts-btn-danger"
                              onClick={() => setDeleteModalWallet(w)}
                              disabled={isMutating}
                              title="Remove wallet from watchlist"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: ACTIVE POSITIONS */}
      {activeTab === "positions" && (
        <div className="alerts-section">
          {/* Positions Filter Bar */}
          <div className="alerts-filters-bar">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Filter size={13} color="var(--muted)" />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>Filter by Wallet:</span>
              <select
                className="alerts-input"
                value={walletFilter}
                onChange={(e) => setWalletFilter(e.target.value)}
              >
                <option value="ALL">All Monitored Wallets ({positions.length})</option>
                {uniqueWallets.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.alias ? `${w.alias} (${truncateAddress(w.address)})` : w.address}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
              Showing {filteredPositions.length} open position{filteredPositions.length === 1 ? "" : "s"}
            </div>
          </div>

          {/* Positions Error Display */}
          {positionsError && (
            <div className="alerts-banner alerts-banner-error">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={16} />
                <span>Error loading active positions: {positionsError}</span>
              </div>
              <button className="alerts-btn" onClick={() => loadData(false)}>
                Retry Discovery
              </button>
            </div>
          )}

          {/* Positions Table */}
          <div className="alerts-table-container">
            <table className="alerts-table">
              <thead>
                <tr>
                  <th>Position Address</th>
                  <th>Owner Wallet</th>
                  <th>Pool Address</th>
                  <th>Version</th>
                  <th>Liquidity Status</th>
                  <th>Discovered At</th>
                  <th>Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredPositions.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: "40px 14px", color: "var(--muted)" }}>
                      {positionsError
                        ? "Position discovery encountered an error (shown above)."
                        : "No active positions found for the selected wallet filter. Positions appear here once discovered on-chain."}
                    </td>
                  </tr>
                ) : (
                  filteredPositions.map((pos) => {
                    const ownerWallet = wallets.find((w) => w.address === pos.owner);
                    const ownerLabel = ownerWallet?.alias
                      ? `${ownerWallet.alias} (${truncateAddress(pos.owner)})`
                      : truncateAddress(pos.owner);

                    return (
                      <tr key={pos.positionAddress}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="alerts-monospace" title={pos.positionAddress}>
                              {truncateAddress(pos.positionAddress, 6, 6)}
                            </span>
                            <button
                              className="alerts-link-btn"
                              onClick={() => copyToClipboard(pos.positionAddress, `pos_${pos.positionAddress}`)}
                              title="Copy position address"
                            >
                              {copiedKey === `pos_${pos.positionAddress}` ? (
                                <Check size={12} color="var(--green)" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                            <a
                              href={`https://explorer.solana.com/address/${pos.positionAddress}`}
                              target="_blank"
                              rel="noreferrer"
                              className="alerts-link-btn"
                              title="View on Solana Explorer"
                            >
                              <ExternalLink size={12} />
                            </a>
                          </div>
                        </td>
                        <td>
                          <span title={pos.owner} className="alerts-monospace">
                            {ownerLabel}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <a
                              href={`/pools/${pos.poolAddress}`}
                              style={{ color: "var(--green, #55d69d)", textDecoration: "none" }}
                              className="alerts-monospace"
                              title={`View pool insight: ${pos.poolAddress}`}
                            >
                              {truncateAddress(pos.poolAddress, 5, 5)}
                            </a>
                            <button
                              className="alerts-link-btn"
                              onClick={() => copyToClipboard(pos.poolAddress, `pool_${pos.poolAddress}`)}
                              title="Copy pool address"
                            >
                              {copiedKey === `pool_${pos.poolAddress}` ? (
                                <Check size={12} color="var(--green)" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                          </div>
                        </td>
                        <td>
                          <span className="alerts-badge alerts-badge-muted">{pos.version}</span>
                        </td>
                        <td>
                          {pos.hasLiquidity ? (
                            <span className="alerts-badge alerts-badge-green">Has Liquidity</span>
                          ) : (
                            <span
                              className="alerts-badge alerts-badge-amber"
                              title="Open position with zero liquidity. Zero liquidity is not a closed position."
                            >
                              Zero Liquidity (Active)
                            </span>
                          )}
                        </td>
                        <td style={{ color: "var(--muted)" }}>{formatWib(pos.discoveredAt)}</td>
                        <td style={{ color: "var(--muted)" }}>{formatWib(pos.lastUpdatedAt)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: RECENT ACTIVITY */}
      {activeTab === "events" && (
        <div className="alerts-section">
          {/* Buffer Disclaimer Banner */}
          <div className="alerts-banner alerts-banner-info">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Info size={16} />
              <span>
                <strong>In-Memory Event Buffer:</strong> Displays up to 100 recent DLMM activity events
                captured in RAM during active monitoring. This buffer is ephemeral and does not represent
                historical database storage.
              </span>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="alerts-filters-bar">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Filter size={13} color="var(--muted)" />
              <select
                className="alerts-input"
                value={walletFilter}
                onChange={(e) => setWalletFilter(e.target.value)}
              >
                <option value="ALL">All Wallets</option>
                {uniqueWallets.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.alias ? `${w.alias} (${truncateAddress(w.address)})` : truncateAddress(w.address)}
                  </option>
                ))}
              </select>

              <select
                className="alerts-input"
                value={eventTypeFilter}
                onChange={(e) => setEventTypeFilter(e.target.value)}
              >
                <option value="ALL">All Event Types</option>
                <option value="POSITION_OPENED">POSITION_OPENED</option>
                <option value="LIQUIDITY_ADDED">LIQUIDITY_ADDED</option>
                <option value="LIQUIDITY_REMOVED">LIQUIDITY_REMOVED</option>
                <option value="POSITION_CLOSED">POSITION_CLOSED</option>
                <option value="FEES_CLAIMED">FEES_CLAIMED</option>
              </select>
            </div>

            <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
              <input
                type="text"
                className="alerts-input"
                style={{ width: "100%", paddingLeft: 28 }}
                placeholder="Search signature, position, or pool..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <Search
                size={13}
                color="var(--muted)"
                style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }}
              />
            </div>

            <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
              Showing {filteredEvents.length} event{filteredEvents.length === 1 ? "" : "s"}
            </div>
          </div>

          {/* Events Table */}
          <div className="alerts-table-container">
            <table className="alerts-table">
              <thead>
                <tr>
                  <th>Event Type</th>
                  <th>Wallet</th>
                  <th>Pool</th>
                  <th>Position</th>
                  <th>Signature</th>
                  <th>Slot / Time</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: "40px 14px", color: "var(--muted)" }}>
                      No recent activity events recorded in memory yet. Events will appear here as monitored wallets interact with Meteora DLMM pools.
                    </td>
                  </tr>
                ) : (
                  filteredEvents.map((evt) => {
                    const walletObj = wallets.find((w) => w.address === evt.walletAddress);
                    const walletDisplay = walletObj?.alias
                      ? `${walletObj.alias} (${truncateAddress(evt.walletAddress)})`
                      : truncateAddress(evt.walletAddress);

                    const eventTime =
                      evt.blockTime > 0 ? evt.blockTime * 1000 : evt.detectedAt;

                    return (
                      <tr key={evt.id}>
                        <td>
                          <span className={`alerts-badge ${getEventTypeBadgeClass(evt.eventType)}`}>
                            {evt.eventType}
                          </span>
                        </td>
                        <td>
                          <span className="alerts-monospace" title={evt.walletAddress}>
                            {walletDisplay}
                          </span>
                        </td>
                        <td>
                          <span className="alerts-monospace" title={evt.poolAddress}>
                            {truncateAddress(evt.poolAddress, 4, 4)}
                          </span>
                        </td>
                        <td>
                          <span className="alerts-monospace" title={evt.positionAddress}>
                            {truncateAddress(posFormat(evt.positionAddress), 4, 4)}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="alerts-monospace" title={evt.signature}>
                              {truncateAddress(evt.signature, 5, 5)}
                            </span>
                            <a
                              href={`https://explorer.solana.com/tx/${evt.signature}`}
                              target="_blank"
                              rel="noreferrer"
                              className="alerts-link-btn"
                              title="View on Solana Explorer"
                            >
                              <ExternalLink size={12} />
                            </a>
                          </div>
                        </td>
                        <td style={{ color: "var(--muted)" }}>
                          <div>Slot {evt.slot}</div>
                          <div style={{ fontSize: 10.5 }}>{formatWib(eventTime)}</div>
                        </td>
                        <td>
                          <button
                            className="alerts-btn"
                            onClick={() => setSelectedEvent(evt)}
                            title="View full transaction evidence"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: TELEGRAM DRY-RUN PREVIEWS */}
      {activeTab === "telegram" && (
        <div className="alerts-section">
          {/* Dry Run Banner */}
          <div className="alerts-banner alerts-banner-warning">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Radio size={16} />
              <span>
                <strong>Telegram Dry-Run Engine:</strong> Messages below are formatted in-memory exactly as
                they would be sent to a Telegram chat, but <strong>NO real messages are sent</strong>. All
                external Telegram tokens, HTTP webhooks, and live bots are strictly disabled. Status is always{" "}
                <span className="alerts-badge alerts-badge-amber">PREVIEW ONLY / NOT SENT</span>.
              </span>
            </div>
          </div>

          {/* Previews Filter Bar */}
          <div className="alerts-filters-bar">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Filter size={13} color="var(--muted)" />
              <select
                className="alerts-input"
                value={walletFilter}
                onChange={(e) => setWalletFilter(e.target.value)}
              >
                <option value="ALL">All Wallets</option>
                {uniqueWallets.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.alias ? `${w.alias} (${truncateAddress(w.address)})` : truncateAddress(w.address)}
                  </option>
                ))}
              </select>

              <select
                className="alerts-input"
                value={eventTypeFilter}
                onChange={(e) => setEventTypeFilter(e.target.value)}
              >
                <option value="ALL">All Event Types</option>
                <option value="POSITION_OPENED">POSITION_OPENED</option>
                <option value="LIQUIDITY_ADDED">LIQUIDITY_ADDED</option>
                <option value="LIQUIDITY_REMOVED">LIQUIDITY_REMOVED</option>
                <option value="POSITION_CLOSED">POSITION_CLOSED</option>
                <option value="FEES_CLAIMED">FEES_CLAIMED</option>
              </select>
            </div>

            <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
              {filteredPreviews.length} dry-run message{filteredPreviews.length === 1 ? "" : "s"} generated
            </div>
          </div>

          {/* Previews List */}
          <div className="alerts-preview-grid">
            {filteredPreviews.length === 0 ? (
              <div className="alerts-card alerts-empty-state">
                <Bell size={32} color="var(--muted)" />
                <h4>No dry-run preview messages yet</h4>
                <p>
                  As monitored wallets open positions, add/remove liquidity, or claim fees, deterministic
                  dry-run preview messages are constructed in RAM and displayed here.
                </p>
              </div>
            ) : (
              filteredPreviews.map((p) => (
                <div key={p.id} className="alerts-preview-card">
                  <div className="alerts-preview-header">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="alerts-badge alerts-badge-amber">PREVIEW ONLY / NOT SENT</span>
                      <span className={`alerts-badge ${getEventTypeBadgeClass(p.eventType)}`}>
                        {p.eventType}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        {p.timestamp} ({formatWib(new Date(p.timestamp).getTime())})
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        className="alerts-btn"
                        onClick={() => copyToClipboard(p.messageText, `msg_${p.id}`)}
                        title="Copy dryrun message text"
                      >
                        {copiedKey === `msg_${p.id}` ? (
                          <>
                            <Check size={12} color="var(--green)" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy size={12} /> Copy Message
                          </>
                        )}
                      </button>

                      <a
                        href={p.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="alerts-btn"
                        title="Open Solana Explorer"
                      >
                        <ExternalLink size={12} />
                        Explorer
                      </a>
                    </div>
                  </div>

                  {/* Monospace Message Text Box */}
                  <div className="alerts-preview-msg">{p.messageText}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* MODAL: Fresh Resume Confirmation */}
      {resumeModalWallet && (
        <div className="alerts-modal-overlay">
          <div className="alerts-modal">
            <div className="alerts-modal-header">
              <h3>Fresh Resume Monitoring</h3>
              <button className="alerts-link-btn" onClick={() => setResumeModalWallet(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="alerts-modal-body">
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <AlertTriangle size={24} color="var(--amber, #f1c84d)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
                    You are resuming monitoring for wallet{" "}
                    <strong>
                      {resumeModalWallet.alias || truncateAddress(resumeModalWallet.address)}
                    </strong>{" "}
                    (<code>{resumeModalWallet.address}</code>).
                  </p>
                  <p style={{ margin: 0, color: "var(--amber, #f1c84d)", fontWeight: 600, lineHeight: 1.5 }}>
                    Fresh Resume Policy: Monitoring will start from the current chain tip. Any DLMM
                    activity that occurred during the pause interval will NOT be replayed or notified.
                  </p>
                </div>
              </div>
            </div>

            <div className="alerts-modal-footer">
              <button className="alerts-btn" onClick={() => setResumeModalWallet(null)}>
                Cancel
              </button>
              <button className="alerts-btn alerts-btn-primary" onClick={handleConfirmFreshResume}>
                Confirm Fresh Resume
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Remove Wallet Confirmation */}
      {deleteModalWallet && (
        <div className="alerts-modal-overlay">
          <div className="alerts-modal">
            <div className="alerts-modal-header">
              <h3>Remove Wallet from Watchlist</h3>
              <button className="alerts-link-btn" onClick={() => setDeleteModalWallet(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="alerts-modal-body">
              <p style={{ margin: 0 }}>
                Are you sure you want to remove wallet{" "}
                <strong>
                  {deleteModalWallet.alias || truncateAddress(deleteModalWallet.address)}
                </strong>{" "}
                from the watchlist? This will immediately unenroll the wallet from the active alerts engine.
              </p>
            </div>

            <div className="alerts-modal-footer">
              <button className="alerts-btn" onClick={() => setDeleteModalWallet(null)}>
                Cancel
              </button>
              <button className="alerts-btn alerts-btn-danger" onClick={handleConfirmDelete}>
                Remove Wallet
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL / DRAWER: Event Details */}
      {selectedEvent && (
        <div className="alerts-modal-overlay">
          <div className="alerts-modal" style={{ maxWidth: 700 }}>
            <div className="alerts-modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className={`alerts-badge ${getEventTypeBadgeClass(selectedEvent.eventType)}`}>
                  {selectedEvent.eventType}
                </span>
                <h3 style={{ margin: 0 }}>DLMM Event Evidence</h3>
              </div>
              <button className="alerts-link-btn" onClick={() => setSelectedEvent(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="alerts-modal-body">
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "10px 14px", alignItems: "center" }}>
                <div style={{ color: "var(--muted)" }}>Event ID:</div>
                <div className="alerts-monospace" style={{ wordBreak: "break-all" }}>{selectedEvent.id}</div>

                <div style={{ color: "var(--muted)" }}>Transaction Signature:</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="alerts-monospace" style={{ wordBreak: "break-all" }}>{selectedEvent.signature}</span>
                  <a
                    href={`https://explorer.solana.com/tx/${selectedEvent.signature}`}
                    target="_blank"
                    rel="noreferrer"
                    className="alerts-link-btn"
                    title="View on Solana Explorer"
                  >
                    <ExternalLink size={13} />
                  </a>
                </div>

                <div style={{ color: "var(--muted)" }}>Slot & Finalization:</div>
                <div>Finalized (Slot {selectedEvent.slot})</div>

                <div style={{ color: "var(--muted)" }}>Ledger Timestamp:</div>
                <div>
                  {selectedEvent.blockTime > 0 ? (
                    <>
                      {new Date(selectedEvent.blockTime * 1000).toISOString()} (
                      {formatWib(selectedEvent.blockTime * 1000)})
                    </>
                  ) : (
                    <>Fallback: {new Date(selectedEvent.detectedAt).toISOString()} (no blockTime)</>
                  )}
                </div>

                <div style={{ color: "var(--muted)" }}>Wallet Address:</div>
                <div className="alerts-monospace" style={{ wordBreak: "break-all" }}>{selectedEvent.walletAddress}</div>

                <div style={{ color: "var(--muted)" }}>Instruction Name:</div>
                <div className="alerts-monospace">{selectedEvent.instructionName} (index {selectedEvent.instructionIndex}, {selectedEvent.source})</div>

                <div style={{ color: "var(--muted)" }}>Signer Address:</div>
                <div className="alerts-monospace" style={{ wordBreak: "break-all" }}>{selectedEvent.signer}</div>

                <div style={{ color: "var(--muted)" }}>Fee Payer:</div>
                <div className="alerts-monospace" style={{ wordBreak: "break-all" }}>
                  {selectedEvent.feePayer || "—"}{" "}
                  <span style={{ fontSize: 10.5, color: "var(--muted)" }}>(Fee payer never used to infer ownership)</span>
                </div>

                <div style={{ color: "var(--muted)" }}>Delegated Operator:</div>
                <div className="alerts-monospace">{selectedEvent.operator || "None"}</div>

                <div style={{ color: "var(--muted)" }}>Pool Address:</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <a
                    href={`/pools/${selectedEvent.poolAddress}`}
                    style={{ color: "var(--green)", textDecoration: "none" }}
                    className="alerts-monospace"
                  >
                    {selectedEvent.poolAddress}
                  </a>
                  <a
                    href={`https://explorer.solana.com/address/${selectedEvent.poolAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="alerts-link-btn"
                  >
                    <ExternalLink size={12} />
                  </a>
                </div>

                <div style={{ color: "var(--muted)" }}>Position Address:</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="alerts-monospace" style={{ wordBreak: "break-all" }}>{selectedEvent.positionAddress}</span>
                  <a
                    href={`https://explorer.solana.com/address/${selectedEvent.positionAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="alerts-link-btn"
                  >
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
            </div>

            <div className="alerts-modal-footer">
              <a
                href={`https://explorer.solana.com/tx/${selectedEvent.signature}`}
                target="_blank"
                rel="noreferrer"
                className="alerts-btn alerts-btn-primary"
              >
                <ExternalLink size={13} />
                Open in Solana Explorer
              </a>
              <button className="alerts-btn" onClick={() => setSelectedEvent(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function posFormat(addr: string): string {
  return addr || "—";
}
