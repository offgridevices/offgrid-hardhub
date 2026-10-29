// One project: the views of the board on the left and middle, the
// conversation on the right. On a phone they are two panes switched at the
// bottom of the screen.
import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { STAGES, type BoardEditRequest, type Stage } from "@hardhub/protocol";
import { BoxIcon, CircleCheckBigIcon, CpuIcon, DownloadIcon, LayoutDashboardIcon, ListChecksIcon, PackageIcon, WaypointsIcon } from "lucide-react";
import { Screen, TopBar } from "../components/topbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChatLog, Composer } from "../components/chat";
import { useApp } from "../lib/app";
import { navigate, onLink } from "../lib/router";
import { useProject } from "../lib/use-project";
import { isKeyError } from "../lib/project-state";
import { STAGE_LABEL, STAGE_TONE, usd } from "../lib/format";
import { providerInfo, modelLabel } from "../config/llm";
import { centreIn } from "../lib/edge-fade";

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
  { id: "overview", label: "Requirements", icon: <ListChecksIcon /> },
  { id: "parts", label: "Parts", icon: <CpuIcon /> },
  { id: "circuit", label: "Schematic", icon: <WaypointsIcon /> },
  { id: "board", label: "Layout", icon: <LayoutDashboardIcon /> },
  { id: "3d", label: "3D", icon: <BoxIcon /> },
  { id: "checks", label: "Checks", icon: <CircleCheckBigIcon /> },
  { id: "order", label: "Order", icon: <PackageIcon /> },
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

