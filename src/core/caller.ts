/**
 * The agent session running a command. Claude Code puts its session in `CLAUDE_CODE_SESSION_ID`,
 * Codex its thread in `CODEX_THREAD_ID`. A process started by one agent inherits that agent's
 * variables, so a `codex exec` worker a Claude Code session launched has both, and so does a
 * Claude Code session started from a Codex shell. The command belongs to the innermost agent:
 * the one met first walking up from this process's parent. Claude Code says which process it is
 * (`CLAUDE_PID`); Codex is known by its command name.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface ProcessInfo {
  ppid: number;
  /** the command line, or at least the program */
  command: string;
}

export type ProcessTable = Map<number, ProcessInfo>;

export interface CallerEnv {
  CLAUDE_CODE_SESSION_ID?: string;
  CODEX_THREAD_ID?: string;
  CLAUDE_PID?: string;
}

/** Whether a command line runs Codex: its program, or the script node runs, is `codex`. */
export function isCodex(command: string): boolean {
  const words = command.trim().split(/\s+/).slice(0, 2);
  return words.some((w) => /^codex(\.exe|\.cmd|\.js|\.mjs)?$/i.test(path.basename(w.replace(/^"|"$/g, "").replace(/\\/g, "/"))));
}

const isClaude = (command: string) => {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return /^claude(\.exe)?$/i.test(path.basename(first.replace(/^"|"$/g, "").replace(/\\/g, "/")));
};

/**
 * Which agent is nearer, walking up from `from`: "codex", "claude", or undefined when the walk
 * finds neither (the table could not be read, or the chain ends).
 */
export function nearestAgent(table: ProcessTable, from: number, claudePid?: number): "codex" | "claude" | undefined {
  let pid = from;
  for (let i = 0; i < 64 && pid > 1; i++) {
    const p = table.get(pid);
    if (!p) return undefined;
    if (claudePid !== undefined && pid === claudePid) return "claude";
    if (isCodex(p.command)) return "codex";
    if (claudePid === undefined && isClaude(p.command)) return "claude";
    pid = p.ppid;
  }
  return undefined;
}

/** Every process with its parent and command line; empty when they cannot be read (a sandbox). */
export function processTable(platform: NodeJS.Platform = process.platform): ProcessTable {
  const out: ProcessTable = new Map();
  try {
    if (platform === "win32") {
      const json = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      const rows = JSON.parse(json) as { ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string | null }[] | object;
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        const x = r as { ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string | null };
        out.set(x.ProcessId, { ppid: x.ParentProcessId, command: x.CommandLine || x.Name || "" });
      }
    } else {
      const text = execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of text.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) out.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]! });
      }
    }
  } catch {
    // ps refused (Codex's sandbox does) or is missing
  }
  return out;
}

/**
 * The session id of the agent running this command. With only one agent's variable set, that
 * one. With both, the nearer agent's; when the process tree cannot tell (a sandbox that hides
 * it), Codex's: a Claude Code session launching Codex workers is the usual way both are set.
 */
export function callingSession(env: CallerEnv = process.env, table: () => ProcessTable = () => processTable(), from = process.ppid): string | undefined {
  const claude = env.CLAUDE_CODE_SESSION_ID || undefined;
  const codex = env.CODEX_THREAD_ID || undefined;
  if (!claude || !codex) return claude ?? codex;
  const claudePid = env.CLAUDE_PID && /^\d+$/.test(env.CLAUDE_PID) ? Number(env.CLAUDE_PID) : undefined;
  return nearestAgent(table(), from, claudePid) === "claude" ? claude : codex;
}
