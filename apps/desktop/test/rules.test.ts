import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { artPng, countLabel, draw, drawTray, TRAY_IDLE, trayWidth } from "../src/art.js";
import { agentsWorking, alertFor, issueUrl, needsYou, summary, toDo, updateLabel } from "../src/rules.js";
import type { Card, PwEvent, Snapshot } from "../../../src/core/types.js";

const card = (id: string, kind: Card["kind"], status: Card["status"] = "open"): Card => ({
  id,
  kind,
  project: "game",
  title: `Card ${id}`,
  openedAt: "2026-11-07T00:00:00.000Z",
  status,
  answers: [],
  comments: [],
});
const snap = (cards: Card[]): Snapshot => ({ v: 1, generatedAt: "", projects: [], cards, runs: [] });
const ev = (body: object): PwEvent => ({ v: 1, seq: 1, ts: "", ...body }) as PwEvent;
const noRuns = { runTitle: () => undefined };

describe("what needs the human", () => {
  it("counts open cards that are not to-dos", () => {
    const s = snap([card("c1", "decide"), card("c2", "block"), card("c3", "todo"), card("c4", "try", "answered")]);
    expect(needsYou(s)).toBe(2);
    expect(toDo(s)).toBe(1);
    expect(summary(s)).toBe("2 need you · 1 to do");
    expect(summary(snap([]))).toBe("Nothing needs you");
  });

  it("sees agents at work from their runs", () => {
    const run = (state: "working" | "idle") => ({ id: "r", runtime: "codex", kind: "exec", title: "r", state }) as const;
    expect(agentsWorking({ ...snap([]), runs: [run("idle")] })).toBe(false);
    expect(agentsWorking({ ...snap([]), runs: [run("idle"), run("working")] })).toBe(true);
  });

  it("notifies for new cards and failed jobs, never for to-dos or answers", () => {
    const open = (kind: Card["kind"]) => ev({ type: "card.open", card: { id: "c9", kind, project: "game", title: "Ship it?" } });
    expect(alertFor(open("decide"), noRuns)).toEqual({ title: "game · Decide", body: "Ship it?", card: "c9" });
    expect(alertFor(open("block"), noRuns)?.title).toBe("game · Blocked");
    expect(alertFor(open("todo"), noRuns)).toBeUndefined();
    expect(alertFor(ev({ type: "card.answer", card: "c9", by: "human", choice: 1 }), noRuns)).toBeUndefined();
    expect(alertFor(ev({ type: "run.end", run: "r2", status: "failed", note: "UI test timed out" }), { runTitle: () => "PR 212 CI" })).toEqual({
      title: "A job failed",
      body: "PR 212 CI: UI test timed out",
    });
    expect(alertFor(ev({ type: "run.end", run: "r2", status: "done" }), noRuns)).toBeUndefined();
  });
});

