import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cannotSend, chatItem, findCodex, liveLine, readChat, readChatLines, resumeArgs } from "../src/core/codexChat.js";

const T = "2026-11-14T03:00:00.000Z";
const meta = (over: Record<string, unknown> = {}) => ({ timestamp: T, type: "session_meta", payload: { id: "019a-1", cwd: "/work/app", originator: "codex_exec", source: "exec", ...over } });
const ctx = (over: Record<string, unknown> = {}) => ({
  timestamp: T,
  type: "turn_context",
  payload: {
    cwd: "/work/app",
    model: "gpt-test",
    effort: "low",
    approval_policy: "never",
    sandbox_policy: { type: "workspace-write", network_access: false },
    file_system_sandbox_policy: {
      kind: "restricted",
      entries: [
        { path: { type: "special", value: { kind: "root" } }, access: "read" },
        { path: { type: "path", path: "/work/app" }, access: "write" },
        { path: { type: "path", path: "/work/shared" }, access: "write" },
        { path: { type: "path", path: "/work/app/.git" }, access: "read" },
      ],
    },
    ...over,
  },
});
const ev = (payload: Record<string, unknown>) => ({ timestamp: T, type: "event_msg", payload });
const done = (item: Record<string, unknown>) => ev({ type: "item_completed", item });

describe("reading a Codex conversation", () => {
  it("shows what was asked, said, run and changed, and what the session ran with", () => {
    const lines = [
      meta(),
      ev({ type: "task_started" }),
      ctx(),
      done({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "Fix the login" }, { type: "local_image", path: "/a.png" }] }),
      done({ type: "Reasoning", id: "r1", summary_text: [] }),
      done({ type: "AgentMessage", id: "a1", phase: "commentary", content: [{ type: "Text", text: "Looking at it" }] }),
      done({ type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "npm test"], aggregated_output: "1 failed\n", exit_code: 1, status: "failed", duration: { secs: 2, nanos: 500_000_000 } }),
      done({ type: "FileChange", id: "f1", changes: { "/work/app/login.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b" } } }),
      done({ type: "McpToolCall", id: "t1", server: "codex_apps", tool: "drive.search", appName: "Google Drive", actionName: "search", arguments: { q: "x" }, status: "completed" }),
      done({ type: "ImageView", id: "i1", path: "file:///tmp/shot%201.png" }),
      done({ type: "ContextCompaction", id: "k1" }),
      done({ type: "AgentMessage", id: "a2", content: [{ type: "Text", text: "Fixed." }] }),
      ev({ type: "task_complete", last_agent_message: "Fixed." }),
    ];
    const v = readChatLines(lines.slice(0, 1), lines, "/logs/x.jsonl");
    expect(v).toMatchObject({ id: "019a-1", origin: "exec", title: "Fix the login", working: false, earlier: 0 });
    expect(v.settings).toEqual({ cwd: "/work/app", model: "gpt-test", effort: "low", approval: "never", sandbox: "workspace-write", network: false, roots: ["/work/shared"] });
    expect(v.items).toEqual([
      { kind: "user", id: "u1", text: "Fix the login", images: 1, at: T },
      { kind: "agent", id: "a1", text: "Looking at it", commentary: true, at: T },
      { kind: "command", id: "c1", command: "npm test", output: "1 failed", exit: 1, status: "failed", seconds: 2.5, at: T },
      { kind: "files", id: "f1", files: [{ path: "/work/app/login.ts", change: "update", diff: "@@ -1 +1 @@\n-a\n+b" }], at: T },
      { kind: "tool", id: "t1", name: "Google Drive search", detail: '{"q":"x"}', status: "completed", at: T },
      { kind: "image", id: "i1", path: "/tmp/shot 1.png", at: T },
      { kind: "note", id: "k1", text: "Earlier conversation compacted", tone: "info", at: T },
      { kind: "agent", id: "a2", text: "Fixed.", at: T },
    ]);
  });

  it("is working between a turn's start and its end; a stop or an error shows as a note", () => {
    const working = readChatLines([meta()], [meta(), ev({ type: "task_started" }), done({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "go" }] })]);
    expect(working.working).toBe(true);
    const stopped = readChatLines([meta()], [meta(), ev({ type: "task_started" }), ev({ type: "turn_aborted" }), ev({ type: "error", message: "rate limited" })]);
    expect(stopped.working).toBe(false);
    expect(stopped.items.map((i) => i.kind === "note" && i.text)).toEqual(["Stopped", "rate limited"]);
  });

  it("a session from the Codex app says so", () => {
    expect(readChatLines([meta({ originator: "Codex Desktop", source: "vscode" })], []).origin).toBe("app");
  });

  it("logs without item events fall back to their messages, leaving out injected context", () => {
    const msg = (role: string, text: string) => ({ timestamp: T, type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
    const v = readChatLines([meta()], [meta(), msg("user", "<environment_context>…"), msg("user", "Hello"), msg("assistant", "Hi"), msg("developer", "rules")]);
    expect(v.items.map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([
      ["user", "Hello"],
      ["agent", "Hi"],
    ]);
  });

  it("shows the latest of a long conversation and counts the rest", () => {
    const lines = [meta(), ...Array.from({ length: 450 }, (_, i) => done({ type: "AgentMessage", id: `a${i}`, content: [{ type: "Text", text: `m${i}` }] }))];
    const v = readChatLines([meta()], lines);
    expect(v.items).toHaveLength(400);
    expect(v.earlier).toBe(50);
    expect(v.items[0]).toMatchObject({ text: "m50" });
  });

  it("long command output keeps its end; an unknown item still shows by its type", () => {
    const out = "x".repeat(7000) + "END";
    expect(chatItem({ type: "CommandExecution", id: "c", command: "ls", aggregated_output: out })).toMatchObject({ output: expect.stringMatching(/^…x+END$/) });
    expect(chatItem({ type: "WebSearch", id: "w" })).toEqual({ kind: "tool", id: "w", name: "WebSearch", at: undefined });
  });

  it("reads a log file from disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-chat-"));
    const file = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(file, [meta(), ctx(), done({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "hi" }] })].map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(readChat(file)).toMatchObject({ id: "019a-1", file, items: [{ kind: "user", text: "hi" }] });
  });
});

