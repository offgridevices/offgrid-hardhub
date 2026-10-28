// One project: the conversation on one side, the board on the other. On a
// phone they are two panes switched at the bottom of the screen.
import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { STAGES, type Stage } from "@hardhub/protocol";
import { TopBar } from "../components/topbar";
import { ChatLog, Composer } from "../components/chat";
import { useApp } from "../lib/app";
import { navigate, onLink } from "../lib/router";
import { useProject } from "../lib/use-project";
import { isKeyError } from "../lib/project-state";
import { STAGE_LABEL, usd } from "../lib/format";
import { providerInfo, modelLabel } from "../config/llm";
import { centreIn, useEdgeFade } from "../lib/edge-fade";
import { Icon3D, IconChecks, IconCircuit, IconLayout, IconOrder, IconParts, IconRequirements } from "../components/icons";

// each tab is its own chunk; the light ones are fetched while the browser is
// idle so switching tabs never waits on the network (3D waits until opened:
// it brings three.js)
const once = <T,>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};
const loaders = {
  overview: once(() => import("../panes/overview")),
  parts: once(() => import("../panes/parts")),
  circuit: once(() => import("../panes/circuit")),
  board: once(() => import("../panes/board2d")),
  checks: once(() => import("../panes/checks")),
  order: once(() => import("../panes/order")),
};
const Overview = lazy(loaders.overview);
const Parts = lazy(loaders.parts);
const Circuit = lazy(loaders.circuit);
const Board2D = lazy(loaders.board);
const Viewer3D = lazy(() => import("../panes/viewer3d"));
const Checks = lazy(loaders.checks);
const Order = lazy(loaders.order);

// one menu: each view, with an icon, marked done or current as the design
// moves through its stages (STAGE_TAB says which view shows which stage)
const TABS = [
  { id: "overview", label: "Requirements", icon: <IconRequirements /> },
  { id: "parts", label: "Parts", icon: <IconParts /> },
  { id: "circuit", label: "Circuit", icon: <IconCircuit /> },
  { id: "board", label: "Layout", icon: <IconLayout /> },
  { id: "3d", label: "3D", icon: <Icon3D /> },
  { id: "checks", label: "Checks", icon: <IconChecks /> },
  { id: "order", label: "Order", icon: <IconOrder /> },
] as const satisfies readonly { id: string; label: string; icon: ReactNode }[];
type Tab = (typeof TABS)[number]["id"];

// the tab that shows what a stage produced
const STAGE_TAB: Record<Stage, Tab> = {
  idea: "overview",
  parts: "parts",
  circuit: "circuit",
  board: "overview",
  layout: "board",
  checks: "checks",
  view: "3d",
  order: "order",
};

/** where a view stands: done when every stage it shows is behind the current one */
function tabProgress(tab: Tab, stage: Stage | null): "done" | "current" | "" {
  if (!stage) return tab === "overview" ? "current" : "";
  if (STAGE_TAB[stage] === tab) return "current";
  const at = STAGES.indexOf(stage);
  const mine = STAGES.filter((s) => STAGE_TAB[s] === tab).map((s) => STAGES.indexOf(s));
  return mine.length && mine.every((i) => i < at) ? "done" : "";
}

// the chat column on a wide screen: dragged, or moved with the arrow keys
const CHAT_KEY = "hh_chat_width";
const CHAT_MIN = 300;
const CHAT_DEFAULT = 400;
const readChatWidth = () => {
  try {
    const n = Number(localStorage.getItem(CHAT_KEY));
    return n >= CHAT_MIN ? n : CHAT_DEFAULT;
  } catch {
    return CHAT_DEFAULT;
  }
};

