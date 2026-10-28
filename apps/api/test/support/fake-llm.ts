// Scripted LLM servers, reached through the real SDKs' `fetch` option: the
// Anthropic and OpenAI clients, their streaming parsers and our providers all
// run for real; only the network is replaced. A reply is picked by how many
// assistant turns the request already carries, like e2e/fake-anthropic.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AnthropicLlm } from "../../src/agent/llm/anthropic";
import { OpenAiLlm } from "../../src/agent/llm/openai";
import type { Llm } from "../../src/agent/llm/types";

export type Block = { thinking: string } | { text: string } | { tool: string; input: unknown } | { toolRaw: string; name: string };
export type Script = Block[][];

export interface Quirks {
  /** Ollama: arguments arrive as an object */
  argsAsObject?: boolean;
  /** tool call deltas without an index */
  noIndex?: boolean;
  /** no usage chunk */
  noUsage?: boolean;
  /** name of the reasoning field ("reasoning", "reasoning_content", "thinking") */
  reasoningField?: string;
}

export interface Recorder {
  bodies: Record<string, unknown>[];
  headers: Headers[];
}

const sse = (event: string | null, data: unknown) => (event ? `event: ${event}\n` : "") + `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

function respond(text: string) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let toolN = 0;

function anthropicReply(body: Record<string, unknown>, blocks: Block[]): string {
  let s = sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_t", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, inference_geo: body.inference_geo ?? null },
    },
  });
  let usedTool = false;
  blocks.forEach((b, index) => {
    if ("thinking" in b) {
      s += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      s += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
      s += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig_${index}` } });
    } else if ("text" in b) {
      s += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < b.text.length; i += 7)
        s += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 7) } });
    } else {
      usedTool = true;
      const name = "tool" in b ? b.tool : b.name;
      const json = "tool" in b ? JSON.stringify(b.input) : b.toolRaw;
      s += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${++toolN}`, name, input: {} } });
      s += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });
    }
    s += sse("content_block_stop", { type: "content_block_stop", index });
  });
  s += sse("message_delta", { type: "message_delta", delta: { stop_reason: usedTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  s += sse("message_stop", { type: "message_stop" });
  return s;
}

function openaiReply(body: Record<string, unknown>, blocks: Block[], q: Quirks): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    sse(null, { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  let s = chunk({ role: "assistant", content: "" });
  let calls = 0;
  for (const b of blocks) {
    if ("thinking" in b) s += chunk({ [q.reasoningField ?? "reasoning"]: b.thinking });
    else if ("text" in b) for (let i = 0; i < b.text.length; i += 7) s += chunk({ content: b.text.slice(i, i + 7) });
    else {
      const name = "tool" in b ? b.tool : b.name;
      const args = "tool" in b ? (q.argsAsObject ? b.input : JSON.stringify(b.input)) : b.toolRaw;
      const call: Record<string, unknown> = { id: q.noIndex ? undefined : `call_${++toolN}`, type: "function", function: { name, arguments: args } };
      if (!q.noIndex) call.index = calls;
      calls++;
      s += chunk({ tool_calls: [call] });
    }
  }
  s += chunk({}, calls ? "tool_calls" : "stop");
  if (!q.noUsage)
    s += sse(null, { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.0012 } });
  s += sse(null, "[DONE]");
  return s;
}

function fakeFetch(script: Script, rec: Recorder, kind: "anthropic" | "openai", q: Quirks = {}) {
  return async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    rec.bodies.push(body);
    rec.headers.push(new Headers(init?.headers));
    const messages = body.messages as { role: string }[];
    const turn = messages.filter((m) => m.role === "assistant").length;
    const blocks = script[turn] ?? [{ text: "(end of script)" }];
    return respond(kind === "anthropic" ? anthropicReply(body, blocks) : openaiReply(body, blocks, q));
  };
}

export function scriptedAnthropic(script: Script) {
  const rec: Recorder = { bodies: [], headers: [] };
  const client = new Anthropic({ apiKey: "sk-test", fetch: fakeFetch(script, rec, "anthropic"), maxRetries: 0 });
  const llm: Llm = new AnthropicLlm({ apiKey: "sk-test", model: "claude-opus-5-5", client });
  return { llm, rec };
}

export function scriptedOpenAi(script: Script, q: Quirks = {}, vision = true) {
  const rec: Recorder = { bodies: [], headers: [] };
  const client = new OpenAI({ apiKey: "sk-test", baseURL: "http://fake/v1", fetch: fakeFetch(script, rec, "openai", q), maxRetries: 0 });
  const llm: Llm = new OpenAiLlm({ apiKey: "sk-test", baseURL: "http://fake/v1", model: "test-model", label: "Test", vision, client });
  return { llm, rec };
}
