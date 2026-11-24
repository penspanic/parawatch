/**
 * Keeps the command line in step with the app. The command line leaves a note of its version and
 * where it is installed (src/core/clients.ts). When that place is an npm global install
 * (`<prefix>/lib/node_modules/parawatch`), the npm beside it can update it: the app runs
 * `<prefix>/bin/npm install -g --prefix <prefix> parawatch@<the app's version>` with that prefix's node first on the
 * PATH, so the same Node install that holds the command line updates it. On Windows the prefix
 * holds no npm of its own, so the npm beside node is used, with the same --prefix (see findNpm).
 * Installs made some other way (a linked checkout, a package manager without that layout) are left
 * alone and named. When the app cannot update an older command line, it says so once per version:
 * in its log and in a notification with the command to run.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readClient } from "../../../src/core/clients.js";
import { compareVersions } from "../../../src/core/semver.js";
import { logger } from "./logger.js";
import type { CliState } from "./prefs.js";
import { findNpm, forCmd, npmFailure, npmPrefix } from "./npmPath.js";

const INSTALL_TIMEOUT_MS = 180_000;
/** npm can take a few minutes to list a version the app's feed already has */
const RETRY_MS = 10 * 60_000;

let state: CliState = { status: "idle" };
let listener: () => void = () => {};
let retry: NodeJS.Timeout | undefined;

function set(next: CliState): void {
  state = next;
  listener();
}

/** Where the command line stands against the app at `appVersion`, and whether the app can update it. */
export function cliState(appVersion: string): CliState {
  const cli = readClient("cli");
  if (state.status === "updating" || state.status === "error") return { ...state, ...(cli ? { version: cli.version } : {}) };
  if (!cli) return { status: "missing" };
  const prefix = npmPrefix(cli.path);
  const npm = prefix ? findNpm(prefix, process.platform, (f) => fs.existsSync(f)) : undefined;
  const behind = compareVersions(cli.version, appVersion) < 0;
  return {
    status: behind ? "behind" : "current",
    version: cli.version,
    path: cli.path,
    ...(npm ? { npm } : {}),
  };
}

export function onCliChange(fn: () => void): void {
  listener = fn;
}

let warn: (title: string, body: string) => void = () => {};
const warned = new Set<string>();

/** Where the app tells the human that it could not update the command line (a notification). */
export function onCliStuck(fn: (title: string, body: string) => void): void {
  warn = fn;
}

/** Says once per app version that the command line stays behind, and how to update it by hand. */
function stuck(appVersion: string, why: string): void {
  logger.warn(`command line not updated to ${appVersion}: ${why}`);
  if (warned.has(appVersion)) return;
  warned.add(appVersion);
  warn("Parawatch could not update the command line", `Agents keep using the older one. In a terminal: npm install -g parawatch@${appVersion}`);
}

/**
 * Install the app's version of the command line with the npm that installed it. Resolves once npm
 * is done. Safe to call again while it runs.
 */
export async function updateCli(appVersion: string, why: string): Promise<CliState> {
  if (state.status === "updating") return state;
  // a failed try is not a reason to refuse the next one
  state = { status: "idle" };
  const now = cliState(appVersion);
  if (now.status !== "behind") return now;
  if (!now.npm) {
    stuck(appVersion, `the command line at ${now.path ?? "an unknown place"} is ${now.version} and no npm was found to update it`);
    return now;
  }
  const npm = now.npm;
  const prefix = npmPrefix(now.path)!;
  const bin = path.dirname(npm);
  set({ status: "updating", version: now.version, target: appVersion, npm, path: now.path });
  logger.info(`updating the command line from ${now.version} to ${appVersion} (${why}) with ${npm}`);
  const result = await new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(
      // through cmd.exe on Windows: npm there lives under "Program Files", which needs quotes
      forCmd(npm),
      // --prefix: into the install the command line runs from, whatever this npm would pick on its own
      ["install", "-g", "--prefix", forCmd(prefix), `parawatch@${appVersion}`, "--prefer-online", "--no-fund", "--no-audit"],
      {
        timeout: INSTALL_TIMEOUT_MS,
        // the GUI's PATH lacks the install's node; npm's own shebang looks for it there
        env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) },
        shell: process.platform === "win32",
        windowsHide: true,
      },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}\n${stderr}`.trim() }),
    );
  });
  if (result.ok) {
    logger.info(`command line updated to ${appVersion}`);
    // any run of the command line rewrites its note, so the settings read the new version at once
    // the command's shim lives in the prefix, which on Windows is not where npm came from
    const shim = process.platform === "win32" ? path.join(prefix, "parawatch.cmd") : path.join(prefix, "bin", "parawatch");
    await new Promise((resolve) => execFile(forCmd(shim), ["--version"], { env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(path.delimiter) }, timeout: 20_000, shell: process.platform === "win32", windowsHide: true }, resolve));
    set({ status: "idle" });
    return cliState(appVersion);
  }
  logger.warn(`command line update failed: ${result.out}`);
  const { notYet, reason: last } = npmFailure(result.out);
  if (!notYet) stuck(appVersion, `npm could not update the command line: ${last.slice(0, 160)}`);
  set({ status: "error", version: now.version, target: appVersion, npm, path: now.path, error: notYet ? `${appVersion} is not on npm yet; trying again in a few minutes` : last.slice(0, 200) });
  if (notYet) {
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => {
      state = { status: "idle" };
      void updateCli(appVersion, "retry");
    }, RETRY_MS);
  }
  return state;
}
