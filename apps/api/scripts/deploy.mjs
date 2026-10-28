// One command puts all of HardHub on Cloudflare:  ./hardhub deploy
// (or pnpm --filter @hardhub/api run deploy). One Worker serves the web app
// and the API (/api); the engine runs as a Cloudflare Container.
//
//  1. signs in to Cloudflare if needed (opens the browser once)
//  2. creates the D1 database and the R2 bucket in the US jurisdiction, if missing,
//     and writes the database id into wrangler.jsonc
//  3. applies the database migrations
//  4. makes KEY_ENCRYPTION_KEY (encrypts people's API keys) if it is not set,
//     and offers to set the sign-in email sender (Resend); both go up with the deploy
//  5. builds the web app and deploys the Worker, the Durable Objects and the engine
//
// Safe to run again: every step checks before it creates. Needs Docker running
// (the engine image is built and pushed by wrangler).
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url);
const ENV = ["--env", "production"];
const DB = "hardhub";
const BUCKET = "hardhub-files";

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

writeFileSync(CONFIG, config);

say("Database migrations");
run(["d1", "migrations", "apply", DB, "--remote", ...ENV]);

say("Secrets");
// a first deploy has no Worker yet, so no secrets to list
let secrets = [];
try {
  secrets = JSON.parse(wrangler(["secret", "list", ...ENV, "--format", "json"], { stdio: ["pipe", "pipe", "ignore"] }) || "[]");
} catch {}
const has = (name) => secrets.some((s) => s.name === name);
const upload = {};
// generated, never shown: losing it only means people re-enter their API keys
if (!has("KEY_ENCRYPTION_KEY")) upload.KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
else console.log("KEY_ENCRYPTION_KEY is set");
if (!has("RESEND_API_KEY")) {
  // sign-in links go out by email; without a sender nobody can sign in
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Sign-in links are emailed through Resend (resend.com, free tier). Leave empty to set it later.");
  const key = (await rl.question("Resend API key: ")).trim();
  const from = key ? (await rl.question('Send from (e.g. "HardHub <signin@yourdomain.com>"): ')).trim() : "";
  rl.close();
  if (key && from) Object.assign(upload, { RESEND_API_KEY: key, MAIL_FROM: from });
  else console.log('Skipped: sign-in answers "no email sender is configured" until both are set.');
} else console.log("Sign-in email (Resend) is set");

say("Building the web app");
const web = spawnSync("pnpm", ["--filter", "@hardhub/web", "build"], { stdio: "inherit", env: { ...env, VITE_API_URL: "/api" } });
if (web.status !== 0) process.exit(web.status ?? 1);

say("Deploying");
// secrets travel with the deploy in a file only this user can read, deleted after
const dir = mkdtempSync(join(tmpdir(), "hardhub-"));
const secretsFile = join(dir, "secrets.json");
writeFileSync(secretsFile, JSON.stringify(upload), { mode: 0o600 });
try {
  run(["deploy", ...ENV, ...(Object.keys(upload).length ? ["--secrets-file", secretsFile] : [])]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("\nDone. HardHub is live at the workers.dev address printed above.");
