import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";

// oxlint-disable-next-line import/no-unassigned-import -- Loads application styles.
import "./app.css";
import { AppProviders } from "./providers.js";

const root = document.querySelector<HTMLElement>("#app");

if (root === null) {
  throw new Error("Missing #app root.");
}

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
