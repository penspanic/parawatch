import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run, RunState } from "../core/types.js";
import { isObj, oneLine, readHeadLines, readTailLines, str } from "./jsonl.js";
import type { Adapter, ScanOptions } from "./index.js";

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 384 * 1024;

export function claudeProjectsDir(): string {
  if (process.env.PARAWATCH_CLAUDE_DIR) return process.env.PARAWATCH_CLAUDE_DIR;
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
}

function blocks(rec: Record<string, unknown>): Block[] {
  const msg = rec.message;
  if (!isObj(msg)) return [];
  const c = msg.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? (c.filter(isObj) as Block[]) : [];
}

function isConversation(rec: Record<string, unknown>): boolean {
  return (rec.type === "user" || rec.type === "assistant") && rec.isMeta !== true;
}

function toolSummary(b: Block): string {
  const inp = b.input ?? {};
  const pick = str(inp.description) || str(inp.command) || str(inp.file_path) || str(inp.pattern) || str(inp.prompt) || str(inp.url);
  const short = pick && (inp.file_path === pick ? path.basename(pick) : pick);
  return short ? `${b.name}: ${oneLine(short, 80)}` : String(b.name ?? "tool");
}

/** A prompt the human (or parent agent) typed, not a tool result or system notice. */
function promptText(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true) return undefined;
  const bs = blocks(rec);
  if (bs.some((b) => b.type === "tool_result")) return undefined;
  const text = bs.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  if (!text || text.startsWith("<")) return undefined;
  return text;
}

export interface Reading {
  state: RunState;
  action?: string;
  lastActivity?: string;
  cwd?: string;
  title?: string;
  pendingTimeoutMs?: number;
}

/** Work out what a Claude Code transcript is doing from its last records. */
export function readClaudeTail(recs: unknown[], kind: "session" | "subagent"): Reading {
  const out: Reading = { state: "unknown" };
  let lastConv: Record<string, unknown> | undefined;
  for (const r of recs) {
    if (!isObj(r)) continue;
    const ts = str(r.timestamp);
    if (ts && (!out.lastActivity || ts > out.lastActivity)) out.lastActivity = ts;
    if (str(r.cwd)) out.cwd = str(r.cwd);
    if (r.type === "custom-title" && str(r.customTitle)) out.title = str(r.customTitle);
    if (r.type === "agent-name" && str(r.agentName) && !out.title) out.title = str(r.agentName);
    if (isConversation(r)) lastConv = r;
  }
  if (!lastConv) return out;
  const bs = blocks(lastConv);
  if (lastConv.type === "assistant") {
    const tool = [...bs].reverse().find((b) => b.type === "tool_use");
    if (tool) {
      out.state = "working";
      out.action = toolSummary(tool);
      const t = tool.input?.timeout;
      if (typeof t === "number") out.pendingTimeoutMs = t;
    } else if (bs.some((b) => b.type === "text" && b.text?.trim())) {
      out.state = kind === "subagent" ? "done" : "idle";
      const text = bs.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
      out.action = oneLine(text, 100);
    } else {
      out.state = "working";
      out.action = "thinking";
    }
  } else {
    out.state = "working";
    const result = bs.find((b) => b.type === "tool_result");
    out.action = result ? "thinking" : "reading a new message";
  }
  return out;
}

function firstPrompt(file: string): { prompt?: string; cwd?: string; startedAt?: string } {
  const out: { prompt?: string; cwd?: string; startedAt?: string } = {};
  for (const r of readHeadLines(file, HEAD_BYTES)) {
    if (!isObj(r)) continue;
    if (!out.startedAt && str(r.timestamp)) out.startedAt = str(r.timestamp);
    if (!out.cwd && str(r.cwd)) out.cwd = str(r.cwd);
    if (!out.prompt) out.prompt = promptText(r);
    if (out.prompt && out.cwd && out.startedAt) break;
  }
  return out;
}

function readMeta(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return isObj(data) ? data : {};
  } catch {
    return {};
  }
}

const STALL_MS = 20 * 60_000;

export function applyStall(run: Run, pendingTimeoutMs: number | undefined, now: number): void {
  if (run.state !== "working" || !run.lastActivity) return;
  const quiet = now - Date.parse(run.lastActivity);
  const allowed = Math.max(STALL_MS, (pendingTimeoutMs ?? 0) + 2 * 60_000);
  if (quiet > allowed) run.state = "stalled";
}

function listJsonl(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function fresh(file: string, sinceMs: number): boolean {
  try {
    return fs.statSync(file).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

export const claudeCode: Adapter = {
  name: "claude-code",
  scan(opts: ScanOptions): Run[] {
    const root = claudeProjectsDir();
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root).map((d) => path.join(root, d));
    } catch {
      return [];
    }
    const runs: Run[] = [];
    for (const dir of dirs) {
      for (const file of listJsonl(dir)) {
        if (fresh(file, opts.sinceMs)) runs.push(readSession(file, opts.now));
      }
      let subdirs: string[] = [];
      try {
        subdirs = fs.readdirSync(dir).map((d) => path.join(dir, d, "subagents"));
      } catch {
        // not a directory listing we can read
      }
      for (const sub of subdirs) {
        for (const file of listJsonl(sub)) {
          if (fresh(file, opts.sinceMs)) runs.push(readSubagent(file, opts.now));
        }
      }
    }
    return runs;
  },
};

function readSession(file: string, now: number): Run {
  const id = path.basename(file, ".jsonl");
  const base: Run = { id, runtime: "claude-code", kind: "session", title: id.slice(0, 8), state: "unknown", source: file };
  try {
    const head = firstPrompt(file);
    const tail = readClaudeTail(readTailLines(file, TAIL_BYTES), "session");
    const run: Run = {
      ...base,
      title: tail.title || (head.prompt ? oneLine(head.prompt, 60) : base.title),
      cwd: tail.cwd || head.cwd,
      startedAt: head.startedAt,
      lastActivity: tail.lastActivity,
      state: tail.state,
      action: tail.action,
      prompt: head.prompt ? oneLine(head.prompt, 400) : undefined,
    };
    applyStall(run, tail.pendingTimeoutMs, now);
    return run;
  } catch (err) {
    return { ...base, error: `could not read: ${(err as Error).message}` };
  }
}

function readSubagent(file: string, now: number): Run {
  const id = path.basename(file, ".jsonl").replace(/^agent-/, "");
  const parent = path.basename(path.dirname(path.dirname(file)));
  const base: Run = { id, runtime: "claude-code", kind: "subagent", parent, title: id.slice(0, 8), state: "unknown", source: file };
  try {
    const meta = readMeta(file);
    const head = firstPrompt(file);
    const tail = readClaudeTail(readTailLines(file, TAIL_BYTES), "subagent");
    const run: Run = {
      ...base,
      title: str(meta.description) || (head.prompt ? oneLine(head.prompt, 60) : base.title),
      model: str(meta.model),
      cwd: tail.cwd || head.cwd,
      startedAt: head.startedAt,
      lastActivity: tail.lastActivity,
      state: tail.state,
      action: tail.action,
      prompt: head.prompt ? oneLine(head.prompt, 400) : undefined,
    };
    applyStall(run, tail.pendingTimeoutMs, now);
    return run;
  } catch (err) {
    return { ...base, error: `could not read: ${(err as Error).message}` };
  }
}
