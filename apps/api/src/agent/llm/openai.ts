// Any OpenAI-compatible chat API through the official openai SDK: OpenAI's
// US endpoint, OpenRouter pinned to US hosts, a local Ollama, or a custom URL.
// Tolerates the quirks of small local models: arguments as an object instead
// of a JSON string, tool calls without ids or indexes, no usage, reasoning in
// non-standard fields.
import OpenAI from "openai";
import {
  type CallRequest,
  type CallResult,
  type Llm,
  LlmError,
  type NeutralMessage,
  type StopKind,
  type StreamSink,
  type ToolCall,
  type ToolOutcome,
} from "./types";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface OpenAiOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  /** provider name for error messages: "OpenRouter", "Ollama" */
  label: string;
  vision: boolean;
  extraBody?: Record<string, unknown>;
  /** for tests: replaces the SDK client */
  client?: Pick<OpenAI, "chat">;
}

// non-standard streaming fields some servers send
interface DeltaExtras {
  reasoning?: string | null;
  reasoning_content?: string | null;
  thinking?: string | null;
}
interface UsageExtras {
  cost?: number;
}

export class OpenAiLlm implements Llm {
  readonly format = "openai" as const;
  readonly model: string;
  readonly vision: boolean;
  private readonly client: Pick<OpenAI, "chat">;

  constructor(private readonly o: OpenAiOptions) {
    this.model = o.model;
    this.vision = o.vision;
    this.client = o.client ?? new OpenAI({ apiKey: o.apiKey || "none", baseURL: o.baseURL, maxRetries: 2 });
  }

  userText(text: string): Msg[] {
    return [{ role: "user", content: text }];
  }

  toolResults(results: ToolOutcome[], text?: string): Msg[] {
    const out: Msg[] = results.map((r) => ({
      role: "tool",
      tool_call_id: r.id,
      content: (r.isError ? "ERROR: " : "") + (r.content || "(no output)"),
    }));
    // tool messages carry text only; images follow in a user message
    const images = results.flatMap((r) => r.images ?? []);
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (images.length && this.vision) {
      parts.push({ type: "text", text: "The render the tool returned:" });
      for (const im of images) parts.push({ type: "image_url", image_url: { url: `data:${im.mediaType};base64,${im.data}` } });
    }
    if (text) parts.push({ type: "text", text });
    if (parts.length) out.push({ role: "user", content: parts });
    return out;
  }

