// The bridge to the person's own Claude Code (bridge/bridge.mjs, started on
// their computer by ./hardhub): HardHub's chat turn runs there, on their
// Claude subscription, and Claude Code works on the board through HardHub's
// own MCP server. Local only: a cloud deployment has no bridge, and people
// there connect their Claude app to /mcp instead.
import type { BridgeStatus } from "@hardhub/protocol";
import type { Env } from "./env";

/** The OAuth client id of the tokens a bridge turn's Claude Code uses on /mcp. */
export const CHAT_CLIENT = "hardhub-chat";

export type BridgeEvent =
  | { type: "session"; id: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "text"; text: string }
  | { type: "done"; ok: boolean; stopped?: boolean; session?: string | null; error?: string };

export interface TurnRequest {
  project: string;
  prompt: string;
  system: string;
  mcp: { url: string; token: string };
  session?: string;
  model?: string;
}

export interface Bridge {
  health(): Promise<BridgeStatus>;
  turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<BridgeEvent>;
}

export class BridgeError extends Error {}

export function bridgeFor(env: Env): Bridge | null {
  if (!env.BRIDGE_URL || !env.BRIDGE_TOKEN) return null;
  const base = env.BRIDGE_URL.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${env.BRIDGE_TOKEN}`, "content-type": "application/json" };
  return {
    async health() {
      try {
        const r = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(20_000) });
        if (!r.ok) return { available: false, error: `the bridge answered ${r.status}` };
        const h = (await r.json()) as { ok: boolean; claude: string | null; signed_in: boolean; auth?: string; error?: string };
        return { available: h.ok, claude: h.claude ?? undefined, signed_in: h.signed_in, auth: h.auth, ...(h.error ? { error: h.error } : {}) };
      } catch {
        return { available: false, error: "HardHub can't reach Claude Code on this computer: start HardHub with ./hardhub" };
      }
    },
    async *turn(req, signal) {
      let r: Response;
      try {
        r = await fetch(`${base}/turn`, { method: "POST", headers, body: JSON.stringify(req), signal });
      } catch (e) {
        if (signal.aborted) return yield { type: "done", ok: false, stopped: true };
        throw new BridgeError("HardHub can't reach Claude Code on this computer. Start HardHub with ./hardhub (it starts the bridge), then try again.");
      }
      if (!r.ok || !r.body) throw new BridgeError(`Claude Code's bridge refused the turn (${r.status}): ${(await r.text()).slice(0, 300)}`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) yield JSON.parse(line) as BridgeEvent;
        }
        if (done) break;
      }
    },
  };
}
