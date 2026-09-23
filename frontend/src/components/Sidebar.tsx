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

type ActivePage = "explore" | "pools" | "track" | "portfolio";
type AppPage = "explore" | "track" | "portfolio";

type Props = {
  activePage: ActivePage;
  onNavigate: (page: AppPage) => void;
};

type SidebarItem = {
  label: string;
  icon: typeof WalletCards;
  page?: AppPage;
  href?: string;
  activeKey?: ActivePage;
};

const discover: SidebarItem[] = [
  {
    label: "Wallet Explorer",
    icon: WalletCards,
    page: "explore",
    activeKey: "explore",
  },
  {
    label: "Pool Explorer",
    icon: Coins,
    href: "/pools",
    activeKey: "pools",
  },
  { label: "Token Insights", icon: Activity },
  { label: "Trends", icon: ChartNoAxesCombined },
  { label: "Opportunities", icon: Star },
];

const watchlist: SidebarItem[] = [
  { label: "My Wallets", icon: WalletCards },
  {
    label: "Tracked Wallets",
    icon: ShieldCheck,
    page: "track",
    activeKey: "track",
  },
];

const tools: SidebarItem[] = [
  { label: "Screener", icon: CircleGauge },
  { label: "Alerts", icon: Bell },
  { label: "Settings", icon: Settings },
];

function SidebarButton({
  item,
  activePage,
  onNavigate,
}: {
  item: SidebarItem;
  activePage: ActivePage;
  onNavigate: (page: AppPage) => void;
}) {
  const Icon = item.icon;
  const active = item.activeKey === activePage;

  function handleClick() {
    if (item.href) {
      window.location.assign(item.href);
      return;
    }

    if (item.page) {
      onNavigate(item.page);
    }
  }

  return (
    <button
      className={`nav-item ${active ? "active" : ""}`}
      onClick={handleClick}
    >
      <Icon size={16} strokeWidth={1.7} />
      <span>{item.label}</span>
    </button>
  );
}

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
        {discover.map((item) => (
          <SidebarButton
            key={item.label}
            item={item}
            activePage={activePage}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      <div className="sidebar-section">
        <span className="sidebar-heading">WATCHLIST</span>
        {watchlist.map((item) => (
          <SidebarButton
            key={item.label}
            item={item}
            activePage={activePage}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      <div className="sidebar-section">
        <span className="sidebar-heading">TOOLS</span>
        {tools.map((item) => (
          <SidebarButton
            key={item.label}
            item={item}
            activePage={activePage}
            onNavigate={onNavigate}
          />
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
