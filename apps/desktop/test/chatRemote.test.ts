import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../../../src/core/chatTypes.js";
import { ASK_LATE_MS, HOST_QUIET_MS, readHosted } from "../../../src/core/remoteChat.js";
import type { Run } from "../../../src/core/types.js";
import { ChatHost } from "../src/chatHost.js";
import { RemoteChats } from "../src/chatRemote.js";

/**
 * The machine showing a session (mac) and the one it runs on (winpc), one shared folder between
 * them. Each side runs as its own device; the chat manager on winpc is a fake.
 */
let shared: string;
let now: number;
let allow: boolean;
let sent: { id: string; text: string }[];
let stopped: string[];
let opened: string[];
let sendError: string | undefined;
let pushed: ChatState[];
const as = (device: string) => vi.stubEnv("PARAWATCH_DEVICE", device);
const run: Run = { id: "019a-1", runtime: "codex", kind: "session", state: "idle", device: "winpc", title: "t" } as Run;

const live: ChatState = { sending: false, view: { id: "019a-1", file: "x", settings: { roots: [], model: "gpt-test", sandbox: "read-only" }, working: false, earlier: 0, items: [{ kind: "user", id: "u1", text: "hello" }] } };

function host(): ChatHost {
  return new ChatHost({
    allowSend: () => allow,
    now: () => now,
    chats: {
      openChat: (id: string) => {
        opened.push(id);
        return live;
      },
      closeChat: () => {},
      send: (id: string, text: string) => {
        if (sendError) throw new Error(sendError);
        sent.push({ id, text });
      },
      stop: (id: string) => void stopped.push(id),
    },
  });
}

function viewer(version?: string): RemoteChats {
  return new RemoteChats({ push: (_id, s) => void pushed.push(s), now: () => now, version: () => version });
}

/** Run `fn` as winpc, then go back to being mac. */
function onPc<T>(fn: () => T): T {
  as("winpc");
  try {
    return fn();
  } finally {
    as("mac");
  }
}

beforeEach(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), "pw-rview-"));
  vi.stubEnv("PARAWATCH_SHARED", shared);
  as("mac");
  now = Date.parse("2026-11-14T10:00:00Z");
  allow = true;
  sent = [];
  stopped = [];
  opened = [];
  sendError = undefined;
  pushed = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(shared, { recursive: true, force: true });
});

describe("a Codex session of another machine", () => {
  it("waits for that machine, and says when its Parawatch is too old", () => {
    const v = viewer();
    expect(v.openChat(run)).toMatchObject({ remote: "winpc", waiting: expect.stringContaining("Waiting for winpc"), sending: false });
    v.dispose();
    expect(viewer("0.3.15").openChat(run).waiting).toContain("needs 0.3.16 or later");
  });

  it("shows the conversation the other machine writes back", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    expect(opened).toEqual(["019a-1"]);
    expect(v.state("019a-1")).toMatchObject({ remote: "winpc", view: { items: [{ text: "hello" }] } });
    expect(v.state("019a-1").blocked).toBeUndefined();
  });

  it("sends a message there and shows it on its way until that machine takes it", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    v.send("019a-1", "  list the files ");
    expect(v.state("019a-1")).toMatchObject({ sending: true, live: "Sending to winpc…" });
    onPc(() => h.tick());
    expect(sent).toEqual([{ id: "019a-1", text: "list the files" }]);
    expect(v.state("019a-1").sending).toBe(false);
    // the same ask is not sent again, by this host or by one started after a restart
    onPc(() => h.tick());
    onPc(() => host().tick());
    expect(sent).toHaveLength(1);
  });

  it("does not send when that machine does not take messages from others, and says how to allow it", () => {
    allow = false;
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    expect(v.state("019a-1").blocked).toContain('Turn on "Messages from other machines" in Parawatch settings on winpc');
    expect(() => v.send("019a-1", "hi")).toThrow(/does not take messages/);
    expect(sent).toEqual([]);
  });

  it("shows why that machine could not send it", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    sendError = "This session is open in Codex (the app or a terminal).";
    v.send("019a-1", "hi");
    onPc(() => h.tick());
    expect(v.state("019a-1")).toMatchObject({ sending: false, error: sendError });
  });

  it("drops a message that reached the other machine too late", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    v.send("019a-1", "hi");
    now += ASK_LATE_MS + 1000;
    v.announce(); // the beat that runs every 20 seconds
    onPc(() => h.tick());
    expect(sent).toEqual([]);
    expect(v.state("019a-1").error).toContain("was not sent to Codex");
  });

  it("passes a stop on", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    v.stop("019a-1");
    onPc(() => h.tick());
    expect(stopped).toEqual(["019a-1"]);
  });

  it("says when the other machine stopped answering", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    now += HOST_QUIET_MS + 60_000;
    expect(v.state("019a-1").blocked).toContain("winpc has not answered for 3 min");
  });

  it("stops serving a session once nobody has it open", () => {
    const v = viewer();
    v.openChat(run);
    const h = onPc(host);
    onPc(() => h.tick());
    expect(onPc(() => readHosted("winpc", "019a-1"))).toBeDefined();
    v.closeChat("019a-1");
    onPc(() => h.tick());
    expect(readHosted("winpc", "019a-1")).toBeUndefined();
  });
});
