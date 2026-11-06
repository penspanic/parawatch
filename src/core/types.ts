export const SCHEMA_VERSION = 1;

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
  status: CardStatus;
  answers: Answer[];
  comments: Comment[];
  closedAt?: string;
  closeNote?: string;
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
}

/** Fields shared by every event line. */
interface EventBase {
  v: number;
  seq: number;
  ts: string;
}

export type EventBody =
  | { type: "project.add"; project: Project }
  | { type: "project.remove"; name: string }
  | { type: "card.open"; card: Omit<Card, "status" | "answers" | "comments" | "openedAt"> }
  | { type: "card.answer"; card: string; by: string; choice?: number; comment?: string; attach?: string[] }
  | { type: "card.comment"; card: string; by: string; text: string }
  | { type: "card.close"; card: string; note?: string }
  | { type: "card.edit"; card: string; set: CardEdit }
  | { type: "run.start"; run: { id: string; project: string; task?: string; title: string; parent?: string } }
  | { type: "run.note"; run: string; text: string }
  | { type: "run.end"; run: string; status: "done" | "failed"; note?: string }
  | { type: "run.claim"; claim: Claim };

export type PwEvent = EventBase & EventBody;

/** What `parawatch status --json` prints and what the panels render. */
export interface Snapshot {
  v: number;
  generatedAt: string;
  projects: Project[];
  cards: Card[];
  runs: Run[];
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
}
