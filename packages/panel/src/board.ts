/**
 * The board: every project at a glance, one line per session, with what each is stopped on. Built
 * here as plain data from a snapshot, drawn by the panel.
 */
import { OTHER } from "./tree";
import type { Card, PrView, Run, Snapshot } from "./types";

/** What a line asks of the eye, most pressing first. */
export type Mark = "you" | "stopped" | "running" | "others" | "quiet";
export const MARKS: Mark[] = ["you", "stopped", "running", "others", "quiet"];

export interface BoardRow {
  /** the session (or job); none for what no session in the project holds */
  run?: Run;
  title: string;
  mark: Mark;
  /** a few words on why it has that mark */
  note: string;
  /** when it last did something, or when the matter came up */
  at?: string;
  cards: Card[];
  prs: PrView[];
  /** subagents and jobs under it that are still going */
  subs: number;
  device?: string;
}

export interface BoardTile {
  project: string;
  mark: Mark;
  rows: BoardRow[];
  /** idle and finished sessions, folded under the rest */
  quiet: BoardRow[];
}

export interface BoardModel {
  /** lines per mark, across the board */
  counts: Record<Mark, number>;
  todo: number;
  /** pull requests asking the human for a review */
  reviews: PrView[];
  tiles: BoardTile[];
}

const rank = (m: Mark) => MARKS.indexOf(m);
const same = (a?: string, b?: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const live = (r: Run) => r.state === "working" || r.state === "waiting";

export function boardModel(s: Snapshot | undefined): BoardModel {
  const counts: Record<Mark, number> = { you: 0, stopped: 0, running: 0, others: 0, quiet: 0 };
  if (!s) return { counts, todo: 0, reviews: [], tiles: [] };
  const runs = s.runs ?? [];
  const prs = s.prs ?? [];
  const reviews = prs.filter((p) => p.reviewRequested && !p.mine);
  const ownPrs = prs.filter((p) => !(p.reviewRequested && !p.mine));
  const open = s.cards.filter((c) => c.status === "open" && c.kind !== "todo");
  const todo = s.cards.filter((c) => c.status === "open" && c.kind === "todo").length;
  // answered, but no session will ever pick it up: the human has to pick a lead
  const stranded = s.cards.filter((c) => c.status === "answered" && c.unrouted);

  const ids = new Set(runs.map((r) => r.id));
  const roots = runs.filter((r) => !r.parent || !ids.has(r.parent));
  const under = (root: Run): Run[] => {
    const out: Run[] = [];
    const walk = (id: string) => {
      for (const k of runs) if (k.parent === id) (out.push(k), walk(k.id));
    };
    walk(root.id);
    return out;
  };

  const taken = new Set<string>();
  const takenPr = new Set<string>();
  const byProject = new Map<string, BoardRow[]>();
  const put = (project: string | undefined, row: BoardRow) => {
    const k = project ?? OTHER;
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(row);
  };

  for (const r of roots) {
    const family = [r, ...under(r)];
    const cards = open.filter((c) => family.some((f) => same(c.session, f.id)));
    const mine = ownPrs.filter((p) => family.some((f) => same(p.session, f.id)));
    for (const c of cards) taken.add(c.id);
    for (const p of mine) takenPr.add(p.key);
    const asks = family.find((f) => f.asks);
    const bad = family.find((f) => f.state === "stalled" || f.state === "failed");
    const stuckPr = mine.find((p) => p.stalled);
    let mark: Mark;
    let note: string;
    if (cards.length || asks) {
      mark = "you";
      note = asks && !cards.length ? (asks.asks!.via === "permission" ? "approve a tool call" : "asked in chat") : `${cards.length} card${cards.length === 1 ? "" : "s"}`;
    } else if (bad || stuckPr) {
      mark = "stopped";
      note = bad ? bad.state : `#${stuckPr!.number} stuck`;
    } else if (family.some((f) => f.state === "working")) {
      mark = "running";
      note = "working";
    } else if (r.state === "waiting" || mine.length) {
      mark = "others";
      note = mine.length ? `#${mine[0]!.number} ${mine[0]!.waitingOn}` : "waiting";
    } else {
      mark = "quiet";
      note = r.done ? "done" : r.state;
    }
    put(r.project, {
      run: r,
      title: r.title,
      mark,
      note,
      at: r.lastActivity,
      cards,
      prs: mine,
      subs: family.length - 1 ? family.slice(1).filter(live).length : 0,
      device: r.device,
    });
  }

  // what no session on the board holds: its session ended, never claimed, or is not shown
  const projects = new Set<string>([...open, ...stranded].map((c) => c.project).concat(ownPrs.map((p) => p.project ?? OTHER)));
  for (const project of projects) {
    const cards = [...open.filter((c) => c.project === project && !taken.has(c.id)), ...stranded.filter((c) => c.project === project)];
    const loose = ownPrs.filter((p) => (p.project ?? OTHER) === project && !takenPr.has(p.key));
    if (!cards.length && !loose.length) continue;
    const noLead = cards.some((c) => c.unrouted) || loose.some((p) => p.unrouted);
    const mark: Mark = cards.length || noLead ? "you" : loose.some((p) => p.stalled) ? "stopped" : "others";
    put(project, {
      title: "No session",
      mark,
      note: noLead ? "no lead" : cards.length ? `${cards.length} card${cards.length === 1 ? "" : "s"}` : `${loose.length} PR${loose.length === 1 ? "" : "s"}`,
      at: [...cards.map((c) => c.since ?? c.openedAt), ...loose.map((p) => p.since)].sort()[0],
      cards,
      prs: loose,
      subs: 0,
    });
  }

  const tiles: BoardTile[] = [];
  for (const [project, all] of byProject) {
    all.sort((a, b) => rank(a.mark) - rank(b.mark) || (b.at ?? "").localeCompare(a.at ?? ""));
    for (const r of all) counts[r.mark]++;
    const rows = all.filter((r) => r.mark !== "quiet");
    const quiet = all.filter((r) => r.mark === "quiet");
    tiles.push({ project, mark: rows[0]?.mark ?? "quiet", rows, quiet });
  }
  tiles.sort((a, b) => rank(a.mark) - rank(b.mark) || Number(a.project === OTHER) - Number(b.project === OTHER) || a.project.localeCompare(b.project));
  return { counts, todo, reviews, tiles };
}
