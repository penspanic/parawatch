// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blocks } from "../src/chat";
import { Panel } from "../src/panel";
import type { Backend, ChatItem, ChatState, Run, Snapshot } from "../src/types";

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const run = (over: Partial<Run> & Pick<Run, "id" | "title">): Run => ({ runtime: "claude-code", kind: "session", project: "app", state: "idle", lastActivity: ago(1), activity: [0, 1], ...over });
const snapshot = (runs: Run[]): Snapshot => ({ v: 1, generatedAt: new Date(NOW).toISOString(), projects: [], cards: [], runs, prs: [] }) as Snapshot;

const items: ChatItem[] = [
  { kind: "user", id: "u1", text: "Fix the login" },
  { kind: "agent", id: "a1", text: "On it", commentary: true },
  { kind: "command", id: "c1", command: "ls", output: "a", exit: 0, status: "completed" },
  { kind: "command", id: "c2", command: "npm test", output: "1 failed", exit: 1, status: "failed" },
  { kind: "tool", id: "t1", name: "Drive search" },
  { kind: "files", id: "f1", files: [{ path: "/w/login.ts", change: "update", diff: "@@\n-a\n+b" }] },
  { kind: "agent", id: "a2", text: "Fixed." },
];
const state = (over: Partial<ChatState> = {}): ChatState => ({
  view: { id: "x1", file: "/l.jsonl", origin: "exec", title: "Fix the login", settings: { model: "gpt-test", sandbox: "read-only", roots: [] }, working: false, items, earlier: 0 },
  sending: false,
  ...over,
});

let root: HTMLElement;
let chat: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onUpdate: ReturnType<typeof vi.fn> };
let push: (run: string, s: ChatState) => void;
let goto: ReturnType<typeof vi.fn>;

function mount(runs: Run[], withChat = true): Panel {
  const backend = {
    snapshot: vi.fn(),
    answer: vi.fn(),
    goto,
    dismiss: vi.fn(),
    hideRun: vi.fn(),
    open: vi.fn(),
    mediaUrl: vi.fn(async () => undefined),
    saveAttachment: vi.fn(),
    droppedPath: vi.fn(),
    ...(withChat ? { chat } : {}),
  } as unknown as Backend;
  const p = new Panel(root, backend, { renderMarkdown: (md, el) => (el.textContent = md), icon: (el, n) => (el.dataset.icon = n), notice: () => {}, refresh: () => {} });
  p.update(snapshot(runs));
  return p;
}

const title = (text: string) => [...root.querySelectorAll<HTMLElement>(".pw-run-title")].find((t) => t.textContent === text)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="panel"></div>';
  root = document.getElementById("panel")!;
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  goto = vi.fn(async () => "Opened");
  chat = {
    open: vi.fn(async () => state()),
    close: vi.fn(),
    send: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onUpdate: vi.fn((fn) => {
      push = fn;
      return () => {};
    }),
  };
});

