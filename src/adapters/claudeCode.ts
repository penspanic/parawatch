import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run, RunState } from "../core/types.js";
import { isObj, logActivity, oneLine, readHeadLines, readTailLines, str } from "./jsonl.js";
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
  is_error?: boolean;
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
/** What Claude Code writes as a user record when the human stops a turn (or its parent was stopped). */
const INTERRUPTED = /^\[Request interrupted by user\b/;

function isInterrupt(rec: Record<string, unknown>): boolean {
  if (rec.type !== "user") return false;
  const text = blocks(rec).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  return INTERRUPTED.test(text);
}

function promptText(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true) return undefined;
  if (isObj(rec.origin) && rec.origin.kind === "task-notification") return undefined;
  const bs = blocks(rec);
  if (bs.some((b) => b.type === "tool_result")) return undefined;
  const text = bs.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  if (!text || text.startsWith("<") || INTERRUPTED.test(text)) return undefined;
  return text;
}

/** A message the log marks as typed or sent by the human, whatever its text looks like. */
function fromHuman(rec: Record<string, unknown>): boolean {
  if (rec.type !== "user" || rec.isMeta === true || !isObj(rec.origin) || rec.origin.kind !== "human") return false;
  return !blocks(rec).some((b) => b.type === "tool_result");
}

export interface Reading {
  state: RunState;
  action?: string;
  lastActivity?: string;
  cwd?: string;
  title?: string;
  pendingTimeoutMs?: number;
  lastPromptAt?: string;
  asks?: Run["asks"];
  recap?: string;
  /** Output files of background jobs still running when the turn ended (waiting runs only). */
  pendingOutputs?: string[];
  /** the log ends on a tool call with no result yet */
  pendingTool?: boolean;
}

interface Job {
  id: string;
  output?: string;
  command?: string;
}

const JOB_STARTED = /(?:running in background with ID|moved to the background \(ID): ([\w-]+)\)?[^\n]{0,80}?\.\s*Output is being written to: (.+?)\.\s+You will be notified/s;
const JOB_STARTED_NO_PATH = /(?:running in background with ID|moved to the background \(ID): ([\w-]+)/;
const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/** `parawatch wait` / `parawatch watch` at a command start: it blocks for the human and prints nothing. */
const HUMAN_WAIT = /(?:^|&&|;|\||\bnpx\s+)\s*(?:parawatch\s+(?:wait|watch)\b|node\s+\S*cli\.js\s+(?:wait|watch)\b)/;
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();
}

/** Text a record carries that may hold a task notice: a user message, a queued command, a queue entry. */
function noticeText(rec: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const b of blocks(rec)) if (b.type === "text" && b.text) parts.push(b.text);
  const att = rec.attachment;
  if (isObj(att) && typeof att.prompt === "string") parts.push(att.prompt);
  if (rec.type === "queue-operation" && typeof rec.content === "string") parts.push(rec.content);
  return parts.join("\n");
}

/**
 * Background shell jobs a transcript started and has not seen end. A job ends with a completion
 * notice (a status other than running) or a stop tool call. A job that started before the tail
 * began is unknown and not counted.
 */
