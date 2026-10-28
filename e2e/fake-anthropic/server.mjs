// A stand-in for api.anthropic.com that replays a scripted conversation, so
// the whole stack (the real Anthropic SDK, the agent loop, tools, the engine,
// the web app) can be tested end to end without an API key or tokens.
//
// It speaks the real streaming wire format (SSE: message_start,
// content_block_start/delta/stop, message_delta, message_stop) and picks the
// reply by how many assistant turns the request already carries, so it keeps
// no state between requests. Every request is checked for the things HardHub
// promises (inference_geo "us", the user's key) and logged for assertions.
//
//   node e2e/fake-anthropic/server.mjs SCRIPT.json [PORT]
//
// A script is { "turns": [ [block, ...], ... ] } where a block is
//   { "thinking": "..." } | { "text": "..." } | { "tool": "name", "input": {...} }
// and an input value { "$file": "relative/path.json" } is replaced by that
// file's parsed contents (paths relative to the script).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [scriptPath, portArg] = process.argv.slice(2);
if (!scriptPath) {
  console.error("usage: server.mjs SCRIPT.json [PORT]");
  process.exit(2);
}
const port = Number(portArg ?? process.env.PORT ?? 8788);
// Relay mode: instead of a script, each request is written to RELAY_DIR as
// req-N.json and the reply (a list of blocks, as in a script turn) is read
// from resp-N.json when someone writes it: a person, or a model in another
// session, answers live. Unscripted, through the real wire format.
const RELAY = process.env.RELAY_DIR;
let relayN = 0;
const LOG = process.env.FAKE_ANTHROPIC_LOG; // optional: one JSON line per request

function load(p) {
  const dir = path.dirname(path.resolve(p));
  const resolve = (v) => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") {
      if (typeof v.$file === "string") {
        // { "$file": "x.json", "$pointer": "/parts" } picks one part of the file
        let doc = JSON.parse(fs.readFileSync(path.resolve(dir, v.$file), "utf8"));
        for (const key of (v.$pointer ?? "").split("/").slice(1)) doc = doc[key.replace(/~1/g, "/").replace(/~0/g, "~")];
        return doc;
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  };
  return resolve(JSON.parse(fs.readFileSync(p, "utf8")));
}

let script = scriptPath === "-" ? { turns: [] } : load(scriptPath);
const problems = [];

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chunks(s, n = 40) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

let toolCounter = 0;

async function reply(res, body, turn, given) {
  const blocks = given ?? script.turns[turn];
  const id = `msg_fake_${turn}_${Date.now()}`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": id });
  const inputTokens = JSON.stringify(body.messages).length >> 2;
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model: body.model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: body.inference_geo ?? null },
    },
  });
  let out = 0;
  let usedTool = false;
  for (const [index, b] of blocks.entries()) {
    if ("thinking" in b) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const c of chunks(b.thinking)) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: c } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig_fake_${turn}_${index}` } });
    } else if ("text" in b) {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const c of chunks(b.text)) {
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: c } });
        await new Promise((r) => setTimeout(r, 5));
      }
      out += b.text.length >> 2;
    } else if ("tool" in b) {
      usedTool = true;
      const toolId = `toolu_fake_${++toolCounter}`;
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name: b.tool, input: {} } });
      const json = JSON.stringify(b.input ?? {});
      for (const c of chunks(json, 512)) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c } });
      out += json.length >> 2;
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: usedTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: out } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function check(req, body) {
  const p = [];
  if (body.inference_geo !== "us") p.push(`inference_geo is ${JSON.stringify(body.inference_geo)}, expected "us"`);
  if (!req.headers["x-api-key"]) p.push("no x-api-key header");
  if (!body.stream) p.push("request is not streaming");
  // append-only history: every assistant turn we sent must come back unchanged
  return p;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__fake/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ turns: script.turns.length, problems }));
  }
  if (req.method === "POST" && req.url === "/__fake/reload") {
    script = load(scriptPath);
    problems.length = 0;
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: req.url } }));
  }
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const turn = body.messages.filter((m) => m.role === "assistant").length;
  const p = check(req, body);
  if (RELAY) {
    problems.push(...p.map((m) => `relay ${relayN}: ${m}`));
    const n = relayN++;
    fs.writeFileSync(path.join(RELAY, `req-${n}.json`), JSON.stringify(body, null, 1));
    const f = path.join(RELAY, `resp-${n}.json`);
    while (!fs.existsSync(f)) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 200));     // let the writer finish
    try {
      return await reply(res, body, turn, load(f));
    } catch (e) {
      console.error(e);
      return res.end();
    }
  }
  problems.push(...p.map((m) => `turn ${turn}: ${m}`));
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ turn, model: body.model, inference_geo: body.inference_geo, problems: p, last: body.messages.at(-1) }) + "\n");
  if (turn >= script.turns.length) {
    // ran past the script: a calm closing line, so a test notices via the log
    script.turns.push([{ text: "(end of scripted conversation)" }]);
    problems.push(`turn ${turn}: past the end of the script`);
  }
  try {
    await reply(res, body, turn);
  } catch (e) {
    console.error(e);
    res.end();
  }
});

server.listen(port, () => console.log(`fake anthropic on :${port}, ${script.turns.length} scripted turns`));
