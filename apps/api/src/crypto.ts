// Tokens, hashes and the encryption of the person's own API keys.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 32 random bytes, URL-safe: session tokens and sign-in links */
export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** short random id for users and projects */
export function newId(prefix: string): string {
  return prefix + "_" + b64url(crypto.getRandomValues(new Uint8Array(12)));
}

/** tokens are stored only as their SHA-256, so a leaked table signs nobody in */
export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM; the user id is bound in as associated data, so a row copied
 * to another user does not decrypt */
export async function encryptSecret(secret: string, plaintext: string, userId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(userId) },
    await aesKey(secret),
    enc.encode(plaintext),
  );
  return { ciphertext: b64(ct), iv: b64(iv) };
}

export async function decryptSecret(secret: string, ciphertext: string, iv: string, userId: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(userId) },
    await aesKey(secret),
    unb64(ciphertext),
  );
  return dec.decode(pt);
}
