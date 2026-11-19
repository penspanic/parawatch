// Passing answers and news to Codex sessions loaded in the Codex app.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CODEX_APP, CodexWaker, codexLogs, codexThread, knownSessions, lastTurnRunning, wakeMessage, type WakeDeps } from "../src/core/codexWake.js";
import { answerCard, claimSession, closeCard, holdListeners, inboxScope, listeners, listenersFor, openCard, readInbox, readState, releaseListeners, startListening } from "../src/core/ops.js";
import { freshHome } from "./helpers.js";

const S1 = "019a1f21-4a1e-7f83-ae21-db528da29fd7";
const S2 = "019a1f22-caf8-7f11-a6e0-118ee67d3d41";

/**
 * Codex with these sessions loaded in its app; `fail` makes `codex queue` refuse, `busy` and
 * `subagent` name threads in a turn and threads of sub-agents.
 */
function fakeCodex(loaded: string[], over: { fail?: boolean; busy?: Set<string>; subagent?: string[] } = {}) {
  const sent: { thread: string; text: string }[] = [];
  let now = Date.parse("2026-10-01T09:00:00Z");
  const deps: WakeDeps = {
    logs: (ids) => new Map(ids.map((id) => [id, `/logs/${id}.jsonl`])),
    loaded: (files) => new Set(files.filter((f) => loaded.some((id) => f.includes(id)))),
    thread: (file) => ({ busy: [...(over.busy ?? [])].some((id) => file.includes(id)), subagent: (over.subagent ?? []).some((id) => file.includes(id)) }),
    queue: async (thread, text) => {
      if (over.fail) throw new Error("could not resume thread");
      sent.push({ thread, text });
    },
    now: () => now,
  };
  return { deps, sent, later: (ms: number) => (now += ms) };
}

