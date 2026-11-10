import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addProject, claimSession, hideRun, startRun, endRun, readState, unhideRun } from "../src/core/ops.js";
import { canonicalPath, insidePath, namesPath, samePath } from "../src/core/paths.js";
import { archivedSessions } from "../src/core/desktop.js";
import { attribute, collectRuns, declaredRuns, endArchived } from "../src/core/runs.js";
import { fold } from "../src/core/state.js";
import { readEvents } from "../src/core/store.js";
import type { Run } from "../src/core/types.js";
import { freshHome } from "./helpers.js";

beforeEach(() => {
  freshHome();
});

const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, runtime: "claude-code", kind: "session", title: id, state: "working", ...extra });

function gitRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-repo-")));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("attribution", () => {
  it("claims win, children follow their parent, prompts name a project", () => {
    addProject("game", ["/work/game"]);
    addProject("notes", ["/vault/notes/game"]);
    claimSession({ session: "aaaaaaaa", project: "game", role: "lead" });
    const runs = attribute(
      [
        run("aaaaaaaa-1111", { cwd: "/vault" }),
        run("child-1", { kind: "subagent", parent: "aaaaaaaa-1111", cwd: "/vault" }),
        // a prompt names a folder as this system writes it
        run("loose", { cwd: "/vault", prompt: `Read ${path.resolve("/vault/notes/game")}/briefs/12.md and do it` }),
        run("inside", { cwd: "/work/game/src" }),
        run("stranger", { cwd: "/elsewhere" }),
      ],
      fold(readEvents()),
    );
    const by = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(by["aaaaaaaa-1111"]).toMatchObject({ project: "game", role: "lead" });
    expect(by["child-1"]!.project).toBe("game");
    expect(by["loose"]!.project).toBe("notes");
    expect(by["inside"]!.project).toBe("game");
    expect(by["stranger"]!.project).toBeUndefined();
  });

  it("a git worktree of a project path belongs to that project", () => {
    const repo = gitRepo();
    const wt = `${repo}-wt`;
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt]);
    addProject("game", [repo]);
    const [r] = attribute([run("w", { cwd: path.join(wt, "src") })], fold(readEvents()));
    expect(r!.project).toBe("game");
  });

  it("a folder inside a bigger repo does not claim the whole repo", () => {
    const repo = gitRepo();
    const sub = path.join(repo, "projects", "game");
    fs.mkdirSync(sub, { recursive: true });
    addProject("game", [sub]);
    const runs = attribute([run("root", { cwd: repo }), run("deep", { cwd: path.join(sub, "x") })], fold(readEvents()));
    expect(runs.map((r) => r.project)).toEqual([undefined, "game"]);
  });
});

describe("paths", () => {
  it("compares folders by their real spelling, through parts that do not exist yet", () => {
    const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-paths-")));
    const link = `${real}-link`;
    fs.symlinkSync(real, link, "junction");
    expect(samePath(link, real)).toBe(true);
    expect(canonicalPath(path.join(link, "not", "yet"))).toBe(canonicalPath(path.join(real, "not", "yet")));
    expect(canonicalPath(path.join(link, "not", "yet")).endsWith(path.join("not", "yet"))).toBe(true);
    expect(insidePath(path.join(link, "src"), real)).toBe(true);
    expect(insidePath(`${real}-other`, real)).toBe(false);
  });

  it("finds a folder named in a prompt with either slash", () => {
    const dir = path.resolve("/work/game");
    expect(namesPath(`see ${dir.replace(/\\/g, "/")}/a.md`, dir)).toBe(true);
    expect(namesPath(`see ${dir.replace(/\//g, "\\")}\\a.md`, dir)).toBe(true);
    expect(namesPath("see /work/other", dir)).toBe(false);
  });
});

describe("claim --done", () => {
  it("ends an idle or stalled session, not a working one", () => {
    for (const id of ["idle0001", "stall001", "work0001"]) claimSession({ session: id, project: "game", done: "Merged #12" });
    const runs = attribute([run("idle0001-x", { state: "idle" }), run("stall001-x", { state: "stalled", action: "thinking" }), run("work0001-x", { state: "working" })], fold(readEvents()));
    expect(runs.map((r) => [r.state, r.done])).toEqual([
      ["done", "Merged #12"],
      ["done", "Merged #12"],
      ["working", "Merged #12"],
    ]);
  });

  it("stops counting once someone writes to the session again", () => {
    claimSession({ session: "stall002", project: "game", done: "Merged #12" });
    const [r] = attribute([run("stall002-x", { state: "stalled", lastPromptAt: "2999-01-01T00:00:00Z" })], fold(readEvents()));
    expect(r).toMatchObject({ state: "stalled" });
    expect(r!.done).toBeUndefined();
  });
});

describe("declared runs", () => {
  it("reports start, note and end", () => {
    const id = startRun({ project: "game", title: "bake intro" });
    endRun(id, "failed", "out of memory");
    const [r] = declaredRuns(fold(readEvents()));
    expect(r).toMatchObject({ id: "r1", runtime: "declared", state: "failed", action: "out of memory" });
  });

  it("is busy from start to end", () => {
    const now = Date.parse("2026-11-07T12:00:30Z");
    const state = fold(readEvents());
    state.runs.set("x", { id: "x", project: "game", title: "ci", startedAt: "2026-11-07T11:57:00Z", lastActivity: "2026-11-07T11:58:00Z", status: "running" });
    expect(declaredRuns(state, now).find((r) => r.id === "x")?.activity).toEqual([0, 1, 2, 3]);
  });
});

