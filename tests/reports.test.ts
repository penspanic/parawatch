// What users saw go wrong in `status` on 0.3.8, each checked against the fix.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callingSubagent, claudeCode, createdPrUrl, readClaudeTail, runsGhPrCreate } from "../src/adapters/claudeCode.js";
import { ghCandidates, ghCommand, githubFailing, readCache, resetGithubProcess, syncGithub, type GhRunner } from "../src/core/github.js";
import { answerCard, commentCard, linkPr, openCard, readState } from "../src/core/ops.js";
import { applyPrompts, readPrompt, recordPrompt } from "../src/core/prompts.js";
import { snapshot } from "../src/core/snapshot.js";
import { fold } from "../src/core/state.js";
import { eventFiles, homeDir, readEvents } from "../src/core/store.js";
import type { Run } from "../src/core/types.js";
import { parsePrRef } from "../src/core/github.js";
import { freshHome } from "./helpers.js";

beforeEach(() => {
  freshHome();
  delete process.env.PARAWATCH_GITHUB;
  resetGithubProcess();
});

const ts = (m: number) => new Date(Date.UTC(2026, 10, 12, 1, m)).toISOString();
const user = (m: number, content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", timestamp: ts(m), message: { role: "user", content }, ...extra });
const assistant = (m: number, content: unknown[]) => ({ type: "assistant", timestamp: ts(m), message: { role: "assistant", content } });
const writeLog = (file: string, recs: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

describe("GitHub read by a process that cannot run gh", () => {
  const ok: GhRunner = async (args) => {
    if (args[0] === "auth") return JSON.stringify({ hosts: { "github.com": [{ state: "success" }] } });
    return JSON.stringify({ data: { viewer: { login: "me" }, mine: { nodes: [] }, asked: { nodes: [] } } });
  };
  const missing: GhRunner = async () => {
    throw new Error("spawn gh ENOENT");
  };

  it("keeps the last good reading, so a process whose gh works reads at once", async () => {
    const state = () => fold(readEvents());
    await syncGithub({ state: state(), gh: ok });
    const good = readCache().fetchedAt!;
    // the app, opened from Finder, cannot run gh
    const failed = await syncGithub({ state: state(), gh: missing, force: true });
    expect(failed).toMatchObject({ fetchedAt: good, hosts: ["github.com"], failedBy: "the command line" });
    expect(failed.error).toMatch(/not installed/);
    expect(githubFailing(failed)).toBe(true);
    expect(snapshot().github).toMatchObject({ enabled: true, failing: true });
    // the failing process waits the interval before it tries again
    let tried = false;
    await syncGithub({ state: state(), gh: async (a) => ((tried = true), ok(a)) });
    expect(tried).toBe(false);
    // another process (an agent's wait) is not held back by the failure: it reads, and the failure clears
    resetGithubProcess();
    const cache = JSON.parse(fs.readFileSync(path.join(homeDir(), "github.json"), "utf8"));
    cache.fetchedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(homeDir(), "github.json"), JSON.stringify(cache));
    const again = await syncGithub({ state: state(), gh: ok });
    expect(again.fetchedAt! > cache.fetchedAt).toBe(true);
    expect(githubFailing(again)).toBe(false);
    expect(snapshot().github?.failing).toBeUndefined();
  });

  it("says not signed in apart from not found", async () => {
    const signedOut: GhRunner = async () => JSON.stringify({ hosts: { "github.com": [{ state: "failure" }] } });
    const c = await syncGithub({ state: fold(readEvents()), gh: signedOut, force: true });
    expect(c.error).toBe("gh is not signed in");
  });

  it("looks for gh where it is usually installed, or where config.json says", () => {
    expect(ghCandidates("darwin")).toContain("/opt/homebrew/bin/gh");
    expect(ghCandidates("win32", { ProgramFiles: "C:\\Program Files" })[0]).toMatch(/GitHub CLI[\\/]gh\.exe$/);
    fs.writeFileSync(path.join(homeDir(), "config.json"), JSON.stringify({ github: { cli: "/somewhere/gh" } }));
    expect(ghCommand()).toBe("/somewhere/gh");
  });
});

describe("a subagent that handed its report back", () => {
  const handback = [
    user(0, "review the diff"),
    assistant(1, [{ type: "tool_use", id: "h1", name: "SubagentHandback", input: { report: "Two findings." } }]),
    user(2, [{ type: "tool_result", tool_use_id: "h1", content: "Report delivered to your caller" }]),
  ];

  it("is done, not thinking", () => {
    expect(readClaudeTail(handback, "subagent")).toMatchObject({ state: "done", action: "handed its report back" });
    // a failed hand-back is not an end
    const failed = [...handback.slice(0, 2), user(2, [{ type: "tool_result", tool_use_id: "h1", is_error: true, content: "no caller" }])];
    expect(readClaudeTail(failed, "subagent").state).toBe("working");
    // a session calling a tool of that name is not a subagent ending
    expect(readClaudeTail(handback, "session").state).toBe("working");
  });

  it("is done when its meta file says finished, however its log ends", () => {
    const dir = path.join(homeDir(), "claude");
    const sub = path.join(dir, "-work-app", "sess", "subagents");
    const log = path.join(sub, "agent-r1.jsonl");
    writeLog(log, [user(0, "review"), assistant(1, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }]), user(2, [{ type: "tool_result", tool_use_id: "t1", content: "x" }])]);
    const scan = () => claudeCode.scan({ now: Date.parse(ts(2)) + 45 * 60_000, sinceMs: 0 } as Parameters<typeof claudeCode.scan>[0]).find((r) => r.id === "r1")!;
    expect(scan().state).toBe("stalled");
    fs.writeFileSync(log.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ description: "Review", finished: true }));
    expect(scan()).toMatchObject({ state: "done", action: "finished", title: "Review" });
    // a meta file older than the log (the subagent was resumed) does not end it
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(log.replace(/\.jsonl$/, ".meta.json"), old, old);
    expect(scan().state).toBe("stalled");
  });
});

