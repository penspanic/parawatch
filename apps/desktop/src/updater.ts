/**
 * The app updates itself from GitHub Releases: it looks for a new version a little after start and
 * every few hours, downloads it in the background, and asks for a restart. It never restarts on its
 * own, though a downloaded update is put in place when the app quits. Packaged macOS builds and the
 * Windows installer update this way; development runs and Linux point at the releases page instead.
 */
import { app, autoUpdater as squirrel } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { logger } from "./logger.js";
import type { UpdateState } from "./prefs.js";

const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 6 * 3_600_000;

export const RELEASES_URL = "https://github.com/penspanic/parawatch/releases";

let state: UpdateState = { status: "idle" };
let listener: (s: UpdateState) => void = () => {};
let timer: NodeJS.Timeout | undefined;
let first: NodeJS.Timeout | undefined;
let wired = false;
/** The check under way, if any. */
let checking: Promise<void> | undefined;
/** The version an earlier restart failed to install; its next update-downloaded is flagged. */
let unfinished: string | undefined;
/**
 * On macOS, electron-updater's update-downloaded only means its own copy is complete. It then hands
 * the file to Squirrel, which fetches and unpacks it again, a few seconds for the whole app. Every
 * check that finds the update does this again, and Squirrel throws away what it had unpacked when it
 * starts over. Quitting to install meanwhile makes ShipIt install a half-unpacked app, which fails
 * its signature check, so a restart waits until Squirrel says the update is in place.
 */
let squirrelBusy = false;
let squirrelError: string | undefined;
const squirrelDone = new Set<() => void>();

function set(next: UpdateState): void {
  state = next;
  listener(state);
}

export function updateState(): UpdateState {
  return state;
}

/** Why this copy cannot update itself, or undefined when it can. */
function offReason(): string | undefined {
  if (!app.isPackaged) return "a development build does not update itself";
  if (process.platform !== "darwin" && process.platform !== "win32") return "this platform has no update feed yet; new versions are on GitHub Releases";
  return undefined;
}

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  const stamp = () => new Date().toISOString();
  autoUpdater.on("checking-for-update", () => set({ ...state, status: state.status === "ready" ? "ready" : "checking" }));
  // a downloaded update stays ready while a later check finds the same version, or nothing
  autoUpdater.on("update-not-available", () => set(state.status === "ready" ? { ...state, checkedAt: stamp() } : { status: "latest", checkedAt: stamp() }));
  autoUpdater.on("update-available", (i: UpdateInfo) => {
    if (state.status === "ready" && state.version === i.version) set({ ...state, checkedAt: stamp() });
    else set({ status: "available", version: i.version, checkedAt: stamp() });
  });
  autoUpdater.on("download-progress", (p: { percent: number }) => {
    if (state.status !== "ready") set({ ...state, status: "downloading", percent: Math.round(p.percent) });
  });
  if (process.platform === "darwin") {
    squirrel.on("update-downloaded", () => settleSquirrel());
    squirrel.on("error", (err: Error) => settleSquirrel(shortError(err)));
    squirrel.on("update-not-available", () => settleSquirrel("Squirrel found nothing to install"));
  }
  autoUpdater.on("update-downloaded", (i: UpdateInfo) => {
    // electron-updater hands this file to Squirrel right after saying it is downloaded
    if (process.platform === "darwin") {
      squirrelBusy = true;
      squirrelError = undefined;
    }
    set({ status: "ready", version: i.version, checkedAt: stamp(), ...(unfinished === i.version ? { interrupted: true } : {}) });
  });
  autoUpdater.on("error", (err: Error) => {
    logger.warn("update check failed:", err);
    if (state.status !== "ready") set({ status: "error", error: shortError(err), checkedAt: stamp() });
  });
}

function settleSquirrel(error?: string): void {
  squirrelBusy = false;
  squirrelError = error;
  if (error) logger.warn(`Squirrel could not take the update: ${error}`);
  for (const f of squirrelDone) f();
  squirrelDone.clear();
}

/**
 * Wait until Squirrel has the downloaded update in place, so quitting installs it. Resolves with
 * why it is not, or undefined when it is (and at once outside macOS).
 */
export async function preparedForInstall(waitMs = 120_000): Promise<string | undefined> {
  if (process.platform === "darwin" && squirrelBusy) {
    logger.info("waiting for Squirrel to unpack the update before quitting");
    let timeout: NodeJS.Timeout | undefined;
    let settle: (() => void) | undefined;
    const done = await Promise.race([
      new Promise<boolean>((r) => {
        settle = () => r(true);
        squirrelDone.add(settle);
      }),
      new Promise<boolean>((r) => (timeout = setTimeout(() => r(false), waitMs))),
    ]);
    if (timeout) clearTimeout(timeout);
    if (settle) squirrelDone.delete(settle);
    if (!done) return "the update was still being unpacked";
  }
  return squirrelError;
}

function shortError(err: Error): string {
  const first = (err.message || String(err)).split("\n")[0] ?? "";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/.test(first)) return "could not reach GitHub";
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

/** Look now. Resolves when the check is done; the download, if any, goes on in the background. */
export async function checkNow(): Promise<UpdateState> {
  const off = offReason();
  if (off) {
    set({ status: "off", reason: off });
    return state;
  }
  // a ready update is checked again: a newer release may have come out since it was downloaded,
  // and restarting into the older one would only mean a second update right after
  if (state.status === "downloading" || state.status === "checking") return state;
  // a ready update stays "ready" while it is checked again, so a second call meanwhile joins the
  // check under way instead of asking GitHub again and handing the file to Squirrel once more
  if (!checking) {
    wire();
    checking = autoUpdater
      .checkForUpdates()
      .then(
        () => {},
        (err: unknown) => {
          // the error event has set the state already
          logger.warn("update check threw:", err);
        },
      )
      .finally(() => {
        checking = undefined;
      });
  }
  await checking;
  return state;
}

/**
 * An earlier restart to update never finished. Look right away instead of waiting for the first
 * scheduled check: the downloaded file is still in electron-updater's cache, so the check finds
 * it, hands it to Squirrel again and reports update-downloaded without downloading anything.
 */
export function resumeUnfinished(version: string): Promise<UpdateState> {
  unfinished = version;
  return checkNow();
}

/** Start or stop looking on a schedule. */
export function scheduleUpdates(on: boolean, onChange: (s: UpdateState) => void): void {
  listener = onChange;
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = first = undefined;
  const off = offReason();
  if (off) {
    set({ status: "off", reason: off });
    return;
  }
  if (!on) return;
  first = setTimeout(() => void checkNow(), FIRST_CHECK_MS);
  timer = setInterval(() => void checkNow(), EVERY_MS);
}

/**
 * Before a restart to update: look once more, so the restart installs the newest release and not
 * one downloaded hours ago. Gives up after `waitMs` and keeps what is ready.
 */
export async function freshestBeforeRestart(waitMs = 15_000): Promise<UpdateState> {
  if (state.status !== "ready") return state;
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([checkNow(), new Promise((r) => (timeout = setTimeout(r, waitMs)))]);
  if (timeout) clearTimeout(timeout);
  return state;
}

/** Set once the app has asked to quit and install; asking again would only quit again. */
let installing = false;

/** Quit and open the new version. */
export function installNow(): void {
  if (state.status !== "ready" || installing) return;
  installing = true;
  logger.info(`restarting into ${state.version}`);
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
}
