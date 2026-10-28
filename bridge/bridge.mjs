// HardHub's chat on your own Claude Code: a small helper that runs on your
// computer (./hardhub starts it) and lets HardHub's API run a chat turn
// through the Claude Code you have installed and signed in to. Your Claude
// subscription does the thinking; HardHub never sees your Claude login.
//
// Each turn runs the official, unmodified `claude` program, as Anthropic's
// terms ask (https://code.claude.com/docs/en/legal-and-compliance):
//
//   claude -p "<message>" --output-format stream-json --verbose --include-partial-messages
//          --tools "" --strict-mcp-config --mcp-config <HardHub's MCP server only>
//          --allowedTools mcp__hardhub --permission-prompts none
//          --append-system-prompt <HardHub's guide> [--resume <session>] [--model <alias>]
//
// in an empty folder: no shell, no file tools, none of your other MCP servers;
// only HardHub's board tools. Zero dependencies (Node 20+).
//
//   BRIDGE_TOKEN   shared secret the API must send (required)
//   BRIDGE_PORT    8789
//   BRIDGE_HOST    127.0.0.1 (Docker Desktop reaches it as host.docker.internal)
//   CLAUDE_BIN     claude
//
// API:  GET /health -> {ok, claude, signed_in, auth}
//       POST /turn  {project, prompt, system, mcp: {url, token}, session?, model?}
//                   -> NDJSON: {type:"session"|"text_delta"|"text"|"done", ...}
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const PORT = Number(process.env.BRIDGE_PORT ?? 8789);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const MAX_BODY = 1_000_000;
const ID = /^[\w-]{1,64}$/;

if (TOKEN.length < 32) {
  console.error("bridge: BRIDGE_TOKEN must be set (32+ characters)");
  process.exit(2);
}

const authorized = (req) => {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};

const run = (args, timeout = 15_000) =>
  new Promise((resolve) => {
    execFile(CLAUDE, args, { timeout }, (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout).trim() }));
  });

async function health() {
  const v = await run(["--version"]);
  if (v.code !== 0) return { ok: false, claude: null, signed_in: false, error: "Claude Code is not installed (or not on PATH)" };
  const s = await run(["auth", "status"]);
  let auth = "none";
  try {
    auth = JSON.parse(s.out).authMethod ?? auth;
  } catch {
    /* older Claude Code: exit code only */
  }
  return { ok: true, claude: v.out.split(/\s/)[0], signed_in: s.code === 0, auth };
}

function turn(body, res, signal) {
  const { project, prompt, system, mcp, session, model } = body;
  if (!ID.test(project ?? "") || typeof prompt !== "string" || !prompt || typeof mcp?.url !== "string" || typeof mcp?.token !== "string")
    return res.writeHead(400).end(JSON.stringify({ error: "project, prompt and mcp {url, token} are required" }));
  if (session && !/^[0-9a-f-]{36}$/i.test(session)) return res.writeHead(400).end(JSON.stringify({ error: "bad session id" }));
  if (model && !/^[\w.:-]{1,64}$/.test(model)) return res.writeHead(400).end(JSON.stringify({ error: "bad model name" }));

  // an empty folder of its own per project: no CLAUDE.md, .mcp.json or files of yours in reach
  const cwd = join(tmpdir(), "hardhub-bridge", project);
  mkdirSync(cwd, { recursive: true });
  const config = JSON.stringify({ mcpServers: { hardhub: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } });
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", config,
    "--allowedTools", "mcp__hardhub",
    "--permission-prompts", "none",
    ...(system ? ["--append-system-prompt", String(system)] : []),
    ...(session ? ["--resume", session] : []),
    ...(model ? ["--model", model] : []),
  ];
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const send = (o) => res.write(JSON.stringify(o) + "\n");
  const child = spawn(CLAUDE, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  // the person pressed Stop (or the API went away): end the turn the way Claude Code asks, with SIGINT
  const stop = () => child.exitCode === null && child.kill("SIGINT");
  signal.addEventListener("abort", stop);

  let sid = session ?? null;
  let buf = "";
  let err = "";
  let result = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.session_id && m.session_id !== sid) {
        sid = m.session_id;
        send({ type: "session", id: sid });
      }
      // the chat's own text, not a subagent's (those carry parent_tool_use_id)
      if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta" && !m.parent_tool_use_id) {
        send({ type: "text_delta", index: m.event.index ?? 0, text: m.event.delta.text });
      } else if (m.type === "assistant" && !m.parent_tool_use_id) {
        for (const b of m.message?.content ?? []) {
          if (b.type === "text" && b.text) send({ type: "text", text: b.text });
        }
      } else if (m.type === "result") {
        result = m;
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
  child.on("error", (e) => {
    send({ type: "done", ok: false, error: e.code === "ENOENT" ? "Claude Code is not installed on this computer." : String(e.message) });
    res.end();
  });
  child.on("close", (code) => {
    signal.removeEventListener("abort", stop);
    const failed = !result || result.is_error || (code !== 0 && !signal.aborted);
    const why = result?.is_error ? String(result.result ?? result.subtype ?? "Claude Code reported an error") : err.trim().split("\n").at(-1) || `Claude Code exited with code ${code}`;
    send({ type: "done", ok: !failed, stopped: signal.aborted, session: sid, ...(failed && !signal.aborted ? { error: why.slice(0, 500) } : {}) });
    res.end();
  });
}

const server = createServer(async (req, res) => {
  if (!authorized(req)) return res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await health()));
  }
  if (req.method === "POST" && req.url === "/turn") {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > MAX_BODY) return res.writeHead(413).end();
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.writeHead(400).end(JSON.stringify({ error: "invalid JSON" }));
    }
    const ctl = new AbortController();
    res.on("close", () => !res.writableFinished && ctl.abort());
    return turn(body, res, ctl.signal);
  }
  res.writeHead(404).end();
});

server.listen(PORT, HOST, () => console.log(`hardhub bridge on ${HOST}:${PORT}, using ${CLAUDE}`));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => server.close(() => process.exit(0)));
