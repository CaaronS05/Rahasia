import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Layers3,
  Loader2,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  WalletCards,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  discoverTokenPools,
  enrichSelectedWallets,
  getPoolScannerStatus,
  scanSelectedPools,
  startPoolScanner,
  stopPoolScanner,
  type PoolDiscoveryItem,
  type PoolDiscoveryResponse,
  type PoolScannerStage,
  type PoolScannerState,
  type PoolScannerStatus,
} from "../lib/poolScannerControl";
import "../pool-scanner-page.css";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface PoolScannerPageProps {
  onDatasetRefreshed?: () => void;
  embedded?: boolean;
  startDisabled?: boolean;
}

type StepStatus = "pending" | "running" | "completed" | "stopped" | "error";

interface StageItem {
  num: string;
  name: string;
  description: string;
  status: StepStatus;
}

const STAGE_LABELS: Record<string, string> = {
  idle: "Idle",
  discovery: "01 — Discover Pools",
  extract: "Extract Selected Pools",
  extract_completed: "Extract Completed",
  fabriq: "02 — Enrich Wallets (Fabriq)",
  fabriq_completed: "Fabriq Enrichment Completed",
  master_upsert: "03 — Master Upsert",
  publish: "04 — Publish Dataset",
  completed: "Completed",
  stopped: "Stopped",
  error: "Error",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function computePipelineProgress(
  stage: PoolScannerStage | undefined,
  status: PoolScannerStatus | undefined,
  logs: string[],
  lastActiveStepRef: React.MutableRefObject<number>
): { stages: StageItem[]; progressPercent: number } {
  if (!status || status === "idle") {
    return {
      progressPercent: 0,
      stages: [
        {
          num: "01",
          name: "Discover Pools",
          description: "Meteora Data API · TOKEN/SOL",
          status: "pending",
        },
        {
          num: "02",
          name: "Enrich Wallets",
          description: "Top LPers · Fabriq analytics",
          status: "pending",
        },
        {
          num: "03",
          name: "Master Upsert",
          description: "Merge into master dataset",
          status: "pending",
        },
        {
          num: "04",
          name: "Publish Dataset",
          description: "Export frontend dataset",
          status: "pending",
        },
      ],
    };
  }

  let activeStep = 1;
  if (stage === "discovery" || stage === "extract" || stage === "extract_completed") activeStep = 1;
  else if (stage === "fabriq" || stage === "fabriq_completed") activeStep = 2;
  else if (stage === "master_upsert") activeStep = 3;
  else if (stage === "publish") activeStep = 4;
  else if (stage === "completed" || status === "completed") {
    activeStep = 5;
  } else {
    activeStep = lastActiveStepRef.current || 1;
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i];
      if (line.includes("[STAGE 4/4]")) {
        activeStep = 4;
        break;
      }
      if (line.includes("[STAGE 3/4]")) {
        activeStep = 3;
        break;
      }
      if (line.includes("[STAGE 2/4]") || line.includes("[RESUME]")) {
        activeStep = 2;
        break;
      }
      if (line.includes("[STAGE 1/4]")) {
        activeStep = 1;
        break;
      }
    }
  }

  if (activeStep >= 1 && activeStep <= 4) {
    lastActiveStepRef.current = activeStep;
  }

  const stepPercentMap: Record<number, number> = {
    1: 25,
    2: 50,
    3: 75,
    4: 90,
    5: 100,
  };

  const progressPercent = stepPercentMap[activeStep] ?? 0;
  const isCompleted = status === "completed" || stage === "completed";
  const isStopped = status === "stopped" || stage === "stopped";
  const isError = status === "error" || stage === "error";

  function getStepStatus(stepNum: number): StepStatus {
    if (isCompleted) {
      return "completed";
    }

    if (isStopped) {
      if (stepNum < activeStep) return "completed";
      if (stepNum === activeStep) return "stopped";
      return "pending";
    }

    if (isError) {
      if (stepNum < activeStep) return "completed";
      if (stepNum === activeStep) return "error";
      return "pending";
    }

    if (stepNum < activeStep) return "completed";
    if (stepNum === activeStep) return "running";
    return "pending";
  }

  return {
    progressPercent: isCompleted ? 100 : progressPercent,
    stages: [
      {
        num: "01",
        name: "Discover Pools",
        description: "Meteora Data API · TOKEN/SOL",
        status: getStepStatus(1),
      },
      {
        num: "02",
        name: "Enrich Wallets",
        description: "Top LPers · Fabriq analytics",
        status: getStepStatus(2),
      },
      {
        num: "03",
        name: "Master Upsert",
        description: "Merge into master dataset",
        status: getStepStatus(3),
      },
      {
        num: "04",
        name: "Publish Dataset",
        description: "Export frontend dataset",
        status: getStepStatus(4),
      },
    ],
  };
}

