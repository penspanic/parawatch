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
  dismissCard,
  handCard,
  handPr,
  inboxFrom,
  inboxScope,
  linkPr,
  listeners,
  listenersFor,
  makeLead,
  openCard,
  prEvent,
  readInbox,
  sessionConsumer,
  startListening,
  startRun,
  beatRun,
} from "../src/core/ops.js";
import { hookContext } from "../src/core/integrate.js";
import { attribute, declaredRuns, foldRepeats } from "../src/core/runs.js";
import { inboxLine } from "../src/core/format.js";
import { snapshot } from "../src/core/snapshot.js";
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

  it("says when something other than reviews and CI holds an approved PR", () => {
    const ready = { ci: "SUCCESS", reviewDecision: "APPROVED", pending: [] };
    expect(waitingOn(pr({ ...ready, mergeState: "CLEAN" }))).toEqual({ what: "merge", who: ["me"] });
    expect(waitingOn(pr({ ...ready, mergeState: "BLOCKED" }))).toEqual({ what: "merge held" });
    // no review needed at all, and still blocked
    expect(waitingOn(pr({ ...ready, reviewDecision: undefined, mergeState: "BLOCKED" }))).toEqual({ what: "merge held" });
    // blocked because reviews are missing is plain review, not held
    expect(waitingOn(pr({ ci: "SUCCESS", mergeState: "BLOCKED" }))).toEqual({ what: "review", who: ["alice"] });
    expect(waitingOn(pr({ ...ready, reviewDecision: "REVIEW_REQUIRED", mergeState: "BLOCKED" }))).toEqual({ what: "no reviewer", who: ["me"] });
    // CI still running comes first
    expect(waitingOn(pr({ ...ready, ci: "PENDING", mergeState: "BLOCKED" }))).toEqual({ what: "CI" });
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

describe("waits per session", () => {
  const sessions = ["aaaa1111-0001", "bbbb2222-0002", "cccc3333-0003", "dddd4444-0004"];
  const setup = () => {
    sessions.forEach((s, i) => {
      claimSession({ session: s, project: "bugs", task: `BUG-${i + 1}` });
      linkPr({ pr: parsePrRef(`acme/app#${i + 1}`)!, session: s });
    });
  };
  const read = (s: string) => {
    const { consumer, filter } = inboxScope({}, s);
    return readInbox(consumer, filter, true);
  };

  it("news on one PR reaches only the session that linked it, once", () => {
    setup();
    prEvent(parsePrRef("acme/app#2")!, "ci_failed");
    expect(read(sessions[0]!)).toHaveLength(0);
    expect(read(sessions[2]!)).toHaveLength(0);
    expect(read(sessions[3]!)).toHaveLength(0);
    const mine = read(sessions[1]!);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "pr", pr: { change: "ci_failed" } });
    expect(read(sessions[1]!)).toHaveLength(0);
    // a project wait outside a session still sees it
    expect(readInbox("bugs", { project: "bugs" }, false)).toHaveLength(1);
  });

  it("an answer goes to the session that opened the card; an unowned card to the project's lead", () => {
    setup();
    claimSession({ session: sessions[0]!, role: "lead" });
    const own = openCard({ kind: "decide", project: "bugs", title: "Ship?", session: sessions[0] });
    const loose = openCard({ kind: "block", project: "bugs", title: "Sign in" });
    const away = openCard({ kind: "block", project: "web", title: "Elsewhere" });
    answerCard(own.id, { comment: "yes" });
    answerCard(loose.id, { comment: "done" });
    answerCard(away.id, { comment: "done" });
    expect(read(sessions[0]!).map((i) => i.card?.id)).toEqual([own.id, loose.id]);
    // the other sessions in the project are not woken for it
    expect(read(sessions[1]!).map((i) => i.card?.id)).toEqual([]);
    // an unclaimed session gets only what it owns
    expect(read("eeee5555-0005")).toHaveLength(0);
  });

  it("a short claimed id matches the full session id", () => {
    claimSession({ session: "abcd1234", project: "bugs" });
    linkPr({ pr: parsePrRef("acme/app#9")!, session: "abcd1234" });
    prEvent(parsePrRef("acme/app#9")!, "merged");
    expect(read("abcd1234-5678-90ab")).toHaveLength(1);
  });

  it("a dismissed card is closed, marked, and its asker is told once; a closed card cannot be dismissed", () => {
    setup();
    const own = openCard({ kind: "decide", project: "bugs", title: "Publish by hand?", session: sessions[0] });
    dismissCard(own.id, "npm publishes itself now");
    const card = fold(readEvents()).cards.get(own.id);
    expect(card).toMatchObject({ status: "closed", dismissed: true, closeNote: "npm publishes itself now" });
    expect(read(sessions[1]!)).toHaveLength(0);
    const mine = read(sessions[0]!);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "dismissed", comment: "npm publishes itself now" });
    expect(inboxLine(mine[0]!)).toContain("dismissed by the human");
    expect(read(sessions[0]!)).toHaveLength(0);
    expect(() => dismissCard(own.id)).toThrow(/already closed/);
  });

  it("outside a session, or with --card, the scope is what it was", () => {
    expect(inboxScope({}, undefined)).toEqual({ consumer: "default", filter: { project: undefined, card: undefined } });
    expect(inboxScope({ project: "bugs" }, undefined)).toEqual({ consumer: "bugs", filter: { project: "bugs", card: undefined } });
    expect(inboxScope({ card: "c1" }, sessions[0]).consumer).toBe("card-c1");
  });

  it("a lead waiting on its project from a session does not take what another live session owns", () => {
    setup();
    const lead = "ffff6666-0006";
    claimSession({ session: lead, project: "bugs", role: "lead" });
    const scope = inboxScope({ project: "bugs" }, lead);
    expect(scope).toEqual({ consumer: sessionConsumer(lead), filter: { session: lead, project: "bugs" } });
    const theirs = openCard({ kind: "try", project: "bugs", title: "Play a few rounds", session: sessions[0] });
    const loose = openCard({ kind: "block", project: "bugs", title: "Sign in" });
    const mine = openCard({ kind: "decide", project: "bugs", title: "Merge?", session: lead });
    for (const c of [theirs, loose, mine]) answerCard(c.id, { comment: "ok" });
    prEvent(parsePrRef("acme/app#1")!, "ci_failed");
    expect(readInbox(scope.consumer, scope.filter, true).map((i) => i.card?.id)).toEqual([loose.id, mine.id]);
    // the owner still gets its own, and not the unowned one: that is the lead's
    expect(read(sessions[0]!).map((i) => i.card?.id ?? i.pr?.ref.number)).toEqual([theirs.id, 1]);
    // its listener counts only where it would wake
    const stop = startListening({ consumer: scope.consumer, project: "bugs", session: lead, scope: "session" });
    expect(listenersFor(theirs, listeners())).toHaveLength(0);
    expect(listenersFor(loose, listeners())).toHaveLength(1);
    stop();
  });

  it("without a lead, what no session owns wakes no one and waits in parawatch", () => {
    setup();
    const loose = openCard({ kind: "decide", project: "bugs", title: "Which name?" });
    answerCard(loose.id, { comment: "the short one" });
    linkPr({ pr: parsePrRef("acme/app#7")!, project: "bugs" });
    prEvent(parsePrRef("acme/app#7")!, "ci_failed");
    for (const s of sessions) expect(read(s)).toHaveLength(0);
    const card = snapshot().cards.find((c) => c.id === loose.id)!;
    expect(card).toMatchObject({ unrouted: true });
    expect(card.lead).toBeUndefined();
    // a wait outside a session still reads it
    expect(readInbox("bugs", { project: "bugs" }, false).length).toBe(2);
  });

  it("the human picks a lead: earlier leads step down, and it is handed what no session got", () => {
    setup();
    claimSession({ session: sessions[3]!, role: "lead" });
    claimSession({ session: sessions[3]!, done: "Finished" }); // the old lead ended
    const loose = openCard({ kind: "decide", project: "bugs", title: "Which name?", options: ["Short", "Long"] });
    answerCard(loose.id, { choice: 1, comment: "short" });
    expect(snapshot().cards.find((c) => c.id === loose.id)).toMatchObject({ unrouted: true });
    read(sessions[1]!); // its cursor is past the answer already
    const r = makeLead("bugs", sessions[1]!.slice(0, 8));
    expect(r).toEqual({ session: sessions[1], handed: [loose.id] });
    const state = fold(readEvents());
    expect(state.claims.find((c) => c.session === sessions[1])).toMatchObject({ role: "lead", project: "bugs", task: "BUG-2" });
    expect(state.claims.find((c) => c.session === sessions[3])?.role).toBe("");
    const got = read(sessions[1]!);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "handed", card: { id: loose.id }, choice: 1, choiceText: "Short", comment: "short" });
    expect(inboxLine(got[0]!)).toBe(`[bugs] ${loose.id} "Which name?" handed to you by the human; the answer: chose 1 (Short); said: short`);
    expect(read(sessions[1]!)).toHaveLength(0);
    expect(read(sessions[0]!)).toHaveLength(0);
    // from now on the lead gets what has no owner
    const next = openCard({ kind: "block", project: "bugs", title: "Sign in" });
    answerCard(next.id, { comment: "done" });
    expect(read(sessions[1]!).map((i) => i.card?.id)).toEqual([next.id]);
    expect(snapshot().cards.find((c) => c.id === next.id)).toMatchObject({ lead: sessions[1] });
  });

  it("a card or a pull request handed to another session goes to it from then on", () => {
    setup();
    const card = openCard({ kind: "try", project: "bugs", title: "Play it", session: sessions[0] });
    handCard(card.id, sessions[2]!);
    const got = read(sessions[2]!);
    expect(got).toHaveLength(1);
    expect(inboxLine(got[0]!)).toContain("handed to you by the human; not answered yet");
    answerCard(card.id, { comment: "feels slow" });
    expect(read(sessions[0]!)).toHaveLength(0);
    expect(read(sessions[2]!).map((i) => i.comment)).toEqual(["feels slow"]);
    handPr(parsePrRef("acme/app#1")!, sessions[3]!);
    const pr = read(sessions[3]!);
    expect(pr[0]).toMatchObject({ kind: "handed", pr: { ref: { number: 1 }, project: "bugs" } });
    expect(inboxLine(pr[0]!)).toContain("handed to you by the human");
    prEvent(parsePrRef("acme/app#1")!, "approved");
    expect(read(sessions[0]!)).toHaveLength(0);
    expect(read(sessions[3]!).map((i) => i.pr?.change)).toEqual(["approved"]);
    expect(() => handCard("c999", sessions[1]!)).toThrow();
  });

  it("a snapshot card names who would be woken: its lead, or no one", () => {
    setup();
    const loose = openCard({ kind: "decide", project: "bugs", title: "Anyone?" });
    const stop = startListening({ consumer: sessionConsumer(sessions[0]!), project: "bugs", session: sessions[0], scope: "session" });
    expect(listenersFor(snapshot().cards.find((c) => c.id === loose.id)!, listeners())).toHaveLength(0);
    claimSession({ session: sessions[0]!, role: "lead" });
    expect(listenersFor(snapshot().cards.find((c) => c.id === loose.id)!, listeners())).toHaveLength(1);
    stop();
  });

  it("a lead moving from the project cursor to its own does not hear old news again", () => {
    setup();
    const lead = "ffff6666-0006";
    claimSession({ session: lead, project: "bugs", role: "lead" });
    const loose = openCard({ kind: "block", project: "bugs", title: "Sign in" });
    answerCard(loose.id, { comment: "done" });
    readInbox("bugs", { project: "bugs" }, true); // an older lead wait handled it
    const scope = inboxScope({ project: "bugs" }, lead);
    expect(readInbox(scope.consumer, scope.filter, true)).toHaveLength(0);
  });

  it("news after the merge of a pull request whose owner has ended wakes no other session", () => {
    setup();
    claimSession({ session: sessions[2]!, role: "lead" });
    claimSession({ session: sessions[0]!, done: "Merged #1" });
    claimSession({ session: sessions[1]!, done: "Handed over #2" });
    prEvent(parsePrRef("acme/app#1")!, "merged");
    prEvent(parsePrRef("acme/app#1")!, "commented");
    prEvent(parsePrRef("acme/app#2")!, "ci_failed");
    // the open one still needs someone: the lead
    expect(read(sessions[3]!)).toHaveLength(0);
    expect(read(sessions[2]!).map((i) => `${i.pr?.ref.number} ${i.pr?.change}`)).toEqual(["2 ci_failed"]);
    // the owner, if it still waits, hears its own, and not what another ended session left
    expect(read(sessions[0]!).map((i) => `${i.pr?.ref.number} ${i.pr?.change}`)).toEqual(["1 merged", "1 commented"]);
    // and the project wait outside a session keeps everything
    expect(readInbox("bugs", { project: "bugs" }, false)).toHaveLength(3);
  });

  it("moving from a project wait starts where that wait stopped", () => {
    setup();
    prEvent(parsePrRef("acme/app#1")!, "ci_failed");
    readInbox("bugs", { project: "bugs" }, true); // the old project wait handled it
    expect(read(sessions[0]!)).toHaveLength(0);
    prEvent(parsePrRef("acme/app#1")!, "approved");
    expect(read(sessions[0]!)).toHaveLength(1);
  });

  it("a session wait counts as listening only for its own cards, and for the project's unowned ones when it leads", () => {
    setup();
    claimSession({ session: sessions[0]!, role: "lead" });
    const stop = startListening({ consumer: sessionConsumer(sessions[0]!), project: "bugs", session: sessions[0], scope: "session" });
    const own = openCard({ kind: "decide", project: "bugs", title: "Mine?", session: sessions[0] });
    const theirs = openCard({ kind: "decide", project: "bugs", title: "Theirs?", session: sessions[1] });
    const loose = openCard({ kind: "decide", project: "bugs", title: "Anyone?" });
    expect(listenersFor(own, listeners())).toHaveLength(1);
    expect(listenersFor(theirs, listeners())).toHaveLength(0);
    expect(listenersFor(loose, listeners())).toHaveLength(1);
    stop();
  });

  it("what a session that has ended owned goes to the project's lead", () => {
    setup();
    claimSession({ session: sessions[1]!, role: "lead" });
    const done = openCard({ kind: "decide", project: "bugs", title: "Ship?", session: sessions[0] });
    const archived = openCard({ kind: "decide", project: "bugs", title: "Rename?", session: sessions[2] });
    const live = openCard({ kind: "decide", project: "bugs", title: "Keep?", session: sessions[3] });
    claimSession({ session: sessions[0]!, done: "Merged #1" });
    // the human archived the third session in the Claude desktop app
    const dir = process.env.PARAWATCH_CLAUDE_DESKTOP_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "local_x1.json"), JSON.stringify({ sessionId: "local_x1", cliSessionId: sessions[2], isArchived: true }));
    for (const c of [done, archived, live]) answerCard(c.id, { comment: "yes" });
    prEvent(parsePrRef("acme/app#1")!, "merged");
    const got = read(sessions[1]!);
    // the merged pull request needs no one, so only its owner hears of it
    expect(got.map((i) => i.card?.id ?? i.pr?.ref.number)).toEqual([done.id, archived.id]);
    // the session itself still gets its own news; what another ended session left is the lead's
    expect(read(sessions[0]!).map((i) => i.card?.id ?? i.pr?.ref.number)).toEqual([done.id, 1]);
    // and a wait on the project counts as listening for those cards
    const stop = startListening({ consumer: sessionConsumer(sessions[1]!), project: "bugs", session: sessions[1], scope: "session" });
    const state = fold(readEvents());
    expect(listenersFor(state.cards.get(done.id)!, listeners())).toHaveLength(1);
    expect(listenersFor(state.cards.get(archived.id)!, listeners())).toHaveLength(1);
    expect(listenersFor(state.cards.get(live.id)!, listeners())).toHaveLength(0);
    stop();
  });

  it("a snapshot marks cards whose session has ended", () => {
    process.env.PARAWATCH_CLAUDE_DIR = path.join(os.tmpdir(), "parawatch-no-logs");
    process.env.PARAWATCH_CODEX_DIR = path.join(os.tmpdir(), "parawatch-no-logs");
    setup();
    openCard({ kind: "decide", project: "bugs", title: "Ship?", session: sessions[0] });
    openCard({ kind: "decide", project: "bugs", title: "Keep?", session: sessions[1] });
    claimSession({ session: sessions[0]!, done: "Merged #1" });
    const cards = snapshot({ project: "bugs" }).cards;
    expect(cards.map((c) => [c.title, c.ownerEnded ?? false])).toEqual([
      ["Ship?", true],
      ["Keep?", false],
    ]);
  });

  it("the hook names only the session's own news", () => {
    setup();
    prEvent(parsePrRef("acme/app#2")!, "ci_failed");
    expect(hookContext({ session_id: sessions[0] })).toBeUndefined();
    expect(hookContext({ session_id: sessions[1] })).toContain("acme/app#2");
    // handled by the session's own wait, or by an old project wait: either cursor counts
    const { consumer, filter } = inboxScope({}, sessions[1]);
    readInbox(consumer, filter, true);
    expect(hookContext({ session_id: sessions[1] })).toBeUndefined();
    prEvent(parsePrRef("acme/app#2")!, "approved");
    readInbox("bugs", { project: "bugs" }, true);
    expect(hookContext({ session_id: sessions[1] })).toBeUndefined();
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
