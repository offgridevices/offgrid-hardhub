// What the interface needs from a server. The real client (api.ts) and the
// demo data (mock.ts) both implement it, so every screen runs on either.
import type {
  BridgeStatus,
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
  AuthStatus,
  BoardEditRequest,
  BoardEditResult,
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
  /** is there an account yet, and may a new one be made? */
  authStatus(): Promise<AuthStatus>;
  signUp(email: string, password: string): Promise<Session>;
  signIn(email: string, password: string): Promise<Session>;
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
  /** can HardHub's chat run on Claude Code on this computer? */
  bridgeStatus(): Promise<BridgeStatus>;
  /** AI apps connected over MCP, and the address to connect more */
  connections(): Promise<Connections>;
  disconnect(clientId: string): Promise<void>;
  /** the consent page: who is asking, then the person's answer (where to send the browser) */
  oauthClient(clientId: string, redirectUri: string): Promise<OAuthClientInfo>;
  oauthApprove(answer: OAuthApprove): Promise<{ redirect: string }>;
  /** hand edits to the routed board: applied in KiCad, then every check runs again */
  editBoard(projectId: string, req: BoardEditRequest): Promise<BoardEditResult>;
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
