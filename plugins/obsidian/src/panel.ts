import { ago, clean, groupRuns, type FoldNode, type RunNode } from "./tree";
import type { Backend, Card, Reply, Run, Snapshot } from "./types";

/** What the panel needs from its host (Obsidian, or the harness page). */
export interface PanelHost {
  renderMarkdown(md: string, el: HTMLElement): void;
  icon(el: HTMLElement, name: string): void;
  notice(message: string): void;
  /** Ask for a fresh snapshot now. */
  refresh(): void;
}

interface Draft {
  note: string;
  attach: string[];
}

const KIND_LABEL: Record<Card["kind"], string> = { decide: "Decide", try: "Try", block: "Blocked" };
const STATE_LABEL: Record<Run["state"], string> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  done: "done",
  stalled: "stalled",
  failed: "failed",
  unknown: "unknown",
};
const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|avif)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function basename(p: string): string {
  if (URL_RE.test(p)) {
    try {
      const u = new URL(p);
      return u.host + (u.pathname.length > 1 ? u.pathname : "");
    } catch {
      return p;
    }
  }
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export class Panel {
  private snapshot?: Snapshot;
  private error?: string;
  private drafts = new Map<string, Draft>();
  private busy = new Set<string>();
  private expanded = new Set<string>();
  private cardsSig = "";
  private head: HTMLElement;
  private cardsEl: HTMLElement;
  private agentsEl: HTMLElement;

  constructor(
    private root: HTMLElement,
    private backend: Backend,
    private host: PanelHost,
  ) {
    root.classList.add("pw-panel");
    root.replaceChildren();
    this.head = el("div", "pw-head", undefined, root);
    this.cardsEl = el("div", "pw-cards", undefined, root);
    this.agentsEl = el("div", "pw-agents", undefined, root);
    this.renderHead();
    el("div", "pw-empty", "Loading…", this.cardsEl);
  }

  update(snapshot: Snapshot | undefined, error?: string): void {
    if (snapshot) this.snapshot = snapshot;
    this.error = error;
    const now = Date.now();
    this.renderHead();
    const sig = this.signature();
    if (sig !== this.cardsSig) {
      this.cardsSig = sig;
      this.renderCards(now);
    } else {
      // ages only
      for (const age of Array.from(this.cardsEl.querySelectorAll<HTMLElement>("[data-since]"))) age.textContent = ago(age.dataset.since, now);
    }
    this.renderAgents(now);
  }

  // ---------------------------------------------------------------- head

  private renderHead(): void {
    const h = this.head;
    h.replaceChildren();
    const s = this.snapshot;
    const open = s?.cards.filter((c) => c.status === "open").length ?? 0;
    const working = s?.runs.filter((r) => r.state === "working" || r.state === "waiting").length ?? 0;
    const line = el("div", "pw-summary", undefined, h);
    const need = el("span", open ? "pw-summary-need is-urgent" : "pw-summary-need", open ? `${open} need${open === 1 ? "s" : ""} you` : "Nothing needs you", line);
    need.setAttribute("aria-live", "polite");
    el("span", "pw-summary-sep", "·", line);
    el("span", "pw-summary-agents", `${working} working`, line);
    const btn = el("button", "pw-icon-btn clickable-icon", undefined, line);
    btn.setAttribute("aria-label", "Refresh");
    this.host.icon(btn, "refresh-cw");
    btn.onclick = () => this.host.refresh();
    if (this.error) {
      const e = el("div", "pw-error", undefined, h);
      el("div", "pw-error-title", "parawatch did not answer", e);
      el("div", "pw-error-text", this.error, e);
      el("div", "pw-error-hint", "Check that the parawatch CLI is installed, or set its path in the plugin settings.", e);
    }
  }

  // ---------------------------------------------------------------- cards

  private signature(): string {
    const cards = this.snapshot?.cards ?? [];
    return JSON.stringify([cards.map((c) => [c.id, c.status, c.answers.length, c.comments.length]), [...this.busy]]);
  }

  private renderCards(now: number): void {
    const root = this.cardsEl;
    // keep the focused textarea's caret across a rebuild
    const active = document.activeElement as HTMLTextAreaElement | null;
    const focusId = active?.dataset?.card;
    const caret = focusId ? [active!.selectionStart, active!.selectionEnd] : undefined;

    root.replaceChildren();
    const cards = this.snapshot?.cards ?? [];
    const open = cards.filter((c) => c.status === "open").sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    const answered = cards.filter((c) => c.status === "answered");

    this.section(root, "Needs you", open.length);
    if (!open.length) el("div", "pw-empty", this.snapshot ? "Nothing needs you right now." : "Loading…", root);
    for (const c of open) root.appendChild(this.card(c, now));

    if (answered.length) {
      this.section(root, "Waiting for the agent", answered.length);
      for (const c of answered) root.appendChild(this.answeredCard(c, now));
    }

    if (focusId) {
      const t = root.querySelector<HTMLTextAreaElement>(`textarea[data-card="${focusId}"]`);
      if (t) {
        t.focus();
        if (caret) t.setSelectionRange(caret[0] ?? 0, caret[1] ?? 0);
      }
    }
  }

  private section(parent: HTMLElement, title: string, count?: number, hint?: string): HTMLElement {
    const s = el("div", "pw-section", undefined, parent);
    el("span", "pw-section-title", title, s);
    if (count !== undefined) el("span", "pw-section-count", String(count), s);
    if (hint) el("span", "pw-section-hint", hint, s);
    return s;
  }

  private cardHead(c: Card, box: HTMLElement, now: number): void {
    const head = el("div", "pw-card-head", undefined, box);
    el("span", `pw-kind pw-kind-${c.kind}`, KIND_LABEL[c.kind], head);
    el("span", "pw-card-project", c.project + (c.task ? ` / ${c.task}` : ""), head);
    const age = el("span", "pw-card-age", ago(c.openedAt, now), head);
    age.dataset.since = c.openedAt;
    age.title = new Date(c.openedAt).toLocaleString();
    el("span", "pw-card-id", c.id, head);
  }

  private card(c: Card, now: number): HTMLElement {
    const box = el("div", `pw-card pw-card-${c.kind}`);
    const busy = this.busy.has(c.id);
    if (busy) box.classList.add("is-busy");
    this.cardHead(c, box, now);
    el("div", "pw-card-title", c.title, box);
    if (c.body) this.host.renderMarkdown(c.body, el("div", "pw-card-body markdown-rendered", undefined, box));
    if (c.look) {
      const look = el("div", "pw-look", undefined, box);
      el("span", "pw-look-label", "Look at", look);
      el("span", "pw-look-text", c.look, look);
    }
    if (c.open?.length) {
      const row = el("div", "pw-opens", undefined, box);
      for (const target of c.open) {
        const b = el("button", "pw-open-btn", undefined, row);
        this.host.icon(el("span", "pw-btn-icon", undefined, b), "external-link");
        el("span", undefined, `Open ${basename(target)}`, b);
        b.title = target;
        b.onclick = () => this.backend.open(target);
      }
    }
    if (c.attach?.length) this.media(c.attach, el("div", "pw-media", undefined, box));
    if (c.comments.length) {
      const log = el("div", "pw-comments", undefined, box);
      for (const m of c.comments) el("div", `pw-comment pw-by-${m.by === "human" ? "human" : "agent"}`, `${m.by === "human" ? "You" : "Agent"}: ${m.text}`, log);
    }
    if (c.from) el("div", "pw-from", `from ${c.from}`, box);
    this.reply(c, box, busy);
    return box;
  }

  private reply(c: Card, box: HTMLElement, busy: boolean): void {
    const draft = this.drafts.get(c.id) ?? { note: "", attach: [] };
    this.drafts.set(c.id, draft);
    const send = (r: Reply) => void this.send(c, r);
    const wrap = el("div", "pw-reply", undefined, box);
    const buttons: HTMLButtonElement[] = [];

    if (c.kind === "decide" && c.options?.length) {
      const opts = el("div", "pw-options", undefined, wrap);
      c.options.forEach((o, i) => {
        const n = i + 1;
        const b = el("button", c.recommend === n ? "pw-option is-recommended" : "pw-option", undefined, opts);
        el("span", "pw-option-n", String(n), b);
        el("span", "pw-option-text", o, b);
        if (c.recommend === n) el("span", "pw-option-rec", "Recommended", b);
        b.onclick = () => send({ choice: n });
        buttons.push(b);
      });
    }

    const note = el("textarea", "pw-note", undefined, wrap);
    note.dataset.card = c.id;
    note.rows = 1;
    note.placeholder =
      c.kind === "decide" ? (c.options?.length ? "Add a note to your choice (optional)" : "Your answer") : c.kind === "try" ? "What did you see?" : "Anything to add? (optional)";
    note.value = draft.note;
    const chips = el("div", "pw-chips", undefined, wrap);
    const actions = el("div", "pw-actions", undefined, wrap);

    const sendNote = el("button", "pw-btn", "Send note", actions);
    let primary: HTMLButtonElement | undefined;
    if (c.kind === "try") primary = el("button", "pw-btn mod-cta", "Looks good", actions);
    if (c.kind === "block") primary = el("button", "pw-btn mod-cta", "Done", actions);
    if (c.kind === "decide" && !c.options?.length) {
      sendNote.textContent = "Send";
      sendNote.classList.add("mod-cta");
    }
    buttons.push(sendNote);
    if (primary) {
      buttons.push(primary);
      primary.onclick = () => send({ comment: draft.note.trim() || primary!.textContent! });
    }
    el("div", "pw-reply-hint", "Paste or drop an image to attach · ⌘↩ sends the note", wrap);

    const sync = () => {
      const empty = !draft.note.trim() && !draft.attach.length;
      wrap.classList.toggle("has-draft", !empty);
      sendNote.disabled = busy || empty;
      for (const b of buttons) if (b !== sendNote) b.disabled = busy;
      note.disabled = busy;
      chips.replaceChildren();
      for (const f of draft.attach) {
        const chip = el("span", "pw-chip", basename(f), chips);
        chip.title = f;
        const x = el("button", "pw-chip-x", "×", chip);
        x.setAttribute("aria-label", `Remove ${basename(f)}`);
        x.onclick = () => {
          draft.attach = draft.attach.filter((a) => a !== f);
          sync();
        };
      }
    };
    sendNote.onclick = () => send({});
    note.oninput = () => {
      draft.note = note.value;
      sync();
    };
    note.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !sendNote.disabled) {
        e.preventDefault();
        send({});
      }
    };
    const add = (p: string | undefined) => {
      if (p && !draft.attach.includes(p)) draft.attach.push(p);
      sync();
    };
    note.onpaste = (e) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) {
        const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
        void f
          .arrayBuffer()
          .then((buf) => this.backend.saveAttachment(buf, ext))
          .then(add)
          .catch((err) => this.host.notice(`Could not attach: ${String(err)}`));
      }
    };
    box.ondragover = (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      box.classList.add("is-drop");
    };
    box.ondragleave = () => box.classList.remove("is-drop");
    box.ondrop = (e) => {
      box.classList.remove("is-drop");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) add(this.backend.droppedPath(f));
    };
    sync();
  }

  private async send(c: Card, r: Reply): Promise<void> {
    const draft = this.drafts.get(c.id) ?? { note: "", attach: [] };
    const reply: Reply = { ...r };
    if (reply.comment === undefined && draft.note.trim()) reply.comment = draft.note.trim();
    if (draft.attach.length) reply.attach = [...draft.attach];
    if (reply.choice === undefined && !reply.comment && !reply.attach) return;
    this.busy.add(c.id);
    this.update(undefined, this.error);
    try {
      await this.backend.answer(c.id, reply);
      this.drafts.delete(c.id);
      this.host.notice(`Sent to ${c.project}. The waiting agent picks it up.`);
    } catch (err) {
      this.host.notice(`Could not answer ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy.delete(c.id);
      this.host.refresh();
    }
  }

  private answeredCard(c: Card, now: number): HTMLElement {
    const box = el("div", "pw-card pw-card-answered");
    this.cardHead(c, box, now);
    el("div", "pw-card-title", c.title, box);
    for (const a of c.answers.filter((x) => x.by === "human")) {
      const parts: string[] = [];
      if (a.choice !== undefined) parts.push(`chose ${a.choice}${c.options?.[a.choice - 1] ? ` (${c.options[a.choice - 1]})` : ""}`);
      if (a.comment) parts.push(`“${a.comment}”`);
      if (a.attach?.length) parts.push(`${a.attach.length} attached`);
      el("div", "pw-answer", `You ${parts.join(", ")}`, box);
    }
    return box;
  }

  private media(files: string[], row: HTMLElement): void {
    for (const f of files) {
      const item = el("div", "pw-media-item", undefined, row);
      item.title = f;
      if (IMAGE.test(f) || VIDEO.test(f)) {
        const video = VIDEO.test(f);
        const m = video ? el("video", "pw-media-video", undefined, item) : el("img", "pw-media-img", undefined, item);
        if (video) {
          (m as HTMLVideoElement).controls = true;
          (m as HTMLVideoElement).preload = "metadata";
        } else (m as HTMLImageElement).alt = basename(f);
        void this.backend.mediaUrl(f).then((url) => {
          if (url) m.src = url;
          else item.replaceChildren(this.fileLink(f));
        });
        if (!video) m.onclick = () => this.backend.open(f);
      } else item.appendChild(this.fileLink(f));
    }
  }

  private fileLink(f: string): HTMLElement {
    const b = el("button", "pw-file");
    this.host.icon(el("span", "pw-btn-icon", undefined, b), URL_RE.test(f) ? "link" : "file");
    el("span", undefined, basename(f), b);
    b.onclick = () => this.backend.open(f);
    return b;
  }

  // ---------------------------------------------------------------- agents

  private renderAgents(now: number): void {
    const root = this.agentsEl;
    root.replaceChildren();
    const runs = this.snapshot?.runs ?? [];
    const groups = groupRuns(runs, now, this.expanded);
    this.section(root, "Agents", runs.length ? undefined : 0);
    if (!runs.length) {
      el("div", "pw-empty", this.snapshot ? "No agent activity in the last hours." : "Loading…", root);
      return;
    }
    for (const g of groups) {
      const box = el("div", "pw-group", undefined, root);
      const gh = el("div", "pw-group-head", undefined, box);
      el("span", "pw-group-name", g.name === "other" ? "Other" : g.name, gh);
      if (g.name === "other") el("span", "pw-group-hint", "not in a registered project", gh);
      else if (g.working) el("span", "pw-group-hint", `${g.working} working`, gh);
      for (const row of g.rows) box.appendChild("run" in row ? this.runRow(row, now) : this.foldRow(row, now));
    }
  }

  private runRow({ run: r, depth }: RunNode, now: number): HTMLElement {
    const row = el("div", `pw-run pw-state-${r.state}${r.role === "lead" ? " is-lead" : ""}${depth ? " is-child" : ""}`);
    row.style.setProperty("--pw-depth", String(depth));
    const top = el("div", "pw-run-top", undefined, row);
    el("span", "pw-dot", undefined, top).setAttribute("aria-label", STATE_LABEL[r.state]);
    el("span", "pw-run-title", r.title, top);
    if (r.role === "lead") el("span", "pw-run-role", "lead", top);
    el("span", "pw-run-age", ago(r.lastActivity, now), top);
    const what = r.error ? `unreadable: ${r.error}` : clean(r.action);
    const text = r.state === "stalled" ? `stalled${what ? ` · ${what}` : ""}` : what || STATE_LABEL[r.state];
    el("div", "pw-run-action", text, row);
    row.title = [
      `${r.title}`,
      `${STATE_LABEL[r.state]}${r.lastActivity ? `, last activity ${new Date(r.lastActivity).toLocaleTimeString()}` : ""}`,
      `${r.runtime} ${r.kind}${r.model ? ` (${r.model})` : ""} · ${r.id}`,
      r.cwd ?? "",
      clean(r.action),
    ]
      .filter(Boolean)
      .join("\n");
    return row;
  }

  private foldRow(f: FoldNode, now: number): HTMLElement {
    const row = el("div", "pw-run pw-fold is-child");
    row.style.setProperty("--pw-depth", String(f.depth));
    const top = el("div", "pw-run-top", undefined, row);
    el("span", "pw-dot", undefined, top);
    el("span", "pw-run-title", `${f.folded.length} finished`, top);
    const newest = f.folded.map((r) => r.lastActivity ?? "").sort().pop();
    el("span", "pw-run-age", ago(newest, now), top);
    row.title = f.folded.map((r) => r.title).join("\n");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    const toggle = () => {
      this.expanded.add(f.parent);
      this.renderAgents(Date.now());
    };
    row.onclick = toggle;
    row.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") toggle();
    };
    return row;
  }
}