describe("archived desktop sessions", () => {
  function desktopDir(sessions: { local: string; cli: string; archived: boolean }[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-desktop-"));
    const sub = path.join(dir, "org", "user");
    fs.mkdirSync(sub, { recursive: true });
    for (const s of sessions) {
      fs.writeFileSync(path.join(sub, `local_${s.local}.json`), JSON.stringify({ sessionId: `local_${s.local}`, cliSessionId: s.cli, isArchived: s.archived, lastActivityAt: 1 }));
    }
    return dir;
  }

  it("knows which CLI sessions were archived, by full id or prefix", () => {
    const dir = desktopDir([
      { local: "a1", cli: "11111111-aaaa", archived: true },
      { local: "b1", cli: "22222222-bbbb", archived: false },
      // the same CLI session run again from a live desktop session is not archived
      { local: "c1", cli: "33333333-cccc", archived: true },
      { local: "c2", cli: "33333333-cccc", archived: false },
    ]);
    const isArchived = archivedSessions(dir);
    expect(isArchived("11111111-aaaa")).toBe(true);
    expect(isArchived("111111")).toBe(true);
    expect(isArchived("11111")).toBe(false);
    expect(isArchived("22222222-bbbb")).toBe(false);
    expect(isArchived("33333333-cccc")).toBe(false);
    expect(isArchived(undefined)).toBe(false);
  });

  it("reads a session file again when it changes", () => {
    const dir = desktopDir([{ local: "a1", cli: "44444444-dddd", archived: false }]);
    expect(archivedSessions(dir)("44444444-dddd")).toBe(false);
    const file = path.join(dir, "org", "user", "local_a1.json");
    fs.writeFileSync(file, JSON.stringify({ sessionId: "local_a1", cliSessionId: "44444444-dddd", isArchived: true }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(archivedSessions(dir)("44444444-dddd")).toBe(true);
  });

  it("an archived session is done, with its subagents, however its log ends", () => {
    const isArchived = (id: string) => id.startsWith("arch");
    const runs = endArchived(
      [
        run("arch-1", { state: "stalled", action: "thinking", asks: { text: "Merge it?", via: "text" } }),
        run("arch-child", { kind: "subagent", parent: "arch-1", state: "working" }),
        run("arch-codex", { runtime: "codex", state: "working" }),
        run("arch-remote", { state: "working", device: "pc" }),
        run("live-1", { state: "working" }),
      ],
      isArchived,
    );
    const by = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(by["arch-1"]).toMatchObject({ state: "done", done: "archived in the Claude app" });
    expect(by["arch-1"]!.asks).toBeUndefined();
    expect(by["arch-child"]!.state).toBe("done");
    // only Claude Code sessions on this machine are read from this machine's desktop app
    expect(by["arch-codex"]!.state).toBe("working");
    expect(by["arch-remote"]!.state).toBe("working");
    expect(by["live-1"]!.state).toBe("working");
  });

  it("keeps the summary a session gave with claim --done", () => {
    const [r] = endArchived([run("arch-2", { state: "idle", done: "Merged #12" })], () => true);
    expect(r).toMatchObject({ state: "done", done: "Merged #12" });
  });
});

describe("hiding runs", () => {
  const list = (all = false, now = Date.now()) => collectRuns(readState(), { sinceHours: 24, runtimes: ["none"], includeEnded: all, keepRepeats: true }, now).map((r) => r.id);

  it("a hidden run leaves the list, --all still shows it, and it comes back when it does something new", () => {
    const a = startRun({ project: "game", title: "bake" });
    const b = startRun({ project: "game", title: "bench" });
    expect(list().sort()).toEqual([a, b].sort());
    expect(hideRun(a.slice(0, 6))).toBe(a);
    expect(list()).toEqual([b]);
    expect(list(true).sort()).toEqual([a, b].sort());
    unhideRun(a);
    expect(list().sort()).toEqual([a, b].sort());
    hideRun(a);
    expect(list()).toEqual([b]);
    // activity after the hide brings it back
    const events = readEvents();
    const hideTs = events.filter((e) => e.type === "run.hide").at(-1)!.ts;
    const state = readState();
    state.runs.get(a)!.lastActivity = new Date(Date.parse(hideTs) + 1000).toISOString();
    expect(collectRuns(state, { sinceHours: 24, runtimes: ["none"], keepRepeats: true }).map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it("children of a hidden run are hidden with it", () => {
    const parent = startRun({ project: "game", title: "parent" });
    const child = startRun({ project: "game", title: "child", parent });
    hideRun(parent);
    expect(list()).toEqual([]);
    expect(list(true).sort()).toEqual([parent, child].sort());
    unhideRun(parent);
    expect(list().sort()).toEqual([parent, child].sort());
  });

  it("asks for an id that exists and is not ambiguous", () => {
    startRun({ project: "game", title: "one" });
    expect(() => hideRun("nothing-here")).toThrow(/no run/);
    expect(() => hideRun("r")).toThrow(/6 characters/);
  });
});
