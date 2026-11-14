/**
 * Codex conversations in the app: the log of each open one is watched and sent to the page as it
 * grows, and a message typed in the app runs `codex exec resume` on that session. The log stays the
 * one record: what Codex answers shows because it is written there.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { cannotSend, findCodex, liveLine, logOpenBy, readChat, resumeArgs, type ChatState } from "../../../src/core/codexChat.js";
import type { Run } from "../../../src/core/types.js";

export interface ChatDeps {
  /** the run behind an id, from the latest snapshot */
  run(id: string): Run | undefined;
  push(id: string, state: ChatState): void;
  spawn?: typeof spawn;
  codex?: () => string | undefined;
  openBy?: (file: string) => number[] | undefined;
}

interface Open {
  file: string;
  watcher?: fs.FSWatcher;
  poll?: NodeJS.Timeout;
  timer?: NodeJS.Timeout;
  mtime: number;
}

interface Sending {
  child: ChildProcess;
  live?: string;
  stopped?: boolean;
}

export class Chats {
  private open = new Map<string, Open>();
  private sending = new Map<string, Sending>();
  private errors = new Map<string, string>();
  constructor(private deps: ChatDeps) {}

  private fileOf(id: string): string {
    const r = this.deps.run(id);
    if (!r) throw new Error("That session is no longer listed.");
    if (r.runtime !== "codex") throw new Error("Only Codex sessions open here.");
    if (r.device) throw new Error(`This session runs on ${r.device}. Its log is there.`);
    if (!r.source) throw new Error("Parawatch does not know where this session's log is.");
    return r.source;
  }

  /** The conversation as it is now, and why a message cannot be sent, if it cannot. */
  state(id: string): ChatState {
    const o = this.open.get(id);
    const file = o?.file ?? this.fileOf(id);
    const s = this.sending.get(id);
    const view = readChat(file);
    // this app has the log open itself, to watch it (kqueue on macOS keeps a descriptor)
    const mine = [process.pid, ...(s?.child.pid ? [s.child.pid] : [])];
    const blocked = s ? undefined : cannotSend(view, (this.deps.openBy ?? logOpenBy)(file), mine);
    const error = this.errors.get(id);
    return { view, ...(blocked ? { blocked } : {}), sending: !!s, ...(s?.live ? { live: s.live } : {}), ...(error ? { error } : {}) };
  }

  openChat(id: string): ChatState {
    if (!this.open.has(id)) {
      const file = this.fileOf(id);
      const o: Open = { file, mtime: 0 };
      try {
        o.watcher = fs.watch(file, () => this.changed(id));
      } catch {
        // some file systems cannot be watched; the poll below covers them
      }
      // fs.watch can miss writes and stops at a rename; a cheap look every two seconds catches up
      o.poll = setInterval(() => {
        try {
          const m = fs.statSync(file).mtimeMs;
          if (m !== o.mtime) this.changed(id);
        } catch {
          // the log went away; nothing to show
        }
      }, 2000);
      this.open.set(id, o);
    }
    return this.state(id);
  }

  closeChat(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    o.watcher?.close();
    if (o.poll) clearInterval(o.poll);
    if (o.timer) clearTimeout(o.timer);
    this.open.delete(id);
  }

  private changed(id: string): void {
    const o = this.open.get(id);
    if (!o || o.timer) return;
    o.timer = setTimeout(() => {
      o.timer = undefined;
      this.emit(id);
    }, 200);
  }

  private emit(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    try {
      o.mtime = fs.statSync(o.file).mtimeMs;
      this.deps.push(id, this.state(id));
    } catch (err) {
      this.deps.push(id, { sending: this.sending.has(id), error: (err as Error).message });
    }
  }

  send(id: string, text: string): void {
    const message = text.trim();
    if (!message) return;
    if (this.sending.has(id)) throw new Error("A message is already being answered.");
    const st = this.state(id);
    if (st.blocked) throw new Error(st.blocked);
    const view = st.view!;
    const bin = (this.deps.codex ?? findCodex)();
    if (!bin) throw new Error("Parawatch could not find the codex command. Install Codex, or set PARAWATCH_CODEX_BIN to its path.");
    const args = resumeArgs(view.id, view.settings);
    const cwd = view.settings.cwd && fs.existsSync(view.settings.cwd) ? view.settings.cwd : undefined;
    const child = (this.deps.spawn ?? spawn)(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" && /\.cmd$/i.test(bin) });
    const s: Sending = { child };
    this.sending.set(id, s);
    this.errors.delete(id);
    let rest = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      const lines = (rest + d.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) {
        const live = liveLine(l);
        if (live) {
          s.live = live;
          this.emit(id);
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4000);
    });
    const done = (code: number | null, err?: Error) => {
      if (this.sending.get(id) !== s) return;
      this.sending.delete(id);
      if (err) this.errors.set(id, `Could not run codex: ${err.message}`);
      else if (code !== 0 && !s.stopped) this.errors.set(id, lastLines(stderr) || `codex stopped with exit code ${code}`);
      this.emit(id);
    };
    child.on("error", (err) => done(null, err));
    child.on("close", (code) => done(code));
    child.stdin?.end(message);
    this.emit(id);
  }

  stop(id: string): void {
    const s = this.sending.get(id);
    if (!s) return;
    s.stopped = true;
    s.child.kill("SIGINT");
    // a Codex that ignores the interrupt is ended after a moment
    setTimeout(() => {
      if (this.sending.get(id) === s) s.child.kill("SIGTERM");
    }, 5000).unref?.();
  }

  /** Stop watching everything; messages being answered keep running to the end. */
  dispose(): void {
    for (const id of [...this.open.keys()]) this.closeChat(id);
  }
}

function lastLines(s: string): string {
  return s
    .trim()
    .split("\n")
    .filter((l) => l.trim() && !/^Reading (additional )?(input|prompt) from stdin/i.test(l))
    .slice(-3)
    .join("\n");
}
