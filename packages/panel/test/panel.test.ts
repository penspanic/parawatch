// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { layoutMedia, Panel, spanLabel } from "../src/panel";
import type { Backend, Card, DeployView, InboxThread, IssueView, NewsItem, PrView, Run, Snapshot } from "../src/types";

/**
 * The panel as the human sees it: a snapshot goes in, and the sections, counts and buttons that
 * come out are checked in the DOM. Layout and color are left to the harness.
 */
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function card(over: Partial<Card> & Pick<Card, "id" | "title">): Card {
  return { kind: "decide", project: "app", status: "open", openedAt: ago(5), answers: [], comments: [], ...over };
}

function run(over: Partial<Run> & Pick<Run, "id" | "title">): Run {
  return { runtime: "claude-code", kind: "session", project: "app", state: "working", lastActivity: ago(1), activity: [0, 1, 2], ...over };
}

function pr(over: Partial<PrView> & Pick<PrView, "number" | "title">): PrView {
  const n = over.number;
  return {
    key: `github.com/acme/app#${n}`,
    url: `https://github.com/acme/app/pull/${n}`,
    repo: "acme/app",
    state: "open",
    draft: false,
    waitingOn: "CI",
    since: ago(30),
    stalled: false,
    reviewRequested: false,
    mine: true,
    project: "app",
    ...over,
  } as PrView;
}

function issue(over: Partial<IssueView> & Pick<IssueView, "number" | "title">): IssueView {
  const n = over.number;
  return { key: `github.com/kim/game#${n}`, url: `https://github.com/kim/game/issues/${n}`, repo: "kim/game", assignedBy: "kim", assignedAt: ago(60 * 24 * 3), aside: false, ...over };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return { v: 1, generatedAt: new Date(NOW).toISOString(), projects: [], cards: [], runs: [], prs: [], ...over } as Snapshot;
}

let root: HTMLElement;
let backend: { [K in keyof Backend]: ReturnType<typeof vi.fn> };
let notices: string[];

function mount(s: Snapshot): Panel {
  const p = new Panel(root, backend as unknown as Backend, {
    renderMarkdown: (md, el) => {
      el.textContent = md;
    },
    icon: (el, name) => {
      el.dataset.icon = name;
    },
    notice: (m) => notices.push(m),
    refresh: () => {},
  });
  p.update(s);
  return p;
}

const sec = (key: string) => root.querySelector<HTMLElement>(`[data-sec="${key}"]`);
const badgeIn = (el: Element | null, icon: string) => el?.querySelector<HTMLElement>(`.pw-badge [data-icon="${icon}"]`)?.parentElement?.querySelector(".pw-badge-n")?.textContent;
const head = () => root.querySelector(".pw-head")!;

beforeEach(() => {
  document.body.innerHTML = '<div id="panel"></div>';
  root = document.getElementById("panel")!;
  // Node's own localStorage shadows the DOM's in this environment; the panel only needs these three
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  notices = [];
  backend = {
    snapshot: vi.fn(),
    answer: vi.fn(async () => {}),
    goto: vi.fn(async () => "Opened"),
    dismiss: vi.fn(async () => {}),
    lead: vi.fn(async () => {}),
    hideRun: vi.fn(async () => {}),
    open: vi.fn(),
    mediaUrl: vi.fn(async () => undefined),
    saveAttachment: vi.fn(async () => "/tmp/x.png"),
    droppedPath: vi.fn(() => undefined),
    targetMenu: vi.fn(),
    siteIcon: vi.fn(async () => undefined),
  };
});

