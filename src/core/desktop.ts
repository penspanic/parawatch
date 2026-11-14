import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePrRef } from "./github.js";
import { UserError } from "./errors.js";
import { sessionTitle, type State } from "./state.js";
import type { Card, Run } from "./types.js";

/**
 * Where the Claude desktop app keeps its Code sessions: one JSON file per session, named
 * `local_<id>.json`, holding the CLI session id the app runs (`cliSessionId`). On Windows the
 * Store build keeps them under `%LOCALAPPDATA%\Claude-Data\claude_<package>`, the installer build
 * under `%APPDATA%\Claude`.
 */
export function desktopSessionsDirs(): string[] {
  const env = process.env.PARAWATCH_CLAUDE_DESKTOP_DIR;
  if (env) return [env];
  const home = os.homedir();
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const out = [path.join(roaming, "Claude", "claude-code-sessions")];
    const data = path.join(local, "Claude-Data");
    try {
      for (const e of fs.readdirSync(data, { withFileTypes: true })) if (e.isDirectory() && /^claude_/i.test(e.name)) out.push(path.join(data, e.name, "claude-code-sessions"));
    } catch {
      // no Store build here
    }
    return out;
  }
  if (process.platform === "darwin") return [path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions")];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude-code-sessions")];
}

export interface DesktopSession {
  /** the app's id, `local_…` */
  id: string;
  cliSessionId: string;
  title?: string;
  cwd?: string;
  archived: boolean;
  lastActivityAt: number;
  /** its Remote Control session (`session_…`), when it has one: openable from any machine */
  remote?: string;
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

interface Read {
  mtimeMs: number;
  session?: DesktopSession & { ids: string[] };
}

/** Session files read before, by path; a file is read again only when it changes. */
const readCache = new Map<string, Read>();

/** Every desktop app session in the folder, read once per change of its file. */
function desktopSessions(dirs: string | string[]): (DesktopSession & { ids: string[] })[] {
  const out: (DesktopSession & { ids: string[] })[] = [];
  for (const file of [dirs].flat().flatMap((d) => [...sessionFiles(d)])) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let hit = readCache.get(file);
    if (!hit || hit.mtimeMs !== mtimeMs) {
      hit = { mtimeMs, session: readSessionFile(file) };
      readCache.set(file, hit);
    }
    if (hit.session) out.push(hit.session);
  }
  return out;
}

function readSessionFile(file: string): (DesktopSession & { ids: string[] }) | undefined {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const ids = [d.cliSessionId, d.lastAssistantCliSessionId].filter((x): x is string => typeof x === "string");
  if (!ids.length) return undefined;
  return {
    id: typeof d.sessionId === "string" ? d.sessionId : path.basename(file, ".json"),
    cliSessionId: ids[0]!,
    ids,
    title: typeof d.title === "string" ? d.title : undefined,
    cwd: typeof d.cwd === "string" ? d.cwd : undefined,
    archived: d.isArchived === true,
    lastActivityAt: typeof d.lastActivityAt === "number" ? d.lastActivityAt : 0,
    remote: Array.isArray(d.bridgeSessionIds) ? d.bridgeSessionIds.find((x): x is string => typeof x === "string" && REMOTE_ID.test(x)) : undefined,
  };
}

/** The desktop app session running a CLI session (full id or a prefix of 6+ characters). */
const REMOTE_ID = /^session_[A-Za-z0-9]+$/;

export function findDesktopSession(cliSession: string, dir: string | string[] = desktopSessionsDirs()): DesktopSession | undefined {
  if (cliSession.length < 6) return undefined;
  let best: DesktopSession | undefined;
  for (const { ids, ...s } of desktopSessions(dir)) {
    if (!ids.some((x) => x.startsWith(cliSession))) continue;
    // prefer a live session, then the most recent one
    if (!best || (best.archived && !s.archived) || (best.archived === s.archived && s.lastActivityAt > best.lastActivityAt)) best = s;
  }
  return best;
}

/**
 * The CLI sessions the human archived in the Claude desktop app, as a test for a session id
 * (full or a prefix of 6+ characters). Such a session never takes another turn, however its log
 * ends. A CLI session that a live desktop session also runs is not archived.
 */
export function archivedSessions(dir: string | string[] = desktopSessionsDirs()): (session: string | undefined) => boolean {
  const archived = new Set<string>();
  const live = new Set<string>();
  for (const s of desktopSessions(dir)) for (const id of s.ids) (s.archived ? archived : live).add(id);
  for (const id of live) archived.delete(id);
  const ids = [...archived];
  return (session) => {
    if (!session || session.length < 6) return false;
    if (archived.has(session)) return true;
    return ids.some((id) => id.startsWith(session));
  };
}

/** A link that opens the session in the Claude desktop app. */
export function desktopSessionUrl(s: DesktopSession): string {
  return `claude://code/continue?session=${encodeURIComponent(s.id)}&source=parawatch`;
}

/** A Remote Control session on claude.ai, which opens from any machine signed in to the account. */
export function remoteSessionUrl(id: string): string {
  return `https://claude.ai/code/${encodeURIComponent(id)}`;
}

/** Give each Claude Code session of this machine its Remote Control link, when it has one. */
export function withRemote(runs: Run[], dir: string | string[] = desktopSessionsDirs()): Run[] {
  const sessions = runs.filter((r) => r.runtime === "claude-code" && r.kind === "session" && !r.device);
  if (!sessions.length) return runs;
  const remote = new Map<string, string>();
  for (const s of desktopSessions(dir)) if (s.remote && !s.archived) for (const id of s.ids) remote.set(id, s.remote);
  for (const r of sessions) {
    const id = remote.get(r.id);
    if (id) r.remote = remoteSessionUrl(id);
  }
  return runs;
}

export interface GotoTarget {
  /** the name to show: the claimed title, else the app's title, else the id */
  name: string;
  session: string;
  card?: Card;
  /** the machine the session runs on, when not this one */
  device?: string;
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
export function resolveGoto(target: string, state: State, runs: Run[] = []): GotoTarget {
  const card = state.cards.get(target);
  let session = card ? card.session : (prSession(target, state) ?? target);
  if (!session) {
    throw new UserError(`card ${target} does not say which session opened it (set one with: parawatch edit ${target} --session <id>)`);
  }
  // a subagent has no window of its own: open the session it works under
  const byId = new Map(runs.map((r) => [r.id, r]));
  let run = runs.find((r) => r.id === session || (session!.length >= 6 && r.id.startsWith(session!)));
  for (let i = 0; run?.parent && byId.has(run.parent) && i < 8; i++) run = byId.get(run.parent);
  if (run) session = run.id;
  const desktop = run?.device ? undefined : findDesktopSession(session);
  const name = sessionTitle(state.claims, session) ?? run?.title ?? desktop?.title ?? session.slice(0, 8);
  const url = desktop ? desktopSessionUrl(desktop) : run?.remote;
  return { name, session, card, desktop, device: run?.device, url };
}

/** A line to paste into the session so it knows which card the human means. */
export function cardContextLine(card: Card): string {
  return `About parawatch card ${card.id} ("${card.title}"): `;
}
