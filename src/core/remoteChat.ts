/**
 * Codex conversations of another machine. The log and the codex command stay on the machine the
 * session ran on (the host); the machine showing it (the viewer) asks through the shared folder:
 *
 *   chats/<viewer>/watching.json   the sessions the viewer has open, rewritten while they are
 *   chats/<viewer>/asks.jsonl      messages to send and stops, written by the viewer only
 *   chats/<host>/<session>.json    the conversation as the host reads it, rewritten as it changes
 *
 * Every file has one writer, so the sync tool never has two versions of one to reconcile.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatState } from "./chatTypes.js";
import { DEVICE_NAME, deviceName, sharedDir } from "./store.js";

/** How often a viewer says it still has its chats open, and when a host stops serving one. */
export const WATCH_EVERY_MS = 20_000;
export const WATCH_GONE_MS = 75_000;
/** How often a host rewrites a watched chat that did not change, and when the viewer gives up on it. */
export const HOST_BEAT_MS = 30_000;
export const HOST_QUIET_MS = 100_000;
/** A message that took longer than this to reach the host is not sent: the person has moved on. */
export const ASK_LATE_MS = 2 * 60_000;
/** How long asks and their results are kept. */
export const ASK_KEEP_MS = 10 * 60_000;
/** The most conversation items a host shares; the rest count as earlier. */
export const SHARED_ITEMS = 150;
/** The first version whose app answers for its Codex sessions. */
export const REMOTE_CHAT_SINCE = "0.3.16";

export interface Watching {
  v: 1;
  device: string;
  at: string;
  open: { host: string; id: string }[];
}

export interface Ask {
  id: string;
  at: string;
  host: string;
  session: string;
  op: "send" | "stop";
  text?: string;
}

/** What a host wrote about one of its sessions. */
export interface Hosted {
  v: 1;
  host: string;
  id: string;
  at: string;
  state: ChatState;
  /** asks handled, by id: null when it went through, the reason when it did not */
  asks: Record<string, { at: string; error: string | null }>;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function validSession(id: string): boolean {
  return SESSION_ID.test(id);
}

function chatsDir(shared = sharedDir()): string | undefined {
  return shared ? path.join(shared, "chats") : undefined;
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The machines with a folder under `chats/`, other than this one. */
function otherDevices(dir: string, me: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => DEVICE_NAME.test(n) && n !== me);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ viewer

/** Say which sessions of other machines this one has open. */
export function writeWatching(open: { host: string; id: string }[], now = Date.now(), shared = sharedDir()): void {
  const dir = chatsDir(shared);
  if (!dir) return;
  const me = deviceName();
  const body: Watching = { v: 1, device: me, at: new Date(now).toISOString(), open };
  try {
    writeAtomic(path.join(dir, me, "watching.json"), JSON.stringify(body) + "\n");
  } catch {
    // the folder may be busy syncing; the next beat writes it again
  }
}

/** Add a message or a stop for a host, dropping asks old enough that no host still needs them. */
export function appendAsk(a: Omit<Ask, "id" | "at">, now = Date.now(), shared = sharedDir()): Ask {
  const dir = chatsDir(shared);
  if (!dir) throw new Error("This machine shares no folder with others.");
  const me = deviceName();
  const ask: Ask = { id: `${me}-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`, at: new Date(now).toISOString(), ...a };
  const file = path.join(dir, me, "asks.jsonl");
  const kept = readAskLines(file).filter((x) => now - Date.parse(x.at) < ASK_KEEP_MS);
  writeAtomic(file, [...kept, ask].map((x) => JSON.stringify(x) + "\n").join(""));
  return ask;
}

/** What the host last wrote about a session, if anything. */
export function readHosted(host: string, id: string, shared = sharedDir()): Hosted | undefined {
  const dir = chatsDir(shared);
  if (!dir || !DEVICE_NAME.test(host) || !validSession(id)) return undefined;
  const h = readJson<Hosted>(path.join(dir, host, `${id}.json`));
  return h && h.v === 1 && h.id === id ? h : undefined;
}

export function hostedPath(host: string, id: string, shared = sharedDir()): string | undefined {
  const dir = chatsDir(shared);
  return dir && DEVICE_NAME.test(host) && validSession(id) ? path.join(dir, host, `${id}.json`) : undefined;
}

// ------------------------------------------------------------------ host

/** The sessions of this machine that another machine has open now, and which machines. */
export function watchedHere(now = Date.now(), shared = sharedDir()): Map<string, string[]> {
  const dir = chatsDir(shared);
  const out = new Map<string, string[]>();
  if (!dir) return out;
  const me = deviceName();
  for (const d of otherDevices(dir, me)) {
    const w = readJson<Watching>(path.join(dir, d, "watching.json"));
    if (!w || !Array.isArray(w.open) || now - Date.parse(w.at) > WATCH_GONE_MS) continue;
    for (const o of w.open) {
      if (o?.host !== me || typeof o.id !== "string" || !validSession(o.id)) continue;
      out.set(o.id, [...(out.get(o.id) ?? []), d]);
    }
  }
  return out;
}

function readAskLines(file: string): Ask[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Ask[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Ask;
      if (typeof a.id === "string" && typeof a.session === "string" && Number.isFinite(Date.parse(a.at)) && (a.op === "send" || a.op === "stop")) out.push(a);
    } catch {
      // a line half written by the sync tool; it is whole next time
    }
  }
  return out;
}

/** Asks other machines left for this one, oldest first. */
export function asksHere(shared = sharedDir()): Ask[] {
  const dir = chatsDir(shared);
  if (!dir) return [];
  const me = deviceName();
  const out: Ask[] = [];
  for (const d of otherDevices(dir, me)) {
    for (const a of readAskLines(path.join(dir, d, "asks.jsonl"))) {
      // an ask names its own machine in its id, so one machine cannot answer for another
      if (a.host === me && a.id.startsWith(`${d}-`) && validSession(a.session)) out.push(a);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The conversation with only its latest items, so the shared file stays small. */
export function slimState(s: ChatState, max = SHARED_ITEMS): ChatState {
  if (!s.view || s.view.items.length <= max) return s;
  const cut = s.view.items.length - max;
  return { ...s, view: { ...s.view, items: s.view.items.slice(cut), earlier: s.view.earlier + cut } };
}

export function writeHosted(h: Omit<Hosted, "v" | "host">, shared = sharedDir()): void {
  const me = deviceName();
  const file = hostedPath(me, h.id, shared);
  if (!file) return;
  const body: Hosted = { v: 1, host: me, ...h, state: slimState(h.state) };
  try {
    writeAtomic(file, JSON.stringify(body) + "\n");
  } catch {
    // the folder may be busy syncing; the next change or beat writes it again
  }
}

export function removeHosted(id: string, shared = sharedDir()): void {
  const file = hostedPath(deviceName(), id, shared);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // gone or busy; nobody reads it once it is not watched
  }
}

/** Asks this machine already handled, read back from what it wrote, so a restart does not send twice. */
export function handledHere(shared = sharedDir()): Map<string, Hosted["asks"]> {
  const dir = chatsDir(shared);
  const out = new Map<string, Hosted["asks"]>();
  if (!dir) return out;
  const mine = path.join(dir, deviceName());
  let names: string[] = [];
  try {
    names = fs.readdirSync(mine);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^(.+)\.json$/.exec(n);
    if (!m || m[1] === "watching" || !validSession(m[1]!)) continue;
    const h = readJson<Hosted>(path.join(mine, n));
    if (h?.asks) out.set(m[1]!, h.asks);
  }
  return out;
}