describe("continuing a Codex session", () => {
  const settings = { cwd: "/work/app", model: "gpt-test", effort: "low", sandbox: "workspace-write", network: true, roots: ["/work/shared", 'C:\\a "b"'] };

  it("resumes with the sandbox, folders and model the session last had, never asking, the message on stdin", () => {
    expect(resumeArgs("019a-1", settings)).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'sandbox_workspace_write.writable_roots=["/work/shared","C:\\\\a \\"b\\""]',
      "-m",
      "gpt-test",
      "-c",
      'model_reasoning_effort="low"',
      "019a-1",
      "-",
    ]);
  });

  it("a read-only or full-access session keeps that; an unknown sandbox is refused", () => {
    expect(resumeArgs("s", { sandbox: "read-only", roots: [] })).toContain('sandbox_mode="read-only"');
    expect(resumeArgs("s", { sandbox: "danger-full-access", roots: ["/x"] }).join(" ")).not.toContain("writable_roots");
    expect(() => resumeArgs("s", { sandbox: "external-sandbox", roots: [] })).toThrow(/does not know/);
    expect(() => resumeArgs("s", { roots: [] })).toThrow(/none recorded/);
  });

  it("is refused while Codex works on it or has it open elsewhere", () => {
    const view = { working: false, settings: { sandbox: "read-only", roots: [] } };
    expect(cannotSend(view, [])).toBeUndefined();
    expect(cannotSend(view, undefined)).toBeUndefined();
    expect(cannotSend({ ...view, working: true }, [])).toMatch(/working/);
    expect(cannotSend(view, [123])).toMatch(/open in Codex/);
    expect(cannotSend(view, [123], [123])).toBeUndefined();
  });

  it("says what Codex started while it answers", () => {
    expect(liveLine('{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc ls"}}')).toBe("Running /bin/zsh -lc ls");
    expect(liveLine('{"type":"item.started","item":{"type":"file_change"}}')).toBe("Editing files");
    expect(liveLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}')).toBeUndefined();
    expect(liveLine("not json")).toBeUndefined();
  });

  it("finds codex where an app started from the Dock would not look", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-bin-"));
    const bin = path.join(dir, "codex");
    fs.writeFileSync(bin, "");
    expect(findCodex({ PARAWATCH_CODEX_BIN: "/opt/x/codex" })).toBe("/opt/x/codex");
    expect(findCodex({ PATH: dir }, "darwin")).toBe(bin);
  });
});
