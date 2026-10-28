// App-wide state: which backend, whether it can be reached, who is signed in.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me } from "@hardhub/protocol";
import type { Backend } from "./backend";
import { ApiClient } from "./api";

// "/api" when the web app and the API are served from one Worker (Cloudflare);
// a full URL for local development
export const API_URL: string = new URL(import.meta.env.VITE_API_URL || "http://localhost:8787", window.location.href).href.replace(/\/$/, "");
export const MOCK = import.meta.env.VITE_MOCK === "1";

export type Reach = "checking" | "offline" | "online";

interface AppValue {
  backend: Backend;
  reach: Reach;
  me: Me | null;
  /** true once we know whether there is a session */
  ready: boolean;
  setMe(me: Me | null): void;
  recheck(): void;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside <AppProvider>");
  return v;
}

export function AppProvider({ backend, children }: { backend?: Backend; children: ReactNode }) {
  const [b, setB] = useState<Backend | null>(backend ?? null);
  const [reach, setReach] = useState<Reach>("checking");
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (b) return;
    if (MOCK) {
      // demo data lives in its own chunk: a real build never downloads it
      import("./mock").then((m) => setB(new m.MockBackend()));
    } else setB(new ApiClient(API_URL));
  }, [b]);

  useEffect(() => {
    if (!b) return;
    let live = true;
    setReach("checking");
    (async () => {
      const ok = await b.ping();
      if (!live) return;
      setReach(ok ? "online" : "offline");
      if (!ok) return setReady(true);
      if (!b.token()) {
        setMe(null);
        return setReady(true);
      }
      try {
        const m = await b.me();
        if (live) setMe(m);
      } catch {
        if (live) setMe(null);
      } finally {
        if (live) setReady(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [b, tick]);

  const recheck = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo<AppValue | null>(
    () => (b ? { backend: b, reach, me, ready, setMe, recheck } : null),
    [b, reach, me, ready, recheck],
  );
  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
