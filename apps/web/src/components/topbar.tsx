import type { ReactNode } from "react";
import { ChevronLeftIcon, SettingsIcon } from "lucide-react";
import { Lockup } from "./brand";
import { MOCK } from "../lib/app";
import { onLink } from "../lib/router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function TopBar({ children, back, current, actions }: { children?: ReactNode; back?: boolean; current?: "settings"; actions?: ReactNode }) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-4">
      {back ? (
        <>
          <Button variant="ghost" size="sm" asChild className="-ml-1 px-2">
            <a href="/" onClick={onLink} aria-label="All boards">
              <ChevronLeftIcon />
              {/* with no title beside it (Settings) the word fits on a phone too */}
              <span className={children ? "hidden sm:inline" : undefined}>Boards</span>
            </a>
          </Button>
          {children && <span className="hidden text-muted-foreground/60 sm:inline">/</span>}
        </>
      ) : (
        <Lockup />
      )}
      <div className="flex min-w-0 grow items-center gap-3">{children}</div>
      {MOCK && (
        <Badge tone="gold" title="Demo mode: scripted data, no server" data-testid="demo-tag">
          Demo
        </Badge>
      )}
      {actions}
      <Button
        variant={current === "settings" ? "secondary" : "ghost"}
        size="sm"
        asChild
        className="-mr-1"
      >
        <a href="/settings" onClick={onLink} aria-current={current === "settings" ? "page" : undefined} data-testid="nav-settings" aria-label="Settings">
          <SettingsIcon />
          <span className="hidden sm:inline">Settings</span>
        </a>
      </Button>
    </header>
  );
}

/** A full-height screen: the top bar, then whatever fills the rest. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-dvh flex-col ${className ?? ""}`}>{children}</div>;
}
