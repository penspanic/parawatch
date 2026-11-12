import fs from "node:fs";
import path from "node:path";
import { prViews, keyOf, parsePrRef, readCache, githubConfig, githubFailing } from "./github.js";
import { endedSessions, linkPr, listeners, readState } from "./ops.js";
import { collectRuns } from "./runs.js";
import type { State } from "./state.js";
import { deviceName, eventFiles, sharedDir } from "./store.js";
import { SCHEMA_VERSION, type Card, type Run, type Snapshot } from "./types.js";

export type { Snapshot };

/**
 * `closed`: also carry the most recently closed cards, newest first, so a panel can show them
 * again. Off by default; open and answered cards are always there.
 *
 * GitHub is read from the last reading only; `syncGithub` refreshes it.
 */
export function snapshot(opts: { sinceHours?: number; project?: string; closed?: number; keepRepeats?: boolean } = {}): Snapshot {
  let state = readState();
  const runs = collectRuns(state, { sinceHours: opts.sinceHours ?? 6, project: opts.project, keepRepeats: opts.keepRepeats });
  if (linkCreatedPrs(runs, state)) state = readState();
  const all = [...state.cards.values()].filter((c) => !opts.project || c.project === opts.project);
  const ended = endedSessions(state);
  const cards = [...all.filter((c) => c.status !== "closed"), ...recentlyClosed(all, opts.closed ?? 0)]
    .map((c) => (c.status !== "closed" && c.session && ended(c.session) ? { ...c, ownerEnded: true } : c))
    .map((c) => {
      const missing = notHere([...(c.attach ?? []), ...(c.open ?? [])]);
      return missing.length ? { ...c, missing } : c;
    });
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
    github: { enabled, fetchedAt: cache.fetchedAt, error: cache.error, failing: githubFailing(cache) || undefined, failedBy: cache.failedBy, failedAt: cache.failedAt },
    listeners: listeners(),
    devices: sharedDir() ? { me: deviceName(), others: eventFiles().map((f) => f.device).filter((d) => d !== deviceName()) } : undefined,
  };
}

/**
 * A pull request a session's log shows it opened belongs to that session, unless linked already.
 * An earlier automatic link to another session gives way when that session's log no longer shows
 * it opening the PR (it was read wrongly); a link made with `parawatch pr link` never does.
 */
function linkCreatedPrs(runs: Run[], state: State): boolean {
  let added = false;
  for (const r of runs) {
    for (const url of r.createdPrs ?? []) {
      const key = keyOf(url);
      const pr = parsePrRef(url);
      if (!key || !pr) continue;
      const had = state.prLinks.get(key);
      if (had) {
        if (!had.auto || !had.session || r.id.startsWith(had.session)) continue;
        const owner = runs.find((x) => x.id.startsWith(had.session!));
        if (!owner || (owner.createdPrs ?? []).some((u) => keyOf(u) === key)) continue;
      }
      linkPr({ pr, session: r.id, project: r.project, task: r.task, auto: true });
      state.prLinks.set(key, { pr, session: r.id, project: r.project, auto: true, at: new Date().toISOString() });
      added = true;
    }
  }
  return added;
}

/** Files named by absolute path (on either system) that this machine does not have. */
function notHere(targets: string[]): string[] {
  return targets.filter((t) => (path.isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(t)) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !fs.existsSync(t));
}

/** A question asked in chat is no longer pending once the session put it on a card. */
function quietAnsweredAsks(runs: Run[], cards: Card[]): void {
  for (const r of runs) {
    // a permission prompt holds the session whatever cards it has open
    if (!r.asks || r.asks.via === "permission") continue;
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
