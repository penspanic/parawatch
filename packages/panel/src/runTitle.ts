/**
 * What an agent is called in the lists. A session has its own name (what the Claude app shows,
 * "Spill Director") and, once it claims a task, the title of that work ("Fix the camera"); the
 * human picks which of the two to see, or both.
 */
import type { Run } from "./types";

export type RunTitles = "name" | "work" | "both";
export const RUN_TITLES: RunTitles[] = ["both", "name", "work"];

export function isRunTitles(v: unknown): v is RunTitles {
  return RUN_TITLES.includes(v as RunTitles);
}

/** The words to show: `main` always, `work` beside it when both are shown and they differ. */
export function runLabel(r: Run, mode: RunTitles): { main: string; work?: string } {
  const name = r.name?.trim() || undefined;
  const work = r.work?.trim() || undefined;
  if (mode === "work") return { main: work ?? r.title };
  const main = name ?? r.title;
  if (mode === "name" || !work || work === main) return { main };
  return { main, work };
}

/** One line of it, for tooltips and other plain text. */
export function runLabelText(r: Run, mode: RunTitles): string {
  const l = runLabel(r, mode);
  return l.work ? `${l.main} · ${l.work}` : l.main;
}
