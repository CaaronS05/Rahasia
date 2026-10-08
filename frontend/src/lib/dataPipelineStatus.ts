import { useCallback, useEffect, useRef, useState } from "react";
import { getFabriqStatus, type FabriqState } from "./fabriqControl";
import { getLpAgentStatus, type LpAgentState } from "./lpAgentControl";
import { getPoolScannerStatus, getPoolRefreshStatus, type PoolScannerState, type PoolRefreshState } from "./poolScannerControl";
import { getWalletIntelligenceStatus, type WalletIntelligenceState } from "./walletIntelligenceControl";

interface PipelineSnapshot {
  fabriq: FabriqState | null;
  lpagent: LpAgentState | null;
  poolScanner: PoolScannerState | null;
  poolRefresh: PoolRefreshState | null;
  intelligence: WalletIntelligenceState | null;
}

export interface DataPipelineStatus extends PipelineSnapshot {
  anyRunning: boolean;
  available: boolean;
  refresh: () => Promise<void>;
}

export function useDataPipelineStatus(onDatasetRefreshed: () => void): DataPipelineStatus {
  const [snapshot, setSnapshot] = useState<PipelineSnapshot>({
    fabriq: null, lpagent: null, poolScanner: null, intelligence: null,
  });
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const previous = useRef<Record<string, string>>({});
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const results = await Promise.allSettled([
        getFabriqStatus(), getLpAgentStatus(), getPoolScannerStatus(), getWalletIntelligenceStatus(), getPoolRefreshStatus(),
      ]);
      if (!mounted.current) return;
      const next: PipelineSnapshot = {
        fabriq: results[0].status === "fulfilled" ? results[0].value : null,
        lpagent: results[1].status === "fulfilled" ? results[1].value : null,
        poolScanner: results[2].status === "fulfilled" ? results[2].value : null,
        intelligence: results[3].status === "fulfilled" ? results[3].value : null,
        poolRefresh: results[4].status === "fulfilled" ? results[4].value : null,
      };
      let completed = false;
      for (const [key, value] of Object.entries(next)) {
        if (!value) continue;
        // Run identity also catches completion while this page was not visible.
        const result = `${value.startedAt}:${value.status}`;
        if (value.status === "completed" && previous.current[key] !== result) completed = true;
        previous.current[key] = result;
      }
      setSnapshot(next);
      if (completed) onDatasetRefreshed();
    } finally {
      inFlight.current = false;
    }
  }, [onDatasetRefreshed]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  const values = Object.values(snapshot);
  return {
    ...snapshot,
    anyRunning: values.some((value) => value?.running || value?.status === "running" || value?.status === "stopping"),
    available: values.every(Boolean),
    refresh,
  };
}
