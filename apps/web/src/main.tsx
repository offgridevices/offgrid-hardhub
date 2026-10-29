// Fonts: Geist and Geist Mono, variable, Latin only (OFL, self-hosted).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./lib/app";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </AppProvider>
  </StrictMode>,
);
