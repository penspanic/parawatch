import { serviceName, siteForPr, siteForRun } from "../../../src/core/sites.js";
import { ago, clean, groupRuns, type FoldNode, type RunNode } from "./tree";
import type { Backend, Card, Listener, PrView, Reply, Run, Snapshot } from "./types";

/** What the panel needs from its host (the desktop app, or the harness page). */
export interface PanelHost {
  renderMarkdown(md: string, el: HTMLElement): void;
  icon(el: HTMLElement, name: string): void;
  notice(message: string): void;
  /** Ask for a fresh snapshot now. */
  refresh(): void;
  /** Add the host's own controls to the end of the status row (the desktop app's settings). */
  decorateHead?(row: HTMLElement): void;
}

interface Draft {
  note: string;
  attach: string[];
}

const KIND_LABEL: Record<Card["kind"], string> = { decide: "Decide", try: "Try", block: "Blocked", todo: "To do" };
const KIND_ICON: Record<Card["kind"], string> = { decide: "split", try: "eye", block: "hand", todo: "list-checks" };
/** The agent chart covers the last hour, a minute per step (the runs' `activity`). */
const CHART_MINUTES = 60;
const KIND_ORDER: Card["kind"][] = ["block", "decide", "try", "todo"];
const DAY = 24 * 60 * 60 * 1000;

/** When the matter came up: `since` when it is older than the card, else when the card opened. */
function cardStart(c: Card): string {
  return c.since && c.since < c.openedAt ? c.since : c.openedAt;
}

/**
 * The waits an answer to this card would wake now (the CLI's `listenersFor`). A card whose session
 * has ended reaches the session waits in its project, as an unowned card does.
 */
function waitingFor(c: Card, ls: Listener[]): Listener[] {
  const same = (x?: string, y?: string) => !!x && !!y && (x.startsWith(y) || y.startsWith(x));
  return ls.filter((l) =>
    l.card
      ? l.card === c.id
      : l.scope === "session"
        ? c.session && same(l.session, c.session)
          ? true
          : (!c.session || !!c.ownerEnded) && !!l.project && l.project === c.project
        : !l.project || l.project === c.project,
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
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

/** How much of an approval shows before its details, and how many preview lines show folded. */
const ACTION_CHARS = 120;
const PREVIEW_LINES = 6;

/** The text without a leading `---` frontmatter block. */
function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length).replace(/^\s*\n/, "") : text;
}

/** Local clock time, as in "14:05". */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

const MEDIA_GAP = 6;

/**
 * A justified gallery: items keep their aspect ratio and share rows of one height that fill the
 * width. A row that is still too tall takes the item that brings it closest to the target height,
 * preferring the next one in order, so a tall video gets a neighbour instead of empty space and
 * nothing shrinks to a sliver. A lone item is capped so it does not take the whole window.
 */
export function layoutMedia(row: HTMLElement): void {
  const width = row.clientWidth;
  const items = Array.from(row.children) as HTMLElement[];
  if (!width || !items.length) return;
  const target = Math.max(200, Math.min(300, width * 0.55));
  const cap = items.length === 1 ? 520 : target * 1.35;
  const ratio = (i: HTMLElement) => Number(i.dataset.ar) || 1.6;
  const height = (line: HTMLElement[]) => (width - MEDIA_GAP * (line.length - 1)) / line.reduce((n, i) => n + ratio(i), 0);
  const rest = [...items];
  while (rest.length) {
    const line = [rest.shift()!];
    while (rest.length) {
      const now = Math.min(height(line), cap);
      if (now <= target * 1.15) break;
      let pick = -1;
      let best = Math.abs(now - target);
      rest.forEach((c, k) => {
        const score = Math.abs(height([...line, c]) - target) + k * 8;
        if (score < best) {
          best = score;
          pick = k;
        }
      });
      if (pick < 0) break;
      line.push(rest.splice(pick, 1)[0]!);
    }
    const h = Math.min(height(line), cap);
    for (const i of line) {
      i.style.width = `${Math.floor(ratio(i) * h)}px`;
      i.style.height = `${Math.floor(h)}px`;
      row.appendChild(i); // rows are placed in order, so a pulled-forward item moves up
    }
  }
}

export class Panel {
  private snapshot?: Snapshot;
  private error?: string;
  private drafts = new Map<string, Draft>();
  /** folds the human opened (a preview shown whole, an action's details), kept across redraws */
  private unfolded = new Set<string>();
  private busy = new Set<string>();
  private expanded = new Set<string>();
  /** answered and closed cards the human opened to read again */
  private reopened = new Set<string>();
  /** lays the media rows out again when the window changes width */
  private mediaSize = new ResizeObserver((entries) => {
    for (const e of entries) layoutMedia(e.target as HTMLElement);
  });
  /** site icons by site; "" when there is none, so it is not asked for again */
  private siteIcons = new Map<string, string>();
  private collapsed = loadCollapsed();
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
    // what the agents are doing sits on top, as a chart; what needs you follows
    this.agentsEl = el("div", "pw-agents", undefined, root);
    this.cardsEl = el("div", "pw-cards", undefined, root);
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

  /** Draw the status row again, for when the host's own controls in it change. */
  redrawHead(): void {
    this.renderHead();
  }

