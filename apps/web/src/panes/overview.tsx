// Requirements and decisions: what the board must do, and every choice made.
import type { Design } from "@hardhub/protocol";
import { date, keepHyphens } from "../lib/format";

const STATUS: Record<string, string> = { open: "Open", met: "Met", unmet: "Not met", limit: "Limit" };

export default function Overview({ design }: { design: Design }) {
  const reqs = design.requirements;
  const decs = design.decisions;
  return (
    <div className="pane-inner">
      <div className="pane-head">
        <h2 className="d4">{design.name}</h2>
        {design.summary && <p className="secondary">{keepHyphens(design.summary)}</p>}
      </div>

      <section>
        <h3 className="section-title">Requirements</h3>
        {reqs.length === 0 ? (
          <p className="muted small">None yet. They are written as the conversation settles what the board must do.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>#</th>
                  <th>Requirement</th>
                  <th className="hide-sm">How it is checked</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {reqs.map((r) => (
                  <tr key={r.id}>
                    <td className="num muted">{r.id}</td>
                    <td>
                      {keepHyphens(r.text)}
                      {r.note && <div className="small muted" style={{ marginTop: 4 }}>{r.note}</div>}
                    </td>
                    <td className="hide-sm secondary">{r.check ?? "—"}</td>
                    <td>
                      <span className={`tag${r.status === "unmet" || r.status === "limit" ? " tag-warn" : ""}`}>{STATUS[r.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="section-title">Decisions</h3>
        {decs.length === 0 ? (
          <p className="muted small">Each choice you make is recorded here with the options and the reason.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {decs.map((d) => {
              const chosen = d.options.find((o) => o.id === d.chosen);
              const others = d.options.filter((o) => o.id !== d.chosen);
              return (
                <div key={d.id} style={{ padding: "16px 0", borderBottom: "1px solid var(--hairline)", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <span className="label">{d.question}</span>
                    {d.at && <span className="small muted num">{date(d.at)}</span>}
                  </div>
                  <div style={{ fontWeight: 500 }}>{chosen ? chosen.label : "Not decided yet"}</div>
                  {d.why && <div className="small secondary">{d.why}</div>}
                  {others.length > 0 && <div className="small muted">Also considered: {others.map((o) => o.label).join(", ")}</div>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
