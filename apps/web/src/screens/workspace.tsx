// One project: the conversation on one side, the board on the other. On a
// phone they are two panes switched at the bottom of the screen.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { STAGES, type Stage } from "@hardhub/protocol";
import { TopBar } from "../components/topbar";
import { ChatLog, Composer } from "../components/chat";
import { useApp } from "../lib/app";
import { navigate, onLink, useQueryParam } from "../lib/router";
import { useProject } from "../lib/use-project";
import { isKeyError } from "../lib/project-state";
import { STAGE_LABEL, usd } from "../lib/format";
import { providerInfo, modelLabel } from "../config/llm";

const Overview = lazy(() => import("../panes/overview"));
const Parts = lazy(() => import("../panes/parts"));
const Circuit = lazy(() => import("../panes/circuit"));
const Board2D = lazy(() => import("../panes/board2d"));
const Viewer3D = lazy(() => import("../panes/viewer3d"));
const Checks = lazy(() => import("../panes/checks"));
const Order = lazy(() => import("../panes/order"));

const TABS = [
  { id: "overview", label: "Requirements" },
  { id: "parts", label: "Parts" },
  { id: "circuit", label: "Circuit" },
  { id: "board", label: "Board" },
  { id: "3d", label: "3D" },
  { id: "checks", label: "Checks" },
  { id: "order", label: "Order" },
] as const;
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

const Stepper = memo(function Stepper({ stage, onPick }: { stage: Stage | null; onPick(s: Stage): void }) {
  const at = stage ? STAGES.indexOf(stage) : 0;
  return (
    <nav className="stepper" aria-label="Design stages" data-testid="stepper" data-stage={stage ?? "idea"}>
      {STAGES.map((s, i) => (
        <button
          key={s}
          className={`step${i < at ? " done" : i === at ? " current" : ""}`}
          aria-current={i === at ? "step" : undefined}
          onClick={() => onPick(s)}
          data-testid={`step-${s}`}
        >
          <span className="node" />
          {STAGE_LABEL[s]}
        </button>
      ))}
    </nav>
  );
});

export default function Workspace({ id }: { id: string }) {
  const { backend, me } = useApp();
  const { detail, state, link, error, send } = useProject(backend, id);
  const [tabParam, setTab] = useQueryParam("tab");
  const [pane, setPane] = useState<"chat" | "board">("chat");
  const [seenArtifacts, setSeenArtifacts] = useState(0);

  const stage = state.stage ?? detail?.stage ?? null;
  const tab: Tab = (TABS.some((t) => t.id === tabParam) ? tabParam : stage ? STAGE_TAB[stage] : "overview") as Tab;

  const provider = me ? providerInfo(me.llm.provider) : null;
  const noKey = !!me && !!provider?.needsKey && !me.keys[me.llm.provider];
  const keyError = isKeyError(state.lastError) || (noKey && !!state.lastError);
  const keyLabel = me?.llm.provider === "anthropic" || !me ? "Add your Claude API key" : `Add your ${provider?.name} key`;

  const onAnswer = useCallback((answers: Record<string, string[]>) => send({ type: "message", text: "Answers", answers }), [send]);
  const onSend = useCallback((text: string) => send({ type: "message", text }), [send]);
  const onStop = useCallback(() => send({ type: "stop" }), [send]);
  const onKeyHelp = useCallback(() => navigate("/settings"), []);
  const pickStage = useCallback(
    (s: Stage) => {
      setTab(STAGE_TAB[s]);
      setPane("board");
    },
    [setTab],
  );

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
      <div className="ws" data-pane={pane}>
        <section className="ws-chat" aria-label="Conversation">
          {noKey && (
            <div className="note-bar" data-testid="no-key-bar">
              <span>HardHub needs an AI key to design.</span>
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
          <div className="ws-stepbar">
            <Stepper stage={stage} onPick={pickStage} />
          </div>
          <div className="tabs" role="tablist" aria-label="Views">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                className="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                data-testid={`tab-${t.id}`}
              >
                {t.label}
                {t.id === "checks" && state.checks.some((c) => c.status === "fail") && <span style={{ color: "var(--destructive)" }}> ·</span>}
              </button>
            ))}
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
          Board
          {newResults && <span className="badge" aria-label="New results" />}
        </button>
      </nav>
    </div>
  );
}
