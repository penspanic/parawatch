// Which agent a command belongs to when a Claude Code session and a Codex thread both left their ids.
import { describe, expect, it } from "vitest";
import { callingSession, isCodex, nearestAgent, processTable, type ProcessTable } from "../src/core/caller.js";

const CLAUDE = "7fb2b866-824b-443c-aac7-f12055489674";
const CODEX = "01a1fd8e-c7a4-7b82-a812-ab1fc12d3aa6";

/** pid → [parent, command], from the top: launchd, the Claude app, its claude, a shell, ... */
function table(rows: [number, number, string][]): ProcessTable {
  return new Map(rows.map(([pid, ppid, command]) => [pid, { ppid, command }]));
}

// a Claude Code session (212) whose shell (300) runs `codex exec` (310), whose shell (320) runs parawatch
const worker = table([
  [1, 0, "/sbin/launchd"],
  [212, 1, "/Users/me/Library/Application Support/Claude/claude-code/2.1.328/claude.app/Contents/MacOS/claude"],
  [300, 212, "/bin/zsh -c codex exec ..."],
  [310, 300, "/opt/homebrew/Caskroom/codex/0.170.0/bin/codex exec --skip-git-repo-check fix it"],
  [320, 310, "/bin/zsh -lc parawatch claim"],
]);

describe("the calling session", () => {
  it("is the only one set", () => {
    expect(callingSession({ CLAUDE_CODE_SESSION_ID: CLAUDE }, () => new Map(), 1)).toBe(CLAUDE);
    expect(callingSession({ CODEX_THREAD_ID: CODEX }, () => new Map(), 1)).toBe(CODEX);
    expect(callingSession({}, () => new Map(), 1)).toBeUndefined();
  });

  it("is the Codex worker a Claude Code session launched, not the session", () => {
    const env = { CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_THREAD_ID: CODEX, CLAUDE_PID: "212" };
    expect(callingSession(env, () => worker, 320)).toBe(CODEX);
  });

  it("is the Claude Code session started from a Codex shell", () => {
    const t = table([
      [1, 0, "/sbin/launchd"],
      [500, 1, "codex"],
      [510, 500, "/bin/bash"],
      [520, 510, "claude --resume x"],
      [530, 520, "/bin/zsh -c parawatch claim"],
    ]);
    expect(callingSession({ CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_THREAD_ID: CODEX, CLAUDE_PID: "520" }, () => t, 530)).toBe(CLAUDE);
    // an older Claude Code without CLAUDE_PID is known by its name
    expect(nearestAgent(t, 530)).toBe("claude");
  });

  it("is the Codex thread when the process tree cannot be read (Codex's sandbox refuses ps)", () => {
    expect(callingSession({ CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_THREAD_ID: CODEX, CLAUDE_PID: "212" }, () => new Map(), 320)).toBe(CODEX);
  });

  it("knows Codex by its program, on any platform and through node", () => {
    expect(isCodex("/opt/homebrew/bin/codex exec x")).toBe(true);
    expect(isCodex('"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" exec x')).toBe(true);
    expect(isCodex("node /usr/lib/node_modules/@openai/codex/bin/codex.js exec")).toBe(true);
    expect(isCodex("/bin/zsh -c codex exec ...")).toBe(false);
    expect(isCodex("codex-exec-server")).toBe(false);
  });

  it("reads this machine's process tree", () => {
    const t = processTable();
    expect(t.get(process.pid)?.ppid).toBe(process.ppid);
  });
});
