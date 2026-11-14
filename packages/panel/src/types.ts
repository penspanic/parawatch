// Shapes shared with the CLI come straight from its source; the rest is the panel's own.
import type { Card, Snapshot } from "../../../src/core/types.js";
import type { ChatState } from "../../../src/core/chatTypes.js";

export type { ChatItem, ChatSettings, ChatState, ChatView } from "../../../src/core/chatTypes.js";
export type { Answer, Card, CardKind, Comment, Listener, PrView, Project, Run, RunState, Snapshot } from "../../../src/core/types.js";

/** One line of `parawatch watch`. */
export interface PwEvent {
  v: number;
  seq: number;
  ts: string;
  type: string;
  card?: Card | string;
  [k: string]: unknown;
}

export interface Reply {
  choice?: number;
  comment?: string;
  attach?: string[];
}

/** Everything the panel needs from the outside world. The plugin uses the CLI; the harness fakes it. */
export interface Backend {
  snapshot(): Promise<Snapshot>;
  answer(card: string, reply: Reply): Promise<void>;
  /** Open the agent session behind a card (or a session id); resolves to what happened. */
  goto(target: string): Promise<string>;
  /** Close a card without answering it; the agent that asked is told. */
  dismiss(card: string): Promise<void>;
  /** Make a session the project's lead: it is handed what no session got, and gets such things from then on. */
  lead?(project: string, session: string): Promise<void>;
  /** Hide a run until it does something new. */
  hideRun(id: string): Promise<void>;
  /** Open a file, app or URL with the system. */
  open(target: string): void;
  /** A URL the panel can put in <img> or <video> for a file outside the vault. */
  mediaUrl(file: string): Promise<string | undefined>;
  /** Save pasted image data and return its path. */
  saveAttachment(data: ArrayBuffer, ext: string): Promise<string>;
  /** Path of a file dropped from Finder, if the platform exposes it. */
  droppedPath(file: File): string | undefined;
  /** The system's menu for a file, app or URL the card carries (open, show in Finder, copy path). */
  targetMenu?(target: string): void;
  /** The site's own icon (its favicon) as a URL the panel can put in <img>, if the host fetches them. */
  siteIcon?(site: string): Promise<string | undefined>;
  /** Codex conversations: read one and send it messages. Hosts that cannot run codex leave it out. */
  chat?: ChatBackend;
}

export interface ChatBackend {
  /** Start watching a Codex run's log; resolves to the conversation as it is now. */
  open(run: string): Promise<ChatState>;
  close(run: string): void;
  /** Send a message to the session; what Codex does arrives through onUpdate. */
  send(run: string, text: string): Promise<void>;
  /** Interrupt the message being answered. */
  stop(run: string): Promise<void>;
  onUpdate(fn: (run: string, state: ChatState) => void): () => void;
}
