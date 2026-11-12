import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import { STORE_FORMAT, type EventBody, type PwEvent } from "./types.js";

/** Directory holding all parawatch state for this user on this machine. */
export function homeDir(): string {
  const explicit = process.env.PARAWATCH_HOME;
  if (explicit) return explicit;
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "parawatch");
}

// ------------------------------------------------------------------ config

/** `config.json` in the parawatch home. Every field is optional. */
export interface LocalConfig {
  /** this machine's name in a shared folder */
  device?: string;
  sync?: { dir?: string; adapter?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export function configPath(): string {
  return path.join(homeDir(), "config.json");
}

export function readConfig(): LocalConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as LocalConfig) : {};
  } catch {
    return {};
  }
}

export function writeConfig(c: LocalConfig): void {
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
  fs.renameSync(tmp, configPath());
}

export function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p;
}

export const DEVICE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A device name made from the host name: lower case, letters, digits and dashes. */
export function defaultDevice(host = os.hostname()): string {
  const short = host.split(".")[0] ?? "";
  const clean = short.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return DEVICE_NAME.test(clean) ? clean : "this";
}

/** The name this machine writes under. */
export function deviceName(): string {
  const env = process.env.PARAWATCH_DEVICE?.trim();
  if (env) return env;
  const c = readConfig().device;
  return typeof c === "string" && DEVICE_NAME.test(c) ? c : defaultDevice();
}

/**
 * The shared folder this machine writes its own log into, when set. Something outside parawatch
 * (Syncthing, a cloud folder) carries that folder between machines.
 */
export function sharedDir(): string | undefined {
  const env = process.env.PARAWATCH_SHARED?.trim();
  if (env) return path.resolve(expandHome(env));
  const d = readConfig().sync?.dir;
  return typeof d === "string" && d.trim() ? path.resolve(expandHome(d.trim())) : undefined;
}

// ------------------------------------------------------------------ files

/** Where the event logs live: the home alone, or `events/` in the shared folder. */
export function eventsDir(): string {
  const shared = sharedDir();
  return shared ? path.join(shared, "events") : homeDir();
}

/** The one file this machine appends to. */
export function eventsPath(): string {
  const shared = sharedDir();
  return shared ? path.join(shared, "events", `${deviceName()}.jsonl`) : path.join(homeDir(), "events.jsonl");
}

/** A device log: `<device>.jsonl`. Sync tools' temp and conflict copies never match. */
const DEVICE_FILE = /^([a-z0-9][a-z0-9-]{0,31})\.jsonl$/;

export interface EventFile {
  device: string;
  file: string;
}

/** Every log to read: one per device in a shared folder, or the single local file. */
export function eventFiles(): EventFile[] {
  const shared = sharedDir();
  if (!shared) return [{ device: deviceName(), file: eventsPath() }];
  const dir = path.join(shared, "events");
  const me = deviceName();
  const out: EventFile[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // nothing shared yet
  }
  for (const n of names.sort()) {
    const m = DEVICE_FILE.exec(n);
    if (m) out.push({ device: m[1]!, file: path.join(dir, n) });
  }
  if (!out.some((f) => f.device === me)) out.push({ device: me, file: eventsPath() });
  return out.sort((a, b) => a.device.localeCompare(b.device));
}

/** Where pasted attachments go: inside the shared folder when there is one, so every machine has them. */
export function attachmentsDir(): string {
  return path.join(sharedDir() ?? homeDir(), "attachments");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ------------------------------------------------------------------ lock

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run fn while holding an exclusive lock file. Several agents on this machine may write at once.
 * The lock is local: each machine only ever writes its own log, so machines never share one.
 */
export function withLock<T>(fn: () => T): T {
  ensureDir(homeDir());
  const lock = path.join(homeDir(), "lock");
  const started = Date.now();
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`parawatch: could not take the lock at ${lock}`);
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

// ------------------------------------------------------------------ reading

/** What each log held at its last good reading, for a moment when it cannot be opened. */
const lastRead = new Map<string, PwEvent[]>();

/** Errors a sync tool causes for a moment while it replaces a file (Windows mostly). */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

function readFileEvents(f: EventFile): PwEvent[] {
  let text: string | undefined;
  for (let attempt = 0; text === undefined; attempt++) {
    try {
      text = fs.readFileSync(f.file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return [];
      if (!BUSY.has(code)) throw err;
      // Syncthing and cloud drives write a new copy and rename it over the old one; on Windows the
      // file cannot be opened during the swap. Try again shortly, then go on with the last reading.
      if (attempt < 5) sleepSync(50);
      else return lastRead.get(f.file) ?? [];
    }
  }
  const events = parseEventLines(text, f.device);
  lastRead.set(f.file, events);
  return events;
}

/**
 * Every event, from every machine, in time order. Each machine's own order is kept as written;
 * between machines the clock decides, then the device name, so every machine sees the same order.
 */
export function readEvents(): PwEvent[] {
  const lists = eventFiles().map(readFileEvents).filter((l) => l.length);
  if (lists.length <= 1) return lists[0] ?? [];
  return mergeLogs(lists);
}

/** Merge per-device logs, each already in its own order, into one. */
export function mergeLogs(lists: PwEvent[][]): PwEvent[] {
  const at = lists.map(() => 0);
  const out: PwEvent[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < lists.length; i++) {
      const ev = lists[i]![at[i]!];
      if (!ev) continue;
      if (pick < 0) {
        pick = i;
        continue;
      }
      const best = lists[pick]![at[pick]!]!;
      if (ev.ts < best.ts || (ev.ts === best.ts && (ev.dev ?? "") < (best.dev ?? ""))) pick = i;
    }
    if (pick < 0) return out;
    out.push(lists[pick]![at[pick]!++]!);
  }
}

export function parseEventLines(text: string, device?: string): PwEvent[] {
  const out: PwEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as PwEvent;
      if (typeof ev.seq !== "number" || typeof ev.type !== "string") continue;
      if (device) ev.dev = device;
      out.push(ev);
    } catch {
      // a torn or hand-edited line; keep going
    }
  }
  return out;
}

