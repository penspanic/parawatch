import type { Card, Claim, DeclaredRun, Project, PwEvent } from "./types.js";

export interface State {
  projects: Map<string, Project>;
  cards: Map<string, Card>;
  runs: Map<string, DeclaredRun>;
  claims: Claim[];
  lastSeq: number;
}

/** Rebuild current state from the event log. */
export function fold(events: PwEvent[]): State {
  const s: State = { projects: new Map(), cards: new Map(), runs: new Map(), claims: [], lastSeq: 0 };
  for (const ev of events) {
    s.lastSeq = Math.max(s.lastSeq, ev.seq);
    switch (ev.type) {
      case "project.add":
        s.projects.set(ev.project.name, ev.project);
        break;
      case "project.remove":
        s.projects.delete(ev.name);
        break;
      case "card.open":
        s.cards.set(ev.card.id, { ...ev.card, openedAt: ev.ts, status: "open", answers: [], comments: [] });
        break;
      case "card.answer": {
        const c = s.cards.get(ev.card);
        if (!c) break;
        c.answers.push({ seq: ev.seq, at: ev.ts, by: ev.by, choice: ev.choice, comment: ev.comment, attach: ev.attach });
        if (c.status === "open") c.status = "answered";
        break;
      }
      case "card.comment": {
        const c = s.cards.get(ev.card);
        if (c) c.comments.push({ seq: ev.seq, at: ev.ts, by: ev.by, text: ev.text });
        break;
      }
      case "card.close": {
        const c = s.cards.get(ev.card);
        if (!c) break;
        c.status = "closed";
        c.closedAt = ev.ts;
        c.closeNote = ev.note;
        break;
      }
      case "run.start":
        s.runs.set(ev.run.id, { ...ev.run, startedAt: ev.ts, lastActivity: ev.ts, status: "running" });
        break;
      case "run.note": {
        const r = s.runs.get(ev.run);
        if (!r) break;
        r.note = ev.text;
        r.lastActivity = ev.ts;
        break;
      }
      case "run.end": {
        const r = s.runs.get(ev.run);
        if (!r) break;
        r.status = ev.status;
        r.endedAt = ev.ts;
        r.lastActivity = ev.ts;
        if (ev.note) r.note = ev.note;
        break;
      }
      case "run.claim":
        // a later claim of the same session replaces the earlier one
        s.claims = s.claims.filter((c) => c.session !== ev.claim.session);
        s.claims.push(ev.claim);
        break;
    }
  }
  return s;
}

/** Next id with a prefix, counting the events that created that kind of thing. */
export function nextId(events: PwEvent[], prefix: "c" | "r"): string {
  let n = 0;
  for (const ev of events) {
    if (prefix === "c" && ev.type === "card.open") n++;
    if (prefix === "r" && ev.type === "run.start") n++;
  }
  return `${prefix}${n + 1}`;
}
