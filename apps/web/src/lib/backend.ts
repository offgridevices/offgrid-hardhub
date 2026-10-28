// What the interface needs from a server. The real client (api.ts) and the
// demo data (mock.ts) both implement it, so every screen runs on either.
import type {
  ClientMessage,
  Connections,
  OAuthApprove,
  OAuthClientInfo,
  LlmProvider,
  LlmSettings,
  Me,
  ProjectDetail,
  ProjectSummary,
  ServerEvent,
  Session,
} from "@hardhub/protocol";

export type LinkStatus = "connecting" | "open" | "closed";

/** POST /auth/start: production emails a link (204); local dev answers with a session. */
export interface AuthStart {
  sent: boolean;
  dev_link?: string;
  token?: string;
}

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
  /** AI apps connected over MCP, and the address to connect more */
  connections(): Promise<Connections>;
  disconnect(clientId: string): Promise<void>;
  /** the consent page: who is asking, then the person's answer (where to send the browser) */
  oauthClient(clientId: string, redirectUri: string): Promise<OAuthClientInfo>;
  oauthApprove(answer: OAuthApprove): Promise<{ redirect: string }>;
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
