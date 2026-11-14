/**
 * A Codex session as a conversation: read from its rollout log (what `codex exec` and the Codex
 * app write under ~/.codex/sessions), and continued with `codex exec resume`, under the same
 * sandbox and model the session last ran with.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObj, readHeadLines, readTailLines, str } from "../adapters/jsonl.js";

export type { ChatItem, ChatSettings, ChatState, ChatView } from "./chatTypes.js";
import type { ChatItem, ChatSettings, ChatView } from "./chatTypes.js";

const OUTPUT_CHARS = 6000;
const DIFF_CHARS = 12000;
const MAX_ITEMS = 400;
// a log with inline images can be hundreds of MB; the conversation is in its last part
const TAIL_BYTES = 48 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

const clip = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max)}` : s);
const clipHead = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…` : s);
const fileUrl = (p: string) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

function texts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObj)
    .map((b) => str(b.text) ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function commandLine(cmd: unknown): string {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd)) return "";
  const parts = cmd.map(String);
  // ["/bin/zsh", "-lc", "<the command>"]: show the command
  if (parts.length === 3 && /^-[a-z]*c$/.test(parts[1]!)) return parts[2]!;
  return parts.join(" ");
}

/** One item of the log's `item_completed` events, as the conversation shows it. */
export function chatItem(it: Record<string, unknown>, at?: string): ChatItem | undefined {
  const id = str(it.id) ?? `${str(it.type)}-${at}`;
  switch (it.type) {
    case "UserMessage": {
      const content = Array.isArray(it.content) ? it.content.filter(isObj) : [];
      const images = content.filter((b) => /image/i.test(str(b.type) ?? "")).length;
      const text = texts(content);
      if (!text && !images) return undefined;
      return { kind: "user", id, text, ...(images ? { images } : {}), at };
    }
    case "AgentMessage": {
      const text = texts(it.content);
      if (!text) return undefined;
      return { kind: "agent", id, text, ...(it.phase === "commentary" ? { commentary: true } : {}), at };
    }
    case "CommandExecution": {
      const output = str(it.aggregated_output) ?? [str(it.stdout), str(it.stderr)].filter(Boolean).join("\n");
      const d = isObj(it.duration) ? Number(it.duration.secs ?? 0) + Number(it.duration.nanos ?? 0) / 1e9 : undefined;
      return {
        kind: "command",
        id,
        command: commandLine(it.command),
        ...(output ? { output: clip(output.trimEnd(), OUTPUT_CHARS) } : {}),
        ...(typeof it.exit_code === "number" ? { exit: it.exit_code } : {}),
        status: str(it.status),
        ...(d !== undefined && Number.isFinite(d) ? { seconds: Math.round(d * 10) / 10 } : {}),
        at,
      };
    }
    case "FileChange": {
      const changes = isObj(it.changes) ? it.changes : {};
      const files = Object.entries(changes).map(([p, c]) => {
        const ch = isObj(c) ? c : {};
        const diff = str(ch.unified_diff);
        return { path: p, change: str(ch.type) ?? "update", ...(diff ? { diff: clipHead(diff, DIFF_CHARS) } : {}) };
      });
      return files.length ? { kind: "files", id, files, at } : undefined;
    }
    case "McpToolCall": {
      const name = [str(it.appName) ?? str(it.server), str(it.actionName) ?? str(it.tool)].filter(Boolean).join(" ");
      let detail: string | undefined;
      try {
        detail = it.arguments === undefined ? undefined : JSON.stringify(it.arguments);
      } catch {
        detail = undefined;
      }
      return { kind: "tool", id, name: name || "tool", ...(detail ? { detail: clipHead(detail, 400) } : {}), status: str(it.status), at };
    }
    case "ImageView": {
      const p = str(it.path);
      return p ? { kind: "image", id, path: fileUrl(p), at } : undefined;
    }
    case "ContextCompaction":
      return { kind: "note", id, text: "Earlier conversation compacted", tone: "info", at };
    case "Reasoning":
    case "Extension":
      return undefined;
    default:
      return typeof it.type === "string" ? { kind: "tool", id, name: it.type, at } : undefined;
  }
}

