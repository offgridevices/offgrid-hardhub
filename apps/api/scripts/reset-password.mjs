// Sets a new password for an account: there is no email to reset it with.
// Signs that account out everywhere, disconnects its AI apps, and clears
// its sign-in attempts.
//
//   node scripts/reset-password.mjs --local   this computer's HardHub (inside the api container: ./hardhub reset-password)
//   node scripts/reset-password.mjs --live    the Cloudflare deployment (./hardhub reset-password --live)
//
// The hash is made here, in the format src/crypto.ts reads; the password is
// never sent anywhere, and never put on a command line.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const where = process.argv[2];
if (where !== "--local" && where !== "--live") {
  console.error("Usage: node scripts/reset-password.mjs --local | --live");
  process.exit(2);
}
// the database names in wrangler.jsonc: local dev, and the production env
const target =
  where === "--live"
    ? ["offgrid-hardhub-db", "--remote", "--env", "production"]
    : ["hardhub", "--local", "--persist-to", process.env.HH_STATE || ".wrangler/state"];

const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const d1 = (sql) =>
  JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", ...target, "--json", "--command", sql], { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] }));

// one reader for every question, so answers piped in are not lost between them
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
const write = rl._writeToOutput?.bind(rl);
// hidden answers: the question shows, typed characters do not
if (write) rl._writeToOutput = (s) => (muted ? undefined : write(s));
const lines = rl[Symbol.asyncIterator]();
async function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write("\n");
  return done ? "" : value;
}

const b64url = (b) => b.toString("base64url");
const ITERATIONS = 100_000;

const email = (await ask("Email of the account: ")).trim().toLowerCase();
// checked strictly, since it goes into the SQL below
if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
  console.error("That is not an email address.");
  rl.close();
  process.exit(1);
}
const found = d1(`SELECT id FROM users WHERE email = '${email}'`)[0]?.results ?? [];
if (!found.length) {
  console.error(`No account with the email ${email} ${where === "--live" ? "on the live site" : "on this computer"}.`);
  rl.close();
  process.exit(1);
}
const password = await ask("New password (at least 8 characters): ", true);
if (password.length < 8 || password.length > 200) {
  console.error("Use 8 to 200 characters.");
  rl.close();
  process.exit(1);
}
if ((await ask("The same password again: ", true)) !== password) {
  console.error("The two passwords are not the same. Nothing changed.");
  rl.close();
  process.exit(1);
}
const salt = randomBytes(16);
const hash = `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256"))}`;
d1(
  `UPDATE users SET password_hash = '${hash}' WHERE email = '${email}'; ` +
    `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = '${email}'); ` +
    // connected AI apps too: their renewal tokens and unused sign-in codes
    `DELETE FROM oauth_grants WHERE user_id = (SELECT id FROM users WHERE email = '${email}'); ` +
    `DELETE FROM oauth_codes WHERE user_id = (SELECT id FROM users WHERE email = '${email}'); ` +
    `DELETE FROM login_failures WHERE substr(key, 1, ${email.length + 1}) = '${email}|';`,
);
rl.close();
console.log(`Done. ${email} has a new password, is signed out everywhere, and its AI apps are disconnected.`);