// ------------------------------------------------------------------ writing

/** Append one event. `build` sees the current events so it can pick ids under the lock. */
export function appendEvent(build: (events: PwEvent[]) => EventBody): PwEvent {
  return withLock(() => appendLocked((events) => [build(events)])[0]!);
}

/** The newest event format in the log. A reader may skip what it does not know; a writer may not. */
export function storeFormat(events: PwEvent[]): number {
  let v = 0;
  for (const e of events) if (typeof e.v === "number" && e.v > v) v = e.v;
  return v;
}

/**
 * The format this machine writes. A log kept on one machine stays at format 1, which every
 * earlier parawatch reads and writes. A shared folder writes format 2.
 */
export function writeFormat(): number {
  return sharedDir() ? 2 : 1;
}

/** Append events while already holding the lock (inside `withLock`). */
export function appendLocked(build: (events: PwEvent[]) => EventBody[]): PwEvent[] {
  const events = readEvents();
  const format = storeFormat(events);
  if (format > STORE_FORMAT) {
    throw new UserError(
      `${eventsDir()} was written by a newer parawatch (format ${format}; this one knows ${STORE_FORMAT}). Update this copy before it writes: npm i -g parawatch@latest, or update the app.`,
    );
  }
  const me = deviceName();
  const own = sharedDir() ? events.filter((e) => e.dev === me) : events;
  let seq = 0;
  for (const e of own) if (e.seq > seq) seq = e.seq;
  const ts = new Date().toISOString();
  const v = writeFormat();
  const out = build(events).map((body) => ({ v, seq: ++seq, ts, ...body }) as PwEvent);
  if (out.length) {
    ensureDir(path.dirname(eventsPath()));
    fs.appendFileSync(eventsPath(), out.map((e) => JSON.stringify(e) + "\n").join(""));
    for (const e of out) e.dev = me;
  }
  return out;
}

// ------------------------------------------------------------------ cursors

/**
 * How far a reader has read: the last seq seen in each device's log. A single-machine log has
 * one entry, for this machine.
 */
export type Position = Record<string, number>;

/** Whether an event comes after a position. */
export function isAfter(ev: PwEvent, pos: Position): boolean {
  return ev.seq > (pos[ev.dev ?? deviceName()] ?? 0);
}

/** A position moved past these events. */
export function advance(pos: Position, events: PwEvent[] | { seq: number; dev?: string }[]): Position {
  const next = { ...pos };
  const me = deviceName();
  for (const e of events) {
    const d = e.dev ?? me;
    if (e.seq > (next[d] ?? 0)) next[d] = e.seq;
  }
  return next;
}

/** The position at the end of these events. */
export function endOf(events: PwEvent[]): Position {
  return advance({}, events);
}

/** A number given on the command line: the same seq in every device's log. */
export function everywhere(seq: number, events: PwEvent[]): Position {
  const pos: Position = { [deviceName()]: seq };
  for (const e of events) if (e.dev) pos[e.dev] = seq;
  return pos;
}

const CURSOR_NAME = /^[A-Za-z0-9._-]+$/;

function cursorPath(name: string): string {
  if (!CURSOR_NAME.test(name)) throw new Error(`parawatch: bad consumer name "${name}"`);
  return path.join(homeDir(), "cursors", `${name}.json`);
}

/**
 * A cursor file holds `seq` (this machine's log, as every version wrote it) and `pos` (every
 * device). Cursors stay on the machine: two machines never share a reader.
 */
export function readCursor(name: string): Position {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(name), "utf8")) as { seq?: number; pos?: Position };
    const me = deviceName();
    const pos: Position = data.pos && typeof data.pos === "object" && sharedDir() ? { ...data.pos } : {};
    if (typeof data.seq === "number" && pos[me] === undefined) pos[me] = data.seq;
    return pos;
  } catch {
    return {};
  }
}

export function writeCursor(name: string, pos: Position): void {
  const file = cursorPath(name);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const seq = pos[deviceName()] ?? 0;
  const body = sharedDir() ? { seq, pos, at: new Date().toISOString() } : { seq, at: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(body) + "\n");
  fs.renameSync(tmp, file);
}
