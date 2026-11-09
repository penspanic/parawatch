import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { advance, appendEvent, deviceName, eventsDir, homeDir, isAfter, readCursor, readEvents, sharedDir, writeCursor, type Position } from "./store.js";
import { findId, fold, nextId, type State } from "./state.js";
import { pathMap } from "./sync.js";
import { CARD_KINDS, HUMAN, PR_CHANGES, type Card, type CardEdit, type CardKind, type Claim, type Listener, type PrChange, type PrRef, type PwEvent } from "./types.js";

export { UserError };

/** Current state, with other machines' paths made local. */
export function readState(events = readEvents()): State {
  return fold(events, pathMap());
}

/** The machine name ids carry, when the log is shared. */
function idDevice(): string | undefined {
  return sharedDir() ? deviceName() : undefined;
}

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
  const s = readState();
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
  /** the agent session opening the card */
  session?: string;
  /** when the matter first came up (a date or a timestamp) */
  since?: string;
  /** an approval: the exact command or step that runs on yes */
  action?: string;
  /** a file whose text the action would send or change */
  preview?: string;
}

const PREVIEW_MAX = 20_000;

function readPreview(file: string | undefined): string | undefined {
  if (!file?.trim()) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(file), "utf8");
  } catch {
    throw new UserError(`cannot read the preview file ${file}`);
  }
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "\n…" : text;
}

