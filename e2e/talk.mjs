// Talk to a HardHub project from the command line, through the same REST and
// WebSocket API the apps use (local dev sign-in).
//
//   node e2e/talk.mjs start EMAIL "PROMPT"              -> prints the project id
//   node e2e/talk.mjs say EMAIL PROJECT "TEXT" [ANSWERS] -> ANSWERS as JSON {questionId: [optionId]}
//   node e2e/talk.mjs log EMAIL PROJECT [AFTER]          -> the events after seq AFTER, one per line
//
// API_URL defaults to http://localhost:8787.
const API = process.env.API_URL ?? "http://localhost:8787";
const [cmd, email, a, b, c] = process.argv.slice(2);

async function session() {
  const post = (path, body) => fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const start = await post("/auth/start", { email });
  const s = await post("/auth/verify", { token: start.token });
  return s.token;
}

const token = await session();
const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };

if (cmd === "start") {
  const p = await (await fetch(API + "/projects", { method: "POST", headers: h, body: JSON.stringify({ prompt: a }) })).json();
  console.log(p.id);
} else if (cmd === "say") {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/projects/${a}/ws?token=${token}`);
  await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)));
  ws.send(JSON.stringify({ type: "hello", after: 1e9 }));
  ws.send(JSON.stringify({ type: "message", text: b ?? "", ...(c ? { answers: JSON.parse(c) } : {}) }));
  await new Promise((r) => setTimeout(r, 500));
  ws.close();
  console.log("sent");
} else if (cmd === "log") {
  const r = await (await fetch(`${API}/projects/${a}/events?after=${b ?? -1}&limit=1000`, { headers: h })).json();
  for (const e of r.events) {
    const { seq, type, at, ...rest } = e;
    console.log(`${seq} ${type} ${JSON.stringify(rest).slice(0, 400)}`);
  }
}
