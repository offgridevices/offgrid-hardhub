import type { ProjectRoom } from "./room";
import type { EngineContainer } from "./engine";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ROOMS: DurableObjectNamespace<ProjectRoom>;
  ENGINE: DurableObjectNamespace<EngineContainer>;
  /** the web app's built files; bound on Cloudflare, absent locally */
  ASSETS?: Fetcher;

  /** "1" in local development: dev overrides apply, cookies work over http */
  DEV: string;
  /** local development: extra host names the API answers to (comma-separated) */
  DEV_HOSTS?: string;
  /** the web app's origin, for the MCP consent page; empty: the request's own origin */
  APP_URL: string;
  /** the MCP address shown in Settings; empty: <the app's address>/mcp */
  MCP_URL?: string;
  /** comma-separated origins allowed by CORS */
  WEB_ORIGINS: string;
  /** engine base URL; empty means use the ENGINE container binding */
  ENGINE_URL: string;
  /** "1": Durable Objects are created in the US jurisdiction */
  US_ONLY: string;

  /** the bridge to the person's own Claude Code (local only; ./hardhub sets both) */
  BRIDGE_URL?: string;
  BRIDGE_TOKEN?: string;

  /** base64 of 32 random bytes; encrypts stored API keys (secret) */
  KEY_ENCRYPTION_KEY: string;

  /** "1": anyone may create an account. Otherwise only the first account,
   *  the owner's, can be created (end-to-end tests set it) */
  ALLOW_SIGNUP?: string;

  // development and test only, ignored unless DEV is "1":
  // new accounts start with these LLM settings, and DEV_LLM_KEY stands in
  // when the person stored no key (e2e against the fake Anthropic server or Ollama)
  DEV_LLM_PROVIDER?: string;
  DEV_LLM_MODEL?: string;
  DEV_LLM_BASE_URL?: string;
  DEV_LLM_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}

export const isDev = (env: Env) => env.DEV === "1";
