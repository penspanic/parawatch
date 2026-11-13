import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { advance, appendEvent, deviceName, eventsDir, homeDir, isAfter, readCursor, readEvents, sharedDir, writeCursor, type Position } from "./store.js";
import { archivedSessions } from "./desktop.js";
import { findId, fold, nextId, sessionTitle, type State } from "./state.js";
import { collectRuns } from "./runs.js";
import { pathMap } from "./sync.js";
import { CARD_KINDS, HUMAN, PR_CHANGES, type Card, type CardEditInput, type CardKind, type Claim, type Listener, type PrChange, type PrRef, type PwEvent } from "./types.js";

export { UserError, sessionTitle };

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

/**
 * An attachment or a thing to open, as stored. A URL, and a path that is absolute on either
 * system (`/Users/...`, `C:\...`, `\\server\share`), is kept as written: it may name a place on
 * another machine, and resolving it here would root it on this one (`E:\Users\...` on Windows,
 * `<cwd>/C:\...` on a Mac). Only a relative path is resolved.
 */
export function storedPath(x: string): string {
  if (/^[a-z]+:\/\//i.test(x)) return x;
  if (path.posix.isAbsolute(x) || path.win32.isAbsolute(x)) return x;
  return path.resolve(x);
}

function absPaths(xs: string[] | undefined): string[] | undefined {
  return cleanList(xs)?.map(storedPath);
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

function readPreview(file: string | undefined): { preview: string; previewFile: string } | undefined {
  if (!file?.trim()) return undefined;
  const abs = path.resolve(file);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    throw new UserError(`cannot read the preview file ${file}`);
  }
  return { preview: text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "\n…" : text, previewFile: abs };
}

/** A date or timestamp as ISO text; a bare date counts as local midnight. */
export function parseWhen(s: string): string {
  const t = s.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00`) : new Date(t);
  if (Number.isNaN(d.getTime())) throw new UserError(`"${s}" is not a date (use YYYY-MM-DD)`);
  return d.toISOString();
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
  const pv = readPreview(input.preview);
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
        preview: pv?.preview,
        previewFile: pv?.previewFile,
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

export function editCard(id: string, set: CardEditInput): Card {
  const card = requireCard(id);
  id = card.id;
  const clean: Extract<PwEvent, { type: "card.edit" }>["set"] = {};
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
  const approval = set.action !== undefined || set.preview !== undefined || set.attach !== undefined;
  if (approval && card.answers.length) {
    throw new UserError(`card ${id} was already answered; close it and open a new one (a yes must not apply to text the human did not see)`);
  }
  if (set.action !== undefined) clean.action = set.action.trim() || cleared;
  if (set.preview !== undefined) {
    const pv = readPreview(set.preview);
    clean.preview = pv?.preview ?? cleared;
    clean.previewFile = pv?.previewFile ?? cleared;
  }
  if (set.attach !== undefined) clean.attach = absPaths(set.attach) ?? cleared;
  if (!Object.keys(clean).length) throw new UserError("nothing to change");
  appendEvent(() => ({ type: "card.edit", card: id, set: clean }));
  return requireCard(id);
}

export function closeCard(id: string, note?: string): void {
  const card = requireCard(id);
  if (card.status === "closed") return;
  appendEvent(() => ({ type: "card.close", card: card.id, note: note?.trim() || undefined }));
}

/**
 * The human drops a card that no longer matters, without answering it. It closes, and the agent
 * that asked reads that it was dismissed (a wait wakes for it), so nothing waits on it forever.
 */
export function dismissCard(id: string, note?: string): void {
  const card = requireCard(id);
  if (card.status === "closed") throw new UserError(`card ${card.id} is already closed`);
  appendEvent(() => ({ type: "card.close", card: card.id, note: note?.trim() || undefined, dismissed: true }));
}

/** The session id as claims hold it, when one matches; else as given. */
function claimedId(state: State, session: string): string {
  return state.claims.find((c) => sameSession(c.session, session))?.session ?? session;
}

/** Give an open card to another session. That session is told once, with the last answer. */
export function handCard(id: string, session: string): Card {
  const card = requireCard(id);
  if (card.status === "closed") throw new UserError(`card ${card.id} is already closed`);
  if (session.length < 6) throw new UserError("give at least 6 characters of the session id");
  const to = claimedId(readState(), session);
  appendEvent(() => ({ type: "card.hand", card: card.id, session: to, by: HUMAN }));
  return card;
}

/** Give a pull request to another session: its news wakes that session from now on. */
export function handPr(pr: PrRef, session: string): void {
  if (session.length < 6) throw new UserError("give at least 6 characters of the session id");
  const state = readState();
  const link = state.prLinks.get(pr.key);
  linkPr({ pr, session: claimedId(state, session), project: link?.project, task: link?.task, handed: true });
}

/**
 * Answered cards no session gets in a project: no owner, or the owner has ended, and no live lead
 * (or a lead that came after the answer). A new lead takes them over.
 */
export function backlogOf(project: string, state = readState()): Card[] {
  const ended = endedSessions(state);
  return [...state.cards.values()].filter((c) => c.project === project && c.status === "answered" && (!c.session || ended(c.session)));
}

/** Hand the answered cards no session gets to the project's lead, who is told of each once. */
export function takeBacklog(project: string, session: string): string[] {
  const handed: string[] = [];
  for (const c of backlogOf(project)) {
    if (sameSession(c.session, session)) continue;
    handCard(c.id, session);
    handed.push(c.id);
  }
  return handed;
}

/**
 * Make a session the project's lead (the human's pick, from the panel or `parawatch lead`).
 * Earlier leads of the project step down; answered cards no session got are handed to it.
 */
export function makeLead(project: string, session: string): { session: string; handed: string[] } {
  if (session.length < 6) throw new UserError("give at least 6 characters of the session id");
  const state = readState();
  const to = claimedId(state, session);
  for (const c of state.claims) {
    if (c.role === "lead" && c.project === project && !sameSession(c.session, to)) claimSession({ session: c.session, role: "", done: c.done });
  }
  // a lead works on: any done it said earlier no longer stands
  claimSession({ session: to, project, role: "lead" });
  return { session: to, handed: takeBacklog(project, to) };
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

/** The id of a seen or declared run from the start of it (6+ characters), or the exact id. */
function resolveRunId(id: string, state: State): string {
  const exact = (xs: string[]) => (xs.includes(id) ? [id] : xs.filter((x) => x.startsWith(id)));
  if (id.length < 6 && !state.runs.has(id)) throw new UserError("give at least 6 characters of the run id");
  const seen = collectRuns(state, { sinceHours: 24 * 7, includeEnded: true, keepRepeats: true }).map((r) => r.id);
  const found = [...new Set(exact([...seen, ...state.runs.keys(), ...state.hidden.keys()]))];
  if (found.length === 1) return found[0]!;
  if (!found.length) throw new UserError(`no run "${id}" (parawatch runs --wide shows ids)`);
  throw new UserError(`"${id}" matches ${found.length} runs; give more of the id`);
}

/** Hide a run from the lists until it does something new. Works for runs other machines shared. */
export function hideRun(id: string): string {
  const run = resolveRunId(id, readState());
  appendEvent(() => ({ type: "run.hide", run }));
  return run;
}

export function unhideRun(id: string): string {
  const state = readState();
  const hidden = [...state.hidden.keys()].filter((k) => k === id || k.startsWith(id));
  const run = hidden.length === 1 ? hidden[0]! : hidden.length ? hidden.find((k) => k === id) : resolveRunId(id, state);
  if (!run) throw new UserError(`"${id}" matches ${hidden.length} hidden runs; give more of the id`);
  appendEvent(() => ({ type: "run.unhide", run }));
  return run;
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

export function linkPr(link: { pr: PrRef; session?: string; project?: string; task?: string; auto?: boolean; handed?: boolean }): void {
  const claims = readState().claims;
  const claim = link.session ? claims.find((c) => link.session!.startsWith(c.session)) : undefined;
  const project = link.project?.trim() || claim?.project;
  appendEvent(() => ({
    type: "pr.link",
    link: { pr: link.pr, session: link.session, project, task: link.task?.trim() || claim?.task, auto: link.auto || undefined, handed: link.handed || undefined },
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
  /** "handed": the human gave this session a card (with its last answer) or a pull request */
  kind: "answer" | "comment" | "dismissed" | "pr" | "handed";
  /** the card answered or commented on; absent for pull request news */
  card?: Card;
  /** pull request news for a PR linked to the project; no change when it was handed over */
  pr?: { ref: PrRef; change?: PrChange; title?: string; text?: string; project?: string };
  by: string;
  choice?: number;
  choiceText?: string;
  comment?: string;
  attach?: string[];
}

export interface InboxFilter {
  project?: string;
  card?: string;
  /**
   * Only what belongs to this agent session: cards it opened and pull requests linked to it. With
   * `project`, cards and pull requests that no session owns in that project come along, and so
   * do those of sessions that have ended, except a pull request already merged or closed. What
   * another live session owns is never in it: that session gets it, even when this one leads.
   */
  session?: string;
  /** whether a session has ended; read from the claims and the Claude desktop app when absent */
  ended?: (session: string) => boolean;
}

/** Whether two session ids name the same session. A claim or a link may hold a short prefix. */
export function sameSession(a?: string, b?: string): boolean {
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Whether a session has ended: it said so with `claim --done`, or the human archived it in the
 * Claude desktop app. Cards and pull requests it owned then belong to its project, so an answer
 * still reaches a session waiting there. The desktop app is read only when asked about a session
 * that has not claimed done.
 */
export function endedSessions(state: State, isArchived?: (session: string) => boolean): (session: string) => boolean {
  let archived = isArchived;
  return (session) => {
    const claim = state.claims.find((c) => sameSession(c.session, session));
    if (claim?.done) return true;
    archived ??= archivedSessions();
    return archived(session);
  };
}

/**
 * The project's lead: the session that most recently claimed it with `--role lead` and has not
 * ended. It gets what no session owns in the project, and what a session that has ended left.
 */
export function leadOf(state: State, ended: (session: string) => boolean): (project?: string) => string | undefined {
  const memo = new Map<string, string | undefined>();
  return (project) => {
    if (!project) return undefined;
    if (!memo.has(project)) {
      // the newest claim leads; claims keep log order, so a tie in time goes to the later one
      const leads = state.claims
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.role === "lead" && c.project === project && !c.done && !ended(c.session))
        .sort((a, b) => (b.c.at ?? "").localeCompare(a.c.at ?? "") || b.i - a.i);
      memo.set(project, leads[0]?.c.session);
    }
    return memo.get(project);
  };
}

/** Whether something owned by `owner` in `project` is for a reader with this filter. */
function inScope(
  owner: string | undefined,
  project: string | undefined,
  f: InboxFilter,
  ended: (session: string) => boolean,
  lead: (project?: string) => string | undefined,
): boolean {
  if (f.session) {
    if (owner && sameSession(owner, f.session)) return true;
    if (owner && !ended(owner)) return false;
    // no owner, or it has ended: the project's lead takes it; without a lead it waits in parawatch
    return sameSession(lead(project), f.session);
  }
  return !f.project || project === f.project;
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
  const ended = filter.ended ?? endedSessions(state);
  const lead = leadOf(state, ended);
  const finished = new Set<string>();
  // a card handed to this reader comes with its last answer; the answers before it are not repeated
  const handedAt = new Map<string, number>();
  if (filter.session) {
    events.forEach((ev, i) => {
      if (ev.type === "card.hand" && isAfter(ev, pos) && sameSession(ev.session, filter.session)) handedAt.set(ev.card, i);
    });
  }
  for (const [i, ev] of events.entries()) {
    if (ev.type === "pr.link") {
      // a pull request the human handed to this session: told once
      if (!ev.link.handed || !isAfter(ev, pos) || !filter.session || filter.card || !sameSession(ev.link.session, filter.session)) continue;
      const now = state.prLinks.get(ev.link.pr.key);
      if (!now || !sameSession(now.session, filter.session)) continue;
      out.push({ seq: ev.seq, dev: ev.dev, at: ev.ts, kind: "handed", by: HUMAN, pr: { ref: ev.link.pr, project: now.project } });
      continue;
    }
    if (ev.type === "card.hand") {
      // a card the human handed to this session: told once, with the last answer on it
      if (!isAfter(ev, pos) || !filter.session || !sameSession(ev.session, filter.session)) continue;
      const card = state.cards.get(ev.card);
      if (!card || card.status === "closed" || !sameSession(card.session, filter.session)) continue;
      if (filter.card && card.id !== filter.card) continue;
      const last = [...card.answers].reverse().find((a) => a.by === HUMAN && !a.late);
      out.push({
        seq: ev.seq,
        dev: ev.dev,
        at: ev.ts,
        kind: "handed",
        card,
        by: ev.by,
        choice: last?.choice,
        choiceText: last?.choice !== undefined ? card.options?.[last.choice - 1] : undefined,
        comment: last?.comment,
        attach: last?.attach,
      });
      continue;
    }
    if (ev.type === "pr.change") {
      const wasOver = finished.has(ev.pr.key);
      if (ev.change === "merged" || ev.change === "closed") finished.add(ev.pr.key);
      const k = `${ev.pr.key}|${ev.change}|${ev.text ?? ""}`;
      const prev = reported.get(k);
      const at = Date.parse(ev.ts);
      reported.set(k, { dev: ev.dev, at });
      if (prev && prev.dev !== ev.dev && at - prev.at < ECHO_MS) continue;
      if (!isAfter(ev, pos)) continue;
      const link = state.prLinks.get(ev.pr.key);
      if (!link || filter.card || !inScope(link.session, link.project, filter, ended, lead)) continue;
      // a merged or closed pull request whose owner has ended needs no one: its news, the merge
      // itself and the bot comments after it, stays on the pull request
      if (filter.session && !sameSession(link.session, filter.session) && (wasOver || finished.has(ev.pr.key))) continue;
      out.push({ seq: ev.seq, dev: ev.dev, at: ev.ts, kind: "pr", by: ev.by ?? ev.source, pr: { ref: ev.pr, change: ev.change, title: ev.title, text: ev.text, project: link.project } });
      continue;
    }
    if (ev.type === "card.close") {
      // a card the human dismissed reaches the agent that asked, once
      if (!ev.dismissed || !isAfter(ev, pos)) continue;
      const card = state.cards.get(ev.card);
      if (!card || !inScope(card.session, card.project, filter, ended, lead)) continue;
      if (filter.card && card.id !== filter.card) continue;
      out.push({ seq: ev.seq, dev: ev.dev, at: ev.ts, kind: "dismissed", card, by: HUMAN, comment: ev.note });
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
    if ((handedAt.get(ev.card) ?? -1) > i) continue;
    const card = state.cards.get(ev.card);
    if (!card || card.status === "closed") continue;
    if (!inScope(card.session, card.project, filter, ended, lead)) continue;
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

/**
 * The waits an answer to this card would wake right now. A card whose session has ended, or that
 * no session opened, reaches the project's lead only. A snapshot's card says so itself
 * (`ownerEnded`, `lead`, `unrouted`); otherwise `ended` and the claims tell.
 */
export function listenersFor(card: Card, ls: Listener[], ended?: (session: string) => boolean): Listener[] {
  let gone: boolean | undefined = card.ownerEnded;
  const isEnded = () => ended ?? endedSessions(readState());
  const ownerGone = () => (gone ??= !!card.session && isEnded()(card.session));
  // a snapshot's card names its lead, or says it has none
  let lead: string | null | undefined = card.lead ?? (card.unrouted ? null : undefined);
  const leadNow = () => (lead === undefined ? (lead = leadOf(readState(), isEnded())(card.project) ?? null) : lead) ?? undefined;
  return ls.filter((l) =>
    l.card
      ? l.card === card.id
      : l.scope === "session"
        ? card.session && sameSession(l.session, card.session)
          ? true
          : (!card.session || ownerGone()) && sameSession(l.session, leadNow())
        : !l.project || l.project === card.project,
  );
}

export function consumerName(opts: { as?: string; project?: string; card?: string }): string {
  return opts.as || opts.project || (opts.card ? `card-${opts.card}` : "default");
}

/** The cursor a session reads with when it waits for its own news. */
export function sessionConsumer(session: string): string {
  return `session-${session.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Per device, the further of two positions. */
export function furthest(a: Position, b: Position): Position {
  const out = { ...a };
  for (const [d, seq] of Object.entries(b)) if (seq > (out[d] ?? 0)) out[d] = seq;
  return out;
}

export interface InboxScope {
  consumer: string;
  filter: InboxFilter;
}

/**
 * What a wait or an inbox reads. `--card` and `--project` read what they name, with a cursor of
 * that name. Called from an agent session without either, it reads that session's own cards and
 * pull requests, plus unowned ones in the project the session claimed, with a cursor of its own:
 * sessions in one project neither wake for each other's news nor take it from each other.
 * `--project` from a session names the project instead of the claim, with the same rule. Outside
 * a session, it reads everything.
 */
export function inboxScope(opts: { as?: string; project?: string; card?: string }, session?: string): InboxScope {
  if (opts.card || !session) return { consumer: consumerName(opts), filter: { project: opts.project, card: opts.card } };
  const consumer = opts.as || sessionConsumer(session);
  if (opts.project) {
    // A lead waiting on its project from a session: what other live sessions own is theirs. It
    // takes over the project cursor once, so it does not hear again what that wait delivered.
    const mine = readCursor(consumer);
    const merged = furthest(Object.keys(mine).length ? mine : bornAt(session), readCursor(opts.project));
    if (JSON.stringify(merged) !== JSON.stringify(mine)) writeCursor(consumer, merged);
    return { consumer, filter: { session, project: opts.project } };
  }
  const claim = readState().claims.find((c) => sameSession(session, c.session));
  // A session that used to wait on its project starts where that wait stopped, so moving to its
  // own cursor does not bring back news it has already handled.
  if (claim && !Object.keys(readCursor(consumer)).length) {
    const from = furthest(bornAt(session), readCursor(claim.project));
    if (Object.keys(from).length) writeCursor(consumer, from);
  }
  return { consumer, filter: { session, project: claim?.project } };
}

/**
 * Where a session's first wait starts: just before the session first shows in the log (a claim,
 * a card it opened, a pull request linked to it, something handed to it). Nothing before that was
 * its to act on, and a lead starting at the top of the log would hear every old pull request and
 * answer of the project again. A session the log has not seen starts at the top; it has nothing
 * of its own and no project yet.
 */
export function bornAt(session: string, events = readEvents()): Position {
  const i = events.findIndex((ev) => {
    switch (ev.type) {
      case "run.claim":
        return sameSession(ev.claim.session, session);
      case "card.open":
        return sameSession(ev.card.session, session);
      case "pr.link":
        return sameSession(ev.link.session, session);
      case "card.hand":
        return sameSession(ev.session, session);
      default:
        return false;
    }
  });
  return i < 0 ? {} : advance({}, events.slice(0, i));
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
    // on Windows a watched folder a sync tool writes into can report EPERM; polling goes on
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined; // polling alone still works
  }
  try {
    for (;;) {
      let items: InboxItem[] = [];
      try {
        items = readInbox(consumer, filter, true);
      } catch (err) {
        // a file busy for a moment is read again on the next poll; a wait must not end without an answer
        if (!["EPERM", "EBUSY", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      }
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
