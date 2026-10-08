import { Sidebar } from "../components/Sidebar";
import { PoolInsightPage } from "./PoolInsightPage";

export function PoolExplorerPage() {
  function navigateApp(pageName: "explore" | "track" | "portfolio" | "data") {
    const path =
      pageName === "track"
        ? "/track"
        : pageName === "portfolio"
          ? "/portfolio"
          : pageName === "data"
            ? "/data"
            : "/";

    window.location.assign(path);
  }

  return (
    <div className="app-shell">
      <Sidebar activePage="pools" onNavigate={navigateApp} />

      <main className="main-content">
        <header className="topbar">
          <nav className="top-nav">
            <button className="active" onClick={() => window.location.assign("/")}>
              EXPLORE
            </button>
            <button onClick={() => window.location.assign("/track")}>TRACK</button>
            <button>COPY TRADE</button>
            <button onClick={() => window.location.assign("/portfolio")}>
              PORTFOLIO
            </button>
            <button>LEADERBOARD</button>
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
