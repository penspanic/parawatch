// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { baseBox, bestColumns, boxOrigin, clockLabel, follow, JUMP, keepSpot, SLACK, type Follower } from "../src/compare";
import { openViewer, type ViewerItem } from "../src/viewer";

const f = (over: Partial<Follower> = {}): Follower => ({ t: 1, duration: 6, paused: false, seeking: false, rate: 1, ...over });

describe("follow: a video keeping time with the longest one", () => {
  it("leaves a follower that is close enough", () => {
    expect(follow(1 + SLACK / 2, true, 1, f())).toEqual({});
  });

  it("catches up by playing a little faster, and slows down when ahead", () => {
    expect(follow(1.02, true, 1, f()).rate).toBeGreaterThan(1);
    expect(follow(1.05, true, 1, f()).rate).toBeGreaterThan(1);
    expect(follow(0.95, true, 1, f()).rate).toBeLessThan(1);
    // never more than a tenth off the speed
    expect(follow(1.2, true, 1, f()).rate).toBeCloseTo(1.1);
  });

  it("jumps when it is far off, and goes back to the speed", () => {
    expect(follow(1 + JUMP + 0.1, true, 1, f({ rate: 1.08 }))).toEqual({ seek: 1 + JUMP + 0.1, rate: 1 });
  });

  it("starts a paused follower at the leader's moment while playing", () => {
    expect(follow(2, true, 1, f({ paused: true }))).toEqual({ seek: 2, play: true, rate: 1 });
  });

  it("sits on the leader's moment while paused", () => {
    expect(follow(2.5, false, 1, f({ t: 2.47 }))).toEqual({ pause: true, seek: 2.5 });
    expect(follow(2.5, false, 1, f({ t: 2.5, paused: true }))).toEqual({});
  });

  it("holds its last frame once the leader passes its end", () => {
    expect(follow(7, true, 1, f({ t: 5.9 }))).toEqual({ pause: true, seek: 6 });
    expect(follow(7, true, 1, f({ t: 6, paused: true }))).toEqual({});
  });

  it("waits while it is still moving to the last moment it was sent to", () => {
    expect(follow(4, true, 1, f({ seeking: true }))).toEqual({});
  });
});

describe("the shared view", () => {
  it("fits the largest picture to the pane and never enlarges it", () => {
    expect(baseBox({ w: 1000, h: 1000 }, [{ w: 1280, h: 720 }, { w: 960, h: 540 }])).toEqual({ w: 1000, h: 562.5 });
    expect(baseBox({ w: 2000, h: 2000 }, [{ w: 640, h: 400 }])).toEqual({ w: 640, h: 400 });
    expect(baseBox({ w: 100, h: 100 }, [])).toEqual({ w: 0, h: 0 });
  });

  it("centres a box smaller than the pane and keeps a larger one from leaving a gap", () => {
    expect(boxOrigin({ w: 100, h: 100 }, { w: 50, h: 40 }, 1, 0.5, 0.5)).toEqual({ x: 25, y: 30 });
    // zoomed 4 times on the left edge: the box's left edge stays at the pane's
    expect(boxOrigin({ w: 100, h: 100 }, { w: 100, h: 100 }, 4, 0, 0.5)).toEqual({ x: 0, y: -150 });
    expect(keepSpot(100, 400, 0)).toBe(0.125);
    expect(keepSpot(100, 80, 0.9)).toBe(0.5);
  });

  it("lays pictures side by side in a wide window, one above the other in a tall one, a grid between", () => {
    expect(bestColumns(2, 16 / 9, { w: 1600, h: 800 })).toBe(2);
    expect(bestColumns(2, 16 / 9, { w: 440, h: 800 })).toBe(1);
    expect(bestColumns(4, 16 / 9, { w: 1200, h: 900 })).toBe(2);
    expect(bestColumns(1, 1, { w: 10, h: 10 })).toBe(1);
  });

  it("writes the clock as minutes, seconds and hundredths", () => {
    expect(clockLabel(75.5)).toBe("1:15.50");
    expect(clockLabel(3.04)).toBe("0:03.04");
    expect(clockLabel(Number.NaN)).toBe("0:00.00");
  });
});

