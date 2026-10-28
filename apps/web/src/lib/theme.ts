// Theme switch: auto follows the device; light and dark are kept per browser.
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