function pendingJobs(recs: unknown[]): Job[] {
  const jobs = new Map<string, Job>();
  const commands = new Map<string, string>();
  const ended = new Set<string>();
  for (const r of recs) {
    if (!isObj(r)) continue;
    for (const b of blocks(r)) {
      if (b.type === "tool_use") {
        if (b.id && b.name === "Bash") commands.set(b.id, str(b.input?.command) ?? "");
        if (STOP_TOOLS.has(String(b.name))) {
          const id = str(b.input?.task_id) || str(b.input?.shell_id) || str(b.input?.bash_id);
          if (id) ended.add(id);
        }
      } else if (b.type === "tool_result") {
        const text = resultText(b);
        const m = JOB_STARTED.exec(text);
        const id = m?.[1] ?? JOB_STARTED_NO_PATH.exec(text)?.[1];
        if (id) jobs.set(id, { id, output: m?.[2]?.trim(), command: b.tool_use_id ? commands.get(b.tool_use_id) : undefined });
      }
    }
    for (const n of noticeText(r).matchAll(NOTICE)) {
      const id = tag(n[1]!, "task-id");
      const status = tag(n[1]!, "status");
      // monitor events carry no status and do not end a job
      if (id && status && status.toLowerCase() !== "running") ended.add(id);
    }
  }
  return [...jobs.values()].filter((j) => !ended.has(j.id) && !(j.command && HUMAN_WAIT.test(j.command.trim())));
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DIR_IN_COMMAND = /(?:^|[;&|]\s*|\s)(?:cd|git\s+-C)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;
/** The desktop app's end-of-turn tool: a recap, maybe a question for the human. */
const WRAP_UP = /(^|__)wrap_up$/;
/** The tool a subagent calls to hand its report back to its caller; its result is the subagent's end. */
const HANDBACK = /(^|__)SubagentHandback$/;

function resultText(b: Block): string {
  const c = (b as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (isObj(x) && typeof x.text === "string" ? x.text : "")).join("\n");
  return "";
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/**
 * What a log shows about where the work happens and what it produced: folders of edited files and
 * of `cd`/`git -C` targets (absolute paths only), and pull requests opened with `gh pr create`.
 */
export function scanWork(recs: unknown[]): { touched: string[]; createdPrs: string[] } {
  const touched: string[] = [];
  const add = (dir: string) => {
    if (!path.isAbsolute(dir)) return;
    const i = touched.indexOf(dir);
    if (i >= 0) touched.splice(i, 1);
    touched.push(dir);
  };
  const prCalls = new Set<string>();
  const prs: string[] = [];
  for (const r of recs) {
    if (!isObj(r) || !isConversation(r)) continue;
    for (const b of blocks(r)) {
      if (b.type === "tool_use") {
        const inp = b.input ?? {};
        if (EDIT_TOOLS.has(String(b.name))) {
          const f = str(inp.file_path) || str(inp.notebook_path);
          if (f) add(path.dirname(f));
        } else if (b.name === "Bash") {
          const cmd = str(inp.command) ?? "";
          for (const m of cmd.matchAll(DIR_IN_COMMAND)) add(unquote(m[1]!));
          if (runsGhPrCreate(cmd) && b.id) prCalls.add(b.id);
        }
      } else if (b.type === "tool_result" && b.tool_use_id && prCalls.has(b.tool_use_id)) {
        const url = createdPrUrl(resultText(b));
        if (url && !prs.includes(url)) prs.push(url);
      }
    }
  }
  return { touched: touched.slice(-50), createdPrs: prs };
}

/** Shell words that may come before the command itself. */
const PREFIX_WORD = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|env|command|time|noglob|exec|then|do|else|!)$/;

/**
 * Whether a shell command runs `gh pr create`, as opposed to mentioning the words: a search for
 * them, a quoted message, a heredoc. Each command of a list or pipeline is looked at on its own.
 */
export function runsGhPrCreate(cmd: string): boolean {
  if (!/\bpr\s+create\b/.test(cmd)) return false;
  const bare = cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "") // heredoc bodies
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const seg of bare.split(/&&|\|\||[;|\n&]|\$\(|`|[()]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && PREFIX_WORD.test(words[0]!)) words.shift();
    if (/(^|[\\/])gh(\.exe)?$/.test(words[0] ?? "") && words[1] === "pr" && words[2] === "create") return true;
  }
  return false;
}

/** The URL `gh pr create` prints when it opens a PR: a line of its own, the last one. */
export function createdPrUrl(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\/\S+\/pull\/\d+$/.test(l));
  return lines[lines.length - 1];
}

/** The last line of an agent's closing message, when it is a question. */
function trailingQuestion(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last && /[?？]\**$/.test(last) ? last : undefined;
}

/** Work out what a Claude Code transcript is doing from its last records. */
export function readClaudeTail(recs: unknown[], kind: "session" | "subagent"): Reading {
  const out: Reading = { state: "unknown" };
  let lastConv: Record<string, unknown> | undefined;
  let wrapUp: Record<string, unknown> | undefined;
  for (const r of recs) {
    if (!isObj(r)) continue;
    const ts = str(r.timestamp);
    if (ts && (!out.lastActivity || ts > out.lastActivity)) out.lastActivity = ts;
    if (str(r.cwd)) out.cwd = str(r.cwd);
    if (r.type === "custom-title" && str(r.customTitle)) out.title = str(r.customTitle);
    if (r.type === "agent-name" && str(r.agentName) && !out.title) out.title = str(r.agentName);
    if (isConversation(r)) lastConv = r;
    if (promptText(r)) {
      out.lastPromptAt = ts ?? out.lastPromptAt;
      wrapUp = undefined; // a new turn began
    } else if (fromHuman(r)) {
      // the human wrote (a pasted block, a command's output): whatever the last wrap-up asked is answered
      wrapUp = undefined;
    }
    if (r.type === "assistant") {
      const w = blocks(r).find((b) => b.type === "tool_use" && WRAP_UP.test(String(b.name)));
      if (w) wrapUp = { ...(w.input ?? {}), at: ts };
    }
  }
  if (!lastConv) return out;
  const jobs = pendingJobs(recs);
  const bs = blocks(lastConv);
  if (lastConv.type === "assistant") {
    const tool = [...bs].reverse().find((b) => b.type === "tool_use");
    if (tool) {
      out.state = "working";
      out.pendingTool = true;
      out.action = toolSummary(tool);
      const t = tool.input?.timeout;
      if (typeof t === "number") out.pendingTimeoutMs = t;
    } else if (jobs.length && bs.some((b) => b.type === "text" && b.text?.trim())) {
      // the turn ended while a background job runs: the run is waiting, not finished
      const j = jobs[jobs.length - 1]!;
      out.state = "working";
      out.action = oneLine(`waiting for a background job${j.command ? `: ${j.command}` : ` (${j.id})`}`, 100);
      const outputs = jobs.map((x) => x.output).filter((x): x is string => !!x);
      if (outputs.length) out.pendingOutputs = outputs;
    } else if (bs.some((b) => b.type === "text" && b.text?.trim())) {
      out.state = kind === "subagent" ? "done" : "idle";
      const full = bs.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      out.action = oneLine(full, 100);
      if (kind === "session") {
        const recap = wrapUp && str(wrapUp.recap);
        if (recap) out.recap = oneLine(recap, 300);
        const ask = wrapUp && str(wrapUp.ask);
        const blocked = wrapUp?.blocked === true;
        if (ask || blocked) out.asks = { text: oneLine(ask || recap || full, 200), via: "wrap_up", blocked: blocked || undefined, at: str(wrapUp!.at) };
        else if (!wrapUp) {
          const q = trailingQuestion(full);
          if (q) out.asks = { text: oneLine(q.replace(/\*\*/g, ""), 200), via: "text", at: out.lastActivity };
        }
      }
    } else {
      out.state = "working";
      out.action = "thinking";
    }
  } else if (isInterrupt(lastConv)) {
    // the turn was stopped and nothing came after: a session waits for the human, a subagent is over
    out.state = kind === "subagent" ? "done" : "idle";
    out.action = "interrupted";
  } else {
    out.state = "working";
    const result = bs.find((b) => b.type === "tool_result");
    out.action = result ? "thinking" : "reading a new message";
    if (kind === "subagent" && result && result.is_error !== true && HANDBACK.test(toolName(recs, result.tool_use_id))) {
      // the report went back to the caller: nothing more comes from this subagent
      out.state = "done";
      out.action = "handed its report back";
    }
  }
  return out;
}

/** The name of the tool call a result answers, looked up in the same records. */
function toolName(recs: unknown[], id: string | undefined): string {
  if (!id) return "";
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (!isObj(r) || r.type !== "assistant") continue;
    const b = blocks(r).find((x) => x.type === "tool_use" && x.id === id);
    if (b) return String(b.name ?? "");
  }
  return "";
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

/** A log small enough that its tail already holds the whole file. */
function sameFile(file: string): boolean {
  return fs.statSync(file).size <= TAIL_BYTES;
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

/** The newest modification time among files that exist on this machine, or undefined. */
export function newestMtime(files: string[] | undefined): number | undefined {
  let newest: number | undefined;
  for (const f of files ?? []) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (newest === undefined || m > newest) newest = m;
    } catch {
      // not on this machine, or gone
    }
  }
  return newest;
}

/** `lastSeenMs` is other proof of life, such as a background job's output file changing. */
export function applyStall(run: Run, pendingTimeoutMs: number | undefined, now: number, lastSeenMs?: number): void {
  if (run.state !== "working" || !run.lastActivity) return;
  const quiet = now - Math.max(Date.parse(run.lastActivity), lastSeenMs ?? 0);
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
    const tailRecs = readTailLines(file, TAIL_BYTES);
    const tail = readClaudeTail(tailRecs, "session");
    const work = scanWork(sameFile(file) ? tailRecs : [...readHeadLines(file, HEAD_BYTES), ...tailRecs]);
    const run: Run = {
      ...base,
      lastPromptAt: tail.lastPromptAt,
      asks: tail.asks,
      recap: tail.recap,
      touched: work.touched.length ? work.touched : undefined,
      createdPrs: work.createdPrs.length ? work.createdPrs : undefined,
      title: tail.title || (head.prompt ? oneLine(head.prompt, 60) : base.title),
      cwd: tail.cwd || head.cwd,
      startedAt: head.startedAt,
      lastActivity: tail.lastActivity,
      state: tail.state,
      action: tail.action,
      prompt: head.prompt ? oneLine(head.prompt, 400) : undefined,
      activity: logActivity(file, now),
      pendingTool: tail.pendingTool,
    };
    applyStall(run, tail.pendingTimeoutMs, now, newestMtime(tail.pendingOutputs));
    // in the log a permission prompt and a long command look the same; the hook can tell them apart
    if (run.state === "stalled" && tail.pendingTool) run.action = `${run.action ?? "a tool call"} · or a permission prompt is open`;
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
    const tailRecs = readTailLines(file, TAIL_BYTES);
    const tail = readClaudeTail(tailRecs, "subagent");
    const work = scanWork(sameFile(file) ? tailRecs : [...readHeadLines(file, HEAD_BYTES), ...tailRecs]);
    const run: Run = {
      ...base,
      touched: work.touched.length ? work.touched : undefined,
      createdPrs: work.createdPrs.length ? work.createdPrs : undefined,
      title: str(meta.description) || (head.prompt ? oneLine(head.prompt, 60) : base.title),
      model: str(meta.model),
      cwd: tail.cwd || head.cwd,
      startedAt: head.startedAt,
      lastActivity: tail.lastActivity,
      state: tail.state,
      action: tail.action,
      prompt: head.prompt ? oneLine(head.prompt, 400) : undefined,
      activity: logActivity(file, now),
    };
    if (meta.finished === true && run.state !== "done" && run.state !== "failed" && metaIsCurrent(file)) {
      // Claude Code marks a subagent finished in its meta file; the log tail can still look mid-turn
      run.state = "done";
      if (run.action === "thinking" || run.action === "reading a new message") run.action = "finished";
    }
    applyStall(run, tail.pendingTimeoutMs, now, newestMtime(tail.pendingOutputs));
    return run;
  } catch (err) {
    return { ...base, error: `could not read: ${(err as Error).message}` };
  }
}

/** A meta file written after the log's last line; an older one may be from before a resumed turn. */
function metaIsCurrent(file: string): boolean {
  try {
    return fs.statSync(file.replace(/\.jsonl$/, ".meta.json")).mtimeMs >= fs.statSync(file).mtimeMs - 5_000;
  } catch {
    return false;
  }
}

/**
 * Which run of a Claude Code session is running a command right now: the session itself, or one of
 * its subagents. A subagent's commands get the session's own `CLAUDE_CODE_SESSION_ID`, so only the
 * logs tell them apart: the run whose log ends on a pending Bash call matching `command`, the
 * newest one if several do. Returns the subagent's id, or undefined for the session itself (or
 * when the logs do not say).
 */
export function callingSubagent(session: string, command: RegExp, now = Date.now()): string | undefined {
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const pendingAt = (file: string): string | undefined => {
    try {
      if (now - fs.statSync(file).mtimeMs > 120_000) return undefined;
      const recs = readTailLines(file, 64 * 1024).filter(isObj);
      const last = recs[recs.length - 1];
      if (!last || last.type !== "assistant") return undefined;
      const call = blocks(last).find((b) => b.type === "tool_use" && b.name === "Bash" && command.test(str(b.input?.command) ?? ""));
      return call ? (str(last.timestamp) ?? new Date(fs.statSync(file).mtimeMs).toISOString()) : undefined;
    } catch {
      return undefined;
    }
  };
  for (const d of dirs) {
    const own = path.join(root, d, `${session}.jsonl`);
    if (!fs.existsSync(own)) continue;
    let best: { id?: string; at: string } | undefined;
    const mine = pendingAt(own);
    if (mine) best = { at: mine };
    for (const f of listJsonl(path.join(root, d, session, "subagents"))) {
      const at = pendingAt(f);
      if (at && (!best || at > best.at)) best = { id: path.basename(f, ".jsonl").replace(/^agent-/, ""), at };
    }
    return best?.id;
  }
  return undefined;
}
