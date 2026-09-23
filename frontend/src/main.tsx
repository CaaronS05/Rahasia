import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PoolExplorerPage } from "./pages/PoolExplorerPage";
import "./styles.css";
import "./pool-explorer.css";

const isPoolExplorerRoute = /^\/pools\/?$/.test(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPoolExplorerRoute ? <PoolExplorerPage /> : <App />}
  </StrictMode>,
);
