// Every LLM provider HardHub can use, in one place. Each keeps inference on
// US servers (owner's rule): change a default model or a URL here only.
import type { LlmProvider } from "@hardhub/protocol";

/** Newest tool-capable Ollama model under 2B parameters (owner, 2026-10-28). */
export const OLLAMA_DEFAULT_MODEL = "qwen3.5:0.8b";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/**
 * OpenRouter is only allowed to route to these providers, with no fallback
 * to others and no data collection. REVIEW BEFORE PRODUCTION: a provider name
 * here is not a promise of US hosting for every model it serves; check each
 * provider's region on OpenRouter for the models people actually pick.
 */
export const OPENROUTER_US_PROVIDERS = ["Anthropic", "OpenAI", "Together", "Fireworks", "Groq", "Cerebras"];

export interface Preset {
  /** wire format of the API */
  format: "anthropic" | "openai";
  baseURL?: string;
  defaultModel?: string;
  /** false: the provider works without a key (local Ollama) */
  needsKey: boolean;
  /** can the model look at board renders */
  vision: boolean;
  /** extra request body fields */
  extraBody?: Record<string, unknown>;
}

export const PRESETS: Record<LlmProvider, Preset> = {
  // inference_geo "us" is sent on every request (anthropic.ts)
  anthropic: { format: "anthropic", defaultModel: ANTHROPIC_DEFAULT_MODEL, needsKey: true, vision: true },
  // OpenAI's US data-residency endpoint; the key's project must be a US-residency project
  openai: { format: "openai", baseURL: "https://us.api.openai.com/v1", needsKey: true, vision: true },
  openrouter: {
    format: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    needsKey: true,
    vision: true,
    extraBody: { provider: { only: OPENROUTER_US_PROVIDERS, allow_fallbacks: false, data_collection: "deny" } },
  },
  // runs on the person's own machine
  ollama: { format: "openai", baseURL: "http://host.docker.internal:11434/v1", defaultModel: OLLAMA_DEFAULT_MODEL, needsKey: false, vision: false },
  // any OpenAI-compatible endpoint the person vouches for; base_url is required
  custom: { format: "openai", needsKey: false, vision: false },
  // the person's own Claude Code, through the bridge (src/bridge.ts): it runs
  // the whole turn itself, so it never goes through makeLlm
  "claude-code": { format: "anthropic", needsKey: false, vision: true },
};
