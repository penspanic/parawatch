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
  /** the human closed it without answering ("dismissed"); the agent that asked is told */
  dismissed?: boolean;
  /** an approval: the exact command or step that runs if the human says yes */
  action?: string;
  /** text the action would send or change (a message, a diff), shown with the card */
  preview?: string;
  /** where the preview text came from, as stored (absolute); the text above is the snapshot the human sees */
  previewFile?: string;
  /** when the action or preview was last changed by `edit` (filled from the event time) */
  changedAt?: string;
  /**
   * In a snapshot: the session that opened the card has ended (claimed done, or archived), so an
   * answer goes to whoever waits on the project. Never stored.
   */
  ownerEnded?: boolean;
  /**
   * In a snapshot, for a card whose session has ended or that no session opened: the project's
   * lead, which gets the answer. Never stored.
   */
  lead?: string;
  /**
   * In a snapshot: no session gets an answer to this card (no owner, and the project has no live
   * lead), so it waits in parawatch until the human picks a lead or hands it on. Never stored.
   */
  unrouted?: boolean;
  /** when the human handed the card to another session (filled from the event time) */
  handedAt?: string;
  /**
   * In a snapshot: attached or to-open files that are not on this machine (yet: a sync tool or a
   * cloud drive may still be bringing them). Never stored.
   */
  missing?: string[];
  /**
   * In a snapshot: those of `missing` that stay on the machine that opened the card, being outside
   * the folders kept in step (the shared folder and named roots). Never stored.
   */
  away?: string[];
}

/** Fields `parawatch edit` may change on a card. */
export type CardEdit = Partial<Pick<Card, "kind" | "title" | "body" | "task" | "from" | "session" | "since">>;

/** What `edit` may change on a card nobody has answered yet: the approval text and the attachments. */
export interface CardEditInput extends CardEdit {
  action?: string;
  /** a file; its text replaces the preview and its path is kept */
  preview?: string;
  /** the whole list of attachments; an empty list clears it */
  attach?: string[];
}

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
  /** linked because the session's log shows it opened the PR, not by `parawatch pr link` */
  auto?: boolean;
  /** the human handed it to this session; the session is told once */
  handed?: boolean;
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

/** An issue on GitHub; the key is `host/owner/repo#12`, like a pull request's. */
export interface IssueRef {
  key: string;
  host: string;
  repo: string;
  number: number;
  url: string;
}

/** What happened on an issue assigned to the human: it was assigned, or someone else commented. */
export type IssueChange = "assigned" | "commented";

/** A GitHub Actions run that waits for the human to approve a deployment, as read from GitHub. */
export interface DeployRef {
  /** `host/owner/repo/actions/runs/<id>` */
  key: string;
  host: string;
  repo: string;
  run: number;
  url: string;
  /** the workflow's name ("Deploy") */
  workflow: string;
  /** the run's title: the commit message or what started it */
  title: string;
  /** the environments it waits on that the human can approve */
  environments: { id: number; name: string }[];
  /** who started the run */
  startedBy?: string;
  /** the registered project whose repository this is */
  project?: string;
}

/**
 * What became of a deployment waiting for approval: approved or rejected (by whom), left waiting
 * another way (`ended`: cancelled, or approved for an environment the human cannot see), and how
 * an approved run ended.
 */
export type DeployChange = "waiting" | "approved" | "rejected" | "ended" | "succeeded" | "failed";

/**
 * A GitHub notification someone else caused: a mention, a review request, an assignment, a comment
 * by another person. What the human's own account did (which includes everything its agents did)
 * is left out. The key is `host:thread id`.
 */
