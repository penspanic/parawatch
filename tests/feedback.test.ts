// Explicit claims, turn endings, pull requests, waits and digests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readClaudeTail, scanWork } from "../src/adapters/claudeCode.js";
import { digest, localDate } from "../src/core/digest.js";
import { resolveGoto } from "../src/core/desktop.js";
import { changesBetween, nextCache, parsePrRef, prViews, readCache, syncGithub, waitingOn, type GhRunner, type PrStatus } from "../src/core/github.js";
import {
  addProject,
  answerCard,
  claimSession,
  inboxFrom,
  linkPr,
  listeners,
  listenersFor,
  openCard,
  prEvent,
  startListening,
  startRun,
  beatRun,
} from "../src/core/ops.js";
import { attribute, declaredRuns, foldRepeats } from "../src/core/runs.js";
import { fold } from "../src/core/state.js";
import { homeDir, readEvents } from "../src/core/store.js";
import type { Run } from "../src/core/types.js";
import { freshHome } from "./helpers.js";

beforeEach(() => {
  freshHome();
  delete process.env.PARAWATCH_GITHUB;
});

const ts = (m: number) => new Date(Date.UTC(2026, 10, 9, 1, m)).toISOString();
const user = (m: number, content: unknown) => ({ type: "user", timestamp: ts(m), message: { role: "user", content } });
const assistant = (m: number, content: unknown[]) => ({ type: "assistant", timestamp: ts(m), message: { role: "assistant", content } });
const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, runtime: "claude-code", kind: "session", title: id, state: "idle", ...extra });

