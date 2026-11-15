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

/** The card an event is about, if any. */
function cardOf(e: PwEvent): string | undefined {
  if (e.type === "card.open") return e.card.id;
  const c = (e as { card?: unknown }).card;
  return typeof c === "string" ? c : undefined;
}

/**
 * When a writer may stamp its next event: now, but never before its own last event (each log
 * stays in order) and, for an event about a card, after everything already said about that card.
 * Logs merge by time and then by machine name, so an answer stamped in the same millisecond as the
 * card on another machine, or by a clock running behind, would sort before the card and be lost.
 */
export function stampFor(events: PwEvent[], own: (e: PwEvent) => boolean, card: unknown, now: number): number {
  let t = now;
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (!Number.isFinite(at)) continue;
    if (own(e) && at > t) t = at;
    if (typeof card === "string" && cardOf(e) === card && at >= t) t = at + 1;
  }
  return t;
}