export interface InboxThread {
  key: string;
  host: string;
  /** GitHub's thread id, for marking it read */
  id: string;
  repo: string;
  kind: "pr" | "issue" | "discussion" | "release" | "commit" | "other";
  /** the pull request or issue number, when it is one */
  number?: number;
  /** `host/owner/repo#12`, the key a pull request or issue has elsewhere in parawatch */
  item?: string;
  title: string;
  /** GitHub's reason: mention, review_requested, assign, comment, author, state_change, ... */
  reason: string;
  /** who wrote last, when GitHub says */
  by?: string;
  url: string;
  /** when GitHub last updated the thread */
  at: string;
  /** the registered project whose repository it is in */
  project?: string;
}

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
  /** `dismissed`: the human closed it without an answer, and the agent that asked is told */
  | { type: "card.close"; card: string; note?: string; dismissed?: boolean }
  /** the human gave the card to another session, which is told once */
  | { type: "card.hand"; card: string; session: string; by: string }
  | { type: "card.edit"; card: string; set: CardEdit & Pick<Card, "action" | "preview" | "previewFile" | "attach"> }
  | { type: "run.start"; run: { id: string; project: string; task?: string; title: string; parent?: string; heartbeat?: number; log?: string } }
  | { type: "run.note"; run: string; text: string }
  | { type: "run.beat"; run: string }
  | { type: "run.end"; run: string; status: "done" | "failed"; note?: string }
  | { type: "run.claim"; claim: Claim }
  /** the human hid a run from the list; it comes back when it does something new */
  | { type: "run.hide"; run: string }
  | { type: "run.unhide"; run: string }
  | { type: "pr.link"; link: Omit<PrLink, "at"> }
  | { type: "pr.unlink"; pr: string }
  /** something happened on a pull request: read from GitHub, or reported by another tool */
  /** `late`: found by a reading long after the previous one, so it may be old news; it is not notified */
  | { type: "pr.change"; pr: PrRef; change: PrChange; title?: string; by?: string; text?: string; source: "github" | "external"; late?: boolean }
  /** news on an issue assigned to the human, read from GitHub; it wakes no agent */
  | { type: "issue.change"; issue: IssueRef; change: IssueChange; title?: string; by?: string; source: "github"; late?: boolean }
  /** a GitHub notification from another person came in, or got news; it wakes no agent */
  | { type: "inbox.new"; thread: Omit<InboxThread, "project">; late?: boolean }
  /** the human marked it read, here or on GitHub; it comes back when it gets news */
  | { type: "inbox.read"; thread: string }
  /** a deployment waits for the human's approval, or what became of one; read from GitHub, it wakes no agent */
  | { type: "deploy.change"; deploy: DeployRef; change: DeployChange; by?: string; source: "github"; late?: boolean }
  /**
   * The human decided on a waiting deployment somewhere that cannot reach GitHub itself (the
   * phone): `to` is the machine that reported it, which carries it out.
   */
  | { type: "deploy.ask"; deploy: string; decision: "approved" | "rejected"; to: string }
  /** carrying out a decision failed; the deployment still waits */
  | { type: "deploy.fail"; deploy: string; error: string }
  /** the human set an issue aside: it folds away until someone else comments on it */
  | { type: "issue.aside"; issue: string }
  | { type: "issue.back"; issue: string }
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
  /** open issues assigned to the human; absent when GitHub is not set up */
  issues?: IssueView[];
  /** unread GitHub notifications from other people; absent when GitHub is not set up */
  inbox?: InboxThread[];
  /** deployments waiting for the human to approve them */
  deploys?: DeployView[];
  /** what happened on pull requests and issues in the last day, newest first */
  news?: NewsItem[];
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
  /** the last attempt failed entirely, after the last good reading: pull request news has stopped */
  failing?: boolean;
  /** which process failed, e.g. "the desktop app" */
  failedBy?: string;
  failedAt?: string;
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
  /**
   * Who holds the wait when the session does not: "codex-app" is the Parawatch app, which passes
   * what arrives to a thread loaded in the Codex app (see core/codexWake.ts).
   */
  via?: string;
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
  /** open, and its session has ended or it has none: the project's lead gets its news */
  lead?: string;
  /** open, its session has ended or it has none, and the project has no live lead: no one gets its news */
  unrouted?: boolean;
}

/** A deployment waiting for the human, as `status` and the panels show it. */
export interface DeployView {
  key: string;
  url: string;
  repo: string;
  run: number;
  workflow: string;
  title: string;
  environments: string[];
  startedBy?: string;
  /** waiting since */
  since: string;
  project?: string;
  /** the machine that read it from GitHub, which carries out a decision made on the phone */
  device?: string;
  /** a decision sent to that machine and not carried out yet */
  asking?: { decision: "approved" | "rejected"; to: string; at: string };
  /** why the last decision could not be carried out */
  error?: string;
}

