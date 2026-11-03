// Theme switch: auto follows the device; light and dark are kept per browser.
import { useSyncExternalStore } from "react";
export type ThemeChoice = "auto" | "light" | "dark";

export function getTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem("hh_theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function setTheme(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  try {
    if (t === "auto") localStorage.removeItem("hh_theme");
    else localStorage.setItem("hh_theme", t);
  } catch {
    /* not saved; still applied */
  }
}

/** The mode actually showing now. */
export function resolvedTheme(): "light" | "dark" {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** the mode showing now, kept current when the device or the person switches it (charts draw their own colours) */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, resolvedTheme, () => "dark");
}
function subscribeTheme(f: () => void) {
  const mq = matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", f);
  const mo = new MutationObserver(f);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    mq.removeEventListener("change", f);
    mo.disconnect();
  };
}
