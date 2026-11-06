/**
 * What deserves the human's attention, kept apart from Electron so it can be tested: what the
 * badge counts, and which events become a system notification.
 */
import type { Card, PwEvent, Snapshot } from "../../../src/core/types.js";

const KIND_WORD: Record<Card["kind"], string> = { decide: "Decide", try: "Try", block: "Blocked", todo: "To do" };

/** Cards that need the human now: open, and not a to-do. */
export function needsYou(s: Snapshot | undefined): number {
  return s?.cards.filter((c) => c.status === "open" && c.kind !== "todo").length ?? 0;
}

export function toDo(s: Snapshot | undefined): number {
  return s?.cards.filter((c) => c.status === "open" && c.kind === "todo").length ?? 0;
}

export interface Alert {
  title: string;
  body: string;
  /** the card to show when the notification is clicked */
  card?: string;
}

/**
 * The notification an event deserves, if any: a card that needs the human, or a declared job that
 * failed. To-dos, answers, comments and closes stay quiet.
 */
export function alertFor(ev: PwEvent, state: { runTitle(id: string): string | undefined }): Alert | undefined {
  if (ev.type === "card.open") {
    const c = ev.card;
    if (c.kind === "todo") return undefined;
    return { title: `${c.project} · ${KIND_WORD[c.kind]}`, body: c.title, card: c.id };
  }
  if (ev.type === "run.end" && ev.status === "failed") {
    const title = state.runTitle(ev.run) ?? ev.run;
    return { title: "A job failed", body: ev.note ? `${title}: ${ev.note}` : title };
  }
  return undefined;
}

/** Menu bar text next to the icon: nothing when nothing needs the human. */
export function trayTitle(n: number): string {
  return n ? String(n) : "";
}

export function summary(s: Snapshot | undefined): string {
  const n = needsYou(s);
  const t = toDo(s);
  const parts = [n ? `${n} need${n === 1 ? "s" : ""} you` : "Nothing needs you"];
  if (t) parts.push(`${t} to do`);
  return parts.join(" · ");
}
