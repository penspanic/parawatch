import { describe, expect, it } from "vitest";
import { cardRows, clean, fit, runsTree, textWidth, type View } from "../src/core/format.js";
import type { Card, Run } from "../src/core/types.js";

const v = (width: number, extra: Partial<View> = {}): View => ({ color: false, width, wide: false, all: false, ...extra });
const now = Date.parse("2026-11-07T03:00:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, runtime: "claude-code", kind: "session", title: id, state: "working", lastActivity: at(0), ...extra });

describe("terminal text", () => {
  it("counts Korean and CJK as two columns", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("구슬")).toBe(4);
    expect(textWidth(fit("옆에서 보는 유리통", 9))).toBeLessThanOrEqual(9);
    expect(fit("short", 10)).toBe("short");
  });

  it("turns an agent message into one plain line", () => {
    expect(clean("- **원인**: 통에 `n` 이\n\n[결과](a.md) 참고")).toBe("원인: 통에 n 이 결과 참고");
  });
});

describe("runs tree", () => {
  const runs: Run[] = [
    run("lead-1", { project: "game", role: "lead", title: "Game Director", state: "idle", action: "**Done.** 다음은 구슬을 더 넣는 것입니다. ".repeat(5) }),
    run("sub-1", { project: "game", kind: "subagent", parent: "lead-1", title: "139 shake", action: "Bash: npm test" }),
    run("sub-2", { project: "game", kind: "subagent", parent: "lead-1", title: "137 tank", state: "done", lastActivity: at(30) }),
    run("sub-3", { project: "game", kind: "subagent", parent: "lead-1", title: "136 cup", state: "done", lastActivity: at(40) }),
    run("loose", { title: "Somewhere else" }),
  ];

  it("keeps every line inside the terminal and folds old finished children", () => {
    for (const width of [60, 80, 140]) {
      const lines = runsTree(runs, v(width), now).split("\n");
      for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(width);
      expect(lines).toContainEqual(expect.stringContaining("✓ 2 finished"));
      expect(lines.some((l) => l.includes("137 tank"))).toBe(false);
    }
  });

  it("draws children as a tree and unregistered runs last", () => {
    const lines = runsTree(runs, v(100), now).split("\n");
    expect(lines[0]).toBe("game");
    expect(lines[2]).toMatch(/^ {2}├ ● 139 shake/);
    expect(lines[3]).toMatch(/^ {2}└ ✓ 2 finished/);
    expect(lines[4]).toMatch(/^other/);
    expect(runsTree(runs, v(100, { all: true }), now)).toContain("137 tank");
  });

  it("lines up the age column", () => {
    const lines = runsTree(runs, v(100), now).split("\n").filter((l) => /\d+[smhd]\b/.test(l));
    const ends = lines.map((l) => {
      const m = / +\d+[smhd]\b/.exec(l)!;
      return textWidth(l.slice(0, m.index + m[0].length));
    });
    const cols = new Set(ends);
    expect(cols.size).toBe(1);
  });
});

describe("card rows", () => {
  it("aligns ids, kinds and projects and stays inside the terminal", () => {
    const card = (id: string, kind: Card["kind"], project: string, title: string): Card => ({ id, kind, project, title, openedAt: at(5), status: "open", answers: [], comments: [] });
    const rows = cardRows([card("c1", "decide", "game", "Which ending?"), card("c12", "block", "app", "아이패드 시뮬레이터 런타임을 설치해 주세요 ".repeat(4))], v(70), now);
    for (const r of rows) expect(textWidth(r)).toBeLessThanOrEqual(70);
    expect(rows[0]!.indexOf("decide")).toBe(rows[1]!.indexOf("blocked"));
  });
});
