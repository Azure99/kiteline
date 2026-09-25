import clone from "@ungap/structured-clone";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { i18nReady } from "./i18n";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

if (!globalThis.structuredClone) globalThis.structuredClone = (value) => clone(value);

void i18nReady.then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider delay={400}>
        <App />
      </TooltipProvider>
    </StrictMode>,
  );
});
