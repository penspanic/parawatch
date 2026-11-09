import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePrRef } from "./github.js";
import { sessionTitle, UserError } from "./ops.js";
import type { State } from "./state.js";
import type { Card } from "./types.js";

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

export interface GotoTarget {
  /** the name to show: the claimed title, else the app's title, else the id */
  name: string;
  session: string;
  card?: Card;
  /** set when the session lives in the Claude desktop app */
  desktop?: DesktopSession;
  url?: string;
}

/** The session that owns a pull request: by URL, `owner/repo#N`, or `#N` / `repo#N` when only one matches. */
function prSession(target: string, state: State): string | undefined {
  const ref = parsePrRef(target);
  if (ref) {
    const link = state.prLinks.get(ref.key);
    if (!link) throw new UserError(`no session owns ${ref.repo}#${ref.number}; link it from that session with: parawatch pr link ${ref.url}`);
    if (!link.session) throw new UserError(`${ref.repo}#${ref.number} is linked to a project but not to a session`);
    return link.session;
  }
  const m = /^(?:([^/\s#]+))?#(\d+)$/.exec(target.trim());
  if (!m) return undefined;
  const hits = [...state.prLinks.values()].filter((l) => l.pr.number === Number(m[2]) && (!m[1] || l.pr.repo.split("/")[1] === m[1]));
  if (!hits.length) throw new UserError(`no session owns a pull request ${target}`);
  if (hits.length > 1) throw new UserError(`${target} matches ${hits.map((h) => h.pr.repo + "#" + h.pr.number).join(", ")}; give owner/repo#N`);
  if (!hits[0]!.session) throw new UserError(`${target} is linked to a project but not to a session`);
  return hits[0]!.session;
}

/** Where `goto` leads for a card id, a pull request, or a session id (prefix). */
export function resolveGoto(target: string, state: State): GotoTarget {
  const card = state.cards.get(target);
  const session = card ? card.session : (prSession(target, state) ?? target);
  if (!session) {
    throw new UserError(`card ${target} does not say which session opened it (set one with: parawatch edit ${target} --session <id>)`);
  }
  const desktop = findDesktopSession(session);
  const name = sessionTitle(state.claims, session) ?? desktop?.title ?? session.slice(0, 8);
  return { name, session, card, desktop, url: desktop ? desktopSessionUrl(desktop) : undefined };
}

/** A line to paste into the session so it knows which card the human means. */
export function cardContextLine(card: Card): string {
  return `About parawatch card ${card.id} ("${card.title}"): `;
}
