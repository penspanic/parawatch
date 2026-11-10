import type { Answer, Card, Claim, DeclaredRun, PrLink, Project, PwEvent } from "./types.js";

/** The claimed name of a session (claims may hold an id prefix). */
export function sessionTitle(claims: Claim[], session: string | undefined): string | undefined {
  if (!session) return undefined;
  const c = claims.find((x) => session.startsWith(x.session) || x.session.startsWith(session));
  return c?.title;
}

export interface State {
  projects: Map<string, Project>;
  cards: Map<string, Card>;
  runs: Map<string, DeclaredRun>;
  claims: Claim[];
  /** runs the human hid, by run id, with when */
  hidden: Map<string, string>;
  /** pull requests linked to sessions, by PR key */
  prLinks: Map<string, PrLink>;
  lastSeq: number;
}

/**
 * Turns a path written on another machine into the same place on this one. Given the path and
 * the machine that wrote it; returns the path unchanged when there is nothing to map.
 */
export type PathMap = (p: string, from?: string) => string;

function mapAll(xs: string[] | undefined, map: PathMap | undefined, from: string | undefined): string[] | undefined {
  return xs && map ? xs.map((x) => map(x, from)) : xs;
}

/** Rebuild current state from the event log. `map` makes other machines' paths local. */
export function fold(events: PwEvent[], map?: PathMap): State {
  const s: State = { projects: new Map(), cards: new Map(), runs: new Map(), claims: [], hidden: new Map(), prLinks: new Map(), lastSeq: 0 };
  for (const ev of events) {
    s.lastSeq = Math.max(s.lastSeq, ev.seq);
    switch (ev.type) {
      case "project.add":
        s.projects.set(ev.project.name, { ...ev.project, paths: mapAll(ev.project.paths, map, ev.dev) ?? [] });
        break;
      case "project.remove":
        s.projects.delete(ev.name);
        break;
      case "card.open": {
        const card: Card = { ...ev.card, openedAt: ev.ts, status: "open", answers: [], comments: [] };
        if (ev.v >= 2 && ev.dev) card.dev = ev.dev;
        card.attach = mapAll(card.attach, map, ev.dev);
        card.open = mapAll(card.open, map, ev.dev);
        if (card.previewFile) card.previewFile = mapAll([card.previewFile], map, ev.dev)?.[0];
        s.cards.set(ev.card.id, card);
        break;
      }
      case "card.answer": {
        const c = s.cards.get(ev.card);
        if (!c) break;
        const a: Answer = { seq: ev.seq, at: ev.ts, by: ev.by, choice: ev.choice, comment: ev.comment, attach: mapAll(ev.attach, map, ev.dev) };
        if (ev.v >= 2 && ev.dev) a.dev = ev.dev;
        // written on another machine before that machine saw an earlier answer: the earlier one stands
        if (typeof ev.seen === "number" && ev.seen < c.answers.length) a.late = true;
        c.answers.push(a);
        if (c.status === "open") c.status = "answered";
        break;
      }
      case "card.comment": {
        const c = s.cards.get(ev.card);
        if (c) c.comments.push({ seq: ev.seq, at: ev.ts, by: ev.by, text: ev.text });
        break;
      }
      case "card.edit": {
        const c = s.cards.get(ev.card);
        if (!c) break;
        const target = c as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(ev.set)) {
          if (v === null || v === undefined) delete target[k];
          else if (k === "attach") c.attach = mapAll(ev.set.attach, map, ev.dev);
          else if (k === "previewFile") c.previewFile = mapAll([ev.set.previewFile as string], map, ev.dev)?.[0];
          else target[k] = v;
        }
        if ("action" in ev.set || "preview" in ev.set) c.changedAt = ev.ts;
        break;
      }
      case "card.close": {
        const c = s.cards.get(ev.card);
        if (!c) break;
        c.status = "closed";
        c.closedAt = ev.ts;
        c.closeNote = ev.note;
        if (ev.dismissed) c.dismissed = true;
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
      case "run.beat": {
        const r = s.runs.get(ev.run);
        if (r) r.lastActivity = ev.ts;
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
        s.claims.push({ ...ev.claim, at: ev.ts });
        break;
      case "run.hide":
        s.hidden.set(ev.run, ev.ts);
        break;
      case "run.unhide":
        s.hidden.delete(ev.run);
        break;
      case "pr.link":
        s.prLinks.set(ev.link.pr.key, { ...ev.link, at: ev.ts });
        break;
      case "pr.unlink":
        s.prLinks.delete(ev.pr);
        break;
    }
  }
  return s;
}

/**
 * Next id with a prefix, counting the events that created that kind of thing. In a shared folder
 * (`device` given) only that machine's own log counts and the id carries the machine's name, so
 * two machines never pick the same id: `pc-c3`.
 */
export function nextId(events: PwEvent[], prefix: "c" | "r", device?: string): string {
  let n = 0;
  for (const ev of events) {
    if (device && ev.dev !== device) continue;
    if (prefix === "c" && ev.type === "card.open") n++;
    if (prefix === "r" && ev.type === "run.start") n++;
  }
  return device ? `${device}-${prefix}${n + 1}` : `${prefix}${n + 1}`;
}

/**
 * Find a card or run by id. A shared id may be given without its machine (`c3` for `pc-c3`) as
 * long as only one machine has it; an exact id always wins.
 */
export function findId<T>(map: Map<string, T>, id: string): string | undefined {
  if (map.has(id)) return id;
  const hits = [...map.keys()].filter((k) => k.endsWith(`-${id}`));
  return hits.length === 1 ? hits[0] : undefined;
}
