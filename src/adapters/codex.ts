import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../core/types.js";
import { applyStall } from "./claudeCode.js";
import { isObj, lastLineWith, logActivity, oneLine, readHeadLines, readHeadText, readTailLines, str, textValues } from "./jsonl.js";
import type { Adapter, ScanOptions } from "./index.js";

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;
// prompts can sit behind several inline base64 images on one line; read this far only when needed
const RAW_HEAD_BYTES = 16 * 1024 * 1024;

export function codexSessionsDir(): string {
  if (process.env.PARAWATCH_CODEX_DIR) return process.env.PARAWATCH_CODEX_DIR;
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "sessions");
}

const PARENT_IN_CWD = /\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/;

/** A Claude Code session id when Codex was started from inside that session's scratch space. */
export function parentFromCwd(cwd: string | undefined): string | undefined {
  return cwd ? PARENT_IN_CWD.exec(cwd)?.[1] : undefined;
}

function payload(r: unknown): Record<string, unknown> | undefined {
  return isObj(r) && isObj(r.payload) ? r.payload : undefined;
}

function messageText(p: Record<string, unknown>): string {
  const c = p.content;
  if (!Array.isArray(c)) return "";
  return c
    .filter(isObj)
    .map((b) => str(b.text) ?? "")
    .join("\n")
    .trim();
}

function promptBlock(p: Record<string, unknown>): string | undefined {
  const c = p.content;
  if (!Array.isArray(c)) return undefined;
  for (const b of c.filter(isObj)) {
    const t = (str(b.text) ?? "").trim();
    if (!t || t.startsWith("<") || t.startsWith("# AGENTS.md instructions")) continue;
    return t;
  }
  return undefined;
}

function toolSummary(p: Record<string, unknown>): string {
  const name = str(p.name) ?? "tool";
  let arg = str(p.input) ?? str(p.arguments) ?? "";
  try {
    const parsed = JSON.parse(arg);
    if (isObj(parsed)) arg = str(parsed.cmd) ?? str(parsed.command) ?? (Array.isArray(parsed.command) ? parsed.command.join(" ") : arg);
  } catch {
    // free-form input
  }
  return arg ? `${name}: ${oneLine(arg, 80)}` : name;
}

/** The first real prompt in user messages whose lines were too long to parse (inline images). */
export function promptFromRaw(raw: string): string | undefined {
  for (const line of raw.split("\n")) {
    if (!line.includes('"role":"user"')) continue;
    for (const t of textValues(line)) {
      const v = t.trim();
      if (v && !v.startsWith("<") && !v.startsWith("# AGENTS.md instructions")) return v;
    }
  }
  return undefined;
}

const SANDBOXES: Record<string, string> = { "read-only": "read-only", "workspace-write": "writes in its folders", "danger-full-access": "full access" };
const APPROVALS: Record<string, string> = { never: "never asks", "on-request": "asks when it wants to", "on-failure": "asks on failure", untrusted: "asks before most commands" };

/** The model, effort and options of the last turn, from Codex's `turn_context` lines. */
export function codexSettings(lines: unknown[]): Pick<Run, "model" | "effort" | "options"> {
  let tc: Record<string, unknown> | undefined;
  for (const r of lines) if (isObj(r) && r.type === "turn_context" && isObj(r.payload)) tc = r.payload;
  if (!tc) return {};
  const sp = tc.sandbox_policy;
  const sandbox = typeof sp === "string" ? sp : isObj(sp) ? str(sp.type) : undefined;
  const approval = str(tc.approval_policy);
  const options = [sandbox ? (SANDBOXES[sandbox] ?? sandbox) : undefined, approval ? (APPROVALS[approval] ?? approval) : undefined].filter((x): x is string => !!x);
  return { model: str(tc.model), effort: str(tc.effort) ?? str(tc.reasoning_effort) ?? (isObj(tc.collaboration_mode) && isObj(tc.collaboration_mode.settings) ? str(tc.collaboration_mode.settings.reasoning_effort) : undefined), options: options.length ? options : undefined };
}

/** What the last turn ran with, per log: a long log is searched once, then only where it grew. */
const middle = new Map<string, { size: number; settings: Pick<Run, "model" | "effort" | "options"> }>();

