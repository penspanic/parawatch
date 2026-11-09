/**
 * Which copies of parawatch use this store. The command line and the desktop app each carry their
 * own copy of the code and are updated apart, so each leaves a note of its version here; the other
 * reads it and says when they differ.
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./store.js";
import { compareVersions } from "./semver.js";

export type ClientName = "cli" | "desktop";

export interface ClientInfo {
  name: ClientName;
  version: string;
  /** when this copy was last seen */
  at: string;
  /** where it is installed */
  path?: string;
  /** the desktop app's process, while it runs */
  pid?: number;
  /** the desktop app's log file */
  log?: string;
}

/** A note older than this is rewritten even when nothing changed, so `at` stays roughly current. */
const REFRESH_MS = 6 * 3_600_000;

function clientPath(name: ClientName): string {
  return path.join(homeDir(), "clients", `${name}.json`);
}

export function readClient(name: ClientName): ClientInfo | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(clientPath(name), "utf8")) as ClientInfo;
    return typeof c.version === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Leave this copy's note. Cheap when nothing changed; never throws. */
export function recordClient(info: Omit<ClientInfo, "at">, now = Date.now()): void {
  try {
    const old = readClient(info.name);
    const same = old && old.version === info.version && old.path === info.path && old.pid === info.pid && old.log === info.log;
    if (same && now - Date.parse(old.at) < REFRESH_MS) return;
    const file = clientPath(info.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...info, at: new Date(now).toISOString() }, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    // a note for other copies; nothing depends on it
  }
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The desktop app's note while it runs. */
export function runningDesktop(): ClientInfo | undefined {
  const d = readClient("desktop");
  return d && processAlive(d.pid) ? d : undefined;
}

export interface Skew {
  cli: string;
  desktop: string;
  /** which copy is older and should be updated */
  older: ClientName;
  text: string;
}

export const CLI_UPDATE = "npm i -g parawatch@latest";

/** When the command line and the app are different versions, which one to update. */
export function versionSkew(cli: string | undefined, desktop: string | undefined): Skew | undefined {
  if (!cli || !desktop) return undefined;
  const c = compareVersions(cli, desktop);
  if (c === 0) return undefined;
  const older: ClientName = c < 0 ? "cli" : "desktop";
  const fix = older === "cli" ? CLI_UPDATE : "update the app (Check for Updates in its menu)";
  return { cli, desktop, older, text: `The desktop app is ${desktop} and the command line is ${cli}: ${fix}.` };
}
