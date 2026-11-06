import { execFileSync } from "node:child_process";
import path from "node:path";
import { scanAll } from "../adapters/index.js";
import type { State } from "./state.js";
import type { Project, Run } from "./types.js";

/** All checkouts of a project path: the path itself plus its git worktrees. */
function rootsOf(p: string, cache: Map<string, string[]>): string[] {
  const hit = cache.get(p);
  if (hit) return hit;
  const roots = [p];
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", p, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    // a folder inside a bigger repo (a notes vault, a monorepo package) must not claim the whole repo
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    if (path.resolve(top) !== path.resolve(p)) {
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

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface Matcher {
  project: string;
  roots: string[];
}

function matchers(projects: Project[]): Matcher[] {
  const cache = new Map<string, string[]>();
  return projects.map((p) => ({ project: p.name, roots: p.paths.flatMap((x) => rootsOf(x, cache)) }));
}

/** The project whose checkout holds this directory; the deepest root wins. */
function projectForCwd(cwd: string | undefined, ms: Matcher[]): string | undefined {
  if (!cwd) return undefined;
  let best: { project: string; depth: number } | undefined;
  for (const m of ms) {
    for (const r of m.roots) {
      if (inside(cwd, r) && (!best || r.length > best.depth)) best = { project: m.project, depth: r.length };
    }
  }
  return best?.project;
}

/** A project whose path the run's first prompt names, when exactly one does. */
function projectForPrompt(prompt: string | undefined, ms: Matcher[]): string | undefined {
  if (!prompt) return undefined;
  const hits = new Set<string>();
  for (const m of ms) {
    for (const r of m.roots) if (prompt.includes(r)) hits.add(m.project);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/**
 * Give each observed run a project, in this order: an explicit claim, the checkout
 * it runs in, its parent's project, a project path named in its first prompt.
 */
export function attribute(runs: Run[], state: State): Run[] {
  const ms = matchers([...state.projects.values()]);
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const r of runs) {
    const claim = state.claims.find((c) => r.id.startsWith(c.session));
    if (claim) {
      r.project = claim.project;
      r.task = claim.task ?? r.task;
      r.role = claim.role ?? r.role;
      if (claim.title) r.title = claim.title;
      continue;
    }
    r.project = projectForCwd(r.cwd, ms);
  }
  // parents may themselves get a project only from a claim, so resolve children afterwards
  for (let pass = 0; pass < 3; pass++) {
    for (const r of runs) {
      if (r.project || !r.parent) continue;
      const p = byId.get(r.parent);
      if (p?.project) r.project = p.project;
      else r.project = state.claims.find((c) => r.parent!.startsWith(c.session))?.project;
    }
  }
  for (const r of runs) {
    if (!r.project) r.project = projectForPrompt(r.prompt, ms);
  }
  return runs;
}

export function declaredRuns(state: State): Run[] {
  return [...state.runs.values()].map((d) => ({
    id: d.id,
    runtime: "declared",
    kind: "declared" as const,
    title: d.title,
    project: d.project,
    task: d.task,
    parent: d.parent,
    startedAt: d.startedAt,
    lastActivity: d.lastActivity,
    state: d.status === "running" ? ("working" as const) : d.status,
    action: d.note,
  }));
}

export interface RunQuery {
  sinceHours: number;
  project?: string;
  includeEnded?: boolean;
  runtimes?: string[];
}

const ENDED = new Set(["done", "idle", "failed"]);
const RECENT_END_MS = 30 * 60_000;
const OLD_STALL_MS = 3 * 3_600_000;

export function collectRuns(state: State, q: RunQuery, now = Date.now()): Run[] {
  const sinceMs = now - q.sinceHours * 3_600_000;
  // a log file can be touched (title records, snapshots) long after its last real activity
  const recent = (r: Run) => !r.lastActivity || Date.parse(r.lastActivity) >= sinceMs;
  let runs = attribute(scanAll({ sinceMs, now }, q.runtimes), state).filter(recent);
  runs.push(...declaredRuns(state).filter(recent));
  if (q.project) runs = runs.filter((r) => r.project === q.project);
  if (!q.includeEnded) {
    // keep what is moving, plus things that finished in the last half hour and parents of live children
    const live = new Set(runs.filter((r) => !ENDED.has(r.state)).map((r) => r.parent).filter(Boolean));
    runs = runs.filter((r) => {
      // a run quiet for hours is almost always gone, not stuck; --all still shows it
      if (r.state === "stalled") return r.lastActivity ? now - Date.parse(r.lastActivity) < OLD_STALL_MS : true;
      if (!ENDED.has(r.state)) return true;
      if (live.has(r.id)) return true;
      if (r.role === "lead") return true;
      return r.lastActivity ? now - Date.parse(r.lastActivity) < RECENT_END_MS : false;
    });
  }
  return runs.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}
