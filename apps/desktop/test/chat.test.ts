import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chats } from "../src/chat.js";
import type { ChatState } from "../../../src/core/chatTypes.js";
import type { Run } from "../../../src/core/types.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const T = "2026-11-14T03:00:00.000Z";
const head = [
  { timestamp: T, type: "session_meta", payload: { id: "019a-1", cwd: os.tmpdir(), originator: "codex_exec" } },
  { timestamp: T, type: "turn_context", payload: { cwd: os.tmpdir(), model: "gpt-test", sandbox_policy: { type: "read-only" } } },
  { timestamp: T, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "hello" }] } } },
];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  input = "";
  signals: string[] = [];
  stdin = { end: (s: string) => (this.input = s) };
  kill(sig: string) {
    this.signals.push(sig);
    return true;
  }
}

let dir: string;
let file: string;
let pushed: ChatState[];
let child: FakeChild;
let spawned: { bin: string; args: string[]; opts: { cwd?: string } }[];
let runs: Run[];
let openBy: number[];

function chats() {
  return new Chats({
    run: (id) => runs.find((r) => r.id === id),
    push: (_id, s) => pushed.push(s),
    codex: () => "/bin/codex",
    openBy: () => openBy,
    spawn: ((bin: string, args: string[], opts: { cwd?: string }) => {
      spawned.push({ bin, args, opts });
      child = new FakeChild();
      return child;
    }) as never,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 350));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-chats-"));
  file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, head.map(line).join(""));
  pushed = [];
  spawned = [];
  openBy = [];
  runs = [{ id: "019a-1", runtime: "codex", kind: "exec", title: "hello", state: "done", source: file }];
});

afterEach(() => vi.useRealTimers());

describe("chats in the app", () => {
  it("keeps watching a conversation while this window or another machine still has it open", () => {
    const c = chats();
    c.openChat("019a-1");
    c.openChat("019a-1", "remote");
    c.closeChat("019a-1");
    expect(c.isOpen("019a-1")).toBe(false);
    expect(c.isOpen("019a-1", "remote")).toBe(true);
    c.closeChat("019a-1", "remote");
    expect(c.isOpen("019a-1", "remote")).toBe(false);
    c.dispose();
  });

  it("opens a Codex run's log as a conversation that can take a message", () => {
    const c = chats();
    const s = c.openChat("019a-1");
    expect(s.view?.items).toMatchObject([{ kind: "user", text: "hello" }]);
    expect(s).toMatchObject({ sending: false });
    expect(s.blocked).toBeUndefined();
    c.dispose();
  });

  it("sends a message through codex exec resume, shows what Codex starts, then what it wrote", async () => {
    const c = chats();
    c.openChat("019a-1");
    c.send("019a-1", "  and then?  ");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.bin).toBe("/bin/codex");
    expect(spawned[0]!.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(spawned[0]!.args).toContain('sandbox_mode="read-only"');
    expect(spawned[0]!.args.slice(-2)).toEqual(["019a-1", "-"]);
    expect(spawned[0]!.opts.cwd).toBe(os.tmpdir());
    expect(child.input).toBe("and then?");
    expect(pushed.at(-1)).toMatchObject({ sending: true });
    expect(() => c.send("019a-1", "again")).toThrow(/already/);

    child.stdout.emit("data", Buffer.from('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}\n'));
    expect(pushed.at(-1)).toMatchObject({ sending: true, live: "Running ls" });

    fs.appendFileSync(file, line({ timestamp: T, type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "done" }] } } }));
    child.emit("close", 0);
    const last = pushed.at(-1)!;
    expect(last.sending).toBe(false);
    expect(last.error).toBeUndefined();
    expect(last.view?.items.map((i) => i.kind)).toEqual(["user", "agent"]);
    c.dispose();
  });

  it("a codex that fails says why, from the end of what it printed", () => {
    const c = chats();
    c.openChat("019a-1");
    c.send("019a-1", "go");
    child.stderr.emit("data", Buffer.from("Reading prompt from stdin...\nError: model not supported\n"));
    child.emit("close", 1);
    expect(pushed.at(-1)).toMatchObject({ sending: false, error: "Error: model not supported" });
    // it stays until the next message
    expect(c.state("019a-1").error).toBe("Error: model not supported");
    c.dispose();
  });

  it("Stop interrupts it, and an interrupted message is not an error", () => {
    vi.useFakeTimers();
    const c = chats();
    c.openChat("019a-1");
    c.send("019a-1", "go");
    c.stop("019a-1");
    expect(child.signals).toEqual(["SIGINT"]);
    vi.advanceTimersByTime(5000);
    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    child.emit("close", 130);
    expect(pushed.at(-1)).toMatchObject({ sending: false });
    expect(pushed.at(-1)!.error).toBeUndefined();
    c.dispose();
  });

  it("a stopped codex that ended without saying so in the log does not leave the session working", () => {
    const c = chats();
    c.openChat("019a-1");
    c.send("019a-1", "go");
    fs.appendFileSync(file, line({ timestamp: "2026-11-14T03:01:00.000Z", type: "event_msg", payload: { type: "task_started" } }));
    expect(c.state("019a-1").view?.working).toBe(true);
    c.stop("019a-1");
    // on Windows the process just ends, and the log never gets its task_complete
    child.emit("close", 1);
    const s = c.state("019a-1");
    expect(s.view?.working).toBe(false);
    expect(s.view?.items.at(-1)).toMatchObject({ kind: "note", text: "Stopped" });
    expect(s.blocked).toBeUndefined();
    // a new turn in the log counts again
    fs.appendFileSync(file, line({ timestamp: "2026-11-14T03:02:00.000Z", type: "event_msg", payload: { type: "task_started" } }));
    expect(c.state("019a-1").view?.working).toBe(true);
    c.dispose();
  });

  it("its own watch on the log does not count as the session being open elsewhere", () => {
    openBy = [process.pid];
    const c = chats();
    expect(c.openChat("019a-1").blocked).toBeUndefined();
    c.dispose();
  });

  it("will not send while the session is open in Codex elsewhere", () => {
    openBy = [999];
    const c = chats();
    expect(c.openChat("019a-1").blocked).toMatch(/open in Codex/);
    expect(() => c.send("019a-1", "go")).toThrow(/open in Codex/);
    expect(spawned).toHaveLength(0);
    c.dispose();
  });

  it("only this machine's Codex runs open", () => {
    runs.push({ id: "pc", runtime: "codex", kind: "exec", title: "x", state: "done", source: file, device: "winpc" });
    runs.push({ id: "cc", runtime: "claude-code", kind: "session", title: "x", state: "idle", source: file });
    const c = chats();
    expect(() => c.openChat("gone")).toThrow(/no longer listed/);
    expect(() => c.openChat("pc")).toThrow(/runs on winpc/);
    expect(() => c.openChat("cc")).toThrow(/Only Codex/);
  });

  it("pushes the conversation again when its log grows", async () => {
    const c = chats();
    c.openChat("019a-1");
    fs.appendFileSync(file, line({ timestamp: T, type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "a9", content: [{ type: "Text", text: "from elsewhere" }] } } }));
    await settle();
    await vi.waitFor(() => expect(pushed.at(-1)?.view?.items.at(-1)).toMatchObject({ text: "from elsewhere" }), { timeout: 3000 });
    c.dispose();
  });
});
