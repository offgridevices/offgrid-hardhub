// Numbers as people read them. Mono is applied by the caller.
export const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const int = (n: number) => n.toLocaleString("en-US");

// numbers and their units never split across lines (a no-break space)
export function bytes(n: number) {
  if (n < 1024) return `${n}\u00a0B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}\u00a0KB`;
  return `${(n / 1024 / 1024).toFixed(1)}\u00a0MB`;
}

/** Text with short hyphenated words ("USB-C", "US-hosted", "2-layer") kept
 * whole: their hyphen becomes a non-breaking one. */
export function keepHyphens(text: string) {
  return text.replace(/\b([\w.]{1,12})-(?=[\w.]{1,12}\b)/g, "$1\u2011");
}

export function date(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return date(iso);
}

// the same words as the tabs where a stage and a tab mean the same thing
export const STAGE_LABEL = {
  idea: "Requirements",
  parts: "Parts",
  circuit: "Circuit",
  board: "Size\u00a0& layers",
  layout: "Layout",
  checks: "Checks",
  view: "3D",
  order: "Order",
} as const;
