/** A Codex conversation as the app shows it. Types only, so the panel can share them. */

export type ChatItem =
  | { kind: "user"; id: string; text: string; images?: number; at?: string }
  | { kind: "agent"; id: string; text: string; commentary?: boolean; at?: string }
  | { kind: "command"; id: string; command: string; output?: string; exit?: number; status?: string; seconds?: number; at?: string }
  | { kind: "files"; id: string; files: { path: string; change: string; diff?: string }[]; at?: string }
  | { kind: "tool"; id: string; name: string; detail?: string; status?: string; at?: string }
  | { kind: "image"; id: string; path: string; at?: string }
  | { kind: "note"; id: string; text: string; tone?: "error" | "info"; at?: string };

/** What the session last ran with; a message sent from here runs with the same. */
export interface ChatSettings {
  cwd?: string;
  model?: string;
  effort?: string;
  /** read-only, workspace-write or danger-full-access */
  sandbox?: string;
  network?: boolean;
  /** folders it may write besides its working folder */
  roots: string[];
  approval?: string;
}

export interface ChatView {
  id: string;
  file: string;
  /** exec, cli, the Codex app ("app"), or what the log says */
  origin?: string;
  title?: string;
  settings: ChatSettings;
  /** a turn has started and not finished */
  working: boolean;
  /** when that unfinished turn started, as the log says */
  turnStarted?: string;
  items: ChatItem[];
  /** older items left out */
  earlier: number;
}

/** What the app shows for one open conversation. */
export interface ChatState {
  view?: ChatView;
  /** why a message cannot be sent now */
  blocked?: string;
  /** a message sent from here is being answered */
  sending: boolean;
  /** what Codex started last while answering it */
  live?: string;
  error?: string;
  /** the machine the session runs on, when it is not this one */
  remote?: string;
  /** nothing to show yet, and why: the other machine has not answered */
  waiting?: string;
}

