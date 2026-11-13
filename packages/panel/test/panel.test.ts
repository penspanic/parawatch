// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Panel } from "../src/panel";
import type { Backend, Card, PrView, Run, Snapshot } from "../src/types";

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

