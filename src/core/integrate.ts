import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { furthest, inboxFrom, readInbox, readState, sameSession, sessionConsumer } from "./ops.js";
import { homeDir, readCursor, readEvents } from "./store.js";
import { inboxLine } from "./format.js";
import type { Card } from "./types.js";
import { insidePath } from "./paths.js";

export const BEGIN = "<!-- parawatch:begin -->";
export const END = "<!-- parawatch:end -->";

export function instructions(project?: string): string {
  const p = project ?? "<project>";
  return `${BEGIN}
## Parawatch

The human follows this work through \`parawatch\`. Use it instead of asking in chat. If a \`parawatch\` skill is available, follow it.

- As soon as you know what you are working on, say so, even when this folder is not where the code lives: \`parawatch claim --project ${p} --task <ticket, PR or short name> --title "<what you do>"\`. Claim again when you move to other work.
- When you open a pull request: \`parawatch pr link <url>\`. Reviews, CI results and merges on it then wake your wait.
- When the work is finished: \`parawatch claim --done "<one line on how it ended>"\`.

- Need a decision: \`parawatch ask --project ${p} "question" --option "..." --option "..." --recommend N --body "two or three lines"\`
- Need approval for a step you have prepared (a merge, a message, a status change): \`parawatch ask --project ${p} "title" --action "<exact command>" [--preview <file with the text>]\`. \`--action\` is the exact command, one line if possible; steps and reasons go in \`--body\`; \`--preview\` is the file with the text it sends. Change them with \`parawatch edit\` while nobody has answered.
- Need the human to try something (a build, a video, a screen): \`parawatch try --project ${p} "title" --open <app or file> --attach <video or image> --look "what to look at"\`
- Stuck until the human does something only they can do (install, sudo, sign in): \`parawatch block --project ${p} "what to do"\`
- Something only the human can do, but nothing waits on it now: \`parawatch todo --project ${p} "what to do"\`
- Put every question for the human on a card, not only in your reply: a question left in chat is easy to miss.
- After opening a card or linking a pull request, keep a background wait armed: \`parawatch wait\`. It prints the human's answers to your cards and news on your pull requests and exits; act on them, \`parawatch close <card> --note "what you did"\`, then arm it again. A lead watching the whole project waits with \`parawatch wait --project ${p}\`.
- A long job with no agent log (a bake, a benchmark): \`parawatch run start --project ${p} "title" --heartbeat <seconds> [--log <file>]\`, \`parawatch run note <id> "..."\`, \`parawatch run end <id>\`.
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

/** Take the parawatch block out of an instruction file. Returns true when the file changed. */
export function removeInstructions(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return false;
  const before = text.slice(0, a).replace(/\n+$/, "");
  const after = text.slice(b + END.length).replace(/^\n+/, "");
  const next = before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
  fs.writeFileSync(file, next);
  return true;
}

/** Whether a file has the parawatch block, and whether it is the one this version writes. */
export function instructionState(file: string): "current" | "outdated" | "absent" {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "absent";
  }
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return "absent";
  const block = text.slice(a, b + END.length);
  const project = /--project (\S+)/.exec(block)?.[1];
  return block === instructions(project === "<project>" ? undefined : project) ? "current" : "outdated";
}

/**
 * Claude Code hook: given the hook's JSON on stdin, return text to add to the turn
 * when the human has answered something for this session's project. Peeks only;
 * the agent's own `wait` still advances its cursor.
 */
export function hookContext(input: { session_id?: string; cwd?: string }, project?: string): string | undefined {
  const events = readEvents();
  const state = readState(events);
  const session = input.session_id;
  let name = project;
  if (!name && session) name = state.claims.find((c) => sameSession(session, c.session))?.project;
  if (!name && input.cwd) {
    for (const p of state.projects.values()) if (p.paths.some((x) => insidePath(input.cwd!, x))) name = p.name;
  }
  if (!name && !session) return undefined;
  // A session reads its own news with its own cursor; one still waiting on its project moves the
  // project's cursor instead, so whichever is further says what it has handled.
  const items = session
    ? inboxFrom(events, furthest(readCursor(sessionConsumer(session)), name ? readCursor(name) : {}), { session, project: name }, state)
    : inboxFrom(events, readCursor(name!), { project: name }, state);
  if (!items.length) return undefined;
  const cards = items.filter((i) => i.kind !== "pr").length;
  const prs = items.length - cards;
  const what = [cards ? `${cards} answer(s) on cards` : "", prs ? `${prs} pull request update(s)` : ""].filter(Boolean).join(" and ");
  return [`Parawatch: ${what}${name ? ` for ${name}` : ""} that you have not handled yet.`, ...items.map(inboxLine), cards ? `Act on them, then \`parawatch close <card>\`.` : `Act on them.`].join("\n");
}

/** Best-effort desktop notification. Never throws, never blocks. */
/** The desktop app writes its pid here while it runs, so the CLI leaves notifications to it. */
export function desktopPidPath(): string {
  return path.join(homeDir(), "desktop.pid");
}

function desktopAppRunning(): boolean {
  try {
    const pid = Number(fs.readFileSync(desktopPidPath(), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function notify(card: Card): void {
  if (process.env.PARAWATCH_NOTIFY === "0") return;
  if (card.kind === "todo") return; // a to-do waits in the panel
  if (desktopAppRunning()) return; // the app notifies, with its own badge
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
