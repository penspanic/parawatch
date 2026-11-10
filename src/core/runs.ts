import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scanAll } from "../adapters/index.js";
import { ACTIVITY_MINUTES, activeMinutes } from "../adapters/jsonl.js";
import { archivedSessions } from "./desktop.js";
import { canonicalPath, insidePath, namesPath, samePath } from "./paths.js";
import type { State } from "./state.js";
import { deviceName, sharedDir } from "./store.js";
import type { Claim, DeclaredRun, Project, Run } from "./types.js";

/** All checkouts of a project path: the path itself plus its git worktrees. */
function rootsOf(p: string, cache: Map<string, string[]>): string[] {
  const hit = cache.get(p);
  if (hit) return hit;
  const roots = [p];
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", p, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    // a folder inside a bigger repo (a notes vault, a monorepo package) must not claim the whole repo
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    if (!samePath(top, p)) {
      cache.set(p, roots);
      return roots;
    }
    const out = git(["worktree", "list", "--porcelain"]);
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        const w = line.slice("worktree ".length).trim();
        if (w && !roots.includes(w)) roots.push(w);
      }
    }
  } catch {
    // not a git checkout, or git missing; the path alone still matches
  }
  cache.set(p, roots);
  return roots;
}

interface Matcher {
  project: string;
  roots: { path: string; canonical: string }[];
}

function matchers(projects: Project[]): Matcher[] {
  const cache = new Map<string, string[]>();
  return projects.map((p) => ({
    project: p.name,
    roots: p.paths.flatMap((x) => rootsOf(x, cache)).map((r) => ({ path: r, canonical: canonicalPath(r) })),
  }));
}

/** The project whose checkout holds this directory; the deepest root wins. */
function projectForCwd(cwd: string | undefined, ms: Matcher[]): string | undefined {
  if (!cwd) return undefined;
  const child = canonicalPath(cwd);
  let best: { project: string; depth: number } | undefined;
  for (const m of ms) {
    for (const r of m.roots) {
      if (insidePath(cwd, r.path, { child, parent: r.canonical }) && (!best || r.path.length > best.depth)) best = { project: m.project, depth: r.path.length };
    }
  }
  return best?.project;
}

