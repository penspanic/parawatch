/**
 * The app's log: one plain file in the system's log folder (on macOS ~/Library/Logs/Parawatch),
 * kept small by rolling it over to main.old.log. Errors that the app survives land here, so a bug
 * report has something to attach.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const MAX_BYTES = 1024 * 1024;

export type Level = "info" | "warn" | "error";

let file: string | undefined;

export function logPath(): string {
  if (!file) {
    let dir: string;
    try {
      dir = app.getPath("logs");
    } catch {
      dir = path.join(app.getPath("userData"), "logs");
    }
    file = path.join(dir, "main.log");
  }
  return file;
}

function text(x: unknown): string {
  if (x instanceof Error) return x.stack ?? `${x.name}: ${x.message}`;
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export function log(level: Level, ...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${parts.map(text).join(" ")}\n`;
  if (!app.isPackaged) (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line.trimEnd());
  try {
    const f = logPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f.replace(/\.log$/, ".old.log"));
    } catch {
      // no file yet
    }
    fs.appendFileSync(f, line);
  } catch {
    // nowhere to write; the app goes on
  }
}

export const logger = {
  info: (...p: unknown[]) => log("info", ...p),
  warn: (...p: unknown[]) => log("warn", ...p),
  error: (...p: unknown[]) => log("error", ...p),
  debug: () => {},
};
