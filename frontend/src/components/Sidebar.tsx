import {
  Activity,
  Bell,
  ChartNoAxesCombined,
  Database,
  Coins,
  Settings,
  ShieldCheck,
  Star,
  Terminal,
  WalletCards,
} from "lucide-react";
import {
  DISCOVER_NAV_ITEMS,
  WATCHLIST_NAV_ITEMS,
  TOOLS_NAV_ITEMS,
  type ActivePage,
  type AppPage,
} from "../lib/navigation";

export type { ActivePage, AppPage };

type Props = {
  activePage: ActivePage;
  onNavigate: (page: AppPage) => void;
};

export type SidebarItem = {
  label: string;
  icon: typeof WalletCards;
  page?: AppPage;
  activeKey?: ActivePage;
  disabled?: boolean;
};

const iconMap: Record<string, typeof WalletCards> = {
  "Wallet Explorer": WalletCards,
  "Pool Explorer": Coins,
  "Token Insights": Activity,
  "Trends": ChartNoAxesCombined,
  "Opportunities": Star,
  "My Wallets": WalletCards,
  "Tracked Wallets": ShieldCheck,
  "Data": Database,
  "Activity Logs": Terminal,
  "Alerts": Bell,
  "Settings": Settings,
};

export const discover: SidebarItem[] = DISCOVER_NAV_ITEMS.map((item) => ({
  ...item,
  icon: iconMap[item.label] ?? WalletCards,
}));

export const watchlist: SidebarItem[] = WATCHLIST_NAV_ITEMS.map((item) => ({
  ...item,
  icon: iconMap[item.label] ?? WalletCards,
}));

export const tools: SidebarItem[] = TOOLS_NAV_ITEMS.map((item) => ({
  ...item,
  icon: iconMap[item.label] ?? WalletCards,
}));

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
  const isDisabled = Boolean(item.disabled);

  function handleClick() {
    if (isDisabled) return;
    if (item.page) {
      onNavigate(item.page);
    }
  }

  return (
    <button
      className={`nav-item ${active ? "active" : ""} ${isDisabled ? "disabled" : ""}`}
      onClick={handleClick}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      title={isDisabled ? "Unavailable" : undefined}
    >
      <Icon size={16} strokeWidth={1.7} />
      <span>{item.label}</span>
      {isDisabled ? <span className="nav-item-badge">Soon</span> : null}
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