// the chat column on a wide screen, on the right: dragged by its left edge,
// or moved with the arrow keys
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
      const right = ws.current?.getBoundingClientRect().right ?? window.innerWidth;
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      let w = chatWidth;
      const move = (m: globalThis.PointerEvent) => setChatWidth((w = clampChat(right - m.clientX)));
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
      // the handle sits on the chat's left edge: left widens it, right narrows it
      const next = e.key === "ArrowLeft" ? chatWidth + step : e.key === "ArrowRight" ? chatWidth - step : e.key === "Home" ? CHAT_MIN : e.key === "End" ? Infinity : null;
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
  const saveEdits = useCallback((req: BoardEditRequest) => backend.editBoard(id, req), [backend, id]);
  const design = detail?.design;

  const main = useMemo(() => {
    if (!design) return <Centre><Loader /></Centre>;
    switch (tab) {
      case "overview":
        return <Overview design={design} />;
      case "parts":
        return <Parts design={design} />;
      case "circuit":
        return <Circuit design={design} />;
      case "board":
        return <Board2D design={design} artifacts={state.artifacts} checks={state.checks} fileUrl={fileUrl} save={saveEdits} />;
      case "3d":
        return <Viewer3D design={design} artifacts={state.artifacts} fileUrl={fileUrl} />;
      case "checks":
        return <Checks checks={state.checks} />;
      case "order":
        return <Order design={design} artifacts={state.artifacts} fileUrl={fileUrl} />;
    }
  }, [tab, design, state.artifacts, state.checks, fileUrl, saveEdits]);

  if (error)
    return (
      <Screen>
        <TopBar back />
        <Centre>
          <div className="flex max-w-md flex-col items-start gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">This board could not be opened</h1>
            <p className="text-soft">{error}</p>
            <Button variant="outline" asChild>
              <a href="/" onClick={onLink}>
                All boards
              </a>
            </Button>
          </div>
        </Centre>
      </Screen>
    );

  const fullBleed = tab === "board" || tab === "3d" || tab === "circuit";
  const failing = state.checks.some((c) => c.status === "fail");
  const hasOrder = state.artifacts.some((a) => a.kind === "gerbers");

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar
        back
        actions={
          hasOrder && tab !== "order" ? (
            <Button size="sm" className="hidden sm:inline-flex" onClick={() => setTab("order")} data-testid="order-files">
              <DownloadIcon />
              Order files
            </Button>
          ) : null
        }
      >
        <span className="min-w-0 truncate font-medium" data-testid="project-name">
          {detail?.name ?? "…"}
        </span>
        {stage && (
          <Badge tone={STAGE_TONE[stage]} className="hidden sm:inline-flex">
            {STAGE_LABEL[stage]}
          </Badge>
        )}
        {link !== "open" && <Badge tone="gold">{link === "connecting" ? "Connecting" : "Reconnecting"}</Badge>}
      </TopBar>
      <div
        className="ws flex min-h-0 flex-1 flex-col gap-2 p-2 min-[700px]:flex-row min-[700px]:gap-3 min-[700px]:p-3"
        data-pane={pane}
        ref={ws}
        style={{ ["--chat-w" as string]: `${chatWidth}px` }}
      >
        <nav
          className={cn(
            "flex shrink-0 gap-1 overflow-x-auto min-[700px]:flex-col min-[700px]:overflow-visible [scrollbar-width:none]",
            pane === "chat" && "max-[699px]:hidden",
          )}
          role="tablist"
          aria-orientation="vertical"
          aria-label={`Views · design stage: ${STAGE_LABEL[stage ?? "idea"]}, ${STAGES.indexOf(stage ?? "idea") + 1} of ${STAGES.length}`}
          ref={tabRow}
          data-testid="stepper"
          data-stage={stage ?? "idea"}
        >
          {TABS.map((t) => {
            const progress = tabProgress(t.id, stage);
            const fail = t.id === "checks" && failing;
            const selected = tab === t.id;
            return (
              <Tooltip key={t.id}>
                <TooltipTrigger asChild>
                  <button
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setTab(t.id)}
                    data-testid={`tab-${t.id}`}
                    className={cn(
                      "relative flex h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 min-[700px]:w-11 min-[700px]:justify-center min-[700px]:px-0 [&_svg]:size-5",
                      selected && "bg-ember/15 text-ember-text hover:bg-ember/20 hover:text-ember-text",
                    )}
                  >
                    {t.icon}
                    <span className="min-[700px]:sr-only">{t.label}</span>
                    {(progress || fail) && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute right-1.5 top-1.5 size-1.5 rounded-full",
                          fail ? "bg-clay" : progress === "done" ? "bg-moss" : "bg-ember",
                        )}
                      />
                    )}
                    {fail && <span className="sr-only"> (a check failed)</span>}
                    {progress === "current" && <span className="sr-only"> (current stage)</span>}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-[699px]:hidden">
                  {progress === "current" ? `${t.label} · where the design is now` : t.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card",
            pane === "chat" && "max-[699px]:hidden",
          )}
          aria-label="Board"
        >
          <div className={fullBleed ? "flex min-h-0 flex-1" : "min-h-0 flex-1 overflow-y-auto"} role="tabpanel">
            <Suspense fallback={<Centre><Loader /></Centre>}>{main}</Suspense>
          </div>
        </section>

        <aside
          className={cn(
            "ws-chat relative flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card max-[699px]:flex-1 min-[700px]:w-(--chat-w) min-[700px]:shrink-0",
            pane === "board" && "max-[699px]:hidden",
          )}
          aria-label="Conversation"
        >
          <div
            className="absolute inset-y-0 left-0 z-10 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-ember focus-visible:after:bg-ember min-[700px]:block"
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
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <span className="font-semibold">Chat</span>
            {me?.llm_ready && (
              <Badge tone="plum" className="min-w-0 truncate">
                {modelLabel(me.llm.provider, me.llm.model)}
              </Badge>
            )}
          </div>
          {noKey && (
            <div className="flex flex-col gap-2 border-b bg-ember/10 px-4 py-3 text-sm text-ember-text" data-testid="no-key-bar">
              <span>To chat here, add an AI key, or keep designing from your connected Claude or ChatGPT.</span>
              <Button size="xs" variant="outline" className="self-start" asChild>
                <a href="/settings" onClick={onLink} data-testid="add-key-bar">
                  {keyLabel}
                </a>
              </Button>
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
            hint={state.usage.cost > 0 ? `${usd(state.usage.cost)} so far` : ""}
          />
        </aside>
      </div>
      <nav className="grid shrink-0 grid-cols-2 gap-1 border-t bg-card p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] min-[700px]:hidden" aria-label="Show">
        <Button variant={pane === "chat" ? "secondary" : "ghost"} aria-pressed={pane === "chat"} onClick={() => setPane("chat")} data-testid="pane-chat" className="relative">
          Chat
          {state.openQuestions && pane !== "chat" && <span className="size-2 rounded-full bg-ember" aria-label="Questions waiting" />}
        </Button>
        <Button variant={pane === "board" ? "secondary" : "ghost"} aria-pressed={pane === "board"} onClick={() => setPane("board")} data-testid="pane-board" className="relative">
          Design
          {newResults && <span className="size-2 rounded-full bg-ember" aria-label="New results" />}
        </Button>
      </nav>
    </div>
  );
}

function Centre({ children }: { children: ReactNode }) {
  return <div className="grid min-h-60 flex-1 place-items-center p-6">{children}</div>;
}
