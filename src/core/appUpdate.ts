/**
 * `parawatch app update`: an agent asks the desktop app running on this machine to update itself,
 * so nobody has to press Restart to Update. The command line leaves a request file in the store;
 * the app looks for it every few seconds, checks for a new version, downloads it and restarts into
 * it, and writes how far it got to a status file the command line follows. The command ends when
 * the new version is running, when there is nothing newer, or with the reason it could not.
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./store.js";

export type AppUpdateStep = "asked" | "checking" | "downloading" | "restarting" | "latest" | "off" | "error";

export interface AppUpdateStatus {
  /** the request this answers */
  id: string;
  step: AppUpdateStep;
  /** the version being installed, or the newest one when the app already runs it */
  version?: string;
  percent?: number;
  error?: string;
  at: string;
}

function dir(): string {
  return path.join(homeDir(), "desktop");
}

export function appUpdateRequestPath(): string {
  return path.join(dir(), "update-request.json");
}

export function appUpdateStatusPath(): string {
  return path.join(dir(), "update-status.json");
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Leave a request for the running app. Returns its id. */
export function requestAppUpdate(now = Date.now()): string {
  const id = `${now.toString(36)}-${process.pid}`;
  writeJson(appUpdateRequestPath(), { id, at: new Date(now).toISOString() });
  return id;
}

export function readAppUpdateRequest(): { id: string; at: string } | undefined {
  const r = readJson<{ id: string; at: string }>(appUpdateRequestPath());
  return r && typeof r.id === "string" ? r : undefined;
}

export function writeAppUpdateStatus(status: Omit<AppUpdateStatus, "at">, now = Date.now()): void {
  writeJson(appUpdateStatusPath(), { ...status, at: new Date(now).toISOString() });
}

export function readAppUpdateStatus(): AppUpdateStatus | undefined {
  const s = readJson<AppUpdateStatus>(appUpdateStatusPath());
  return s && typeof s.id === "string" && typeof s.step === "string" ? s : undefined;
}

export interface AppUpdateWait {
  id: string;
  /** the app's version when the request was made */
  from: string;
  /** what the app said about this request so far */
  status: () => AppUpdateStatus | undefined;
  /** the running app's version, or undefined while none runs */
  running: () => string | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  /** a step changed: for progress lines */
  onStep?: (s: AppUpdateStatus) => void;
}

export interface AppUpdateResult {
  ok: boolean;
  /** what to tell the agent */
  text: string;
  version?: string;
}

/** How long the app may take to notice the request before the command says it did not. */
const NOTICE_MS = 30_000;

/**
 * Follow a request until the app runs the new version, says there is nothing newer, or fails.
 * After `restarting` the app is gone for about half a minute; the new one is recognised by its
 * version in the note it leaves on start.
 */
export async function waitForAppUpdate(w: AppUpdateWait): Promise<AppUpdateResult> {
  const start = w.now();
  let last: AppUpdateStep | undefined;
  for (;;) {
    const s = w.status();
    const mine = s && s.id === w.id ? s : undefined;
    if (mine && (mine.step !== last || mine.step === "downloading")) {
      if (mine.step !== last) w.onStep?.(mine);
      last = mine.step;
    }
    if (mine?.step === "latest") return { ok: true, version: w.from, text: `Parawatch ${w.from} is the newest version.` };
    if (mine?.step === "off") return { ok: false, text: `The app cannot update itself: ${mine.error ?? "updates are off in this build"}.` };
    if (mine?.step === "error") return { ok: false, text: `The app could not update: ${mine.error ?? "unknown error"}.` };
    // the new app is recognised by its version; a newer release than the one announced may win
    const now = w.running();
    if (last === "restarting" && now && now !== w.from) return { ok: true, version: now, text: `Parawatch ${now} is running. It brings the command line to ${now} within a minute or two.` };
    const waited = w.now() - start;
    if (!mine && waited > NOTICE_MS) {
      return { ok: false, text: "The app did not pick up the request. It may be older than 0.3.33, which does not know this command: update it once from its menu (Check for Updates)." };
    }
    if (waited > w.timeoutMs) {
      return { ok: false, text: last ? `Gave up after ${Math.round(waited / 1000)}s; the app was at "${last}". It goes on by itself; run this again to follow it.` : `Gave up after ${Math.round(waited / 1000)}s.` };
    }
    await w.sleep(1000);
  }
}
