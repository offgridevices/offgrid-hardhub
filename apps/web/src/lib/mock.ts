// Demo mode (VITE_MOCK=1): the whole interface on scripted data, no server.
import {
  Design,
  emptyDesign,
  type AuthStart,
  type LlmProvider,
  type LlmSettings,
  type Me,
  type ProjectDetail,
  type ProjectSummary,
  type ServerEvent,
  type Session,
  type Stage,
} from "@hardhub/protocol";
import type { Backend, LinkStatus, ProjectLink } from "./backend";
import { usbHubDesign } from "../fixtures/usb-hub";
import { gardenHistory, hubHistory, replyScript, type ScriptStep } from "../fixtures/script";

interface MockProject {
  summary: ProjectSummary;
  design: Design;
  events: ServerEvent[];
  listeners: Set<(e: ServerEvent) => void>;
  busy: boolean;
}

const t0 = Date.parse("2026-10-17T14:58:00Z");

function stamp(steps: ScriptStep[], start = 0): ServerEvent[] {
  return steps.map(({ delay: _d, ...e }, i) => ({ ...e, seq: start + i, at: new Date(t0 + i * 20_000).toISOString() }) as ServerEvent);
}

function lastStage(events: ServerEvent[]): Stage {
  let s: Stage = "idea";
  for (const e of events) if (e.type === "stage") s = e.stage;
  return s;
}

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private tok: string | null = "demo";
  private meState: Me = {
    id: "demo",
    email: "you@example.com",
    keys: {},
    llm: { provider: "anthropic", model: "claude-opus-5-5" },
  };
  private projects = new Map<string, MockProject>();

  constructor() {
    const hub = stamp(hubHistory);
    this.projects.set("demo-hub", {
      summary: { id: "demo-hub", name: "Print hub", stage: lastStage(hub), created_at: "2026-10-17T14:58:00Z", updated_at: "2026-10-18T09:12:00Z" },
      design: usbHubDesign,
      events: hub,
      listeners: new Set(),
      busy: false,
    });
    const garden = stamp(gardenHistory);
    this.projects.set("demo-garden", {
      summary: { id: "demo-garden", name: "Garden moisture sensor", stage: lastStage(garden), created_at: "2026-10-27T18:40:00Z", updated_at: "2026-10-27T18:41:00Z" },
      design: Design.parse({ name: "Garden moisture sensor", summary: "Battery soil-moisture sensor reporting to Home Assistant." }),
      events: garden,
      listeners: new Set(),
      busy: false,
    });
  }

  token() {
    return this.tok;
  }
  adoptToken(t: string) {
    this.tok = t;
  }
  async ping() {
    return true;
  }
  async authStart(_email: string): Promise<AuthStart> {
    return { sent: true, token: "demo", dev_link: "#demo" };
  }
  async authVerify(token: string): Promise<Session> {
    this.tok = token;
    return { token, me: this.meState };
  }
  async logout() {
    this.tok = null;
  }
  async me() {
    return structuredClone(this.meState);
  }
  async setLlm(llm: LlmSettings) {
    this.meState = { ...this.meState, llm };
    return this.me();
  }
  async saveKey(provider: LlmProvider, key: string) {
    this.meState.keys = { ...this.meState.keys, [provider]: { last4: key.slice(-4), added_at: new Date().toISOString() } };
    return this.me();
  }
  async deleteKey(provider: LlmProvider) {
    const keys = { ...this.meState.keys };
    delete keys[provider];
    this.meState.keys = keys;
    return this.me();
  }
  async listProjects() {
    return [...this.projects.values()].map((p) => p.summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async createProject(input: { name?: string; prompt?: string }) {
    const id = `demo-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const name = input.name ?? (input.prompt ? input.prompt.split(/[.,\n]/)[0]!.slice(0, 48) : "Untitled board");
    const p: MockProject = {
      summary: { id, name, stage: "idea", created_at: now, updated_at: now },
      design: emptyDesign(name),
      events: [],
      listeners: new Set(),
      busy: false,
    };
    this.projects.set(id, p);
    this.push(p, { type: "stage", stage: "idea" });
    if (input.prompt) this.userMessage(p, input.prompt);
    return p.summary;
  }
  private get(id: string) {
    const p = this.projects.get(id);
    if (!p) throw new Error("Project not found");
    return p;
  }
  async getProject(id: string): Promise<ProjectDetail> {
    const p = this.get(id);
    return {
      ...p.summary,
      design: p.design,
      design_version: 1,
      last_seq: p.events.length - 1,
      busy: p.busy,
    };
  }
  async renameProject(id: string, name: string) {
    const p = this.get(id);
    p.summary = { ...p.summary, name };
    return p.summary;
  }
  async deleteProject(id: string) {
    this.projects.delete(id);
  }
  fileUrl(_id: string, url: string) {
    return url;
  }

  private push(p: MockProject, e: ScriptStep) {
    const { delay: _d, ...rest } = e;
    const ev = { ...rest, seq: p.events.length, at: new Date().toISOString() } as ServerEvent;
    p.events.push(ev);
    if (ev.type === "stage") p.summary = { ...p.summary, stage: ev.stage };
    p.summary = { ...p.summary, updated_at: ev.at };
    for (const l of p.listeners) l(ev);
  }

  private userMessage(p: MockProject, text: string, answers?: Record<string, string[]>) {
    this.push(p, { type: "user_message", id: `u${p.events.length}`, text, answers });
    p.busy = true;
    const steps = replyScript(text, !!answers);
    let wait = 0;
    for (const s of steps) {
      wait += s.delay ?? 30;
      setTimeout(() => {
        this.push(p, s);
        if (s.type === "turn_end") p.busy = false;
      }, wait);
    }
  }

  connect(projectId: string, after: number, onEvent: (e: ServerEvent) => void, onStatus: (s: LinkStatus) => void): ProjectLink {
    const p = this.get(projectId);
    onStatus("open");
    for (const e of p.events) if (e.seq > after) onEvent(e);
    p.listeners.add(onEvent);
    return {
      send: (m) => {
        if (m.type === "message" && !p.busy) this.userMessage(p, m.text, m.answers);
      },
      close: () => {
        p.listeners.delete(onEvent);
        onStatus("closed");
      },
    };
  }
}
