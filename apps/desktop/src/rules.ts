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

/** Some agent is busy right now, so the menu bar icon shows movement. */
export function agentsWorking(s: Snapshot | undefined): boolean {
  return s?.runs.some((r) => r.state === "working") ?? false;
}

/** Pull request news worth a notification: things that stop it from landing, and the landing. */
const PR_ALERTS: Partial<Record<string, string>> = {
  changes_requested: "changes requested",
  ci_failed: "CI failed",
  conflict: "merge conflict",
  queue_removed: "dropped from the merge queue",
  merged: "merged",
};

/**
 * What became stuck since the last look: a pull request waiting too long in one state, or a job
 * that stopped showing signs of life. `seen` remembers what was already reported.
 */
export function newlyStuck(s: Snapshot | undefined, seen: Set<string>): Alert[] {
  if (!s) return [];
  const out: Alert[] = [];
  const now = new Set<string>();
  for (const p of s.prs ?? []) {
    if (!p.stalled || (p.reviewRequested && !p.mine)) continue;
    const key = `pr:${p.key}:${p.waitingOn}`;
    now.add(key);
    if (!seen.has(key)) out.push({ title: `${p.repo.split("/")[1]}#${p.number} stuck in ${p.waitingOn}`, body: p.title });
  }
  for (const r of s.runs) {
    if (r.state !== "stalled" || r.kind !== "declared") continue;
    const key = `run:${r.id}`;
    now.add(key);
    if (!seen.has(key)) out.push({ title: "A job stopped showing signs of life", body: r.action ? `${r.title}: ${r.action}` : r.title });
  }
  // forget what got unstuck, so it is reported again if it sticks again
  for (const k of [...seen]) if (!now.has(k)) seen.delete(k);
  for (const k of now) seen.add(k);
  return out;
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
  if (ev.type === "pr.change" && PR_ALERTS[ev.change]) {
    return { title: `${ev.pr.repo.split("/")[1]}#${ev.pr.number} · ${PR_ALERTS[ev.change]}${ev.by && ev.source === "github" ? ` by ${ev.by}` : ""}`, body: ev.text ? `${ev.title ?? ""}\n${ev.text}`.trim() : (ev.title ?? ev.pr.url) };
  }
  if (ev.type === "run.end" && ev.status === "failed") {
    const title = state.runTitle(ev.run) ?? ev.run;
    return { title: "A job failed", body: ev.note ? `${title}: ${ev.note}` : title };
  }
  return undefined;
}

/** One line on what needs the human, for the menu bar menu and tooltip. */
export function summary(s: Snapshot | undefined): string {
  const n = needsYou(s);
  const t = toDo(s);
  const parts = [n ? `${n} need${n === 1 ? "s" : ""} you` : "Nothing needs you"];
  if (t) parts.push(`${t} to do`);
  return parts.join(" · ");
}