/** A project whose path the run's first prompt names, when exactly one does. */
function projectForPrompt(prompt: string | undefined, ms: Matcher[]): string | undefined {
  if (!prompt) return undefined;
  const hits = new Set<string>();
  for (const m of ms) {
    for (const r of m.roots) if (namesPath(prompt, r.path)) hits.add(m.project);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** The project most of these folders belong to (ties go to the most recent), with its count. */
function projectForEdits(dirs: string[] | undefined, ms: Matcher[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of dirs ?? []) {
    const p = projectForCwd(d, ms);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

function topOf(counts: Map<string, number>, dirs: string[] | undefined, ms: Matcher[]): string | undefined {
  let best: string | undefined;
  let n = 0;
  // walk newest first so a tie goes to where the run worked last
  for (const d of [...(dirs ?? [])].reverse()) {
    const p = projectForCwd(d, ms);
    if (p && (counts.get(p) ?? 0) > n) {
      best = p;
      n = counts.get(p)!;
    }
  }
  return best;
}

function claimFor(id: string, state: State) {
  return state.claims.find((c) => id.startsWith(c.session));
}

/**
 * Give each observed run a project, in this order: an explicit claim; the checkout it runs in,
 * unless it only edits files of another project; its parent's project; the project whose files it
 * edits most; a project path named in its first prompt.
 */
function applyClaim(r: Run, claim: Claim): void {
  r.project = claim.project;
  r.projectSource = "claim";
  r.task = claim.task ?? r.task;
  r.role = claim.role ?? r.role;
  if (claim.title) r.title = claim.title;
  if (claim.kind === "scheduled") r.scheduled = true;
  // done until someone writes to the session again
  if (claim.done && claim.at && (!r.lastPromptAt || r.lastPromptAt < claim.at)) {
    r.done = claim.done;
    // a session that says it is finished is not stuck, even if its log ends mid-turn
    if (r.state === "idle" || r.state === "stalled") r.state = "done";
    r.asks = undefined;
  }
}

export function attribute(runs: Run[], state: State): Run[] {
  const ms = matchers([...state.projects.values()]);
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const r of runs) {
    const claim = claimFor(r.id, state);
    if (claim) {
      applyClaim(r, claim);
      continue;
    }
    const here = projectForCwd(r.cwd, ms);
    const edits = projectForEdits(r.touched, ms);
    if (here && !r.parent && edits.size && !edits.has(here)) {
      r.project = topOf(edits, r.touched, ms);
      r.projectSource = "edits";
    } else if (here) {
      r.project = here;
      r.projectSource = "cwd";
    }
  }
  // parents may themselves get a project only from a claim, so resolve children afterwards
  for (let pass = 0; pass < 3; pass++) {
    for (const r of runs) {
      if (r.project || !r.parent) continue;
      const p = byId.get(r.parent);
      const project = p?.project ?? claimFor(r.parent, state)?.project;
      if (project) {
        r.project = project;
        r.projectSource = "parent";
      }
    }
  }
  for (const r of runs) {
    if (r.project) continue;
    const edits = topOf(projectForEdits(r.touched, ms), r.touched, ms);
    const prompt = edits ? undefined : projectForPrompt(r.prompt, ms);
    r.project = edits ?? prompt;
    if (r.project) r.projectSource = edits ? "edits" : "prompt";
  }
  return runs;
}

/**
 * A Claude Code session the human archived in the Claude desktop app has ended, even when its log
 * stops mid-turn (archived while a tool ran, say), and so have its subagents.
 */
export function endArchived(runs: Run[], isArchived: (session: string) => boolean): Run[] {
  const ended = new Set<string>();
  for (const r of runs) {
    if (r.runtime !== "claude-code" || r.kind !== "session" || r.device || !isArchived(r.id)) continue;
    ended.add(r.id);
  }
  for (const r of runs) {
    if (!ended.has(r.id) && !(r.parent && ended.has(r.parent))) continue;
    if (r.state === "failed") continue;
    r.state = "done";
    if (ended.has(r.id)) r.done ??= "archived in the Claude app";
    r.asks = undefined;
  }
  return runs;
}

/**
 * Fold repeated runs of a scheduled task into the newest one, with a count. Runs claimed as
 * scheduled group by project and task; unclaimed top-level sessions group by an identical first
 * prompt. A run still working is never folded away.
 */
export function foldRepeats(runs: Run[]): Run[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.kind !== "session" || r.parent) continue;
    const key = r.scheduled ? `s:${r.project}:${r.task ?? r.title}` : r.projectSource === "claim" || !r.prompt ? undefined : `p:${r.prompt}`;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const drop = new Set<Run>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
    const [newest, ...older] = g;
    let n = 0;
    for (const r of older) {
      if (r.state === "working" || r.state === "waiting" || r.asks) continue;
      drop.add(r);
      n++;
    }
    if (n) {
      newest!.repeats = n;
      newest!.scheduled = true;
    }
  }
  // children of a folded run go with it
  const gone = new Set([...drop].map((r) => r.id));
  return runs.filter((r) => !drop.has(r) && !(r.parent && gone.has(r.parent)));
}

/** Linked pull requests, put on the run that owns them. */
function attachPrs(runs: Run[], state: State): void {
  for (const link of state.prLinks.values()) {
    if (!link.session) continue;
    const r = runs.find((x) => x.id.startsWith(link.session!));
    if (r) (r.prs ??= []).push(link.pr.key);
  }
}

/** A declared run is busy from its start until it ends (or now, while it runs). */
function declaredActivity(start: string, end: string | undefined, now: number): number[] {
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  const times: number[] = [];
  for (let t = Math.max(from, now - ACTIVITY_MINUTES * 60_000); t <= to; t += 60_000) times.push(t);
  if (to >= from) times.push(to);
  return activeMinutes(times, now);
}

/** When a declared run last showed life: its last beat or note, or its log file changing. */
function lastSign(d: DeclaredRun): string {
  if (!d.log) return d.lastActivity;
  try {
    const m = new Date(fs.statSync(d.log).mtimeMs).toISOString();
    return m > d.lastActivity ? m : d.lastActivity;
  } catch {
    return d.lastActivity;
  }
}

export function declaredRuns(state: State, now = Date.now()): Run[] {
  return [...state.runs.values()].map((d) => {
    const last = d.status === "running" ? lastSign(d) : d.lastActivity;
    const quiet = d.status === "running" && d.heartbeat !== undefined && now - Date.parse(last) > d.heartbeat * 1000;
    return {
      id: d.id,
      runtime: "declared",
      kind: "declared" as const,
      title: d.title,
      project: d.project,
      task: d.task,
      parent: d.parent,
      startedAt: d.startedAt,
      lastActivity: last,
      state: quiet ? ("stalled" as const) : d.status === "running" ? ("working" as const) : d.status,
      action: quiet ? `no sign of life for ${Math.round((now - Date.parse(last)) / 60_000)}m${d.note ? ` · ${d.note}` : ""}` : d.note,
      projectSource: "claim" as const,
      activity: declaredActivity(d.startedAt, d.status === "running" ? undefined : (d.endedAt ?? d.lastActivity), now),
    };
  });
}

// ---------------------------------------------------------------- other machines

/** How often a machine rewrites its runs for the others, and when its summary counts as gone. */
const SHARE_EVERY_MS = 30_000;
export const SHARED_RUNS_GONE_MS = 15 * 60_000;

/** `runs/<device>.json` in the shared folder: what a machine's agents were doing at `at`. */
interface SharedRuns {
  v: 1;
  device: string;
  at: string;
  runs: Run[];
}

const SHARED_RUNS_FILE = /^([a-z0-9][a-z0-9-]{0,31})\.json$/;

function sharedRunsDir(): string | undefined {
  const s = sharedDir();
  return s ? path.join(s, "runs") : undefined;
}

/**
 * Write the runs read from this machine's agent logs where the other machines read them, at most
 * every half minute. The logs themselves stay here; only the summary travels.
 */
export function shareRuns(runs: Run[], now = Date.now()): void {
  if (!shareRunsDue(now)) return;
  const dir = sharedRunsDir()!;
  const me = deviceName();
  const file = path.join(dir, `${me}.json`);
  // the folders it edited are paths on this machine, and only guide attribution here
  const slim = runs.map(({ touched: _t, ...r }) => ({ ...r, prompt: r.prompt?.slice(0, 300) }));
  const body: SharedRuns = { v: 1, device: me, at: new Date(now).toISOString(), runs: slim };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${me}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(body) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    // the folder may be busy syncing; the next reading writes it again
  }
}