describe("waking Codex app sessions", () => {
  beforeEach(() => {
    freshHome();
    releaseListeners();
  });

  it("passes an answer to the thread, once, and takes it off the inbox", async () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    const { deps, sent } = fakeCodex([S1]);
    const waker = new CodexWaker(deps);

    let r = waker.tick(readState());
    await r.sent;
    expect(sent).toEqual([]); // nothing answered yet
    expect(r.hold).toEqual([expect.objectContaining({ session: S1, scope: "session", via: CODEX_APP, project: "demo" })]);

    answerCard("c1", { choice: 1, comment: "go" });
    r = waker.tick(readState());
    await r.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.thread).toBe(S1);
    expect(sent[0]!.text).toContain('[demo] c1 "Ship it?" chose 1 (Yes); said: go');

    // the session's own inbox no longer has it, and the next pass sends nothing
    const { consumer, filter } = inboxScope({}, S1);
    expect(readInbox(consumer, filter, false)).toEqual([]);
    await waker.tick(readState()).sent;
    expect(sent).toHaveLength(1);
  });

  it("leaves a thread the Codex app has not loaded to its next turn", async () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    answerCard("c1", { choice: 1 });
    const { deps, sent } = fakeCodex([]);
    const r = new CodexWaker(deps).tick(readState());
    await r.sent;
    expect(sent).toEqual([]);
    expect(r.hold).toEqual([]);
    const { consumer, filter } = inboxScope({}, S1);
    expect(readInbox(consumer, filter, false)).toHaveLength(1);
  });

  it("leaves a session that runs its own wait to that wait", async () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    answerCard("c1", { choice: 1 });
    const stop = startListening({ consumer: "session-x", session: S1, scope: "session", project: "demo" });
    try {
      const { deps, sent } = fakeCodex([S1]);
      const r = new CodexWaker(deps).tick(readState());
      await r.sent;
      expect(sent).toEqual([]);
      expect(r.hold).toEqual([]);
    } finally {
      stop();
    }
  });

  it("puts the news back when codex refuses, and tries again later", async () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    answerCard("c1", { choice: 2 });
    const failing = fakeCodex([S1], { fail: true });
    const logs: string[] = [];
    const waker = new CodexWaker(failing.deps, (l) => logs.push(l));
    await waker.tick(readState()).sent;
    expect(logs.join("\n")).toContain("could not resume thread");
    const { consumer, filter } = inboxScope({}, S1);
    expect(readInbox(consumer, filter, false)).toHaveLength(1);

    // it stops failing; within the pause nothing is tried, after it the answer goes
    let ok = false;
    const sent: string[] = [];
    failing.deps.queue = async (thread) => {
      if (!ok) throw new Error("no");
      sent.push(thread);
    };
    ok = true;
    await waker.tick(readState()).sent;
    expect(sent).toEqual([]);
    failing.later(6 * 60_000);
    await waker.tick(readState()).sent;
    expect(sent).toEqual([S1]);
  });

  it("knows only live sessions with something in parawatch", () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    claimSession({ session: S2, project: "demo", title: "Done one" });
    claimSession({ session: S2, project: "demo", done: "finished" });
    openCard({ kind: "decide", project: "demo", title: "Old", options: ["A", "B"], session: "11111111-2222-7333-8444-555555555555" });
    closeCard("c1");
    expect(knownSessions(readState()).map((k) => k.session)).toEqual([S1]);
  });

  it("holds a wait, so the card says an answer reaches the session", () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    const card = openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    holdListeners([{ consumer: "session-x", session: S1, scope: "session", via: CODEX_APP, project: "demo" }]);
    expect(listenersFor(card, listeners())).toEqual([expect.objectContaining({ via: CODEX_APP, pid: process.pid })]);
    releaseListeners();
    expect(listenersFor(card, listeners())).toEqual([]);
  });

  it("says what it passes the way a wait prints it", () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    answerCard("c1", { choice: 1 });
    const { consumer, filter } = inboxScope({}, S1);
    const text = wakeMessage(readInbox(consumer, filter, false));
    expect(text.split("\n")[0]).toMatch(/^parawatch: news for this session/);
    expect(text.split("\n")[1]).toBe('[demo] c1 "Ship it?" chose 1 (Yes)');
  });

  it("finds Codex logs by the session id in their names", () => {
    const dir = path.join(process.env.PARAWATCH_CODEX_DIR!, "2026", "10", "01");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-10-01T09-00-00-${S1}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    expect(codexLogs([S1, S2], Date.parse("2026-10-01T09:00:00Z"))).toEqual(new Map([[S1, file]]));
  });

  it("leaves a thread in a turn to its own wait, and passes what is left when the turn ends", async () => {
    claimSession({ session: S1, project: "demo", title: "Codex worker" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    answerCard("c1", { choice: 1 });
    const busy = new Set([S1]);
    const { deps, sent } = fakeCodex([S1], { busy });
    const waker = new CodexWaker(deps);
    const r = waker.tick(readState());
    await r.sent;
    expect(sent).toEqual([]);
    expect(r.hold).toHaveLength(1); // the answer still reaches it, when the turn ends
    const { consumer, filter } = inboxScope({}, S1);
    expect(readInbox(consumer, filter, false)).toHaveLength(1);

    busy.clear();
    await waker.tick(readState()).sent;
    expect(sent.map((s) => s.thread)).toEqual([S1]);
  });

  it("skips sub-agent threads, which take no queued messages", async () => {
    claimSession({ session: S1, project: "demo", title: "Codex sub-agent" });
    openCard({ kind: "decide", project: "demo", title: "Ship it?", options: ["Yes", "No"], session: S1 });
    answerCard("c1", { choice: 1 });
    const { deps, sent } = fakeCodex([S1], { subagent: [S1] });
    const r = new CodexWaker(deps).tick(readState());
    await r.sent;
    expect(sent).toEqual([]);
    expect(r.hold).toEqual([]);
  });

  it("reads from a Codex log who started the thread and whether a turn runs", () => {
    const dir = path.join(process.env.PARAWATCH_CODEX_DIR!, "2026", "10", "02");
    fs.mkdirSync(dir, { recursive: true });
    const ev = (type: string) => JSON.stringify({ timestamp: "2026-10-02T09:00:00Z", type: "event_msg", payload: { type } });
    const meta = (extra: object) => JSON.stringify({ type: "session_meta", payload: { id: S2, base_instructions: { text: "x".repeat(100_000) }, ...extra } });
    const main = path.join(dir, `rollout-main-${S1}.jsonl`);
    fs.writeFileSync(main, [meta({ thread_source: "user" }), ev("task_started"), ev("task_complete"), ev("token_count")].join("\n") + "\n");
    expect(codexThread(main)).toEqual({ subagent: false, busy: false });
    fs.appendFileSync(main, ev("task_started") + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", text: "\"task_complete\"" } }) + "\n");
    expect(codexThread(main)).toEqual({ subagent: false, busy: true });

    const sub = path.join(dir, `rollout-sub-${S2}.jsonl`);
    fs.writeFileSync(sub, meta({ thread_source: "subagent", source: { subagent: { thread_spawn: { depth: 1 } } } }) + "\n");
    expect(codexThread(sub).subagent).toBe(true);
  });

  it("takes a turn to run when the end of the log has no turn event", () => {
    expect(lastTurnRunning(['{"type":"response_item"}'])).toBe(true);
    expect(lastTurnRunning(['{"type":"event_msg","payload":{"type":"turn_aborted"}}', '{"type":"event_msg","payload":{"type":"token_count"}}'])).toBe(false);
  });
});
