import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for electron-updater's autoUpdater. `latest` is the newest release on the feed;
 * `cached` is what has been downloaded. A check reports what electron-updater reports: nothing
 * newer, or a newer version that is downloaded (at once when it is already in the cache).
 */
const feed = vi.hoisted(() => ({ latest: "0.3.10", cached: undefined as string | undefined, current: "0.3.8", checks: 0, installs: [] as string[] }));
const updater = vi.hoisted(() => ({ emitter: undefined as unknown as EventEmitter }));

vi.mock("electron", () => ({ app: { isPackaged: true, getVersion: () => feed.current } }));
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
  Object.assign(feed, { latest: "0.3.9", cached: undefined, current: "0.3.8", checks: 0, installs: [] });
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
    (updater.emitter as unknown as { checkForUpdates: () => Promise<void> }).checkForUpdates = () => new Promise(() => {});
    const s = await u.freshestBeforeRestart(20);
    expect(s).toMatchObject({ status: "ready", version: "0.3.9" });
  });
});
