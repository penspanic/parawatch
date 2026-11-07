import { describe, expect, it } from "vitest";
import { readClaudeTail } from "../src/adapters/claudeCode.js";
import { parentFromCwd, promptFromRaw, readCodexLog } from "../src/adapters/codex.js";
import { activeMinutes, timestampsIn, textValues } from "../src/adapters/jsonl.js";

const ts = (m: number) => new Date(Date.UTC(2026, 10, 7, 1, m)).toISOString();

const user = (m: number, content: unknown) => ({ type: "user", timestamp: ts(m), cwd: "/work/app", message: { role: "user", content } });
const assistant = (m: number, content: unknown[]) => ({ type: "assistant", timestamp: ts(m), message: { role: "assistant", content } });

describe("claude code transcripts", () => {
  it("a pending tool call means working, with the tool as the action", () => {
    const r = readClaudeTail(
      [
        user(0, "fix the build"),
        { type: "custom-title", customTitle: "Build fixer" },
        assistant(1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run tests", timeout: 600000 } }]),
      ],
      "session",
    );
    expect(r).toMatchObject({ state: "working", action: "Bash: Run tests", title: "Build fixer", cwd: "/work/app", pendingTimeoutMs: 600000 });
    expect(r.lastActivity).toBe(ts(1));
  });

  it("a final text reply means idle for a session and done for a subagent", () => {
    const recs = [user(0, "hi"), assistant(1, [{ type: "text", text: "All done." }])];
    expect(readClaudeTail(recs, "session").state).toBe("idle");
    expect(readClaudeTail(recs, "subagent")).toMatchObject({ state: "done", action: "All done." });
  });

  it("a tool result waiting for the model means working", () => {
    const r = readClaudeTail([assistant(1, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }]), user(2, [{ type: "tool_result", tool_use_id: "t1", content: "..." }])], "session");
    expect(r).toMatchObject({ state: "working", action: "thinking" });
  });

  it("ignores meta records when judging state", () => {
    const r = readClaudeTail([assistant(1, [{ type: "text", text: "ok" }]), { ...user(2, "<local-command-caveat>"), isMeta: true }], "session");
    expect(r.state).toBe("idle");
  });
});

describe("codex logs", () => {
  const meta = { type: "session_meta", timestamp: ts(0), payload: { id: "01a1-x", cwd: "/private/tmp/claude-501/-Users-pp-space/811a9612-ec61-462a-a43c-6f9aca9b4ef4/scratchpad/141", originator: "codex_exec", source: "exec" } };
  const msg = (role: string, ...texts: string[]) => ({ type: "response_item", timestamp: ts(1), payload: { type: "message", role, content: texts.map((t) => ({ type: "input_text", text: t })) } });

  it("finds the real prompt behind injected context and the parent session", () => {
    const run = readCodexLog([meta, msg("user", "<environment_context>…</environment_context>"), msg("user", "<image name=[Image #1]>", "Generate the images")], []);
    expect(run).toMatchObject({ runtime: "codex", kind: "exec", title: "Generate the images", parent: "811a9612-ec61-462a-a43c-6f9aca9b4ef4" });
  });

  it("task_complete after task_started means done; a later start means working again", () => {
    const started = { type: "event_msg", timestamp: ts(2), payload: { type: "task_started" } };
    const call = { type: "response_item", timestamp: ts(3), payload: { type: "custom_tool_call", name: "exec", input: '{"cmd":"swift test"}' } };
    const done = { type: "event_msg", timestamp: ts(4), payload: { type: "task_complete", last_agent_message: "Tests pass." } };
    expect(readCodexLog([meta], [started, call, done])).toMatchObject({ state: "done", action: "Tests pass.", lastActivity: ts(4) });
    expect(readCodexLog([meta], [started, call])).toMatchObject({ state: "working", action: "exec: swift test" });
  });

  it("reads a prompt from a line cut off by inline images", () => {
    const line = `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<image name=[Image #1]>"},{"type":"input_text","text":"Make \\"three\\" icons"}`;
    expect(textValues(line)).toEqual(["<image name=[Image #1]>", 'Make "three" icons']);
    expect(promptFromRaw(line)).toBe('Make "three" icons');
  });

  it("parent only comes from a scratch path that carries a session id", () => {
    expect(parentFromCwd("/Users/me/dev/app")).toBeUndefined();
  });
});

describe("activity", () => {
  it("lists the minutes in the last hour that saw records, ascending", () => {
    const now = Date.parse("2026-11-07T12:00:30Z");
    const text = [
      { timestamp: "2026-11-07T12:00:10Z" },
      { timestamp: "2026-11-07T11:59:50Z" },
      { timestamp: "2026-11-07T11:58:00Z" },
      { timestamp: "2026-11-07T11:30:00Z", message: { content: 'quoted "timestamp":"x" inside text' } },
      { timestamp: "2026-11-07T10:30:00Z" },
      { note: "no timestamp" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(activeMinutes(timestampsIn(text), now)).toEqual([0, 2, 30]);
  });
});
