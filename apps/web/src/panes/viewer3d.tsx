// The assembled board in 3D, three ways: assembled; with the parts lifted off;
// and with every layer pulled apart, one plate per copper layer, the
// silkscreen outside the top and bottom copper, and the parts above and
// below. The worker parses the GLB and merges it into a few meshes (one per
// colour and side); this thread only uploads buffers and draws. Frames are
// drawn on demand: nothing renders while nothing moves.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Artifact, Design } from "@hardhub/protocol";
import { RotateCcwIcon } from "lucide-react";
import { loadScene } from "../workers/client";
import type { SceneData } from "../workers/geometry";
import { useGeometry } from "../lib/use-geometry";
import { copperCanvas, layerColor, plotCanvas } from "../lib/layer-canvas";
import { layerName } from "./board2d";
import { ViewBar } from "../components/viewer-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    __hh3d?: { frames: number; renderMs: number; meshes: number; triangles: number };
  }
}

type Mode = "assembled" | "parts" | "layers";
interface Plate {
  layer: string;
  canvas: HTMLCanvasElement;
  /** a copper plate sits on a slab of board material */
  copper: boolean;
}
interface Api {
  setVisible(g: string, v: boolean): void;
  setMode(m: Mode, spread: number, layersOn: Set<string>): void;
  setPlates(p: Plate[], board: { w: number; h: number }): void;
  reset(): void;
}

const SILK = ["F.Silkscreen", "B.Silkscreen"];