/** The settings of a log whose last `turn_context` sits between its head and tail. */
export function settingsInMiddle(file: string): Pick<Run, "model" | "effort" | "options"> {
  const size = fs.statSync(file).size;
  const known = middle.get(file);
  if (known && known.size === size) return known.settings;
  const found = lastLineWith(file, '"type":"turn_context"', known && known.size < size ? Math.max(0, known.size - 64) : 0);
  const settings = found ? codexSettings([found]) : (known?.settings ?? {});
  middle.set(file, { size, settings });
  return settings;
}

export function readCodexLog(head: unknown[], tail: unknown[], rawHead?: () => string): Omit<Run, "source"> {
  const meta = head.map(payload).find((p, i) => p && isObj(head[i]) && (head[i] as Record<string, unknown>).type === "session_meta");
  const id = str(meta?.id) ?? str(meta?.session_id) ?? "unknown";
  const cwd = str(meta?.cwd);
  const exec = str(meta?.originator) === "codex_exec" || str(meta?.source) === "exec";
  let prompt: string | undefined;
  for (const r of head) {
    const p = payload(r);
    if (isObj(r) && r.type === "response_item" && p?.type === "message" && p.role === "user") {
      // skip injected context: environment blocks, image tags, AGENTS.md instructions
      const t = promptBlock(p);
      if (t) {
        prompt = t;
        break;
      }
    }
  }
  if (!prompt && rawHead) prompt = promptFromRaw(rawHead());
  const run: Omit<Run, "source"> = {
    id,
    runtime: "codex",
    kind: exec ? "exec" : "session",
    title: prompt ? oneLine(prompt, 60) : id.slice(0, 8),
    cwd,
    parent: parentFromCwd(cwd),
    startedAt: str(meta?.timestamp) ?? (isObj(head[0]) ? str((head[0] as Record<string, unknown>).timestamp) : undefined),
    state: "working",
    prompt: prompt ? oneLine(prompt, 400) : undefined,
    // the last turn's settings: a later turn may change them (`codex exec resume -m ...`)
    ...codexSettings([...head, ...tail]),
  };
  let lastStart = -1;
  let lastDone = -1;
  let lastError = -1;
  tail.forEach((r, i) => {
    if (!isObj(r)) return;
    const ts = str(r.timestamp);
    if (ts && (!run.lastActivity || ts > run.lastActivity)) run.lastActivity = ts;
    const p = payload(r);
    if (!p) return;
    if (r.type === "event_msg" && p.type === "task_started") lastStart = i;
    if (r.type === "event_msg" && p.type === "task_complete") {
      lastDone = i;
      const msg = str(p.last_agent_message);
      if (msg) run.action = oneLine(msg, 100);
    }
    if (r.type === "event_msg" && (p.type === "error" || p.type === "turn_aborted")) lastError = i;
    if (r.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
      if (i > lastDone) run.action = toolSummary(p);
    }
    if (r.type === "response_item" && p.type === "message" && p.role === "assistant" && i > lastDone) {
      const t = messageText(p);
      if (t) run.action = oneLine(t, 100);
    }
  });
  if (lastError > Math.max(lastStart, lastDone)) run.state = "failed";
  else if (lastDone > lastStart) run.state = exec ? "done" : "idle";
  return run;
}

function dayDirs(root: string, sinceMs: number, now: number): string[] {
  const out: string[] = [];
  const day = 86_400_000;
  for (let t = sinceMs - day; t <= now + day; t += day) {
    const d = new Date(t);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const dir = path.join(root, y, m, dd);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

export const codex: Adapter = {
  name: "codex",
  scan(opts: ScanOptions): Run[] {
    const root = codexSessionsDir();
    const runs: Run[] = [];
    for (const dir of dayDirs(root, opts.sinceMs, opts.now)) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          if (fs.statSync(file).mtimeMs < opts.sinceMs) continue;
          const run: Run = { ...readCodexLog(readHeadLines(file, HEAD_BYTES), readTailLines(file, TAIL_BYTES), () => readHeadText(file, RAW_HEAD_BYTES)), source: file };
          if (!run.model) Object.assign(run, settingsInMiddle(file));
          run.activity = logActivity(file, opts.now);
          applyStall(run, undefined, opts.now);
          runs.push(run);
        } catch (err) {
          runs.push({ id: f, runtime: "codex", kind: "exec", title: f, state: "unknown", source: file, error: `could not read: ${(err as Error).message}` });
        }
      }
    }
    return runs;
  },
};
