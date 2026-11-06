import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BEGIN, END, hookContext, writeInstructions } from "../src/core/integrate.js";
import { addProject, answerCard, claimSession, openCard } from "../src/core/ops.js";
import { freshHome } from "./helpers.js";

beforeEach(() => {
  freshHome();
});

describe("init", () => {
  it("adds the block once and replaces it in place", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pw-init-")), "AGENTS.md");
    fs.writeFileSync(file, "# Rules\n\nBe kind.\n");
    expect(writeInstructions(file, "game")).toBe(true);
    expect(writeInstructions(file, "game")).toBe(false);
    expect(writeInstructions(file, "other")).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("# Rules\n\nBe kind.\n")).toBe(true);
    expect(text.split(BEGIN)).toHaveLength(2);
    expect(text.split(END)).toHaveLength(2);
    expect(text).toContain("--project other");
    expect(text).not.toContain("--project game");
  });
});

describe("claude code hook", () => {
  it("says nothing until the human answers, then names the answer", () => {
    addProject("game", ["/work/game"]);
    openCard({ kind: "decide", project: "game", title: "Which ending?", options: ["a", "b"] });
    expect(hookContext({ cwd: "/work/game" })).toBeUndefined();
    answerCard("c1", { choice: 2 });
    expect(hookContext({ cwd: "/work/game/src" })).toContain('c1 "Which ending?" chose 2 (b)');
    expect(hookContext({ cwd: "/elsewhere" })).toBeUndefined();
  });

  it("finds the project from a claimed session id", () => {
    claimSession({ session: "abcdef12", project: "game" });
    openCard({ kind: "block", project: "game", title: "Install Xcode" });
    answerCard("c1", { comment: "installed" });
    expect(hookContext({ session_id: "abcdef12-3456", cwd: "/vault" })).toContain("installed");
  });
});
