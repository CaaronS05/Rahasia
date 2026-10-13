export type Timeframe = "7d" | "30d" | "all";
export type Page = "explore" | "pools" | "track" | "portfolio" | "data" | "activity-logs";
export type ActivePage = Page;
export type AppPage = Page;

export type NavigationItemConfig = {
  label: string;
  page?: AppPage;
  activeKey?: ActivePage;
  disabled?: boolean;
};

export const DISCOVER_NAV_ITEMS: NavigationItemConfig[] = [
  {
    label: "Wallet Explorer",
    page: "explore",
    activeKey: "explore",
  },
  {
    label: "Pool Explorer",
    page: "pools",
    activeKey: "pools",
  },
  { label: "Token Insights", disabled: true },
  { label: "Trends", disabled: true },
  { label: "Opportunities", disabled: true },
];

export const WATCHLIST_NAV_ITEMS: NavigationItemConfig[] = [
  { label: "My Wallets", disabled: true },
  {
    label: "Tracked Wallets",
    page: "track",
    activeKey: "track",
  },
];

export const TOOLS_NAV_ITEMS: NavigationItemConfig[] = [
  {
    label: "Data",
    page: "data",
    activeKey: "data",
  },
  {
    label: "Activity Logs",
    page: "activity-logs",
    activeKey: "activity-logs",
  },
  { label: "Alerts", disabled: true },
  { label: "Settings", disabled: true },
];

export const PORTFOLIO_TAB_ITEMS = [
  { id: "Overview", label: "Overview", enabled: true },
  { id: "Position Analytics", label: "Position Analytics", enabled: true },
  { id: "Active Positions", label: "Active Positions", enabled: false },
  { id: "Closed Positions", label: "Closed Positions", enabled: false },
  { id: "Transactions", label: "Transactions", enabled: false },
  { id: "Balances", label: "Balances", enabled: false },
] as const;

export type PortfolioTabId = typeof PORTFOLIO_TAB_ITEMS[number]["id"];

export function resolveRouteFromPath(pathname: string, search: string = ""): {
  page: Page;
  address?: string;
  dataTab?: any;
} {
  const match = pathname.match(/^\/portfolio\/([^/]+)$/);
  if (match) {
    return {
      page: "portfolio",
      address: decodeURIComponent(match[1]),
    };
  }

  if (pathname === "/portfolio") {
    return { page: "portfolio" };
  }

  if (pathname === "/track") {
    return { page: "track" };
  }

  if (pathname === "/activity-logs" || pathname === "/logs") {
    return { page: "activity-logs" };
  }

  if (pathname === "/pool-scanner") {
    return { page: "data", dataTab: "pool-scanner" };
  }

  if (pathname === "/data") {
    const tabParam = new URLSearchParams(search).get("tab");
    if (tabParam === "pool-insight") {
      return { page: "pools" };
    }
    const validDataTabs = ["overview", "wallet-data", "pool-scanner", "wallet-intelligence"];
    const tab = validDataTabs.includes(tabParam ?? "") ? tabParam : "overview";
    return { page: "data", dataTab: tab };
  }

  if (pathname.startsWith("/pools")) {
    return { page: "pools" };
  }

  return { page: "explore" };
}

export function routeFromLocation(): { page: Page; address?: string; dataTab?: any } {
  if (typeof window === "undefined") {
    return { page: "explore" };
  }
  return resolveRouteFromPath(window.location.pathname, window.location.search);
}

export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", path);
  const event = typeof PopStateEvent !== "undefined"
    ? new PopStateEvent("popstate")
    : new Event("popstate");
  window.dispatchEvent(event);
}
