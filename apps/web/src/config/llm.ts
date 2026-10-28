// The AI providers HardHub can use, their model presets and where each runs.
// Change a preset here and nowhere else.
import type { LlmProvider } from "@hardhub/protocol";

export interface ProviderInfo {
  id: LlmProvider;
  name: string;
  recommended?: boolean;
  /** one plain sentence: where the AI runs */
  where: string;
  needsKey: boolean;
  keyHint?: string;
  keyUrl?: string;
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
  /** presets offered in the model picker; the first is the default */
  models: { id: string; label: string; note?: string }[];
  /** free-text model names are allowed */
  freeModel: boolean;
  modelPlaceholder?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Claude",
    recommended: true,
    where: "Runs on Anthropic's servers in the US only; HardHub asks for US inference on every request.",
    needsKey: true,
    keyHint: "sk-ant-…",
    keyUrl: "https://platform.claude.com/settings/keys",
    needsBaseUrl: false,
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Best results. Recommended for real boards." },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster and about half the cost." },
    ],
    freeModel: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    where: "Routed through OpenRouter and pinned to US-hosted providers only.",
    needsKey: true,
    keyHint: "sk-or-…",
    keyUrl: "https://openrouter.ai/settings/keys",
    needsBaseUrl: false,
    models: [],
    modelPlaceholder: "Model id from openrouter.ai/models",
    freeModel: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    where: "Runs on OpenAI's US data-residency endpoint; your OpenAI project must be set to US residency.",
    needsKey: true,
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    needsBaseUrl: false,
    models: [],
    modelPlaceholder: "Model id from your OpenAI account",
    freeModel: true,
  },
  {
    id: "ollama",
    name: "Ollama on this computer",
    where: "Runs on your own computer. Nothing leaves it.",
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: "http://host.docker.internal:11434/v1",
    models: [{ id: "qwen3.5:0.8b", label: "qwen3.5:0.8b", note: "Small and fast, good for trying HardHub; use Claude for real boards." }],
    freeModel: true,
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    where: "Runs wherever your server runs. Make sure it is in the US if that matters to you.",
    needsKey: true,
    keyHint: "your server's key",
    needsBaseUrl: true,
    defaultBaseUrl: "https://",
    models: [],
    modelPlaceholder: "Model name your server serves",
    freeModel: true,
  },
];

export function providerInfo(id: LlmProvider): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

export function modelLabel(provider: LlmProvider, model: string): string {
  return providerInfo(provider).models.find((m) => m.id === model)?.label ?? model;
}