function sandboxOf(tc: Record<string, unknown>, cwd: string | undefined): Pick<ChatSettings, "sandbox" | "network" | "roots"> {
  const sp = isObj(tc.sandbox_policy) ? tc.sandbox_policy : undefined;
  const sandbox = typeof tc.sandbox_policy === "string" ? tc.sandbox_policy : str(sp?.type);
  const network = typeof sp?.network_access === "boolean" ? sp.network_access : undefined;
  const roots = new Set<string>();
  for (const r of Array.isArray(sp?.writable_roots) ? sp.writable_roots : []) if (typeof r === "string") roots.add(r);
  const fsp = isObj(tc.file_system_sandbox_policy) ? tc.file_system_sandbox_policy : undefined;
  for (const e of Array.isArray(fsp?.entries) ? fsp.entries.filter(isObj) : []) {
    const p = isObj(e.path) && e.path.type === "path" ? str(e.path.path) : undefined;
    if (p && e.access === "write") roots.add(p);
  }
  if (cwd) roots.delete(cwd);
  return { sandbox, ...(network !== undefined ? { network } : {}), roots: [...roots] };
}

/** The conversation in a rollout log's lines. */
export function readChatLines(head: unknown[], tail: unknown[], file = ""): ChatView {
  const meta = head.find((r) => isObj(r) && r.type === "session_meta") as Record<string, unknown> | undefined;
  const m = isObj(meta?.payload) ? meta.payload : {};
  const id = str(m.id) ?? str(m.session_id) ?? path.basename(file);
  const source = str(m.source);
  const origin = str(m.originator) === "codex_exec" || source === "exec" ? "exec" : source === "vscode" ? "app" : source;
  const settings: ChatSettings = { cwd: str(m.cwd), roots: [] };
  const items = new Map<string, ChatItem>();
  let started = -1;
  let ended = -1;
  let turnAt: string | undefined;
  let structured = false;
  const fallback: ChatItem[] = [];

  tail.forEach((r, i) => {
    if (!isObj(r) || !isObj(r.payload)) return;
    const p = r.payload;
    const at = str(r.timestamp);
    if (r.type === "turn_context") {
      settings.cwd = str(p.cwd) ?? settings.cwd;
      settings.model = str(p.model) ?? settings.model;
      settings.effort = str(p.effort) ?? (isObj(p.collaboration_mode) && isObj(p.collaboration_mode.settings) ? str(p.collaboration_mode.settings.reasoning_effort) : undefined) ?? settings.effort;
      settings.approval = str(p.approval_policy) ?? settings.approval;
      Object.assign(settings, sandboxOf(p, settings.cwd));
      return;
    }
    if (r.type === "event_msg") {
      if (p.type === "task_started") {
        started = i;
        turnAt = at;
      }
      else if (p.type === "task_complete") ended = i;
      else if (p.type === "turn_aborted") {
        ended = i;
        items.set(`aborted-${i}`, { kind: "note", id: `aborted-${i}`, text: "Stopped", tone: "info", at });
      } else if (p.type === "error") {
        items.set(`error-${i}`, { kind: "note", id: `error-${i}`, text: str(p.message) ?? "Codex reported an error", tone: "error", at });
      } else if (p.type === "item_completed" && isObj(p.item)) {
        structured = true;
        const item = chatItem(p.item, at);
        if (item) {
          items.delete(item.id); // a repeat moves to where it was seen last
          items.set(item.id, item);
        }
      }
      return;
    }
    // logs from versions without item events: messages only
    if (r.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = texts(p.content);
      if (!text || (p.role === "user" && (text.startsWith("<") || text.startsWith("# AGENTS.md")))) return;
      fallback.push(p.role === "user" ? { kind: "user", id: `m${i}`, text, at } : { kind: "agent", id: `m${i}`, text, at });
    }
  });

  const all = structured ? [...items.values()] : [...fallback, ...[...items.values()].filter((x) => x.kind === "note")];
  const firstUser = all.find((x) => x.kind === "user") as Extract<ChatItem, { kind: "user" }> | undefined;
  return {
    id,
    file,
    ...(origin ? { origin } : {}),
    ...(firstUser ? { title: firstUser.text.split("\n")[0]!.slice(0, 80) } : {}),
    settings,
    working: started > ended,
    ...(started > ended && turnAt ? { turnStarted: turnAt } : {}),
    items: all.slice(-MAX_ITEMS),
    earlier: Math.max(0, all.length - MAX_ITEMS),
  };
}

