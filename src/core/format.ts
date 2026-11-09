import type { InboxItem } from "./ops.js";
import type { Card, PrView, Run } from "./types.js";

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "?";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// ------------------------------------------------------------------ terminal

export interface View {
  color: boolean;
  /** terminal columns; every line stays within this */
  width: number;
  /** show runtime and ids */
  wide: boolean;
  /** show finished subagents one by one instead of as a count */
  all: boolean;
}

export function view(opts: { wide?: boolean; all?: boolean } = {}): View {
  const out = process.stdout;
  const color = process.env.NO_COLOR ? false : process.env.FORCE_COLOR ? true : Boolean(out.isTTY);
  const width = out.columns || Number(process.env.COLUMNS) || 120;
  return { color, width: Math.max(50, width), wide: Boolean(opts.wide), all: Boolean(opts.all) };
}

const PLAIN: View = { color: false, width: 120, wide: false, all: false };

const SGR = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36" } as const;
type Paint = keyof typeof SGR;

function paint(v: View, s: string, ...codes: Paint[]): string {
  if (!v.color || !s || !codes.length) return s;
  return `\x1b[${codes.map((c) => SGR[c]).join(";")}m${s}\x1b[0m`;
}

function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Columns a string takes in a terminal (CJK and emoji count as two). */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Cut to at most `max` columns, ending with … when cut. */
export function fit(s: string, max: number): string {
  if (max <= 0) return "";
  if (textWidth(s) <= max) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const c = charWidth(ch.codePointAt(0)!);
    if (w + c > max - 1) break;
    out += ch;
    w += c;
  }
  return out + "…";
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - textWidth(s)));
}

