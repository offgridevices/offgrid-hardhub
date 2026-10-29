// One turn of the conversation: the person's message in, the model working
// through tools until it answers, asks a question, or something stops it.
//
// The history is append-only. A turn appends the person's message, then each
// assistant message exactly as the provider returned it, then one message
// with all of that step's tool results. Nothing earlier is ever edited, so
// prompt caches stay warm and Claude's thinking blocks stay valid. Whenever
// an assistant message with tool calls is appended, its results follow before
// the turn returns, even when the turn is stopped or fails; the one exception
// is ask_user, whose result is the person's answer and arrives next turn.
import { type Llm, LlmError, LlmMalformed, type StreamSink, type ToolCall, type ToolOutcome, type ToolSpec } from "./llm/types";

export type TurnEnd = "waiting_for_user" | "done" | "stopped" | "error";

export interface ToolRun {
  outcome: ToolOutcome;
  /** ask_user: the result is the person's answer, given next turn */
  waitForUser?: boolean;
}

export interface Pending {
  /** results of the other tools in the step that asked */
  outcomes: ToolOutcome[];
  askIds: string[];
}

export interface TurnIO {
  llm: Llm;
  system: string;
  tools: ToolSpec[];
  history(): unknown[];
  append(messages: unknown[]): void;
  sink: StreamSink;
  error(message: string, retryable: boolean): void;
  usage(u: { input: number; output: number; costUsd: number }): void;
  runTool(call: ToolCall, signal: AbortSignal): Promise<ToolRun>;
  getPending(): Pending | null;
  setPending(p: Pending | null): void;
  signal: AbortSignal;
}

export interface TurnInput {
  text: string;
  answers?: Record<string, string[]>;
  /** what happened in the project since the last turn that the model should know
   * (the person edited the board by hand): a note before their words, not shown as theirs */
  context?: string;
}

export const LIMITS = {
  /** model calls per turn */
  steps: 40,
  /** steps in a row where every tool call was invalid, before giving up */
  badSteps: 3,
  /** re-issues of a call whose output could not be parsed */
  malformed: 2,
};

export function formatAnswers(input: TurnInput): string {
  const lines = Object.entries(input.answers ?? {}).map(([q, a]) => `${q}: ${a.join(", ")}`);
  if (input.text.trim()) lines.push(lines.length ? `They added: ${input.text.trim()}` : input.text.trim());
  return lines.length ? `The person answered.\n${lines.join("\n")}` : "The person did not answer the questions.";
}

const stopped = (c: ToolCall): ToolOutcome => ({ id: c.id, name: c.name, content: "Stopped by the person before this ran.", isError: true });

export async function runTurn(io: TurnIO, input: TurnInput): Promise<TurnEnd> {
  // the person's message, answering any questions still open
  const pending = io.getPending();
  const note = (t: string) => (input.context ? `${input.context}\n\n${t}` : t);
  if (pending) {
    const answer = note(formatAnswers(input));
    const outcomes = [
      ...pending.outcomes,
      ...pending.askIds.map((id, i) => ({ id, name: "ask_user", content: i === 0 ? answer : "Answered above." })),
    ];
    io.append(io.llm.toolResults(outcomes));
    io.setPending(null);
  } else {
    io.append(io.llm.userText(note(input.text || formatAnswers(input))));
  }

  let badSteps = 0;
  let malformed = 0;
  for (let step = 0; step < LIMITS.steps; step++) {
    if (io.signal.aborted) return "stopped";
    let res;
    try {
      res = await io.llm.call({ system: io.system, tools: io.tools, history: io.history() }, io.sink, io.signal);
    } catch (e) {
      if (io.signal.aborted) return "stopped";
      if (e instanceof LlmMalformed && malformed++ < LIMITS.malformed) {
        step--;
        continue;
      }
      if (e instanceof LlmError) io.error(e.message, e.retryable);
      else io.error(`The AI call failed: ${e instanceof Error ? e.message : String(e)}`, true);
      return "error";
    }
    malformed = 0;
    io.usage({ input: res.usage.input + res.usage.cacheRead + res.usage.cacheWrite, output: res.usage.output, costUsd: res.usage.costUsd });

    if (res.stop === "refusal") {
      // a declined reply is not kept: it may hold a cut-off tool call
      io.error("The model declined to continue with this request.", false);
      return "error";
    }
    if (res.stop === "max_tokens" && res.toolCalls.length) {
      io.error("The model's reply was cut off mid tool call. Ask it to continue in smaller steps.", true);
      return "error";
    }
    io.append([res.assistant]);
    if (res.stop === "pause") continue;
    if (!res.toolCalls.length) return "done";

    const outcomes: ToolOutcome[] = [];
    const askIds: string[] = [];
    let valid = 0;
    for (const call of res.toolCalls) {
      if (io.signal.aborted) {
        outcomes.push(stopped(call));
        continue;
      }
      if (call.name === "ask_user" && askIds.length) {
        outcomes.push({ id: call.id, name: call.name, content: "Only one ask_user per step; put every question in one call.", isError: true });
        continue;
      }
      let run: ToolRun;
      try {
        run = await io.runTool(call, io.signal);
      } catch (e) {
        run = { outcome: { id: call.id, name: call.name, content: `The tool failed: ${e instanceof Error ? e.message : String(e)}`, isError: true } };
      }
      if (!run.outcome.isError) valid++;
      if (run.waitForUser) askIds.push(call.id);
      else outcomes.push(run.outcome);
    }

    if (io.signal.aborted) {
      io.append(io.llm.toolResults([...outcomes, ...askIds.map((id) => stopped({ id, name: "ask_user", input: {} }))]));
      return "stopped";
    }
    if (askIds.length) {
      io.setPending({ outcomes, askIds });
      return "waiting_for_user";
    }
    io.append(io.llm.toolResults(outcomes));

    // a model that keeps sending broken calls is not going to recover
    badSteps = valid ? 0 : badSteps + 1;
    if (badSteps >= LIMITS.badSteps) {
      io.error("The model kept sending tool calls HardHub could not use. Try again, or pick a more capable model in Settings.", false);
      return "error";
    }
  }
  io.error(`Stopped after ${LIMITS.steps} steps in one turn. Send a message to let it continue.`, true);
  return "error";
}