describe("icons drawn in code", () => {
  it("draws a tile with transparent corners and a monochrome tray mark", () => {
    const app = draw("app", 64);
    expect(app[3]).toBe(0); // top-left corner is outside the rounded tile
    expect(app[(32 * 64 + 4) * 4 + 3]).toBe(0); // left edge, outside the tile
    expect(app[(32 * 64 + 32) * 4 + 3]).toBe(255); // centre
    const tray = draw("tray", 32);
    for (let i = 0; i < tray.length; i += 4) expect([tray[i], tray[i + 1], tray[i + 2]]).toEqual([0, 0, 0]);
    expect(tray.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
  });

  it("moves the tray dots only while agents work, and holds the one that needs you", () => {
    const opaque = (px: Uint8Array) => px.filter((v, i) => i % 4 === 3 && v === 255).length;
    const idle = (phase: number) => draw("tray", 36, { phase, working: false, attention: false });
    expect(idle(0.3)).toEqual(idle(0.7));
    const work = (phase: number) => draw("tray", 36, { phase, working: true, attention: false });
    expect(work(0.3)).not.toEqual(work(0.7));
    const held = draw("tray", 36, { phase: 0.125, working: false, attention: true });
    expect(opaque(held)).toBeGreaterThan(opaque(idle(0.125)));
    const white = draw("tray", 36, TRAY_IDLE, [255, 255, 255]);
    expect([white[0], white[1], white[2]]).toEqual([255, 255, 255]);
  });

  it("encodes a valid PNG", () => {
    const buf = artPng("overlay", 16);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(16); // width in IHDR
    const idat = buf.indexOf("IDAT");
    const len = buf.readUInt32BE(idat - 4);
    expect(zlib.inflateSync(buf.subarray(idat + 4, idat + 4 + len)).length).toBe(16 * (16 * 4 + 1));
  });

  it("draws the count inside the menu bar icon", () => {
    expect(countLabel(7)).toBe("7");
    expect(countLabel(140)).toBe("99+");
    expect(trayWidth(0)).toBe(18);
    expect(trayWidth(12)).toBeGreaterThan(trayWidth(1));
    const plain = drawTray(TRAY_IDLE, 0, 2);
    expect(plain.width).toBe(36);
    const one = drawTray(TRAY_IDLE, 1, 2);
    const twelve = drawTray(TRAY_IDLE, 12, 2);
    expect(twelve.width).toBeGreaterThan(one.width);
    // amber bubble pixels, and dark digit pixels inside it
    const px = (img: { rgba: Uint8Array }, test: (r: number, g: number, b: number, a: number) => boolean) => {
      let n = 0;
      for (let i = 0; i < img.rgba.length; i += 4) if (test(img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!)) n++;
      return n;
    };
    const amber = (r: number, g: number, b: number, a: number) => a > 250 && r > 240 && g > 160 && b < 80;
    const digit = (r: number, g: number, b: number, a: number) => a > 250 && r < 80 && g < 50;
    expect(px(plain, amber)).toBe(0);
    expect(px(one, amber)).toBeGreaterThan(50);
    expect(px(one, digit)).toBeGreaterThan(10);
    expect(px(twelve, digit)).toBeGreaterThan(px(one, digit));
  });
});

describe("pull requests and stuck work", () => {
  const pr = { type: "pr.change", pr: { key: "github.com/acme/api#88", host: "github.com", repo: "acme/api", number: 88, url: "https://github.com/acme/api/pull/88" }, title: "Fix login", source: "github" };

  it("notifies what keeps a pull request from landing, and the landing", () => {
    expect(alertFor(ev({ ...pr, change: "queue_removed" }), noRuns)).toEqual({ title: "api#88 · dropped from the merge queue", body: "Fix login" });
    expect(alertFor(ev({ ...pr, change: "changes_requested", by: "alice" }), noRuns)?.title).toBe("api#88 · changes requested by alice");
    expect(alertFor(ev({ ...pr, change: "commented" }), noRuns)).toBeUndefined();
  });

  it("reports a pull request or a job once when it gets stuck, and again only after it recovers", async () => {
    const { newlyStuck } = await import("../src/rules.js");
    const view = { key: "k", url: "", repo: "acme/api", number: 88, title: "Fix login", state: "open", draft: false, waitingOn: "merge queue", since: "", stalled: true, reviewRequested: false, mine: true } as const;
    const job = { id: "r1", runtime: "declared", kind: "declared", title: "bench", state: "stalled", action: "no sign of life for 12m" } as const;
    const s = { ...snap([]), prs: [view], runs: [job] } as Snapshot;
    const seen = new Set<string>();
    expect(newlyStuck(s, seen).map((a) => a.title)).toEqual(["api#88 stuck in merge queue", "A job stopped showing signs of life"]);
    expect(newlyStuck(s, seen)).toEqual([]);
    expect(newlyStuck({ ...s, prs: [{ ...view, stalled: false }], runs: [] }, seen)).toEqual([]);
    expect(newlyStuck(s, seen)).toHaveLength(2);
  });
});

describe("versions and updates", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  it("says where the app's own update stands", () => {
    expect(updateLabel({ status: "latest", checkedAt: "2026-11-09T11:50:00Z" }, now)).toBe("Up to date · checked 10 min ago");
    expect(updateLabel({ status: "downloading", version: "0.2.2", percent: 40 }, now)).toBe("Downloading 0.2.2 · 40%");
    expect(updateLabel({ status: "ready", version: "0.2.2" }, now)).toBe("0.2.2 is ready · restart to use it");
    expect(updateLabel({ status: "off", reason: "a development build does not update itself" }, now)).toBe("A development build does not update itself");
    expect(updateLabel({ status: "error", error: "could not reach GitHub" }, now)).toBe("Could not check: could not reach GitHub");
  });

  it("opens an issue with the versions filled in and nothing else", () => {
    const url = issueUrl({ version: "0.2.1", electron: "45.2.3", platform: "darwin-arm64 27.2", cli: { version: "0.2.0", at: "" }, logPath: "/Users/someone/Library/Logs/Parawatch/main.log", dataPath: "/Users/someone/.local/state/parawatch" });
    expect(url.startsWith("https://github.com/penspanic/parawatch/issues/new?body=")).toBe(true);
    const body = decodeURIComponent(url.split("body=")[1]!);
    expect(body).toContain("Parawatch app 0.2.1 (Electron 45.2.3)");
    expect(body).toContain("parawatch CLI 0.2.0");
    expect(body).not.toContain("/Users/someone");
  });
});
