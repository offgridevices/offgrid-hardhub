// The routed board's vector geometry (the engine's board.json), fetched again
// whenever a new one is published or the caller asks.
import { useEffect, useState } from "react";
import { BoardGeometry as BoardGeometrySchema, type Artifact, type BoardGeometry } from "@hardhub/protocol";

export function useGeometry(artifact: Artifact | undefined, fileUrl: (u: string) => string, reload = 0) {
  const [geo, setGeo] = useState<BoardGeometry | null>(null);
  // which file the geometry came from: a saved edit waits for a new one
  const [from, setFrom] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!artifact || artifact.url.startsWith("mock:")) return;
    let live = true;
    fetch(fileUrl(artifact.url), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!live) return;
        setGeo(BoardGeometrySchema.parse(j));
        setFrom(artifact.url);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [artifact, fileUrl, reload]);
  return { geo, from, failed };
}

