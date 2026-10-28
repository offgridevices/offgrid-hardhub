// Heavy board work off the main thread: parsing a KiCad GLB and merging its
// thousands of meshes into a few (one per colour and side), and drawing the
// demo layers. Results come back as transferable buffers.
/// <reference lib="webworker" />
import type { Design } from "@hardhub/protocol";
import type { MeshoptSimplifier as Simplifier } from "meshoptimizer/simplifier";
import { demoLayers, demoScene, type MeshData, type SceneData } from "./geometry";

export type WorkerRequest =
  | { id: number; op: "layers"; design: Design }
  | { id: number; op: "demo3d"; design: Design }
  | { id: number; op: "glb"; url: string };

export type WorkerResponse =
  | { id: number; ok: true; layers: Record<string, string> }
  | { id: number; ok: true; scene: SceneData }
  | { id: number; ok: false; error: string };

declare const self: DedicatedWorkerGlobalScope;

function transferables(scene: SceneData): ArrayBuffer[] {
  return scene.meshes.flatMap((m) => [m.positions.buffer, m.normals.buffer, m.index.buffer, ...(m.lod ? [m.lod.buffer] : [])] as ArrayBuffer[]);
}

// A lighter index buffer for phones: the same vertices, about a quarter of the
// triangles, with the surface moved by at most 0.2 % of the mesh's size (a
// few hundredths of a millimetre on a small board). Small meshes keep theirs.
function lowDetail(MeshoptSimplifier: typeof Simplifier, index: Uint32Array, positions: Float32Array): Uint32Array | undefined {
  if (index.length < 30_000 || !MeshoptSimplifier.supported) return undefined;
  const [lod] = MeshoptSimplifier.simplify(index, positions, 3, Math.floor(index.length / 4 / 3) * 3, 0.002, ["Prune"]);
  return lod.length < index.length * 0.8 ? lod : undefined;
}

async function parseGlb(url: string): Promise<SceneData> {
  const [{ GLTFLoader }, { MeshoptDecoder }, THREE, { mergeGeometries }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
    import("three"),
    import("three/examples/jsm/utils/BufferGeometryUtils.js"),
  ]);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the 3D model (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(buf, "");
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // the board is flat: its thinnest axis points out of the top face
  const dims = [size.x, size.y, size.z];
  const up = dims.indexOf(Math.min(...dims)) as 0 | 1 | 2;

  // the board body is the mesh with the largest footprint; its faces split parts into top and bottom
  type Item = { geo: InstanceType<typeof THREE.BufferGeometry>; color: [number, number, number]; c: number; area: number };
  const items: Item[] = [];
  root.traverse((o) => {
    const mesh = o as InstanceType<typeof THREE.Mesh>;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat = mats[0] as InstanceType<typeof THREE.MeshStandardMaterial> | undefined;
    const col = mat?.color ? ([mat.color.r, mat.color.g, mat.color.b] as [number, number, number]) : ([0.5, 0.5, 0.5] as [number, number, number]);
    let g = mesh.geometry.clone() as InstanceType<typeof THREE.BufferGeometry>;
    g.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    if (!g.index) {
      const n = g.getAttribute("position").count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const s = bb.getSize(new THREE.Vector3());
    const c = bb.getCenter(new THREE.Vector3());
    const ext = [s.x, s.y, s.z];
    ext.splice(up, 1);
    items.push({ geo: g, color: col, c: [c.x, c.y, c.z][up]!, area: ext[0]! * ext[1]! });
  });
  if (!items.length) throw new Error("The 3D model has no meshes");
  const body = items.reduce((a, b) => (b.area > a.area ? b : a));
  const mid = body.c;

  const groups = new Map<string, { group: MeshData["group"]; color: [number, number, number]; geos: Item["geo"][] }>();
  for (const it of items) {
    const group: MeshData["group"] = it.area >= body.area * 0.9 ? "board" : it.c >= mid ? "top" : "bottom";
    const key = `${group}:${it.color.map((v) => v.toFixed(2)).join(",")}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { group, color: it.color, geos: [] }));
    g.geos.push(it.geo);
  }
  const meshes: MeshData[] = [];
  const { MeshoptSimplifier } = await import("meshoptimizer/simplifier");
  await MeshoptSimplifier.ready;
  for (const [key, g] of groups) {
    const merged = g.geos.length === 1 ? g.geos[0]! : mergeGeometries(g.geos as Parameters<typeof mergeGeometries>[0], false);
    if (!merged) continue;
    const idx = merged.index!.array;
    const index = idx instanceof Uint32Array ? idx : new Uint32Array(idx);
    const positions = new Float32Array((merged.getAttribute("position") as InstanceType<typeof THREE.BufferAttribute>).array);
    meshes.push({
      key,
      group: g.group,
      color: g.color,
      positions,
      normals: new Float32Array((merged.getAttribute("normal") as InstanceType<typeof THREE.BufferAttribute>).array),
      index,
      lod: lowDetail(MeshoptSimplifier, index, positions),
    });
  }
  const thickness = (() => {
    body.geo.computeBoundingBox();
    const s = body.geo.boundingBox!.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z][up]!;
  })();
  return { meshes, up, thickness, size: [size.x, size.y, size.z], center: [center.x, center.y, center.z] };
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.op === "layers") {
      self.postMessage({ id: req.id, ok: true, layers: demoLayers(req.design) } satisfies WorkerResponse);
    } else {
      const scene = req.op === "demo3d" ? demoScene(req.design) : await parseGlb(req.url);
      self.postMessage({ id: req.id, ok: true, scene } satisfies WorkerResponse, transferables(scene));
    }
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies WorkerResponse);
  }
};