  async call(req: CallRequest, sink: StreamSink, signal?: AbortSignal): Promise<CallResult> {
    const params = {
      model: this.model,
      stream: true as const,
      stream_options: { include_usage: true },
      messages: [{ role: "system" as const, content: req.system }, ...(req.history as Msg[]).map(emptyText)],
      tools: req.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
      ...this.o.extraBody,
    };

    let text = "";
    let thinking = "";
    let started = false;
    let finish: string | null = null;
    let model = this.model;
    let usage: (OpenAI.CompletionUsage & UsageExtras) | null = null;
    const calls: { id?: string; name?: string; args: string | object }[] = [];

    try {
      const stream = await this.client.chat.completions.create(params, signal ? { signal } : undefined);
      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & DeltaExtras;
        const r = d.reasoning ?? d.reasoning_content ?? d.thinking;
        if (r) thinking += r;
        if (d.content) {
          if (!started) {
            started = true;
            sink.textStart();
          }
          text += d.content;
          sink.text(d.content);
        }
        for (const [k, tc] of (d.tool_calls ?? []).entries()) {
          // Ollama may omit index, and may send a whole call per chunk
          const i = typeof tc.index === "number" ? tc.index : calls.length + k;
          const slot = (calls[i] ??= { args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = (slot.name ?? "") + tc.function.name;
          const a = tc.function?.arguments as unknown;
          if (a && typeof a === "object") slot.args = a;
          else if (typeof a === "string" && typeof slot.args === "string") slot.args += a;
        }
      }
    } catch (e) {
      throw this.classify(e);
    }

    if (thinking.trim()) sink.thinking(thinking);
    if (started) sink.textDone(text);

    const toolCalls: ToolCall[] = calls
      .filter((c) => c && c.name)
      .map((c, n) => {
        const id = c.id || `call_${Date.now().toString(36)}_${n}`;
        if (typeof c.args === "object") return { id, name: c.name!, input: c.args };
        const raw = c.args.trim() || "{}";
        try {
          return { id, name: c.name!, input: JSON.parse(raw) as unknown };
        } catch {
          return { id, name: c.name!, input: {}, badJson: raw.slice(0, 2000) };
        }
      });

    const stop: StopKind = toolCalls.length
      ? "tool_use"
      : finish === "length"
        ? "max_tokens"
        : finish === "content_filter"
          ? "refusal"
          : "end";

    const assistant: Msg = {
      role: "assistant",
      content: text || (toolCalls.length ? null : ""),
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.badJson ?? JSON.stringify(c.input) },
            })),
          }
        : {}),
    };

    return {
      assistant,
      text,
      toolCalls,
      stop,
      model,
      usage: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
        // OpenRouter reports the price it charged; others give none
        costUsd: typeof usage?.cost === "number" ? usage.cost : 0,
      },
    };
  }

  toNeutral(history: unknown[]): NeutralMessage[] {
    const out: NeutralMessage[] = [];
    for (const m of history as Msg[]) {
      if (m.role === "tool") {
        const r = { id: m.tool_call_id, name: "", content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("\n") };
        const last = out.at(-1);
        if (last?.role === "user" && !last.text) (last.results ??= []).push(r);
        else out.push({ role: "user", results: [r] });
      } else if (m.role === "user") {
        const t = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
        const last = out.at(-1);
        if (last?.role === "user" && !last.text) last.text = t;
        else out.push({ role: "user", text: t });
      } else if (m.role === "assistant") {
        out.push({
          role: "assistant",
          text: typeof m.content === "string" ? m.content : "",
          calls: (m.tool_calls ?? []).flatMap((c) =>
            c.type === "function" ? [{ id: c.id, name: c.function.name, input: safeParse(c.function.arguments) }] : [],
          ),
        });
      }
    }
    return out;
  }

  fromNeutral(messages: NeutralMessage[]): Msg[] {
    const out: Msg[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        for (const r of m.results ?? []) out.push({ role: "tool", tool_call_id: r.id, content: (r.isError ? "ERROR: " : "") + r.content });
        if (m.text) out.push({ role: "user", content: m.text });
      } else {
        out.push({
          role: "assistant",
          content: m.text || (m.calls.length ? null : ""),
          ...(m.calls.length
            ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
            : {}),
        });
      }
    }
    return out;
  }

  private classify(e: unknown): Error {
    const who = this.o.label;
    if (e instanceof OpenAI.APIUserAbortError) return e;
    if (e instanceof OpenAI.AuthenticationError) return new LlmError(`${who} rejected the API key. Check it in Settings.`, false);
    if (e instanceof OpenAI.PermissionDeniedError) return new LlmError(`${who} does not allow this key to use that model.`, false);
    if (e instanceof OpenAI.NotFoundError) return new LlmError(`${who} does not know the model "${this.model}".`, false);
    if (e instanceof OpenAI.RateLimitError) return new LlmError(`${who}'s rate limit was reached. Try again in a minute.`, true);
    if (e instanceof OpenAI.BadRequestError) return new LlmError(`${who} rejected the request: ${e.message}`, false);
    if (e instanceof OpenAI.APIConnectionError) return new LlmError(`Could not reach ${who} at ${this.o.baseURL}.`, true);
    if (e instanceof OpenAI.APIError) return new LlmError(`${who} error ${e.status ?? ""}: ${e.message}`, true);
    return new LlmError(`${who}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/** An assistant message with neither text nor tool calls must carry "" rather
 *  than null: Ollama rejects null ("invalid message content type"). Also
 *  repairs histories saved before replies were stored that way. */
function emptyText(m: Msg): Msg {
  return m.role === "assistant" && m.content == null && !m.tool_calls?.length ? { ...m, content: "" } : m;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
