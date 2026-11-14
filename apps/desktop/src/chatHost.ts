/**
 * Answering for this machine's Codex sessions when another machine has one open. The other machine
 * says what it watches and what to send through the shared folder (see core/remoteChat.ts); this
 * side reads the log, runs codex, and writes the conversation back. Sending needs the setting on
 * this machine; showing does not.
 */
import { ASK_KEEP_MS, ASK_LATE_MS, HOST_BEAT_MS, asksHere, handledHere, removeHosted, watchedHere, writeHosted, type Ask, type Hosted } from "../../../src/core/remoteChat.js";
import type { ChatState } from "../../../src/core/codexChat.js";
import { deviceName } from "../../../src/core/store.js";
import type { Chats } from "./chat.js";

/** The owner name other machines' chats use in the chat manager. */
export const REMOTE_OWNER = "remote";

export interface HostDeps {
  chats: Pick<Chats, "openChat" | "closeChat" | "send" | "stop">;
  /** whether other machines may send messages, not only look */
  allowSend(): boolean;
  now?: () => number;
}

interface Served {
  asks: Hosted["asks"];
  last: ChatState;
  wrote: number;
  timer?: NodeJS.Timeout;
}

export class ChatHost {
  private served = new Map<string, Served>();
  private handled = new Set<string>();
  /** results of asks from before a restart, by session, until the session is served again */
  private recovered: Map<string, Hosted["asks"]>;
  constructor(private deps: HostDeps) {
    this.recovered = handledHere();
    for (const asks of this.recovered.values()) for (const id of Object.keys(asks)) this.handled.add(id);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Look at what other machines watch and ask for; cheap enough to run every second or two. */
  tick(): void {
    const now = this.now();
    const watched = watchedHere(now);
    for (const id of watched.keys()) if (!this.served.has(id)) this.serve(id);
    for (const id of [...this.served.keys()]) if (!watched.has(id)) this.unserve(id);
    for (const a of asksHere()) if (!this.handled.has(a.id)) this.handle(a, now);
    for (const [id, s] of this.served) if (now - s.wrote >= HOST_BEAT_MS) this.write(id);
  }

  /** The chat manager says a conversation another machine watches changed. */
  pushed(id: string, state: ChatState): void {
    const s = this.served.get(id);
    if (!s) return;
    s.last = state;
    if (s.timer) return;
    // a busy answer changes many times a second; the sync tool is happier with fewer writes
    s.timer = setTimeout(() => {
      s.timer = undefined;
      this.write(id);
    }, 300);
  }

  private serve(id: string): void {
    const s: Served = { asks: this.recovered.get(id) ?? {}, last: { sending: false }, wrote: 0 };
    this.recovered.delete(id);
    this.served.set(id, s);
    try {
      s.last = this.deps.chats.openChat(id, REMOTE_OWNER);
    } catch (err) {
      s.last = { sending: false, error: (err as Error).message };
    }
    this.write(id);
  }

  private unserve(id: string): void {
    const s = this.served.get(id);
    if (s?.timer) clearTimeout(s.timer);
    this.served.delete(id);
    this.deps.chats.closeChat(id, REMOTE_OWNER);
    removeHosted(id);
  }

  private handle(a: Ask, now: number): void {
    this.handled.add(a.id);
    const me = deviceName();
    let error: string | null = null;
    const late = now - Date.parse(a.at);
    if (late > ASK_LATE_MS) {
      error = a.op === "send" ? `This reached ${me} ${Math.round(late / 60_000)} min after it was sent, so it was not sent to Codex.` : null;
    } else if (a.op === "stop") {
      this.deps.chats.stop(a.session);
    } else if (!this.deps.allowSend()) {
      error = notAllowed(me);
    } else {
      try {
        this.deps.chats.send(a.session, a.text ?? "");
      } catch (err) {
        error = (err as Error).message;
      }
    }
    const s = this.served.get(a.session);
    if (!s) return; // nobody watches it any more, so nobody reads the result
    for (const [k, v] of Object.entries(s.asks)) if (now - Date.parse(v.at) > ASK_KEEP_MS) delete s.asks[k];
    s.asks[a.id] = { at: a.at, error };
    this.write(a.session);
  }

  private write(id: string): void {
    const s = this.served.get(id);
    if (!s) return;
    const now = this.now();
    let state = s.last;
    if (!this.deps.allowSend() && !state.blocked && state.view) state = { ...state, blocked: notAllowed(deviceName()) };
    writeHosted({ id, at: new Date(now).toISOString(), state, asks: s.asks });
    s.wrote = now;
  }

  /** Stop serving everything and take the conversations out of the shared folder. */
  dispose(): void {
    for (const id of [...this.served.keys()]) this.unserve(id);
  }
}

function notAllowed(me: string): string {
  return `${me} does not take messages from other machines. Turn on "Messages from other machines" in Parawatch settings on ${me}.`;
}
