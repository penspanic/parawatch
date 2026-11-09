import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION, type EventBody, type PwEvent } from "./types.js";

/** Directory holding all parawatch state for this user. */
export function homeDir(): string {
  const explicit = process.env.PARAWATCH_HOME;
  if (explicit) return explicit;
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "parawatch");
}

export function eventsPath(): string {
  return path.join(homeDir(), "events.jsonl");
}

function ensureHome(): void {
  fs.mkdirSync(homeDir(), { recursive: true });
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run fn while holding an exclusive lock file. Several agents may write at once. */
export function withLock<T>(fn: () => T): T {
  ensureHome();
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

/** Parse every event line. Broken lines are skipped, not fatal. */
export function readEvents(): PwEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(eventsPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseEventLines(text);
}

export function parseEventLines(text: string): PwEvent[] {
  const out: PwEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as PwEvent;
      if (typeof ev.seq === "number" && typeof ev.type === "string") out.push(ev);
    } catch {
      // a torn or hand-edited line; keep going
    }
  }
  return out;
}

/** Append one event. `build` sees the current events so it can pick ids under the lock. */
export function appendEvent(build: (events: PwEvent[]) => EventBody): PwEvent {
  return withLock(() => appendLocked((events) => [build(events)])[0]!);
}

/** Append events while already holding the lock (inside `withLock`). */
export function appendLocked(build: (events: PwEvent[]) => EventBody[]): PwEvent[] {
  const events = readEvents();
  let seq = events[events.length - 1]?.seq ?? 0;
  const ts = new Date().toISOString();
  const out = build(events).map((body) => ({ v: SCHEMA_VERSION, seq: ++seq, ts, ...body }) as PwEvent);
  if (out.length) fs.appendFileSync(eventsPath(), out.map((e) => JSON.stringify(e) + "\n").join(""));
  return out;
}

const CURSOR_NAME = /^[A-Za-z0-9._-]+$/;

function cursorPath(name: string): string {
  if (!CURSOR_NAME.test(name)) throw new Error(`parawatch: bad consumer name "${name}"`);
  return path.join(homeDir(), "cursors", `${name}.json`);
}

export function readCursor(name: string): number {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(name), "utf8")) as { seq?: number };
    return typeof data.seq === "number" ? data.seq : 0;
  } catch {
    return 0;
  }
}

export function writeCursor(name: string, seq: number): void {
  const file = cursorPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ seq, at: new Date().toISOString() }) + "\n");
  fs.renameSync(tmp, file);
}
