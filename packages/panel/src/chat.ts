/**
 * A Codex session as a conversation inside the panel: what was asked, what Codex said, the
 * commands it ran and the files it changed, with a box to send it the next message. It replaces
 * the board and the feed until it is closed (Esc or the back button).
 */
import type { ChatBackend, ChatItem, ChatState, Run } from "./types";

export interface ChatHost {
  renderMarkdown(md: string, el: HTMLElement): void;
  icon(el: HTMLElement, name: string): void;
  notice(message: string): void;
  open(target: string): void;
}

/** Commands and tool calls in a row fold into one line from this many on. */
const FOLD_FROM = 3;
const NEAR_BOTTOM = 80;

type Step = Extract<ChatItem, { kind: "command" | "tool" | "image" }>;
type Block = { kind: "item"; item: ChatItem } | { kind: "steps"; id: string; steps: Step[] };

/** Runs of commands, tool calls and pictures viewed fold into one block; the rest stay as they are. */
export function blocks(items: ChatItem[]): Block[] {
  const out: Block[] = [];
  let run: Step[] = [];
  const flush = () => {
    if (run.length >= FOLD_FROM) out.push({ kind: "steps", id: `steps-${run[0]!.id}`, steps: run });
    else for (const s of run) out.push({ kind: "item", item: s });
    run = [];
  };
  for (const it of items) {
    if (it.kind === "command" || it.kind === "tool" || it.kind === "image") run.push(it);
    else {
      flush();
      out.push({ kind: "item", item: it });
    }
  }
  flush();
  return out;
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const home = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/i, "~");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class ChatPane {
  readonly root: HTMLElement;
  private header: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private note: HTMLElement;
  private state?: ChatState;
  private unfolded = new Set<string>();
  private off?: () => void;
  private sizer = () => this.fit();

  constructor(
    readonly run: Run,
    private backend: ChatBackend,
    private host: ChatHost,
    private onClose: () => void,
    private drafts: Map<string, string>,
  ) {
    this.root = el("div", "pw-chat");
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", `Codex conversation: ${run.title}`);
    this.header = el("div", "pw-chat-head", undefined, this.root);
    this.list = el("div", "pw-chat-list", undefined, this.root);
    this.status = el("div", "pw-chat-status", undefined, this.root);
    const composer = el("div", "pw-chat-compose", undefined, this.root);
    this.box = el("textarea", "pw-chat-input", undefined, composer);
    this.box.rows = 1;
    this.box.placeholder = "Message Codex";
    this.box.value = drafts.get(run.id) ?? "";
    this.sendBtn = el("button", "pw-chat-send mod-cta", undefined, composer);
    this.host.icon(this.sendBtn, "send");
    this.sendBtn.title = "Send (Enter; Shift+Enter for a new line)";
    this.sendBtn.setAttribute("aria-label", "Send");
    this.note = el("div", "pw-chat-note", undefined, this.root);

    this.box.oninput = () => {
      this.drafts.set(run.id, this.box.value);
      this.grow();
      this.syncSend();
    };
    this.box.onkeydown = (e) => {
      // Enter while an input method is composing (Korean, Japanese) picks the word; it does not send
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.send();
      }
    };
    this.sendBtn.onclick = () => this.send();
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        this.onClose();
      }
    });
    this.renderHead();
    el("div", "pw-chat-empty", "Loading the conversation…", this.list);
  }

  /** Start watching; call once the pane is in the page. */
  start(): void {
    window.addEventListener("resize", this.sizer);
    this.fit();
    this.off = this.backend.onUpdate((id, s) => {
      if (id === this.run.id) this.set(s);
    });
    this.backend
      .open(this.run.id)
      .then((s) => this.set(s, true))
      .catch((err) => this.set({ sending: false, error: err instanceof Error ? err.message : String(err) }, true));
    this.box.focus();
  }

  dispose(): void {
    window.removeEventListener("resize", this.sizer);
    this.off?.();
    this.backend.close(this.run.id);
    this.root.remove();
  }

  /** The pane fills the window below where it starts. */
  private fit(): void {
    const top = this.root.getBoundingClientRect().top;
    this.root.style.height = `${Math.max(240, window.innerHeight - Math.max(0, top) - 8)}px`;
  }

  private grow(): void {
    this.box.style.height = "auto";
    this.box.style.height = `${Math.min(this.box.scrollHeight, 180)}px`;
  }

  set(s: ChatState, first = false): void {
    const near = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < NEAR_BOTTOM;
    this.state = s;
    this.renderHead();
    this.renderList();
    this.renderStatus();
    this.syncSend();
    if (first || near) this.list.scrollTop = this.list.scrollHeight;
  }

  private syncSend(): void {
    const s = this.state;
    const blocked = !s?.view || !!s.blocked || s.sending;
    this.sendBtn.disabled = blocked || !this.box.value.trim();
    this.box.disabled = !s?.view;
    this.note.textContent = s?.blocked ?? (s?.view ? this.runsAs() : "");
    this.note.classList.toggle("is-blocked", !!s?.blocked);
  }

  /** How a message sent from here runs: the session's own model and sandbox, never asking. */
  private runsAs(): string {
    const st = this.state?.view?.settings;
    if (!st) return "";
    const sandbox =
      st.sandbox === "danger-full-access"
        ? "full access, no sandbox"
        : st.sandbox === "workspace-write"
          ? `writes in its folder${st.roots.length ? ` and ${st.roots.length} more` : ""}${st.network ? ", with network" : ""}`
          : st.sandbox === "read-only"
            ? "read only"
            : (st.sandbox ?? "");
    const on = this.state?.remote ? ` on ${this.state.remote}` : "";
    return [st.model, st.effort, sandbox].filter(Boolean).join(" · ") + `. Runs${on} without asking, as the session did.`;
  }

  private renderHead(): void {
    const h = this.header;
    h.replaceChildren();
    const back = el("button", "pw-icon-btn clickable-icon pw-chat-back", undefined, h);
    this.host.icon(back, "arrow-left");
    back.title = "Back (Esc)";
    back.setAttribute("aria-label", "Back");
    back.onclick = () => this.onClose();
    const text = el("div", "pw-chat-title", undefined, h);
    el("div", "pw-chat-name", this.state?.view?.title ?? this.run.title, text);
    const v = this.state?.view;
    const where = v?.settings.cwd ? home(v.settings.cwd) : this.run.cwd ? home(this.run.cwd) : "";
    const origin = v?.origin === "exec" ? "codex exec" : v?.origin === "app" ? "Codex app" : v?.origin === "cli" ? "Codex CLI" : "Codex";
    const machine = this.state?.remote ?? this.run.device;
    el("div", "pw-chat-sub", [origin, machine ? `on ${machine}` : "", where].filter(Boolean).join(" · "), text);
    const copy = el("button", "pw-icon-btn clickable-icon", undefined, h);
    this.host.icon(copy, "terminal");
    copy.title = "Copy the command that opens this session in a terminal";
    copy.setAttribute("aria-label", copy.title);
    copy.onclick = () => {
      const cmd = `codex resume ${v?.id ?? this.run.id}`;
      void navigator.clipboard
        ?.writeText(cmd)
        .then(() => this.host.notice(`Copied: ${cmd}`))
        .catch(() => this.host.notice(cmd));
    };
  }

  private renderList(): void {
    const v = this.state?.view;
    this.list.replaceChildren();
    if (!v) {
      if (this.state?.error) el("div", "pw-chat-empty is-error", this.state.error, this.list);
      else if (this.state?.waiting) el("div", "pw-chat-empty", this.state.waiting, this.list);
      return;
    }
    if (v.earlier) el("div", "pw-chat-earlier", `${v.earlier} earlier step${v.earlier === 1 ? "" : "s"} not shown`, this.list);
    if (!v.items.length) el("div", "pw-chat-empty", "Nothing in this conversation yet.", this.list);
    for (const b of blocks(v.items)) this.list.appendChild(b.kind === "steps" ? this.stepsBlock(b.id, b.steps) : this.itemEl(b.item));
  }

  private renderStatus(): void {
    const s = this.state;
    const st = this.status;
    st.replaceChildren();
    st.className = "pw-chat-status";
    if (s?.sending) {
      st.classList.add("is-working");
      el("span", "pw-chat-spin", undefined, st);
      el("span", "pw-chat-live", s.live ?? "Codex is answering…", st);
      const stop = el("button", "pw-chat-stop", "Stop", st);
      stop.onclick = () => void this.backend.stop(this.run.id).catch((err) => this.host.notice(String(err instanceof Error ? err.message : err)));
    } else if (s?.view?.working) {
      st.classList.add("is-working");
      el("span", "pw-chat-spin", undefined, st);
      el("span", "pw-chat-live", "Codex is working on this session", st);
    }
    if (s?.error && s.view) el("div", "pw-chat-error", s.error, st);
  }

  private send(): void {
    const text = this.box.value.trim();
    if (!text || this.sendBtn.disabled) return;
    this.sendBtn.disabled = true;
    void this.backend
      .send(this.run.id, text)
      .then(() => {
        this.box.value = "";
        this.drafts.delete(this.run.id);
        this.grow();
        this.list.scrollTop = this.list.scrollHeight;
      })
      .catch((err) => this.host.notice(err instanceof Error ? err.message : String(err)))
      .finally(() => this.syncSend());
  }

  private toggle(id: string, body: HTMLElement, head: HTMLElement): void {
    const open = !this.unfolded.has(id);
    if (open) this.unfolded.add(id);
    else this.unfolded.delete(id);
    body.hidden = !open;
    head.setAttribute("aria-expanded", String(open));
  }

  /** A line that opens what it holds when clicked. */
  private fold(id: string, cls: string, fill: (head: HTMLElement) => void, body: () => HTMLElement): HTMLElement {
    const wrap = el("div", `pw-chat-fold ${cls}`);
    const head = el("button", "pw-chat-fold-head", undefined, wrap);
    fill(head);
    const open = this.unfolded.has(id);
    head.setAttribute("aria-expanded", String(open));
    let inner: HTMLElement | undefined;
    head.onclick = () => {
      if (!inner) {
        inner = body();
        inner.classList.add("pw-chat-fold-body");
        inner.hidden = true;
        wrap.appendChild(inner);
      }
      this.toggle(id, inner, head);
    };
    if (open) {
      inner = body();
      inner.classList.add("pw-chat-fold-body");
      wrap.appendChild(inner);
    }
    return wrap;
  }

  private stepsBlock(id: string, steps: Step[]): HTMLElement {
    const failed = steps.filter((s) => s.kind === "command" && s.exit !== undefined && s.exit !== 0).length;
    return this.fold(
      id,
      "pw-chat-steps",
      (head) => {
        this.host.icon(head, "terminal");
        el("span", "pw-chat-steps-count", `${steps.length} steps`, head);
        const last = steps[steps.length - 1]!;
        el("span", "pw-chat-step-text", this.stepText(last), head);
        if (failed) el("span", "pw-chat-exit is-bad", `${failed} failed`, head);
      },
      () => {
        const box = el("div", "pw-chat-steps-list");
        for (const s of steps) box.appendChild(this.itemEl(s));
        return box;
      },
    );
  }

  private stepText(s: Step): string {
    if (s.kind === "command") return s.command;
    if (s.kind === "image") return `Viewed ${basename(s.path)}`;
    return s.detail ? `${s.name} ${s.detail}` : s.name;
  }

  private itemEl(it: ChatItem): HTMLElement {
    switch (it.kind) {
      case "user": {
        const b = el("div", "pw-chat-msg is-user");
        el("div", "pw-chat-bubble", it.text, b);
        if (it.images) el("div", "pw-chat-meta", `${it.images} image${it.images === 1 ? "" : "s"} attached`, b);
        if (it.at) b.title = new Date(it.at).toLocaleString();
        return b;
      }
      case "agent": {
        const b = el("div", `pw-chat-msg is-agent${it.commentary ? " is-commentary" : ""}`);
        this.host.renderMarkdown(it.text, el("div", "pw-chat-text markdown-rendered", undefined, b));
        return b;
      }
      case "command":
        return this.fold(
          it.id,
          "pw-chat-cmd",
          (head) => {
            el("span", "pw-chat-prompt", "$", head);
            el("span", "pw-chat-step-text", it.command, head);
            if (it.exit !== undefined && it.exit !== 0) el("span", "pw-chat-exit is-bad", `exit ${it.exit}`, head);
            else if (it.status && it.status !== "completed") el("span", "pw-chat-exit", it.status, head);
          },
          () => {
            const pre = el("pre", "pw-chat-output");
            el("div", "pw-chat-output-cmd", it.command, pre);
            el("div", undefined, it.output || "(no output)", pre);
            return pre;
          },
        );
      case "files": {
        const wrap = el("div", "pw-chat-files");
        const head = el("div", "pw-chat-files-head", undefined, wrap);
        this.host.icon(head, "file-diff");
        el("span", undefined, it.files.length === 1 ? "Changed 1 file" : `Changed ${it.files.length} files`, head);
        for (const f of it.files) {
          wrap.appendChild(
            this.fold(
              `${it.id}:${f.path}`,
              "pw-chat-file",
              (h) => {
                el("span", `pw-chat-change is-${f.change}`, f.change === "add" ? "A" : f.change === "delete" ? "D" : "M", h);
                el("span", "pw-chat-step-text", home(f.path), h).title = f.path;
              },
              () => diffEl(f.diff),
            ),
          );
        }
        return wrap;
      }
      case "tool": {
        const row = el("div", "pw-chat-tool");
        this.host.icon(row, "plug");
        el("span", "pw-chat-tool-name", it.name, row);
        if (it.detail) el("span", "pw-chat-step-text", it.detail, row);
        if (it.status === "failed") el("span", "pw-chat-exit is-bad", "failed", row);
        return row;
      }
      case "image": {
        const row = el("div", "pw-chat-tool");
        this.host.icon(row, "image");
        const a = el("a", "pw-chat-step-text", `Viewed ${basename(it.path)}`, row);
        a.href = "#";
        a.title = it.path;
        a.onclick = (e) => {
          e.preventDefault();
          this.host.open(it.path);
        };
        return row;
      }
      case "note":
        return el("div", `pw-chat-sys${it.tone === "error" ? " is-error" : ""}`, it.text);
    }
  }
}

function diffEl(diff: string | undefined): HTMLElement {
  const pre = el("pre", "pw-chat-diff");
  if (!diff) {
    pre.textContent = "(no diff recorded)";
    return pre;
  }
  for (const line of diff.split("\n")) {
    const cls = line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-del" : line.startsWith("@@") ? "is-hunk" : undefined;
    el("div", cls, line || " ", pre);
  }
  return pre;
}
