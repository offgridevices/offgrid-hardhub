// The provider-neutral face of an LLM, so the agent loop, tools and events
// never depend on whose model runs. Each provider keeps the conversation in
// its own wire format (Anthropic thinking blocks go back exactly as they came);
// the loop treats those messages as opaque.

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** set when the model's arguments were not valid JSON */
  badJson?: string;
}

export interface ToolImage {
  mediaType: "image/png" | "image/jpeg";
  data: string; // base64
}

export interface ToolOutcome {
  id: string;
  name: string;
  content: string;
  images?: ToolImage[];
  isError?: boolean;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "pause";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** estimate in USD; 0 when the provider gives no price */
  costUsd: number;
}

export interface CallResult {
  /** native assistant message, appended to history unchanged */
  assistant: unknown;
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  usage: Usage;
  model: string;
}

/** Where streamed output goes as it arrives. */
export interface StreamSink {
  textStart(): void;
  text(delta: string): void;
  textDone(full: string): void;
  thinking(full: string): void;
}

export interface CallRequest {
  system: string;
  tools: ToolSpec[];
  history: unknown[];
}

/** A provider problem the person should see: bad key, rate limit, outage. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** The model's output could not be parsed (e.g. truncated tool JSON); the call can be re-issued. */
export class LlmMalformed extends Error {}

/** Messages in no provider's format, for moving a conversation between providers. */
export type NeutralMessage =
  | { role: "user"; text?: string; results?: { id: string; name: string; content: string; isError?: boolean }[] }
  | { role: "assistant"; text: string; calls: { id: string; name: string; input: unknown }[] };

export interface Llm {
  /** "anthropic" or "openai": the wire format of the history it keeps */
  readonly format: "anthropic" | "openai";
  readonly model: string;
  /** can the model look at images (board renders) */
  readonly vision: boolean;
  userText(text: string): unknown[];
  toolResults(results: ToolOutcome[], text?: string): unknown[];
  call(req: CallRequest, sink: StreamSink, signal?: AbortSignal): Promise<CallResult>;
  toNeutral(history: unknown[]): NeutralMessage[];
  fromNeutral(messages: NeutralMessage[]): unknown[];
}
