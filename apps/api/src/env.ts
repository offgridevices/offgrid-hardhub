import type { ProjectRoom } from "./room";
import type { EngineContainer } from "./engine";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ROOMS: DurableObjectNamespace<ProjectRoom>;
  ENGINE: DurableObjectNamespace<EngineContainer>;
  /** the web app's built files; bound on Cloudflare, absent locally */
  ASSETS?: Fetcher;

  /** "1" in local development: sign-in links are returned, dev overrides apply */
  DEV: string;
  /** the web app's origin, for sign-in links; empty: the request's own origin */
  APP_URL: string;
  /** comma-separated origins allowed by CORS */
  WEB_ORIGINS: string;
  /** engine base URL; empty means use the ENGINE container binding */
  ENGINE_URL: string;
  /** "1": Durable Objects are created in the US jurisdiction */
  US_ONLY: string;

  /** base64 of 32 random bytes; encrypts stored API keys (secret) */
  KEY_ENCRYPTION_KEY: string;

  /** sign-in emails through Resend (secrets); without them production sign-in is refused */
  RESEND_API_KEY?: string;
  /** the sender, e.g. "HardHub <signin@yourdomain.com>" on a domain verified in Resend */
  MAIL_FROM?: string;

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
