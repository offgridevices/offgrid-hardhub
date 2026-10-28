// A small history router: four screens do not need a routing library.
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "signin" }
  | { name: "verify" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "settings" }
  | { name: "connect" }
  | { name: "notfound" };

export function parse(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "projects" };
  if (p === "/signin") return { name: "signin" };
  // the link in the sign-in email
  if (p === "/auth/verify") return { name: "verify" };
  if (p === "/settings") return { name: "settings" };
  // an AI app asking to connect (MCP sign-in)
  if (p === "/connect") return { name: "connect" };
  const m = /^\/p\/([\w-]+)$/.exec(p);
  if (m) return { name: "project", id: m[1]! };
  return { name: "notfound" };
}

// Where to go after signing in: the consent page an AI app sent the person
// to. Kept in localStorage, because the sign-in email may open a new tab.
const NEXT_KEY = "hh_next";
const NEXT_MINUTES = 30;

export function rememberNext(path: string) {
  try {
    localStorage.setItem(NEXT_KEY, JSON.stringify({ path, until: Date.now() + NEXT_MINUTES * 60_000 }));
  } catch {
    /* private mode: the person lands on their boards instead */
  }
}

/** the remembered path (once), or "/" */
export function takeNext(): string {
  try {
    const raw = localStorage.getItem(NEXT_KEY);
    localStorage.removeItem(NEXT_KEY);
    const v = raw ? (JSON.parse(raw) as { path?: unknown; until?: unknown }) : null;
    // only a path on this site, never another origin
    if (v && typeof v.path === "string" && v.path.startsWith("/") && !v.path.startsWith("//") && Number(v.until) > Date.now()) return v.path;
  } catch {
    /* unreadable: ignore */
  }
  return "/";
}

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
if (typeof window !== "undefined") window.addEventListener("popstate", emit);

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const getPath = () => location.pathname;

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath, () => "/");
}

/** Plain links that navigate without a reload (modifier clicks still open tabs). */
export function onLink(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute("href");
  if (!href || !href.startsWith("/")) return;
  e.preventDefault();
  navigate(href);
}
