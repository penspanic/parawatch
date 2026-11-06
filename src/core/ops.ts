import fs from "node:fs";
import path from "node:path";
import { appendEvent, eventsPath, readCursor, readEvents, writeCursor } from "./store.js";
import { fold, nextId } from "./state.js";
import { HUMAN, type Card, type CardKind, type Claim, type PwEvent } from "./types.js";

export class UserError extends Error {}

function cleanList(xs: string[] | undefined): string[] | undefined {
  const out = (xs ?? []).map((x) => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function absPaths(xs: string[] | undefined): string[] | undefined {
  // attachments and things to open are kept as given when they look like URLs
  return cleanList(xs)?.map((x) => (/^[a-z]+:\/\//i.test(x) ? x : path.resolve(x)));
}

export function addProject(name: string, paths: string[]): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new UserError(`project name "${name}" may only use letters, digits, . _ -`);
  appendEvent(() => ({
    type: "project.add",
    project: { name, paths: paths.map((p) => path.resolve(p)), addedAt: new Date().toISOString() },
  }));
}

export function removeProject(name: string): void {
  const s = fold(readEvents());
  if (!s.projects.has(name)) throw new UserError(`no project named "${name}"`);
  appendEvent(() => ({ type: "project.remove", name }));
}

export interface CardInput {
  kind: CardKind;
  project: string;
  task?: string;
  title: string;
  body?: string;
  options?: string[];
  recommend?: number;
  attach?: string[];
  open?: string[];
  look?: string;
  from?: string;
}

export function openCard(input: CardInput): Card {
  if (!input.title.trim()) throw new UserError("a card needs a title");
  if (!input.project.trim()) throw new UserError("a card needs --project");
  const options = cleanList(input.options);
  if (input.recommend !== undefined) {
    if (!options) throw new UserError("--recommend needs --option");
    if (!Number.isInteger(input.recommend) || input.recommend < 1 || input.recommend > options.length) {
      throw new UserError(`--recommend must be between 1 and ${options.length}`);
    }
  }
  let id = "";
  appendEvent((events) => {
    id = nextId(events, "c");
    return {
      type: "card.open",
      card: {
        id,
        kind: input.kind,
        project: input.project,
        task: input.task || undefined,
        title: input.title.trim(),
        body: input.body?.trim() || undefined,
        options,
        recommend: input.recommend,
        attach: absPaths(input.attach),
        open: absPaths(input.open),
        look: input.look?.trim() || undefined,
        from: input.from || undefined,
      },
    };
  });
  const card = fold(readEvents()).cards.get(id);
  if (!card) throw new Error("card vanished right after it was written");
  return card;
}

function requireCard(id: string): Card {
  const card = fold(readEvents()).cards.get(id);
  if (!card) throw new UserError(`no card "${id}"`);
  return card;
}

export function answerCard(id: string, a: { choice?: number; comment?: string; attach?: string[]; by?: string }): void {
  const card = requireCard(id);
  if (card.status === "closed") throw new UserError(`card ${id} is already closed`);
  if (a.choice === undefined && !a.comment?.trim() && !cleanList(a.attach)) {
    throw new UserError("an answer needs --choice, --comment or --attach");
  }
  if (a.choice !== undefined) {
    const n = card.options?.length ?? 0;
    if (!Number.isInteger(a.choice) || a.choice < 1 || a.choice > n) {
      throw new UserError(n ? `--choice must be between 1 and ${n}` : `card ${id} has no options`);
    }
  }
  appendEvent(() => ({
    type: "card.answer",
    card: id,
    by: a.by || HUMAN,
    choice: a.choice,
    comment: a.comment?.trim() || undefined,
    attach: absPaths(a.attach),
  }));
}

export function commentCard(id: string, text: string, by: string): void {
  requireCard(id);
  if (!text.trim()) throw new UserError("a comment needs text");
  appendEvent(() => ({ type: "card.comment", card: id, by, text: text.trim() }));
}

export function closeCard(id: string, note?: string): void {
  const card = requireCard(id);
  if (card.status === "closed") return;
  appendEvent(() => ({ type: "card.close", card: id, note: note?.trim() || undefined }));
}

export function startRun(r: { project: string; task?: string; title: string; parent?: string }): string {
  let id = "";
  appendEvent((events) => {
    id = nextId(events, "r");
    return { type: "run.start", run: { id, project: r.project, task: r.task, title: r.title, parent: r.parent } };
  });
  return id;
}

export function noteRun(id: string, text: string): void {
  if (!fold(readEvents()).runs.has(id)) throw new UserError(`no declared run "${id}"`);
  appendEvent(() => ({ type: "run.note", run: id, text }));
}

export function endRun(id: string, status: "done" | "failed", note?: string): void {
  if (!fold(readEvents()).runs.has(id)) throw new UserError(`no declared run "${id}"`);
  appendEvent(() => ({ type: "run.end", run: id, status, note }));
}

export function claimSession(claim: Claim): void {
  if (claim.session.length < 6) throw new UserError("give at least 6 characters of the session id");
  appendEvent(() => ({ type: "run.claim", claim }));
}

// ---------------------------------------------------------------- inbox

export interface InboxItem {
  seq: number;
  at: string;
  kind: "answer" | "comment";
  card: Card;
  by: string;
  choice?: number;
  choiceText?: string;
  comment?: string;
  attach?: string[];
}

export interface InboxFilter {
  project?: string;
  card?: string;
}

/** Human answers and comments newer than `afterSeq`, on cards that are not closed. */
export function inboxFrom(events: PwEvent[], afterSeq: number, filter: InboxFilter): InboxItem[] {
  const state = fold(events);
  const out: InboxItem[] = [];
  for (const ev of events) {
    if (ev.seq <= afterSeq) continue;
    if (ev.type !== "card.answer" && ev.type !== "card.comment") continue;
    if (ev.by !== HUMAN) continue;
    const card = state.cards.get(ev.card);
    if (!card || card.status === "closed") continue;
    if (filter.project && card.project !== filter.project) continue;
    if (filter.card && card.id !== filter.card) continue;
    if (ev.type === "card.answer") {
      out.push({
        seq: ev.seq,
        at: ev.ts,
        kind: "answer",
        card,
        by: ev.by,
        choice: ev.choice,
        choiceText: ev.choice !== undefined ? card.options?.[ev.choice - 1] : undefined,
        comment: ev.comment,
        attach: ev.attach,
      });
    } else {
      out.push({ seq: ev.seq, at: ev.ts, kind: "comment", card, by: ev.by, comment: ev.text });
    }
  }
  return out;
}

export function consumerName(opts: { as?: string; project?: string; card?: string }): string {
  return opts.as || opts.project || (opts.card ? `card-${opts.card}` : "default");
}

export function readInbox(consumer: string, filter: InboxFilter, advance: boolean): InboxItem[] {
  const events = readEvents();
  const items = inboxFrom(events, readCursor(consumer), filter);
  const last = items[items.length - 1];
  if (advance && last) writeCursor(consumer, last.seq);
  return items;
}

/**
 * Block until the consumer has something in its inbox, or the timeout passes.
 * Returns the items (cursor advanced) or [] on timeout.
 */
export async function waitInbox(
  consumer: string,
  filter: InboxFilter,
  timeoutMs: number,
  pollMs = 1000,
): Promise<InboxItem[]> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let watcher: fs.FSWatcher | undefined;
  let wake: (() => void) | undefined;
  try {
    const dir = path.dirname(eventsPath());
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => wake?.());
  } catch {
    watcher = undefined; // polling alone still works
  }
  try {
    for (;;) {
      const items = readInbox(consumer, filter, true);
      if (items.length) return items;
      const left = deadline - Date.now();
      if (left <= 0) return [];
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(pollMs, left));
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    watcher?.close();
  }
}
