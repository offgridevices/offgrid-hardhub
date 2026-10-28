// One command to put the API on Cloudflare:  pnpm --filter @hardhub/api run deploy
//
//  1. signs in to Cloudflare if needed (opens the browser once)
//  2. creates the D1 database and the R2 bucket in the US jurisdiction, if missing,
//     and writes the database id into wrangler.jsonc
//  3. asks once for the web app's address (sign-in links, CORS)
//  4. applies the database migrations
//  5. creates KEY_ENCRYPTION_KEY (encrypts people's API keys) if it is not set
//  6. deploys the Worker, the Durable Objects and the engine container
//
// Safe to run again: every step checks before it creates. Needs Docker running
// (the engine image is built and pushed by wrangler).
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url);
const ENV = ["--env", "production"];
const DB = "hardhub";
const BUCKET = "hardhub-files";
const PLACEHOLDER_URL = "https://hardhub.example";

const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const say = (s) => console.log(`\n▸ ${s}`);
const wrangler = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", env, stdio: ["pipe", "pipe", "inherit"], ...opts });
const run = (args, input) => {
  const r = spawnSync("npx", ["wrangler", ...args], { stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], input, env });
  if (r.status !== 0) {
    console.error(`\nwrangler ${args.join(" ")} failed.`);
    process.exit(r.status ?? 1);
  }
};

say("Cloudflare account");
try {
  console.log(wrangler(["whoami"]).split("\n").find((l) => l.includes("@") || l.includes("associated")) ?? "signed in");
} catch {
  run(["login"]);
}

let config = readFileSync(CONFIG, "utf8");

say(`D1 database "${DB}" (jurisdiction us)`);
const dbs = JSON.parse(wrangler(["d1", "list", "--json"]));
let db = dbs.find((d) => d.name === DB);
if (!db) {
  wrangler(["d1", "create", DB, "--jurisdiction", "us"], { stdio: "inherit" });
  db = JSON.parse(wrangler(["d1", "list", "--json"])).find((d) => d.name === DB);
}
if (!db?.uuid) throw new Error("could not find the D1 database id");
config = config.replace(/("database_id": ")(REPLACE_WITH_D1_ID|[0-9a-f-]{36})(")/, `$1${db.uuid}$3`);
console.log(`id ${db.uuid}`);

say(`R2 bucket "${BUCKET}" (jurisdiction us)`);
const buckets = wrangler(["r2", "bucket", "list", "--jurisdiction", "us"]);
if (!buckets.includes(BUCKET)) wrangler(["r2", "bucket", "create", BUCKET, "--jurisdiction", "us"], { stdio: "inherit" });
else console.log("exists");

if (config.includes(PLACEHOLDER_URL)) {
  say("Web app address");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const url = (await rl.question("Where will the web app live? (e.g. https://hardhub.pages.dev) ")).trim().replace(/\/$/, "");
  rl.close();
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(url)) throw new Error("an https:// address is needed");
  config = config.replaceAll(PLACEHOLDER_URL, url);
}
writeFileSync(CONFIG, config);

say("Database migrations");
run(["d1", "migrations", "apply", DB, "--remote", ...ENV]);

say("Secrets");
const secrets = JSON.parse(wrangler(["secret", "list", ...ENV, "--format", "json"]) || "[]");
if (!secrets.some((s) => s.name === "KEY_ENCRYPTION_KEY")) {
  // generated, never shown: losing it only means people re-enter their API keys
  run(["secret", "put", "KEY_ENCRYPTION_KEY", ...ENV], randomBytes(32).toString("base64"));
} else console.log("KEY_ENCRYPTION_KEY is set");

say("Deploying");
run(["deploy", ...ENV]);
console.log("\nDone. Point the web app's API address at the Worker URL printed above.");
