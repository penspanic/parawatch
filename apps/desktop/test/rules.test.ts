import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { artPng, draw } from "../src/art.js";
import { alertFor, needsYou, summary, toDo, trayTitle } from "../src/rules.js";
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
    expect(trayTitle(0)).toBe("");
    expect(trayTitle(3)).toBe("3");
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

  it("encodes a valid PNG", () => {
    const buf = artPng("overlay", 16);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(16); // width in IHDR
    const idat = buf.indexOf("IDAT");
    const len = buf.readUInt32BE(idat - 4);
    expect(zlib.inflateSync(buf.subarray(idat + 4, idat + 4 + len)).length).toBe(16 * (16 * 4 + 1));
  });
});
