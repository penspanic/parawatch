import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the Claude desktop app keeps its Code sessions: one JSON file per session, named
 * `local_<id>.json`, holding the CLI session id the app runs (`cliSessionId`).
 */
export function desktopSessionsDir(): string {
  return (
    process.env.PARAWATCH_CLAUDE_DESKTOP_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")
  );
}

export interface DesktopSession {
  /** the app's id, `local_…` */
  id: string;
  cliSessionId: string;
  title?: string;
  cwd?: string;
  archived: boolean;
  lastActivityAt: number;
}

function* sessionFiles(dir: string, depth = 0): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) yield* sessionFiles(p, depth + 1);
    else if (e.isFile() && /^local_[A-Za-z0-9-]+\.json$/.test(e.name)) yield p;
  }
}

/** The desktop app session running a CLI session (full id or a prefix of 6+ characters). */
export function findDesktopSession(cliSession: string, dir = desktopSessionsDir()): DesktopSession | undefined {
  if (cliSession.length < 6) return undefined;
  let best: DesktopSession | undefined;
  for (const file of sessionFiles(dir)) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const ids = [d.cliSessionId, d.lastAssistantCliSessionId].filter((x): x is string => typeof x === "string");
    if (!ids.some((x) => x.startsWith(cliSession))) continue;
    const s: DesktopSession = {
      id: typeof d.sessionId === "string" ? d.sessionId : path.basename(file, ".json"),
      cliSessionId: ids[0]!,
      title: typeof d.title === "string" ? d.title : undefined,
      cwd: typeof d.cwd === "string" ? d.cwd : undefined,
      archived: d.isArchived === true,
      lastActivityAt: typeof d.lastActivityAt === "number" ? d.lastActivityAt : 0,
    };
    // prefer a live session, then the most recent one
    if (!best || (best.archived && !s.archived) || (best.archived === s.archived && s.lastActivityAt > best.lastActivityAt)) best = s;
  }
  return best;
}

/** A link that opens the session in the Claude desktop app. */
export function desktopSessionUrl(s: DesktopSession): string {
  return `claude://code/continue?session=${encodeURIComponent(s.id)}&source=parawatch`;
}
