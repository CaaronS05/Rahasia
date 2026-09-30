import { ArrowRight, Database, Layers3, ScanSearch } from "lucide-react";
import { WalletDataControlPanel } from "../components/data/WalletDataControlPanel";
import { WalletIntelligencePanel, dataTimestamp } from "../components/data/WalletIntelligencePanel";
import type { DataPipelineStatus } from "../lib/dataPipelineStatus";
import { PoolScannerPage } from "./PoolScannerPage";
import "../data-page.css";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "wallet-data", label: "Wallet Data" },
  { key: "pool-scanner", label: "Pool Scanner" },
  { key: "wallet-intelligence", label: "Wallet Intelligence" },
] as const;
export type DataTab = typeof TABS[number]["key"];
export function resolveDataTab(value: string | null): DataTab {
  return TABS.find((tab) => tab.key === value)?.key ?? "overview";
}

function statusLabel(status: string | undefined) {
  return status === "idle" ? "Ready" : status ? status[0].toUpperCase() + status.slice(1) : "—";
}

export function DataPage({ tab, onTabChange, walletCount, lastUpdated, intelligenceUpdatedAt, pipelines, onDatasetRefreshed }: {
  tab: DataTab;
  onTabChange: (tab: DataTab) => void;
  walletCount: number | null;
  lastUpdated: string | null;
  intelligenceUpdatedAt: string | null;
  pipelines: DataPipelineStatus;
  onDatasetRefreshed: () => void;
}) {
  const walletRunning = Boolean(pipelines.fabriq?.running || pipelines.lpagent?.running);
  const walletState = walletRunning
    ? (pipelines.lpagent?.running ? pipelines.lpagent : pipelines.fabriq)
    : [pipelines.fabriq, pipelines.lpagent].filter((value) => value !== null).sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
  const poolRunning = Boolean(pipelines.poolScanner?.running);
  const intelligenceRunning = Boolean(pipelines.intelligence?.running);
  const walletBlocked = !pipelines.available || poolRunning || intelligenceRunning;
  const poolBlocked = !pipelines.available || walletRunning || intelligenceRunning;
  const intelligenceBlocked = !pipelines.available || pipelines.anyRunning;
  const published = pipelines.intelligence?.lastPublishedAt ?? intelligenceUpdatedAt;

  return <div className="data-page">
    <header className="data-heading"><div><h1>DATA CONTROL CENTER</h1><p>Manage wallet datasets, discovery pipelines, and Wallet Intelligence from one workspace.</p></div>
      <span className={`data-status ${pipelines.anyRunning ? "status-running" : ""}`}>{pipelines.anyRunning ? "PIPELINE ACTIVE" : pipelines.available ? "READY" : "CONTROL UNAVAILABLE"}</span>
    </header>
    <nav className="data-tabs" aria-label="Data sections">
      {TABS.map((item) => <button key={item.key} aria-current={tab === item.key ? "page" : undefined} className={tab === item.key ? "active" : ""} onClick={() => onTabChange(item.key)}>{item.label}</button>)}
    </nav>
    {!pipelines.available && <div className="data-notice" role="status">Control status is unavailable. Start controls are disabled until the local control server is connected.</div>}
    {pipelines.anyRunning && <div className="data-notice" role="status">Another data pipeline is currently running. Incompatible start controls are disabled.</div>}
    {tab === "overview" && <section className="data-overview" aria-label="Pipeline overview">
      <article className="data-overview-card"><Database size={19} /><h2>WALLET DATA</h2><strong className="data-overview-value">{walletCount?.toLocaleString() ?? "—"}<small> wallets</small></strong>
        <dl><div><dt>Last published</dt><dd>{dataTimestamp(lastUpdated)}</dd></div><div><dt>Status</dt><dd>{statusLabel(walletState?.status)}</dd></div></dl>
        <button className="secondary-button" onClick={() => onTabChange("wallet-data")}>Open Wallet Data <ArrowRight size={13} /></button></article>
      <article className="data-overview-card"><ScanSearch size={19} /><h2>POOL SCANNER</h2><strong className="data-overview-value">{statusLabel(pipelines.poolScanner?.status)}</strong>
        <dl><div><dt>Active token</dt><dd className="data-token" title={pipelines.poolScanner?.tokenCa ?? undefined}>{pipelines.poolScanner?.tokenCa ?? "—"}</dd></div><div><dt>Stage</dt><dd>{pipelines.poolScanner?.stage ?? "—"}</dd></div></dl>
        <button className="secondary-button" onClick={() => onTabChange("pool-scanner")}>Open Pool Scanner <ArrowRight size={13} /></button></article>
      <article className="data-overview-card"><Layers3 size={19} /><h2>WALLET INTELLIGENCE</h2><strong className="data-overview-value">{statusLabel(pipelines.intelligence?.status)}</strong>
        <dl><div><dt>Last published</dt><dd>{dataTimestamp(published)}</dd></div><div><dt>Stage</dt><dd>{pipelines.intelligence?.stage ?? "—"}</dd></div></dl>
        <button className="secondary-button" onClick={() => onTabChange("wallet-intelligence")}>Open Intelligence <ArrowRight size={13} /></button></article>
    </section>}
    <div hidden={tab !== "wallet-data"}><WalletDataControlPanel walletCount={walletCount} lastUpdated={lastUpdated} startDisabled={walletBlocked} onDatasetRefreshed={onDatasetRefreshed} /></div>
    <div hidden={tab !== "pool-scanner"}><PoolScannerPage embedded startDisabled={poolBlocked} onDatasetRefreshed={onDatasetRefreshed} /></div>
    <div hidden={tab !== "wallet-intelligence"}><WalletIntelligencePanel state={pipelines.intelligence} startDisabled={intelligenceBlocked} onStateChanged={pipelines.refresh} /></div>
  </div>;
}
