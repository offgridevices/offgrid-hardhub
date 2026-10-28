// HardHub's chat on your own Claude Code: a small helper that runs on your
// computer (./hardhub starts it) and lets HardHub's API run a chat turn
// through the Claude Code you have installed and signed in to. Your Claude
// subscription does the thinking; HardHub never sees your Claude login.
//
// Each turn runs the official, unmodified `claude` program, as Anthropic's
// terms ask (https://code.claude.com/docs/en/legal-and-compliance):
//
//   claude -p --output-format stream-json --verbose --include-partial-messages
//          --tools "" --strict-mcp-config --mcp-config <file: HardHub's MCP server only>
//          --allowedTools mcp__hardhub --permission-prompts none --setting-sources user
//          --append-system-prompt <HardHub's guide> [--resume <session>] [--model <alias>]
//          < the message, on stdin
//
// in an empty, private folder: no shell, no file tools, none of your other MCP
// servers, no project settings; only HardHub's board tools. The message goes
// on stdin, never on the command line, so no message can be read as an
// option, and the turn's token is in a private file, not in `ps`.
// Zero dependencies (Node 20+).
//
//   BRIDGE_TOKEN   shared secret the API must send (required)
//   BRIDGE_PORT    8789
//   BRIDGE_HOST    127.0.0.1 (Docker Desktop reaches it as host.docker.internal)
//   CLAUDE_BIN     claude
//   BRIDGE_HOME    a private folder for the per-project working folders (default: a new one in the temp folder)
//   TURN_MINUTES   a turn longer than this is stopped (60)
//
// API:  GET /health -> {ok, claude, signed_in, auth}
//       POST /turn  {project, prompt, system, mcp: {url, token}, session?, model?}
//                   -> NDJSON: {type:"session"|"text_delta"|"text"|"done", ...}
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const PORT = Number(process.env.BRIDGE_PORT ?? 8789);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const MAX_BODY = 1_000_000;
const ID = /^[\w-]{1,64}$/;
const TURN_MS = Number(process.env.TURN_MINUTES ?? 60) * 60_000;
// owned by this user only: nobody else can plant settings or a CLAUDE.md in it
const HOME = process.env.BRIDGE_HOME ?? mkdtempSync(join(tmpdir(), "hardhub-bridge-"));
mkdirSync(HOME, { recursive: true, mode: 0o700 });
chmodSync(HOME, 0o700);
// claude gets the environment minus the bridge's own secret
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.BRIDGE_TOKEN;
const running = new Set();

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

  // an empty, private folder of its own per project: no CLAUDE.md, .mcp.json or files of yours in reach
  const cwd = join(HOME, project);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  // the turn's token goes in a private file, not on the command line where `ps` shows it
  const configFile = join(cwd, `mcp-${process.pid}-${Date.now()}.json`);
  writeFileSync(configFile, JSON.stringify({ mcpServers: { hardhub: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }), { mode: 0o600 });
  const args = [
    "-p",
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", configFile,
    "--allowedTools", "mcp__hardhub",
    "--permission-prompts", "none",
    "--setting-sources", "user",
    ...(system ? ["--append-system-prompt", String(system)] : []),
    ...(session ? ["--resume", session] : []),
    ...(model ? ["--model", model] : []),
  ];
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const send = (o) => res.write(JSON.stringify(o) + "\n");
  const child = spawn(CLAUDE, args, { cwd, env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"] });
  running.add(child);
  // the message on stdin: whatever it says, it is never an option
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  // the person pressed Stop (or the API went away): end the turn the way Claude
  // Code asks, with SIGINT, and make sure of it a little later
  let killer = null;
  const stop = () => {
    if (child.exitCode !== null || killer) return;
    child.kill("SIGINT");
    killer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 10_000);
  };
  signal.addEventListener("abort", stop);
  const limit = setTimeout(stop, TURN_MS);

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
  const cleanup = () => {
    running.delete(child);
    clearTimeout(limit);
    clearTimeout(killer);
    signal.removeEventListener("abort", stop);
    rmSync(configFile, { force: true });
  };
  child.on("error", (e) => {
    cleanup();
    send({ type: "done", ok: false, error: e.code === "ENOENT" ? "Claude Code is not installed on this computer." : String(e.message) });
    res.end();
  });
  child.on("close", (code) => {
    cleanup();
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

server.on("error", (e) => {
  console.error(`bridge: ${e.code === "EADDRINUSE" ? `port ${PORT} is already in use (another bridge?)` : e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`hardhub bridge on ${HOST}:${PORT}, using ${CLAUDE}, working in ${HOME}`));
// stopping: end every running turn too, so no claude is left behind
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    for (const c of running) c.kill("SIGINT");
    server.close();
    setTimeout(() => {
      for (const c of running) c.kill("SIGKILL");
      process.exit(0);
    }, running.size ? 3000 : 0);
  });
