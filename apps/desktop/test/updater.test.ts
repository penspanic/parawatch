import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for electron-updater's autoUpdater. `latest` is the newest release on the feed;
 * `cached` is what has been downloaded. A check reports what electron-updater reports: nothing
 * newer, or a newer version that is downloaded (at once when it is already in the cache).
 *
 * After update-downloaded, electron-updater hands the file to Squirrel (electron's own autoUpdater),
 * which unpacks it and says update-downloaded or error when done: `squirrel` says how that goes.
 */
const feed = vi.hoisted(() => ({ latest: "0.3.10", cached: undefined as string | undefined, current: "0.3.8", checks: 0, installs: [] as string[], squirrel: "ok" as "ok" | "fails" | "hangs", squirrelMs: 5 }));
const updater = vi.hoisted(() => ({ emitter: undefined as unknown as EventEmitter, native: undefined as unknown as EventEmitter }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  updater.native = new EventEmitter();
  return { app: { isPackaged: true, getVersion: () => feed.current }, autoUpdater: updater.native };
});
vi.mock("../src/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  const e = new EventEmitter() as EventEmitter & Record<string, unknown>;
  updater.emitter = e;
  Object.assign(e, {
    checkForUpdates: async () => {
      feed.checks++;
      e.emit("checking-for-update");
      if (feed.latest === feed.current) {
        e.emit("update-not-available", { version: feed.latest });
        return;
      }
      e.emit("update-available", { version: feed.latest });
      if (feed.cached !== feed.latest) {
        e.emit("download-progress", { percent: 50 });
        feed.cached = feed.latest;
      }
      e.emit("update-downloaded", { version: feed.latest });
      if (feed.squirrel === "hangs") return;
      const native = updater.native;
      setTimeout(() => (feed.squirrel === "ok" ? native.emit("update-downloaded") : native.emit("error", new Error("Code signature did not pass validation"))), feed.squirrelMs);
    },
    quitAndInstall: () => feed.installs.push(feed.cached ?? "none"),
  });
  return { autoUpdater: e };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => Object.defineProperty(process, "platform", { value: "darwin" }));
afterAll(() => Object.defineProperty(process, "platform", platform));

async function load() {
  vi.resetModules();
  return import("../src/updater.js");
}

beforeEach(() => {
  Object.assign(feed, { latest: "0.3.9", cached: undefined, current: "0.3.8", checks: 0, installs: [], squirrel: "ok", squirrelMs: 5 });
});

describe("updater", () => {
  it("downloads a new version and is ready to restart into it", async () => {
    const u = await load();
    expect(await u.checkNow()).toMatchObject({ status: "ready", version: "0.3.9" });
  });

  it("says latest when nothing is newer", async () => {
    feed.latest = "0.3.8";
    const u = await load();
    expect(await u.checkNow()).toMatchObject({ status: "latest" });
  });

  it("checks again while an update is ready, and moves to a release that came out since", async () => {
    const u = await load();
    await u.checkNow();
    feed.latest = "0.3.10";
    expect(await u.checkNow()).toMatchObject({ status: "ready", version: "0.3.10" });
    expect(feed.checks).toBe(2);
  });

  it("stays ready on the same version when nothing newer came out", async () => {
    const u = await load();
    await u.checkNow();
    const seen: string[] = [];
    u.scheduleUpdates(false, (s) => seen.push(s.status));
    expect(await u.checkNow()).toMatchObject({ status: "ready", version: "0.3.9" });
    // the Restart button never goes away while it looks
    expect(seen.filter((s) => s !== "ready" && s !== "off")).toEqual([]);
  });

  it("a check that fails keeps the ready update", async () => {
    const u = await load();
    await u.checkNow();
    updater.emitter.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(u.updateState()).toMatchObject({ status: "ready", version: "0.3.9" });
  });

  it("before a restart, looks once more so it installs the newest and not the one downloaded hours ago", async () => {
    const u = await load();
    await u.checkNow();
    feed.latest = "0.3.10";
    const s = await u.freshestBeforeRestart();
    expect(s).toMatchObject({ status: "ready", version: "0.3.10" });
    u.installNow();
    await new Promise((r) => setImmediate(r));
    expect(feed.installs).toEqual(["0.3.10"]);
  });

  it("before a restart, gives up on a slow check and keeps what is ready", async () => {
    const u = await load();
    await u.checkNow();
    const e = updater.emitter as unknown as { checkForUpdates: () => Promise<void> };
    const check = e.checkForUpdates;
    e.checkForUpdates = () => new Promise(() => {});
    try {
      const s = await u.freshestBeforeRestart(20);
      expect(s).toMatchObject({ status: "ready", version: "0.3.9" });
    } finally {
      e.checkForUpdates = check;
    }
  });

  it("a restart waits until Squirrel has unpacked the update the last check handed it", async () => {
    const u = await load();
    await u.checkNow();
    await new Promise((r) => setTimeout(r, 20));
    // the check right before a restart hands the file to Squirrel again
    feed.squirrelMs = 40;
    await u.freshestBeforeRestart();
    let settled = false;
    const prepared = u.preparedForInstall(1000).then((why) => {
      settled = true;
      return why;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(await prepared).toBeUndefined();
  });

  it("says why when Squirrel could not take the update", async () => {
    feed.squirrel = "fails";
    const u = await load();
    await u.checkNow();
    expect(await u.preparedForInstall(1000)).toContain("Code signature");
  });

  it("gives up waiting on Squirrel and says so", async () => {
    feed.squirrel = "hangs";
    const u = await load();
    await u.checkNow();
    expect(await u.preparedForInstall(20)).toBe("the update was still being unpacked");
  });

  it("is prepared at once once Squirrel is done", async () => {
    const u = await load();
    await u.checkNow();
    await new Promise((r) => setTimeout(r, 20));
    expect(await u.preparedForInstall(0)).toBeUndefined();
  });
});
