// GitHub notifications from other people, the recent news, and readings that come late.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchInbox, inboxViews, markThreadRead, newsViews, nextInbox, readCache, resetGithubProcess, syncGithub, toThread, type GhRunner } from "../src/core/github.js";
import { claimSession, linkPr, readState } from "../src/core/ops.js";
import { fold } from "../src/core/state.js";
import { homeDir, readEvents } from "../src/core/store.js";
import type { InboxThread } from "../src/core/types.js";
import { inboxReason, newsWords } from "../src/core/words.js";
import { freshHome } from "./helpers.js";

const ts = (min: number) => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString();

/** A notification the way GitHub's REST API gives it. */
function note(id: string, reason: string, over: { number?: number; kind?: "pulls" | "issues"; at?: string; comment?: string; repo?: string } = {}) {
  const repo = over.repo ?? "kim/game";
  const number = over.number ?? 21;
  return {
    id,
    reason,
    updated_at: over.at ?? ts(0),
    repository: { full_name: repo },
    subject: {
      title: `Thread ${id}`,
      type: over.kind === "pulls" ? "PullRequest" : "Issue",
      url: `https://api.github.com/repos/${repo}/${over.kind ?? "issues"}/${number}`,
      latest_comment_url: over.comment ? `https://api.github.com/repos/${repo}/issues/comments/${over.comment}` : null,
    },
  };
}

/** gh with these notifications, and comment authors by comment id. */
function fakeGh(notes: unknown[], authors: Record<string, string>, calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "auth") return JSON.stringify({ hosts: { "github.com": [{ state: "success" }] } });
    if (args[1] === "graphql") return JSON.stringify({ data: { viewer: { login: "me" }, mine: { nodes: [] }, asked: { nodes: [] }, assigned: { nodes: [] } } });
    const p = args[args.length - 1]!;
    if (p.startsWith("notifications?")) return JSON.stringify(notes);
    const c = /comments\/(\w+)$/.exec(p);
    if (c) return JSON.stringify({ user: { login: authors[c[1]!] } });
    return "{}";
  };
}

beforeEach(() => {
  freshHome();
  delete process.env.PARAWATCH_GITHUB;
  resetGithubProcess();
});

