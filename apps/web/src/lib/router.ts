// A small history router: four screens do not need a routing library.
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "signin" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "settings" }
  | { name: "notfound" };

export function parse(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "projects" };
  if (p === "/signin") return { name: "signin" };
  if (p === "/settings") return { name: "settings" };
  const m = /^\/p\/([\w-]+)$/.exec(p);
  if (m) return { name: "project", id: m[1]! };
  return { name: "notfound" };
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