describe("an answer without a choice", () => {
  it("goes back to the human once the agent replies", () => {
    const c = openCard({ kind: "decide", project: "api", title: "Merge it?", options: ["Do it", "Don't"] });
    answerCard(c.id, { comment: "what does it change?" });
    expect(readState().cards.get(c.id)!.status).toBe("answered");
    commentCard(c.id, "It drops the old flag. Please choose.", "agent");
    expect(readState().cards.get(c.id)!.status).toBe("open");
    answerCard(c.id, { choice: 1 });
    expect(readState().cards.get(c.id)!.status).toBe("answered");
    // after a real choice, the agent's comment does not reopen it
    commentCard(c.id, "Merging.", "agent");
    expect(readState().cards.get(c.id)!.status).toBe("answered");
  });

  it("an open question answered in words stays answered", () => {
    const c = openCard({ kind: "decide", project: "api", title: "Which name?" });
    answerCard(c.id, { comment: "Parawatch" });
    commentCard(c.id, "Thanks.", "agent");
    expect(readState().cards.get(c.id)!.status).toBe("answered");
  });
});

describe("a question in chat the human answered", () => {
  it("is cleared by any message the log marks as the human's", () => {
    const recs = [
      user(0, "ship it"),
      assistant(1, [{ type: "tool_use", id: "w1", name: "mcp__ccd_turn__wrap_up", input: { recap: "PR open.", ask: "Mark it breaking?" } }]),
      user(2, [{ type: "tool_result", tool_use_id: "w1", content: "ok" }]),
      assistant(3, [{ type: "text", text: "Ready." }]),
    ];
    expect(readClaudeTail(recs, "session").asks?.text).toBe("Mark it breaking?");
    // the reply starts with a tag (a pasted block), so it is not read as a prompt, but the human sent it
    const reply = user(4, [{ type: "text", text: "<pasted_content>yes, breaking</pasted_content>" }], { origin: { kind: "human" } });
    const after = [...recs, reply, assistant(5, [{ type: "text", text: "Marked it breaking." }])];
    expect(readClaudeTail(after, "session").asks).toBeUndefined();
  });
});

