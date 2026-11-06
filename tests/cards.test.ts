import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { answerCard, closeCard, commentCard, openCard, readInbox, UserError, waitInbox } from "../src/core/ops.js";
import { fold } from "../src/core/state.js";
import { readEvents } from "../src/core/store.js";
import { freshHome } from "./helpers.js";

beforeEach(() => {
  freshHome();
});

const ask = (title = "Which ending?") =>
  openCard({ kind: "decide", project: "demo", title, options: ["Side tank", "Top box"], recommend: 2 });

describe("cards", () => {
  it("numbers cards and folds answers into state", () => {
    const a = ask();
    const b = openCard({ kind: "try", project: "demo", title: "Try the build", open: ["/Applications/X.app"], look: "speed" });
    expect([a.id, b.id]).toEqual(["c1", "c2"]);
    answerCard("c1", { choice: 2, comment: "fill it to the rim" });
    const card = fold(readEvents()).cards.get("c1")!;
    expect(card.status).toBe("answered");
    expect(card.answers[0]).toMatchObject({ by: "human", choice: 2, comment: "fill it to the rim" });
    closeCard("c1", "done");
    expect(fold(readEvents()).cards.get("c1")!.status).toBe("closed");
  });

  it("rejects answers that do not fit the card", () => {
    ask();
    expect(() => answerCard("c1", { choice: 3 })).toThrow(UserError);
    expect(() => answerCard("c1", {})).toThrow(UserError);
    expect(() => answerCard("c9", { comment: "x" })).toThrow(UserError);
    expect(() => openCard({ kind: "decide", project: "demo", title: "x", options: ["a"], recommend: 2 })).toThrow(UserError);
  });
});

describe("inbox", () => {
  it("shows each human answer once per consumer", () => {
    ask();
    answerCard("c1", { choice: 1 });
    expect(readInbox("demo", { project: "demo" }, true)).toHaveLength(1);
    expect(readInbox("demo", { project: "demo" }, true)).toHaveLength(0);
    // another consumer has its own cursor
    expect(readInbox("other", { project: "demo" }, false)).toHaveLength(1);
  });

  it("ignores agent comments, other projects and closed cards", () => {
    ask();
    openCard({ kind: "block", project: "elsewhere", title: "Install Xcode" });
    commentCard("c1", "working on it", "agent");
    answerCard("c2", { comment: "done" });
    expect(readInbox("demo", { project: "demo" }, false)).toHaveLength(0);
    commentCard("c1", "also make it louder", "human");
    expect(readInbox("demo", { project: "demo" }, false)).toHaveLength(1);
    closeCard("c1");
    expect(readInbox("demo", { project: "demo" }, false)).toHaveLength(0);
  });

  it("wait returns as soon as the human answers", async () => {
    ask();
    setTimeout(() => answerCard("c1", { choice: 2 }), 150);
    const started = Date.now();
    const items = await waitInbox("demo", { project: "demo" }, 5000, 50);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "answer", choice: 2, choiceText: "Top box" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("wait times out with nothing", async () => {
    ask();
    expect(await waitInbox("demo", { project: "demo" }, 200, 50)).toEqual([]);
  });

  it("an answer given before the wait starts is not lost", async () => {
    ask();
    answerCard("c1", { choice: 1 });
    expect(await waitInbox("demo", { project: "demo" }, 200, 50)).toHaveLength(1);
  });
});

describe("concurrent writers", () => {
  it("several processes appending at once keep every event and unique ids", async () => {
    const run = promisify(execFile);
    const cli = path.resolve("src/bin/cli.ts");
    const tsx = path.resolve("node_modules/.bin/tsx");
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => run(tsx, [cli, "block", "-p", "demo", `job ${i}`], { env: process.env })),
    );
    const cards = [...fold(readEvents()).cards.values()];
    expect(cards).toHaveLength(6);
    expect(new Set(cards.map((c) => c.id)).size).toBe(6);
    expect(readEvents().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 30_000);
});
