import { describe, expect, it } from "vitest";
import { boardModel } from "../src/board";
import type { Card, PrView, Run, Snapshot } from "../src/types";

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const card = (over: Partial<Card> & Pick<Card, "id">): Card => ({ kind: "decide", project: "app", title: over.id, status: "open", openedAt: ago(5), answers: [], comments: [], ...over });
const run = (over: Partial<Run> & Pick<Run, "id">): Run => ({ runtime: "claude-code", kind: "session", title: over.id, project: "app", state: "idle", lastActivity: ago(2), ...over });
const pr = (over: Partial<PrView> & Pick<PrView, "number">): PrView =>
  ({ key: `acme/app#${over.number}`, url: "u", repo: "acme/app", title: "t", state: "open", draft: false, waitingOn: "CI", since: ago(30), stalled: false, reviewRequested: false, mine: true, project: "app", ...over }) as PrView;
const snap = (over: Partial<Snapshot>): Snapshot => ({ v: 1, generatedAt: new Date(NOW).toISOString(), projects: [], cards: [], runs: [], prs: [], ...over }) as Snapshot;

const lines = (s: Snapshot) => Object.fromEntries(boardModel(s).tiles.flatMap((t) => [...t.rows, ...t.quiet]).map((r) => [r.title, `${r.mark}: ${r.note}`]));

describe("board", () => {
  it("marks each session by what it is stopped on, the most pressing first", () => {
    const s = snap({
      runs: [
        run({ id: "asker", state: "waiting" }),
        run({ id: "chat", asks: { text: "Which?", via: "text" } }),
        run({ id: "prompt", state: "waiting", asks: { text: "Bash", via: "permission" } }),
        run({ id: "hung", state: "stalled" }),
        run({ id: "stuck", state: "waiting" }),
        run({ id: "busy", state: "working" }),
        run({ id: "ci", state: "waiting" }),
        run({ id: "rest", state: "idle" }),
        run({ id: "over", state: "done", done: "Merged #3" }),
      ],
      cards: [card({ id: "c1", session: "asker" })],
      prs: [pr({ number: 1, session: "stuck", stalled: true }), pr({ number: 2, session: "ci" })],
    });
    expect(lines(s)).toEqual({
      asker: "you: 1 card",
      chat: "you: asked in chat",
      prompt: "you: approve a tool call",
      hung: "stopped: stalled",
      stuck: "stopped: #1 stuck",
      busy: "running: working",
      ci: "others: #2 CI",
      rest: "quiet: idle",
      over: "quiet: done",
    });
    const m = boardModel(s);
    expect(m.counts).toEqual({ you: 3, stopped: 2, running: 1, others: 1, quiet: 2 });
    expect(m.tiles[0]!.rows.map((r) => r.mark)).toEqual(["you", "you", "you", "stopped", "stopped", "running", "others"]);
    expect(m.tiles[0]!.quiet.map((r) => r.title).sort()).toEqual(["over", "rest"]);
  });

  it("folds subagents into their session: a working one keeps it running, a stalled one stops it", () => {
    const s = snap({
      runs: [
        run({ id: "lead", state: "waiting" }),
        run({ id: "sub1", kind: "subagent", parent: "lead", state: "working" }),
        run({ id: "boss", state: "idle" }),
        run({ id: "sub2", kind: "subagent", parent: "boss", state: "stalled" }),
      ],
    });
    expect(lines(s)).toEqual({ lead: "running: working", boss: "stopped: stalled" });
    const lead = boardModel(s).tiles[0]!.rows.find((r) => r.title === "lead")!;
    expect(lead.subs).toBe(1);
  });

  it("a card opened by a subagent belongs to its session", () => {
    const s = snap({ runs: [run({ id: "lead" }), run({ id: "sub", parent: "lead", kind: "subagent" })], cards: [card({ id: "c1", session: "sub" })] });
    expect(lines(s)).toEqual({ lead: "you: 1 card" });
  });

  it("what no session on the board holds gets its own line; one with no lead needs the human", () => {
    const s = snap({
      cards: [
        card({ id: "c1", session: "gone" }),
        card({ id: "c2", project: "tools", status: "answered", unrouted: true }),
        card({ id: "c3", project: "tools", kind: "todo" }),
      ],
      prs: [pr({ number: 5, project: "site" }), pr({ number: 6, project: "site", reviewRequested: true, mine: false })],
    });
    const m = boardModel(s);
    const by = Object.fromEntries(m.tiles.map((t) => [t.project, t.rows.map((r) => `${r.title} ${r.mark}: ${r.note}`)]));
    expect(by).toEqual({ app: ["No session you: 1 card"], tools: ["No session you: no lead"], site: ["No session others: 1 PR"] });
    expect(m.todo).toBe(1);
    expect(m.reviews.map((p) => p.number)).toEqual([6]);
  });

  it("projects that need the human come first, quiet ones last, Other after its peers", () => {
    const s = snap({
      runs: [
        run({ id: "a", project: "alpha", state: "idle" }),
        run({ id: "b", project: "beta", state: "working" }),
        run({ id: "o", project: undefined, state: "stalled" }),
        run({ id: "g", project: "gamma", state: "stalled" }),
      ],
      cards: [card({ id: "c1", project: "zeta" })],
    });
    expect(boardModel(s).tiles.map((t) => `${t.project}:${t.mark}`)).toEqual(["zeta:you", "gamma:stopped", "other:stopped", "beta:running", "alpha:quiet"]);
  });

  it("an empty or missing snapshot draws nothing", () => {
    expect(boardModel(undefined).tiles).toEqual([]);
    expect(boardModel(snap({})).tiles).toEqual([]);
  });
});