describe("reading the log", () => {
  it("collects folders of edited files, cd targets, and PRs opened with gh", () => {
    const w = scanWork([
      assistant(1, [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/work/api/src/a.ts" } }]),
      assistant(2, [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cd /work/web && git status; git -C '/work/lib x' log" } }]),
      assistant(3, [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "gh pr create --fill" } }]),
      user(4, [{ type: "tool_result", tool_use_id: "b2", content: "https://github.com/acme/api/pull/88\n" }]),
      assistant(5, [{ type: "tool_use", id: "e2", name: "Write", input: { file_path: "/work/api/src/b.ts" } }]),
    ]);
    expect(w.touched).toEqual(["/work/web", "/work/lib x", "/work/api/src"]);
    expect(w.createdPrs).toEqual(["https://github.com/acme/api/pull/88"]);
  });

  it("a turn that ends with the desktop app's wrap-up question asks the human", () => {
    const r = readClaudeTail(
      [
        user(0, "ship it"),
        assistant(1, [{ type: "tool_use", id: "w1", name: "mcp__ccd_turn__wrap_up", input: { recap: "Tests pass, PR is open.", ask: "Merge PR 88?", blocked: true } }]),
        user(2, [{ type: "tool_result", tool_use_id: "w1", content: "ok" }]),
        assistant(3, [{ type: "text", text: "Done. Should I merge?" }]),
      ],
      "session",
    );
    expect(r).toMatchObject({ state: "idle", recap: "Tests pass, PR is open.", asks: { text: "Merge PR 88?", via: "wrap_up", blocked: true }, lastPromptAt: ts(0) });
  });

  it("a wrap-up without a question is not an ask, even when the text ends with one", () => {
    const r = readClaudeTail(
      [user(0, "x"), assistant(1, [{ type: "tool_use", id: "w1", name: "mcp__ccd_turn__wrap_up", input: { recap: "All done." } }]), assistant(2, [{ type: "text", text: "Anything else?" }])],
      "session",
    );
    expect(r.asks).toBeUndefined();
    expect(r.recap).toBe("All done.");
  });

  it("without a wrap-up, a closing question in the text counts, marked as read from text", () => {
    const r = readClaudeTail([user(0, "x"), assistant(1, [{ type: "text", text: "I fixed it.\n\n**Merge now?**" }])], "session");
    expect(r.asks).toMatchObject({ text: "Merge now?", via: "text" });
    const plain = readClaudeTail([user(0, "x"), assistant(1, [{ type: "text", text: "Fixed." }])], "session");
    expect(plain.asks).toBeUndefined();
  });
});

describe("explicit claims", () => {
  it("a session that only edits another project's files belongs to that project", () => {
    addProject("notes", ["/home/notes"]);
    addProject("api", ["/work/api"]);
    const runs = attribute(
      [
        run("a1", { cwd: "/home/notes", touched: ["/work/api/src", "/work/api/test"] }),
        run("a2", { cwd: "/home/notes", touched: ["/home/notes/journal", "/work/api/src"] }),
        run("a3", { cwd: "/elsewhere", touched: ["/work/api/src"] }),
      ],
      fold(readEvents()),
    );
    expect(runs.map((r) => [r.project, r.projectSource])).toEqual([
      ["api", "edits"],
      ["notes", "cwd"],
      ["api", "edits"],
    ]);
  });

  it("a later claim without a project keeps the project and adds done; new work clears it", () => {
    claimSession({ session: "sess-123456", project: "api", task: "ABC-101", title: "Fix login" });
    const c = claimSession({ session: "sess-123456", done: "Merged in #88" });
    expect(c).toMatchObject({ project: "api", task: "ABC-101", title: "Fix login", done: "Merged in #88" });
    const again = claimSession({ session: "sess-123456", project: "api", task: "ABC-102" });
    expect(again.done).toBeUndefined();
    expect(again.title).toBe("Fix login");
    expect(() => claimSession({ session: "other-123456", done: "x" })).toThrow(/--project/);
  });

  it("done shows until someone writes to the session again", () => {
    claimSession({ session: "sess-123456", project: "api", done: "Shipped" });
    const at = fold(readEvents()).claims[0]!.at!;
    const before = new Date(Date.parse(at) - 60_000).toISOString();
    const after = new Date(Date.parse(at) + 60_000).toISOString();
    const [quiet, resumed] = attribute(
      [run("sess-123456-a", { lastPromptAt: before, asks: { text: "?", via: "text" } }), run("sess-123456-b", { lastPromptAt: after, state: "idle" })],
      fold(readEvents()),
    );
    expect(quiet).toMatchObject({ state: "done", done: "Shipped" });
    expect(quiet!.asks).toBeUndefined();
    expect(resumed!.done).toBeUndefined();
  });
});

describe("scheduled sessions", () => {
  it("fold into the newest run of the task, keeping any that still work", () => {
    const runs = foldRepeats([
      run("s1", { project: "ops", task: "check", scheduled: true, lastActivity: ts(1) }),
      run("s2", { project: "ops", task: "check", scheduled: true, lastActivity: ts(2) }),
      run("s3", { project: "ops", task: "check", scheduled: true, lastActivity: ts(3) }),
      run("s0", { project: "ops", task: "check", scheduled: true, lastActivity: ts(0), state: "working" }),
      run("kid", { kind: "subagent", parent: "s1" }),
      run("x", { project: "ops", lastActivity: ts(4) }),
    ]);
    expect(runs.map((r) => r.id)).toEqual(["s3", "s0", "x"]);
    expect(runs[0]!.repeats).toBe(2);
  });

  it("unclaimed sessions with the same first prompt fold too", () => {
    const runs = foldRepeats([run("p1", { prompt: "/check the board", lastActivity: ts(1) }), run("p2", { prompt: "/check the board", lastActivity: ts(2) })]);
    expect(runs.map((r) => [r.id, r.repeats])).toEqual([["p2", 1]]);
  });
});

describe("heartbeats", () => {
  it("a declared run with a heartbeat stalls when beats stop, and a beat revives it", () => {
    const id = startRun({ project: "game", title: "overnight bench", heartbeat: 600 });
    const later = Date.now() + 11 * 60_000;
    expect(declaredRuns(fold(readEvents()), later)[0]).toMatchObject({ state: "stalled" });
    beatRun(id);
    expect(declaredRuns(fold(readEvents()))[0]!.state).toBe("working");
  });

  it("a log file that keeps changing counts as beats", () => {
    const log = path.join(homeDir(), "bench.log");
    fs.writeFileSync(log, "start\n");
    startRun({ project: "game", title: "bench", heartbeat: 60, log });
    const future = new Date(Date.now() + 120_000);
    fs.utimesSync(log, future, future);
    expect(declaredRuns(fold(readEvents()), future.getTime() + 1000)[0]!.state).toBe("working");
  });
});

describe("approvals", () => {
  it("an action makes a yes-or-no card that carries the action and a preview", () => {
    const file = path.join(homeDir(), "msg.txt");
    fs.writeFileSync(file, "Hi team, PR 88 is ready.");
    const c = openCard({ kind: "decide", project: "api", title: "Post the release note?", action: "gh pr comment 88 -F msg.txt", preview: file });
    expect(c).toMatchObject({ options: ["Do it", "Don't"], action: "gh pr comment 88 -F msg.txt", preview: "Hi team, PR 88 is ready." });
  });
});

// ------------------------------------------------------------------ pull requests

const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
  key: "github.com/acme/api#88",
  url: "https://github.com/acme/api/pull/88",
  host: "github.com",
  repo: "acme/api",
  number: 88,
  title: "Fix login",
  author: "me",
  state: "open",
  draft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  pending: ["alice"],
  reviews: [],
  comments: 0,
  ci: "PENDING",
  autoMerge: false,
  updatedAt: ts(0),
  mine: true,
  reviewRequested: false,
  ...over,
});

