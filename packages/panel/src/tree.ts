import type { Run, RunState } from "./types";

export const OTHER = "other";
const ENDED = new Set<RunState>(["done", "idle"]);
/** Finished subagents older than this fold into one "N finished" row. */
export const FOLD_AFTER_MS = 5 * 60_000;

export interface RunNode {
  run: Run;
  depth: number;
}

export interface FoldNode {
  folded: Run[];
  depth: number;
  parent: string;
}

export type TreeRow = RunNode | FoldNode;

export interface Group {
  name: string;
  rows: TreeRow[];
  working: number;
}

/** Group runs by project and lay out each group as a tree, children after their parent. */
export function groupRuns(runs: Run[], now: number, expanded: Set<string> = new Set()): Group[] {
  const by = new Map<string, Run[]>();
  for (const r of runs) {
    const k = r.project ?? OTHER;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  const names = [...by.keys()].sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)));
  return names.map((name) => {
    const rs = by.get(name)!;
    const ids = new Set(rs.map((r) => r.id));
    const rows: TreeRow[] = [];
    const walk = (r: Run, depth: number) => {
      rows.push({ run: r, depth });
      const kids = rs.filter((x) => x.parent === r.id);
      const old = (k: Run) => ENDED.has(k.state) && now - Date.parse(k.lastActivity ?? "") > FOLD_AFTER_MS;
      const shown = expanded.has(r.id) ? kids : kids.filter((k) => !old(k));
      for (const k of shown) walk(k, depth + 1);
      const folded = kids.filter((k) => !shown.includes(k));
      if (folded.length) rows.push({ folded, depth: depth + 1, parent: r.id });
    };
    // leads first, then the rest by recent activity (runs arrive newest first)
    const roots = rs.filter((r) => !r.parent || !ids.has(r.parent));
    roots.sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead"));
    for (const r of roots) walk(r, 0);
    const working = rs.filter((r) => r.state === "working" || r.state === "waiting").length;
    return { name, rows, working };
  });
}

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One line of plain text from an agent message. */
export function clean(s: string | undefined): string {
  return (s ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/^\s*(?:[-*>]|#+)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