describe("pull requests a session opened", () => {
  it("only a command that runs gh pr create counts", () => {
    expect(runsGhPrCreate("gh pr create --fill")).toBe(true);
    expect(runsGhPrCreate("cd /work/api && git push -u origin HEAD && gh pr create --title x --body-file b.md")).toBe(true);
    expect(runsGhPrCreate('url=$(gh pr create --fill) && echo "$url"')).toBe(true);
    expect(runsGhPrCreate("GH_HOST=ghe.example.com /opt/homebrew/bin/gh pr create --fill")).toBe(true);
    expect(runsGhPrCreate('grep -n "render\\|gh pr create\\|/ci run" SKILL.md')).toBe(false);
    expect(runsGhPrCreate("rg 'gh pr create' docs")).toBe(false);
    expect(runsGhPrCreate("git commit -F - <<'EOF'\nDocument gh pr create\nEOF")).toBe(false);
    expect(runsGhPrCreate("echo gh pr create")).toBe(false);
  });

  it("takes the URL gh prints on its own line, not every URL in the output", () => {
    expect(createdPrUrl("Creating pull request for x into main\n\nhttps://github.com/acme/api/pull/88\n")).toBe("https://github.com/acme/api/pull/88");
    expect(createdPrUrl("see https://github.com/acme/api/pull/7 for an example")).toBeUndefined();
  });

  it("a wrong automatic link gives way to the session that opened the PR; a manual one does not", () => {
    const dir = path.join(homeDir(), "claude", "-work-api");
    const now = Date.now();
    const at = (m: number) => new Date(now - (30 - m) * 60_000).toISOString();
    const rec = (m: number, type: string, content: unknown) => ({ type, timestamp: at(m), cwd: "/work/api", message: { role: type, content } });
    // the session that opened #88
    writeLog(path.join(dir, "owner-1111.jsonl"), [
      rec(0, "user", "open the PR"),
      rec(1, "assistant", [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "gh pr create --fill" } }]),
      rec(2, "user", [{ type: "tool_result", tool_use_id: "c1", content: "https://github.com/acme/api/pull/88\n" }]),
      rec(3, "assistant", [{ type: "text", text: "Opened." }]),
    ]);
    // a session that only searched for the words, read wrongly by 0.3.8 and linked first
    writeLog(path.join(dir, "other-2222.jsonl"), [
      rec(0, "user", "check the skill"),
      rec(1, "assistant", [{ type: "tool_use", id: "g1", name: "Bash", input: { command: 'grep -n "gh pr create" SKILL.md' } }]),
      rec(2, "user", [{ type: "tool_result", tool_use_id: "g1", content: "12: gh pr create\nhttps://github.com/acme/api/pull/88\n" }]),
      rec(3, "assistant", [{ type: "text", text: "Done." }]),
    ]);
    const pr = parsePrRef("https://github.com/acme/api/pull/88")!;
    linkPr({ pr, session: "other-2222", auto: true });
    snapshot();
    expect(readState().prLinks.get(pr.key)?.session).toBe("owner-1111");
    // a link the human or a lead made stays where they put it
    linkPr({ pr, session: "other-2222" });
    snapshot();
    expect(readState().prLinks.get(pr.key)?.session).toBe("other-2222");
  });
});

