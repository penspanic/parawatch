/**
 * How a run's model, effort and options read on screen. Runtimes name models in full
 * (`claude-opus-5-5`, `claude-haiku-5-5-20260101`); a row has room for `opus 5.5`.
 */
import type { Run } from "./types.js";

const CLAUDE = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[1m\])?$/;

export function shortModel(model: string): string {
  const m = CLAUDE.exec(model);
  if (m) return `${m[1]} ${m[2]}.${m[3]}${m[4] ? " 1M" : ""}`;
  return model.replace(/-\d{8}$/, "");
}

/** The model and effort in a few words, `opus 5.5 high`; fast mode too, as it changes the speed. */
export function settingsLine(r: Pick<Run, "model" | "effort" | "options">): string | undefined {
  const parts = [r.model ? shortModel(r.model) : undefined, r.effort, r.options?.includes("fast") ? "fast" : undefined].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/** Everything it runs with, for a tooltip or a detail line: `claude-opus-5-5 · effort high · bypasses permissions`. */
export function settingsFull(r: Pick<Run, "model" | "effort" | "options">): string | undefined {
  const parts = [r.model, r.effort ? `effort ${r.effort}` : undefined, ...(r.options ?? [])].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