describe("panel", () => {
  it("says nothing needs you when nothing does", () => {
    mount(snapshot());
    expect(root.querySelector(".pw-all-clear")?.getAttribute("aria-label")).toBe("Nothing needs you");
    expect(badgeIn(head(), "inbox")).toBe("0");
  });

  it("groups open cards by project, blocked first, with to-dos folded under them", () => {
    mount(
      snapshot({
        cards: [
          card({ id: "c1", title: "Pick a name?" }),
          card({ id: "c2", title: "Sign in to the store", kind: "block" }),
          card({ id: "c3", title: "Renew the domain", kind: "todo" }),
          card({ id: "c4", title: "Try the build", kind: "try", project: "game" }),
        ],
      }),
    );
    expect(badgeIn(head(), "inbox")).toBe("3");
    expect(badgeIn(head(), "list-checks")).toBe("1");
    const app = sec("cards:app")!;
    const titles = [...app.querySelectorAll(":scope > .pw-fold-body > .pw-card .pw-card-title")].map((t) => t.textContent);
    expect(titles).toEqual(["Sign in to the store", "Pick a name?"]);
    expect(sec("todo:app")?.classList.contains("is-collapsed")).toBe(true);
    expect(sec("cards:game")?.textContent).toContain("Try the build");
  });

  it("a click on an option sends that choice", async () => {
    mount(snapshot({ cards: [card({ id: "c1", title: "Ship?", options: ["Ship", "Wait"], recommend: 1 })] }));
    const opts = [...root.querySelectorAll<HTMLButtonElement>(".pw-option")];
    expect(opts.map((o) => o.querySelector(".pw-option-text")?.textContent)).toEqual(["Ship", "Wait"]);
    expect(opts[0]!.classList.contains("is-recommended")).toBe(true);
    opts[1]!.click();
    await vi.waitFor(() => expect(backend.answer).toHaveBeenCalledWith("c1", { choice: 2 }));
    await vi.waitFor(() => expect(notices[0]).toContain("Sent to app"));
  });

  it("what to look at goes through Markdown, a one-line numbered list broken into lines", () => {
    mount(snapshot({ cards: [card({ id: "c1", kind: "try", title: "Try build 139", look: "1) the camera 2) the hand 3) the pocket" })] }));
    const look = root.querySelector(".pw-look-text");
    expect(look?.classList.contains("markdown-rendered")).toBe(true);
    expect(look?.textContent).toBe("1) the camera\n2) the hand\n3) the pocket");
  });

  it("pictures carry their captions and choices; a comparison is one cell with a tab for each", async () => {
    backend.mediaUrl.mockImplementation(async (f: string) => `blob:${f}`);
    const attach = ["/c/now.png", "/c/ring.png", "/c/outline.png", "/c/plain.png"];
    mount(
      snapshot({
        cards: [
          card({
            id: "c1",
            title: "Which halo?",
            options: ["Outline", "Ring removed"],
            attach,
            media: { captions: ["Now", "Ring removed", "Outline", null], options: [null, 2, 1, null], compare: [[0, 1, 2]], grid: 2 },
          }),
        ],
      }),
    );
    const row = root.querySelector<HTMLElement>(".pw-media")!;
    expect(row.classList.contains("is-grid")).toBe(true);
    const cells = [...row.querySelectorAll<HTMLElement>(":scope > .pw-media-item")];
    // the comparison takes the place of its first picture; the plain one has no strip
    expect(cells.length).toBe(2);
    const tabs = [...cells[0]!.querySelectorAll<HTMLButtonElement>(".pw-media-tab")];
    expect(tabs.map((t) => t.textContent)).toEqual(["Now", "2Ring removed", "1Outline"]);
    expect(cells[1]!.querySelector(".pw-media-foot")).toBeNull();
    await vi.waitFor(() => expect(cells[0]!.querySelectorAll("img").length).toBe(3));
    const shown = () => [...cells[0]!.querySelectorAll("img")].findIndex((i) => !i.hidden);
    expect(shown()).toBe(0);
    tabs[2]!.click();
    expect(shown()).toBe(2);
    // pointing at a choice lights its pictures and flips the comparison to it, and back after
    tabs[0]!.click();
    const opts = [...root.querySelectorAll<HTMLButtonElement>(".pw-option")];
    expect(opts.map((o) => o.classList.contains("has-media"))).toEqual([true, true]);
    opts[1]!.dispatchEvent(new Event("mouseenter"));
    expect(shown()).toBe(1);
    expect(cells[0]!.classList.contains("is-lit")).toBe(true);
    expect(cells[1]!.classList.contains("is-dim")).toBe(true);
    opts[1]!.dispatchEvent(new Event("mouseleave"));
    expect(shown()).toBe(0);
    expect(cells[1]!.classList.contains("is-dim")).toBe(false);

    // the comparison opens all at once in the viewer; a lone picture has no such button
    expect(cells[1]!.querySelector(".pw-media-compare")).toBeNull();
    cells[0]!.querySelector<HTMLButtonElement>(".pw-media-compare")!.click();
    const viewer = document.querySelector(".pw-viewer")!;
    expect([...viewer.querySelectorAll(".pw-cmp.is-side .pw-cmp-label")].map((l) => l.textContent)).toEqual(["Now", "2 · Ring removed", "1 · Outline"]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("a single picture with a caption shows it under the picture, with its choice", async () => {
    backend.mediaUrl.mockImplementation(async (f: string) => `blob:${f}`);
    mount(snapshot({ cards: [card({ id: "c1", title: "Ending?", options: ["Side", "Top"], attach: ["/c/side.png", "/c/top.png"], media: { captions: ["Side tank", "Top box"], options: [1, 2] } })] }));
    const feet = [...root.querySelectorAll(".pw-media-foot")].map((f) => f.textContent);
    expect(feet).toEqual(["1Side tank", "2Top box"]);
    await vi.waitFor(() => expect(root.querySelector<HTMLImageElement>(".pw-media-img")?.alt).toBe("Side tank"));
  });

  it("a file the card names says whether it is on its way or stays on the machine that asked", () => {
    const shared = "/Users/me/agent-sync/parawatch/attachments/a.png";
    const pc = "E:\\dev\\game\\run.cmd";
    mount(snapshot({ cards: [card({ id: "pc-c1", kind: "try", title: "Try it", dev: "pc", open: [pc], attach: [shared], missing: [pc, shared], away: [pc] })] }));
    const links = [...root.querySelectorAll(".pw-file.is-missing")].map((b) => b.textContent);
    expect(links).toEqual(["run.cmd · on pc", "a.png · not on this machine yet"]);
    root.querySelector<HTMLButtonElement>(".pw-file.is-missing")!.click();
    expect(notices.at(-1)).toMatch(/only on pc/);
  });

  it("answered cards wait on the agent; those no session gets have their own group and a Help button", async () => {
    const answered = { status: "answered" as const, answers: [{ seq: 2, at: ago(1), by: "human", choice: 1 }], options: ["Yes"] };
    mount(
      snapshot({
        cards: [card({ id: "c1", title: "Mine?", session: "s-work", ...answered }), card({ id: "c2", title: "Loose?", project: "tools", unrouted: true, ...answered })],
        runs: [run({ id: "s-docs", title: "Docs cleanup", project: "tools", state: "idle" })],
      }),
    );
    expect(sec("answered")?.textContent).toContain("Mine?");
    expect(sec("answered")?.textContent).not.toContain("Loose?");
    const stranded = sec("stranded")!;
    expect(stranded.textContent).toContain("Loose?");
    expect(badgeIn(head(), "life-buoy")).toBe("1");

    stranded.querySelector<HTMLButtonElement>(".pw-help-btn")!.click();
    const help = await vi.waitFor(() => {
      const h = sec("stranded")!.querySelector(".pw-lead-help");
      if (!h) throw new Error("no help yet");
      return h;
    });
    expect(help.querySelector(".pw-lead-name")?.textContent).toBe("Docs cleanup");
    help.querySelector<HTMLButtonElement>(".pw-lead-pick")!.click();
    await vi.waitFor(() => expect(backend.lead).toHaveBeenCalledWith("tools", "s-docs"));
  });

  it("an open card no session will get says so, with Help", () => {
    mount(snapshot({ cards: [card({ id: "c1", title: "Loose?", unrouted: true })] }));
    const line = root.querySelector(".pw-no-session");
    expect(line?.textContent).toContain("No session gets your answer");
    expect(line?.querySelector(".pw-help-btn")).not.toBeNull();
  });

  it("pull requests: reviews asked of you on top, the rest waiting on others, stuck ones counted", () => {
    mount(
      snapshot({
        prs: [
          pr({ number: 1, title: "Pricing copy", reviewRequested: true, mine: false, waitingOn: "review" }),
          pr({ number: 2, title: "Fast export", waitingOn: "CI failed" }),
          pr({ number: 3, title: "Settings", waitingOn: "review", stalled: true, since: ago(26 * 60) }),
        ],
      }),
    );
    expect(sec("reviews")?.textContent).toContain("Pricing copy");
    const waiting = sec("waiting")!;
    expect(waiting.textContent).toContain("Fast export");
    expect(waiting.textContent).not.toContain("Pricing copy");
    expect(badgeIn(waiting.querySelector(".pw-fold-head"), "clock")).toBe("1");
    expect(badgeIn(head(), "eye")).toBe("1");
    expect(badgeIn(head(), "git-pull-request")).toBe("2");
  });

  it("a session that asked in chat, or waits on a permission prompt, shows outside the cards", () => {
    mount(
      snapshot({
        runs: [
          run({ id: "s1", title: "Spill review", state: "idle", asks: { text: "Use the corner shop first?", via: "text" } }),
          run({ id: "s2", title: "Ticket 2207", state: "waiting", asks: { text: "Bash: move the file", via: "permission", blocked: true } }),
        ],
      }),
    );
    const asks = sec("asks")!;
    expect(asks.querySelectorAll(".pw-ask")).toHaveLength(2);
    expect(asks.textContent).toContain("Use the corner shop first?");
    expect(asks.querySelector(".pw-ask.is-blocked")?.textContent).toContain("Ticket 2207");
    asks.querySelector<HTMLAnchorElement>(".pw-ask-who")!.click();
    expect(backend.goto).toHaveBeenCalledWith("s1");
  });

  it("the agent chart groups runs by project and counts the working ones", () => {
    mount(
      snapshot({
        runs: [
          run({ id: "a1", title: "App Director", role: "lead" }),
          run({ id: "a2", title: "Settings screen", state: "stalled" }),
          run({ id: "g1", title: "Shake test", project: "game" }),
          run({ id: "o1", title: "Notes", project: undefined, state: "idle" }),
        ],
      }),
    );
    expect(badgeIn(head(), "activity")).toBe("2");
    const app = sec("agents:app")!;
    expect(app.textContent).toContain("App Director");
    expect(app.textContent).toContain("Settings screen");
    expect(sec("agents:game")?.textContent).toContain("Shake test");
    expect(root.querySelector('[data-sec^="agents:"]:last-of-type')?.textContent).toContain("Notes");
  });

  it("a GitHub reader that fails is shown, since pull request news stops for everyone", () => {
    mount(snapshot({ github: { enabled: true, failing: true, fetchedAt: ago(70), failedBy: "the desktop app", error: "gh not found" } } as Partial<Snapshot>));
    expect(root.querySelector(".pw-error-title")?.textContent).toBe("GitHub is not being read");
    expect(root.querySelector(".pw-error-text")?.textContent).toContain("The desktop app failed: gh not found");
  });

  it("a fold the human closed stays closed across redraws", () => {
    const s = snapshot({ cards: [card({ id: "c1", title: "A?" })] });
    const p = mount(s);
    sec("cards:app")!.querySelector<HTMLElement>(".pw-fold-head")!.click();
    expect(sec("cards:app")!.classList.contains("is-collapsed")).toBe(true);
    p.update({ ...s, cards: [...s.cards, card({ id: "c2", title: "B?" })] });
    expect(sec("cards:app")!.classList.contains("is-collapsed")).toBe(true);
  });
});

describe("board and feed", () => {
  const busy = () =>
    snapshot({
      runs: [run({ id: "a1", title: "App Director", state: "waiting" }), run({ id: "a2", title: "Settings screen", state: "stalled" })],
      cards: [card({ id: "c1", title: "Ship?", session: "a1", options: ["Ship"] })],
    });
  const viewBtn = () => root.querySelector<HTMLButtonElement>(".pw-view-btn");

  it("a narrow window shows the feed, and one button switches to the board and back, remembered", () => {
    mount(busy());
    expect(root.classList.contains("pw-view-feed")).toBe(true);
    viewBtn()!.click();
    expect(root.classList.contains("pw-view-board")).toBe(true);
    expect(window.localStorage.getItem("parawatch:view")).toBe("board");
    const rows = [...root.querySelectorAll(".pw-board .pw-br")].map((r) => `${r.querySelector(".pw-br-title")?.textContent} ${r.getAttribute("data-mark")}`);
    expect(rows).toEqual(["App Director you", "Settings screen stopped"]);
    viewBtn()!.click();
    expect(root.classList.contains("pw-view-feed")).toBe(true);
  });

  it("a card chip on the board goes to the card in the feed", () => {
    window.localStorage.setItem("parawatch:view", "board");
    mount(busy());
    root.querySelector<HTMLButtonElement>(".pw-br .pw-lane-card")!.click();
    expect(root.classList.contains("pw-view-feed")).toBe(true);
  });

  it("the summary filters the board to one kind of line", () => {
    window.localStorage.setItem("parawatch:view", "board");
    mount(busy());
    const stopped = root.querySelector<HTMLButtonElement>(".pw-board-count.pw-mark-stopped")!;
    expect(stopped.querySelector(".pw-board-n")?.textContent).toBe("1");
    stopped.click();
    expect([...root.querySelectorAll(".pw-board .pw-br-title")].map((t) => t.textContent)).toEqual(["Settings screen"]);
    root.querySelector<HTMLButtonElement>(".pw-board-count.pw-mark-stopped")!.click();
    expect(root.querySelectorAll(".pw-board .pw-br")).toHaveLength(2);
  });

  it("a wide window shows both side by side, with no switch", () => {
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 1400 });
    mount(busy());
    expect(root.classList.contains("pw-split")).toBe(true);
    expect(root.classList.contains("pw-view-board") || root.classList.contains("pw-view-feed")).toBe(false);
    expect(viewBtn()).toBeNull();
    expect(root.querySelector(".pw-board .pw-br")).not.toBeNull();
    expect(root.querySelector(".pw-feed .pw-card")).not.toBeNull();
  });
});

describe("opening a session", () => {
  const links = () => Object.fromEntries([...root.querySelectorAll(".pw-run-title")].map((t) => [t.textContent, t.classList.contains("is-link")]));

  it("links a session here, one elsewhere only with a Remote Control link, and a subagent through its session", () => {
    mount(
      snapshot({
        runs: [
          run({ id: "here", title: "Here" }),
          run({ id: "sub", title: "Its subagent", kind: "subagent", parent: "here" }),
          run({ id: "pc", title: "Spill Director", device: "winpc", remote: "https://claude.ai/code/session_01ABC" }),
          run({ id: "pc-sub", title: "206 bottle shop", kind: "subagent", parent: "pc", device: "winpc" }),
          run({ id: "pc-bare", title: "No remote", device: "winpc" }),
          run({ id: "job", title: "Bench", kind: "declared", runtime: "declared" }),
        ],
      }),
    );
    expect(links()).toEqual({ Here: true, "Its subagent": true, "Spill Director": true, "206 bottle shop": true, "No remote": false, Bench: false });
    const sub = [...root.querySelectorAll<HTMLElement>(".pw-run-title")].find((t) => t.textContent === "206 bottle shop")!;
    expect(sub.title).toBe("Open Spill Director, the session it works under, on winpc, through Remote Control");
    sub.click();
    expect(backend.goto).toHaveBeenCalledWith("pc-sub");
  });

  it("a card asked on another machine opens its session there through Remote Control, and only then", async () => {
    mount(
      snapshot({
        devices: { me: "mac", others: ["winpc"] },
        cards: [
          card({ id: "winpc-c1", title: "Why the tower falls", dev: "winpc", session: "pc", from: "Spill Director" }),
          card({ id: "winpc-c2", title: "No link", dev: "winpc", session: "pc-bare", from: "No remote" }),
        ],
        runs: [
          run({ id: "pc", title: "Spill Director", device: "winpc", remote: "https://claude.ai/code/session_01ABC" }),
          run({ id: "pc-bare", title: "No remote", device: "winpc" }),
        ],
      } as Partial<Snapshot>),
    );
    const from = Object.fromEntries([...root.querySelectorAll<HTMLElement>(".pw-from")].map((f) => [f.textContent, f.tagName]));
    expect(from).toEqual({ "Spill Director on winpc": "A", "No remote on winpc": "SPAN" });
    const link = [...root.querySelectorAll<HTMLElement>("a.pw-from")][0]!;
    expect(link.title).toContain("through Remote Control");
    link.click();
    expect(backend.goto).toHaveBeenCalledWith("winpc-c1");
    await new Promise((r) => setTimeout(r, 0));
    expect(notices.at(-1)).toContain("A line about winpc-c1 is on your clipboard");
  });

  it("shows a session's name and the work it claimed, either one, or both", () => {
    const director = run({ id: "pc", title: "Model and launch", name: "Spill Director", work: "Model and launch", device: "winpc", remote: "https://claude.ai/code/session_01ABC", role: "lead" });
    const plain = run({ id: "here", title: "Here" });
    const p = mount(snapshot({ runs: [director, plain] }));
    const shown = () => [...root.querySelectorAll<HTMLElement>(".pw-run-title")].map((t) => [t.querySelector(".pw-name-main")?.textContent ?? t.textContent, t.querySelector(".pw-name-work")?.textContent]);
    expect(shown()).toEqual([
      ["Spill Director", "Model and launch"],
      ["Here", undefined],
    ]);
    p.setRunTitles("name");
    expect(shown()).toEqual([
      ["Spill Director", undefined],
      ["Here", undefined],
    ]);
    p.setRunTitles("work");
    expect(shown()).toEqual([
      ["Model and launch", undefined],
      ["Here", undefined],
    ]);
  });

  it("the board links the same way", () => {
    window.localStorage.setItem("parawatch:view", "board");
    mount(snapshot({ runs: [run({ id: "pc", title: "Spill Director", device: "winpc", remote: "https://claude.ai/code/session_01ABC" }), run({ id: "pc-bare", title: "No remote", device: "winpc" })] }));
    const titles = Object.fromEntries([...root.querySelectorAll(".pw-board .pw-br-title")].map((t) => [t.textContent, t.tagName]));
    expect(titles).toEqual({ "Spill Director": "A", "No remote": "SPAN" });
  });

  it("the chart reaches back as far as the human picks on its axis, remembered", () => {
    const runs = [run({ id: "r1", title: "Long job", activity: [0, 1, 100, 101, 300] })];
    mount(snapshot({ runs }));
    const lane = () => root.querySelector(".pw-run .pw-lane")!;
    const pick = () => root.querySelector<HTMLSelectElement>(".pw-axis .pw-span")!;
    expect(pick().value).toBe("60");
    expect(lane().querySelectorAll("i")).toHaveLength(1);
    pick().value = "360";
    pick().dispatchEvent(new Event("change"));
    expect(lane().querySelectorAll("i")).toHaveLength(3);
    expect([...root.querySelectorAll(".pw-axis > span")].map((e) => e.textContent)).toEqual(["−3h", "now"]);
    expect(window.localStorage.getItem("parawatch:chart-span")).toBe("360");
    mount(snapshot({ runs }));
    expect(pick().value).toBe("360");
    expect(spanLabel(30)).toBe("30m");
    expect(spanLabel(90)).toBe("90m");
    expect(spanLabel(720)).toBe("12h");
  });

  it("the divider between names and lanes moves, is remembered, and resets on a double click", () => {
    mount(snapshot({ runs: [run({ id: "r1", title: "Job" })] }));
    const chart = () => root.querySelector<HTMLElement>(".pw-agents")!;
    const bar = () => root.querySelector<HTMLElement>(".pw-divider")!;
    expect(chart().style.getPropertyValue("--pw-who-f")).toBe("0.42");
    for (let i = 0; i < 5; i++) bar().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(Number(chart().style.getPropertyValue("--pw-who-f"))).toBeCloseTo(0.32);
    expect(window.localStorage.getItem("parawatch:chart-names")).toBe("0.320");
    // it never squeezes either side away
    for (let i = 0; i < 40; i++) bar().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(Number(chart().style.getPropertyValue("--pw-who-f"))).toBeCloseTo(0.15);
    mount(snapshot({ runs: [run({ id: "r1", title: "Job" })] }));
    expect(Number(chart().style.getPropertyValue("--pw-who-f"))).toBeCloseTo(0.15);
    bar().dispatchEvent(new MouseEvent("dblclick"));
    expect(chart().style.getPropertyValue("--pw-who-f")).toBe("0.42");
  });

  it("issues assigned to the human show with who gave them, fold aside, and come back", async () => {
    backend.issueAside = vi.fn(async () => {});
    const s = snapshot({
      issues: [
        issue({ number: 21, title: "Wreck interior", lastOther: { by: "kim", at: ago(60) }, project: "scuba" }),
        issue({ number: 22, title: "Fan worm" }),
        issue({ number: 18, title: "Rusty modules", aside: true }),
      ],
    });
    mount(s);
    expect(badgeIn(head(), "circle-dot")).toBe("2");
    const group = sec("assigned")!;
    const rows = () => [...group.querySelectorAll<HTMLElement>(".pw-issue")];
    expect(rows().map((r) => r.dataset.issue)).toEqual(["github.com/kim/game#21", "github.com/kim/game#22"]);
    // the newer word from someone else shows over who assigned it
    expect(rows()[0]!.querySelector(".pw-pr-wait")?.textContent).toBe("kim wrote");
    expect(rows()[1]!.querySelector(".pw-pr-wait")?.textContent).toBe("from kim");
    expect(rows()[0]!.textContent).toContain("scuba");
    rows()[1]!.querySelector<HTMLElement>(".pw-pr-label")!.click();
    expect(backend.open).toHaveBeenCalledWith("https://github.com/kim/game/issues/22");
    rows()[1]!.querySelector<HTMLButtonElement>(".pw-issue-aside")!.click();
    expect(backend.issueAside).toHaveBeenCalledWith("github.com/kim/game#22", true);
    // the one set aside waits behind a line, with a way back
    const more = group.querySelector<HTMLButtonElement>(".pw-issue-more")!;
    expect(more.textContent).toBe("1 set aside");
    more.click();
    const back = sec("assigned")!.querySelector<HTMLElement>('.pw-issue.is-aside .pw-issue-aside')!;
    expect(back.title).toBe("Bring back");
    back.click();
    expect(backend.issueAside).toHaveBeenCalledWith("github.com/kim/game#18", false);
  });

  it("a deployment waiting for the human is approved with a second press that names where it goes", async () => {
    let done!: () => void;
    backend.deployDecide = vi.fn(() => new Promise<void>((r) => (done = r)));
    const d: DeployView = { key: "github.com/kim/game/actions/runs/7", url: "https://github.com/kim/game/actions/runs/7", repo: "kim/game", run: 7, workflow: "Deploy", title: "Release 0.3.29", environments: ["production"], startedBy: "me", since: ago(90) };
    mount(snapshot({ deploys: [d] }));
    expect(badgeIn(head(), "rocket")).toBe("1");
    const row = () => sec("deploys")!.querySelector<HTMLElement>(".pw-deploy")!;
    expect(row().querySelector(".pw-pr-label")?.textContent).toBe("game production");
    expect(row().querySelector(".pw-pr-wait")?.textContent).toBe("Deploy by me");
    const buttons = () => [...row().querySelectorAll<HTMLButtonElement>(".pw-deploy-btn")];
    expect(buttons().map((b) => b.textContent)).toEqual(["Approve", "Reject"]);
    buttons()[0]!.click();
    expect(backend.deployDecide).not.toHaveBeenCalled();
    expect(buttons().map((b) => b.textContent)).toEqual(["Deploy to production", "Cancel"]);
    buttons()[1]!.click();
    expect(buttons().map((b) => b.textContent)).toEqual(["Approve", "Reject"]);
    buttons()[0]!.click();
    buttons()[0]!.click();
    expect(backend.deployDecide).toHaveBeenCalledWith(d.key, "approved");
    expect(row().textContent).toContain("Approving…");
    done();
    // the next snapshot no longer has it
    await Promise.resolve();
    mount(snapshot({ deploys: [] }));
    expect(sec("deploys")).toBeNull();
  });

  it("a deployment that comes or goes redraws the list", () => {
    const d: DeployView = { key: "k", url: "https://x", repo: "kim/game", run: 7, workflow: "Deploy", title: "R", environments: ["production"], since: ago(5) };
    const p = mount(snapshot());
    expect(sec("deploys")).toBeNull();
    p.update(snapshot({ deploys: [d] }));
    expect(sec("deploys")).not.toBeNull();
    p.update(snapshot({ deploys: [] }));
    expect(sec("deploys")).toBeNull();
  });

  it("a deployment the phone asked about says which machine carries it out, and why it could not", () => {
    const d: DeployView = { key: "k", url: "https://x", repo: "kim/game", run: 7, workflow: "Deploy", title: "R", environments: ["production"], since: ago(5) };
    backend.deployDecide = vi.fn(async () => {});
    mount(snapshot({ deploys: [{ ...d, asking: { decision: "approved", to: "mac", at: ago(1) } }] }));
    expect(sec("deploys")!.textContent).toContain("Approving on mac…");
    expect(sec("deploys")!.querySelector(".pw-deploy-btn")).toBeNull();
    mount(snapshot({ deploys: [{ ...d, error: "HTTP 422" }] }));
    expect(sec("deploys")!.textContent).toContain("Not done: HTTP 422");
  });

  it("a host that cannot set issues aside shows them without the button", () => {
    mount(snapshot({ issues: [issue({ number: 5, title: "Fix it" })] }));
    expect(sec("assigned")!.querySelector(".pw-issue-aside")).toBeNull();
  });

  it("notifications from people show why they came, open the page, and mark read", async () => {
    backend.inboxDone = vi.fn(async () => {});
    const thread = (id: string, over: Partial<InboxThread> = {}): InboxThread => ({ key: `github.com:${id}`, host: "github.com", id, repo: "kim/game", kind: "issue", number: Number(id), title: `Thread ${id}`, reason: "mention", by: "kim", url: `https://github.com/kim/game/issues/${id}`, at: ago(30), ...over });
    mount(snapshot({ inbox: [thread("21"), thread("22", { reason: "author", by: "lee", kind: "pr", url: "https://github.com/kim/game/pull/22" })] }));
    expect(badgeIn(head(), "bell")).toBe("2");
    const rows = [...sec("inbox")!.querySelectorAll<HTMLElement>(".pw-inbox")];
    expect(rows.map((r) => r.querySelector(".pw-pr-wait")?.textContent)).toEqual(["kim mentioned you", "lee wrote"]);
    rows[1]!.querySelector<HTMLElement>(".pw-pr-label")!.click();
    expect(backend.open).toHaveBeenCalledWith("https://github.com/kim/game/pull/22");
    expect(backend.inboxDone).toHaveBeenCalledWith("github.com:22");
    rows[0]!.querySelector<HTMLButtonElement>(".pw-issue-aside")!.click();
    expect(backend.inboxDone).toHaveBeenCalledWith("github.com:21");
  });

  it("recent news starts folded, and a notification click opens what it was about", () => {
    const at = (min: number, change: NewsItem["change"], n = 88): NewsItem => ({ at: ago(min), kind: "pr", key: `github.com/acme/app#${n}`, url: `https://github.com/acme/app/pull/${n}`, repo: "acme/app", number: n, title: "Fix login", change, session: "s-1", sessionTitle: "Login fix" });
    const p = mount(snapshot({ prs: [pr({ number: 90, title: "Open one" })], news: [at(5, "merged"), at(20, "ci_failed"), at(30, "ci_failed", 91)] }));
    const news = sec("news")!;
    expect(news.classList.contains("is-collapsed")).toBe(true);
    expect([...news.querySelectorAll(".pw-news-what")].map((e) => e.textContent)).toEqual(["merged", "CI failed", "CI failed"]);
    // the newest line of each pull request is where a click lands
    expect([...news.querySelectorAll<HTMLElement>("[data-news]")].map((e) => e.dataset.news)).toEqual(["github.com/acme/app#88", "github.com/acme/app#91"]);
    news.querySelector<HTMLElement>(".pw-pr-owner")!.click();
    expect(backend.goto).toHaveBeenCalledWith("s-1");
    // an open pull request is found in place; a merged one in the news, which unfolds
    expect(p.focusTarget("pr:github.com/acme/app#90")).toBe(true);
    expect(p.focusTarget("pr:github.com/acme/app#88")).toBe(true);
    expect(sec("news")!.classList.contains("is-collapsed")).toBe(false);
    expect(p.focusTarget("news")).toBe(true);
    // nothing to show: the caller opens the page instead
    expect(p.focusTarget("issue:github.com/kim/game#99")).toBe(false);
  });
});

describe("redraws keep what the human is doing", () => {
  const cardEl = (id: string) => root.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  const note = (id: string) => root.querySelector<HTMLTextAreaElement>(`textarea[data-card="${id}"]`)!;

  it("keeps a card that did not change, and swaps only the one that did", () => {
    const a = card({ id: "c1", title: "Ship the top-box ending?" });
    const b = card({ id: "c2", title: "Merge #88?" });
    const p = mount(snapshot({ cards: [a, b] }));
    const before1 = cardEl("c1");
    const before2 = cardEl("c2");
    p.update(snapshot({ cards: [a, { ...b, title: "Merge #88 now?" }] }));
    expect(cardEl("c1")).toBe(before1);
    expect(cardEl("c2")).not.toBe(before2);
    expect(cardEl("c2")?.textContent).toContain("Merge #88 now?");
  });

  it("leaves the field being typed in alone when another card arrives above it", () => {
    const b = card({ id: "c2", title: "Merge #88?", openedAt: ago(5) });
    const p = mount(snapshot({ cards: [b] }));
    const field = note("c2");
    field.focus();
    field.value = "after the CI run";
    field.setSelectionRange(5, 5);
    p.update(snapshot({ cards: [card({ id: "c1", title: "Older question", openedAt: ago(50) }), b] }));
    expect(note("c2")).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("after the CI run");
    expect(field.selectionStart).toBe(5);
  });

  it("holds a card that changes while the human types in it, and draws it once they leave", async () => {
    const b = card({ id: "c2", title: "Merge #88?" });
    const p = mount(snapshot({ cards: [b] }));
    const field = note("c2");
    field.focus();
    p.update(snapshot({ cards: [{ ...b, title: "Merge #88 now?" }] }));
    expect(note("c2")).toBe(field);
    expect(cardEl("c2")?.textContent).not.toContain("now?");
    field.blur();
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(cardEl("c2")?.textContent).toContain("Merge #88 now?");
  });

  it("waits while a syllable is being composed", async () => {
    const b = card({ id: "c2", title: "Merge #88?" });
    const p = mount(snapshot({ cards: [b] }));
    const field = note("c2");
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    p.update(snapshot({ cards: [b, card({ id: "c3", title: "New one" })] }));
    expect(cardEl("c3")).toBeNull();
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    // still typing: the new card is drawn, the field stays
    p.update(snapshot({ cards: [b, card({ id: "c3", title: "New one" })] }));
    expect(cardEl("c3")).not.toBeNull();
    expect(note("c2")).toBe(field);
  });
});

describe("laying out a row of pictures and videos", () => {
  function row(n: number): HTMLElement {
    const r = document.createElement("div");
    r.className = "pw-media";
    for (let i = 0; i < n; i++) {
      const item = document.createElement("div");
      item.className = "pw-media-item";
      item.dataset.ar = String(1 + i * 0.3);
      item.appendChild(document.createElement(i === 0 ? "video" : "img"));
      r.appendChild(item);
    }
    document.body.appendChild(r);
    Object.defineProperty(r, "clientWidth", { configurable: true, value: 400 });
    return r;
  }

  it("does not take cells out of the page when their order stays", async () => {
    const r = row(3);
    layoutMedia(r);
    const moved: Node[] = [];
    const mo = new MutationObserver((ms) => ms.forEach((m) => moved.push(...Array.from(m.removedNodes))));
    mo.observe(r, { childList: true });
    Object.defineProperty(r, "clientWidth", { configurable: true, value: 380 });
    layoutMedia(r);
    await new Promise((done) => setTimeout(done, 0));
    mo.disconnect();
    // moving a cell stops its video and ends its full screen
    expect(moved).toEqual([]);
  });

  it("leaves a row alone while one of its videos is full screen", () => {
    const r = row(2);
    const video = r.querySelector("video")!;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => video });
    try {
      layoutMedia(r);
      expect((r.firstElementChild as HTMLElement).style.width).toBe("");
    } finally {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    }
    layoutMedia(r);
    expect((r.firstElementChild as HTMLElement).style.width).not.toBe("");
  });
});
