/**
 * Permission prompts a Claude Code session is showing, recorded by the optional hook
 * (`PermissionRequest`, or a `Notification` about a permission). In the log a prompt looks like a
 * tool call that has not returned yet, the same as a long command; only the hook can tell them apart.
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./store.js";
import type { Run } from "./types.js";

export interface PromptNote {
  at: string;
  /** what the session asks to run, e.g. "Bash: npm test" */
  what?: string;
}

function dir(): string {
  return path.join(homeDir(), "prompts");
}

function file(session: string): string {
  return path.join(dir(), `${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The hook's input, when it is about a permission prompt. */
export interface PromptHookInput {
  session_id?: string;
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Whether the hook input is a permission prompt; records it if so. */
export function recordPrompt(input: PromptHookInput, now = new Date()): boolean {
  const ev = input.hook_event_name;
  const isPermission =
    ev === "PermissionRequest" || (ev === "Notification" && (input.notification_type === "permission_prompt" || /\bpermission\b/i.test(input.message ?? "")));
  if (!isPermission || !input.session_id) return false;
  let what: string | undefined;
  if (input.tool_name) {
    const inp = input.tool_input ?? {};
    const pick = [inp.description, inp.command, inp.file_path, inp.url].find((x): x is string => typeof x === "string" && !!x);
    what = pick ? `${input.tool_name}: ${oneLine(pick, 80)}` : input.tool_name;
  } else if (input.message) {
    // "Claude needs your permission to use Bash"
    const m = /permission to use (.+)$/i.exec(input.message.trim());
    what = m ? m[1]!.trim() : undefined;
  }
  try {
    const prev = readPrompt(input.session_id);
    // a Notification after the PermissionRequest of the same prompt keeps the richer line
    const keep = prev && !input.tool_name && prev.what && now.getTime() - Date.parse(prev.at) < 60_000;
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(input.session_id), JSON.stringify(keep ? prev : { at: now.toISOString(), what }) + "\n");
  } catch {
    // a hook never fails the session
  }
  return true;
}

export function readPrompt(session: string): PromptNote | undefined {
  try {
    const p = JSON.parse(fs.readFileSync(file(session), "utf8")) as PromptNote;
    return typeof p.at === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A session whose last tool call has not returned and that showed a permission prompt after its
 * log last moved is waiting for the human to approve: it asks, blocked. A prompt the log has
 * moved past is over.
 */
export function applyPrompts(runs: Run[], read: (session: string) => PromptNote | undefined = readPrompt): Run[] {
  for (const r of runs) {
    if (r.runtime !== "claude-code" || r.kind !== "session" || r.device || !r.pendingTool) continue;
    if (r.state !== "working" && r.state !== "stalled") continue;
    const p = read(r.id);
    if (!p || !r.lastActivity || Date.parse(p.at) < Date.parse(r.lastActivity) - 2_000) continue;
    r.asks = { text: `approve a tool call${p.what ? `: ${p.what}` : ""}`, via: "permission", blocked: true, at: p.at };
    // like a session that asked in chat, it waits for the human rather than working
    r.state = "idle";
  }
  return runs;
}
