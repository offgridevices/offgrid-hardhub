// Everything needed to order: the files, the settings to pick at the fab,
// and where to upload them.
import { useState } from "react";
import type { Artifact, Design } from "@hardhub/protocol";
import { bytes } from "../lib/format";

const WHAT: Partial<Record<Artifact["kind"], string>> = {
  gerbers: "Gerber and drill files: upload this zip to the fab",
  bom: "Bill of materials in JLCPCB's format",
  cpl: "Where each part sits (placement file)",
  netlist: "Netlist, for the fab's electrical test",
  step: "3D model for your enclosure CAD",
  firmware: "Starter firmware",
  report: "Check report",
};

const MASK: Record<string, string> = { black: "Black", green: "Green", white: "White", blue: "Blue", red: "Red", purple: "Purple", yellow: "Yellow" };
const FINISH: Record<string, string> = { hasl: "HASL", "lead-free-hasl": "Lead-free HASL", enig: "ENIG (gold)" };

export default function Order({ design, artifacts, fileUrl }: { design: Design; artifacts: Artifact[]; fileUrl(u: string): string }) {
  const files = artifacts.filter((a) => a.kind in WHAT);
  const b = design.board;
  const [shown, setShown] = useState<string | null>(null);
  const fw = Object.entries(design.firmware.files);

  return (
    <div className="pane-inner">
      <div className="pane-head">
        <h2 className="d4">Order the board</h2>
        <p className="secondary">
          JLCPCB and PCBWay both build and assemble from these files. HardHub fills in nothing for you at the fab: you upload, check
          the preview, and pay there.
        </p>
      </div>

      <section>
        <h3 className="section-title">Files</h3>
        {files.length === 0 ? (
          <p className="small muted">The files appear once the board is routed and every check has run.</p>
        ) : (
          <div style={{ borderTop: "1px solid var(--hairline-strong)" }}>
            {files.map((f) => (
              <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--hairline)", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div className="num" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                    {f.name}
                  </div>
                  <div className="small muted">
                    {WHAT[f.kind]}
                    {f.bytes ? ` · ${bytes(f.bytes)}` : ""}
                  </div>
                </div>
                <a className="btn btn-sm" href={f.url.startsWith("mock:") ? undefined : fileUrl(f.url)} download aria-disabled={f.url.startsWith("mock:")} data-testid={`download-${f.kind}`}>
                  Download
                </a>
              </div>
            ))}
          </div>
        )}
      </section>

      {b && (
        <section>
          <h3 className="section-title">Settings to pick at the fab</h3>
          <div className="table-scroll">
            <table className="table">
              <tbody>
                {[
                  ["Layers", String(b.layers)],
                  ["Size", `${b.width} × ${b.height} mm`],
                  ["Thickness", `${b.thickness} mm`],
                  ["Solder mask", MASK[b.mask_color] ?? b.mask_color],
                  ["Silkscreen", b.mask_color === "white" ? "Black" : "White"],
                  ["Surface finish", FINISH[b.finish] ?? b.finish],
                  ["Copper", `${b.copper_oz.outer} oz outer${b.layers > 2 ? `, ${b.copper_oz.inner} oz inner` : ""}`],
                  ["Assembly", "Top side, using the BOM and placement files above"],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <th style={{ width: "40%", fontWeight: 500, color: "var(--fg-3)", borderBottom: "1px solid var(--hairline)", padding: "12px 16px 12px 0" }}>{k}</th>
                    <td className={/\d/.test(v!) ? "num" : undefined}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <a className="btn" href="https://cart.jlcpcb.com/quote" target="_blank" rel="noreferrer">
              Open JLCPCB ↗
            </a>
            <a className="btn" href="https://www.pcbway.com/orderonline.aspx" target="_blank" rel="noreferrer">
              Open PCBWay ↗
            </a>
          </div>
        </section>
      )}

      {fw.length > 0 && (
        <section>
          <h3 className="section-title">Firmware</h3>
          <p className="small secondary" style={{ marginBottom: 12 }}>
            {design.firmware.platform === "esphome"
              ? "ESPHome configuration: flash it once over USB and the board appears in Home Assistant."
              : "Starter firmware for the board's microcontroller."}{" "}
            The pin map is checked against the circuit.
          </p>
          {fw.map(([path, text]) => (
            <div key={path} style={{ marginBottom: 12 }}>
              <button className="btn btn-sm" onClick={() => setShown(shown === path ? null : path)} aria-expanded={shown === path}>
                <span className="num">{path}</span>
              </button>
              {shown === path && (
                <pre className="code" style={{ marginTop: 8 }}>
                  {text}
                </pre>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