  /** Bring one card into view, opening any folded section it sits in. */
  focusCard(id: string): void {
    const box = this.cardsEl.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
    if (!box) return;
    for (let g = box.closest<HTMLElement>(".pw-fold-group.is-collapsed"); g; g = g.parentElement?.closest<HTMLElement>(".pw-fold-group.is-collapsed") ?? null) {
      g.querySelector<HTMLElement>(":scope > .pw-fold-head")?.click();
    }
    box.scrollIntoView({ block: "center", behavior: "smooth" });
    box.classList.add("is-flash");
    window.setTimeout(() => box.classList.remove("is-flash"), 1600);
  }

  // ---------------------------------------------------------------- small parts

  private icon(parent: HTMLElement, name: string, cls = "pw-icon"): HTMLElement {
    const span = el("span", cls, undefined, parent);
    this.host.icon(span, name);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  /**
   * Show the service's own icon in `slot` (which holds a generic icon until then). The icon is asked
   * for once per site and never blocks drawing: the slot swaps when it arrives.
   */
  private siteSlot(slot: HTMLElement, site: string | undefined): void {
    if (!site || !this.backend.siteIcon) return;
    slot.dataset.site = site;
    const known = this.siteIcons.get(site);
    if (known === undefined) {
      this.siteIcons.set(site, "");
      void this.backend
        .siteIcon(site)
        .catch(() => undefined)
        .then((url) => {
          if (!url) return;
          this.siteIcons.set(site, url);
          for (const s of Array.from(this.root.querySelectorAll<HTMLElement>("[data-site]"))) if (s.dataset.site === site) this.paintSite(s, url);
        });
    } else if (known) this.paintSite(slot, known);
  }

  private paintSite(slot: HTMLElement, url: string): void {
    if (slot.classList.contains("is-site")) return;
    const img = el("img", "pw-site-img");
    img.src = url;
    img.alt = "";
    img.draggable = false;
    slot.classList.add("is-site");
    slot.replaceChildren(img);
    slot.closest(".pw-run-mark")?.classList.add("has-site");
  }

  /** Forget the icons and draw again, for when the host turns them on or off. */
  resetSiteIcons(): void {
    this.siteIcons.clear();
    this.cardsSig = "";
    this.update(undefined, this.error);
  }

  /** An icon with a number, worded only for the tooltip and screen readers. */
  private badge(parent: HTMLElement, icon: string, n: number, label: string, cls = ""): HTMLElement {
    const b = el("span", `pw-badge ${cls}`.trim(), undefined, parent);
    this.icon(b, icon);
    el("span", "pw-badge-n", String(n), b);
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }

  // ---------------------------------------------------------------- head

  private renderHead(): void {
    const h = this.head;
    h.replaceChildren();
    const s = this.snapshot;
    const open = s?.cards.filter((c) => c.status === "open" && c.kind !== "todo").length ?? 0;
    const todo = s?.cards.filter((c) => c.status === "open" && c.kind === "todo").length ?? 0;
    const working = s?.runs.filter((r) => r.state === "working" || r.state === "waiting").length ?? 0;
    const row = el("div", "pw-status", undefined, h);
    const need = this.badge(row, "inbox", open, open ? `${open} card${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you` : "Nothing needs you", open ? "pw-need is-urgent" : "pw-need");
    need.setAttribute("aria-live", "polite");
    this.badge(row, "list-checks", todo, `${todo} to do`, todo ? "" : "is-zero");
    const asks = s?.runs.filter((r) => r.asks).length ?? 0;
    if (asks) this.badge(row, "message-circle-question", asks, `${asks} session${asks === 1 ? "" : "s"} asked you in chat, without a card`, "pw-asks");
    const stuck = s?.prs?.filter((p) => p.stalled && !(p.reviewRequested && !p.mine)).length ?? 0;
    const prs = s?.prs?.length ?? 0;
    if (prs) this.badge(row, "git-pull-request", prs, `${prs} open pull request${prs === 1 ? "" : "s"}${stuck ? `, ${stuck} stuck` : ""}`, stuck ? "pw-prs is-stuck" : "pw-prs");
    this.badge(row, "activity", working, `${working} agent${working === 1 ? "" : "s"} working`, working ? "" : "is-zero");
    const btn = el("button", "pw-icon-btn clickable-icon", undefined, row);
    btn.setAttribute("aria-label", "Refresh");
    btn.title = "Refresh";
    this.host.icon(btn, "refresh-cw");
    btn.onclick = () => this.host.refresh();
    this.host.decorateHead?.(row);
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
    const s = this.snapshot;
    const asks = (s?.runs ?? []).filter((r) => r.asks).map((r) => [r.id, r.title, r.asks!.text]);
    const prs = (s?.prs ?? []).map((p) => [p.key, p.waitingOn, p.since, p.stalled, p.sessionTitle, p.title]);
    const ls = (s?.listeners ?? []).map((l) => [l.pid, l.project, l.card]);
    return JSON.stringify([cards.map((c) => [c.id, c.status, c.kind, c.title, c.since, c.from, c.session, c.answers.length, c.comments.length, c.closedAt]), asks, prs, ls, [...this.busy], [...this.reopened]]);
  }

  private renderCards(now: number): void {
    const root = this.cardsEl;
    // keep the focused textarea's caret across a rebuild
    const active = document.activeElement as HTMLTextAreaElement | null;
    const focusId = active?.dataset?.card;
    const caret = focusId ? [active!.selectionStart, active!.selectionEnd] : undefined;

    root.replaceChildren();
    this.mediaSize.disconnect();
    const cards = this.snapshot?.cards ?? [];
    const open = cards
      .filter((c) => c.status === "open")
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cardStart(a).localeCompare(cardStart(b)));
    const answered = cards.filter((c) => c.status === "answered");
    const closed = cards.filter((c) => c.status === "closed");

    if (!open.length) {
      const empty = el("div", "pw-empty pw-all-clear", undefined, root);
      this.icon(empty, "check");
      el("span", undefined, this.snapshot ? "Nothing needs you" : "Loading…", empty);
    }
    // one light section per project, the project with the oldest card first
    const byProject = new Map<string, Card[]>();
    for (const c of open) {
      if (!byProject.has(c.project)) byProject.set(c.project, []);
      byProject.get(c.project)!.push(c);
    }
    for (const [project, list] of byProject) {
      const now_ = list.filter((c) => c.kind !== "todo");
      const later = list.filter((c) => c.kind === "todo");
      const body = this.foldGroup(root, `cards:${project}`, project, false, (head) => {
        for (const k of KIND_ORDER) {
          const n = list.filter((c) => c.kind === k).length;
          if (n) this.badge(head, KIND_ICON[k], n, `${n} ${KIND_LABEL[k].toLowerCase()}`, `pw-kind-${k}`);
        }
      });
      for (const c of now_) body.appendChild(this.card(c, now));
      if (later.length) {
        // nothing waits on these, so they start folded under a quiet line
        const todo = this.foldGroup(body, `todo:${project}`, "", true, (head) => {
          this.badge(head, KIND_ICON.todo, later.length, `${later.length} to do, nothing waits on these`, "pw-kind-todo");
        });
        todo.parentElement!.classList.add("pw-todo-group");
        for (const c of later) todo.appendChild(this.card(c, now));
      }
    }

    // a session that ended its turn with a question in chat, read from its log
    const asking = (this.snapshot?.runs ?? []).filter((r) => r.asks);
    if (asking.length) {
      const body = this.foldGroup(root, "asks", "Asked in chat", false, (head) => {
        this.badge(head, "message-circle-question", asking.length, `${asking.length} asked in chat, without a card (read from the session log)`, "pw-asks");
      });
      for (const r of asking) body.appendChild(this.askRow(r, now));
    }

    const prs = this.snapshot?.prs ?? [];
    const reviews = prs.filter((p) => p.reviewRequested && !p.mine);
    const waiting = prs.filter((p) => !(p.reviewRequested && !p.mine));
    if (reviews.length) {
      const body = this.foldGroup(root, "reviews", "Reviews for you", false, (head) => {
        this.badge(head, "git-pull-request", reviews.length, `${reviews.length} pull request${reviews.length === 1 ? "" : "s"} asking for your review`);
      });
      for (const p of reviews) body.appendChild(this.prRow(p, now));
    }
    if (waiting.length) {
      const stuck = waiting.filter((p) => p.stalled).length;
      const body = this.foldGroup(root, "waiting", "Waiting on others", false, (head) => {
        this.badge(head, "git-pull-request", waiting.length, `${waiting.length} open pull request${waiting.length === 1 ? "" : "s"}${stuck ? `, ${stuck} stuck` : ""}`, stuck ? "is-stuck" : "");
      });
      for (const p of waiting) body.appendChild(this.prRow(p, now));
    }

    if (answered.length) {
      const s = el("div", "pw-section", undefined, root);
      this.badge(s, "hourglass", answered.length, `${answered.length} answered, waiting for the agent`);
      for (const c of answered) root.appendChild(this.pastCard(c, now));
    }

    if (closed.length) {
      // done with, kept so their builds, videos and pictures can be opened again; starts folded
      const body = this.foldGroup(root, "closed", "", true, (head) => {
        this.badge(head, "archive", closed.length, `${closed.length} closed, newest first`);
      });
      body.parentElement!.classList.add("pw-closed-group");
      for (const c of closed) body.appendChild(this.pastCard(c, now));
    }

    if (focusId) {
      const t = root.querySelector<HTMLTextAreaElement>(`textarea[data-card="${focusId}"]`);
      if (t) {
        t.focus();
        if (caret) t.setSelectionRange(caret[0] ?? 0, caret[1] ?? 0);
      }
    }
  }

