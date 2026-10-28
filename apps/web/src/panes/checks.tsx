// Every check that ran: what it tested, why it matters, the result. A miss is
// written exactly like a pass.
import type { CheckResult } from "@hardhub/protocol";

const GROUPS: { id: CheckResult["group"]; name: string }[] = [
  { id: "circuit", name: "Circuit" },
  { id: "layout", name: "Layout" },
  { id: "power", name: "Power" },
  { id: "thermal", name: "Heat" },
  { id: "firmware", name: "Firmware" },
  { id: "fab", name: "Manufacturing" },
];
// sentence case, like every other label
const ST: Record<CheckResult["status"], string> = { pass: "Pass", fail: "Fail", warn: "Warning", skip: "Not run" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Checks({ checks }: { checks: CheckResult[] }) {
  if (checks.length === 0)
    return (
      <div className="pane-inner">
        <div className="empty">
          <h2 className="d4">Nothing checked yet</h2>
          <p>
            Checks run on the circuit as soon as it is wired, and on the routed board after layout: design rules with the fab's
            own limits, copper against the circuit pad for pad, track widths for their current, heat, and the firmware's pin map.
          </p>
        </div>
      </div>
    );
  const n = (s: CheckResult["status"]) => checks.filter((c) => c.status === s).length;
  return (
    <div className="pane-inner">
      <div className="stats">
        <div className="stat">
          <span className="n">
            {n("pass")} <span className="of">of</span> {checks.length}
          </span>
          <span className="m">checks pass</span>
        </div>
        <div className="stat">
          <span className="n">{n("fail")}</span>
          <span className="m">fail</span>
        </div>
        <div className="stat">
          <span className="n">{n("warn")}</span>
          <span className="m">need a look</span>
        </div>
        <div className="stat">
          <span className="n">{n("skip")}</span>
          <span className="m">after hardware</span>
        </div>
      </div>
      {GROUPS.map((g) => {
        const rows = checks.filter((c) => c.group === g.id);
        if (!rows.length) return null;
        return (
          <section key={g.id}>
            <h3 className="section-title">{g.name}</h3>
            <div style={{ borderTop: "1px solid var(--hairline-strong)" }}>
              {rows.map((c) => (
                <div key={c.id} className={`check ${c.status}`} data-testid="check-row" data-status={c.status}>
                  <span className="st">{ST[c.status]}</span>
                  <span className="name">{c.name}</span>
                  <span className="why">{cap(c.why)}</span>
                  {c.detail && <span className="det">{c.detail}</span>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
