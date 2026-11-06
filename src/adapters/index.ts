import type { Run } from "../core/types.js";
import { claudeCode } from "./claudeCode.js";
import { codex } from "./codex.js";

export interface ScanOptions {
  /** Only logs touched at or after this time (ms since epoch). */
  sinceMs: number;
  now: number;
}

/**
 * An adapter reads one agent runtime's own logs and reports runs. It must only read,
 * never write, and should report a run with `error` rather than guess when a log
 * does not look like what it expects.
 */
export interface Adapter {
  name: string;
  scan(opts: ScanOptions): Run[];
}

export const adapters: Adapter[] = [claudeCode, codex];

export function scanAll(opts: ScanOptions, only?: string[]): Run[] {
  const runs: Run[] = [];
  for (const a of adapters) {
    if (only && !only.includes(a.name)) continue;
    try {
      runs.push(...a.scan(opts));
    } catch (err) {
      runs.push({ id: `${a.name}-error`, runtime: a.name, kind: "session", title: `${a.name} adapter failed`, state: "unknown", error: (err as Error).message });
    }
  }
  return runs;
}
