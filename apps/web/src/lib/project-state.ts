// Folds the project's event stream into what the workspace draws. Pure, so it
// replays the same way on every client and is easy to test.
import type { Artifact, CheckResult, Comparison, Question, ServerEvent, Stage } from "@hardhub/protocol";

export type ChatItem =
  | { kind: "user"; id: string; text: string; answers?: Record<string, string[]> }
  | { kind: "assistant"; id: string; text: string; done: boolean }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error"; detail?: string }
  | { kind: "questions"; id: string; questions: Question[] }
  | { kind: "comparison"; id: string; comparison: Comparison }
  | { kind: "stage"; id: string; stage: Stage }
  | { kind: "job"; id: string; job: string; step: string; progress: number; done: boolean; ok?: boolean }
  | { kind: "error"; id: string; message: string; retryable: boolean };

export interface ProjectState {
  lastSeq: number;
  items: ChatItem[];
  stage: Stage | null;
  designVersion: number;
  designSummary: string;
  checks: CheckResult[];
  artifacts: Artifact[];
  usage: { input: number; output: number; cost: number };
  busy: boolean;
  /** id of the questions item still waiting for an answer, if any */
  openQuestions: string | null;
  lastError: string | null;
}

export const initialState: ProjectState = {
  lastSeq: -1,
  items: [],
  stage: null,
  designVersion: 0,
  designSummary: "",
  checks: [],
  artifacts: [],
  usage: { input: 0, output: 0, cost: 0 },
  busy: false,
  openQuestions: null,
  lastError: null,
};

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.kind === item.kind && x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

export function reduce(s: ProjectState, e: ServerEvent): ProjectState {
  if (e.seq <= s.lastSeq) return s; // duplicate after a reconnect
  const n: ProjectState = { ...s, lastSeq: e.seq };
  switch (e.type) {
    case "user_message":
      n.items = [...s.items, { kind: "user", id: e.id, text: e.text, answers: e.answers }];
      n.busy = true;
      n.openQuestions = null;
      n.lastError = null;
      break;
    case "assistant_text": {
      // deltas: the server sends the text so far under one id, or appends;
      // either way the latest event carries the whole text
      n.items = upsert(s.items, { kind: "assistant", id: e.id, text: e.text, done: e.done });
      n.busy = true;
      break;
    }
    case "thinking":
      n.items = upsert(s.items, { kind: "thinking", id: e.id, text: e.text });
      n.busy = true;
      break;
    case "tool":
      n.items = upsert(s.items, { kind: "tool", id: e.id, name: e.name, label: e.label, status: e.status, detail: e.detail });
      n.busy = true;
      break;
    case "questions":
      n.items = upsert(s.items, { kind: "questions", id: e.id, questions: e.questions });
      n.openQuestions = e.id;
      break;
    case "comparison":
      n.items = upsert(s.items, { kind: "comparison", id: e.comparison.id, comparison: e.comparison });
      break;
    case "design":
      n.designVersion = e.version;
      n.designSummary = e.summary;
      break;
    case "stage":
      if (e.stage !== s.stage && s.stage !== null) n.items = [...s.items, { kind: "stage", id: `stage-${e.seq}`, stage: e.stage }];
      n.stage = e.stage;
      break;
    case "job":
      n.items = upsert(s.items, { kind: "job", id: e.job, job: e.job, step: e.step, progress: e.progress, done: e.done, ok: e.ok });
      break;
    case "checks": {
      // results arrive per job; a later result for the same check replaces it
      const byId = new Map(s.checks.map((c) => [c.id, c]));
      for (const r of e.results) byId.set(r.id, r);
      n.checks = [...byId.values()];
      break;
    }
    case "artifacts": {
      const byName = new Map(s.artifacts.map((a) => [a.name, a]));
      for (const a of e.artifacts) byName.set(a.name, a);
      n.artifacts = [...byName.values()];
      break;
    }
    case "usage":
      n.usage = {
        input: s.usage.input + e.input_tokens,
        output: s.usage.output + e.output_tokens,
        cost: s.usage.cost + e.cost_usd,
      };
      break;
    case "error":
      n.items = [...s.items, { kind: "error", id: `err-${e.seq}`, message: e.message, retryable: e.retryable }];
      n.lastError = e.message;
      break;
    case "turn_end":
      n.busy = false;
      // a turn that ended for any reason but a question leaves nothing open
      if (e.reason !== "waiting_for_user") n.openQuestions = null;
      // a streamed message cut short still renders as finished
      n.items = s.items.map((it) => (it.kind === "assistant" && !it.done ? { ...it, done: true } : it));
      break;
  }
  return n;
}

export function replay(events: ServerEvent[], from: ProjectState = initialState): ProjectState {
  return events.reduce(reduce, from);
}

/** Does this error mean the person has to add or fix their AI key? */
export function isKeyError(message: string | null): boolean {
  return !!message && /api[ _-]?key|no key|unauthori[sz]ed|authentication|401/i.test(message);
}
