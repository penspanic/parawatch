import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { answerCard, claimSession, closeCard, commentCard, editCard, openCard, readInbox, UserError, waitInbox } from "../src/core/ops.js";
import { desktopSessionUrl, findDesktopSession } from "../src/core/desktop.js";
import { recentlyClosed, snapshot } from "../src/core/snapshot.js";
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

  it("keeps the most recently closed cards in the snapshot only when asked", () => {
    ask("one");
    ask("two");
    ask("three");
    closeCard("c1");
    closeCard("c2");
    expect(snapshot().cards.map((c) => c.id)).toEqual(["c3"]);
    expect(snapshot({ closed: 1 }).cards.map((c) => c.id)).toHaveLength(2);
    expect(snapshot({ closed: 10 }).cards.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    const at = (id: string, closedAt: string) => ({ ...fold(readEvents()).cards.get(id)!, closedAt });
    expect(recentlyClosed([at("c1", "2026-01-02"), at("c2", "2026-01-03")], 1).map((c) => c.id)).toEqual(["c2"]);
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

/** tsx's own entry, run with this node: `node_modules/.bin/tsx` is a shell script on Windows. */
const TSX = path.resolve("node_modules/tsx/dist/cli.mjs");

describe("concurrent writers", () => {
  it("several processes appending at once keep every event and unique ids", async () => {
    const run = promisify(execFile);
    const cli = path.resolve("src/bin/cli.ts");
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => run(process.execPath, [TSX, cli, "block", "-p", "demo", `job ${i}`], { env: process.env })),
    );
    const cards = [...fold(readEvents()).cards.values()];
    expect(cards).toHaveLength(6);
    expect(new Set(cards.map((c) => c.id)).size).toBe(6);
    expect(readEvents().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 30_000);
});

describe("calling session", () => {
  it("claim and run start default to the agent session in the environment", async () => {
    const run = promisify(execFile);
    const cli = path.resolve("src/bin/cli.ts");
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "abcdef12-0000-4000-8000-000000000001" };
    await run(process.execPath, [TSX, cli, "claim", "-p", "demo", "--role", "lead"], { env });
    const { stdout } = await run(process.execPath, [TSX, cli, "run", "start", "-p", "demo", "CI"], { env });
    const state = fold(readEvents());
    expect(state.claims[0]).toMatchObject({ session: "abcdef12-0000-4000-8000-000000000001", project: "demo", role: "lead" });
    expect(state.runs.get(stdout.trim())?.parent).toBe("abcdef12-0000-4000-8000-000000000001");
  }, 30_000);
});

describe("card kinds, origin and editing", () => {
  it("records the asking session, names it from its claim and keeps when the matter came up", () => {
    claimSession({ session: "abcdef12", project: "demo", role: "lead", title: "Demo Director" });
    const c = openCard({ kind: "todo", project: "demo", title: "Check billing", session: "abcdef12-0000-4000-8000-000000000001", since: "2026-10-01" });
    expect(c).toMatchObject({ kind: "todo", from: "Demo Director", session: "abcdef12-0000-4000-8000-000000000001" });
    expect(new Date(c.since!).getDate()).toBe(1);
    expect(() => openCard({ kind: "todo", project: "demo", title: "x", since: "someday" })).toThrow(UserError);
  });

  it("edits kind and fields, and clears a field given an empty value", () => {
    openCard({ kind: "block", project: "demo", title: "Check billing", body: "Org settings" });
    const c = editCard("c1", { kind: "todo", since: "2026-10-01", body: "" });
    expect(c.kind).toBe("todo");
    expect(c.body).toBeUndefined();
    expect(c.since).toBeDefined();
    expect(fold(readEvents()).cards.get("c1")!.body).toBeUndefined();
    expect(() => editCard("c1", { kind: "later" as never })).toThrow(UserError);
    expect(() => editCard("c1", {})).toThrow(UserError);
  });
});

describe("desktop sessions", () => {
  it("finds the desktop session that runs a CLI session, preferring a live one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-desk-"));
    const sub = path.join(dir, "acct", "org");
    fs.mkdirSync(sub, { recursive: true });
    const write = (id: string, d: object) => fs.writeFileSync(path.join(sub, `${id}.json`), JSON.stringify({ sessionId: id, ...d }));
    write("local_old", { cliSessionId: "abcdef12-1", isArchived: true, lastActivityAt: 5 });
    write("local_live", { cliSessionId: "zzz", lastAssistantCliSessionId: "abcdef12-1", lastActivityAt: 1, title: "Director" });
    const s = findDesktopSession("abcdef12", dir)!;
    expect(s.id).toBe("local_live");
    expect(desktopSessionUrl(s)).toBe("claude://code/continue?session=local_live&source=parawatch");
    expect(findDesktopSession("nothere", dir)).toBeUndefined();
  });
});
