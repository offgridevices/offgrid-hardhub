// One shared board worker, started on first use, with promise-based calls.
import type { Design } from "@hardhub/protocol";
import type { SceneData } from "./geometry";
import type { WorkerRequest, WorkerResponse } from "./board.worker";

type Bare<T> = T extends unknown ? Omit<T, "id"> : never;

let worker: Worker | null = null;
let next = 1;
const pending = new Map<number, { resolve(v: WorkerResponse): void; reject(e: Error): void }>();

function get(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./board.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data);
    else p.reject(new Error(ev.data.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "Board worker failed"));
    pending.clear();
  };
  return worker;
}

function call(req: Bare<WorkerRequest>): Promise<WorkerResponse> {
  const id = next++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    get().postMessage({ ...req, id });
  });
}

export async function demoLayerSvgs(design: Design): Promise<Record<string, string>> {
  const r = await call({ op: "layers", design });
  return "layers" in r ? r.layers : {};
}

export async function loadScene(src: { glb: string } | { design: Design }): Promise<SceneData> {
  const r = await call("glb" in src ? { op: "glb", url: src.glb } : { op: "demo3d", design: src.design });
  if (!("scene" in r)) throw new Error("No scene");
  return r.scene;
}
