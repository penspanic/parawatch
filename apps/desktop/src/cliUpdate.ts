/**
 * Keeps the command line in step with the app. The command line leaves a note of its version and
 * where it is installed (src/core/clients.ts). When that place is an npm global install
 * (`<prefix>/lib/node_modules/parawatch`), the npm beside it can update it: the app runs
 * `<prefix>/bin/npm install -g --prefix <prefix> parawatch@<the app's version>` with that prefix's node first on the
 * PATH, so the same Node install that holds the command line updates it. Installs made some other
 * way (a linked checkout, a package manager without that layout) are left alone and named.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readClient } from "../../../src/core/clients.js";
import { compareVersions } from "../../../src/core/semver.js";
import { logger } from "./logger.js";
import type { CliState } from "./prefs.js";
import { npmBin, npmPrefix } from "./npmPath.js";

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
  const managed = !!prefix && fs.existsSync(npmBin(prefix));
  const behind = compareVersions(cli.version, appVersion) < 0;
  return {
    status: behind ? "behind" : "current",
    version: cli.version,
    path: cli.path,
    ...(managed ? { npm: npmBin(prefix!) } : {}),
  };
}

export function onCliChange(fn: () => void): void {
  listener = fn;
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
  if (now.status !== "behind" || !now.npm) return now;
  const npm = now.npm;
  const prefix = npmPrefix(now.path)!;
  const bin = path.dirname(npm);
  set({ status: "updating", version: now.version, target: appVersion, npm, path: now.path });
  logger.info(`updating the command line from ${now.version} to ${appVersion} (${why}) with ${npm}`);
  const result = await new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(
      npm,
      // --prefix: into the install the command line runs from, whatever this npm would pick on its own
      ["install", "-g", "--prefix", prefix, `parawatch@${appVersion}`, "--prefer-online", "--no-fund", "--no-audit"],
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
    await new Promise((resolve) => execFile(path.join(bin, process.platform === "win32" ? "parawatch.cmd" : "parawatch"), ["--version"], { env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(path.delimiter) }, timeout: 20_000, shell: process.platform === "win32", windowsHide: true }, resolve));
    set({ status: "idle" });
    return cliState(appVersion);
  }
  const last = result.out.split("\n").filter(Boolean).slice(-3).join(" ");
  logger.warn(`command line update failed: ${result.out}`);
  const notYet = /ETARGET|No matching version|notarget/i.test(result.out);
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
