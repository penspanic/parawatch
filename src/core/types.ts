/** The version of the JSON that commands print (`--json`) and panels read. */
export const SCHEMA_VERSION = 1;

/**
 * The newest event-log format this copy reads and writes. 1: one machine. 2: per-device logs in a
 * shared folder (prefixed ids, answers that record what they saw). A copy refuses to write to a
 * log with a newer format than it knows.
 */
export const STORE_FORMAT = 2;

/**
 * decide: a choice. try: try a build or look at something. block: only the human can do it and
 * the agent is stuck until they do. todo: only the human can do it, but nothing waits on it now.
 */
export type CardKind = "decide" | "try" | "block" | "todo";
export const CARD_KINDS: CardKind[] = ["decide", "try", "block", "todo"];
export type CardStatus = "open" | "answered" | "closed";

export interface Answer {
  seq: number;
  at: string;
  by: string;
  /** the machine the answer was given on (shared folders only) */
  dev?: string;
  /**
   * given on another machine before that machine saw an earlier answer: kept on the card, but the
   * earlier answer stands and this one is not delivered
   */
  late?: boolean;
  choice?: number;
  comment?: string;
  attach?: string[];
}

export interface Comment {
  seq: number;
  at: string;
  by: string;
  text: string;
}

export interface Card {
  id: string;
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
  /** who asked: an agent or session name */
  from?: string;
  /** the agent session that opened the card, so the human can jump to it */
  session?: string;
  /** when the matter first came up, if earlier than the card (moved from a board, say) */
  since?: string;
  openedAt: string;
  /** the machine the card was opened on (shared folders only) */
  dev?: string;
  status: CardStatus;
  answers: Answer[];
  comments: Comment[];
  closedAt?: string;
  closeNote?: string;
  /** an approval: the exact command or step that runs if the human says yes */
  action?: string;
  /** text the action would send or change (a message, a diff), shown with the card */
  preview?: string;
}

/** Fields `parawatch edit` may change on a card. */
export type CardEdit = Partial<Pick<Card, "kind" | "title" | "body" | "task" | "from" | "session" | "since">>;

export interface Project {
  name: string;
  paths: string[];
  addedAt: string;
}

export interface Claim {
  session: string;
  project: string;
  task?: string;
  role?: string;
  title?: string;
  /** "scheduled": started by a schedule, so repeated runs of the same task fold into one row */
  kind?: "scheduled";
  /** the session said its work is finished, with this one-line summary */
  done?: string;
  /** when the claim was made (filled from the event time) */
  at?: string;
}

export interface DeclaredRun {
  id: string;
  project: string;
  task?: string;
  title: string;
  parent?: string;
  startedAt: string;
  lastActivity: string;
  note?: string;
  status: "running" | "done" | "failed";
  endedAt?: string;
  /** seconds without a beat, a note or log output after which the run counts as stalled */
  heartbeat?: number;
  /** a log file whose changes count as beats */
  log?: string;
}

/** A pull request, wherever it is hosted. `key` is `host/owner/repo#number`. */
export interface PrRef {
  key: string;
  host: string;
  repo: string;
  number: number;
  url: string;
}

/** A pull request an agent session said is its own, or that its log shows it opened. */
export interface PrLink {
  pr: PrRef;
  session?: string;
  project?: string;
  task?: string;
  at: string;
}

export type PrChange =
  | "review"
  | "approved"
  | "changes_requested"
  | "commented"
  | "ci_failed"
  | "ci_passed"
  | "queued"
  | "queue_removed"
  | "conflict"
  | "merged"
  | "closed"
  | "note";

export const PR_CHANGES: PrChange[] = ["review", "approved", "changes_requested", "commented", "ci_failed", "ci_passed", "queued", "queue_removed", "conflict", "merged", "closed", "note"];

/** Fields shared by every event line. */
interface EventBase {
  v: number;
  /** the order within one machine's log */
  seq: number;
  ts: string;
  /** the machine whose log holds the event; filled in when read, never written */
  dev?: string;
}

