import { prViews, keyOf, parsePrRef, readCache, githubConfig } from "./github.js";
import { linkPr, listeners } from "./ops.js";
import { collectRuns } from "./runs.js";
import { fold, type State } from "./state.js";
import { readEvents } from "./store.js";
import { SCHEMA_VERSION, type Card, type Run, type Snapshot } from "./types.js";

export type { Snapshot };

/**
 * `closed`: also carry the most recently closed cards, newest first, so a panel can show them
 * again. Off by default; open and answered cards are always there.
 *
 * GitHub is read from the last reading only; `syncGithub` refreshes it.
 */
export function snapshot(opts: { sinceHours?: number; project?: string; closed?: number; keepRepeats?: boolean } = {}): Snapshot {
  let state = fold(readEvents());
  const runs = collectRuns(state, { sinceHours: opts.sinceHours ?? 6, project: opts.project, keepRepeats: opts.keepRepeats });
  if (linkCreatedPrs(runs, state)) state = fold(readEvents());
  const all = [...state.cards.values()].filter((c) => !opts.project || c.project === opts.project);
  const cards = [...all.filter((c) => c.status !== "closed"), ...recentlyClosed(all, opts.closed ?? 0)];
  quietAnsweredAsks(runs, all);
  const cache = readCache();
  const enabled = githubConfig().enabled && (cache.hosts === undefined ? false : cache.hosts.length > 0);
  let prs = enabled ? prViews(cache, state, runs) : undefined;
  if (prs && opts.project) prs = prs.filter((p) => p.project === opts.project);
  return {
    v: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    projects: [...state.projects.values()],
    cards,
    runs,
    prs,
    github: { enabled, fetchedAt: cache.fetchedAt, error: cache.error },
    listeners: listeners(),
  };
}

/** A pull request a session's log shows it opened belongs to that session, unless linked already. */
function linkCreatedPrs(runs: Run[], state: State): boolean {
  let added = false;
  for (const r of runs) {
    for (const url of r.createdPrs ?? []) {
      const key = keyOf(url);
      const pr = parsePrRef(url);
      if (!key || !pr || state.prLinks.has(key)) continue;
      linkPr({ pr, session: r.id, project: r.project, task: r.task });
      state.prLinks.set(key, { pr, session: r.id, project: r.project, at: new Date().toISOString() });
      added = true;
    }
  }
  return added;
}

/** A question asked in chat is no longer pending once the session put it on a card. */
function quietAnsweredAsks(runs: Run[], cards: Card[]): void {
  for (const r of runs) {
    if (!r.asks) continue;
    const turn = r.lastPromptAt ?? "";
    if (cards.some((c) => c.status !== "closed" && c.session && r.id.startsWith(c.session) && c.openedAt >= turn)) r.asks = undefined;
  }
}

export function recentlyClosed(cards: Card[], keep: number): Card[] {
  if (keep <= 0) return [];
  return cards
    .filter((c) => c.status === "closed")
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(0, keep);
}
