// The assembled board in 3D. The worker parses the GLB and merges it into a
// few meshes (one per colour and side); this thread only uploads buffers and
// draws. Frames are drawn on demand: nothing renders while nothing moves.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Artifact, Design } from "@hardhub/protocol";
import { loadScene } from "../workers/client";
import type { SceneData } from "../workers/geometry";

declare global {
  interface Window {
    __hh3d?: { frames: number; renderMs: number; meshes: number; triangles: number };
  }
}

export default function Viewer3D({ design, artifacts, fileUrl }: { design: Design; artifacts: Artifact[]; fileUrl(u: string): string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [showTop, setShowTop] = useState(true);
  const [showBottom, setShowBottom] = useState(true);
  const [explode, setExplode] = useState(0);
  const api = useRef<{ setVisible(g: string, v: boolean): void; setExplode(k: number): void; reset(): void } | null>(null);

  const glb = artifacts.find((a) => a.kind === "glb");
  const src = glb && !glb.url.startsWith("mock:") ? { glb: fileUrl(glb.url) } : { design };
  const srcKey = "glb" in src ? src.glb : `demo:${design.name}:${design.components.length}`;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: !coarse, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x100d09, 1);
    renderer.domElement.setAttribute("data-testid", "viewer-3d-canvas");
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    scene.add(new THREE.HemisphereLight(0xf1ece0, 0x1b1813, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
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

    const resize = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      request();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const groups: Record<string, THREE.Mesh[]> = { board: [], top: [], bottom: [] };
    let upVec = new THREE.Vector3(0, 0, 1);
    let thick = 1.6;
    let home: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

    const build = (data: SceneData) => {
      const mats = new Map<string, THREE.MeshStandardMaterial>();
      for (const m of data.meshes) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
        g.setIndex(new THREE.BufferAttribute(m.index, 1));
        g.computeBoundingSphere();
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
        stats.triangles += m.index.length / 3;
      }
      stats.meshes = data.meshes.length;
      upVec = new THREE.Vector3(data.up === 0 ? 1 : 0, data.up === 1 ? 1 : 0, data.up === 2 ? 1 : 0);
      thick = data.thickness || 1.6;
      const center = new THREE.Vector3(...data.center);
      const radius = Math.hypot(...data.size) / 2;
      camera.up.copy(upVec);
      camera.near = radius / 100;
      camera.far = radius * 100;
      // three-quarter view from the front, above the top face
      const dir = new THREE.Vector3(0.0, -1.1, 0.9);
      if (data.up === 1) dir.set(0, 0.9, 1.1);
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95;
      camera.position.copy(center).add(dir.normalize().multiplyScalar(dist));
      controls.target.copy(center);
      camera.updateProjectionMatrix();
      home = { pos: camera.position.clone(), target: center.clone() };
      controls.update();
      request();
    };

    api.current = {
      setVisible(g, v) {
        for (const m of groups[g] ?? []) m.visible = v;
        request();
      },
      setExplode(k) {
        const off = k * thick * 8;
        for (const m of groups.top!) {
          m.position.copy(upVec).multiplyScalar(off);
          m.updateMatrix();
        }
        for (const m of groups.bottom!) {
          m.position.copy(upVec).multiplyScalar(-off);
          m.updateMatrix();
        }
        request();
      },
      reset() {
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
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      api.current = null;
    };
    // src is derived from srcKey
  }, [srcKey]);

  useEffect(() => api.current?.setVisible("top", showTop), [showTop, status]);
  useEffect(() => api.current?.setVisible("bottom", showBottom), [showBottom, status]);
  useEffect(() => api.current?.setExplode(explode), [explode, status]);

  return (
    <div className="viewer" ref={host} data-testid="viewer-3d" data-status={status} style={{ background: "var(--coal)" }}>
      {status !== "ready" && (
        <div className="center-state" style={{ position: "absolute", inset: 0, color: "var(--sand)" }}>
          <div style={{ alignItems: "center", textAlign: "center" }}>
            {status === "loading" ? (
              <>
                <div className="spinner-line" />
                <span className="small">Loading the board in 3D</span>
              </>
            ) : (
              <span className="small">{error}</span>
            )}
          </div>
        </div>
      )}
      <div className="viewer-hint" style={{ color: "var(--dim)" }}>
        {"glb" in src ? "From the routed board" : "Demo model: parts as blocks"} · drag to turn, pinch to zoom
      </div>
      <div className="viewer-tools">
        <div className="layer-panel" role="group" aria-label="Show">
          <label className="chk">
            <input type="checkbox" checked={showTop} onChange={(e) => setShowTop(e.target.checked)} data-testid="toggle-top" />
            Top parts
          </label>
          <label className="chk">
            <input type="checkbox" checked={showBottom} onChange={(e) => setShowBottom(e.target.checked)} data-testid="toggle-bottom" />
            Bottom parts
          </label>
          <label className="range">
            Explode
            <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} data-testid="explode" />
          </label>
        </div>
        <div className="zoom">
          <button onClick={() => api.current?.reset()} style={{ width: 64, fontSize: 12 }}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
