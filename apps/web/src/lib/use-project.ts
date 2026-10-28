// One project's live state: the design (fetched), the event stream (folded by
// project-state.ts). Events are buffered and folded once per animation frame,
// so a fast token stream costs one render per frame, not one per token.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ProjectDetail, ServerEvent } from "@hardhub/protocol";
import { initialState, reduce, type ProjectState } from "./project-state";
import type { Backend, LinkStatus, ProjectLink } from "./backend";

export interface ProjectHandle {
  detail: ProjectDetail | null;
  state: ProjectState;
  link: LinkStatus;
  error: string | null;
  send(msg: ClientMessage): void;
}

export function useProject(backend: Backend, id: string): ProjectHandle {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [state, setState] = useState<ProjectState>(initialState);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const linkRef = useRef<ProjectLink | null>(null);

  useEffect(() => {
    let live = true;
    let buffer: ServerEvent[] = [];
    let frame = 0;
    let refetch: ReturnType<typeof setTimeout> | undefined;
    setDetail(null);
    setState(initialState);
    setError(null);

    const load = () =>
      backend.getProject(id).then(
        (d) => live && setDetail(d),
        (e: Error) => live && setError(e.message),
      );

    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setState((s) => batch.reduce(reduce, s));
      // the design itself is fetched, not streamed: refetch (debounced) when it changes
      if (batch.some((e) => e.type === "design" || e.type === "stage")) {
        clearTimeout(refetch);
        refetch = setTimeout(load, 250);
      }
    };
    const onEvent = (e: ServerEvent) => {
      buffer.push(e);
      if (!frame) frame = requestAnimationFrame(flush);
    };

    load();
    linkRef.current = backend.connect(id, -1, onEvent, (s) => live && setLink(s));
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      clearTimeout(refetch);
      linkRef.current?.close();
      linkRef.current = null;
    };
  }, [backend, id]);

  const send = useCallback((msg: ClientMessage) => linkRef.current?.send(msg), []);
  return { detail, state, link, error, send };
}
