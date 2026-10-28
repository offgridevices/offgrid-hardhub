// Picks the person's LLM for a turn: their settings, their key (decrypted for
// this turn only), the provider's preset.
import { LlmProvider, type LlmSettings } from "@hardhub/protocol";
import { getKey, getMe } from "../../db";
import { type Env, isDev } from "../../env";
import { AnthropicLlm } from "./anthropic";
import { OpenAiLlm } from "./openai";
import { PRESETS } from "./presets";
import { type Llm, LlmError } from "./types";

export * from "./types";
export { PRESETS, OLLAMA_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODEL } from "./presets";

const LABEL: Record<LlmProvider, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  custom: "The custom endpoint",
};

/** Development defaults for new accounts (DEV=1 only), so local and e2e runs need no setup. */
export function devLlmDefaults(env: Env): LlmSettings | null {
  if (!isDev(env) || !env.DEV_LLM_PROVIDER) return null;
  const provider = LlmProvider.parse(env.DEV_LLM_PROVIDER);
  return {
    provider,
    model: env.DEV_LLM_MODEL || PRESETS[provider].defaultModel || "claude-opus-5-5",
    ...(env.DEV_LLM_BASE_URL ? { base_url: env.DEV_LLM_BASE_URL } : {}),
  };
}

export function makeLlm(settings: LlmSettings, key: string | null, env: Env): Llm {
  const preset = PRESETS[settings.provider];
  if (preset.needsKey && !key)
    throw new LlmError(`Add your ${LABEL[settings.provider]} API key in Settings to start designing.`, false);
  if (preset.format === "anthropic") {
    // a different Anthropic endpoint is for local testing only
    const baseURL = isDev(env) ? settings.base_url || env.ANTHROPIC_BASE_URL : undefined;
    return new AnthropicLlm({ apiKey: key!, model: settings.model, ...(baseURL ? { baseURL } : {}) });
  }
  const baseURL = settings.base_url && (settings.provider === "custom" || settings.provider === "ollama") ? settings.base_url : preset.baseURL;
  if (!baseURL) throw new LlmError("Set the endpoint URL for the custom provider in Settings.", false);
  return new OpenAiLlm({
    apiKey: key ?? "",
    baseURL,
    model: settings.model,
    label: LABEL[settings.provider],
    vision: preset.vision,
    ...(preset.extraBody ? { extraBody: preset.extraBody } : {}),
  });
}

// format converters only: they never make a request, so they need no client
const NO_CLIENT = {} as never;
export const CONVERTERS = {
  anthropic: new AnthropicLlm({ apiKey: "", model: "", client: NO_CLIENT }),
  openai: new OpenAiLlm({ apiKey: "", baseURL: "http://unused", model: "", label: "", vision: false, client: NO_CLIENT }),
};

export async function llmFor(env: Env, userId: string): Promise<Llm> {
  const me = await getMe(env, userId);
  if (!me) throw new LlmError("Your account was not found.", false);
  let key = await getKey(env, userId, me.llm.provider);
  if (!key && isDev(env) && env.DEV_LLM_KEY) key = env.DEV_LLM_KEY;
  return makeLlm(me.llm, key, env);
}
