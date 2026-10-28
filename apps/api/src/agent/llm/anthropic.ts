// Claude through the Anthropic SDK. Every request runs on US servers
// (inference_geo "us"), streams, thinks adaptively with readable summaries,
// and caches the stable prefix (tools + system) plus the conversation.
import Anthropic from "@anthropic-ai/sdk";
import {
  type CallRequest,
  type CallResult,
  type Llm,
  LlmError,
  LlmMalformed,
  type NeutralMessage,
  type StopKind,
  type StreamSink,
  type ToolCall,
  type ToolOutcome,
} from "./types";

type Msg = Anthropic.MessageParam;

// $ per million tokens: input, output, cache read, 5-minute cache write.
// Claude API list prices, read 2026-10-28; US-only inference costs 1.1x.
const PRICES: [prefix: string, p: [number, number, number, number]][] = [
  ["claude-opus-5-5", [4, 20, 0.2, 5]],
  ["claude-sonnet-5-5", [2, 10, 0.2, 2.5]],
  ["claude-haiku-5-5", [0.1, 0.5, 0.01, 0.125]],
  ["claude-opus", [5, 25, 0.5, 6.25]],
  ["claude-sonnet", [3, 15, 0.3, 3.75]],
];
const US_MULTIPLIER = 1.1;

export function anthropicCost(model: string, u: Anthropic.Usage): number {
  const p = PRICES.find(([k]) => model.startsWith(k))?.[1] ?? PRICES[0]![1];
  const usd =
    (u.input_tokens * p[0] + u.output_tokens * p[1] + (u.cache_read_input_tokens ?? 0) * p[2] + (u.cache_creation_input_tokens ?? 0) * p[3]) /
    1e6;
  return u.inference_geo === "us" ? usd * US_MULTIPLIER : usd;
}

const STOP: Record<string, StopKind> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause",
};

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** for tests: replaces the SDK client */
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicLlm implements Llm {
  readonly format = "anthropic" as const;
  readonly vision = true;
  readonly model: string;
  private readonly client: Pick<Anthropic, "messages">;

  constructor(o: AnthropicOptions) {
    this.model = o.model;
    this.client = o.client ?? new Anthropic({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), maxRetries: 2 });
  }

  userText(text: string): Msg[] {
    return [{ role: "user", content: text }];
  }

  toolResults(results: ToolOutcome[], text?: string): Msg[] {
    const content: Anthropic.ContentBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      ...(r.isError ? { is_error: true } : {}),
      content: [
        { type: "text", text: r.content || "(no output)" },
        ...(r.images ?? []).map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
      ],
    }));
    // tool results come first in a user message; the person's words after
    if (text) content.push({ type: "text", text });
    return [{ role: "user", content }];
  }

  async call(req: CallRequest, sink: StreamSink, signal?: AbortSignal): Promise<CallResult> {
    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: 64000,
      inference_geo: "us",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      // tools render before system, so this one breakpoint caches both
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools.map((t) => ({ ...t, eager_input_streaming: true })),
      // histories saved before empty replies were stored as "(no reply)"
      messages: (req.history as Msg[]).map((m) => (m.role === "assistant" && Array.isArray(m.content) && !m.content.length ? { ...m, content: "(no reply)" } : m)),
      // and the conversation so far, moving with each request
      cache_control: { type: "ephemeral" },
    };
    let message: Anthropic.Message;
    try {
      const stream = this.client.messages.stream(params, signal ? { signal } : undefined);
      const thinking = new Map<number, string>();
      const texts = new Map<number, string>();
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "thinking") thinking.set(ev.index, "");
          if (ev.content_block.type === "text") {
            texts.set(ev.index, "");
            sink.textStart();
          }
        } else if (ev.type === "content_block_delta") {
          if (ev.delta.type === "thinking_delta") thinking.set(ev.index, (thinking.get(ev.index) ?? "") + ev.delta.thinking);
          else if (ev.delta.type === "text_delta") {
            texts.set(ev.index, (texts.get(ev.index) ?? "") + ev.delta.text);
            sink.text(ev.delta.text);
          }
        } else if (ev.type === "content_block_stop") {
          const th = thinking.get(ev.index);
          if (th !== undefined) {
            if (th.trim()) sink.thinking(th);
            thinking.delete(ev.index);
          }
          const tx = texts.get(ev.index);
          if (tx !== undefined) sink.textDone(tx);
        }
      }
      message = await stream.finalMessage();
    } catch (e) {
      throw classify(e);
    }

    const toolCalls: ToolCall[] = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const u = message.usage;
    return {
      // appended exactly as received: thinking blocks and their signatures
      // included; an empty reply as "(no reply)", since the API refuses an
      // empty message in the history (as fromNeutral below does)
      assistant: { role: "assistant", content: message.content.length ? message.content : "(no reply)" } satisfies Msg,
      text,
      toolCalls,
      stop: STOP[message.stop_reason ?? "end_turn"] ?? "end",
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        costUsd: anthropicCost(message.model ?? this.model, u),
      },
      model: message.model ?? this.model,
    };
  }

  toNeutral(history: unknown[]): NeutralMessage[] {
    const out: NeutralMessage[] = [];
    for (const m of history as Msg[]) {
      const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
      if (m.role === "user") {
        const results = blocks
          .filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result")
          .map((b) => ({
            id: b.tool_use_id,
            name: "",
            content: typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "[image]")).join("\n"),
            ...(b.is_error ? { isError: true } : {}),
          }));
        const text = blocks
          .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        out.push({ role: "user", ...(text ? { text } : {}), ...(results.length ? { results } : {}) });
      } else {
        out.push({
          role: "assistant",
          text: blocks
            .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
          calls: blocks
            .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, input: b.input })),
        });
      }
    }
    return out;
  }

  fromNeutral(messages: NeutralMessage[]): Msg[] {
    return messages.map((m): Msg => {
      if (m.role === "user") {
        const content: Anthropic.ContentBlockParam[] = (m.results ?? []).map((r) => ({
          type: "tool_result",
          tool_use_id: safeId(r.id),
          content: r.content || "(no output)",
          ...(r.isError ? { is_error: true } : {}),
        }));
        if (m.text) content.push({ type: "text", text: m.text });
        return { role: "user", content: content.length ? content : "(continue)" };
      }
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.calls) content.push({ type: "tool_use", id: safeId(c.id), name: c.name, input: c.input ?? {} });
      return { role: "assistant", content: content.length ? content : "(no reply)" };
    });
  }
}

// Anthropic tool ids allow only letters, digits, _ and -
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function classify(e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new LlmError("Claude rejected the API key. Check it in Settings.", false);
  if (e instanceof Anthropic.PermissionDeniedError) return new LlmError("This API key is not allowed to use that model.", false);
  if (e instanceof Anthropic.NotFoundError) return new LlmError("Claude does not know that model name.", false);
  if (e instanceof Anthropic.RateLimitError) return new LlmError("Claude's rate limit was reached. Try again in a minute.", true);
  if (e instanceof Anthropic.BadRequestError) return new LlmError(`Claude rejected the request: ${e.message}`, false);
  if (e instanceof Anthropic.APIConnectionError) return new LlmError("Could not reach Claude.", true);
  if (e instanceof Anthropic.APIError) return new LlmError(`Claude error ${e.status ?? ""}: ${e.message}`, true);
  // anything else came from parsing the model's own output
  return new LlmMalformed(e instanceof Error ? e.message : String(e));
}

export const isAbort = (e: unknown) => e instanceof Anthropic.APIUserAbortError || (e instanceof Error && e.name === "AbortError");