/** A date or timestamp as ISO text; a bare date counts as local midnight. */
export function parseWhen(s: string): string {
  const t = s.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00`) : new Date(t);
  if (Number.isNaN(d.getTime())) throw new UserError(`"${s}" is not a date (use YYYY-MM-DD)`);
  return d.toISOString();
}

/** The claimed name of a session (claims may hold an id prefix). */
export function sessionTitle(claims: Claim[], session: string | undefined): string | undefined {
  if (!session) return undefined;
  const c = claims.find((x) => session.startsWith(x.session) || x.session.startsWith(session));
  return c?.title;
}

function checkKind(kind: string): CardKind {
  if (!CARD_KINDS.includes(kind as CardKind)) throw new UserError(`kind must be one of ${CARD_KINDS.join(", ")}`);
  return kind as CardKind;
}

export function openCard(input: CardInput): Card {
  if (!input.title.trim()) throw new UserError("a card needs a title");
  if (!input.project.trim()) throw new UserError("a card needs --project");
  const action = input.action?.trim() || undefined;
  // an approval with no choices of its own is a yes or a no
  const options = cleanList(input.options) ?? (action ? ["Do it", "Don't"] : undefined);
  const preview = readPreview(input.preview);
  if (input.recommend !== undefined) {
    if (!options) throw new UserError("--recommend needs --option");
    if (!Number.isInteger(input.recommend) || input.recommend < 1 || input.recommend > options.length) {
      throw new UserError(`--recommend must be between 1 and ${options.length}`);
    }
  }
  checkKind(input.kind);
  const since = input.since?.trim() ? parseWhen(input.since) : undefined;
  let id = "";
  appendEvent((events) => {
    id = nextId(events, "c", idDevice());
    const session = input.session?.trim() || undefined;
    const from = input.from?.trim() || sessionTitle(fold(events).claims, session);
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
        from,
        session,
        since,
        action,
        preview,
      },
    };
  });
  const card = readState().cards.get(id);
  if (!card) throw new Error("card vanished right after it was written");
  return card;
}

/** A card by id; a shared id may leave out its machine (`c3` for `pc-c3`). */
export function findCard(state: State, id: string): Card | undefined {
  const k = findId(state.cards, id);
  return k ? state.cards.get(k) : undefined;
}

function requireCard(id: string): Card {
  const card = findCard(readState(), id);
  if (!card) throw new UserError(`no card "${id}"`);
  return card;
}

function requireRun(id: string): string {
  const k = findId(readState().runs, id);
  if (!k) throw new UserError(`no declared run "${id}"`);
  return k;
}

export function answerCard(id: string, a: { choice?: number; comment?: string; attach?: string[]; by?: string }): void {
  const card = requireCard(id);
  id = card.id;
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
  const shared = !!sharedDir();
  appendEvent((events) => ({
    type: "card.answer",
    card: id,
    by: a.by || HUMAN,
    choice: a.choice,
    comment: a.comment?.trim() || undefined,
    attach: absPaths(a.attach),
    // what this machine knew when answering, so a crossing answer from another machine shows
    seen: shared ? events.filter((e) => e.type === "card.answer" && e.card === id).length : undefined,
  }));
}

export function commentCard(id: string, text: string, by: string): void {
  id = requireCard(id).id;
  if (!text.trim()) throw new UserError("a comment needs text");
  appendEvent(() => ({ type: "card.comment", card: id, by, text: text.trim() }));
}

export function editCard(id: string, set: CardEdit): Card {
  id = requireCard(id).id;
  const clean: CardEdit = {};
  if (set.kind !== undefined) clean.kind = checkKind(set.kind);
  if (set.title !== undefined) {
    if (!set.title.trim()) throw new UserError("a card needs a title");
    clean.title = set.title.trim();
  }
  // an empty value clears the field; null survives JSON where undefined would vanish
  const cleared = null as unknown as undefined;
  if (set.body !== undefined) clean.body = set.body.trim() || cleared;
  if (set.task !== undefined) clean.task = set.task.trim() || cleared;
  if (set.from !== undefined) clean.from = set.from.trim() || cleared;
  if (set.session !== undefined) clean.session = set.session.trim() || cleared;
  if (set.since !== undefined) clean.since = set.since.trim() ? parseWhen(set.since) : cleared;
  if (!Object.keys(clean).length) throw new UserError("nothing to change");
  appendEvent(() => ({ type: "card.edit", card: id, set: clean }));
  return requireCard(id);
}

export function closeCard(id: string, note?: string): void {
  const card = requireCard(id);
  if (card.status === "closed") return;
  appendEvent(() => ({ type: "card.close", card: card.id, note: note?.trim() || undefined }));
}

export interface RunInput {
  project: string;
  task?: string;
  title: string;
  parent?: string;
  /** seconds without a sign of life before the run counts as stalled */
  heartbeat?: number;
  /** a log file whose changes count as signs of life */
  log?: string;
}

export function startRun(r: RunInput): string {
  if (r.heartbeat !== undefined && (!Number.isFinite(r.heartbeat) || r.heartbeat <= 0)) throw new UserError("--heartbeat must be a number of seconds above 0");
  const log = r.log?.trim() ? path.resolve(r.log) : undefined;
  let id = "";
  appendEvent((events) => {
    id = nextId(events, "r", idDevice());
    return { type: "run.start", run: { id, project: r.project, task: r.task, title: r.title, parent: r.parent, heartbeat: r.heartbeat, log } };
  });
  return id;
}

export function noteRun(id: string, text: string): void {
  const run = requireRun(id);
  appendEvent(() => ({ type: "run.note", run, text }));
}

export function beatRun(id: string): void {
  const run = requireRun(id);
  appendEvent(() => ({ type: "run.beat", run }));
}

export function endRun(id: string, status: "done" | "failed", note?: string): void {
  const run = requireRun(id);
  appendEvent(() => ({ type: "run.end", run, status, note }));
}

export interface ClaimInput {
  session: string;
  project?: string;
  task?: string;
  role?: string;
  title?: string;
  kind?: "scheduled";
  /** the work is finished: a one-line summary */
  done?: string;
}

/**
 * Say which project and task a session works on. A claim without a project keeps the session's
 * earlier claim and only changes what is given (for `--done`). A claim of a new task clears `done`.
 */
export function claimSession(input: ClaimInput): Claim {
  if (input.session.length < 6) throw new UserError("give at least 6 characters of the session id");
  const before = readState().claims.find((c) => c.session === input.session);
  const project = input.project?.trim() || before?.project;
  if (!project) throw new UserError("this session has not claimed a project yet: give --project");
  const sameWork = !input.project || (input.project === before?.project && (input.task ?? before?.task) === before?.task);
  const claim: Claim = {
    session: input.session,
    project,
    task: input.task ?? (sameWork ? before?.task : undefined),
    role: input.role ?? before?.role,
    title: input.title ?? before?.title,
    kind: input.kind ?? before?.kind,
    // any new claim means work goes on; only --done marks it finished
    done: input.done?.trim() || undefined,
  };
  for (const k of Object.keys(claim) as (keyof Claim)[]) if (claim[k] === undefined) delete claim[k];
  appendEvent(() => ({ type: "run.claim", claim }));
  return claim;
}

// ---------------------------------------------------------------- pull requests

export function linkPr(link: { pr: PrRef; session?: string; project?: string; task?: string }): void {
  const claims = readState().claims;
  const claim = link.session ? claims.find((c) => link.session!.startsWith(c.session)) : undefined;
  const project = link.project?.trim() || claim?.project;
  appendEvent(() => ({
    type: "pr.link",
    link: { pr: link.pr, session: link.session, project, task: link.task?.trim() || claim?.task },
  }));
}

export function unlinkPr(key: string): void {
  if (!readState().prLinks.has(key)) throw new UserError(`no linked pull request ${key}`);
  appendEvent(() => ({ type: "pr.unlink", pr: key }));
}

/** Something another tool saw on a PR (a merge bot, a ticket system), recorded like GitHub's own. */
export function prEvent(pr: PrRef, change: string, opts: { by?: string; text?: string; title?: string } = {}): void {
  if (!PR_CHANGES.includes(change as PrChange)) throw new UserError(`change must be one of ${PR_CHANGES.join(", ")}`);
  appendEvent(() => ({ type: "pr.change", pr, change: change as PrChange, by: opts.by, text: opts.text?.trim() || undefined, title: opts.title, source: "external" }));
}

// ---------------------------------------------------------------- inbox

export interface InboxItem {
  seq: number;
  /** the machine whose log holds it (with `seq`, where a reader has read up to) */
  dev?: string;
  at: string;
  kind: "answer" | "comment" | "pr";
  /** the card answered or commented on; absent for pull request news */
  card?: Card;
  /** pull request news for a PR linked to the project */
  pr?: { ref: PrRef; change: PrChange; title?: string; text?: string; project?: string };
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

/** Two machines that both read GitHub report the same change; the later report is an echo. */
const ECHO_MS = 30 * 60_000;

/**
 * Human answers and comments after `after` (a position, or a seq on a single machine), on cards
 * that are not closed, and news on pull requests linked to the project. An answer given on
 * another machine before it saw an earlier answer is kept on the card but not delivered.
 */
export function inboxFrom(events: PwEvent[], after: Position | number, filter: InboxFilter, state = readState(events)): InboxItem[] {
  const pos: Position = typeof after === "number" ? { [deviceName()]: after } : after;
  const out: InboxItem[] = [];
  const reported = new Map<string, { dev?: string; at: number }>();
  const answerNo = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "pr.change") {
      const k = `${ev.pr.key}|${ev.change}|${ev.text ?? ""}`;
      const prev = reported.get(k);
      const at = Date.parse(ev.ts);
      reported.set(k, { dev: ev.dev, at });
      if (prev && prev.dev !== ev.dev && at - prev.at < ECHO_MS) continue;
      if (!isAfter(ev, pos)) continue;
      const link = state.prLinks.get(ev.pr.key);
      if (!link || filter.card || (filter.project && link.project !== filter.project)) continue;
      out.push({ seq: ev.seq, dev: ev.dev, at: ev.ts, kind: "pr", by: ev.by ?? ev.source, pr: { ref: ev.pr, change: ev.change, title: ev.title, text: ev.text, project: link.project } });
      continue;
    }
    if (ev.type !== "card.answer" && ev.type !== "card.comment") continue;
    let late = false;
    if (ev.type === "card.answer") {
      const n = answerNo.get(ev.card) ?? 0;
      answerNo.set(ev.card, n + 1);
      late = typeof ev.seen === "number" && ev.seen < n;
    }
    if (!isAfter(ev, pos)) continue;
    if (ev.by !== HUMAN || late) continue;
    const card = state.cards.get(ev.card);
    if (!card || card.status === "closed") continue;
    if (filter.project && card.project !== filter.project) continue;
    if (filter.card && card.id !== filter.card) continue;
    if (ev.type === "card.answer") {
      out.push({
        seq: ev.seq,
        dev: ev.dev,
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
      out.push({ seq: ev.seq, dev: ev.dev, at: ev.ts, kind: "comment", card, by: ev.by, comment: ev.text });
    }
  }
  return out;
}

// ---------------------------------------------------------------- listeners

/** Waits are visible to every machine when the log is shared. */
function listenersDir(): string {
  return path.join(sharedDir() ?? homeDir(), "listeners");
}

/** How often a wait says it is still there, and when one on another machine counts as gone. */
const LISTENER_BEAT_MS = 60_000;
const LISTENER_GONE_MS = 3 * LISTENER_BEAT_MS;

/** Mark this process as waiting, so cards can say whether an answer reaches an agent at once. */
export function startListening(l: Omit<Listener, "pid" | "since">): () => void {
  const shared = !!sharedDir();
  const file = path.join(listenersDir(), shared ? `${deviceName()}-${process.pid}.json` : `${process.pid}.json`);
  fs.mkdirSync(listenersDir(), { recursive: true });
  const me: Listener = { ...l, pid: process.pid, since: new Date().toISOString(), ...(shared ? { device: deviceName(), beat: new Date().toISOString() } : {}) };
  const write = () => {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(me) + "\n");
      fs.renameSync(tmp, file);
    } catch {
      // the folder may be busy syncing; the next beat writes it again
    }
  };
  write();
  const timer = shared
    ? setInterval(() => {
        me.beat = new Date().toISOString();
        write();
      }, LISTENER_BEAT_MS)
    : undefined;
  timer?.unref();
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    fs.rmSync(file, { force: true });
  };
  process.once("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      stop();
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
    });
  }
  return stop;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits running now, on this machine and (when shared) the others. Files left by a process that
 * died here are removed; a wait on another machine counts while its beat is fresh.
 */
export function listeners(now = Date.now()): Listener[] {
  let names: string[];
  try {
    names = fs.readdirSync(listenersDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const me = deviceName();
  const out: Listener[] = [];
  for (const n of names) {
    const file = path.join(listenersDir(), n);
    try {
      const l = JSON.parse(fs.readFileSync(file, "utf8")) as Listener;
      if (l.device && l.device !== me) {
        if (l.beat && now - Date.parse(l.beat) < LISTENER_GONE_MS) out.push(l);
      } else if (alive(l.pid)) out.push(l);
      else fs.rmSync(file, { force: true });
    } catch {
      // half written; read it next time
    }
  }
  return out;
}

/** The waits an answer to this card would wake right now. */
export function listenersFor(card: Card, ls: Listener[]): Listener[] {
  return ls.filter((l) => (l.card ? l.card === card.id : !l.project || l.project === card.project));
}

export function consumerName(opts: { as?: string; project?: string; card?: string }): string {
  return opts.as || opts.project || (opts.card ? `card-${opts.card}` : "default");
}

export function readInbox(consumer: string, filter: InboxFilter, move: boolean): InboxItem[] {
  const events = readEvents();
  const pos = readCursor(consumer);
  const items = inboxFrom(events, pos, filter);
  if (move && items.length) writeCursor(consumer, advance(pos, items));
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
    const dir = eventsDir();
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
