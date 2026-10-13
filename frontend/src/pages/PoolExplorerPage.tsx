import { Sidebar, type AppPage } from "../components/Sidebar";
import { PoolInsightPage } from "./PoolInsightPage";

export function PoolExplorerPage() {
  function navigateApp(pageName: AppPage) {
    const path =
      pageName === "track"
        ? "/track"
        : pageName === "portfolio"
          ? "/portfolio"
          : pageName === "data"
            ? "/data"
            : pageName === "activity-logs"
              ? "/activity-logs"
              : pageName === "pools"
                ? "/pools"
                : "/";
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function handleSpaNav(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  return (
    <div className="app-shell">
      <Sidebar activePage="pools" onNavigate={navigateApp} />

      <main className="main-content">
        <header className="topbar">
          <nav className="top-nav">
            <button onClick={() => handleSpaNav("/")}>
              EXPLORE
            </button>
            <button onClick={() => handleSpaNav("/track")}>TRACK</button>
            <button className="active" onClick={() => handleSpaNav("/pools")}>
              POOLS
            </button>
            <button className="top-nav-disabled" disabled aria-disabled="true" title="Unavailable">
              COPY TRADE
            </button>
            <button onClick={() => handleSpaNav("/portfolio")}>
              PORTFOLIO
            </button>
            <button className="top-nav-disabled" disabled aria-disabled="true" title="Unavailable">
              LEADERBOARD
            </button>
          </nav>

          <div className="topbar-right">
            <button className="network-select">
              <span className="solana-mark">≋</span>
              Solana
            </button>
          </div>
        </header>

        <div className="pool-explorer-page">
          <PoolInsightPage />
        </div>
      </main>
    </div>
  );
}