/** One line of plain text from an agent message: no markdown, no line breaks. */
export function clean(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/^\s*(?:[-*>]|#+)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------------ cards

const KIND_LABEL: Record<Card["kind"], string> = { decide: "decide", try: "try", block: "blocked", todo: "to do" };
const KIND_PAINT: Record<Card["kind"], Paint> = { decide: "yellow", try: "cyan", block: "red", todo: "blue" };

/** When the matter came up: `since` when it is older than the card, else when the card opened. */
export function cardStart(c: Card): string {
  return c.since && c.since < c.openedAt ? c.since : c.openedAt;
}

/** Cards as aligned rows: id, kind, project, title, age. */
export function cardRows(cards: Card[], v: View = PLAIN, now = Date.now(), indent = "", extra: Record<string, string> = {}): string[] {
  const idW = Math.max(3, ...cards.map((c) => c.id.length));
  const projW = Math.min(16, Math.max(0, ...cards.map((c) => textWidth(c.project + (c.task ? `/${c.task}` : "")))));
  const noteOf = (c: Card) => (c.status === "answered" ? " · answered" : c.status === "closed" ? " · closed" : "") + (extra[c.id] ? ` · ${extra[c.id]}` : "");
  const fixed = textWidth(indent) + idW + 2 + 7 + 2 + projW + 2 + 2 + 4;
  const titleW = Math.min(v.width - fixed, Math.max(0, ...cards.map((c) => textWidth(c.title + noteOf(c)))));
  return cards.map((c) => {
    const proj = c.project + (c.task ? `/${c.task}` : "");
    const age = ago(cardStart(c), now).padStart(4);
    const note = noteOf(c);
    const title = fit(c.title, titleW - textWidth(note));
    const dim = c.status !== "open";
    return [
      indent,
      paint(v, pad(c.id, idW), "bold"),
      "  ",
      paint(v, pad(KIND_LABEL[c.kind], 7), dim ? "dim" : KIND_PAINT[c.kind]),
      "  ",
      pad(fit(proj, projW), projW),
      "  ",
      paint(v, pad(title + note, titleW), ...(dim ? (["dim"] as Paint[]) : [])),
      "  ",
      paint(v, age, "dim"),
    ].join("");
  });
}

export function cardLine(c: Card, now = Date.now()): string {
  return cardRows([c], PLAIN, now)[0]!.trimEnd();
}

export function cardDetail(c: Card): string {
  const out: string[] = [];
  out.push(`${c.id} · ${KIND_LABEL[c.kind]} · ${c.project}${c.task ? ` [${c.task}]` : ""} · ${c.status}`);
  out.push(c.title);
  if (c.body) out.push("", c.body);
  if (c.options?.length) {
    out.push("");
    c.options.forEach((o, i) => out.push(`  ${i + 1}. ${o}${c.recommend === i + 1 ? "  (recommended)" : ""}`));
  }
  if (c.action) out.push("", `Runs on yes: ${c.action}`);
  if (c.preview) out.push("", "Preview:", ...c.preview.split("\n").map((l) => `  ${l}`));
  if (c.look) out.push("", `Look at: ${c.look}`);
  for (const o of c.open ?? []) out.push(`Open: ${o}`);
  for (const a of c.attach ?? []) out.push(`Attached: ${a}`);
  if (c.from || c.session) out.push(`From: ${[c.from, c.session ? `session ${c.session.slice(0, 8)}` : ""].filter(Boolean).join(", ")}`);
  out.push(`Opened: ${new Date(c.openedAt).toLocaleString()}${c.since ? `, first came up ${new Date(c.since).toLocaleDateString()}` : ""}`);
  for (const a of c.answers) {
    const choice = a.choice !== undefined ? ` chose ${a.choice}${c.options?.[a.choice - 1] ? ` (${c.options[a.choice - 1]})` : ""}` : "";
    out.push("", `${a.by}${choice}${a.comment ? `: ${a.comment}` : ""}`);
    for (const f of a.attach ?? []) out.push(`  attached ${f}`);
  }
  for (const m of c.comments) out.push(`${m.by}: ${m.text}`);
  if (c.closeNote) out.push("", `Closed: ${c.closeNote}`);
  return out.join("\n");
}

const PR_WORDS: Record<string, string> = {
  review: "new review",
  approved: "approved",
  changes_requested: "changes requested",
  commented: "new comment",
  ci_failed: "CI failed",
  ci_passed: "CI passed",
  queued: "entered the merge queue",
  queue_removed: "left the merge queue without merging",
  conflict: "has a merge conflict",
  merged: "merged",
  closed: "closed without merging",
  note: "note",
};

export function prChangeText(change: string, by?: string): string {
  const w = PR_WORDS[change] ?? change;
  return by && by !== "github" && by !== "external" ? `${w} by ${by}` : w;
}

export function inboxLine(i: InboxItem): string {
  if (i.kind === "pr" && i.pr) {
    const p = i.pr;
    return `[${p.project ?? "?"}] PR ${p.ref.repo}#${p.ref.number}${p.title ? ` "${p.title}"` : ""}: ${prChangeText(p.change, i.by)}${p.text ? `; ${p.text}` : ""} (${p.ref.url})`;
  }
  const card = i.card!;
  const head = `[${card.project}] ${card.id} "${card.title}"`;
  if (i.kind === "comment") return `${head} comment: ${i.comment}`;
  const parts: string[] = [];
  if (i.choice !== undefined) parts.push(`chose ${i.choice}${i.choiceText ? ` (${i.choiceText})` : ""}`);
  if (i.comment) parts.push(`said: ${i.comment}`);
  if (i.attach?.length) parts.push(`attached: ${i.attach.join(", ")}`);
  return `${head} ${parts.join("; ")}`;
}

const STATE_MARK: Record<Run["state"], string> = {
  working: "●",
  waiting: "◐",
  idle: "○",
  done: "✓",
  stalled: "!",
  failed: "✗",
  unknown: "?",
};

const STATE_PAINT: Record<Run["state"], Paint[]> = {
  working: ["green"],
  waiting: ["yellow"],
  idle: ["dim"],
  done: ["dim"],
  stalled: ["red"],
  failed: ["red"],
  unknown: ["dim"],
};

const ENDED = new Set<Run["state"]>(["done", "idle"]);

// ------------------------------------------------------------------ pull requests

function prLabel(p: PrView): string {
  return `${p.repo.split("/")[1]}#${p.number}`;
}

/** Open pull requests: what each waits on, for how long, and the session that owns it. */
export function prRows(prs: PrView[], v: View = PLAIN, now = Date.now(), indent = ""): string[] {
  const idW = Math.max(4, ...prs.map((p) => textWidth(prLabel(p))));
  const waitW = Math.min(30, Math.max(6, ...prs.map((p) => textWidth(waitText(p)))));
  const ownW = Math.min(24, Math.max(0, ...prs.map((p) => textWidth(ownerText(p)))));
  const fixed = textWidth(indent) + idW + 2 + waitW + 2 + 4 + 2 + (ownW ? ownW + 2 : 0);
  const titleW = Math.max(8, v.width - fixed);
  return prs.map((p) => {
    const age = ago(p.since, now).padStart(4);
    return [
      indent,
      paint(v, pad(prLabel(p), idW), "bold"),
      "  ",
      paint(v, pad(fit(waitText(p), waitW), waitW), ...(p.stalled ? (["red"] as Paint[]) : ["yellow"] as Paint[])),
      "  ",
      paint(v, age, ...(p.stalled ? (["red"] as Paint[]) : ["dim"] as Paint[])),
      "  ",
      ownW ? paint(v, pad(fit(ownerText(p), ownW), ownW), "dim") + "  " : "",
      fit(p.title, titleW),
    ].join("").trimEnd();
  });
}

export function waitText(p: PrView): string {
  if (p.reviewRequested && !p.mine) return `${p.stalled ? "long " : ""}waiting for your review`;
  const who = p.who?.length && p.waitingOn === "review" ? ` (${p.who.join(", ")})` : "";
  return `${p.stalled ? "stuck in " : ""}${p.waitingOn}${who}`;
}

function ownerText(p: PrView): string {
  return p.sessionTitle ?? (p.project ? p.project + (p.task ? `/${p.task}` : "") : "");
}

/** Sessions that asked the human something in chat instead of on a card. */
export function askRows(runs: Run[], v: View = PLAIN, now = Date.now(), indent = ""): string[] {
  const asking = runs.filter((r) => r.asks);
  const nameW = Math.min(32, Math.max(8, ...asking.map((r) => textWidth(r.title))));
  return asking.map((r) => {
    const age = ago(r.asks!.at ?? r.lastActivity, now).padStart(4);
    const room = Math.max(8, v.width - textWidth(indent) - nameW - 2 - 4 - 2 - 10);
    const where = r.project ? `${r.project}` : "other";
    return [
      indent,
      paint(v, pad(fit(r.title, nameW), nameW), "bold"),
      "  ",
      paint(v, age, "dim"),
      "  ",
      paint(v, fit(clean(r.asks!.text), room), ...(r.asks!.blocked ? (["red"] as Paint[]) : ["yellow"] as Paint[])),
      "  ",
      paint(v, `(${where})`, "dim"),
    ].join("");
  });
}
/** Finished subagents older than this fold into one "N finished" line. */
const FOLD_AFTER_MS = 5 * 60_000;
export const OTHER = "other";

function whatText(r: Run): string {
  if (r.error) return `unreadable: ${r.error}`;
  if (r.done) return `done · ${clean(r.done)}`;
  if (r.asks) return `${r.asks.blocked ? "blocked" : "asks"}: ${clean(r.asks.text)}`;
  const a = clean((r.state === "idle" && r.recap) || r.action || "");
  if (r.state === "stalled") return a ? `stalled · ${a}` : "stalled";
  return a;
}

const SOURCE_NOTE: Partial<Record<NonNullable<Run["projectSource"]>, string>> = { edits: "~edits", prompt: "~prompt" };

interface Row {
  prefix: string;
  run?: Run;
  folded?: { count: number; newest?: string };
}

/** Runs grouped by project, children drawn as a tree under their parent, one terminal line each. */
export function runsTree(runs: Run[], v: View = PLAIN, now = Date.now(), indent = ""): string {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = r.project ?? OTHER;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const names = [...groups.keys()].sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)));

  // rows first, so every group shares one set of columns
  const blocks: { name: string; rows: Row[] }[] = [];
  for (const name of names) {
    const rs = groups.get(name)!;
    const ids = new Set(rs.map((r) => r.id));
    const rows: Row[] = [];
    const walk = (r: Run, prefix: string, cont: string) => {
      rows.push({ prefix, run: r });
      const kids = rs.filter((x) => x.parent === r.id);
      const shown = v.all ? kids : kids.filter((k) => !(ENDED.has(k.state) && now - Date.parse(k.lastActivity ?? "") > FOLD_AFTER_MS));
      const folded = kids.filter((k) => !shown.includes(k));
      const items: (Run | Row["folded"])[] = [...shown];
      if (folded.length) items.push({ count: folded.length, newest: folded.map((k) => k.lastActivity ?? "").sort().pop() });
      items.forEach((it, i) => {
        const last = i === items.length - 1;
        const p = cont + (last ? "└ " : "├ ");
        const c = cont + (last ? "  " : "│ ");
        if (it && "id" in it) walk(it, p, c);
        else rows.push({ prefix: p, folded: it });
      });
    };
    for (const r of rs.filter((r) => !r.parent || !ids.has(r.parent))) walk(r, indent + "  ", indent + "  ");
    blocks.push({ name, rows });
  }

  const all = blocks.flatMap((b) => b.rows);
  const nameW = Math.min(
    Math.max(24, Math.floor(v.width * 0.4)),
    Math.max(12, ...all.map((row) => textWidth(row.prefix) + 2 + textWidth(row.run?.title ?? ""))),
  );
  const wideW = v.wide ? 24 : 0;

  const out: string[] = [];
  for (const { name, rows } of blocks) {
    if (name === OTHER) out.push(indent + paint(v, "other", "bold") + paint(v, "  not in a registered project", "dim"));
    else out.push(indent + paint(v, name, "bold"));
    for (const row of rows) {
      const lead = paint(v, row.prefix, "dim");
      const room = nameW - textWidth(row.prefix) - 2;
      if (row.folded) {
        const label = `✓ ${row.folded.count} finished`;
        out.push(lead + paint(v, pad(fit(label, room + 2), room + 2), "dim") + "  " + paint(v, ago(row.folded.newest, now).padStart(4), "dim"));
        continue;
      }
      const r = row.run!;
      const ended = ENDED.has(r.state);
      const titlePaint: Paint[] = r.role === "lead" ? ["bold"] : ended ? ["dim"] : [];
      const mark = paint(v, STATE_MARK[r.state], ...STATE_PAINT[r.state]);
      const label = r.title + (r.repeats ? ` ×${r.repeats + 1}` : "") + (r.prs?.length ? ` (${r.prs.length} PR)` : "");
      const title = paint(v, pad(fit(label, room), room), ...titlePaint);
      const age = paint(v, ago(r.lastActivity, now).padStart(4), "dim");
      const src = (r.projectSource && SOURCE_NOTE[r.projectSource]) || "";
      const wide = v.wide ? "  " + paint(v, pad(fit(`${r.kind === "subagent" ? r.model ?? "subagent" : r.runtime} ${r.id.slice(0, 8)}${src ? " " + src : ""}`, wideW - 2), wideW - 2), "dim") : "";
      const restW = v.width - nameW - 2 - 4 - wideW - 2;
      const whatPaint: Paint[] = r.error || r.state === "stalled" || r.state === "failed" || r.asks?.blocked ? ["red"] : r.asks ? ["yellow"] : ended ? ["dim"] : [];
      const what = restW >= 8 ? "  " + paint(v, fit(whatText(r), restW), ...whatPaint) : "";
      out.push(`${lead}${mark} ${title}  ${age}${wide}${what}`.trimEnd());
    }
  }
  return out.join("\n");
}