  /** A light, collapsible section; returns the element to put its rows in. */
  private foldGroup(parent: HTMLElement, key: string, name: string, startCollapsed = false, decorate?: (head: HTMLElement) => void): HTMLElement {
    const box = el("div", "pw-fold-group", undefined, parent);
    const head = el("div", "pw-fold-head", undefined, box);
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const chevron = el("span", "pw-chevron", undefined, head);
    this.host.icon(chevron, "chevron-down");
    if (name) el("span", "pw-fold-name", name, head);
    if (decorate) decorate(el("span", "pw-fold-badges", undefined, head));
    const body = el("div", "pw-fold-body", undefined, box);
    // a group that starts collapsed remembers being opened instead of being closed
    const stored = startCollapsed ? `open:${key}` : key;
    this.foldable(box, head, stored, startCollapsed);
    return body;
  }

  /** Make `head` open and shut `box`, remembering the choice under `stored`. */
  private foldable(box: HTMLElement, head: HTMLElement, stored: string, startCollapsed = false): void {
    const isShut = () => (startCollapsed ? !this.collapsed.has(stored) : this.collapsed.has(stored));
    const apply = () => {
      const shut = isShut();
      box.classList.toggle("is-collapsed", shut);
      head.setAttribute("aria-expanded", String(!shut));
    };
    const toggle = () => {
      if (this.collapsed.has(stored)) this.collapsed.delete(stored);
      else this.collapsed.add(stored);
      saveCollapsed(this.collapsed);
      apply();
    };
    head.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button, a")) return;
      toggle();
    };
    head.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    };
    apply();
  }

  /** `grouped`: the card sits under its project's section, so the head shows only the task. */
  private cardHead(c: Card, box: HTMLElement, now: number, grouped = false): void {
    const head = el("div", "pw-card-head", undefined, box);
    const kind = this.icon(head, KIND_ICON[c.kind], `pw-kind pw-kind-${c.kind}`);
    kind.removeAttribute("aria-hidden");
    kind.setAttribute("role", "img");
    kind.setAttribute("aria-label", KIND_LABEL[c.kind]);
    kind.title = KIND_LABEL[c.kind];
    const where = grouped ? (c.task ?? "") : c.project + (c.task ? ` / ${c.task}` : "");
    if (where) el("span", "pw-card-project", where, head);
    this.fromLine(c, head);
    const start = cardStart(c);
    const opened = `Card ${c.id}, opened ${new Date(c.openedAt).toLocaleString()}`;
    const meta = el("span", "pw-meta pw-card-age", undefined, head);
    this.icon(meta, "clock");
    let age: HTMLElement;
    if (start !== c.openedAt) {
      // moved from somewhere else: show when it first came up, not when the card was made
      age = el("span", undefined, shortDate(start), meta);
      meta.title = `First came up ${new Date(start).toLocaleDateString()}\n${opened}`;
    } else if (now - Date.parse(start) > 2 * DAY) {
      age = el("span", undefined, shortDate(start), meta);
      meta.title = opened;
    } else {
      age = el("span", undefined, ago(start, now), meta);
      age.dataset.since = start;
      meta.title = opened;
    }
  }

  private card(c: Card, now: number): HTMLElement {
    const box = el("div", `pw-card pw-card-${c.kind}`);
    box.dataset.cardId = c.id;
    const busy = this.busy.has(c.id);
    if (busy) box.classList.add("is-busy");
    this.cardHead(c, box, now, true);
    el("div", "pw-card-title", c.title, box);
    this.cardDetail(c, box);
    this.reply(c, box, busy);
    return box;
  }

  /** What the card says and carries: body, what to look at, things to open, media, comments. */
  private cardDetail(c: Card, box: HTMLElement): void {
    if (c.body) this.host.renderMarkdown(c.body, el("div", "pw-card-body markdown-rendered", undefined, box));
    if (c.action) this.actionLine(c, box);
    if (c.preview) this.previewBlock(c, box);
    if (c.look) {
      const look = el("div", "pw-look", undefined, box);
      this.icon(look, "eye").title = "Look at";
      el("span", "pw-look-text", c.look, look);
    }
    const refs = el("div", "pw-refs", undefined, box);
    if (c.previewFile) refs.appendChild(this.fileLink(c.previewFile, "file", "Open the file the preview came from"));
    for (const target of c.open ?? []) {
      const b = el("button", "pw-ref", undefined, refs);
      this.icon(b, "external-link", "pw-btn-icon");
      el("span", undefined, basename(target), b);
      b.title = `Open ${target}`;
      b.onclick = () => this.backend.open(target);
      this.withMenu(b, target);
    }
    const media = (c.attach ?? []).filter((f) => IMAGE.test(f) || VIDEO.test(f));
    for (const f of (c.attach ?? []).filter((x) => !media.includes(x))) refs.appendChild(this.fileLink(f));
    if (!refs.childElementCount) refs.remove();
    if (media.length) this.media(media, el("div", "pw-media", undefined, box));
    if (c.comments.length) {
      const log = el("div", "pw-comments", undefined, box);
      for (const m of c.comments) {
        const human = m.by === "human";
        const line = el("div", `pw-comment pw-by-${human ? "human" : "agent"}`, undefined, log);
        this.icon(line, human ? "user" : "bot").title = human ? "You" : "Agent";
        el("span", undefined, m.text, line);
      }
    }
  }

  /** The first line of the action next to the play icon; the whole text under a disclosure. */
  private actionLine(c: Card, box: HTMLElement): void {
    const act = el("div", "pw-action", undefined, box);
    this.icon(act, "play").title = "Runs if you say yes";
    const action = c.action ?? "";
    const first = action.split("\n")[0] ?? "";
    const short = first.length > ACTION_CHARS ? first.slice(0, ACTION_CHARS).trimEnd() + "…" : first;
    const more = short !== action;
    const main = el("div", "pw-action-main", undefined, act);
    const row = el("div", "pw-action-row", undefined, main);
    el("code", "pw-action-text", short, row);
    if (c.changedAt) el("span", "pw-meta pw-changed", `changed ${clock(c.changedAt)}`, row).title = `The approval text was changed at ${new Date(c.changedAt).toLocaleString()}`;
    if (!more) return;
    const key = `action:${c.id}`;
    const d = el("details", "pw-action-more", undefined, main);
    d.open = this.unfolded.has(key);
    d.addEventListener("toggle", () => {
      if (d.open) this.unfolded.add(key);
      else this.unfolded.delete(key);
    });
    el("summary", undefined, "details", d);
    el("code", "pw-action-full", action, d);
  }

  /** The preview text, folded to a few lines; Markdown files are rendered without their frontmatter. */
  private previewBlock(c: Card, box: HTMLElement): void {
    const text = c.preview ?? "";
    const markdown = /\.(md|markdown)$/i.test(c.previewFile ?? "") || /^---\r?\n/.test(text);
    const shown = markdown ? stripFrontmatter(text) : text;
    const long = shown.split("\n").length > PREVIEW_LINES;
    const key = `preview:${c.id}`;
    const wrap = el("div", "pw-preview-wrap", undefined, box);
    const view = el(markdown ? "div" : "pre", `pw-preview${markdown ? " markdown-rendered" : ""}`, undefined, wrap);
    if (markdown) this.host.renderMarkdown(shown, view);
    else view.textContent = shown;
    if (!long) return;
    const toggle = el("button", "pw-preview-toggle", undefined, wrap);
    const apply = () => {
      const open = this.unfolded.has(key);
      view.classList.toggle("is-collapsed", !open);
      toggle.textContent = open ? "Show less" : "Show all";
    };
    toggle.onclick = () => {
      if (this.unfolded.has(key)) this.unfolded.delete(key);
      else this.unfolded.add(key);
      apply();
    };
    apply();
  }

  /** Who asked, with a link that opens their session and puts a line about the card on the clipboard. */
  /** The machine a card came from, when it is not this one (shared logs only). */
  private elsewhere(c: { dev?: string }): string | undefined {
    const me = this.snapshot?.devices?.me;
    return me && c.dev && c.dev !== me ? c.dev : undefined;
  }

  private fromLine(c: Card, head: HTMLElement): void {
    const away = this.elsewhere(c);
    if (!c.from && !c.session && !away) return;
    const who = c.from ?? (c.session ? `session ${c.session.slice(0, 8)}` : "");
    // a session on another machine cannot be opened from here
    const row = el(c.session && !away ? "a" : "span", "pw-meta pw-from", undefined, head);
    const mark = this.icon(row, away ? "monitor" : "bot");
    const run = !away && c.session ? this.snapshot?.runs?.find((r) => r.id === c.session) : undefined;
    if (run) this.siteSlot(mark, siteForRun(run));
    el("span", "pw-from-name", [who, away ? `on ${away}` : ""].filter(Boolean).join(" "), row);
    if (away) row.title = `Asked on ${away}`;
    if (!c.session || away) return;
    const link = row as HTMLAnchorElement;
    link.href = "#";
    link.title = `Open this session in Claude and copy a line about ${c.id} to paste there`;
    link.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.backend
        .goto(c.id)
        .then(() => this.host.notice(`Opened ${who}. A line about ${c.id} is on your clipboard; paste it to talk about this card.`))
        .catch((err) => this.host.notice(err instanceof Error ? err.message : String(err)));
    };
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
        const rec = c.recommend === n;
        const b = el("button", rec ? "pw-option is-recommended" : "pw-option", undefined, opts);
        el("span", "pw-option-n", String(n), b);
        el("span", "pw-option-text", o, b);
        if (rec) {
          this.icon(b, "check", "pw-option-rec");
          b.title = "Recommended";
        }
        b.onclick = () => send({ choice: n });
        buttons.push(b);
      });
    }

    const line = el("div", "pw-reply-line", undefined, wrap);
    const note = el("textarea", "pw-note", undefined, line);
    note.dataset.card = c.id;
    note.rows = 1;
    note.placeholder = c.kind === "decide" ? (c.options?.length ? "Note" : "Answer") : c.kind === "try" ? "What did you see?" : "Note";
    note.title = "Paste or drop an image to attach. ⌘↩ sends.";
    note.value = draft.note;
    let primary: HTMLButtonElement | undefined;
    if (c.kind === "try" || c.kind === "block" || c.kind === "todo") {
      const label = c.kind === "try" ? "Looks good" : "Done";
      primary = el("button", "pw-round pw-done", undefined, line);
      this.icon(primary, "check");
      primary.title = label;
      primary.setAttribute("aria-label", label);
      primary.dataset.say = label;
    }
    const sendNote = el("button", "pw-round pw-send", undefined, line);
    this.icon(sendNote, "arrow-up");
    sendNote.title = "Send note (⌘↩)";
    sendNote.setAttribute("aria-label", "Send note");
    const chips = el("div", "pw-chips", undefined, wrap);
    buttons.push(sendNote);
    if (primary) {
      buttons.push(primary);
      primary.onclick = () => send({ comment: draft.note.trim() || primary!.dataset.say! });
    }

    const sync = () => {
      const empty = !draft.note.trim() && !draft.attach.length;
      wrap.classList.toggle("has-draft", !empty);
      sendNote.disabled = busy || empty;
      for (const b of buttons) if (b !== sendNote) b.disabled = busy;
      note.disabled = busy;
      chips.replaceChildren();
      for (const f of draft.attach) {
        const chip = el("span", "pw-chip", undefined, chips);
        this.icon(chip, "paperclip");
        el("span", undefined, basename(f), chip);
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

  /**
   * An answered or closed card: its title and your answer, folded. Click it to read the whole card
   * again and open what it carried.
   */
  private pastCard(c: Card, now: number): HTMLElement {
    const box = el("div", `pw-card pw-card-past pw-card-${c.status}`);
    box.dataset.cardId = c.id;
    const open = this.reopened.has(c.id);
    box.classList.toggle("is-open", open);
    const top = el("div", "pw-past-top", undefined, box);
    top.setAttribute("role", "button");
    top.tabIndex = 0;
    top.setAttribute("aria-expanded", String(open));
    this.cardHead(c, top, now);
    const title = el("div", "pw-past-title", undefined, top);
    el("div", "pw-card-title", c.title, title);
    this.icon(title, "chevron-down", "pw-chevron");
    for (const a of c.answers.filter((x) => x.by === "human")) {
      const parts: string[] = [];
      if (a.choice !== undefined) parts.push(`${a.choice}${c.options?.[a.choice - 1] ? `. ${c.options[a.choice - 1]}` : ""}`);
      if (a.comment) parts.push(`“${a.comment}”`);
      if (a.attach?.length) parts.push(`${a.attach.length} attached`);
      const line = el("div", a.late ? "pw-answer is-late" : "pw-answer", undefined, top);
      this.icon(line, "corner-down-right").title = "Your answer";
      el("span", undefined, parts.join(", "), line);
      const away = this.elsewhere(a);
      if (a.late) {
        const n = el("span", "pw-meta", ` · not used: answered${a.dev ? ` on ${a.dev}` : ""} at the same time as the answer above`, line);
        n.title = "Two machines answered before either saw the other. The earlier answer stands.";
      } else if (away) el("span", "pw-meta", ` · on ${away}`, line);
    }
    if (c.status === "answered" && !waitingFor(c, this.snapshot?.listeners ?? []).length) {
      const n = el("div", "pw-delivery", "No agent is waiting. It gets your answer on its next turn.", top);
      n.title = "No `parawatch wait` is running for this project";
    }
    if (c.status === "closed" && c.closeNote) {
      const line = el("div", "pw-answer pw-close-note", undefined, top);
      this.icon(line, "archive").title = "Closed";
      el("span", undefined, c.closeNote, line);
    }
    const toggle = () => {
      if (this.reopened.has(c.id)) this.reopened.delete(c.id);
      else this.reopened.add(c.id);
      this.cardsSig = "";
      this.update(undefined, this.error);
    };
    top.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button, a")) return;
      toggle();
    };
    top.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    };
    if (open) {
      // built only when opened, so a long list does not load every video
      const detail = el("div", "pw-past-detail", undefined, box);
      this.cardDetail(c, detail);
      const sent = c.answers.filter((x) => x.by === "human").flatMap((a) => a.attach ?? []);
      if (sent.length) {
        const media = sent.filter((f) => IMAGE.test(f) || VIDEO.test(f));
        const refs = el("div", "pw-refs", undefined, detail);
        for (const f of sent.filter((x) => !media.includes(x))) refs.appendChild(this.fileLink(f));
        if (!refs.childElementCount) refs.remove();
        if (media.length) this.media(media, el("div", "pw-media", undefined, detail));
      }
      if (!detail.childElementCount) el("div", "pw-meta pw-past-empty", "Nothing more on this card", detail);
    }
    return box;
  }

  /** Pictures and videos at their own shape, in rows that fill the card (see layoutMedia). */
  private media(files: string[], row: HTMLElement): void {
    this.mediaSize.observe(row);
    for (const f of files) {
      const item = el("div", "pw-media-item", undefined, row);
      item.title = f;
      this.withMenu(item, f);
      const fit = (w: number, h: number) => {
        if (!(w > 0 && h > 0)) return;
        item.dataset.ar = String(w / h);
        layoutMedia(row);
      };
      if (IMAGE.test(f) || VIDEO.test(f)) {
        const video = VIDEO.test(f);
        const m = video ? el("video", "pw-media-video", undefined, item) : el("img", "pw-media-img", undefined, item);
        if (video) m.addEventListener("loadedmetadata", () => fit((m as HTMLVideoElement).videoWidth, (m as HTMLVideoElement).videoHeight));
        else m.addEventListener("load", () => fit((m as HTMLImageElement).naturalWidth, (m as HTMLImageElement).naturalHeight));
        if (video) {
          (m as HTMLVideoElement).controls = true;
          (m as HTMLVideoElement).preload = "metadata";
          // the file is already on this machine; its own menu (right click) has the file actions
          m.setAttribute("controlslist", "nodownload noremoteplayback");
        } else (m as HTMLImageElement).alt = basename(f);
        void this.backend.mediaUrl(f).then((url) => {
          if (url) m.src = url;
          else item.replaceChildren(this.fileLink(f));
        });
        if (!video) m.onclick = () => this.backend.open(f);
      } else item.appendChild(this.fileLink(f));
    }
  }

  private fileLink(f: string, icon?: string, hint?: string): HTMLElement {
    const b = el("button", "pw-ref pw-file");
    this.icon(b, icon ?? (URL_RE.test(f) ? "link" : "paperclip"), "pw-btn-icon");
    el("span", undefined, basename(f), b);
    b.title = hint ? `${hint}: ${f}` : f;
    b.onclick = () => this.backend.open(f);
    this.withMenu(b, f);
    return b;
  }

  /** Right click shows the host's menu for the file instead of the page's own. */
  private withMenu(target: HTMLElement, file: string): void {
    const menu = this.backend.targetMenu;
    if (!menu) return;
    target.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.call(this.backend, file);
    });
  }

  // ---------------------------------------------------------------- agents

  /**
   * The agents as a chart: one lane per run over the last hour, its active minutes drawn as
   * segments, now at the right edge. The whole block folds away to one line of counts.
   */
  private renderAgents(now: number): void {
    const root = this.agentsEl;
    root.replaceChildren();
    const runs = this.snapshot?.runs ?? [];
    const working = runs.filter((r) => r.state === "working" || r.state === "waiting").length;
    const head = el("div", "pw-agents-head", undefined, root);
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const lead = el("div", "pw-agents-title", undefined, head);
    const chevron = el("span", "pw-chevron", undefined, lead);
    this.host.icon(chevron, "chevron-down");
    this.badge(lead, "activity", working, `${working} agent${working === 1 ? "" : "s"} working, ${runs.length} in the last hours`, working ? "" : "is-zero");
    const axis = el("div", "pw-axis", undefined, head);
    axis.setAttribute("aria-hidden", "true");
    el("span", undefined, `−${CHART_MINUTES}m`, axis);
    el("span", undefined, `−${CHART_MINUTES / 2}m`, axis);
    el("span", undefined, "now", axis);
    const body = el("div", "pw-agents-body", undefined, root);
    this.foldable(root, head, "agents");
    if (!runs.length) {
      el("div", "pw-empty", this.snapshot ? "No agent activity in the last hours." : "Loading…", body);
      return;
    }
    // minutes in the chart count back from when the snapshot was taken
    const at = this.snapshot ? Date.parse(this.snapshot.generatedAt) : now;
    for (const g of groupRuns(runs, now, this.expanded)) {
      const other = g.name === "other";
      const rows = this.foldGroup(body, `agents:${g.name}`, other ? "Other" : g.name, false, (h) => {
        if (other) h.title = "Not in a registered project";
        if (g.working) this.badge(h, "activity", g.working, `${g.working} working`);
      });
      for (const row of g.rows) rows.appendChild("run" in row ? this.runRow(row, now, at) : this.foldRow(row, now));
    }
  }

  /** A session that asked the human something in chat: open it to answer. */
  private askRow(r: Run, now: number): HTMLElement {
    const row = el("div", `pw-ask${r.asks!.blocked ? " is-blocked" : ""}`);
    const top = el("div", "pw-ask-top", undefined, row);
    const who = el("a", "pw-ask-who", r.title, top);
    (who as HTMLAnchorElement).href = "#";
    who.title = "Open this session to answer";
    who.onclick = (e) => {
      e.preventDefault();
      void this.backend.goto(r.id).catch((err) => this.host.notice(err instanceof Error ? err.message : String(err)));
    };
    if (r.project) el("span", "pw-meta", r.project + (r.task ? ` / ${r.task}` : ""), top);
    el("span", "pw-meta pw-ask-age", ago(r.asks!.at ?? r.lastActivity, now), top);
    el("div", "pw-ask-text", clean(r.asks!.text), row);
    row.title = r.asks!.via === "wrap_up" ? "The session's end-of-turn summary asks you this" : "The session's last message ends with this question";
    return row;
  }

  /** A pull request: what it waits on and since when, and the session that owns it. */
  private prRow(p: PrView, now: number): HTMLElement {
    const row = el("div", `pw-pr${p.stalled ? " is-stuck" : ""}`);
    const top = el("div", "pw-pr-top", undefined, row);
    this.siteSlot(this.icon(top, "git-pull-request", "pw-pr-icon"), siteForPr(p));
    const label = el("a", "pw-pr-label", `${p.repo.split("/")[1]}#${p.number}`, top);
    (label as HTMLAnchorElement).href = "#";
    label.title = `Open ${p.url}`;
    label.onclick = (e) => {
      e.preventDefault();
      this.backend.open(p.url);
    };
    const review = p.reviewRequested && !p.mine;
    const wait = review ? "your review" : p.waitingOn + (p.waitingOn === "review" && p.who?.length ? ` (${p.who.join(", ")})` : "");
    el("span", "pw-pr-wait", p.stalled ? `stuck in ${wait}` : wait, top);
    el("span", "pw-meta", ago(p.since, now), top).title = `Waiting on this since ${new Date(p.since).toLocaleString()}`;
    el("div", "pw-pr-title", p.title, row);
    if (p.session || p.project) {
      const own = el(p.session ? "a" : "span", "pw-meta pw-pr-owner", undefined, row);
      this.icon(own, "bot");
      el("span", undefined, p.sessionTitle ?? p.project ?? p.session!.slice(0, 8), own);
      if (p.session) {
        (own as HTMLAnchorElement).href = "#";
        own.title = "Open the session that owns this pull request";
        own.onclick = (e) => {
          e.preventDefault();
          void this.backend.goto(p.session!).catch((err) => this.host.notice(err instanceof Error ? err.message : String(err)));
        };
      }
    }
    return row;
  }

  private runIcon(r: Run): string {
    if (r.role === "lead") return "network";
    if (r.kind === "declared") return "timer";
    if (r.kind === "subagent") return "corner-down-right";
    return "terminal";
  }

  private runRow({ run: r, depth }: RunNode, now: number, at: number): HTMLElement {
    const row = el("div", `pw-run pw-state-${r.state}${r.role === "lead" ? " is-lead" : ""}${depth ? " is-child" : ""}`);
    row.style.setProperty("--pw-depth", String(depth));
    const who = el("div", "pw-run-who", undefined, row);
    const mark = el("span", "pw-run-mark", undefined, who);
    this.siteSlot(this.icon(mark, this.runIcon(r), "pw-run-icon"), siteForRun(r));
    if (r.role === "lead") this.icon(mark, "network", "pw-run-lead");
    el("span", "pw-run-dot", undefined, mark);
    const service = serviceName(r);
    mark.title = `${service ? `${service} ${r.kind}` : r.kind === "declared" ? "declared job" : `${r.runtime} ${r.kind}`}${r.role === "lead" ? " (lead)" : ""} · ${STATE_LABEL[r.state]}`;
    const text = el("div", "pw-run-text", undefined, who);
    const title = el("span", "pw-run-title", r.title, text);
    // a session on another machine cannot be opened from here
    if (r.runtime === "claude-code" && r.kind === "session" && !r.device) {
      title.classList.add("is-link");
      title.setAttribute("role", "link");
      title.tabIndex = 0;
      const go = () =>
        void this.backend.goto(r.id).catch((err) => this.host.notice(err instanceof Error ? err.message : String(err)));
      title.onclick = go;
      title.onkeydown = (e) => {
        if (e.key === "Enter") go();
      };
    }
    const what = r.error
      ? `unreadable: ${r.error}`
      : r.done
        ? `done · ${clean(r.done)}`
        : r.asks
          ? `${r.asks.blocked ? "blocked" : "asks"}: ${clean(r.asks.text)}`
          : clean((r.state === "idle" && r.recap) || r.action);
    if (r.repeats) el("span", "pw-run-repeats", `×${r.repeats + 1}`, text).title = `${r.repeats + 1} runs of this scheduled task; the newest is shown`;
    const sub = el("div", "pw-run-sub", undefined, text);
    if (r.asks) sub.classList.add(r.asks.blocked ? "is-blocked" : "is-asking");
    el("span", "pw-run-age", ago(r.lastActivity, now), sub);
    if (r.device) el("span", "pw-run-device", `on ${r.device}`, sub);
    if (what || r.state === "stalled") el("span", "pw-run-action", r.state === "stalled" ? `stalled${what ? ` · ${what}` : ""}` : what, sub);
    row.appendChild(this.lane(r, at, now));
    const hide = el("button", "pw-run-hide clickable-icon", undefined, row);
    this.host.icon(hide, "eye-off");
    hide.title = "Hide until it does something new";
    hide.setAttribute("aria-label", "Hide until it does something new");
    hide.onclick = () =>
      void this.backend.hideRun(r.id).then(() => this.host.refresh(), (err) => this.host.notice(err instanceof Error ? err.message : String(err)));
    row.title = [
      `${r.title}`,
      `${STATE_LABEL[r.state]}${r.lastActivity ? `, last activity ${new Date(r.lastActivity).toLocaleTimeString()}` : ""}`,
      `${r.runtime} ${r.kind}${r.model ? ` (${r.model})` : ""} · ${r.id}${r.device ? ` · on ${r.device}` : ""}`,
      r.cwd ?? "",
      clean(r.action),
    ]
      .filter(Boolean)
      .join("\n");
    return row;
  }

  /** One lane of the chart: the run's active minutes, merged into segments. */
  private lane(r: Run, at: number, now: number): HTMLElement {
    const lane = el("div", "pw-lane");
    lane.setAttribute("aria-hidden", "true");
    // the snapshot may be a little old; slide the chart so its right edge stays at now
    const shift = Math.max(0, Math.floor((now - at) / 60_000));
    const mins = (r.activity ?? []).map((m) => m + shift).filter((m) => m < CHART_MINUTES);
    const live = r.state === "working" || r.state === "waiting";
    const bad = r.state === "stalled" || r.state === "failed";
    for (let i = 0; i < mins.length; ) {
      let j = i;
      while (j + 1 < mins.length && mins[j + 1] === mins[j]! + 1) j++;
      const newest = mins[i]!;
      const oldest = mins[j]!;
      const seg = el("i", undefined, undefined, lane);
      seg.style.left = `${((CHART_MINUTES - 1 - oldest) / CHART_MINUTES) * 100}%`;
      seg.style.width = `${((oldest - newest + 1) / CHART_MINUTES) * 100}%`;
      if (i === 0 && newest <= 1 && live) seg.className = "is-live";
      if (i === 0 && bad) seg.className = "is-bad";
      i = j + 1;
    }
    return lane;
  }

  private foldRow(f: FoldNode, now: number): HTMLElement {
    const row = el("div", "pw-run pw-fold is-child");
    row.style.setProperty("--pw-depth", String(f.depth));
    const who = el("div", "pw-run-who", undefined, row);
    this.icon(who, "chevrons-down", "pw-run-icon");
    const text = el("div", "pw-run-text", undefined, who);
    el("span", "pw-run-title", `${f.folded.length} finished`, text);
    const newest = f.folded.map((r) => r.lastActivity ?? "").sort().pop();
    el("div", "pw-run-sub", ago(newest, now), text);
    el("div", "pw-lane", undefined, row).setAttribute("aria-hidden", "true");
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

const COLLAPSED_KEY = "parawatch:collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  } catch {
    // storage unavailable; the state lasts for this session only
  }
}