describe("Codex conversations in the panel", () => {
  it("a Codex run opens as a conversation, here or from another machine; with no chat in the host it does not", async () => {
    mount([
      run({ id: "lead", title: "Lead" }),
      run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec", parent: "lead" }),
      run({ id: "x2", title: "PC job", runtime: "codex", kind: "exec", device: "winpc" }),
    ]);
    expect(title("PC job").classList.contains("is-link")).toBe(true);
    expect(title("PC job").title).toContain("from winpc");
    title("Icons job").click();
    await flush();
    expect(goto).not.toHaveBeenCalled();
    expect(chat.open).toHaveBeenCalledWith("x1");
    expect(root.classList.contains("pw-chatting")).toBe(true);
    expect(root.querySelector(".pw-chat-name")?.textContent).toBe("Fix the login");
    expect(root.querySelector(".pw-chat-note")?.textContent).toMatch(/gpt-test · read only/);

    document.body.innerHTML = '<div id="panel"></div>';
    root = document.getElementById("panel")!;
    mount([run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" })], false);
    expect(title("Icons job").classList.contains("is-link")).toBe(false);
  });

  it("waits for the other machine, then names it where the conversation runs", async () => {
    const pc = run({ id: "x2", title: "PC job", runtime: "codex", kind: "exec", device: "winpc" });
    chat.open.mockResolvedValueOnce({ sending: false, remote: "winpc", waiting: "Waiting for winpc.", blocked: "Waiting for winpc." });
    const p = mount([pc]);
    p.openChat(pc);
    await flush();
    expect(root.querySelector(".pw-chat-list")?.textContent).toBe("Waiting for winpc.");
    expect(root.querySelector(".pw-chat-sub")?.textContent).toContain("on winpc");
    expect((root.querySelector(".pw-chat-input") as HTMLTextAreaElement | null)?.disabled).toBe(true);
    push("x2", state({ remote: "winpc" }));
    expect(root.querySelector(".pw-chat-note")?.textContent).toMatch(/Runs on winpc without asking/);
  });

  it("shows messages, folds a run of steps with its failures counted, and opens a step's output", async () => {
    const p = mount([run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" })]);
    p.openChat(run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" }));
    await flush();
    const list = root.querySelector(".pw-chat-list")!;
    expect(list.querySelector(".is-user")?.textContent).toBe("Fix the login");
    expect(list.querySelectorAll(".is-agent")).toHaveLength(2);
    const steps = list.querySelector(".pw-chat-steps")!;
    expect(steps.querySelector(".pw-chat-steps-count")?.textContent).toBe("3 steps");
    expect(steps.querySelector(".pw-chat-exit")?.textContent).toBe("1 failed");
    steps.querySelector<HTMLElement>(".pw-chat-fold-head")!.click();
    const cmds = steps.querySelectorAll<HTMLElement>(".pw-chat-cmd > .pw-chat-fold-head");
    cmds[1]!.click();
    expect(steps.querySelector(".pw-chat-output")?.textContent).toContain("1 failed");
    expect(list.querySelector(".pw-chat-files .pw-chat-change")?.textContent).toBe("M");
  });

  it("Enter sends; Enter while an input method is composing does not; Shift+Enter does not", async () => {
    const p = mount([]);
    p.openChat(run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" }));
    await flush();
    const box = root.querySelector<HTMLTextAreaElement>(".pw-chat-input")!;
    box.value = "다음은?";
    box.dispatchEvent(new Event("input"));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(chat.send).not.toHaveBeenCalled();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(chat.send).toHaveBeenCalledWith("x1", "다음은?");
    await flush();
    expect(box.value).toBe("");
  });

  it("while Codex answers it shows what it does with a Stop; a refusal shows instead of the settings", async () => {
    const p = mount([]);
    p.openChat(run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" }));
    await flush();
    push("x1", state({ sending: true, live: "Running npm test" }));
    expect(root.querySelector(".pw-chat-live")?.textContent).toBe("Running npm test");
    root.querySelector<HTMLElement>(".pw-chat-stop")!.click();
    expect(chat.stop).toHaveBeenCalledWith("x1");
    expect(root.querySelector<HTMLButtonElement>(".pw-chat-send")!.disabled).toBe(true);
    push("x1", state({ blocked: "This session is open in Codex" }));
    expect(root.querySelector(".pw-chat-note")?.textContent).toBe("This session is open in Codex");
    push("other", state({ sending: true }));
    expect(root.querySelector(".pw-chat-live")).toBeNull();
  });

  it("Esc closes it and the board and feed come back; the draft is kept for next time", async () => {
    const p = mount([]);
    const r = run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" });
    p.openChat(r);
    await flush();
    const box = root.querySelector<HTMLTextAreaElement>(".pw-chat-input")!;
    box.value = "half a thought";
    box.dispatchEvent(new Event("input"));
    root.querySelector(".pw-chat")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".pw-chat")).toBeNull();
    expect(root.classList.contains("pw-chatting")).toBe(false);
    expect(chat.close).toHaveBeenCalledWith("x1");
    p.openChat(r);
    expect(root.querySelector<HTMLTextAreaElement>(".pw-chat-input")!.value).toBe("half a thought");
  });

  it("a failed open shows why", async () => {
    chat.open = vi.fn(async () => {
      throw new Error("That session is no longer listed.");
    });
    const p = mount([]);
    p.openChat(run({ id: "x1", title: "Icons job", runtime: "codex", kind: "exec" }));
    await flush();
    expect(root.querySelector(".pw-chat-empty")?.textContent).toBe("That session is no longer listed.");
  });

  it("folds three or more steps in a row, not fewer", () => {
    const c = (id: string): ChatItem => ({ kind: "command", id, command: id });
    const kinds = (xs: ChatItem[]) => blocks(xs).map((b) => (b.kind === "steps" ? `steps${b.steps.length}` : b.item.kind));
    expect(kinds([c("a"), c("b"), { kind: "agent", id: "m", text: "x" }, c("c"), c("d"), c("e")])).toEqual(["command", "command", "agent", "steps3"]);
  });
});
