/**
 * Waking Codex app sessions. Claude Code keeps `parawatch wait` running in the background and wakes
 * when it exits; a Codex session has no such command, so an answer used to wait for its next turn.
 * The Codex app, though, runs a message queued for one of its threads (`codex queue --thread <id>`)
 * by itself as soon as the thread is loaded in the app, even while another thread is on screen.
 *
 * So while the Parawatch app runs, it waits for every Codex session the app has loaded and that has
 * something in parawatch (a claim, a card, a pull request): it holds a wait for it, so its cards
 * say an answer reaches it, and passes what arrives to the thread as a queued message, taking it
 * off the session's inbox the way a wait does. A session that runs a wait of its own is left to it.
 * A thread the app has not loaded keeps the old way: it reads its inbox on its next turn.
 *
 * A thread in the middle of a turn is left alone: the Codex app would run the message only after
 * the turn, and a turn that loops on `parawatch wait --timeout` would lose the news to the queue
 * in the moment between two waits. Its own wait takes the news; what is left when the turn ends
 * goes then. Sub-agent threads are skipped: the Codex app takes no queued messages for them.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { codexSessionsDir } from "../adapters/codex.js";
import { findCodex } from "./codexChat.js";
import { inboxLine } from "./format.js";
import { endedSessions, inboxScope, listeners, sameSession, sessionConsumer, takeInbox, type InboxItem } from "./ops.js";
import type { State } from "./state.js";
import type { Listener } from "./types.js";

/** What the holder calls itself in a card's delivery line. */
export const CODEX_APP = "codex-app";

/** After a queue fails, leave the session alone this long. */
const RETRY_MS = 5 * 60_000;
/** How long a listing of the log folder is good for. */
const LOGS_MS = 60_000;

export interface WakeDeps {
  /** Codex session id → its log file, for the sessions asked about. */
  logs(ids: string[]): Map<string, string>;
  /** Of these log files, the ones the Codex app has loaded. */
  loaded(files: string[]): Set<string>;
  /** What the thread's log says about it: a sub-agent's thread, and whether a turn is running. */
  thread(file: string): ThreadState;
  /** Queue a message for a thread. Rejects when codex refuses. */
  queue(thread: string, text: string): Promise<void>;
  now?: () => number;
}

export interface ThreadState {
  subagent: boolean;
  /** A turn has started and not ended. */
  busy: boolean;
}

export interface Wakeable {
  session: string;
  project?: string;
}

/** The sessions parawatch knows of that could have news: claimed, owning a card, or linked to a pull request. */
export function knownSessions(state: State, ended = endedSessions(state)): Wakeable[] {
  const out = new Map<string, Wakeable>();
  const add = (session: string | undefined) => {
    if (!session || ended(session) || [...out.keys()].some((k) => sameSession(k, session))) return;
    out.set(session, { session });
  };
  for (const c of state.claims) add(c.session);
  for (const c of state.cards.values()) if (c.status !== "closed") add(c.session);
  for (const l of state.prLinks.values()) add(l.session);
  for (const w of out.values()) w.project = state.claims.find((c) => sameSession(c.session, w.session))?.project;
  return [...out.values()];
}

/** The text a thread gets: the same lines `parawatch wait` prints. */
export function wakeMessage(items: InboxItem[]): string {
  return ["parawatch: news for this session (the Parawatch app passes it on, as no `parawatch wait` is running):", ...items.map(inboxLine)].join("\n");
}

export class CodexWaker {
  private busy = new Set<string>();
  private failedAt = new Map<string, number>();

  constructor(
    private deps: WakeDeps,
    private log: (line: string) => void = () => {},
  ) {}

