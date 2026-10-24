import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { NightfallProvider } from "./state/NightfallProvider";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <NightfallProvider>
        <App />
      </NightfallProvider>
    </HashRouter>
  </StrictMode>,
);