describe("pull requests", () => {
  it("parses URLs and short forms", () => {
    expect(parsePrRef("https://ghe.corp/acme/api/pull/88/files")).toMatchObject({ key: "ghe.corp/acme/api#88", host: "ghe.corp" });
    expect(parsePrRef("acme/api#88")).toMatchObject({ key: "github.com/acme/api#88", url: "https://github.com/acme/api/pull/88" });
    expect(parsePrRef("ABC-1234")).toBeUndefined();
  });

  it("says what a PR waits on", () => {
    expect(waitingOn(pr({ ci: "SUCCESS" }))).toEqual({ what: "review", who: ["alice"] });
    expect(waitingOn(pr())).toMatchObject({ what: "CI" });
    expect(waitingOn(pr({ ci: "FAILURE" }))).toMatchObject({ what: "CI failed", who: ["me"] });
    expect(waitingOn(pr({ ci: "SUCCESS", reviewDecision: "APPROVED", queue: { state: "QUEUED", position: 3 } }))).toMatchObject({ what: "merge queue" });
    expect(waitingOn(pr({ mergeable: "CONFLICTING" }))).toMatchObject({ what: "conflict" });
  });

  it("turns two readings into changes", () => {
    const a = pr({ queue: { state: "QUEUED" } });
    const b = pr({ ci: "FAILURE", reviews: [{ by: "alice", state: "CHANGES_REQUESTED", at: ts(5) }], comments: 2 });
    expect(changesBetween(a, b)).toEqual([{ change: "changes_requested", by: "alice" }, { change: "commented" }, { change: "ci_failed" }, { change: "queue_removed" }]);
    expect(changesBetween(pr(), pr({ state: "merged" }))).toEqual([{ change: "merged" }]);
  });

  it("keeps how long a PR has waited on the same thing", () => {
    const first = nextCache({ prs: [], since: {} }, [pr({ ci: "SUCCESS" })], ["github.com"], ts(10));
    expect(first.cache.since[pr().key]).toEqual({ waitingOn: "review", since: ts(0) });
    expect(first.events).toEqual([]);
    const second = nextCache(first.cache, [pr({ ci: "SUCCESS" })], ["github.com"], ts(20));
    expect(second.cache.since[pr().key]!.since).toBe(ts(0));
    const third = nextCache(second.cache, [pr({ ci: "FAILURE" })], ["github.com"], ts(30));
    expect(third.cache.since[pr().key]).toEqual({ waitingOn: "CI failed", since: ts(30) });
    expect(third.events.map((e) => e.type === "pr.change" && e.change)).toEqual(["ci_failed"]);
  });

  it("news on a linked PR reaches the owning project's wait; other PRs stay out", () => {
    const ref = parsePrRef("acme/api#88")!;
    claimSession({ session: "sess-123456", project: "api", task: "ABC-101" });
    linkPr({ pr: ref, session: "sess-123456" });
    prEvent(ref, "approved", { by: "alice" });
    prEvent(parsePrRef("acme/other#1")!, "merged");
    const items = inboxFrom(readEvents(), 0, { project: "api" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "pr", by: "alice", pr: { change: "approved", project: "api" } });
    expect(inboxFrom(readEvents(), 0, { project: "web" })).toHaveLength(0);
    expect(() => prEvent(ref, "exploded")).toThrow(/change must be/);
  });

  it("goto finds the session that owns a PR", () => {
    linkPr({ pr: parsePrRef("acme/api#88")!, session: "sess-123456", project: "api" });
    process.env.PARAWATCH_CLAUDE_DESKTOP_DIR = path.join(homeDir(), "none");
    const state = fold(readEvents());
    expect(resolveGoto("https://github.com/acme/api/pull/88", state).session).toBe("sess-123456");
    expect(resolveGoto("api#88", state).session).toBe("sess-123456");
    expect(() => resolveGoto("acme/api#9", state)).toThrow(/no session owns/);
  });

  it("sync reads GitHub through gh, records changes, and waits for the interval", async () => {
    let reading = pr({ ci: "PENDING" });
    let calls = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === "auth") return JSON.stringify({ hosts: { "github.com": [{ state: "success" }] } });
      calls++;
      const node = {
        number: reading.number,
        title: reading.title,
        url: reading.url,
        state: reading.state.toUpperCase(),
        isDraft: false,
        mergeable: reading.mergeable,
        reviewDecision: reading.reviewDecision,
        updatedAt: reading.updatedAt,
        author: { login: "me" },
        repository: { nameWithOwner: reading.repo },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "alice" } }] },
        latestReviews: { nodes: [] },
        comments: { totalCount: 0 },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: reading.ci } } }] },
        mergeQueueEntry: null,
        autoMergeRequest: null,
      };
      return JSON.stringify({ data: { viewer: { login: "me" }, mine: { nodes: [node] }, asked: { nodes: [] } } });
    };
    const state = () => fold(readEvents());
    await syncGithub({ state: state(), gh });
    expect(readCache().prs[0]).toMatchObject({ key: pr().key, ci: "PENDING", mine: true, pending: ["alice"] });
    reading = pr({ ci: "FAILURE" });
    await syncGithub({ state: state(), gh });
    expect(calls).toBe(1); // within the interval
    await syncGithub({ state: state(), gh, force: true });
    expect(readEvents().filter((e) => e.type === "pr.change").map((e) => e.type === "pr.change" && e.change)).toEqual(["ci_failed"]);
    const views = prViews(readCache(), state(), []);
    expect(views[0]).toMatchObject({ waitingOn: "CI failed", mine: true });
  });

  it("stays off when gh is missing or turned off", async () => {
    const gh: GhRunner = async () => {
      throw new Error("gh: command not found");
    };
    const c = await syncGithub({ state: fold(readEvents()), gh });
    expect(c).toMatchObject({ hosts: [], error: expect.stringMatching(/not installed/) });
    process.env.PARAWATCH_GITHUB = "0";
    let called = false;
    await syncGithub({ state: fold(readEvents()), force: true, gh: async () => ((called = true), "") });
    expect(called).toBe(false);
  });
});