export default function Workspace({ id }: { id: string }) {
  const { backend, me } = useApp();
  const { detail, state, link, error, send } = useProject(backend, id);
  // the tab lives in React state (so a transition can keep the current tab on
  // screen until the next one is ready) and is mirrored into the URL
  const [tabParam, setTabParam] = useState(() => new URLSearchParams(location.search).get("tab"));
  const setTab = useCallback((t: string) => {
    const q = new URLSearchParams(location.search);
    q.set("tab", t);
    history.replaceState(null, "", `${location.pathname}?${q}`);
    startTransition(() => setTabParam(t));
  }, []);
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(() => Object.values(loaders).forEach((l) => l()));
  }, []);
  const [pane, setPane] = useState<"chat" | "board">("chat");
  const ws = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState(readChatWidth);
  // the board keeps at least 420 px; the chat at most 60% of the window
  const clampChat = useCallback((w: number) => {
    const total = ws.current?.clientWidth ?? window.innerWidth;
    return Math.round(Math.max(CHAT_MIN, Math.min(w, total - 420, total * 0.6)));
  }, []);
  const saveChat = useCallback((w: number) => {
    try {
      localStorage.setItem(CHAT_KEY, String(w));
    } catch {
      /* private mode: the width lasts this visit */
    }
  }, []);
  const dragChat = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const left = ws.current?.getBoundingClientRect().left ?? 0;
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      let w = chatWidth;
      const move = (m: globalThis.PointerEvent) => setChatWidth((w = clampChat(m.clientX - left)));
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        saveChat(w);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [chatWidth, clampChat, saveChat],
  );
  const nudgeChat = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 80 : 24;
      const next = e.key === "ArrowLeft" ? chatWidth - step : e.key === "ArrowRight" ? chatWidth + step : e.key === "Home" ? CHAT_MIN : e.key === "End" ? Infinity : null;
      if (next === null) return;
      e.preventDefault();
      const w = clampChat(next);
      setChatWidth(w);
      saveChat(w);
    },
    [chatWidth, clampChat, saveChat],
  );
  // a narrower window brings a wide chat back within bounds
  useEffect(() => {
    const fit = () => setChatWidth((w) => clampChat(w));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [clampChat]);
  const tabRow = useRef<HTMLDivElement>(null);
  useEdgeFade(tabRow);
  const [seenArtifacts, setSeenArtifacts] = useState(0);

  const stage = state.stage ?? detail?.stage ?? null;
  const tab: Tab = (TABS.some((t) => t.id === tabParam) ? tabParam : stage ? STAGE_TAB[stage] : "overview") as Tab;
  // a phone shows a few tabs at a time: keep the open one in view
  useEffect(() => {
    centreIn(tabRow.current, tabRow.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null);
  }, [tab, pane]);

  const provider = me ? providerInfo(me.llm.provider) : null;
  const noKey = !!me && !me.llm_ready;
  const keyError = isKeyError(state.lastError) || (noKey && !!state.lastError);
  const keyLabel = me?.llm.provider === "anthropic" || !me ? "Add your Claude API key" : `Add your ${provider?.name} key`;

  const onAnswer = useCallback((answers: Record<string, string[]>) => send({ type: "message", text: "Answers", answers }), [send]);
  const onSend = useCallback((text: string) => send({ type: "message", text }), [send]);
  const onStop = useCallback(() => send({ type: "stop" }), [send]);
  const onKeyHelp = useCallback(() => navigate("/settings"), []);

  // a phone user in the chat learns new results arrived on the board side
  const newResults = pane === "chat" && state.artifacts.length > seenArtifacts;
  useEffect(() => {
    if (pane === "board") setSeenArtifacts(state.artifacts.length);
  }, [pane, state.artifacts.length]);

  const fileUrl = useCallback((u: string) => backend.fileUrl(id, u), [backend, id]);
  const design = detail?.design;

  const main = useMemo(() => {
    if (!design) return <div className="center-state"><div className="spinner-line" /></div>;
    switch (tab) {
      case "overview":
        return <Overview design={design} />;
      case "parts":
        return <Parts design={design} />;
      case "circuit":
        return <Circuit design={design} />;
      case "board":
        return <Board2D design={design} artifacts={state.artifacts} fileUrl={fileUrl} />;
      case "3d":
        return <Viewer3D design={design} artifacts={state.artifacts} fileUrl={fileUrl} />;
      case "checks":
        return <Checks checks={state.checks} />;
      case "order":
        return <Order design={design} artifacts={state.artifacts} fileUrl={fileUrl} />;
    }
  }, [tab, design, state.artifacts, state.checks, fileUrl]);

  if (error)
    return (
      <div className="screen">
        <TopBar back />
        <div className="center-state">
          <div>
            <h1 className="d4">This board could not be opened</h1>
            <p className="secondary">{error}</p>
            <a className="btn" href="/" onClick={onLink} style={{ alignSelf: "flex-start" }}>
              All boards
            </a>
          </div>
        </div>
      </div>
    );

  const fullBleed = tab === "board" || tab === "3d";

  return (
    <div className="screen" style={{ height: "100dvh", overflow: "hidden" }}>
      <TopBar back>
        <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} data-testid="project-name">
          {detail?.name ?? "…"}
        </span>
        {link !== "open" && <span className="tag">{link === "connecting" ? "Connecting" : "Reconnecting"}</span>}
      </TopBar>
      <div className="ws" data-pane={pane} ref={ws} style={{ ["--chat-w" as string]: `${chatWidth}px` }}>
        <section className="ws-chat" aria-label="Conversation">
          <div
            className="ws-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the chat"
            aria-valuemin={CHAT_MIN}
            aria-valuenow={chatWidth}
            tabIndex={0}
            onPointerDown={dragChat}
            onKeyDown={nudgeChat}
            onDoubleClick={() => {
              const w = clampChat(CHAT_DEFAULT);
              setChatWidth(w);
              saveChat(w);
            }}
            data-testid="chat-resize"
          />
          {noKey && (
            <div className="note-bar" data-testid="no-key-bar">
              <span>To chat here, add an AI key, or keep designing from your connected Claude or ChatGPT.</span>
              <a className="btn btn-sm" href="/settings" onClick={onLink} data-testid="add-key-bar">
                {keyLabel}
              </a>
            </div>
          )}
          <ChatLog
            items={state.items}
            openQuestions={state.openQuestions}
            busy={state.busy}
            onAnswer={onAnswer}
            keyError={keyError}
            onKeyHelp={onKeyHelp}
            keyLabel={keyLabel}
          />
          <Composer
            busy={state.busy}
            onSend={onSend}
            onStop={onStop}
            hint={
              state.usage.cost > 0
                ? `${me ? modelLabel(me.llm.provider, me.llm.model) : "AI"} · ${usd(state.usage.cost)} so far`
                : me
                  ? modelLabel(me.llm.provider, me.llm.model)
                  : ""
            }
          />
        </section>
        <section className="ws-main" aria-label="Board">
          <div
            className="viewbar"
            role="tablist"
            aria-label={`Views · design stage: ${STAGE_LABEL[stage ?? "idea"]}, ${STAGES.indexOf(stage ?? "idea") + 1} of ${STAGES.length}`}
            ref={tabRow}
            data-testid="stepper"
            data-stage={stage ?? "idea"}
          >
            {TABS.map((t) => {
              const progress = tabProgress(t.id, stage);
              const failing = t.id === "checks" && state.checks.some((c) => c.status === "fail");
              return (
                <button
                  key={t.id}
                  role="tab"
                  className={`vtab${progress ? ` ${progress}` : ""}`}
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  title={progress === "current" ? `${t.label}: the stage the design is at` : t.label}
                  data-testid={`tab-${t.id}`}
                >
                  <span className="vtab-icon">
                    {t.icon}
                    {(progress || failing) && <span className={`vtab-mark${failing ? " fail" : ""}`} aria-hidden="true" />}
                  </span>
                  <span className="vtab-label">{t.label}</span>
                  {failing && <span className="sr-only"> (a check failed)</span>}
                  {progress === "current" && <span className="sr-only"> (current stage)</span>}
                </button>
              );
            })}
          </div>
          <div className={fullBleed ? "viewer-wrap" : "pane"} style={fullBleed ? { flex: 1, minHeight: 0, display: "flex" } : undefined} role="tabpanel">
            <Suspense fallback={<div className="center-state"><div className="spinner-line" /></div>}>{main}</Suspense>
          </div>
        </section>
      </div>
      <nav className="segmented" aria-label="Show">
        <button aria-pressed={pane === "chat"} onClick={() => setPane("chat")} data-testid="pane-chat">
          Chat
          {state.openQuestions && pane !== "chat" && <span className="badge" aria-label="Questions waiting" />}
        </button>
        <button aria-pressed={pane === "board"} onClick={() => setPane("board")} data-testid="pane-board">
          Design
          {newResults && <span className="badge" aria-label="New results" />}
        </button>
      </nav>
    </div>
  );
}