/** One thing that happened on a pull request, an issue or a deployment, for the recent news list. */
export interface NewsItem {
  at: string;
  kind: "pr" | "issue" | "deploy";
  /** what to call it when not `repo#number` (a deployment: `repo production`) */
  label?: string;
  /** `host/owner/repo#12` */
  key: string;
  url: string;
  repo: string;
  number: number;
  title?: string;
  change: PrChange | IssueChange | DeployChange;
  by?: string;
  text?: string;
  session?: string;
  sessionTitle?: string;
  project?: string;
}

/** An open issue assigned to the human, as `status` and the panel show it. */
export interface IssueView {
  key: string;
  url: string;
  repo: string;
  number: number;
  title: string;
  author?: string;
  /** who assigned it to the human, and when */
  assignedBy?: string;
  assignedAt?: string;
  /** the latest comment by someone other than the human */
  lastOther?: { by: string; at: string };
  /** the registered project whose repository it is in */
  project?: string;
  /** the human set it aside, and nobody else has commented since */
  aside: boolean;
}

/** Who counts as a human when deciding what wakes an agent. */
export const HUMAN = "human";

export type RunState = "working" | "waiting" | "idle" | "done" | "stalled" | "failed" | "unknown";

/** A run observed from an agent log, or declared through `run start`. */
export interface Run {
  id: string;
  runtime: string; // "claude-code" | "codex" | "declared" | ...
  kind: "session" | "subagent" | "exec" | "declared";
  /** what to call it: the title its claim gives, else its own name, else its first prompt */
  title: string;
  /**
   * The session's own name, as the Claude app or its log names it ("Spill Director"), when a claim
   * gives it another title. Older machines leave it out.
   */
  name?: string;
  /** the title of the work it claimed ("Fix the camera"), which may change with each task */
  work?: string;
  project?: string;
  task?: string;
  role?: string;
  parent?: string;
  cwd?: string;
  /** the model it runs on, as its runtime names it (`claude-opus-5-5`, `gpt-6.1-sol`) */
  model?: string;
  /** its reasoning effort (`high`, `xhigh`) */
  effort?: string;
  /** what else it runs with, in a few words each: `fast`, `bypasses permissions`, `full access`, `never asks` */
  options?: string[];
  startedAt?: string;
  lastActivity?: string;
  state: RunState;
  action?: string;
  prompt?: string;
  source?: string;
  error?: string;
  /**
   * The minutes in the last day with any activity, as minutes before the snapshot (0 is the
   * current minute), ascending. Read from the end of the log, so a very busy run may show less.
   */
  activity?: number[];
  /** how the project was found: an explicit claim, or a guess from the log */
  projectSource?: "claim" | "cwd" | "parent" | "edits" | "prompt";
  /** folders of the files this run edited, most recent last (from its log) */
  touched?: string[];
  /** the last turn ended asking the human something, without a card */
  asks?: { text: string; via: "wrap_up" | "text" | "permission"; blocked?: boolean; at?: string };
  /** the log ends on a tool call that has not returned (a long command, or a permission prompt) */
  pendingTool?: boolean;
  /** the one-line summary the runtime wrote for the last turn, if it writes one */
  recap?: string;
  /** the session said it is finished (`claim --done`) and has not been asked anything since */
  done?: string;
  /** started by a schedule (`claim --kind scheduled`) */
  scheduled?: boolean;
  /** older runs of the same scheduled task folded into this row */
  repeats?: number;
  /** its Remote Control link (claude.ai), which opens from any machine; read where the session runs */
  remote?: string;
  /** when the human (or parent) last wrote to this run */
  lastPromptAt?: string;
  /** pull requests this run opened, as seen in its log */
  createdPrs?: string[];
  /** pull requests linked to this run */
  prs?: string[];
  /** the machine the run is on, when it is another one (shared folders only) */
  device?: string;
}
