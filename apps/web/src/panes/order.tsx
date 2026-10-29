// Ordering, made to be one download: the board's zip for the fab's quote
// page, then (only if the fab is to solder the parts) the parts list and the
// placement file, which both fabs take in their own upload boxes. Everything
// else (the whole package, 3D model, netlist, firmware) is a click away.
import { useState } from "react";
import type { Artifact, Design } from "@hardhub/protocol";
import { CheckIcon, CircleCheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, FileArchiveIcon } from "lucide-react";
import { bytes } from "../lib/format";
import { Empty, Pane, PaneHead, Section } from "../components/pane";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

type Fab = "jlcpcb" | "pcbway";
const FABS: Record<Fab, { name: string; quote: string }> = {
  jlcpcb: { name: "JLCPCB", quote: "https://cart.jlcpcb.com/quote" },
  pcbway: { name: "PCBWay", quote: "https://www.pcbway.com/orderonline.aspx" },
};
const MASK: Record<string, string> = { black: "Black", green: "Green", white: "White", blue: "Blue", red: "Red", purple: "Purple", yellow: "Yellow" };
const FINISH: Record<string, string> = { hasl: "HASL", "lead-free-hasl": "Lead-free HASL", enig: "ENIG (gold)" };
const MASK_HEX: Record<string, string> = { black: "#0d0d0d", green: "#1f6b3a", white: "#f4f4f0", blue: "#1f4f9c", red: "#a3241f", purple: "#5b2a86", yellow: "#d9b21f" };

// the other files, in plain words
const EXTRA: Partial<Record<Artifact["kind"], string>> = {
  package: "Everything in one zip, with a README",
  step: "3D model for your enclosure CAD",
  netlist: "Netlist, for the fab's electrical test",
  kicad: "KiCad project, to open and edit yourself",
  report: "Check report",
};

const forFab = (a: Artifact, fab: Fab) => (fab === "pcbway" ? /pcbway/i.test(a.name) || a.kind === "cpl" : !/pcbway/i.test(a.name));

