// Bill of materials: one line per part, with what it costs and whether it can
// be bought. Every price and stock figure carries the date it was read.
import { useMemo } from "react";
import type { Design } from "@hardhub/protocol";
import { date, int, usd } from "../lib/format";

const LIFE: Record<string, string> = { active: "In production", nrnd: "Not for new designs", eol: "End of life", unknown: "Status unknown" };
const TIER: Record<string, string> = { basic: "Basic", preferred: "Preferred", extended: "Extended" };

export default function Parts({ design }: { design: Design }) {
  const lines = useMemo(() => {
    const byPart = new Map<string, string[]>();
    for (const c of design.components) byPart.set(c.part, [...(byPart.get(c.part) ?? []), c.ref]);
    return [...byPart.entries()]
      .map(([key, refs]) => {
        const p = design.parts[key];
        const unit = p?.sourcing?.prices[0]?.usd ?? null;
        return { key, refs: refs.sort((a, b) => a.localeCompare(b, "en", { numeric: true })), p, unit, total: unit === null ? null : unit * refs.length };
      })
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  }, [design]);

  const rejected = useMemo(() => {
    const used = new Set(design.components.map((c) => c.part));
    return Object.entries(design.parts).filter(([k]) => !used.has(k));
  }, [design]);

  const count = design.components.length;
  const cost = lines.reduce((s, l) => s + (l.total ?? 0), 0);
  const extended = lines.filter((l) => l.p?.sourcing?.tier === "extended").length;
  const dates = lines.map((l) => l.p?.sourcing?.checked_at).filter(Boolean).sort() as string[];
  const risky = lines.filter((l) => l.p && (l.p.lifecycle === "nrnd" || l.p.lifecycle === "eol"));

  if (lines.length === 0)
    return (
      <div className="pane-inner">
        <div className="empty">
          <h2 className="d4">No parts yet</h2>
          <p>Parts appear here once you and HardHub have chosen them, with price, stock and whether they are still made.</p>
        </div>
      </div>
    );

  return (
    <div className="pane-inner">
      <div className="stats">
        <div className="stat">
          <span className="n">{count}</span>
          <span className="m">parts on the board</span>
        </div>
        <div className="stat">
          <span className="n">{usd(cost)}</span>
          <span className="m">parts per board, at 10</span>
        </div>
        <div className="stat">
          <span className="n">{extended}</span>
          <span className="m">extended types (≈$3 setup each)</span>
        </div>
        <div className="stat">
          <span className="n">{risky.length}</span>
          <span className="m">at end of life</span>
        </div>
      </div>

      <section>
        <h3 className="section-title">Bill of materials</h3>
        <div className="table-scroll">
          <table className="table" data-testid="bom">
            <thead>
              <tr>
                <th>Part</th>
                <th className="r">Qty</th>
                <th className="hide-sm">LCSC</th>
                <th className="hide-sm">JLCPCB</th>
                <th className="r hide-sm">Stock</th>
                <th className="r hide-sm">Each</th>
                <th className="r">Line</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ key, refs, p, unit, total }) => (
                <tr key={key} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 64px" }}>
                  <td style={{ minWidth: 150 }}>
                    <div style={{ fontWeight: 500 }}>{p?.value ?? p?.mpn ?? key}</div>
                    <div className="small muted">
                      {p?.mpn} · {p?.maker}
                    </div>
                    <div className="small secondary">{p?.description}</div>
                    <div className="small muted num" title={refs.join(", ")} style={{ marginTop: 2, overflowWrap: "anywhere" }}>
                      {refs.length > 6 ? `${refs.slice(0, 6).join(" ")} +${refs.length - 6}` : refs.join(" ")}
                    </div>
                    {p?.sourcing?.tier && (
                      <span className="tag show-sm" style={{ marginTop: 6, marginRight: 6 }}>
                        {TIER[p.sourcing.tier]}
                        {unit !== null && <span className="num"> · {usd(unit, unit < 0.1 ? 3 : 2)} each</span>}
                      </span>
                    )}
                    {p && p.lifecycle !== "active" && (
                      <span className={`tag${p.lifecycle === "unknown" ? "" : " tag-warn"}`} style={{ marginTop: 6 }}>
                        {LIFE[p.lifecycle]}
                      </span>
                    )}
                  </td>
                  <td className="r num">{refs.length}</td>
                  <td className="num hide-sm">{p?.sourcing?.lcsc ?? "—"}</td>
                  <td className="hide-sm">{p?.sourcing?.tier ? <span className="tag">{TIER[p.sourcing.tier]}</span> : <span className="muted">—</span>}</td>
                  <td className="r num hide-sm">{p?.sourcing?.stock !== undefined ? int(p.sourcing.stock) : "—"}</td>
                  <td className="r num hide-sm">{unit === null ? "—" : usd(unit, unit < 0.1 ? 3 : 2)}</td>
                  <td className="r num">{total === null ? "—" : usd(total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          {dates.length ? `Prices and stock from the JLCPCB catalogue, read ${date(dates[0]!)}${dates.at(-1) !== dates[0] ? ` to ${date(dates.at(-1)!)}` : ""}. ` : ""}
          Price at 10 pieces. Read them again before ordering: stock moves.
        </p>
      </section>

      {rejected.length > 0 && (
        <section>
          <h3 className="section-title">Considered, not used</h3>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {rejected.map(([k, p]) => (
              <div key={k} style={{ padding: "12px 0", borderBottom: "1px solid var(--hairline)", display: "flex", gap: 12, justifyContent: "space-between", flexWrap: "wrap" }}>
                <span>
                  {p.mpn} <span className="muted small">· {p.maker}</span>
                </span>
                <span className={`tag${p.lifecycle === "nrnd" || p.lifecycle === "eol" ? " tag-warn" : ""}`}>{LIFE[p.lifecycle]}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
