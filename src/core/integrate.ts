import { spawn } from "node:child_process";
import fs from "node:fs";
import { readInbox, inboxFrom } from "./ops.js";
import { readCursor, readEvents } from "./store.js";
import { fold } from "./state.js";
import { inboxLine } from "./format.js";
import type { Card } from "./types.js";

export const BEGIN = "<!-- parawatch:begin -->";
export const END = "<!-- parawatch:end -->";

export function instructions(project?: string): string {
  const p = project ?? "<project>";
  return `${BEGIN}
## Parawatch

The human follows this work through \`parawatch\`. Use it instead of asking in chat. If a \`parawatch\` skill is available, follow it.

- At the start of a session: \`parawatch claim --project ${p}\` (add \`--role lead\` if you lead this project).

- Need a decision: \`parawatch ask --project ${p} "question" --option "..." --option "..." --recommend N --body "two or three lines"\`
- Need the human to try something (a build, a video, a screen): \`parawatch try --project ${p} "title" --open <app or file> --attach <video or image> --look "what to look at"\`
- Stuck until the human does something only they can do (install, sudo, sign in): \`parawatch block --project ${p} "what to do"\`
- Something only the human can do, but nothing waits on it now: \`parawatch todo --project ${p} "what to do"\`
- After opening a card, keep a background wait armed: \`parawatch wait --project ${p}\`. It prints the human's answers and exits; act on them, \`parawatch close <card> --note "what you did"\`, then arm it again.
- A long job with no agent log (a bake, a benchmark): \`parawatch run start --project ${p} "title"\`, \`parawatch run note <id> "..."\`, \`parawatch run end <id>\`.
- Never answer a card yourself. \`parawatch status\` shows everything that is open.
${END}`;
}

/** Insert or replace the parawatch block in an instruction file. Returns true when the file changed. */
export function writeInstructions(file: string, project?: string): boolean {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const block = instructions(project);
  let next: string;
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a >= 0 && b > a) next = text.slice(0, a) + block + text.slice(b + END.length);
  else next = text + (text && !text.endsWith("\n") ? "\n" : "") + (text ? "\n" : "") + block + "\n";
  if (next === text) return false;
  fs.writeFileSync(file, next);
  return true;
}

/**
 * Claude Code hook: given the hook's JSON on stdin, return text to add to the turn
 * when the human has answered something for this session's project. Peeks only;
 * the agent's own `wait` still advances its cursor.
 */
export function hookContext(input: { session_id?: string; cwd?: string }, project?: string): string | undefined {
  const events = readEvents();
  const state = fold(events);
  let name = project;
  if (!name && input.session_id) name = state.claims.find((c) => input.session_id!.startsWith(c.session))?.project;
  if (!name && input.cwd) {
    for (const p of state.projects.values()) if (p.paths.some((x) => input.cwd === x || input.cwd!.startsWith(x + "/"))) name = p.name;
  }
  if (!name) return undefined;
  const items = inboxFrom(events, readCursor(name), { project: name });
  if (!items.length) return undefined;
  return [`Parawatch: the human answered ${items.length} card(s) for ${name} that you have not handled yet.`, ...items.map(inboxLine), `Act on them, then \`parawatch close <card>\`.`].join("\n");
}

/** Best-effort desktop notification. Never throws, never blocks. */
export function notify(card: Card): void {
  if (process.env.PARAWATCH_NOTIFY === "0") return;
  const title = `parawatch · ${card.project}`;
  const body = `${card.kind === "decide" ? "Decide" : card.kind === "try" ? "Try" : "Blocked"}: ${card.title}`;
  try {
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      spawn("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } else if (process.platform === "linux") {
      spawn("notify-send", [title, body], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    }
  } catch {
    // no notifier available
  }
}

export { readInbox };