export type EventBody =
  | { type: "project.add"; project: Project }
  | { type: "project.remove"; name: string }
  | { type: "card.open"; card: Omit<Card, "status" | "answers" | "comments" | "openedAt"> }
  /** `seen`: how many answers the card had where it was written (shared folders only) */
  | { type: "card.answer"; card: string; by: string; choice?: number; comment?: string; attach?: string[]; seen?: number }
  | { type: "card.comment"; card: string; by: string; text: string }
  | { type: "card.close"; card: string; note?: string }
  | { type: "card.edit"; card: string; set: CardEdit }
  | { type: "run.start"; run: { id: string; project: string; task?: string; title: string; parent?: string; heartbeat?: number; log?: string } }
  | { type: "run.note"; run: string; text: string }
  | { type: "run.beat"; run: string }
  | { type: "run.end"; run: string; status: "done" | "failed"; note?: string }
  | { type: "run.claim"; claim: Claim }
  | { type: "pr.link"; link: Omit<PrLink, "at"> }
  | { type: "pr.unlink"; pr: string }
  /** something happened on a pull request: read from GitHub, or reported by another tool */
  | { type: "pr.change"; pr: PrRef; change: PrChange; title?: string; by?: string; text?: string; source: "github" | "external" }
  /** left in a single-machine log that moved to a shared folder, so older copies stop writing to it */
  | { type: "store.moved"; to: string };

export type PwEvent = EventBase & EventBody;

/** What `parawatch status --json` prints and what the panels render. */
export interface Snapshot {
  v: number;
  generatedAt: string;
  projects: Project[];
  cards: Card[];
  runs: Run[];
  /** open pull requests and what each waits on; absent when GitHub is not set up */
  prs?: PrView[];
  github?: GithubInfo;
  /** agents blocked in `parawatch wait` right now */
  listeners?: Listener[];
  /** this machine and the others, when the log is shared */
  devices?: { me: string; others: string[] };
}

export interface GithubInfo {
  /** `gh` is installed and signed in */
  enabled: boolean;
  fetchedAt?: string;
  error?: string;
}

/** A running `parawatch wait`: an answer that matches it is delivered at once. */
export interface Listener {
  consumer: string;
  pid: number;
  /** the machine the wait runs on (shared folders only) */
  device?: string;
  /** last sign of life, for waits on other machines */
  beat?: string;
  project?: string;
  card?: string;
  session?: string;
  /**
   * "session": the wait reads only what belongs to `session` (its cards and pull requests), plus
   * what has no owner in `project`. Without it, `project` or `card` say what the wait reads.
   */
  scope?: "session";
  since: string;
}

/** Where a pull request stands, as `status` and the panel show it. */
export interface PrView {
  key: string;
  url: string;
  repo: string;
  number: number;
  title: string;
  author?: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** what it waits on now, in a few words: "review", "CI", "merge queue", "changes requested", ... */
  waitingOn: string;
  /** who it waits on: reviewer logins, or the author */
  who?: string[];
  /** since when it has waited on that */
  since: string;
  stalled: boolean;
  /** the PR asks the human (not the author) for a review */
  reviewRequested: boolean;
  /** the human wrote it */
  mine: boolean;
  session?: string;
  sessionTitle?: string;
  project?: string;
  task?: string;
}

/** Who counts as a human when deciding what wakes an agent. */
export const HUMAN = "human";

export type RunState = "working" | "waiting" | "idle" | "done" | "stalled" | "failed" | "unknown";

/** A run observed from an agent log, or declared through `run start`. */
export interface Run {
  id: string;
  runtime: string; // "claude-code" | "codex" | "declared" | ...
  kind: "session" | "subagent" | "exec" | "declared";
  title: string;
  project?: string;
  task?: string;
  role?: string;
  parent?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  lastActivity?: string;
  state: RunState;
  action?: string;
  prompt?: string;
  source?: string;
  error?: string;
  /**
   * The minutes in the last hour with any activity, as minutes before the snapshot (0 is the
   * current minute), ascending. Read from the end of the log, so a very busy run may show less.
   */
  activity?: number[];
  /** how the project was found: an explicit claim, or a guess from the log */
  projectSource?: "claim" | "cwd" | "parent" | "edits" | "prompt";
  /** folders of the files this run edited, most recent last (from its log) */
  touched?: string[];
  /** the last turn ended asking the human something, without a card */
  asks?: { text: string; via: "wrap_up" | "text"; blocked?: boolean; at?: string };
  /** the one-line summary the runtime wrote for the last turn, if it writes one */
  recap?: string;
  /** the session said it is finished (`claim --done`) and has not been asked anything since */
  done?: string;
  /** started by a schedule (`claim --kind scheduled`) */
  scheduled?: boolean;
  /** older runs of the same scheduled task folded into this row */
  repeats?: number;
  /** when the human (or parent) last wrote to this run */
  lastPromptAt?: string;
  /** pull requests this run opened, as seen in its log */
  createdPrs?: string[];
  /** pull requests linked to this run */
  prs?: string[];
}
