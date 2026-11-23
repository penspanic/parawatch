import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshHome } from "./helpers.js";
import { attachLines, buildMedia, mediaHints, parseAttach } from "../src/core/media.js";
import { editCard, openCard, readState } from "../src/core/ops.js";

let home = "";
beforeEach(() => {
  home = freshHome();
});

describe("captions on attachments", () => {
  it("reads caption=file, and a plain file as before", () => {
    expect(parseAttach("Now=/abs/now.png")).toEqual({ file: "/abs/now.png", caption: "Now" });
    expect(parseAttach("Ring removed=C:\\\\shots\\\\ring.png")).toEqual({ file: "C:\\\\shots\\\\ring.png", caption: "Ring removed" });
    expect(parseAttach("Before=https://example.com/a.png")).toEqual({ file: "https://example.com/a.png", caption: "Before" });
    expect(parseAttach("/abs/plain.png")).toEqual({ file: "/abs/plain.png" });
    // a = that is not followed by a path is part of the file name
    expect(parseAttach("shots/a=b.png")).toEqual({ file: "shots/a=b.png" });
  });

  it("keeps a file whose own name holds = when it exists", () => {
    const f = path.join(home, "x=y.png");
    fs.writeFileSync(f, "x");
    expect(parseAttach(f)).toEqual({ file: f });
  });

  it("points at attachments by place, caption or file name, and says which names there are", () => {
    const specs = [{ file: "/a/now.png", caption: "Now" }, { file: "/a/after.png", caption: "After" }, { file: "/a/plain.png" }];
    expect(buildMedia(specs, { compare: ["Now,after"], optionAttach: ["2=3", "1=now"], grid: 2 }, 2)).toEqual({
      captions: ["Now", "After", null],
      compare: [[0, 1]],
      options: [1, null, 2],
      grid: 2,
    });
    expect(buildMedia(specs, { compare: ["plain.png,1"] }, 0)?.compare).toEqual([[2, 0]]);
    expect(() => buildMedia(specs, { compare: ["Now,Later"] }, 0)).toThrow(/no attachment "Later".*1 \(Now\), 2 \(After\), 3/);
    expect(() => buildMedia(specs, { compare: ["Now"] }, 0)).toThrow(/two or more/);
    expect(() => buildMedia(specs, { compare: ["1,2", "2,3"] }, 0)).toThrow(/in two comparisons/);
    expect(() => buildMedia(specs, { optionAttach: ["3=1"] }, 2)).toThrow(/between 1 and 2/);
    expect(() => buildMedia(specs, { optionAttach: ["1=1"] }, 0)).toThrow(/needs choices/);
    expect(() => buildMedia(specs, { grid: 9 }, 0)).toThrow(/1 to 6/);
    expect(buildMedia([{ file: "/a.png" }], {}, 0)).toBeUndefined();
  });

  it("hints when pictures have no captions", () => {
    const two = ["/a/1.png", "/a/2.png"];
    expect(mediaHints({ id: "c1", attach: two })[0]).toMatch(/2 of 2 pictures.*parawatch edit c1 --attach/);
    expect(mediaHints({ id: "c1", attach: two, media: { captions: ["A", "B"] } })).toEqual([]);
    expect(mediaHints({ id: "c1", attach: ["/a/1.png", "/a/log.txt"] })).toEqual([]);
    expect(mediaHints({ id: "c1", attach: two, options: ["A", "B"], media: { captions: ["A", "B"] } })[0]).toMatch(/--option-attach/);
  });

  it("text views name each attachment with its caption, choice and comparison", () => {
    expect(attachLines(["/a/1.png", "/a/2.png"], { captions: ["Now", null], options: [null, 2], compare: [[0, 1]] })).toEqual(["Now: /a/1.png [compare 1]", "/a/2.png [choice 2, compare 1]"]);
  });
});

describe("cards keep their layout", () => {
  it("opens with captions and keeps them by place, not by path", () => {
    const c = openCard({ kind: "decide", project: "app", title: "Halo?", options: ["Outline", "Keep"], attach: ["Now=/x/now.png", "Outline=/x/outline.png"], compare: ["Now,Outline"], optionAttach: ["1=Outline"] });
    expect(c.attach).toEqual(["/x/now.png", "/x/outline.png"]);
    expect(c.media).toEqual({ captions: ["Now", "Outline"], compare: [[0, 1]], options: [null, 1] });
  });

  it("an edit of the layout alone keeps the files and captions; new files replace them all", () => {
    const c = openCard({ kind: "try", project: "app", title: "Look", attach: ["Now=/x/now.png", "After=/x/after.png"] });
    const grid = editCard(c.id, { grid: 2 });
    expect(grid.media).toEqual({ captions: ["Now", "After"], grid: 2 });
    const cmp = editCard(c.id, { compare: ["1,2"] });
    expect(cmp.media).toEqual({ captions: ["Now", "After"], compare: [[0, 1]], grid: 2 });
    expect(editCard(c.id, { grid: 0 }).media).toEqual({ captions: ["Now", "After"], compare: [[0, 1]] });
    const plain = editCard(c.id, { attach: ["/x/only.png"] });
    expect(plain.attach).toEqual(["/x/only.png"]);
    expect(plain.media).toBeUndefined();
    expect(readState().cards.get(c.id)?.media).toBeUndefined();
  });

  it("refuses a layout change once the human has answered", async () => {
    const { answerCard } = await import("../src/core/ops.js");
    const c = openCard({ kind: "try", project: "app", title: "Look", attach: ["A=/x/a.png", "B=/x/b.png"] });
    answerCard(c.id, { comment: "fine" });
    expect(() => editCard(c.id, { grid: 2 })).toThrow(/already answered/);
  });
});
