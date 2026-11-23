import { beforeEach, describe, expect, it } from "vitest";
import { freshHome } from "./helpers.js";
import { readAppUpdateRequest, readAppUpdateStatus, requestAppUpdate, waitForAppUpdate, writeAppUpdateStatus, type AppUpdateStatus } from "../src/core/appUpdate.js";

beforeEach(() => {
  freshHome();
});

/** A clock and an app that move one step per sleep. */
function scripted(steps: { status?: Omit<AppUpdateStatus, "at" | "id">; running?: string }[], id = "r1") {
  let i = 0;
  let t = 0;
  const seen: string[] = [];
  return {
    seen,
    wait: (timeoutMs = 600_000, from = "0.3.32") =>
      waitForAppUpdate({
        id,
        from,
        status: () => {
          const s = steps[Math.min(i, steps.length - 1)]!.status;
          return s ? { id, at: "", ...s } : undefined;
        },
        running: () => steps[Math.min(i, steps.length - 1)]!.running,
        sleep: async () => {
          i++;
          t += 1000;
        },
        now: () => t,
        timeoutMs,
        onStep: (s) => seen.push(s.step),
      }),
  };
}

describe("parawatch app update", () => {
  it("leaves a request and reads the app's answer to it", () => {
    const id = requestAppUpdate();
    expect(readAppUpdateRequest()?.id).toBe(id);
    writeAppUpdateStatus({ id, step: "downloading", version: "0.3.33", percent: 40 });
    expect(readAppUpdateStatus()).toMatchObject({ id, step: "downloading", version: "0.3.33", percent: 40 });
  });

  it("follows the app through the restart until the new version runs", async () => {
    const s = scripted([
      { running: "0.3.32" },
      { status: { step: "checking" }, running: "0.3.32" },
      { status: { step: "downloading", version: "0.3.33" }, running: "0.3.32" },
      { status: { step: "restarting", version: "0.3.33" }, running: "0.3.32" },
      { status: { step: "restarting", version: "0.3.33" } },
      { status: { step: "restarting", version: "0.3.33" }, running: "0.3.33" },
    ]);
    const r = await s.wait();
    expect(r).toMatchObject({ ok: true, version: "0.3.33" });
    expect(s.seen).toEqual(["checking", "downloading", "restarting"]);
  });

  it("says when there is nothing newer, or why it cannot", async () => {
    expect(await scripted([{ status: { step: "latest" }, running: "0.3.32" }]).wait()).toMatchObject({ ok: true, text: expect.stringContaining("newest") });
    expect(await scripted([{ status: { step: "error", error: "could not reach GitHub" }, running: "0.3.32" }]).wait()).toMatchObject({ ok: false, text: expect.stringContaining("could not reach GitHub") });
  });

  it("names an app too old to know the command, and an answer to another request does not count", async () => {
    const r = await scripted([{ status: { step: "latest" }, running: "0.3.31" }], "other").wait(600_000, "0.3.31");
    expect(r.ok).toBe(true);
    const old = scripted([{ running: "0.3.31" }]);
    const r2 = await old.wait(600_000, "0.3.31");
    expect(r2).toMatchObject({ ok: false, text: expect.stringContaining("Check for Updates") });
  });

  it("gives up after the timeout and says where the app was", async () => {
    const r = await scripted([{ status: { step: "downloading", version: "0.3.33" }, running: "0.3.32" }]).wait(5_000);
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('"downloading"') });
  });
});
