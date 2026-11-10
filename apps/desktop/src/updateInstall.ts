/**
 * What the app remembers about an update it is in the middle of installing. Restart to Update quits
 * the app; Squirrel's ShipIt then verifies the downloaded bundle for about 20 seconds, swaps it in
 * and reopens it. Nothing is on screen meanwhile, and starting the old version again in that time
 * makes ShipIt give up ("App Still Running"). So the app writes a small marker just before it quits
 * and reads it on the next start: a fresh marker means the install is still going (step aside), an
 * old one for a version we do not run means it never finished (offer the restart again).
 *
 * No electron imports here, so the logic can be tested on its own.
 */
import fs from "node:fs";
import path from "node:path";
import { compareVersions } from "../../../src/core/semver.js";

export interface InstallMarker {
  /** the version being installed */
  version: string;
  /** when the app quit to install it */
  at: string;
}

/** How long after Restart to Update the install is still expected to be running. */
export const INSTALL_WINDOW_MS = 90_000;

export type StartState =
  /** nothing was being installed (or it finished) */
  | "none"
  /** an install started a moment ago and ShipIt is still working: do not stay open */
  | "installing"
  /** an install started a while ago and this version is still the old one */
  | "interrupted";

export const MARKER_FILE = "pending-update.json";

export function parseMarker(text: string): InstallMarker | undefined {
  try {
    const m = JSON.parse(text) as Partial<InstallMarker>;
    if (typeof m.version === "string" && m.version && typeof m.at === "string" && Number.isFinite(Date.parse(m.at))) return { version: m.version, at: m.at };
  } catch {
    // not a marker
  }
  return undefined;
}

/** What a start finds: compare the marker with the version that is running and the clock. */
export function startState(marker: InstallMarker | undefined, running: string, now = Date.now()): StartState {
  if (!marker) return "none";
  if (compareVersions(running, marker.version) >= 0) return "none";
  return now - Date.parse(marker.at) < INSTALL_WINDOW_MS ? "installing" : "interrupted";
}

/** The notification shown just before the app quits for an update. */
export function installingNotice(version: string): { title: string; body: string } {
  return { title: `Installing ${version}`, body: `Parawatch reopens in about 30 seconds. Please do not open it again until then.` };
}

/** Shown when the app is started while an install is still going on, just before it steps aside. */
export function stillInstallingNotice(version: string): { title: string; body: string } {
  return { title: `Still installing ${version}`, body: "Parawatch reopens by itself when it is done." };
}

/** Shown when an earlier restart to update never finished. */
export function interruptedNotice(version: string): { title: string; body: string } {
  return { title: `${version} was not installed`, body: "The last restart did not finish. Restart to Update to try again." };
}

export function readMarker(dir: string): InstallMarker | undefined {
  try {
    return parseMarker(fs.readFileSync(path.join(dir, MARKER_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

export function writeMarker(dir: string, version: string, now = new Date()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify({ version, at: now.toISOString() } satisfies InstallMarker));
  } catch {
    // the update still goes ahead; only the "did not finish" notice is lost
  }
}

export function clearMarker(dir: string): void {
  fs.rmSync(path.join(dir, MARKER_FILE), { force: true });
}