export default function Viewer3D({ design, artifacts, fileUrl }: { design: Design; artifacts: Artifact[]; fileUrl(u: string): string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [showTop, setShowTop] = useState(true);
  const [showBottom, setShowBottom] = useState(true);
  const [mode, setMode] = useState<Mode>("assembled");
  const [spread, setSpread] = useState(0.6);
  const [plates, setPlates] = useState<Plate[] | null>(null);
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const api = useRef<Api | null>(null);

  const glb = artifacts.find((a) => a.kind === "glb");
  const src = glb && !glb.url.startsWith("mock:") ? { glb: fileUrl(glb.url) } : { design };
  const srcKey = "glb" in src ? src.glb : `demo:${design.name}:${design.components.length}`;
  const { geo } = useGeometry(
    artifacts.find((a) => a.kind === "board-json"),
    fileUrl,
  );
  const silk = useMemo(() => artifacts.filter((a) => a.kind === "board-svg" && SILK.includes(a.layers?.[0] ?? "") && !a.url.startsWith("mock:")), [artifacts]);

  // the plates are drawn once, the first time the layers are pulled apart
  useEffect(() => {
    if (mode !== "layers" || plates || !geo) return;
    let live = true;
    (async () => {
      const copper = geo.layers.map((l) => ({ layer: l, canvas: copperCanvas(geo, l), copper: true }));
      const prints = await Promise.all(
        silk.map(async (a) => ({ layer: a.layers![0]!, canvas: await plotCanvas(fileUrl(a.url), geo.size[0], geo.size[1]).catch(() => null), copper: false })),
      );
      const order = [
        ...prints.filter((p) => p.layer === "F.Silkscreen"),
        ...copper,
        ...prints.filter((p) => p.layer === "B.Silkscreen"),
      ].filter((p): p is Plate => !!p.canvas);
      if (live) setPlates(order);
    })();
    return () => {
      live = false;
    };
  }, [mode, plates, geo, silk, fileUrl]);
  // a new board brings new plates
  useEffect(() => setPlates(null), [geo]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: !coarse, powerPreference: "high-performance" });
    // sharp when still, cheaper while a finger is turning the board
    const dpr = Math.min(devicePixelRatio, coarse ? 1.5 : 2);
    const movingDpr = coarse ? Math.min(dpr, 1) : dpr;
    renderer.setPixelRatio(dpr);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("data-testid", "viewer-3d-canvas");
    renderer.domElement.className = "absolute inset-0 size-full";
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    scene.add(new THREE.HemisphereLight(0xf1ece0, 0x1b1813, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(1, 2, 3);
    scene.add(sun);

    const stats = (window.__hh3d = { frames: 0, renderMs: 0, meshes: 0, triangles: 0 });
    let frame = 0;
    const draw = () => {
      frame = 0;
      const moving = controls.update();
      const t = performance.now();
      renderer.render(scene, camera);
      stats.frames++;
      stats.renderMs += performance.now() - t;
      if (moving) request(); // damping still settling
    };
    const request = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    controls.addEventListener("change", request);

    let touched = false;
    controls.addEventListener("start", () => {
      touched = true;
      if (movingDpr !== dpr) renderer.setPixelRatio(movingDpr);
    });
    controls.addEventListener("end", () => {
      if (movingDpr !== dpr) {
        renderer.setPixelRatio(dpr);
        request();
      }
    });
    let fitTo: (() => void) | null = null;
    const resize = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      if (!touched) fitTo?.();
      request();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const groups: Record<string, THREE.Mesh[]> = { board: [], top: [], bottom: [] };
    let upVec = new THREE.Vector3(0, 0, 1);
    let upAxis: 0 | 1 | 2 = 2;
    let thick = 1.6;
    let home: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    // the board body's own box: where the layer plates go
    const body = new THREE.Box3();
    let unit = 1; // scene units per mm
    const plateGroup = new THREE.Group();
    plateGroup.visible = false;
    scene.add(plateGroup);
    let plateMeshes: { layer: string; meshes: THREE.Object3D[] }[] = [];
    let state: { mode: Mode; spread: number; on: Set<string> } = { mode: "assembled", spread: 0.6, on: new Set() };

    const build = (data: SceneData) => {
      const mats = new Map<string, THREE.MeshStandardMaterial>();
      for (const m of data.meshes) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
        // phones draw the lighter index the worker made, where there is one
        const index = coarse && m.lod ? m.lod : m.index;
        g.setIndex(new THREE.BufferAttribute(index, 1));
        g.computeBoundingSphere();
        if (m.group === "board") {
          g.computeBoundingBox();
          body.union(g.boundingBox!);
        }
        const ck = m.color.join(",");
        let mat = mats.get(ck);
        if (!mat) {
          mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(m.color[0], m.color[1], m.color[2]),
            roughness: m.group === "board" ? 0.55 : 0.4,
            metalness: m.color[0] > 0.6 && Math.abs(m.color[0] - m.color[2]) < 0.1 ? 0.6 : 0.05,
          });
          mats.set(ck, mat);
        }
        const mesh = new THREE.Mesh(g, mat);
        mesh.matrixAutoUpdate = false; // static: matrices change only on explode
        mesh.userData.group = m.group;
        groups[m.group]!.push(mesh);
        scene.add(mesh);
        stats.triangles += index.length / 3;
      }
      stats.meshes = data.meshes.length;
      upAxis = data.up;
      upVec = new THREE.Vector3(data.up === 0 ? 1 : 0, data.up === 1 ? 1 : 0, data.up === 2 ? 1 : 0);
      thick = data.thickness || 1.6;
      if (body.isEmpty()) body.setFromCenterAndSize(new THREE.Vector3(...data.center), new THREE.Vector3(...data.size));
      const center = new THREE.Vector3(...data.center);
      const radius = Math.hypot(...data.size) / 2;
      camera.up.copy(upVec);
      camera.near = radius / 100;
      camera.far = radius * 100;
      // three-quarter view from the front, above the top face, far enough
      // that the whole board fits across the narrower of the two directions
      const dir = new THREE.Vector3(0.0, -1.1, 0.9);
      if (data.up === 1) dir.set(0, 0.9, 1.1);
      dir.normalize();
      fitTo = () => {
        const v = THREE.MathUtils.degToRad(camera.fov / 2);
        const h = Math.atan(Math.tan(v) * camera.aspect);
        // pulled apart, the stack is taller: stand further back
        const tall = state.mode === "layers" ? 1 + state.spread * 0.9 : state.mode === "parts" ? 1 + state.spread * 0.3 : 1;
        const dist = ((radius * tall) / Math.sin(Math.min(v, h))) * 1.02;
        camera.position.copy(center).addScaledVector(dir, dist);
        controls.target.copy(center);
        home = { pos: camera.position.clone(), target: center.clone() };
        controls.update();
      };
      fitTo();
      request();
    };

    const place = () => {
      const { mode: m, spread: k, on } = state;
      const step = thick * 10 * k; // between plates when pulled apart
      const n = plateMeshes.length;
      // the plates' centre stays at the board's middle
      const at = (i: number) => (n - 1) / 2 * step - i * step;
      for (const g of groups.board!) g.visible = m !== "layers";
      plateGroup.visible = m === "layers";
      plateMeshes.forEach((p, i) => {
        for (const o of p.meshes) {
          o.visible = on.has(p.layer);
          o.position.copy(upVec).multiplyScalar(at(i) + (o.userData.offset as number));
        }
      });
      const lift = m === "assembled" ? 0 : m === "parts" ? k * thick * 8 : at(0) + step + thick * 2;
      for (const mesh of groups.top!) {
        mesh.position.copy(upVec).multiplyScalar(lift);
        mesh.updateMatrix();
      }
      for (const mesh of groups.bottom!) {
        mesh.position.copy(upVec).multiplyScalar(m === "layers" ? -lift : -lift);
        mesh.updateMatrix();
      }
      request();
    };

    api.current = {
      setVisible(g, v) {
        for (const m of groups[g] ?? []) m.visible = v;
        request();
      },
      setMode(m, k, on) {
        const was = state.mode;
        state = { mode: m, spread: k, on };
        place();
        if (was !== m && !touched) fitTo?.();
      },
      setPlates(list, board) {
        for (const p of plateMeshes) for (const o of p.meshes) plateGroup.remove(o);
        const size = body.getSize(new THREE.Vector3());
        const mid = body.getCenter(new THREE.Vector3());
        const across = [0, 1, 2].filter((a) => a !== upAxis) as [number, number];
        unit = size.getComponent(across[0]) / board.w || 1;
        const w = board.w * unit;
        const h = board.h * unit;
        const slab = new THREE.MeshStandardMaterial({ color: 0x1f3326, transparent: true, opacity: 0.55, roughness: 0.8, depthWrite: false, side: THREE.DoubleSide });
        plateMeshes = list.map((p) => {
          const tex = new THREE.CanvasTexture(p.canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
          const meshes: THREE.Object3D[] = [face];
          face.userData.offset = 0;
          if (p.copper) {
            const base = new THREE.Mesh(new THREE.PlaneGeometry(w, h), slab);
            base.userData.offset = -thick * 0.05;
            base.renderOrder = -1;
            meshes.push(base);
          }
          for (const o of meshes) {
            // planes face +z; turn them to face up, and centre them on the board
            if (upAxis === 1) o.rotation.x = -Math.PI / 2;
            else if (upAxis === 0) o.rotation.y = Math.PI / 2;
            o.userData.offset = (o.userData.offset as number) * unit + 0;
            plateGroup.add(o);
          }
          plateGroup.position.copy(mid);
          return { layer: p.layer, meshes };
        });
        place();
      },
      reset() {
        touched = false;
        if (fitTo) fitTo();
        if (!home) return;
        camera.position.copy(home.pos);
        controls.target.copy(home.target);
        controls.update();
        request();
      },
    };

    setStatus("loading");
    loadScene(src)
      .then((data) => {
        if (disposed) return;
        build(data);
        resize();
        setStatus("ready");
      })
      .catch((e: Error) => {
        if (disposed) return;
        setError(e.message);
        setStatus("error");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => {
            (x as THREE.MeshBasicMaterial).map?.dispose();
            x.dispose();
          });
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      api.current = null;
    };
    // src is derived from srcKey
  }, [srcKey]);

  const layerList = plates?.map((p) => p.layer) ?? [];
  const on = useMemo(() => new Set(layerList.filter((l) => !off.has(l))), [layerList.join(), off]);
  useEffect(() => api.current?.setVisible("top", showTop), [showTop, status]);
  useEffect(() => api.current?.setVisible("bottom", showBottom), [showBottom, status]);
  useEffect(() => {
    if (status === "ready" && plates && geo) api.current?.setPlates(plates, { w: geo.size[0], h: geo.size[1] });
  }, [plates, status, geo]);
  useEffect(() => api.current?.setMode(mode === "layers" && !plates ? "parts" : mode, spread, on), [mode, spread, on, status, plates]);

  const canLayers = !!geo;
  const copperCount = geo?.layers.length ?? design.board?.layers ?? 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ViewBar>
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as Mode)} aria-label="Arrangement" className="h-8">
          <ToggleGroupItem value="assembled">Assembled</ToggleGroupItem>
          <ToggleGroupItem value="parts" data-testid="explode">
            Parts lifted
          </ToggleGroupItem>
          <ToggleGroupItem value="layers" disabled={!canLayers} title={canLayers ? undefined : "Every layer appears with the next board build"} data-testid="explode-layers">
            Every layer
          </ToggleGroupItem>
        </ToggleGroup>
        {mode !== "assembled" && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Spread
            <Slider className="w-32" min={0.1} max={1} step={0.01} value={[spread]} onValueChange={([v]) => setSpread(v!)} aria-label="How far apart" />
          </label>
        )}
        <span className="grow" />
        {copperCount > 0 && <Badge>{copperCount} copper layers</Badge>}
        <Button variant="ghost" size="sm" onClick={() => api.current?.reset()}>
          <RotateCcwIcon />
          Reset view
        </Button>
      </ViewBar>
      <div className="flex min-h-0 flex-1 flex-wrap">
        <div
          ref={host}
          data-testid="viewer-3d"
          data-status={status}
          className="relative min-h-[380px] min-w-0 flex-[999_1_420px] touch-none bg-[radial-gradient(ellipse_at_50%_40%,#2a241d_0%,var(--board-bg)_70%)]"
        >
          {status !== "ready" && (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              {status === "loading" ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader />
                  Loading the board in 3D
                </div>
              ) : (
                <span className="max-w-sm px-6 text-center">{error}</span>
              )}
            </div>
          )}
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-card/70 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
            {"glb" in src ? "From the routed board" : "Demo model: parts as blocks"} · drag to turn, pinch or scroll to zoom
          </span>
          {mode === "layers" && !plates && canLayers && (
            <div className="absolute inset-x-0 bottom-4 flex justify-center">
              <Badge tone="ember">Drawing each layer…</Badge>
            </div>
          )}
        </div>
        <aside className="flex min-w-0 flex-[1_1_240px] flex-col gap-1 border-l p-3 max-[699px]:border-l-0 max-[699px]:border-t lg:max-w-72" aria-label="What to show">
          <span className="px-2 pb-1 text-xs font-medium text-muted-foreground">{mode === "layers" ? "Layers, top to bottom" : "Parts"}</span>
          <ToggleRow label="Top parts" color="#9aa0a6" checked={showTop} onChange={setShowTop} testId="toggle-top" />
          {mode === "layers" &&
            layerList.map((l) => (
              <ToggleRow
                key={l}
                label={layerName(l)}
                color={l.endsWith(".Cu") ? layerColor(l) : "#f1ece0"}
                checked={!off.has(l)}
                onChange={(v) =>
                  setOff((o) => {
                    const n = new Set(o);
                    if (v) n.delete(l);
                    else n.add(l);
                    return n;
                  })
                }
                onSolo={() => setOff(new Set(layerList.filter((x) => x !== l)))}
              />
            ))}
          <ToggleRow label="Bottom parts" color="#6f757a" checked={showBottom} onChange={setShowBottom} testId="toggle-bottom" />
          {mode === "layers" && (
            <p className="mt-2 rounded-lg bg-sunken p-3 text-xs text-soft">
              Silkscreen sits on the outside: above the top copper and below the bottom copper. Click a layer's name to see it alone; switch them all back on with Assembled.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  color,
  checked,
  onChange,
  onSolo,
  testId,
}: {
  label: string;
  color: string;
  checked: boolean;
  onChange(v: boolean): void;
  onSolo?: () => void;
  testId?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm", !checked && "text-muted-foreground")}>
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color, opacity: checked ? 1 : 0.4 }} />
      {onSolo ? (
        <button type="button" className="flex-1 text-left hover:text-foreground" onClick={onSolo} title="Show this layer alone">
          {label}
        </button>
      ) : (
        <span className="flex-1">{label}</span>
      )}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  );
}