export default function Order({ design, artifacts, fileUrl }: { design: Design; artifacts: Artifact[]; fileUrl(u: string): string }) {
  const b = design.board;
  const [fab, setFab] = useState<Fab>(b?.fab ?? "jlcpcb");
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fw = Object.entries(design.firmware.files);

  const gerbers = artifacts.find((a) => a.kind === "gerbers");
  // the same kinds come per fab: JLCPCB's first, as the fabs' own names say
  const bom = artifacts.filter((a) => a.kind === "bom").sort((a, c) => Number(forFab(c, fab)) - Number(forFab(a, fab)))[0];
  const cpl = artifacts.filter((a) => a.kind === "cpl")[0];
  const extras = artifacts.filter((a) => a.kind in EXTRA && !(a.kind === "netlist" && !/\.ipc$/i.test(a.name)));
  const fitted = design.components.filter((c) => design.parts[c.part]?.assembled !== false);
  const assembled = fitted.length;
  const bottom = fitted.some((c) => design.placement[c.ref]?.side === "bottom");
  const top = fitted.some((c) => design.placement[c.ref]?.side !== "bottom");
  const sides = top && bottom ? "Both sides" : bottom ? "Bottom side" : "Top side";
  const href = (a: Artifact) => (a.url.startsWith("mock:") ? undefined : fileUrl(a.url));

  const settings: [string, string][] = b
    ? [
        ["Layers", String(b.layers)],
        ["Size", `${b.width} × ${b.height} mm`],
        ["Thickness", `${b.thickness} mm`],
        ["Solder mask", MASK[b.mask_color] ?? b.mask_color],
        ["Silkscreen", b.mask_color === "white" ? "Black" : "White"],
        ["Surface finish", FINISH[b.finish] ?? b.finish],
        ["Copper", `${b.copper_oz.outer} oz outer${b.layers > 2 ? `, ${b.copper_oz.inner} oz inner` : ""}`],
        ["Assembly", `${sides} · ${assembled} parts`],
      ]
    : [];
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(settings.map(([k, v]) => `${k}: ${v}`).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard: the settings are on screen */
    }
  };

  if (!gerbers)
    return <Empty title="Nothing to order yet">The files appear here once the board is routed and every check has run: one zip for the board, and the two files the fab needs to solder the parts.</Empty>;

  return (
    <Pane>
      <PaneHead title="Order your board">One zip has the whole board. Upload it, check the fab's preview, and pay there. HardHub fills in nothing at the fab for you.</PaneHead>

      <ToggleGroup type="single" value={fab} onValueChange={(v) => v && setFab(v as Fab)} aria-label="Factory" className="h-10">
        {(Object.keys(FABS) as Fab[]).map((f) => (
          <ToggleGroupItem key={f} value={f} className="px-5" data-testid={`fab-${f}`}>
            {FABS[f].name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_28rem] flex-col gap-4">
          <section className="flex flex-col gap-5 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-ember/15 text-ember-text">
                <FileArchiveIcon className="size-6" />
              </span>
              <div className="flex min-w-0 flex-[1_1_12rem] flex-col">
                <span className="text-xs font-medium text-ember-text">Step 1 · the board</span>
                <span className="num truncate font-medium">{gerbers.name}</span>
                <span className="text-xs text-muted-foreground">
                  Gerbers and drill files{gerbers.bytes ? ` · ${bytes(gerbers.bytes)}` : ""}
                </span>
              </div>
              <Button size="lg" asChild>
                <a href={href(gerbers)} download aria-disabled={!href(gerbers)} data-testid="download-gerbers">
                  <DownloadIcon />
                  Download zip
                </a>
              </Button>
            </div>
            <ol className="grid gap-2 sm:grid-cols-2">
              <li className="flex flex-col gap-1 rounded-lg bg-sunken p-3 text-sm">
                <span className="font-medium">Upload it, still zipped</span>
                <a className="inline-flex items-center gap-1 text-ember-text underline-offset-4 hover:underline" href={FABS[fab].quote} target="_blank" rel="noreferrer">
                  {FABS[fab].name}'s quote page
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              </li>
              <li className="flex flex-col gap-1 rounded-lg bg-sunken p-3 text-sm">
                <span className="font-medium">Match the settings</span>
                <span className="text-muted-foreground">They're listed here. Check the preview, then pay.</span>
              </li>
            </ol>
          </section>

          {(bom || cpl) && (
            <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-sky-text">Step 2 · only if {FABS[fab].name} solders the parts</span>
                <span className="text-sm text-soft">
                  Turn on assembly in the order. {FABS[fab].name} asks for these two files in their own boxes, so they can't go in the board's zip.
                </span>
              </div>
              <div className="flex flex-col divide-y rounded-lg border">
                {[
                  bom && { a: bom, kind: "bom", label: "Parts list (BOM)", hint: "the BOM box" },
                  cpl && { a: cpl, kind: "cpl", label: "Where each part sits (placement)", hint: fab === "jlcpcb" ? "the CPL box" : "the centroid box" },
                ]
                  .filter((x): x is { a: Artifact; kind: string; label: string; hint: string } => !!x)
                  .map(({ a, kind, label, hint }) => (
                    <div key={kind} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
                      <div className="flex min-w-0 flex-[1_1_12rem] flex-col">
                        <span className="text-sm font-medium">{label}</span>
                        <span className="text-xs text-muted-foreground">
                          Goes in {hint}
                          {a.bytes ? ` · ${bytes(a.bytes)}` : ""}
                        </span>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <a href={href(a)} download aria-disabled={!href(a)} data-testid={`download-${kind}`}>
                          <DownloadIcon />
                          Download
                        </a>
                      </Button>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {extras.length > 0 && (
            <Section title="Also handy">
              <div className="flex flex-wrap gap-2">
                {extras.map((a) => (
                  <Button key={a.name} variant="outline" size="sm" asChild>
                    <a href={href(a)} download aria-disabled={!href(a)} title={a.name} data-testid={`download-${a.kind}`}>
                      <DownloadIcon />
                      {EXTRA[a.kind]}
                    </a>
                  </Button>
                ))}
              </div>
            </Section>
          )}
        </div>

        {b && (
          <aside className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1 rounded-xl border bg-card p-5" aria-label={`Settings to pick at ${FABS[fab].name}`}>
            <div className="flex items-center gap-2 pb-2">
              <span className="text-sm font-semibold">Pick these at {FABS[fab].name}</span>
              <span className="grow" />
              <Button variant="ghost" size="xs" onClick={copyAll}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy all"}
              </Button>
            </div>
            <dl className="flex flex-col">
              {settings.map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 border-b py-2.5 text-sm last:border-0">
                  <dt className="flex-1 text-muted-foreground">{k}</dt>
                  <dd className={cn("text-right", /\d/.test(v) && "num")}>
                    {k === "Solder mask" && (
                      <span className="mr-2 inline-block size-3 rounded-[3px] border border-input align-[-1px]" style={{ background: MASK_HEX[b.mask_color] }} aria-hidden="true" />
                    )}
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-moss/10 px-3 py-2.5 text-sm text-moss-text">
              <CircleCheckIcon className="size-4 shrink-0" />
              Every check ran on these files.
            </div>
          </aside>
        )}
      </div>

      {fw.length > 0 && (
        <Section title="Firmware">
          <p className="text-sm text-soft">
            {design.firmware.platform === "esphome"
              ? "ESPHome configuration: flash it once over USB and the board appears in Home Assistant."
              : "Starter firmware for the board's microcontroller."}{" "}
            The pin map is checked against the circuit.
          </p>
          <div className="flex flex-col gap-2">
            {fw.map(([path, text]) => (
              <div key={path} className="overflow-hidden rounded-xl border">
                <button
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent"
                  onClick={() => setShown(shown === path ? null : path)}
                  aria-expanded={shown === path}
                >
                  <span className="num flex-1">{path}</span>
                  <Badge>{shown === path ? "Hide" : "Show"}</Badge>
                </button>
                {shown === path && <pre className="max-h-96 overflow-auto border-t bg-sunken p-4 font-mono text-xs leading-relaxed">{text}</pre>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </Pane>
  );
}
