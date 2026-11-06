import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addProject, claimSession, startRun, endRun } from "../src/core/ops.js";
import { attribute, declaredRuns } from "../src/core/runs.js";
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
        run("loose", { cwd: "/vault", prompt: "Read /vault/notes/game/briefs/12.md and do it" }),
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

describe("declared runs", () => {
  it("reports start, note and end", () => {
    const id = startRun({ project: "game", title: "bake intro" });
    endRun(id, "failed", "out of memory");
    const [r] = declaredRuns(fold(readEvents()));
    expect(r).toMatchObject({ id: "r1", runtime: "declared", state: "failed", action: "out of memory" });
  });
});
