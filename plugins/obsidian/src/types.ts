// Shapes shared with the CLI come straight from its source; the rest is the panel's own.
import type { Card, Project, Run } from "../../../src/core/types.js";

export type { Answer, Card, CardKind, Comment, Project, Run, RunState } from "../../../src/core/types.js";

/** What `parawatch status --json` prints. */
export interface Snapshot {
  v: number;
  generatedAt: string;
  projects: Project[];
  cards: Card[];
  runs: Run[];
}

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
  /** Open a file, app or URL with the system. */
  open(target: string): void;
  /** A URL the panel can put in <img> or <video> for a file outside the vault. */
  mediaUrl(file: string): Promise<string | undefined>;
  /** Save pasted image data and return its path. */
  saveAttachment(data: ArrayBuffer, ext: string): Promise<string>;
  /** Path of a file dropped from Finder, if the platform exposes it. */
  droppedPath(file: File): string | undefined;
}
