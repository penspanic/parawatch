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

/**
 * Words every block written from now on carries. A block with them points to the installed version
 * for how to use parawatch, so it stays right across releases and is never reported as older.
 */
const POINTS_TO_GUIDE = "not from this file";

/**
 * The block for a project's instruction file. It holds only what belongs to the project and does
 * not change with a release: the project's name, that the human answers on cards, and where the
 * commands are explained. The commands themselves come from the installed version (the skill,
 * `parawatch guide`, `--help`), so a release never leaves this block behind.
 */
export function instructions(project?: string): string {
  const p = project ?? "<project>";
  return `${BEGIN}
## Parawatch

This repository is the parawatch project \`${p}\`. The human follows this work through \`parawatch\` and answers there, not in chat.

- Before your first parawatch command in a session, run \`parawatch guide\` or follow the \`parawatch\` skill. Both match the installed version: take commands and flags from there, ${POINTS_TO_GUIDE}.
- Claims and cards take \`--project ${p}\`.
- Anything you need from the human goes on a card, never only in your reply. Never answer a card yourself.
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

/** The parawatch block in a file, and the project it names, if any. */
function readBlock(file: string): { block: string; project?: string } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return undefined;
  const block = text.slice(a, b + END.length);
  const project = /--project (\S+)/.exec(block)?.[1];
  return { block, project: project === "<project>" ? undefined : project };
}

/**
 * Whether a file has the parawatch block, and whether it is an older one that still spells out
 * commands (written before 0.3.32) and so falls behind each release.
 */
export function instructionState(file: string): "current" | "outdated" | "absent" {
  const found = readBlock(file);
  if (!found) return "absent";
  return found.block.includes(POINTS_TO_GUIDE) ? "current" : "outdated";
}

/** The `init` command that rewrites a file's block for this version, keeping the project it names. */
export function initCommand(file: string): string {
  const project = readBlock(file)?.project;
  return `parawatch init -f ${path.basename(file)}${project ? ` -p ${project}` : ""}`;
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
