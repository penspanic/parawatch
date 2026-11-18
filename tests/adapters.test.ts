import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyStall, claudeCode, newestMtime, readClaudeTail } from "../src/adapters/claudeCode.js";
import { parentFromCwd, promptFromRaw, readCodexLog, settingsInMiddle } from "../src/adapters/codex.js";
import { activeMinutes, timestampsIn, textValues } from "../src/adapters/jsonl.js";
import { settingsFull, settingsLine, shortModel } from "../src/core/model.js";

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

describe("what a run runs with", () => {
  it("a Claude Code log gives the last answer's model, effort, fast mode and permission mode", () => {
    const r = readClaudeTail(
      [
        { ...user(0, "go"), permissionMode: "bypassPermissions" },
        { ...assistant(1, [{ type: "text", text: "on it" }]), effort: "high", message: { role: "assistant", model: "claude-sonnet-5-5", usage: { speed: "standard" }, content: [] } },
        { ...assistant(2, [{ type: "text", text: "done" }]), effort: "xhigh", message: { role: "assistant", model: "claude-opus-5-5", usage: { speed: "fast" }, content: [{ type: "text", text: "done" }] } },
        // made up by Claude Code itself: names no model
        { ...assistant(3, []), message: { role: "assistant", model: "<synthetic>", content: [] } },
      ],
      "session",
    );
    expect(r).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh", fast: true, permissionMode: "bypassPermissions" });
  });

  it("a Codex log gives the last turn's model, effort, sandbox and approvals", () => {
    const meta = { type: "session_meta", timestamp: ts(0), payload: { id: "01a1-y", originator: "codex_exec" } };
    const turn = (model: string, effort: string | null, sandbox: string) => ({
      type: "turn_context",
      timestamp: ts(1),
      payload: { model, approval_policy: "never", sandbox_policy: { type: sandbox }, collaboration_mode: { settings: { model, reasoning_effort: effort } } },
    });
    expect(readCodexLog([meta, turn("gpt-6.1-sol", "high", "workspace-write")], [turn("gpt-6.1-sol", "xhigh", "danger-full-access")])).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "xhigh",
      options: ["full access", "never asks"],
    });
    // no effort set: left out, not guessed
    expect(readCodexLog([meta, turn("gpt-5.6-luna", null, "read-only")], []).effort).toBeUndefined();
    expect(readCodexLog([meta], []).model).toBeUndefined();
  });

  it("finds a Codex turn's settings in the middle of a long log, and a newer turn as it grows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-codex-mid-"));
    const file = path.join(dir, "rollout.jsonl");
    const filler = (kb: number) => Array.from({ length: kb }, (_, i) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${i} ${"x".repeat(1000)}` }] } })).join("\n") + "\n";
    const turn = (model: string, effort: string) => JSON.stringify({ type: "turn_context", payload: { model, approval_policy: "never", sandbox_policy: { type: "workspace-write" }, collaboration_mode: { settings: { reasoning_effort: effort } } } }) + "\n";
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "01a1-z" } }) + "\n" + filler(300) + turn("gpt-6.1-sol", "high") + filler(1500));
    expect(settingsInMiddle(file)).toEqual({ model: "gpt-6.1-sol", effort: "high", options: ["writes in its folders", "never asks"] });
    fs.appendFileSync(file, filler(400) + turn("gpt-6.1-sol", "xhigh") + filler(600));
    expect(settingsInMiddle(file).effort).toBe("xhigh");
    // grown with no new turn: still the last one
    fs.appendFileSync(file, filler(50));
    expect(settingsInMiddle(file).effort).toBe("xhigh");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads short on a row and in full in a tooltip", () => {
    expect(shortModel("claude-opus-5-5")).toBe("opus 5.5");
    expect(shortModel("claude-haiku-5-5-20260101")).toBe("haiku 5.5");
    expect(shortModel("claude-sonnet-5-5[1m]")).toBe("sonnet 5.5 1M");
    expect(shortModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    const r = { model: "claude-opus-5-5", effort: "high", options: ["fast", "bypasses permissions"] };
    expect(settingsLine(r)).toBe("opus 5.5 high fast");
    expect(settingsFull(r)).toBe("claude-opus-5-5 · effort high · fast · bypasses permissions");
    expect(settingsLine({})).toBeUndefined();
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
      // a day back is past what the chart can show
      { timestamp: "2026-11-06T11:59:00Z" },
      { note: "no timestamp" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(activeMinutes(timestampsIn(text), now)).toEqual([0, 2, 30, 90]);
  });
});
