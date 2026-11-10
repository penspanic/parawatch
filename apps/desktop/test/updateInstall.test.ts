import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearMarker, INSTALL_WINDOW_MS, installingNotice, interruptedNotice, parseMarker, readMarker, startState, writeMarker } from "../src/updateInstall.js";
import { updateLabel } from "../src/rules.js";

const at = "2026-11-10T12:00:00.000Z";
const t0 = Date.parse(at);

describe("startState", () => {
  it("is none without a marker", () => {
    expect(startState(undefined, "0.3.2", t0)).toBe("none");
  });
  it("is installing just after the app quit for the update", () => {
    expect(startState({ version: "0.3.3", at }, "0.3.2", t0 + 25_000)).toBe("installing");
  });
  it("is interrupted once the install window has passed and the old version is still running", () => {
    expect(startState({ version: "0.3.3", at }, "0.3.2", t0 + INSTALL_WINDOW_MS + 1)).toBe("interrupted");
    expect(startState({ version: "0.3.3", at }, "0.3.2", t0 + 3 * 3_600_000)).toBe("interrupted");
  });
  it("is none when the new version is the one running, however fresh the marker", () => {
    expect(startState({ version: "0.3.3", at }, "0.3.3", t0 + 5_000)).toBe("none");
    expect(startState({ version: "0.3.3", at }, "0.4.0", t0 + 5_000)).toBe("none");
  });
});

describe("notices", () => {
  it("names the version being installed and the wait", () => {
    const n = installingNotice("0.3.3");
    expect(n.title).toBe("Installing 0.3.3");
    expect(n.body).toContain("reopens in about 30 seconds");
  });
  it("tells an unfinished install apart", () => {
    expect(interruptedNotice("0.3.3").title).toContain("0.3.3");
    expect(updateLabel({ status: "ready", version: "0.3.3", interrupted: true })).toBe("0.3.3 was not installed · restart to try again");
    expect(updateLabel({ status: "ready", version: "0.3.3" })).toBe("0.3.3 is ready · restart to use it");
  });
});

describe("marker file", () => {
  it("round-trips and clears", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-marker-"));
    try {
      expect(readMarker(dir)).toBeUndefined();
      writeMarker(dir, "0.3.3", new Date(at));
      expect(readMarker(dir)).toEqual({ version: "0.3.3", at });
      clearMarker(dir);
      expect(readMarker(dir)).toBeUndefined();
      clearMarker(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("ignores a damaged file", () => {
    expect(parseMarker("{")).toBeUndefined();
    expect(parseMarker('{"version":"0.3.3","at":"nope"}')).toBeUndefined();
    expect(parseMarker('{"version":3}')).toBeUndefined();
  });
});