describe("the viewer's ways of showing a comparison", () => {
  const items: ViewerItem[] = [
    { file: "/c/now.png", src: "blob:now", video: false, caption: "Now", group: 0 },
    { file: "/c/ring.png", src: "blob:ring", video: false, caption: "Ring removed", group: 0, option: 2 },
    { file: "/c/outline.png", src: "blob:outline", video: false, caption: "Outline", group: 0, option: 1 },
    { file: "/c/plain.png", src: "blob:plain", video: false },
  ];
  const host = { icon: (e: HTMLElement, n: string) => (e.dataset.icon = n), openExternal: () => {} };
  const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const modes = () => document.querySelector<HTMLElement>(".pw-viewer-modes")!;
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    document.body.replaceChildren();
  });

  it("shows a comparison side by side, each picture with its name, and keeps the choice", () => {
    close = openViewer(document, items, 0, host, { mode: "side" });
    expect(modes().hidden).toBe(false);
    expect(document.querySelectorAll(".pw-cmp.is-side .pw-cmp-pane").length).toBe(3);
    expect([...document.querySelectorAll(".pw-cmp-label")].map((l) => l.textContent)).toEqual(["Now", "2 · Ring removed", "1 · Outline"]);
    expect(document.querySelector(".pw-viewer-caption")?.textContent).toBe("1–3 / 4");
    // pictures have nothing to play
    expect(document.querySelector<HTMLElement>(".pw-cmp-transport")!.hidden).toBe(true);
    close();
    close = openViewer(document, items, 1, host);
    expect(document.querySelectorAll(".pw-viewer:not(.is-closing) .pw-cmp-pane").length).toBe(3);
  });

  it("lays two over each other as a slider, and picks which two of three", () => {
    close = openViewer(document, items, 0, host, { mode: "wipe" });
    const layers = () => [...document.querySelectorAll<HTMLImageElement>(".pw-cmp-layer img")].map((i) => i.alt);
    expect(layers()).toEqual(["Now", "Ring removed"]);
    expect(document.querySelector(".pw-cmp-layer.is-over img")?.getAttribute("alt")).toBe("Ring removed");
    expect(document.querySelector(".pw-cmp-divider")).not.toBeNull();
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>(".pw-cmp-tab")];
    expect(tabs().map((t) => t.querySelector(".pw-cmp-side")?.textContent)).toEqual(["L", "R", ""]);
    // another takes the right side first, then the left
    tabs()[2]!.click();
    expect(layers()).toEqual(["Now", "Outline"]);
    tabs()[1]!.click();
    expect(layers()).toEqual(["Ring removed", "Outline"]);
    // a shown one swaps sides
    tabs()[2]!.click();
    expect(layers()).toEqual(["Outline", "Ring removed"]);
  });

  it("switches with 1, 2 and 3, steps over the whole comparison, and has no switch for a lone picture", () => {
    close = openViewer(document, items, 0, host, { mode: "one" });
    expect(document.querySelector(".pw-cmp")).toBeNull();
    expect(document.querySelectorAll(".pw-viewer-tab").length).toBe(3);
    key("2");
    expect(document.querySelector(".pw-cmp.is-side")).not.toBeNull();
    key("3");
    expect(document.querySelector(".pw-cmp.is-wipe")).not.toBeNull();
    key("ArrowRight");
    expect(document.querySelector(".pw-cmp")).toBeNull();
    expect(modes().hidden).toBe(true);
    expect(document.querySelector(".pw-viewer-img")?.getAttribute("alt")).toBe("plain.png");
    // the way chosen comes back with the comparison
    key("ArrowRight");
    expect(document.querySelector(".pw-cmp.is-wipe")).not.toBeNull();
    key("1");
    expect(document.querySelector(".pw-cmp")).toBeNull();
    expect(document.querySelector<HTMLElement>(".pw-viewer-tabs")!.hidden).toBe(false);
  });
});
