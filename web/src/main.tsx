import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

// Register service worker (vite-plugin-pwa injects this in production builds)
// In dev, the import resolves to a no-op stub.
import { registerSW } from "virtual:pwa-register";
registerSW({ immediate: false });

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
