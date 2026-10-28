#!/usr/bin/env node
// A stand-in for the `claude` program in the end-to-end test: the bridge runs
// it exactly as it runs Claude Code, and it does what Claude Code would. It
// reads the MCP server and token from --mcp-config, calls HardHub's tools
// over HTTP, and prints Claude Code's stream-json lines. No model involved.
//
// Turn 1 ("design ..."): reads the design, names the board, asks a question.
// Turn 2 (the answers): records them as a requirement and says so.
// Turn 3 ("build it"): loads the sensor circuit, builds it in KiCad and
// waits for the result, all inside the one chat turn.
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  process.exit(0);
}
import { readFileSync } from "node:fs";
const flag = (f) => args[args.indexOf(f) + 1];
const prompt = readFileSync(0, "utf8"); // the message comes on stdin
const system = args.includes("--append-system-prompt") ? flag("--append-system-prompt") : "";
const project = /pass project "([^"]+)"/.exec(system)?.[1];
const { url, headers } = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.hardhub;
const session = args.includes("--resume") ? flag("--resume") : "0b7f7a52-3c1e-4e7a-9f61-2d3c4b5a6978";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const tool = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: { project, ...args } });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.content?.[0]?.text ?? "";
};
const say = (text) => {
  for (const part of text.match(/.{1,12}/gs)) out({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } } });
  out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
};

try {
  out({ type: "system", subtype: "init", session_id: session, mcp_servers: [{ name: "hardhub", status: "connected" }] });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.300" } });
  if (prompt.includes("build it")) {
    const fixture = JSON.parse(readFileSync(new URL("../../engine/tests/fixtures/esp32c3-sensor.json", import.meta.url), "utf8"));
    const patch = ["blocks", "parts", "components", "nets", "placement"].map((k) => ({ op: "replace", path: `/${k}`, value: fixture[k] }));
    patch.push({ op: "add", path: "/board", value: fixture.board });
    await tool("update_design", { summary: "The sensor circuit and a 50 x 40 mm board", patch });
    let r = await tool("build_board", {});
    for (let i = 0; i < 40 && r.startsWith("Still building"); i++) r = await tool("wait_for_build", {});
    say(r.startsWith("Build finished") ? `Built it: ${r.split("\n").find((l) => l.startsWith("Checks:"))}` : `The build did not finish: ${r.slice(0, 200)}`);
  } else if (!prompt.includes("My answers")) {
    say("Hello from your own Claude Code. Let me look at the design.");
    await tool("get_design", { sections: ["name"] });
    await tool("update_design", { summary: "Named the board", patch: [{ op: "replace", path: "/name", value: "Bridge sensor" }] });
    await tool("ask_user", {
      questions: [{ id: "power", header: "Power", text: "How will it be powered?", options: [{ id: "usbc", label: "USB-C", recommended: true, detail: "Simplest" }, { id: "battery", label: "Battery" }] }],
    });
    say("I've named it Bridge sensor. One question for you.");
  } else {
    const picked = /How will it be powered\?: (.+)/.exec(prompt)?.[1] ?? "?";
    await tool("update_design", { summary: "Power decided", patch: [{ op: "add", path: "/requirements/-", value: { id: "R1", text: `Powered by ${picked}` } }] });
    say(`Noted: powered by ${picked}.`);
  }
  out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: session });
} catch (e) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: String(e.message ?? e), session_id: session });
  process.exit(1);
}