export function readChat(file: string): ChatView {
  return readChatLines(readHeadLines(file, HEAD_BYTES), readTailLines(file, TAIL_BYTES), file);
}

const toml = (s: string) => JSON.stringify(s);

/**
 * The arguments for `codex` to send one message to the session, read from stdin, with the
 * sandbox, folders and model it last ran with. `codex exec resume` takes no sandbox flags and
 * would otherwise fall back to the user's config, which may allow more than the session had.
 */
export function resumeArgs(id: string, s: ChatSettings): string[] {
  const sandbox = s.sandbox;
  if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") {
    throw new Error(`this session ran with a sandbox parawatch does not know (${sandbox ?? "none recorded"}); continue it in Codex`);
  }
  const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
  args.push("-c", `sandbox_mode=${toml(sandbox)}`);
  // a message sent from here has no one to ask, so it never waits for an approval
  args.push("-c", `approval_policy="never"`);
  if (sandbox === "workspace-write") {
    if (s.network !== undefined) args.push("-c", `sandbox_workspace_write.network_access=${s.network}`);
    if (s.roots.length) args.push("-c", `sandbox_workspace_write.writable_roots=[${s.roots.map(toml).join(",")}]`);
  }
  if (s.model) args.push("-m", s.model);
  if (s.effort) args.push("-c", `model_reasoning_effort=${toml(s.effort)}`);
  args.push(id, "-");
  return args;
}

/** Where the codex command is. An app started from the Dock does not get the shell's PATH. */
export function findCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.PARAWATCH_CODEX_BIN) return env.PARAWATCH_CODEX_BIN;
  const names = platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  const home = os.homedir();
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter),
    ...(platform === "win32"
      ? [env.APPDATA && path.join(env.APPDATA, "npm"), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "codex")]
      : ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), path.join(home, ".volta", "bin"), path.join(home, ".bun", "bin")]),
  ].filter((d): d is string => !!d);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  if (platform === "win32") return undefined;
  try {
    const shell = env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-lc", "command -v codex"], { encoding: "utf8", timeout: 5000 }).trim().split("\n").pop();
    return out && path.isAbsolute(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Processes that have the log open: a Codex app or terminal that has the session loaded. Unknown on Windows. */
export function logOpenBy(file: string, platform: NodeJS.Platform = process.platform): number[] | undefined {
  if (platform === "win32") return undefined;
  try {
    const out = execFileSync("lsof", ["-t", "--", file], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => n > 0);
  } catch (err) {
    // lsof exits 1 when no process has it open
    return (err as { status?: number }).status === 1 ? [] : undefined;
  }
}

/** Why a message cannot be sent now, or undefined when it can. */
export function cannotSend(view: Pick<ChatView, "working" | "settings">, openBy: number[] | undefined, mine: number[] = []): string | undefined {
  if (view.working) return "Codex is working on this session. Wait until it finishes.";
  if (openBy?.some((p) => !mine.includes(p))) return "This session is open in Codex (the app or a terminal). Continue it there, or close it there first.";
  const s = view.settings.sandbox;
  if (s !== "read-only" && s !== "workspace-write" && s !== "danger-full-access") return `This session ran with a sandbox parawatch does not know (${s ?? "none recorded"}). Continue it in Codex.`;
  return undefined;
}

/** A line of `codex exec --json` that says what Codex is doing now, if it is one. */
export function liveLine(line: string): string | undefined {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(e) || e.type !== "item.started" || !isObj(e.item)) return undefined;
  const it = e.item;
  if (it.type === "command_execution") return `Running ${commandLine(it.command)}`.slice(0, 200);
  if (it.type === "file_change") return "Editing files";
  if (it.type === "mcp_tool_call") return `Using ${[str(it.server), str(it.tool)].filter(Boolean).join(" ")}`;
  if (it.type === "web_search") return "Searching the web";
  if (it.type === "reasoning") return "Thinking";
  return undefined;
}
