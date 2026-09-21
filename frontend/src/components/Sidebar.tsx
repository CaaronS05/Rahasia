import {
  Activity,
  Bell,
  ChartNoAxesCombined,
  CircleGauge,
  Coins,
  Settings,
  ShieldCheck,
  Star,
  WalletCards,
} from "lucide-react";

type Props = {
  activePage: "explore" | "track" | "portfolio";
  onNavigate: (page: "explore" | "track" | "portfolio") => void;
};

const discover = [
  { label: "Wallet Explorer", icon: WalletCards, page: "explore" as const },
  { label: "Pool Explorer", icon: Coins },
  { label: "Token Insights", icon: Activity },
  { label: "Trends", icon: ChartNoAxesCombined },
  { label: "Opportunities", icon: Star },
];

const watchlist = [
  { label: "My Wallets", icon: WalletCards },
  { label: "Tracked Wallets", icon: ShieldCheck, page: "track" as const },
];

const tools = [
  { label: "Screener", icon: CircleGauge },
  { label: "Alerts", icon: Bell },
  { label: "Settings", icon: Settings },
];

export function Sidebar({ activePage, onNavigate }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <ShieldCheck size={18} />
        </div>
        <div>
          <div className="brand-name">LP SCANNER</div>
          <div className="brand-sub">DLMM INTELLIGENCE</div>
        </div>
      </div>

      <div className="sidebar-section">
        <span className="sidebar-heading">DISCOVER</span>
        {discover.map(({ label, icon: Icon, page }) => (
          <button
            key={label}
            className={`nav-item ${page === "explore" && activePage === "explore" ? "active" : ""}`}
            onClick={() => page && onNavigate(page)}
          >
            <Icon size={16} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-section">
        <span className="sidebar-heading">WATCHLIST</span>
        {watchlist.map(({ label, icon: Icon, page }) => (
          <button
            key={label}
            className={`nav-item ${page === "track" && activePage === "track" ? "active" : ""}`}
            onClick={() => page && onNavigate(page)}
          >
            <Icon size={16} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-section">
        <span className="sidebar-heading">TOOLS</span>
        {tools.map(({ label, icon: Icon }) => (
          <button key={label} className="nav-item">
            <Icon size={16} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-spacer" />

      <div className="workspace-status">
        <span className="status-dot" />
        <div>
          <strong>Scanner workspace</strong>
          <small>Local data mode</small>
        </div>
      </div>
    </aside>
  );
}
