import type { ReactNode } from "react";
import { Lockup } from "./brand";
import { MOCK } from "../lib/app";
import { onLink } from "../lib/router";

export function TopBar({ children, back }: { children?: ReactNode; back?: boolean }) {
  return (
    <header className="topbar">
      {back ? (
        <a className="btn btn-sm btn-quiet" href="/" onClick={onLink} aria-label="All boards" style={{ marginLeft: -10 }}>
          ← <span className="hide-sm">Boards</span>
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
      <a className="btn btn-sm btn-quiet" href="/settings" onClick={onLink} data-testid="nav-settings" style={{ marginRight: -10 }}>
        Settings
      </a>
    </header>
  );
}
