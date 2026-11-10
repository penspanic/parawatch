/**
 * The app updates itself from GitHub Releases: it looks for a new version a little after start and
 * every few hours, downloads it in the background, and asks for a restart. It never restarts on its
 * own, though a downloaded update is put in place when the app quits. Only signed macOS builds
 * update this way; development runs and other platforms point at the releases page instead.
 */
import { app } from "electron";
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
/** The version an earlier restart failed to install; its next update-downloaded is flagged. */
let unfinished: string | undefined;

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
  if (process.platform !== "darwin") return "this platform has no update feed yet; new versions are on GitHub Releases";
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
  autoUpdater.on("update-not-available", () => set({ status: "latest", checkedAt: stamp() }));
  autoUpdater.on("update-available", (i: UpdateInfo) => set({ status: "available", version: i.version, checkedAt: stamp() }));
  autoUpdater.on("download-progress", (p: { percent: number }) => set({ ...state, status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i: UpdateInfo) => set({ status: "ready", version: i.version, checkedAt: stamp(), ...(unfinished === i.version ? { interrupted: true } : {}) }));
  autoUpdater.on("error", (err: Error) => {
    logger.warn("update check failed:", err);
    if (state.status !== "ready") set({ status: "error", error: shortError(err), checkedAt: stamp() });
  });
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
  if (state.status === "ready" || state.status === "downloading" || state.status === "checking") return state;
  wire();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // the error event has set the state already
    logger.warn("update check threw:", err);
  }
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

/** Quit and open the new version. */
export function installNow(): void {
  if (state.status !== "ready") return;
  logger.info(`restarting into ${state.version}`);
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
}
