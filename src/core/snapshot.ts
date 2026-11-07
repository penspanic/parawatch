import { collectRuns } from "./runs.js";
import { fold } from "./state.js";
import { readEvents } from "./store.js";
import { SCHEMA_VERSION, type Card, type Snapshot } from "./types.js";

export type { Snapshot };

/**
 * `closed`: also carry the most recently closed cards, newest first, so a panel can show them
 * again. Off by default; open and answered cards are always there.
 */
export function snapshot(opts: { sinceHours?: number; project?: string; closed?: number } = {}): Snapshot {
  const state = fold(readEvents());
  const all = [...state.cards.values()].filter((c) => !opts.project || c.project === opts.project);
  const cards = [...all.filter((c) => c.status !== "closed"), ...recentlyClosed(all, opts.closed ?? 0)];
  const runs = collectRuns(state, { sinceHours: opts.sinceHours ?? 6, project: opts.project });
  return { v: SCHEMA_VERSION, generatedAt: new Date().toISOString(), projects: [...state.projects.values()], cards, runs };
}

export function recentlyClosed(cards: Card[], keep: number): Card[] {
  if (keep <= 0) return [];
  return cards
    .filter((c) => c.status === "closed")
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, keep);
}