export function PoolScannerPage({ onDatasetRefreshed, embedded = false, startDisabled = false }: PoolScannerPageProps) {
  const [tokenCa, setTokenCa] = useState("");
  const [fabriqWorkers, setFabriqWorkers] = useState<number | string>(2);
  const [state, setState] = useState<PoolScannerState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [stopModalError, setStopModalError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [discoveryResult, setDiscoveryResult] = useState<PoolDiscoveryResponse | null>(null);
  const [selectedPoolAddresses, setSelectedPoolAddresses] = useState<string[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [enrichTestLimit, setEnrichTestLimit] = useState(false);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const prevRunningRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActiveStepRef = useRef(1);

  const cleanedToken = tokenCa.trim();

  const tokenLooksValid = useMemo(
    () => cleanedToken.length >= 32 && cleanedToken.length <= 50,
    [cleanedToken]
  );

  const workersRaw = String(fabriqWorkers).trim();
  const workersValid = useMemo(
    () => /^[1-9]\d*$/.test(workersRaw),
    [workersRaw]
  );

  const isRunning = Boolean(state?.running || submitting);
  const isCompleted = state?.status === "completed" && !isRunning;
  const isStopped = state?.status === "stopped" && !isRunning;
  const isError = (state?.status === "error" || Boolean(apiError)) && !isRunning;

  const isResumableSession = useMemo(() => {
    if (isRunning) return false;
    if (!tokenLooksValid) return false;
    const target = state?.resumableTokenCa || state?.tokenCa;
    const isMatchingToken = Boolean(target && cleanedToken === target);
    const hasResumableState = Boolean(
      state?.resumable ||
        (state?.stage1Complete && !state?.stage2Complete && !state?.pipelineComplete)
    );
    return isMatchingToken && hasResumableState;
  }, [isRunning, tokenLooksValid, state, cleanedToken]);

  const fetchStatus = useCallback(async (token?: string) => {
    try {
      const s = await getPoolScannerStatus(token);
      setState(s);
      setApiError(null);
      return s;
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    let mounted = true;

    async function initialLoad() {
      const s = await fetchStatus();
      if (mounted) {
        if (s?.tokenCa) {
          setTokenCa((prev) => (prev ? prev : s.tokenCa!));
        }
        if (typeof s?.fabriqWorkers === "number" && s.fabriqWorkers >= 1) {
          setFabriqWorkers(String(s.fabriqWorkers));
        }
      }
    }

    initialLoad();

    return () => {
      mounted = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [fetchStatus]);

  // Token CA resume detection (debounced when idle and valid token entered)
  useEffect(() => {
    if (isRunning || !tokenLooksValid) return;

    const timer = setTimeout(() => {
      fetchStatus(cleanedToken);
    }, 350);

    return () => {
      clearTimeout(timer);
    };
  }, [isRunning, tokenLooksValid, cleanedToken, fetchStatus]);

  // Polling loop while running
  useEffect(() => {
    if (!state?.running) {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    const timer = setTimeout(async () => {
      await fetchStatus();
    }, 1500);

    pollTimerRef.current = timer;

    return () => {
      clearTimeout(timer);
    };
  }, [state, fetchStatus]);

  // Call onDatasetRefreshed exactly once when transitioning running -> completed
  useEffect(() => {
    const runningNow = Boolean(state?.running);
    if (prevRunningRef.current && !runningNow && state?.status === "completed") {
      onDatasetRefreshed?.();
    }
    prevRunningRef.current = runningNow;
  }, [state?.running, state?.status, onDatasetRefreshed]);

  // Auto-scroll logs to bottom while running and logs are expanded
  useEffect(() => {
    if (state?.running && logsExpanded && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [state?.logs, state?.running, logsExpanded]);

  // Handle Escape key to close stop confirmation modal
  useEffect(() => {
    if (!showStopModal) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !stopping) {
        setShowStopModal(false);
        setStopModalError(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showStopModal, stopping]);

  function handleTokenChange(val: string) {
    setTokenCa(val);
    setDiscoveryResult(null);
    setSelectedPoolAddresses([]);
    setDiscoveryError(null);
  }

  function handleClearToken() {
    setTokenCa("");
    setDiscoveryResult(null);
    setSelectedPoolAddresses([]);
    setDiscoveryError(null);
  }

  async function handleDiscoverPools(event: React.FormEvent) {
    event.preventDefault();
    if (!tokenLooksValid || discoveryLoading || isRunning) {
      return;
    }

    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setDiscoveryResult(null);
    setSelectedPoolAddresses([]);

    try {
      const res = await discoverTokenPools(cleanedToken);
      setDiscoveryResult(res);
      setSelectedPoolAddresses(res.pools.map((p) => p.poolAddress));
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveryLoading(false);
    }
  }

  const allPoolAddresses = useMemo(
    () => discoveryResult?.pools.map((p) => p.poolAddress) || [],
    [discoveryResult]
  );

  const isAllSelected =
    allPoolAddresses.length > 0 &&
    selectedPoolAddresses.length === allPoolAddresses.length;

  function handleSelectAll() {
    setSelectedPoolAddresses([...allPoolAddresses]);
  }

  function handleClearSelection() {
    setSelectedPoolAddresses([]);
  }

  function handleTogglePool(poolAddress: string) {
    setSelectedPoolAddresses((prev) =>
      prev.includes(poolAddress)
        ? prev.filter((addr) => addr !== poolAddress)
        : [...prev, poolAddress]
    );
  }

  async function handleScanSelectedPools() {
    if (
      selectedPoolAddresses.length === 0 ||
      discoveryLoading ||
      isRunning ||
      startDisabled
    ) {
      return;
    }

    setSubmitting(true);
    setApiError(null);

    try {
      const s = await scanSelectedPools(cleanedToken, selectedPoolAddresses);
      setState(s);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEnrichSelectedWallets() {
    if (isRunning || startDisabled || !tokenLooksValid) return;
    setSubmitting(true);
    setApiError(null);

    const workerCount = Number(workersRaw) || 2;
    const limit = enrichTestLimit ? 1 : undefined;

    try {
      const s = await enrichSelectedWallets(cleanedToken, workerCount, limit);
      setState(s);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tokenLooksValid || !workersValid || isRunning || submitting || startDisabled) {
      return;
    }

    setSubmitting(true);
    setApiError(null);
    lastActiveStepRef.current = isResumableSession ? 2 : 1;

    const workerCount = Number(workersRaw);

    try {
      const s = await startPoolScanner(cleanedToken, workerCount);
      setState(s);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenStopModal() {
    if (!isRunning || stopping) return;
    setStopModalError(null);
    setShowStopModal(true);
  }

  function handleCloseStopModal() {
    if (stopping) return;
    setShowStopModal(false);
    setStopModalError(null);
  }

  async function handleConfirmStop() {
    if (stopping) return;
    setStopping(true);
    setStopModalError(null);

    try {
      const s = await stopPoolScanner();
      setState(s);
      setShowStopModal(false);
    } catch (err) {
      setStopModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  function handleCopyLogs() {
    if (!state?.logs?.length) return;
    navigator.clipboard.writeText(state.logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const { stages, progressPercent } = useMemo(
    () =>
      computePipelineProgress(
        state?.stage,
        state?.status,
        state?.logs || [],
        lastActiveStepRef
      ),
    [state?.stage, state?.status, state?.logs]
  );

  let heroBadgeText = "Scanner ready";
  let heroBadgeClass = "pool-scanner-hero-badge";
  if (isRunning) {
    heroBadgeText = "Scanner running";
    heroBadgeClass = "pool-scanner-hero-badge running";
  } else if (isCompleted) {
    heroBadgeText = "Scan completed";
    heroBadgeClass = "pool-scanner-hero-badge completed";
  } else if (isStopped) {
    heroBadgeText = "Scan stopped";
    heroBadgeClass = "pool-scanner-hero-badge stopped";
  } else if (isError) {
    heroBadgeText = "Scan failed";
    heroBadgeClass = "pool-scanner-hero-badge error";
  }

  let statusUi: "Ready" | "Running" | "Completed" | "Stopped" | "Error" = "Ready";
  if (isRunning) {
    statusUi = "Running";
  } else if (state?.status === "completed") {
    statusUi = "Completed";
  } else if (state?.status === "stopped") {
    statusUi = "Stopped";
  } else if (state?.status === "error" || Boolean(apiError)) {
    statusUi = "Error";
  } else {
    statusUi = "Ready";
  }

  const activeTokenCa = state?.tokenCa || (isRunning ? cleanedToken : null);

  return (
    <div className={`pool-scanner-page ${embedded ? "pool-scanner-embedded" : ""}`}>
      {!embedded && <section className="pool-scanner-hero">
        <div>
          <div className="pool-scanner-kicker">
            <Radar size={13} />
            METEORA DLMM DISCOVERY
          </div>
          <h1>Pool Scanner</h1>
          <p>
            Discover every TOKEN/SOL Meteora pool, collect Top LPers, enrich
            wallets, and prepare them for the main scanner dataset.
          </p>
        </div>

        <div className={heroBadgeClass}>
          {isRunning ? (
            <span className="pool-scanner-live-dot pulse" />
          ) : isCompleted ? (
            <CheckCircle2 size={13} className="hero-badge-icon success" />
          ) : isStopped ? (
            <Square size={13} className="hero-badge-icon stopped" />
          ) : isError ? (
            <XCircle size={13} className="hero-badge-icon error" />
          ) : (
            <span className="pool-scanner-live-dot" />
          )}
          {heroBadgeText}
        </div>
      </section>}

      <div className="pool-scanner-layout">
        <section className="pool-scanner-main-card">
          <div className="pool-scanner-card-head">
            <div className="pool-scanner-icon-box">
              <ScanSearch size={20} />
            </div>
            <div>
              <h2>Scan a token</h2>
              <p>Enter a Solana token contract address to begin discovery.</p>
            </div>
          </div>

          <form className="pool-scanner-form" onSubmit={handleDiscoverPools}>
            <label htmlFor="pool-scanner-token">TOKEN CONTRACT ADDRESS</label>
            <div
              className={`pool-scanner-input-wrap ${tokenLooksValid ? "valid" : ""} ${
                isRunning || discoveryLoading ? "disabled" : ""
              }`}
            >
              <input
                id="pool-scanner-token"
                value={tokenCa}
                onChange={(event) => handleTokenChange(event.target.value)}
                placeholder="Enter token CA..."
                spellCheck={false}
                autoComplete="off"
                disabled={isRunning || discoveryLoading}
              />
              {cleanedToken && !isRunning && !discoveryLoading ? (
                <button
                  type="button"
                  className="pool-scanner-clear"
                  onClick={handleClearToken}
                >
                  Clear
                </button>
              ) : null}
            </div>

            <div className="pool-scanner-input-meta">
              <span>
                Pair filter: <strong>TOKEN / SOL only</strong>
              </span>
              <span className="pool-scanner-sol-mint" title={SOL_MINT}>
                SOL mint verified
              </span>
            </div>

            <div className="pool-scanner-field-group">
              <label htmlFor="pool-scanner-workers">
                FABRIQ WORKERS
                <span style={{ fontSize: "10px", color: "var(--muted)", textTransform: "none", fontWeight: 400, marginLeft: "6px" }}>
                  (Step 3C · does not affect pool extraction)
                </span>
              </label>
              <div
                className={`pool-scanner-input-wrap compact ${
                  isRunning ? "disabled" : ""
                }`}
              >
                <input
                  id="pool-scanner-workers"
                  type="number"
                  min={1}
                  step={1}
                  value={fabriqWorkers}
                  onChange={(event) => setFabriqWorkers(event.target.value)}
                  disabled={isRunning}
                />
              </div>
            </div>

            {isResumableSession ? (
              <div className="pool-scanner-resume-indicator">
                <CheckCircle2 size={13} />
                <span>Resume available — Stage 1 complete</span>
              </div>
            ) : null}

            <button
              type="submit"
              className="pool-scanner-start"
              disabled={!tokenLooksValid || discoveryLoading || isRunning || startDisabled}
            >
              {discoveryLoading ? (
                <>
                  <Loader2 size={17} className="spin" />
                  Discovering Pools...
                </>
              ) : (
                <>
                  <ScanSearch size={17} />
                  Discover Pools
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {discoveryError ? (
            <div className="pool-scanner-error-banner">
              <AlertCircle size={16} />
              <div>
                <strong>Discovery Error</strong>
                <span>{discoveryError}</span>
              </div>
            </div>
          ) : null}

          {discoveryResult ? (
            <div className="pool-discovery-section">
              <div className="pool-discovery-header">
                <div className="pool-discovery-title-wrap">
                  <Layers3 size={15} className="pool-discovery-icon" />
                  <span className="pool-discovery-title">Discovered Pools</span>
                </div>
                <span className="pool-discovery-count-badge">
                  {discoveryResult.poolCount} pool{discoveryResult.poolCount === 1 ? "" : "s"}
                </span>
              </div>

              {discoveryResult.pools.length === 0 ? (
                <div className="pool-discovery-empty">
                  <AlertCircle size={15} />
                  <span>No TOKEN/SOL DLMM pools found for this token.</span>
                </div>
              ) : (
                <>
                  <div className="pool-discovery-controls">
                    <div className="pool-discovery-btn-group">
                      <button
                        type="button"
                        className="pool-discovery-ctrl-btn"
                        onClick={handleSelectAll}
                        disabled={isAllSelected}
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        className="pool-discovery-ctrl-btn"
                        onClick={handleClearSelection}
                        disabled={selectedPoolAddresses.length === 0}
                      >
                        Clear
                      </button>
                    </div>
                    <span className="pool-discovery-selected-count">
                      {selectedPoolAddresses.length} of {discoveryResult.poolCount} selected
                    </span>
                  </div>

                  <div className="pool-discovery-list">
                    {discoveryResult.pools.map((p) => {
                      const isSelected = selectedPoolAddresses.includes(p.poolAddress);
                      const shortPool = `${p.poolAddress.slice(0, 4)}...${p.poolAddress.slice(-4)}`;
                      const feeDisplay = p.baseFeePct !== null ? `${p.baseFeePct.toFixed(2)}%` : "—";
                      const binDisplay = p.binStep !== null ? String(p.binStep) : "—";

                      return (
                        <label
                          key={p.poolAddress}
                          className={`pool-discovery-item ${isSelected ? "selected" : ""}`}
                        >
                          <div className="pool-discovery-checkbox-wrap">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleTogglePool(p.poolAddress)}
                            />
                          </div>
                          <div className="pool-discovery-item-body">
                            <div className="pool-discovery-item-top">
                              <span className="pool-discovery-pair">{p.pair}</span>
                              <span className="pool-discovery-address" title={p.poolAddress}>
                                <span className="pool-discovery-field-label">Pool</span> {shortPool}
                              </span>
                            </div>
                            <div className="pool-discovery-item-meta">
                              <div className="pool-discovery-meta-col">
                                <span className="pool-discovery-field-label">Bin Step</span>
                                <strong className="pool-discovery-field-val">{binDisplay}</strong>
                              </div>
                              <div className="pool-discovery-meta-col">
                                <span className="pool-discovery-field-label">Base Fee</span>
                                <strong className="pool-discovery-field-val">{feeDisplay}</strong>
                              </div>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <div className="pool-discovery-actions">
                    <button
                      type="button"
                      className={`pool-scanner-start pool-discovery-scan-btn ${
                        selectedPoolAddresses.length === 0 ||
                        discoveryLoading ||
                        isRunning ||
                        startDisabled
                          ? "disabled"
                          : ""
                      }`}
                      disabled={
                        selectedPoolAddresses.length === 0 ||
                        discoveryLoading ||
                        isRunning ||
                        startDisabled
                      }
                      onClick={handleScanSelectedPools}
                    >
                      {submitting && state?.stage === "extract" ? (
                        <>
                          <Loader2 size={16} className="spin" />
                          Starting Selected Scan...
                        </>
                      ) : (
                        <>
                          <Radar size={16} />
                          Scan Selected Pools ({selectedPoolAddresses.length})
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {apiError || (state?.status === "error" && state.error) ? (
            <div className="pool-scanner-error-banner">
              <AlertCircle size={16} />
              <div>
                <strong>Pipeline Error</strong>
                <span>{apiError || state?.error}</span>
              </div>
            </div>
          ) : null}

          <div className="pool-scanner-note">
            <ShieldCheck size={16} />
            <div>
              <strong>Exact mint filtering</strong>
              <span>
                Only pools whose token mints exactly match TOKEN ↔ native SOL
                are accepted. USDC, swSOL, and token/token pools are excluded.
              </span>
            </div>
          </div>
        </section>

        <aside className="pool-scanner-side-card">
          <div className="pool-scanner-side-head">
            <span>PIPELINE</span>
            <strong>Discovery flow</strong>
          </div>

          <div className="pool-scanner-flow">
            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">01</span>
              <div className="pool-scanner-flow-icon">
                <Layers3 size={16} />
              </div>
              <div>
                <strong>Discover pools</strong>
                <span>Meteora Data API</span>
              </div>
            </div>

            <div className="pool-scanner-flow-line" />

            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">02</span>
              <div className="pool-scanner-flow-icon">
                <WalletCards size={16} />
              </div>
              <div>
                <strong>Collect Top LPers</strong>
                <span>LP Agent · owner only</span>
              </div>
            </div>

            <div className="pool-scanner-flow-line" />

            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">03</span>
              <div className="pool-scanner-flow-icon">
                <Sparkles size={16} />
              </div>
              <div>
                <strong>Enrich wallets</strong>
                <span>Fabriq analytics</span>
              </div>
            </div>

            <div className="pool-scanner-flow-line" />

            <div className="pool-scanner-flow-item">
              <span className="pool-scanner-step">04</span>
              <div className="pool-scanner-flow-icon">
                <Database size={16} />
              </div>
              <div>
                <strong>Publish dataset</strong>
                <span>Master DB → frontend</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Primary Pipeline Progress Section */}
      <section className="pool-scanner-progress-section">
        {/* Compact Status Summary Bar */}
        <div className="pool-scanner-meta-bar">
          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">STATUS</span>
            <div className="status-with-actions">
              <span className={`pool-scanner-status-pill ${statusUi.toLowerCase()}`}>
                {isRunning && <span className="status-pill-dot" />}
                {statusUi}
              </span>
              {isRunning ? (
                <button
                  type="button"
                  className="pool-scanner-stop-btn"
                  onClick={handleOpenStopModal}
                  disabled={stopping}
                  title="Stop the current Pool Scanner pipeline"
                >
                  <Square size={11} fill="currentColor" />
                  Stop Scan
                </button>
              ) : null}
            </div>
          </div>

          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">TOKEN</span>
            <span
              className="pool-scanner-meta-value mono"
              title={activeTokenCa || ""}
            >
              {activeTokenCa
                ? `${activeTokenCa.slice(0, 8)}...${activeTokenCa.slice(-8)}`
                : "—"}
            </span>
          </div>

          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">STARTED</span>
            <span className="pool-scanner-meta-value">
              {formatDate(state?.startedAt)}
            </span>
          </div>

          <div className="pool-scanner-meta-item">
            <span className="pool-scanner-meta-label">FINISHED</span>
            <span className="pool-scanner-meta-value">
              {state?.finishedAt ? formatDate(state.finishedAt) : "—"}
            </span>
          </div>
        </div>

        {/* Selected Pools Extraction Card (Step 3B) */}
        {(state?.stage === "extract" ||
          state?.stage === "extract_completed" ||
          ((state?.selectedPoolCount || 0) > 0 && isRunning)) && (
          <div className="pool-scanner-extract-card">
            <div className="extract-card-header">
              <div className="extract-card-title">
                {state?.stage === "extract" || isRunning ? (
                  <>
                    <Loader2 size={16} className="spin text-green" />
                    <span>Scanning selected pools</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} className="text-green" />
                    <span>Selected pools scan completed</span>
                  </>
                )}
              </div>
              <div className="extract-card-stats">
                <span className="extract-stat-item">
                  <strong>
                    {state?.completedPoolCount ?? 0} /{" "}
                    {state?.selectedPoolCount ?? selectedPoolAddresses.length}
                  </strong>{" "}
                  pools completed
                </span>
                <span className="extract-stat-dot">·</span>
                <span className="extract-stat-item">
                  <strong>{state?.uniqueWallets ?? 0}</strong> unique wallets
                </span>
              </div>
            </div>

            {state?.currentPool && (state?.stage === "extract" || isRunning) ? (
              <div className="extract-current-pool">
                <span className="extract-current-label">Current pool:</span>
                <div className="extract-current-details">
                  <span className="extract-current-pair">
                    {state.currentPool.pair}
                  </span>
                  <span className="extract-current-meta">
                    Bin Step {state.currentPool.binStep ?? "—"}
                  </span>
                  <span className="extract-current-meta">
                    Base Fee{" "}
                    {state.currentPool.baseFeePct !== null &&
                    state.currentPool.baseFeePct !== undefined
                      ? `${state.currentPool.baseFeePct.toFixed(2)}%`
                      : "—"}
                  </span>
                  <span
                    className="extract-current-addr mono"
                    title={state.currentPool.poolAddress}
                  >
                    {state.currentPool.poolAddress.slice(0, 4)}...
                    {state.currentPool.poolAddress.slice(-4)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Step 3C-A Fabriq Enrichment Trigger (when extraction is complete) */}
        {((state?.stage === "extract_completed" ||
          (state?.status === "completed" && (state?.uniqueWallets || 0) > 0)) &&
          !isRunning &&
          state?.stage !== "fabriq" &&
          state?.stage !== "fabriq_completed") ? (
          <div className="pool-scanner-enrich-trigger-card">
            <div className="enrich-trigger-info">
              <Sparkles size={16} className="text-green" />
              <div>
                <strong>Step 3C-A · Fabriq Enrichment</strong>
                <p>
                  Enrich {state?.uniqueWallets || 0} globally deduplicated wallets using {fabriqWorkers} workers.
                </p>
              </div>
            </div>
            <div className="enrich-trigger-actions">
              <label className="enrich-test-limit-label">
                <input
                  type="checkbox"
                  checked={enrichTestLimit}
                  onChange={(e) => setEnrichTestLimit(e.target.checked)}
                />
                <span>Test mode (limit: 1 wallet)</span>
              </label>
              <button
                type="button"
                className="pool-scanner-start pool-discovery-scan-btn enrich-btn"
                onClick={handleEnrichSelectedWallets}
                disabled={isRunning || startDisabled}
              >
                <Sparkles size={15} />
                Enrich Wallets with Fabriq
              </button>
            </div>
          </div>
        ) : null}

        {/* Fabriq Enrichment Progress Card (Step 3C-A) */}
        {(state?.stage === "fabriq" || state?.stage === "fabriq_completed") ? (
          <div className="pool-scanner-extract-card fabriq-enrich-card">
            <div className="extract-card-header">
              <div className="extract-card-title">
                {state.stage === "fabriq" && isRunning ? (
                  <>
                    <Loader2 size={16} className="spin text-green" />
                    <span>Fabriq Enrichment</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} className="text-green" />
                    <span>Fabriq Enrichment Completed</span>
                  </>
                )}
              </div>
              <div className="extract-card-stats">
                <span className="extract-stat-item">
                  <strong>{state.fabriqCompleted ?? 0} / {state.fabriqTotal || state.uniqueWallets || 0}</strong> wallets
                </span>
                <span className="extract-stat-dot">·</span>
                <span className="extract-stat-item">
                  Workers: <strong>{state.fabriqWorkers || fabriqWorkers}</strong>
                </span>
                {state.fabriqLimit ? (
                  <>
                    <span className="extract-stat-dot">·</span>
                    <span className="extract-stat-item">
                      Limit: <strong>{state.fabriqLimit}</strong>
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            <div className="fabriq-substats-row">
              <span className="fabriq-substat ok">
                ✓ {state.fabriqSuccess ?? 0} ok
              </span>
              <span className="fabriq-substat skip">
                ↷ {state.fabriqSkipped ?? 0} skipped / fresh
              </span>
              <span className="fabriq-substat fail">
                ✗ {state.fabriqFailed ?? 0} failed
              </span>
            </div>
          </div>
        ) : null}

        {/* Primary Stage Progress Display */}
        <div className="pool-scanner-progress-card">
          <div className="pool-scanner-progress-header">
            <div className="progress-header-title">
              <Layers3 size={15} />
              <span>PIPELINE PROGRESS</span>
            </div>
            <div className="progress-header-stage">
              Current stage:{" "}
              <strong>
                {isCompleted
                  ? "Completed"
                  : isStopped
                  ? "Stopped"
                  : isError
                  ? "Error"
                  : isRunning
                  ? STAGE_LABELS[state?.stage || ""] || state?.stage || "Running"
                  : "Ready"}
              </strong>
            </div>
          </div>

          {/* Horizontal Overall Progress Bar */}
          <div className="pool-scanner-overall-progress">
            <div className="progress-bar-meta">
              <span className="progress-bar-label">OVERALL COMPLETION</span>
              <span className="progress-bar-value">{progressPercent}%</span>
            </div>
            <div className="progress-bar-track">
              <div
                className={`progress-bar-fill ${statusUi.toLowerCase()}`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* 4 Pipeline Stages */}
          <div className="pool-scanner-stages-grid">
            {stages.map((st) => (
              <div
                key={st.num}
                className={`pool-scanner-stage-card ${st.status}`}
              >
                <div className="stage-card-top">
                  <span className="stage-card-num">{st.num}</span>
                  <div className={`stage-state-badge ${st.status}`}>
                    {st.status === "completed" ? (
                      <>
                        <CheckCircle2 size={12} />
                        <span>Completed</span>
                      </>
                    ) : st.status === "running" ? (
                      <>
                        <Loader2 size={12} className="spin" />
                        <span>Running</span>
                      </>
                    ) : st.status === "stopped" ? (
                      <>
                        <Square size={10} fill="currentColor" />
                        <span>Stopped</span>
                      </>
                    ) : st.status === "error" ? (
                      <>
                        <XCircle size={12} />
                        <span>Error</span>
                      </>
                    ) : (
                      <>
                        <Clock size={12} />
                        <span>Pending</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="stage-card-body">
                  <strong>{st.name}</strong>
                  <p>{st.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Collapsible Live Logs Section */}
        <div className="pool-scanner-logs-section">
          <div className="pool-scanner-logs-toggle-row">
            <button
              type="button"
              className="pool-scanner-logs-toggle-btn"
              onClick={() => setLogsExpanded((v) => !v)}
            >
              <Terminal size={14} />
              <span>{logsExpanded ? "Hide Live Logs" : "Show Live Logs"}</span>
              <span className="logs-count-badge">
                {state?.logs?.length || 0} lines
              </span>
              {isRunning ? (
                <span className="logs-live-badge">
                  <span className="pool-scanner-live-dot pulse" />
                  LIVE
                </span>
              ) : null}
            </button>
          </div>

          {logsExpanded ? (
            <div className="pool-scanner-terminal-card">
              <div className="pool-scanner-terminal-header">
                <div className="terminal-header-title">
                  <Terminal size={15} />
                  <span>LIVE PIPELINE LOGS</span>
                  <span className="terminal-log-count">
                    {state?.logs?.length || 0} lines
                  </span>
                </div>

                {state?.logs && state.logs.length > 0 ? (
                  <button
                    type="button"
                    className="terminal-copy-btn"
                    onClick={handleCopyLogs}
                    title="Copy all logs"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "Copied" : "Copy logs"}
                  </button>
                ) : null}
              </div>

              <div
                className="pool-scanner-terminal-body"
                ref={logsContainerRef}
              >
                {state?.logs && state.logs.length > 0 ? (
                  state.logs.map((log, index) => {
                    let lineClass = "pool-scanner-log-line";
                    if (
                      log.includes("[FAIL]") ||
                      log.includes("FAILED") ||
                      log.includes("Error:") ||
                      log.includes("error:")
                    ) {
                      lineClass += " log-error";
                    } else if (
                      log.includes("[OK]") ||
                      log.includes("COMPLETE") ||
                      log.includes("Success")
                    ) {
                      lineClass += " log-success";
                    } else if (
                      log.includes("[STAGE") ||
                      log.includes("POOL ")
                    ) {
                      lineClass += " log-stage";
                    }

                    return (
                      <div key={index} className={lineClass}>
                        <span className="log-line-num">
                          {String(index + 1).padStart(3, "0")}
                        </span>
                        <span className="log-line-text">{log}</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="pool-scanner-terminal-empty">
                    <Terminal size={20} />
                    <span>No logs available yet.</span>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="pool-scanner-info-grid">
        <article>
          <span className="pool-scanner-info-label">POOL POLICY</span>
          <strong>Exact TOKEN ↔ SOL</strong>
          <p>Pool matching is based on mint addresses, never token symbols.</p>
        </article>

        <article>
          <span className="pool-scanner-info-label">WALLET SOURCE</span>
          <strong>Top LPers</strong>
          <p>Only <code>data[].owner</code> is retained from LP Agent.</p>
        </article>

        <article>
          <span className="pool-scanner-info-label">DEDUPLICATION</span>
          <strong>Global across pools</strong>
          <p>The same wallet discovered in multiple pools is stored once.</p>
        </article>

        <article>
          <span className="pool-scanner-info-label">OUTPUT</span>
          <strong>Scanner dataset</strong>
          <p>Enriched wallets are merged into master data and published.</p>
        </article>
      </section>

      {/* Custom Stop Confirmation Modal */}
      {showStopModal ? (
        <div className="pool-scanner-modal-overlay" onClick={handleCloseStopModal}>
          <div
            className="pool-scanner-modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="stop-modal-title"
          >
            <div className="pool-scanner-modal-header">
              <div className="pool-scanner-modal-icon-box">
                <AlertCircle size={18} />
              </div>
              <div>
                <h3 id="stop-modal-title">Stop Pool Scanner?</h3>
                <p className="pool-scanner-modal-desc">
                  Stopping now will terminate the current pipeline. Any
                  unfinished stages will not continue.
                </p>
              </div>
            </div>

            <div className="pool-scanner-modal-meta">
              <span className="pool-scanner-modal-meta-label">CURRENT STAGE</span>
              <span className="pool-scanner-modal-meta-value">
                {STAGE_LABELS[state?.stage || ""] || state?.stage || "Running"}
              </span>
            </div>

            {stopModalError ? (
              <div className="pool-scanner-modal-error">
                <AlertCircle size={14} />
                <span>{stopModalError}</span>
              </div>
            ) : null}

            <div className="pool-scanner-modal-actions">
              <button
                type="button"
                className="pool-scanner-modal-btn cancel"
                onClick={handleCloseStopModal}
                disabled={stopping}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pool-scanner-modal-btn danger"
                onClick={handleConfirmStop}
                disabled={stopping}
              >
                {stopping ? (
                  <>
                    <Loader2 size={13} className="spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square size={11} fill="currentColor" />
                    Stop Scan
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
