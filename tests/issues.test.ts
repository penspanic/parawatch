// Issues assigned to the human: read from GitHub, news on them, set aside and brought back.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { dropReported, issueViews, nextIssues, parseIssueRef, projectRepos, remoteRepo, toIssue, type IssueStatus } from "../src/core/github.js";
import { addProject, readState, setIssueAside } from "../src/core/ops.js";
import type { EventBody, PwEvent } from "../src/core/types.js";
import { freshHome } from "./helpers.js";

const ts = (min: number) => new Date(Date.UTC(2026, 10, 18, 9, min)).toISOString();

function issue(over: Partial<IssueStatus> & Pick<IssueStatus, "number">): IssueStatus {
  const n = over.number;
  return { key: `github.com/kim/game#${n}`, url: `https://github.com/kim/game/issues/${n}`, host: "github.com", repo: "kim/game", title: `Issue ${n}`, updatedAt: ts(0), assignedBy: "kim", assignedAt: ts(0), ...over };
}

let home: string;
beforeEach(() => {
  home = freshHome();
});

describe("issues assigned to you", () => {
  it("reads who assigned it to the human and the latest comment by someone else", () => {
    const node = {
      number: 21,
      title: "Wreck interior",
      url: "https://github.com/kim/game/issues/21",
      updatedAt: ts(30),
      author: { login: "kim" },
      repository: { nameWithOwner: "kim/game" },
      timelineItems: {
        nodes: [
          { createdAt: ts(1), actor: { login: "kim" }, assignee: { login: "lee" } },
          { createdAt: ts(2), actor: { login: "kim" }, assignee: { login: "me" } },
        ],
      },
      comments: { nodes: [{ author: { login: "kim" }, createdAt: ts(10) }, { author: { login: "me" }, createdAt: ts(20) }] },
    };
    const i = toIssue("github.com", node, "me")!;
    expect(i.key).toBe("github.com/kim/game#21");
    expect([i.assignedBy, i.assignedAt, i.byMe]).toEqual(["kim", ts(2), undefined]);
    // the human's own comment is not news to them
    expect(i.lastOther).toEqual({ by: "kim", at: ts(10) });
    const self = toIssue("github.com", { ...node, timelineItems: { nodes: [{ createdAt: ts(3), actor: { login: "me" }, assignee: { login: "me" } }] } }, "me")!;
    expect(self.byMe).toBe(true);
  });

  it("tells a new assignment and someone else's comment once, and nothing on the first reading", () => {
    const first = [issue({ number: 1 })];
    expect(nextIssues(undefined, first, undefined)).toEqual([]);
    expect(nextIssues(first, first, ts(5))).toEqual([]);
    const assigned = issue({ number: 2, assignedAt: ts(6), title: "Fan worm" });
    const news = nextIssues(first, [...first, assigned], ts(5));
    expect(news).toEqual([{ type: "issue.change", issue: { key: "github.com/kim/game#2", host: "github.com", repo: "kim/game", number: 2, url: "https://github.com/kim/game/issues/2" }, change: "assigned", title: "Fan worm", by: "kim", source: "github" }]);
    const commented = { ...first[0]!, lastOther: { by: "kim", at: ts(7) } };
    expect(nextIssues(first, [commented], ts(5)).map((e) => e.type === "issue.change" && [e.change, e.by])).toEqual([["commented", "kim"]]);
    expect(nextIssues([commented], [commented], ts(8))).toEqual([]);
    // assigned to themselves, or long ago and only now inside the reading: not news
    expect(nextIssues(first, [...first, issue({ number: 3, assignedAt: ts(6), byMe: true })], ts(5))).toEqual([]);
    const old = issue({ number: 4, assignedAt: "2026-09-01T00:00:00Z" });
    expect(nextIssues(first, [...first, old], ts(5))).toEqual([]);
  });

  it("news another machine already logged is not told again", () => {
    const body: EventBody = { type: "issue.change", issue: { key: "github.com/kim/game#2", host: "github.com", repo: "kim/game", number: 2, url: "u" }, change: "assigned", by: "kim", source: "github" };
    const log = [{ ...body, v: 2, seq: 1, ts: ts(6), dev: "pc" }] as PwEvent[];
    expect(dropReported([body], log, ts(5), "mac")).toEqual([]);
    expect(dropReported([body], log, ts(7), "mac")).toEqual([body]);
  });

  it("an issue set aside folds away until someone else comments, and comes back on asking", () => {
    const cache = { prs: [], since: {}, issues: [issue({ number: 1, assignedAt: ts(1) }), issue({ number: 2, assignedAt: ts(2), lastOther: { by: "kim", at: ts(3) } })] };
    setIssueAside("github.com/kim/game#1", true);
    setIssueAside("github.com/kim/game#2", true);
    let views = issueViews(cache, readState());
    expect(views.map((v) => [v.number, v.aside])).toEqual([[2, true], [1, true]]);
    // a later comment by someone else brings it back
    cache.issues[1] = { ...cache.issues[1]!, lastOther: { by: "kim", at: "2099-01-01T00:00:00Z" } };
    views = issueViews(cache, readState());
    expect(views.map((v) => [v.number, v.aside])).toEqual([[2, false], [1, true]]);
    setIssueAside("github.com/kim/game#1", false);
    expect(issueViews(cache, readState()).every((v) => !v.aside)).toBe(true);
    expect(() => setIssueAside("github.com/kim/game#1", false)).toThrow(/not set aside/);
  });

  it("finds the project of an issue by the repository its folders push to", () => {
    expect(remoteRepo("git@github.com:kg/ScubaDivingSimulator.git")).toBe("github.com/kg/scubadivingsimulator");
    expect(remoteRepo("https://github.com/acme/app")).toBe("github.com/acme/app");
    expect(remoteRepo("ssh://git@ghe.example.com:22/acme/app.git")).toBe("ghe.example.com/acme/app");
    const repo = path.join(home, "game");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:kim/game.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    // a worktree points at the main checkout's git folder
    const wt = path.join(home, "game-wt");
    fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
    addProject("game", [wt]);
    expect(projectRepos(readState()).get("github.com/kim/game")).toBe("game");
  });

  it("takes an issue as a URL or owner/repo#N", () => {
    expect(parseIssueRef("https://github.com/kim/game/issues/21")?.key).toBe("github.com/kim/game#21");
    expect(parseIssueRef("kim/game#21")?.key).toBe("github.com/kim/game#21");
    expect(parseIssueRef("nonsense")).toBeUndefined();
  });
});