/** Whether this machine's summary for the others is due (a shared folder, and none written lately). */
export function shareRunsDue(now = Date.now()): boolean {
  const dir = sharedRunsDir();
  if (!dir) return false;
  try {
    return now - fs.statSync(path.join(dir, `${deviceName()}.json`)).mtimeMs >= SHARE_EVERY_MS;
  } catch {
    return true;
  }
}

/**
 * Runs other machines shared, as they last wrote them, marked with the machine. A machine that
 * has not written for a while is left out: its agents may be long gone. Claims made since are
 * applied here, and the activity chart slides by the summary's age.
 */
export function otherRuns(state: State, now = Date.now()): Run[] {
  const dir = sharedRunsDir();
  if (!dir) return [];
  const me = deviceName();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Run[] = [];
  for (const n of names.sort()) {
    const m = SHARED_RUNS_FILE.exec(n);
    if (!m || m[1] === me) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as SharedRuns;
      const at = Date.parse(s.at);
      if (!Number.isFinite(at) || now - at > SHARED_RUNS_GONE_MS || !Array.isArray(s.runs)) continue;
      const shift = Math.max(0, Math.floor((now - at) / 60_000));
      for (const r of s.runs) {
        const run: Run = { ...r, device: m[1], activity: r.activity?.map((x) => x + shift).filter((x) => x < ACTIVITY_MINUTES) };
        const claim = claimFor(run.id, state);
        if (claim) applyClaim(run, claim);
        out.push(run);
      }
    } catch {
      // half synced; read it next time
    }
  }
  return out;
}

export interface RunQuery {
  sinceHours: number;
  project?: string;
  includeEnded?: boolean;
  runtimes?: string[];
  /** show every run of a scheduled task instead of folding them */
  keepRepeats?: boolean;
}

const ENDED = new Set(["done", "idle", "failed"]);
const RECENT_END_MS = 30 * 60_000;
const OLD_STALL_MS = 3 * 3_600_000;

export function collectRuns(state: State, q: RunQuery, now = Date.now()): Run[] {
  const sinceMs = now - q.sinceHours * 3_600_000;
  // a log file can be touched (title records, snapshots) long after its last real activity
  const recent = (r: Run) => !r.lastActivity || Date.parse(r.lastActivity) >= sinceMs;
  let runs = endArchived(attribute(scanAll({ sinceMs, now }, q.runtimes), state), archivedSessions()).filter(recent);
  // a narrower reading (one runtime) would hide the rest from the other machines
  if (!q.runtimes) shareRuns(runs, now);
  runs.push(...otherRuns(state, now).filter(recent));
  runs.push(...declaredRuns(state, now).filter(recent));
  attachPrs(runs, state);
  if (q.project) runs = runs.filter((r) => r.project === q.project);
  if (!q.includeEnded) {
    // keep what is moving, plus things that finished in the last half hour and parents of live children
    const live = new Set(runs.filter((r) => !ENDED.has(r.state)).map((r) => r.parent).filter(Boolean));
    runs = runs.filter((r) => {
      // a run quiet for hours is almost always gone, not stuck; --all still shows it
      if (r.state === "stalled") return r.lastActivity ? now - Date.parse(r.lastActivity) < OLD_STALL_MS : true;
      if (!ENDED.has(r.state)) return true;
      if (r.asks) return true; // still waiting for the human to read it
      if (live.has(r.id)) return true;
      if (r.role === "lead") return true;
      return r.lastActivity ? now - Date.parse(r.lastActivity) < RECENT_END_MS : false;
    });
  }
  if (!q.keepRepeats) runs = foldRepeats(runs);
  return runs.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}
