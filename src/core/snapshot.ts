import { collectRuns } from "./runs.js";
import { fold } from "./state.js";
import { readEvents } from "./store.js";
import { SCHEMA_VERSION, type Snapshot } from "./types.js";

export type { Snapshot };

export function snapshot(opts: { sinceHours?: number; project?: string } = {}): Snapshot {
  const state = fold(readEvents());
  const cards = [...state.cards.values()].filter((c) => c.status !== "closed" && (!opts.project || c.project === opts.project));
  const runs = collectRuns(state, { sinceHours: opts.sinceHours ?? 6, project: opts.project });
  return { v: SCHEMA_VERSION, generatedAt: new Date().toISOString(), projects: [...state.projects.values()], cards, runs };
}
