/**
 * What each session did on one day, from the event log and the agent logs: the work it claimed,
 * cards it opened and what came of them, jobs it declared, news on its pull requests, and how it
 * said it ended.
 */
import { collectRuns } from "./runs.js";
import { fold } from "./state.js";
import { readEvents } from "./store.js";
import { prChangeText } from "./format.js";
import type { PwEvent, Run } from "./types.js";

export interface DigestSession {
  /** the agent session id, or "" for things no session owns */
  session: string;
  title: string;
  project?: string;
  task?: string;
  /** what the session said when it finished (`claim --done`) */
  done?: string;
  /** the last one-line summary the runtime wrote */
  recap?: string;
  lastActivity?: string;
  cards: { id: string; title: string; events: string[] }[];
  runs: { id: string; title: string; status: string; note?: string }[];
  prs: { key: string; url: string; title?: string; changes: string[] }[];
}

export interface Digest {
  date: string;
  sessions: DigestSession[];
}

/** Local midnight to local midnight. */
export function dayRange(date: string): [number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date (use YYYY-MM-DD)`);
  const start = new Date(`${date}T00:00:00`).getTime();
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end.getTime()];
}

export function localDate(t = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function digest(date: string, now = Date.now()): Digest {
  const [from, to] = dayRange(date);
  const events = readEvents();
  const state = fold(events);
  const inDay = (e: PwEvent) => {
    const t = Date.parse(e.ts);
    return t >= from && t < to;
  };
  const sessions = new Map<string, DigestSession>();
  const sessionKey = (id: string | undefined) => {
    if (!id) return "";
    const c = state.claims.find((x) => id.startsWith(x.session) || x.session.startsWith(id));
    return c?.session ?? id;
  };
  const get = (id: string | undefined): DigestSession => {
    const k = sessionKey(id);
    let s = sessions.get(k);
    if (!s) {
      const c = state.claims.find((x) => x.session === k);
      s = { session: k, title: c?.title ?? (k ? k.slice(0, 8) : "no session"), project: c?.project, task: c?.task, cards: [], runs: [], prs: [] };
      sessions.set(k, s);
    }
    return s;
  };

  // agent logs: what was active that day
  const sinceHours = Math.max(1, Math.ceil((now - from) / 3_600_000));
  const observed: Run[] = collectRuns(state, { sinceHours, includeEnded: true, keepRepeats: true }, now).filter(
    (r) => r.kind === "session" && r.lastActivity && Date.parse(r.lastActivity) >= from && (!r.startedAt || Date.parse(r.startedAt) < to),
  );
  for (const r of observed) {
    const s = get(r.id);
    s.title = r.title;
    s.project ??= r.project;
    s.task ??= r.task;
    s.recap = r.recap;
    s.lastActivity = r.lastActivity;
  }

  for (const e of events) {
    if (!inDay(e)) continue;
    switch (e.type) {
      case "run.claim": {
        const s = get(e.claim.session);
        s.project = e.claim.project;
        s.task = e.claim.task ?? s.task;
        if (e.claim.title) s.title = e.claim.title;
        if (e.claim.done) s.done = e.claim.done;
        break;
      }
      case "card.open":
      case "card.answer":
      case "card.close": {
        const id = e.type === "card.open" ? e.card.id : e.card;
        const card = state.cards.get(id);
        if (!card) break;
        const s = get(card.session);
        s.project ??= card.project;
        let row = s.cards.find((c) => c.id === id);
        if (!row) s.cards.push((row = { id, title: card.title, events: [] }));
        if (e.type === "card.open") row.events.push("opened");
        else if (e.type === "card.answer") {
          const choice = e.choice !== undefined ? card.options?.[e.choice - 1] : undefined;
          row.events.push(`answered${choice ? `: ${choice}` : e.comment ? `: ${e.comment}` : ""}`);
        } else row.events.push(`closed${e.note ? `: ${e.note}` : ""}`);
        break;
      }
      case "run.start":
      case "run.end": {
        const id = e.type === "run.start" ? e.run.id : e.run;
        const run = state.runs.get(id);
        if (!run) break;
        const s = get(run.parent);
        s.project ??= run.project;
        if (!s.runs.some((x) => x.id === id)) s.runs.push({ id, title: run.title, status: run.status, note: run.note });
        break;
      }
      case "pr.change": {
        const link = state.prLinks.get(e.pr.key);
        const s = get(link?.session);
        s.project ??= link?.project;
        let row = s.prs.find((p) => p.key === e.pr.key);
        if (!row) s.prs.push((row = { key: e.pr.key, url: e.pr.url, title: e.title, changes: [] }));
        row.changes.push(prChangeText(e.change, e.by) + (e.text ? `: ${e.text}` : ""));
        break;
      }
    }
  }
  const list = [...sessions.values()].filter((s) => s.session || s.cards.length || s.runs.length || s.prs.length);
  list.sort((a, b) => (a.project ?? "~").localeCompare(b.project ?? "~") || (a.lastActivity ?? "").localeCompare(b.lastActivity ?? ""));
  return { date, sessions: list };
}

export function digestText(d: Digest): string {
  const out: string[] = [d.date];
  if (!d.sessions.length) return `${d.date}\nNothing recorded.`;
  let project: string | undefined | null = null;
  for (const s of d.sessions) {
    if (s.project !== project) {
      project = s.project;
      out.push("", project ?? "other");
    }
    out.push(`  ${s.task ? `${s.task} · ` : ""}${s.title}`);
    const end = s.done ? `done: ${s.done}` : s.recap ? `last: ${s.recap}` : undefined;
    if (end) out.push(`    ${end}`);
    for (const c of s.cards) out.push(`    card ${c.id} "${c.title}": ${c.events.join(", ")}`);
    for (const r of s.runs) out.push(`    job ${r.id} "${r.title}": ${r.status}${r.note ? ` (${r.note})` : ""}`);
    for (const p of s.prs) out.push(`    PR ${p.key.replace(/^[^/]+\//, "")}${p.title ? ` "${p.title}"` : ""}: ${p.changes.join(", ")}`);
  }
  return out.join("\n");
}
