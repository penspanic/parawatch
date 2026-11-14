/**
 * Reading event logs, with nothing from Node, so a browser (the phone web app) reads them the same
 * way as the CLI.
 */
import type { PwEvent } from "./types.js";

/** Merge per-device logs, each already in its own order, into one. */
export function mergeLogs(lists: PwEvent[][]): PwEvent[] {
  const at = lists.map(() => 0);
  const out: PwEvent[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < lists.length; i++) {
      const ev = lists[i]![at[i]!];
      if (!ev) continue;
      if (pick < 0) {
        pick = i;
        continue;
      }
      const best = lists[pick]![at[pick]!]!;
      if (ev.ts < best.ts || (ev.ts === best.ts && (ev.dev ?? "") < (best.dev ?? ""))) pick = i;
    }
    if (pick < 0) return out;
    out.push(lists[pick]![at[pick]!++]!);
  }
}

export function parseEventLines(text: string, device?: string): PwEvent[] {
  const out: PwEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as PwEvent;
      if (typeof ev.seq !== "number" || typeof ev.type !== "string") continue;
      if (device) ev.dev = device;
      out.push(ev);
    } catch {
      // a torn or hand-edited line; keep going
    }
  }
  return out;
}