describe("notifications from other people", () => {
  it("reads where a notification points and links to the page, not the API", () => {
    const t = toThread("github.com", note("7", "comment", { kind: "pulls", number: 88, repo: "acme/api", comment: "1" }))!;
    expect(t.thread).toMatchObject({ key: "github.com:7", kind: "pr", number: 88, item: "github.com/acme/api#88", url: "https://github.com/acme/api/pull/88" });
    expect(t.comment).toMatch(/comments\/1$/);
  });

  it("keeps what someone else said or asked, and leaves out the account's own words, bots, CI and owned pull requests", async () => {
    const notes = [
      note("1", "mention", { comment: "c1" }), // kim asked for the human
      note("2", "author", { number: 22, comment: "c2" }), // the human's issue, kim wrote last
      note("3", "author", { number: 23, comment: "c3" }), // the account's own words (an agent)
      note("4", "author", { number: 24, comment: "c4" }), // a bot
      note("5", "author", { number: 25 }), // a change with no comment
      note("6", "ci_activity", { number: 26 }),
      note("7", "author", { kind: "pulls", number: 27, comment: "c7" }), // a session owns this one
      note("8", "review_requested", { kind: "pulls", number: 28, comment: "c8" }), // asked, own words last
    ];
    const authors = { c1: "kim", c2: "kim", c3: "me", c4: "dependabot[bot]", c7: "kim", c8: "me" };
    const got = await fetchInbox("github.com", "me", new Set(["github.com/kim/game#27"]), new Map(), fakeGh(notes, authors));
    expect(got.map((t) => [t.id, t.by])).toEqual([
      ["1", "kim"],
      ["2", "kim"],
      ["8", undefined],
    ]);
    expect(got.map(inboxReason)).toEqual(["kim mentioned you", "kim wrote", "asks for your review"]);
  });

  it("does not look up the same comment again while the thread has no news", async () => {
    const calls: string[][] = [];
    const gh = fakeGh([note("2", "author", { comment: "c2" })], { c2: "kim" }, calls);
    const first = await fetchInbox("github.com", "me", new Set(), new Map(), gh);
    const known = new Map(first.map((t) => [t.key, t as InboxThread]));
    calls.length = 0;
    expect(await fetchInbox("github.com", "me", new Set(), known, gh)).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("tells a thread once, nothing on the first reading, and not again after it was marked read", () => {
    const t = (id: string, at: string): InboxThread => ({ key: `github.com:${id}`, host: "github.com", id, repo: "kim/game", kind: "issue", number: 21, title: "Wreck", reason: "mention", by: "kim", url: "u", at });
    expect(nextInbox(undefined, [t("1", ts(1))], new Map())).toEqual([]);
    expect(nextInbox([], [t("1", ts(1))], new Map()).map((e) => e.type)).toEqual(["inbox.new"]);
    expect(nextInbox([t("1", ts(1))], [t("1", ts(1))], new Map())).toEqual([]);
    expect(nextInbox([t("1", ts(1))], [t("1", ts(5))], new Map())).toHaveLength(1);
    expect(nextInbox([], [t("1", ts(1))], new Map([["github.com:1", ts(2)]]))).toEqual([]);
  });

  it("marks a thread read on GitHub and here, and it stays away until it has news", async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (a) => (calls.push(a), "");
    const thread: InboxThread = { key: "github.com:9", host: "github.com", id: "9", repo: "kim/game", kind: "issue", number: 21, title: "Wreck", reason: "mention", url: "u", at: ts(1) };
    fs.writeFileSync(path.join(homeDir(), "github.json"), JSON.stringify({ fetchedAt: ts(2), prs: [], inbox: [thread] }));
    expect(await markThreadRead("github.com:9", gh)).toEqual({ onGithub: true });
    expect(calls[0]).toEqual(["api", "--hostname", "github.com", "-X", "PATCH", "notifications/threads/9"]);
    expect(readCache().inbox).toEqual([]);
    expect(readState().readThreads.has("github.com:9")).toBe(true);
    // the next reading brings it back with older news: still read; with newer news: back
    const state = readState();
    expect(inboxViews({ prs: [], since: {}, inbox: [thread] }, state)).toEqual([]);
    expect(inboxViews({ prs: [], since: {}, inbox: [{ ...thread, at: "2099-01-01T00:00:00Z" }] }, state)).toHaveLength(1);
    // GitHub refused: still read here
    expect(await markThreadRead("github.com:9", async () => Promise.reject(new Error("offline")))).toEqual({ onGithub: false });
    await expect(markThreadRead("nonsense")).rejects.toThrow(/not a notification/);
  });
});

describe("readings that come late", () => {
  it("marks news found after a long gap late, so the desktop app does not pop it up", async () => {
    const gh = (notes: unknown[]) => fakeGh(notes, { c1: "kim", c2: "kim" });
    const state = () => fold(readEvents());
    await syncGithub({ state: state(), gh: gh([note("1", "mention", { comment: "c1", at: ts(0) })]), force: true });
    // the next reading finds a new thread, but the last one was hours ago (the laptop slept)
    const cache = JSON.parse(fs.readFileSync(path.join(homeDir(), "github.json"), "utf8"));
    cache.fetchedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(homeDir(), "github.json"), JSON.stringify(cache));
    await syncGithub({ state: state(), gh: gh([note("1", "mention", { comment: "c1", at: ts(0) }), note("2", "mention", { number: 22, comment: "c2", at: ts(9) })]), force: true });
    const news = readEvents().filter((e) => e.type === "inbox.new");
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ late: true, thread: { key: "github.com:2", by: "kim" } });
    // a reading soon after is on time
    await syncGithub({ state: state(), gh: gh([note("1", "mention", { comment: "c1", at: ts(0) }), note("2", "mention", { number: 22, comment: "c2", at: ts(9) }), note("3", "mention", { number: 23, comment: "c1", at: ts(12) })]), force: true });
    const third = readEvents().filter((e) => e.type === "inbox.new").at(-1);
    expect(third).toMatchObject({ thread: { key: "github.com:3" } });
    expect(third && "late" in third ? third.late : undefined).toBeUndefined();
  });
});

describe("recent news", () => {
  const pr = (n: number) => ({ key: `github.com/acme/api#${n}`, host: "github.com", repo: "acme/api", number: n, url: `https://github.com/acme/api/pull/${n}` });

  it("lists changes newest first, once when two machines read the same change, and drops CI passed on a merged one", () => {
    claimSession({ session: "s-123456", project: "api", title: "Login fix" });
    linkPr({ pr: pr(88), session: "s-123456" });
    const state = fold(readEvents());
    const at = (min: number, body: object) => ({ ...body, v: 2, seq: 0, ts: ts(min) });
    state.news.push(
      at(1, { type: "pr.change", pr: pr(88), change: "ci_failed", title: "Fix login", source: "github" }) as never,
      at(2, { type: "pr.change", pr: pr(88), change: "ci_failed", title: "Fix login", source: "github", dev: "pc" }) as never,
      at(3, { type: "pr.change", pr: pr(89), change: "ci_passed", title: "Docs", source: "github" }) as never,
      at(4, { type: "pr.change", pr: pr(89), change: "merged", title: "Docs", source: "github" }) as never,
      at(5, { type: "pr.change", pr: pr(88), change: "changes_requested", by: "alice", title: "Fix login", source: "github" }) as never,
    );
    const news = newsViews(state, ts(0));
    expect(news.map((n) => [n.number, newsWords(n)])).toEqual([
      [88, "changes requested · alice"],
      [89, "merged"],
      [88, "CI failed"],
    ]);
    expect(news[0]).toMatchObject({ session: "s-123456", sessionTitle: "Login fix", project: "api" });
    expect(newsViews(state, ts(4)).map((n) => n.change)).toEqual(["changes_requested", "merged"]);
  });
});
