// Local API: applies the D1 migrations, then runs `wrangler dev` with local
// D1, R2 and Durable Objects persisted under HH_STATE. Settings come from the
// environment (docker compose sets them), with defaults for a bare `pnpm dev`:
//
//   HH_STATE            where local data lives          .wrangler/state
//   PORT                                                8787
//   ENGINE_URL          the engine service              http://localhost:8080
//   APP_URL             the web app, for sign-in links  http://localhost:5173
//   MCP_URL             the MCP address Settings shows  http://localhost:PORT/mcp
//   WEB_ORIGINS         CORS origins                    APP_URL and 127.0.0.1:5173
//   KEY_ENCRYPTION_KEY  encrypts stored API keys        generated once, kept in HH_STATE
//   BRIDGE_URL, BRIDGE_TOKEN  the bridge to the person's own Claude Code (./hardhub sets them)
//   DEV_LLM_PROVIDER, DEV_LLM_MODEL, DEV_LLM_BASE_URL, DEV_LLM_KEY
//                       LLM defaults for new accounts and a fallback key (dev only)
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const e = process.env;
const state = resolve(e.HH_STATE || ".wrangler/state");
mkdirSync(state, { recursive: true });

const kekFile = join(state, "dev-key-encryption-key");
if (!e.KEY_ENCRYPTION_KEY && !existsSync(kekFile)) writeFileSync(kekFile, randomBytes(32).toString("base64"), { mode: 0o600 });
const kek = e.KEY_ENCRYPTION_KEY || readFileSync(kekFile, "utf8").trim();

const appUrl = e.APP_URL || "http://localhost:5173";
const vars = {
  DEV: "1",
  APP_URL: appUrl,
  // agents connect to the API's own port; Settings shows this address
  MCP_URL: e.MCP_URL || `http://localhost:${e.PORT || "8787"}/mcp`,
  WEB_ORIGINS: e.WEB_ORIGINS || `${appUrl},http://127.0.0.1:5173`,
  ENGINE_URL: e.ENGINE_URL || "http://localhost:8080",
  US_ONLY: "0",
  KEY_ENCRYPTION_KEY: kek,
  ...Object.fromEntries(
    ["DEV_LLM_PROVIDER", "DEV_LLM_MODEL", "DEV_LLM_BASE_URL", "DEV_LLM_KEY", "ANTHROPIC_BASE_URL", "BRIDGE_URL", "BRIDGE_TOKEN"]
      .filter((k) => e[k])
      .map((k) => [k, e[k]]),
  ),
};
// secrets go through a file wrangler reads, not the command line
const varsFile = join(state, "dev.vars");
writeFileSync(varsFile, Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });

const env = { ...e, WRANGLER_SEND_METRICS: "false" };
const migrate = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "hardhub", "--local", "--persist-to", state], { stdio: "inherit", env });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const dev = spawn(
  "npx",
  ["wrangler", "dev", "--ip", "0.0.0.0", "--port", e.PORT || "8787", "--persist-to", state, "--env-file", varsFile, "--show-interactive-dev-session=false"],
  { stdio: "inherit", env },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => dev.kill(sig));
dev.on("exit", (code) => process.exit(code ?? 0));
