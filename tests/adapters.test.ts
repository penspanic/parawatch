import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyStall, claudeCode, newestMtime, readClaudeTail } from "../src/adapters/claudeCode.js";
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

  it("a stopped turn is over: idle for a session, done for a subagent", () => {
    const recs = [
      user(0, "run the scene tests"),
      assistant(1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "until grep -q PASSED log; do sleep 20; done" } }]),
      user(2, [{ type: "tool_result", tool_use_id: "t1", content: "The user doesn't want to proceed with this tool use.", is_error: true }]),
      user(2, [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    ];
    expect(readClaudeTail(recs, "subagent")).toMatchObject({ state: "done", action: "interrupted" });
    const session = readClaudeTail(recs, "session");
    expect(session).toMatchObject({ state: "idle", action: "interrupted" });
    // the stop is not a prompt from the human
    expect(session.lastPromptAt).toBe(ts(0));
  });

  it("a new prompt after a stop means working again", () => {
    const r = readClaudeTail([user(0, "go"), user(1, [{ type: "text", text: "[Request interrupted by user]" }]), user(3, "try the other way")], "session");
    expect(r).toMatchObject({ state: "working", action: "reading a new message", lastPromptAt: ts(3) });
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

describe("background jobs", () => {
  const OUT = "/tmp/claude-1/proj/sess/tasks/bjob1.output";
  const bash = assistant(1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node tour.js", run_in_background: true } }]);
  const started = user(2, [
    { type: "tool_result", tool_use_id: "t1", content: `Command running in background with ID: bjob1. Output is being written to: ${OUT}. You will be notified when it completes.` },
  ]);
  const movedWin = user(2, [
    {
      type: "tool_result",
      tool_use_id: "t1",
      content: "Command was moved to the background (ID: bjob1) after running for 180s. Output is being written to: C:\\Users\\x\\AppData\\Local\\Temp\\claude\\abc\\tasks\\bjob1.output. You will be notified when it completes. It is running now: node tour.js",
    },
  ]);
  const waitingText = assistant(3, [{ type: "text", text: "Tour is running. Waiting for the completion notice?" }]);
  const notice = (status: string) =>
    user(4, `<task-notification>\n<task-id>bjob1</task-id>\n<tool-use-id>t1</tool-use-id>\n<output-file>${OUT}</output-file>\n<status>${status}</status>\n<summary>Background command completed</summary>\n</task-notification>`);
  const closing = assistant(5, [{ type: "text", text: "Tour finished." }]);

  it("a turn that ends with a job still running is working, not done", () => {
    for (const kind of ["subagent", "session"] as const) {
      const r = readClaudeTail([user(0, "run it"), bash, started, waitingText], kind);
      expect(r.state).toBe("working");
      expect(r.action).toContain("waiting for a background job");
      expect(r.action).toContain("node tour.js");
      expect(r.asks).toBeUndefined();
      expect(r.pendingOutputs).toEqual([OUT]);
    }
  });

  it("reads a command moved to the background after a timeout", () => {
    const r = readClaudeTail([user(0, "run it"), bash, movedWin, waitingText], "subagent");
    expect(r.state).toBe("working");
    expect(r.pendingOutputs).toEqual(["C:\\Users\\x\\AppData\\Local\\Temp\\claude\\abc\\tasks\\bjob1.output"]);
  });

  it("a completion notice ends the wait", () => {
    const recs = [user(0, "run it"), bash, started, waitingText, notice("completed"), closing];
    expect(readClaudeTail(recs, "subagent")).toMatchObject({ state: "done" });
    expect(readClaudeTail(recs, "session")).toMatchObject({ state: "idle" });
    const queued = { type: "queue-operation", operation: "enqueue", timestamp: ts(4), content: (notice("completed").message as { content: string }).content };
    expect(readClaudeTail([...recs.slice(0, 4), queued, closing], "subagent").state).toBe("done");
    expect(readClaudeTail([...recs.slice(0, 4), notice("failed"), closing], "subagent").state).toBe("done");
  });

  it("a notice is not a human prompt", () => {
    const r = readClaudeTail([user(0, "run it"), bash, started, waitingText, { ...notice("completed"), origin: { kind: "task-notification" } }], "session");
    expect(r.lastPromptAt).toBe(ts(0));
  });

  it("a monitor event without a status does not end the job", () => {
    const ev = user(4, "<task-notification>\n<task-id>bjob1</task-id>\n<summary>Monitor event</summary>\n</task-notification>");
    expect(readClaudeTail([user(0, "go"), bash, started, ev, closing], "subagent").state).toBe("working");
  });

  it("TaskStop ends the wait", () => {
    const stop = assistant(4, [{ type: "tool_use", id: "t2", name: "TaskStop", input: { task_id: "bjob1" } }]);
    const stopped = user(4, [{ type: "tool_result", tool_use_id: "t2", content: "stopped" }]);
    expect(readClaudeTail([user(0, "go"), bash, started, stop, stopped, closing], "subagent").state).toBe("done");
  });

  it("parawatch wait and watch jobs are the human's wait, not a pending job", () => {
    const cmds = ["parawatch wait", "parawatch wait --card c1", "cd /x && parawatch watch", "npx parawatch wait --card c1", "node /opt/parawatch/dist/cli.js wait", "sleep 1; parawatch wait"];
    for (const command of cmds) {
      const b = assistant(1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command, run_in_background: true } }]);
      expect(readClaudeTail([user(0, "go"), b, started, waitingText], "session").state, command).toBe("idle");
      expect(readClaudeTail([user(0, "go"), b, started, waitingText], "subagent").state, command).toBe("done");
    }
  });

  it("a dev server job still counts as pending", () => {
    const b = assistant(1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run dev", run_in_background: true } }]);
    expect(readClaudeTail([user(0, "go"), b, started, waitingText], "session").state).toBe("working");
  });

  it("a job that started before the tail is unknown", () => {
    expect(readClaudeTail([waitingText], "subagent").state).toBe("done");
  });

  describe("stall", () => {
    const now = Date.parse(ts(0)) + 25 * 60_000;
    const run = () => ({ state: "working", lastActivity: ts(0) }) as Parameters<typeof applyStall>[0];

    it("a fresh output file counts as activity, a stale one does not", () => {
      const a = run();
      applyStall(a, undefined, now, now - 60_000);
      expect(a.state).toBe("working");
      const b = run();
      applyStall(b, undefined, now, now - 21 * 60_000);
      expect(b.state).toBe("stalled");
    });

    it("an output path that does not exist falls back to the log", () => {
      expect(newestMtime(["/no/such/dir/x.output"])).toBeUndefined();
      const a = run();
      applyStall(a, undefined, now, newestMtime(["/no/such/dir/x.output"]));
      expect(a.state).toBe("stalled");
    });

    it("scan uses the output file of a waiting subagent", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-bg-"));
      const out = path.join(dir, "bjob1.output");
      fs.writeFileSync(out, "log\n");
      const sub = path.join(dir, "projects", "-work-app", "sess", "subagents");
      fs.mkdirSync(sub, { recursive: true });
      const startedHere = user(2, [{ type: "tool_result", tool_use_id: "t1", content: `Command running in background with ID: bjob1. Output is being written to: ${out}. You will be notified when it completes.` }]);
      fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), [user(0, "run it"), bash, startedHere, waitingText].map((r) => JSON.stringify(r)).join("\n") + "\n");
      process.env.PARAWATCH_CLAUDE_DIR = path.join(dir, "projects");
      const scan = (nowMs: number) => claudeCode.scan({ now: nowMs, sinceMs: 0 } as Parameters<typeof claudeCode.scan>[0]).find((r) => r.id === "a1")!;
      // the transcript is 25 minutes old but the output file was just written
      expect(scan(Date.parse(ts(3)) + 25 * 60_000).state).toBe("working");
      // the output file is old too
      const old = new Date(Date.parse(ts(3)) - 60_000);
      fs.utimesSync(out, old, old);
      expect(scan(Date.parse(ts(3)) + 25 * 60_000).state).toBe("stalled");
      // the output file is gone: the log decides
      fs.unlinkSync(out);
      expect(scan(Date.parse(ts(3)) + 25 * 60_000).state).toBe("stalled");
      expect(scan(Date.parse(ts(3)) + 5 * 60_000).state).toBe("working");
      delete process.env.PARAWATCH_CLAUDE_DIR;
    });
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
