/**
 * The relay's sealing (src/core/relay.ts) with the browser's Web Crypto, so a phone opens and
 * writes the same boxes as the machines. The space key never leaves the device.
 */

export interface RelayConfig {
  url: string;
  space: string;
  token: string;
  /** the space key, base64url */
  key: string;
}

export interface Keys {
  enc: CryptoKey;
  name: CryptoKey;
}

const CODE_PREFIX = "pwr1.";
const enc = new TextEncoder();
const dec = new TextDecoder();

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Read a join code (`parawatch relay code`). */
export function readJoinCode(code: string): RelayConfig {
  const t = code.trim();
  if (!t.startsWith(CODE_PREFIX)) throw new Error("That is not a Parawatch relay code (it starts with pwr1.)");
  let o: { u?: unknown; s?: unknown; t?: unknown; k?: unknown };
  try {
    o = JSON.parse(dec.decode(fromB64url(t.slice(CODE_PREFIX.length))));
  } catch {
    throw new Error("That relay code is cut short or changed; copy it again");
  }
  if (typeof o.u !== "string" || typeof o.s !== "string" || typeof o.t !== "string" || typeof o.k !== "string") throw new Error("That relay code is missing parts; copy it again");
  if (fromB64url(o.k).length !== 32) throw new Error("The key in that relay code is not 32 bytes");
  return { url: o.u.replace(/\/+$/, ""), space: o.s, token: o.t, key: o.k };
}

export async function keysOf(key: string): Promise<Keys> {
  const raw = fromB64url(key);
  if (raw.length !== 32) throw new Error("The relay key is not 32 bytes; pair again with a fresh code");
  const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits"]);
  const derive = async (info: string) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) }, base, 256));
  const [e, n] = await Promise.all([derive("parawatch relay seal v1"), derive("parawatch relay name v1")]);
  return {
    enc: await crypto.subtle.importKey("raw", e, "AES-GCM", false, ["encrypt", "decrypt"]),
    name: await crypto.subtle.importKey("raw", n, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The name the server knows a path by. */
export async function sealedName(keys: Keys, rel: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", keys.name, enc.encode(rel)))).slice(0, 40);
}

/** One box: version, nonce, tag, then the path and the bytes, encrypted together. */
export async function seal(keys: Keys, rel: string, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const p = enc.encode(rel);
  const plain = new Uint8Array(4 + p.length + data.length);
  new DataView(plain.buffer).setUint32(0, p.length);
  plain.set(p, 4);
  plain.set(data, 4 + p.length);
  // Web Crypto puts the tag after the text; the box keeps it before
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.enc, plain));
  const body = out.subarray(0, out.length - 16);
  const tag = out.subarray(out.length - 16);
  const box = new Uint8Array(1 + 12 + 16 + body.length);
  box[0] = 1;
  box.set(iv, 1);
  box.set(tag, 13);
  box.set(body, 29);
  return box;
}

export async function open(keys: Keys, box: Uint8Array): Promise<{ rel: string; data: Uint8Array }> {
  if (box.length < 29 || box[0] !== 1) throw new Error("not a sealed parawatch file");
  const joined = new Uint8Array(box.length - 13);
  joined.set(box.subarray(29), 0);
  joined.set(box.subarray(13, 29), box.length - 29);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.slice(1, 13) as BufferSource }, keys.enc, joined));
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  return { rel: dec.decode(plain.subarray(4, 4 + n)), data: plain.subarray(4 + n) };
}