describe("waits", () => {
  it("a running wait is visible, and a dead one is cleaned up", () => {
    const stop = startListening({ consumer: "api", project: "api" });
    const card = openCard({ kind: "decide", project: "api", title: "Q?" });
    const other = openCard({ kind: "decide", project: "web", title: "Q?" });
    expect(listenersFor(card, listeners())).toHaveLength(1);
    expect(listenersFor(other, listeners())).toHaveLength(0);
    stop();
    expect(listeners()).toHaveLength(0);
    const dir = path.join(homeDir(), "listeners");
    fs.writeFileSync(path.join(dir, "999999.json"), JSON.stringify({ consumer: "x", pid: 999999, since: ts(0) }));
    expect(listeners()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "999999.json"))).toBe(false);
  });
});

describe("digest", () => {
  it("lists what each session did today", () => {
    process.env.PARAWATCH_CLAUDE_DIR = path.join(os.tmpdir(), "parawatch-no-logs");
    process.env.PARAWATCH_CODEX_DIR = path.join(os.tmpdir(), "parawatch-no-logs");
    claimSession({ session: "sess-123456", project: "api", task: "ABC-101", title: "Fix login" });
    const c = openCard({ kind: "decide", project: "api", title: "Merge?", options: ["Yes", "No"], session: "sess-123456" });
    answerCard(c.id, { choice: 1 });
    linkPr({ pr: parsePrRef("acme/api#88")!, session: "sess-123456" });
    prEvent(parsePrRef("acme/api#88")!, "merged");
    claimSession({ session: "sess-123456", done: "Merged #88" });
    const d = digest(localDate());
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0]).toMatchObject({
      project: "api",
      task: "ABC-101",
      title: "Fix login",
      done: "Merged #88",
      cards: [{ id: c.id, events: ["opened", "answered: Yes"] }],
      prs: [{ changes: ["merged"] }],
    });
  });
});
