// The circuit, block by block, drawn from the design document: each part as a
// symbol whose pins carry net labels (parts on the same net are connected),
// and a pin table to check against the datasheet.
import { memo, useMemo, useState } from "react";
import type { Component, Design, Net } from "@hardhub/protocol";

const PITCH = 16; // between pins
const STUB = 14;
const LABEL = 92; // room for a net label
const BOX = 96;

function short(s: string, n = 13) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function natural(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true });
}

const Symbol = memo(function Symbol({ c, value, nets }: { c: Component; value: string; nets: Record<string, Net> }) {
  const pins = Object.entries(c.pins).sort(([a], [b]) => natural(a, b));
  const half = Math.ceil(pins.length / 2);
  const left = pins.slice(0, half);
  const right = pins.slice(half);
  const rows = Math.max(left.length, right.length, 1);
  const h = rows * PITCH + 20;
  const w = LABEL * 2 + STUB * 2 + BOX;
  const bx = LABEL + STUB;
  const cls = (net: string | null) => (net && nets[net] && nets[net]!.kind !== "signal" ? "pwr" : "net");
  return (
    <svg width={w} height={h + 34} viewBox={`0 0 ${w} ${h + 34}`} role="img" aria-label={`${c.ref} ${value}`}>
      <text className="ref" x={bx} y={13}>
        {c.ref}
      </text>
      <text className="val" x={bx + BOX} y={13} textAnchor="end">
        {short(value, 16)}
      </text>
      <rect className="body" x={bx} y={20} width={BOX} height={h} />
      {left.map(([pad, net], i) => {
        const y = 20 + 18 + i * PITCH;
        return (
          <g key={pad}>
            <line className="pin" x1={bx - STUB} y1={y} x2={bx} y2={y} />
            <text x={bx + 4} y={y + 3.5}>
              {short(pad, 4)}
            </text>
            <text className={cls(net)} x={bx - STUB - 4} y={y + 3.5} textAnchor="end">
              {net ? short(net) : "open"}
            </text>
          </g>
        );
      })}
      {right.map(([pad, net], i) => {
        const y = 20 + 18 + i * PITCH;
        return (
          <g key={pad}>
            <line className="pin" x1={bx + BOX} y1={y} x2={bx + BOX + STUB} y2={y} />
            <text x={bx + BOX - 4} y={y + 3.5} textAnchor="end">
              {short(pad, 4)}
            </text>
            <text className={cls(net)} x={bx + BOX + STUB + 4} y={y + 3.5}>
              {net ? short(net) : "open"}
            </text>
          </g>
        );
      })}
    </svg>
  );
});

const Block = memo(function Block({
  id,
  name,
  purpose,
  comps,
  design,
}: {
  id: string;
  name: string;
  purpose: string;
  comps: Component[];
  design: Design;
}) {
  const [table, setTable] = useState(false);
  return (
    <section className="block" aria-labelledby={`blk-${id}`}>
      <div className="block-head">
        <div>
          <h3 id={`blk-${id}`} className="section-title" style={{ marginBottom: 2 }}>
            {name}
          </h3>
          <p className="small secondary">{purpose}</p>
        </div>
        <button className="btn btn-sm" onClick={() => setTable((t) => !t)} aria-expanded={table}>
          {table ? "Hide pin table" : "Pin table"}
        </button>
      </div>
      <div className="schem" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 220px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 4px", padding: 12 }}>
          {comps.map((c) => (
            <Symbol key={c.ref} c={c} value={design.parts[c.part]?.value ?? c.part} nets={design.nets} />
          ))}
        </div>
      </div>
      {table && (
        <div className="table-scroll">
          <table className="table pins">
            <thead>
              <tr>
                <th>Part</th>
                <th>Pin</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {comps.flatMap((c) =>
                Object.entries(c.pins)
                  .sort(([a], [b]) => natural(a, b))
                  .map(([pad, net], i) => (
                    <tr key={c.ref + pad}>
                      <td>{i === 0 ? <strong>{c.ref}</strong> : ""}</td>
                      <td className="num">{pad}</td>
                      <td className={net ? "num" : "muted"}>{net ?? "left open"}</td>
                    </tr>
                  )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});

export default function Circuit({ design }: { design: Design }) {
  const blocks = useMemo(() => {
    const by = new Map<string, Component[]>();
    for (const c of design.components) by.set(c.block, [...(by.get(c.block) ?? []), c]);
    return [...by.entries()].map(([id, comps]) => ({
      id,
      name: design.blocks[id]?.name ?? id,
      purpose: design.blocks[id]?.purpose ?? "",
      comps: comps.sort((a, b) => natural(a.ref, b.ref)),
    }));
  }, [design]);

  const nets = useMemo(() => {
    const n = new Set<string>();
    for (const c of design.components) for (const v of Object.values(c.pins)) if (v) n.add(v);
    return n.size;
  }, [design]);

  if (blocks.length === 0)
    return (
      <div className="pane-inner">
        <div className="empty">
          <h2 className="d4">No circuit yet</h2>
          <p>Once the parts are chosen, HardHub wires every pin from the datasheets and shows the circuit here, block by block.</p>
        </div>
      </div>
    );

  return (
    <div className="pane-inner">
      <div className="stats">
        <div className="stat">
          <span className="n">{blocks.length}</span>
          <span className="m">blocks</span>
        </div>
        <div className="stat">
          <span className="n">{design.components.length}</span>
          <span className="m">parts</span>
        </div>
        <div className="stat">
          <span className="n">{nets}</span>
          <span className="m">nets</span>
        </div>
      </div>
      <p className="small muted">Pins with the same label are connected. Power and ground labels are set in bold.</p>
      {blocks.map((b) => (
        <Block key={b.id} {...b} design={design} />
      ))}
    </div>
  );
}
