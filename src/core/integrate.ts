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

The human follows this work through \`parawatch\` and answers there, not in chat. Follow the \`parawatch\` skill if you have one; \`parawatch guide\` prints the same for the installed version.

- When you know what you work on: \`parawatch claim --project ${p} --task <ticket, PR or short name> --title "<what you do>"\`. When you open a pull request: \`parawatch pr link <url>\`. When the work is finished: \`parawatch claim --done "<one line on how it ended>"\`. A worker a lead started needs nothing more.
- Anything you need from the human goes on a card, never only in your reply: \`parawatch ask\`, \`try\`, \`block\` or \`todo\` with \`--project ${p}\` (examples in \`parawatch ask --help\`). Caption each picture: \`--attach "Now=/abs/now.png"\`.
- After opening a card or linking a pull request, keep one background \`parawatch wait\` armed. Act on what it prints, \`parawatch close <card> --note "what you did"\`, and arm it again.
- A long job with no agent log (CI, a bake, a benchmark): \`parawatch run watch "title" --project ${p} -- <command>\`.
- Never answer a card yourself.
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