describe("a session held by a permission prompt", () => {
  const run = (extra: Partial<Run> = {}): Run => ({ id: "sess-1", runtime: "claude-code", kind: "session", title: "s", state: "stalled", pendingTool: true, lastActivity: ts(0), ...extra });

  it("the hook records the prompt, and the session asks the human, blocked", () => {
    expect(recordPrompt({ session_id: "sess-1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "jira transition -h", description: "Show help" } }, new Date(ts(1)))).toBe(true);
    expect(readPrompt("sess-1")).toMatchObject({ what: "Bash: Show help" });
    // the notification for the same prompt keeps the richer line
    recordPrompt({ session_id: "sess-1", hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }, new Date(ts(1)));
    expect(readPrompt("sess-1")!.what).toBe("Bash: Show help");
    const [r] = applyPrompts([run()]);
    expect(r).toMatchObject({ state: "idle", asks: { text: "approve a tool call: Bash: Show help", via: "permission", blocked: true } });
  });

  it("a prompt the log has moved past, or a run with no pending tool, asks nothing", () => {
    recordPrompt({ session_id: "sess-1", hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Edit" }, new Date(ts(1)));
    expect(applyPrompts([run({ lastActivity: ts(5) })])[0]!.asks).toBeUndefined();
    expect(applyPrompts([run({ pendingTool: false })])[0]!.asks).toBeUndefined();
    expect(applyPrompts([run()])[0]!.asks?.text).toBe("approve a tool call: Edit");
    // other notifications are not prompts
    expect(recordPrompt({ session_id: "sess-2", hook_event_name: "Notification", message: "Claude is waiting for your input" })).toBe(false);
  });

  it("without the hook, a stalled tool call says a prompt may be open", () => {
    const dir = path.join(homeDir(), "claude", "-work-app");
    writeLog(path.join(dir, "held-1.jsonl"), [user(0, "go"), assistant(1, [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "make", description: "Build" } }])]);
    const r = claudeCode.scan({ now: Date.parse(ts(1)) + 60 * 60_000, sinceMs: 0 } as Parameters<typeof claudeCode.scan>[0]).find((x) => x.id === "held-1")!;
    expect(r).toMatchObject({ state: "stalled", action: "Bash: Build · or a permission prompt is open", pendingTool: true });
  });
});

describe("issue 28: a peer's log a sync tool is replacing", () => {
  afterEach(() => vi.restoreAllMocks());
  const busy = (times: number, file: string) => {
    const real = fs.readFileSync;
    let left = times;
    return vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p) === file && left-- > 0) throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), { code: "EPERM" });
      return (real as (...a: unknown[]) => unknown)(p, o);
    }) as typeof fs.readFileSync);
  };

  it("is read again after a short pause", () => {
    openCard({ kind: "decide", project: "api", title: "One?" });
    const file = eventFiles()[0]!.file;
    busy(2, file);
    expect(readEvents().length).toBe(1);
  });

  it("still busy, the last reading stands in, and nothing throws", () => {
    openCard({ kind: "decide", project: "api", title: "One?" });
    const file = eventFiles()[0]!.file;
    expect(readEvents().length).toBe(1);
    busy(100, file);
    expect(readEvents().length).toBe(1);
  });

  it("other errors still surface", () => {
    openCard({ kind: "decide", project: "api", title: "One?" });
    const file = eventFiles()[0]!.file;
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p) === file) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return (real as (...a: unknown[]) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    expect(() => readEvents()).toThrow(/EIO/);
  });
});

describe("a claim from a subagent", () => {
  const pending = (m: number, cmd: string) => assistant(m, [{ type: "tool_use", id: `b${m}`, name: "Bash", input: { command: cmd } }]);
  const now = () => Date.parse(ts(10));
  const setup = () => {
    const dir = path.join(homeDir(), "claude", "-work-app");
    const own = path.join(dir, "lead-1111.jsonl");
    const sub = path.join(dir, "lead-1111", "subagents", "agent-w42.jsonl");
    const touch = (f: string) => fs.utimesSync(f, new Date(now()), new Date(now()));
    return { own, sub, touch };
  };

  it("is the subagent's when the subagent's log is the one running parawatch claim", () => {
    const { own, sub, touch } = setup();
    writeLog(own, [user(0, "lead"), pending(1, "sleep 100 # waiting on workers")]);
    writeLog(sub, [user(2, "work"), pending(9, 'parawatch claim -p api -t T-1 --title "Worker"')]);
    touch(own);
    touch(sub);
    expect(callingSubagent("lead-1111", /\bparawatch\b.*\bclaim\b/, now())).toBe("w42");
  });

  it("is the session's own when the session runs it", () => {
    const { own, sub, touch } = setup();
    writeLog(own, [user(0, "lead"), pending(9, "parawatch claim -p api --role lead")]);
    writeLog(sub, [user(2, "work"), pending(3, "parawatch claim -p api -t T-1"), user(4, [{ type: "tool_result", tool_use_id: "b3", content: "ok" }])]);
    touch(own);
    touch(sub);
    expect(callingSubagent("lead-1111", /\bparawatch\b.*\bclaim\b/, now())).toBeUndefined();
  });
});

describe("a file the card names that is not on this machine", () => {
  it("is listed as missing in the snapshot; files that are here are not", () => {
    const here = path.join(homeDir(), "shot.png");
    fs.writeFileSync(here, "png");
    const c = openCard({ kind: "try", project: "api", title: "Look", attach: [here, "/no/such/folder/late.png", "https://example.com/x"], open: ["C:\\Games\\Build.exe"] });
    const s = snapshot().cards.find((x) => x.id === c.id)!;
    expect(s.missing).toEqual(["/no/such/folder/late.png", "C:\\Games\\Build.exe"]);
    expect(readState().cards.get(c.id)!.missing).toBeUndefined();
  });
});