  /**
   * One pass: the waits to hold now, and the deliveries started (resolved when each is queued or
   * has failed). `state` is read again by the inbox; pass the current one.
   */
  tick(state: State): { hold: Omit<Listener, "pid" | "since">[]; sent: Promise<void> } {
    const now = this.deps.now?.() ?? Date.now();
    const known = knownSessions(state);
    if (!known.length) return { hold: [], sent: Promise.resolve() };
    const files = this.deps.logs(known.map((k) => k.session));
    const loaded = this.deps.loaded([...files.values()]);
    const own = listeners().filter((l) => l.via !== CODEX_APP);
    const hold: Omit<Listener, "pid" | "since">[] = [];
    const sends: Promise<void>[] = [];
    for (const k of known) {
      const file = files.get(k.session);
      if (!file || !loaded.has(file)) continue;
      const thread = this.deps.thread(file);
      if (thread.subagent) continue;
      // a session waiting for itself gets its news from that wait
      if (own.some((l) => l.scope === "session" && sameSession(l.session, k.session))) continue;
      hold.push({ consumer: sessionConsumer(k.session), session: k.session, scope: "session", via: CODEX_APP, ...(k.project ? { project: k.project } : {}) });
      if (thread.busy || this.busy.has(k.session) || now - (this.failedAt.get(k.session) ?? -Infinity) < RETRY_MS) continue;
      const { consumer, filter } = inboxScope({}, k.session);
      const { items, undo } = takeInbox(consumer, filter);
      if (!items.length) continue;
      this.busy.add(k.session);
      sends.push(
        this.deps
          .queue(k.session, wakeMessage(items))
          .then(() => {
            this.failedAt.delete(k.session);
            this.log(`passed ${items.length} item(s) to Codex session ${k.session.slice(0, 8)}`);
          })
          .catch((err: unknown) => {
            undo();
            this.failedAt.set(k.session, now);
            this.log(`could not pass news to Codex session ${k.session.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => this.busy.delete(k.session)),
      );
    }
    return { hold, sent: Promise.all(sends).then(() => undefined) };
  }
}

// ---------------------------------------------------------------- this machine

let listing: { at: number; byId: Map<string, string> } | undefined;

/** Codex logs by session id, from the file names (`rollout-<time>-<id>.jsonl`). */
export function codexLogs(ids: string[], now = Date.now()): Map<string, string> {
  if (!listing || now - listing.at > LOGS_MS || ids.some((id) => !listing!.byId.has(id) && looksLikeCodexId(id))) {
    // a session asked about that is not in the listing may have started since; list again, once a minute at most
    if (!listing || now - listing.at > LOGS_MS / 6) listing = { at: now, byId: listLogs(codexSessionsDir()) };
  }
  const out = new Map<string, string>();
  for (const id of ids) {
    const f = listing.byId.get(id);
    if (f) out.set(id, f);
  }
  return out;
}

const looksLikeCodexId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/.test(id);

function listLogs(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (d.isFile()) {
        const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(d.name);
        if (m) out.set(m[1]!, p);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Of these logs, the ones a Codex app server holds open: the threads the Codex app has loaded. A
 * terminal `codex` holds its log open too, but does not run queued messages, so only app servers
 * count. macOS and Linux only.
 */
export function loadedInCodexApp(files: string[], platform: NodeJS.Platform = process.platform): Set<string> {
  const out = new Set<string>();
  if (!files.length || platform === "win32") return out;
  try {
    const pids = execFileSync("pgrep", ["-f", "codex.* app-server"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!pids.length) return out;
    const open = execFileSync("lsof", ["-Fn", "-p", pids.join(",")], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const names = new Set(open.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)));
    for (const f of files) if (names.has(f) || names.has(realPath(f))) out.add(f);
  } catch {
    // pgrep finds nothing (exit 1), or lsof is missing: nothing is loaded as far as we can tell
  }
  return out;
}

function realPath(f: string): string {
  try {
    return fs.realpathSync.native(f);
  } catch {
    return f;
  }
}

const metas = new Map<string, boolean>();
const turns = new Map<string, { size: number; mtime: number; busy: boolean }>();
/** How much of a log's end is read for the last turn event. */
const TAIL = 512 * 1024;

/** A Codex thread from its log: the first line says who started it, the last turn event whether it runs. */
export function codexThread(file: string): ThreadState {
  let subagent = metas.get(file);
  if (subagent === undefined) {
    const meta = firstLine(file);
    if (meta !== undefined) {
      subagent = isSubagent(meta);
      metas.set(file, subagent);
    }
  }
  return { subagent: subagent ?? false, busy: turnRunning(file) };
}

export function isSubagent(line: string): boolean {
  try {
    const p = JSON.parse(line)?.payload;
    return p?.thread_source === "subagent" || !!p?.source?.subagent;
  } catch {
    return false;
  }
}

/**
 * Whether the last turn event in these log lines is a start. With none (a turn that has written a
 * lot since it started), a turn is taken to be running.
 */
export function lastTurnRunning(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!/"(task_started|task_complete|turn_aborted)"/.test(line)) continue;
    let ev: { type?: string; payload?: { type?: string } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const t = ev.type === "event_msg" ? ev.payload?.type : undefined;
    if (t === "task_started") return true;
    if (t === "task_complete" || t === "turn_aborted") return false;
  }
  return true;
}

function turnRunning(file: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  const seen = turns.get(file);
  if (seen && seen.size === st.size && seen.mtime === st.mtimeMs) return seen.busy;
  const start = Math.max(0, st.size - TAIL);
  const buf = readRange(file, start, st.size - start);
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // cut in the middle
  const busy = lastTurnRunning(lines);
  turns.set(file, { size: st.size, mtime: st.mtimeMs, busy });
  return busy;
}

function firstLine(file: string): string | undefined {
  const chunks: Buffer[] = [];
  for (let at = 0; at < 4 * 1024 * 1024; at += 64 * 1024) {
    const b = readRange(file, at, 64 * 1024);
    const nl = b.indexOf(10);
    if (nl >= 0) return Buffer.concat([...chunks, b.subarray(0, nl)]).toString("utf8");
    if (b.length < 64 * 1024) return undefined; // the line is still being written
    chunks.push(b);
  }
  return undefined;
}

function readRange(file: string, start: number, length: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(length);
    const n = fs.readSync(fd, b, 0, length, start);
    return b.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Queue a message for a Codex thread with the codex command. */
export function codexQueue(thread: string, text: string): Promise<void> {
  const bin = findCodex();
  if (!bin) return Promise.reject(new Error("the codex command was not found"));
  return new Promise((resolve, reject) => {
    const child = execFile(bin, ["queue", "--thread", thread, "--message", text], { timeout: 20_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split("\n").pop() || err.message));
      else resolve();
    });
    child.stdin?.end();
  });
}

export const thisMachine: WakeDeps = { logs: (ids) => codexLogs(ids), loaded: (files) => loadedInCodexApp(files), thread: codexThread, queue: codexQueue };
