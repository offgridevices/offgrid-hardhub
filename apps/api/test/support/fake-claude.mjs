#!/usr/bin/env node
// A stand-in for the `claude` program in tests: answers --version and
// auth status, and for -p prints Claude Code's stream-json lines. It writes
// the arguments it got to $FAKE_CLAUDE_LOG so tests can check them.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: process.env.FAKE_CLAUDE_AUTH ?? "claude.ai" }));
  process.exit(process.env.FAKE_CLAUDE_AUTH === "none" ? 1 : 0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "6f1c2b9e-0d4e-4a51-9a7e-2c3b4d5e6f70";
const prompt = args[args.indexOf("-p") + 1];
if (prompt === "fail") {
  out({ type: "system", subtype: "init", session_id: session });
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login", session_id: session });
  process.exit(1);
}
if (prompt === "slow") {
  out({ type: "system", subtype: "init", session_id: session });
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  out({ type: "system", subtype: "init", session_id: session, mcp_servers: [{ name: "hardhub", status: "connected" }] });
  for (const t of ["I'll look ", "at your board."])
    out({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } });
  out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { content: [{ type: "text", text: "I'll look at your board." }, { type: "tool_use", id: "t1", name: "mcp__hardhub__get_design", input: {} }] } });
  // a subagent's text is not the chat's
  out({ type: "assistant", session_id: session, parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "(subagent)" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: session, total_cost_usd: 0.01 });
}
