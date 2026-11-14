/**
 * Showing a Codex session of another machine. Its log and codex are there; this side says it has
 * the session open, reads what that machine writes back, and leaves messages for it to send
 * (see core/remoteChat.ts).
 */
import fs from "node:fs";
import type { ChatState } from "../../../src/core/codexChat.js";
import { ASK_LATE_MS, HOST_QUIET_MS, REMOTE_CHAT_SINCE, WATCH_EVERY_MS, appendAsk, hostedPath, readHosted, validSession, writeWatching } from "../../../src/core/remoteChat.js";
import { compareVersions } from "../../../src/core/semver.js";
import type { Run } from "../../../src/core/types.js";

export interface RemoteDeps {
  push(id: string, state: ChatState): void;
  /** the Parawatch version a machine last said it runs */
  version?(device: string): string | undefined;
  now?: () => number;
}

interface Open {
  host: string;
  mtime: number;
  /** the last message or stop sent from here, until the other machine says what became of it */
  pending?: { ask: string; at: number; op: "send" | "stop" };
  error?: string;
  quiet?: boolean;
}

/** How often the conversation file is looked at. */
const LOOK_MS = 1000;

export class RemoteChats {
  private open = new Map<string, Open>();
  private look?: NodeJS.Timeout;
  private beat?: NodeJS.Timeout;
  constructor(private deps: RemoteDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  has(id: string): boolean {
    return this.open.has(id);
  }

  openChat(run: Run): ChatState {
    if (!run.device) throw new Error("That session runs on this machine.");
    if (run.runtime !== "codex") throw new Error("Only Codex sessions open here.");
    if (!validSession(run.id)) throw new Error("Parawatch cannot ask for a session with that id.");
    if (!this.open.has(run.id)) {
      this.open.set(run.id, { host: run.device, mtime: 0 });
      this.announce();
      this.timers();
    }
    return this.state(run.id);
  }

  closeChat(id: string): void {
    if (!this.open.delete(id)) return;
    this.announce();
    this.timers();
  }

  state(id: string): ChatState {
    const o = this.open.get(id);
    if (!o) throw new Error("That conversation is not open.");
    const host = o.host;
    const now = this.now();
    const h = readHosted(host, id);
    if (o.pending && h?.asks[o.pending.ask]) {
      const r = h.asks[o.pending.ask]!;
      if (r.error) o.error = r.error;
      o.pending = undefined;
    }
    if (o.pending && now - o.pending.at > ASK_LATE_MS + 30_000) {
      o.error = `${host} did not pick up the ${o.pending.op === "send" ? "message" : "stop"}.`;
      o.pending = undefined;
    }
    if (!h) {
      const waiting = this.waitingFor(host);
      return { sending: !!o.pending, remote: host, waiting, blocked: waiting, ...(o.error ? { error: o.error } : {}) };
    }
    let st: ChatState = { ...h.state, remote: host };
    const age = now - Date.parse(h.at);
    if (age > HOST_QUIET_MS) {
      return { ...st, sending: false, live: undefined, blocked: `${host} has not answered for ${Math.max(1, Math.round(age / 60_000))} min. Its Parawatch app may be closed or asleep.`, ...(o.error ? { error: o.error } : {}) };
    }
    if (o.pending?.op === "send" && !st.sending) st = { ...st, sending: true, live: `Sending to ${host}…`, blocked: undefined };
    const error = o.error ?? st.error;
    return { ...st, ...(error ? { error } : {}) };
  }

  private waitingFor(host: string): string {
    const v = this.deps.version?.(host);
    if (v && compareVersions(v, REMOTE_CHAT_SINCE) < 0) return `${host} runs Parawatch ${v}. Opening its sessions here needs ${REMOTE_CHAT_SINCE} or later there.`;
    return `Waiting for ${host}. Its Parawatch app reads the session there, so it has to be running.`;
  }

  send(id: string, text: string): void {
    const message = text.trim();
    if (!message) return;
    const o = this.open.get(id);
    if (!o) throw new Error("That conversation is not open.");
    const st = this.state(id);
    if (st.sending) throw new Error("A message is already being answered.");
    if (st.blocked) throw new Error(st.blocked);
    const ask = appendAsk({ host: o.host, session: id, op: "send", text: message }, this.now());
    o.pending = { ask: ask.id, at: this.now(), op: "send" };
    o.error = undefined;
    this.emit(id);
  }

  stop(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    const ask = appendAsk({ host: o.host, session: id, op: "stop" }, this.now());
    o.pending = { ask: ask.id, at: this.now(), op: "stop" };
    this.emit(id);
  }

  private emit(id: string): void {
    try {
      this.deps.push(id, this.state(id));
    } catch {
      // closed meanwhile
    }
  }

  /** Tell the other machines which of their sessions are open here; repeated while any is. */
  announce(): void {
    writeWatching(
      [...this.open].map(([id, o]) => ({ host: o.host, id })),
      this.now(),
    );
  }

  private timers(): void {
    if (this.open.size && !this.look) {
      this.look = setInterval(() => this.lookAll(), LOOK_MS);
      this.beat = setInterval(() => this.announce(), WATCH_EVERY_MS);
    } else if (!this.open.size && this.look) {
      clearInterval(this.look);
      clearInterval(this.beat);
      this.look = this.beat = undefined;
    }
  }

  /** Push a conversation when its file changed, when a message is on its way, or when it went quiet. */
  lookAll(): void {
    const now = this.now();
    for (const [id, o] of this.open) {
      const file = hostedPath(o.host, id);
      let m = 0;
      try {
        m = file ? fs.statSync(file).mtimeMs : 0;
      } catch {
        // not written yet
      }
      const quiet = !!m && now - m > HOST_QUIET_MS;
      if (m !== o.mtime || o.pending || quiet !== !!o.quiet) {
        o.mtime = m;
        o.quiet = quiet;
        this.emit(id);
      }
    }
  }

  dispose(): void {
    this.open.clear();
    this.announce();
    this.timers();
  }
}
