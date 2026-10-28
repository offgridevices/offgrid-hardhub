// What the interface needs from a server. The real client (api.ts) and the
// demo data (mock.ts) both implement it, so every screen runs on either.
import type {
  AuthStart,
  ClientMessage,
  LlmProvider,
  LlmSettings,
  Me,
  ProjectDetail,
  ProjectSummary,
  ServerEvent,
  Session,
} from "@hardhub/protocol";

export type LinkStatus = "connecting" | "open" | "closed";

export interface ProjectLink {
  send(msg: ClientMessage): void;
  close(): void;
}

export interface Backend {
  readonly kind: "api" | "mock";
  token(): string | null;
  /** Can the server be reached at all? Any HTTP answer counts. */
  ping(): Promise<boolean>;
  authStart(email: string): Promise<AuthStart>;
  authVerify(token: string): Promise<Session>;
  adoptToken(token: string): void;
  logout(): Promise<void>;
  me(): Promise<Me>;
  setLlm(llm: LlmSettings): Promise<Me>;
  saveKey(provider: LlmProvider, key: string): Promise<Me>;
  deleteKey(provider: LlmProvider): Promise<Me>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name?: string; prompt?: string }): Promise<ProjectSummary>;
  getProject(id: string): Promise<ProjectDetail>;
  renameProject(id: string, name: string): Promise<ProjectSummary>;
  deleteProject(id: string): Promise<void>;
  /** URL a browser element (<img>, fetch, download link) can load. */
  fileUrl(projectId: string, url: string): string;
  connect(
    projectId: string,
    after: number,
    onEvent: (e: ServerEvent) => void,
    onStatus: (s: LinkStatus) => void,
  ): ProjectLink;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}
