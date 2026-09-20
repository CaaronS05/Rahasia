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

const nav = [
  { label: "Overview", icon: CircleGauge },
  { label: "Wallet Explorer", icon: WalletCards, active: true },
  { label: "Pool Analyzer", icon: Coins },
  { label: "Watchlist", icon: Star },
  { label: "Analytics", icon: ChartNoAxesCombined },
  { label: "Alerts", icon: Bell },
  { label: "Settings", icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><ShieldCheck size={19} /></div>
        <div>
          <div className="brand-name">SOLTRACE</div>
          <div className="brand-sub">LP ANALYTICS</div>
        </div>
      </div>

      <nav className="nav-list">
        {nav.map(({ label, icon: Icon, active }) => (
          <button key={label} className={`nav-item ${active ? "active" : ""}`}>
            <Icon size={17} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-promo">
        <Activity size={22} />
        <strong>Track smarter.</strong>
        <span>Explore LP behavior before building automated screening.</span>
      </div>

      <div className="profile-row">
        <div className="avatar">A</div>
        <div>
          <strong>Aaron C.</strong>
          <span>Local workspace</span>
        </div>
      </div>
    </aside>
  );
}
