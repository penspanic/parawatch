import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../src/core/chatTypes.js";
import {
  ASK_KEEP_MS,
  WATCH_GONE_MS,
  appendAsk,
  asksHere,
  handledHere,
  readHosted,
  removeHosted,
  slimState,
  watchedHere,
  writeHosted,
  writeWatching,
} from "../src/core/remoteChat.js";

let shared: string;
const NOW = Date.parse("2026-11-14T10:00:00Z");
const as = (device: string) => vi.stubEnv("PARAWATCH_DEVICE", device);

beforeEach(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), "pw-rchat-"));
  vi.stubEnv("PARAWATCH_SHARED", shared);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(shared, { recursive: true, force: true });
});

const state = (n: number): ChatState => ({
  sending: false,
  view: { id: "s1", file: "x", settings: { roots: [] }, working: false, earlier: 2, items: Array.from({ length: n }, (_, i) => ({ kind: "agent" as const, id: `a${i}`, text: `t${i}` })) },
});

describe("sessions of another machine, through the shared folder", () => {
  it("tells a host which of its sessions another machine has open, until that machine goes quiet", () => {
    as("mac");
    writeWatching([{ host: "winpc", id: "s1" }, { host: "other", id: "s2" }], NOW);
    as("winpc");
    expect([...watchedHere(NOW)]).toEqual([["s1", ["mac"]]]);
    expect(watchedHere(NOW + WATCH_GONE_MS + 1).size).toBe(0);
  });

  it("does not take its own watching file or a bad session id", () => {
    as("winpc");
    writeWatching([{ host: "winpc", id: "s1" }], NOW);
    expect(watchedHere(NOW).size).toBe(0);
    as("mac");
    writeWatching([{ host: "winpc", id: "../x" }], NOW);
    as("winpc");
    expect(watchedHere(NOW).size).toBe(0);
  });

  it("hands a host only the asks meant for it, and drops old ones when adding", () => {
    as("mac");
    appendAsk({ host: "winpc", session: "s1", op: "send", text: "old" }, NOW - ASK_KEEP_MS - 1);
    const a = appendAsk({ host: "winpc", session: "s1", op: "send", text: "hi" }, NOW);
    appendAsk({ host: "other", session: "s1", op: "stop" }, NOW);
    expect(fs.readFileSync(path.join(shared, "chats", "mac", "asks.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    as("winpc");
    expect(asksHere().map((x) => [x.id, x.text])).toEqual([[a.id, "hi"]]);
  });

  it("ignores an ask whose id names another machine than the folder it is in", () => {
    fs.mkdirSync(path.join(shared, "chats", "mac"), { recursive: true });
    const forged = { id: "laptop-1-aa", at: new Date(NOW).toISOString(), host: "winpc", session: "s1", op: "send", text: "x" };
    fs.writeFileSync(path.join(shared, "chats", "mac", "asks.jsonl"), JSON.stringify(forged) + "\n{half");
    as("winpc");
    expect(asksHere()).toEqual([]);
  });

  it("writes the latest part of a conversation and reads it back with what became of each ask", () => {
    as("winpc");
    writeHosted({ id: "s1", at: new Date(NOW).toISOString(), state: state(200), asks: { "mac-1-aa": { at: new Date(NOW).toISOString(), error: null } } });
    const h = readHosted("winpc", "s1")!;
    expect(h.host).toBe("winpc");
    expect(h.state.view!.items).toHaveLength(150);
    expect(h.state.view!.items[0]!.id).toBe("a50");
    expect(h.state.view!.earlier).toBe(52);
    expect([...handledHere().keys()]).toEqual(["s1"]);
    removeHosted("s1");
    expect(readHosted("winpc", "s1")).toBeUndefined();
  });

  it("leaves a short conversation as it is", () => {
    const s = state(3);
    expect(slimState(s)).toBe(s);
  });
});
