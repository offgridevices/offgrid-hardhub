import type { ReactNode } from "react";
import { Lockup } from "./brand";
import { MOCK } from "../lib/app";
import { onLink } from "../lib/router";

export function TopBar({ children, back, current }: { children?: ReactNode; back?: boolean; current?: "settings" }) {
  return (
    <header className="topbar">
      {back ? (
        <a className="btn btn-sm btn-quiet" href="/" onClick={onLink} aria-label="All boards" style={{ marginLeft: -10 }}>
          {/* with no title beside it (Settings) the word fits on a phone too */}
          ← <span className={children ? "hide-sm" : undefined}>Boards</span>
        </a>
      ) : (
        <Lockup />
      )}
      <div className="grow" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        {children}
      </div>
      {MOCK && (
        <span className="tag" title="Demo mode: scripted data, no server" data-testid="demo-tag">
          Demo
        </span>
      )}
      <a
        className={`btn btn-sm btn-quiet${current === "settings" ? " is-current" : ""}`}
        href="/settings"
        onClick={onLink}
        aria-current={current === "settings" ? "page" : undefined}
        data-testid="nav-settings"
        style={{ marginRight: -10 }}
      >
        Settings
      </a>
    </header>
  );
}
