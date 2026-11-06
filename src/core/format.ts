import type { InboxItem } from "./ops.js";
import type { Card, Run } from "./types.js";

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

const KIND_LABEL: Record<Card["kind"], string> = { decide: "decide", try: "try", block: "blocked" };

export function cardLine(c: Card, now = Date.now()): string {
  const task = c.task ? ` [${c.task}]` : "";
  const status = c.status === "answered" ? " (answered)" : c.status === "closed" ? " (closed)" : "";
  return `${c.id.padEnd(4)} ${KIND_LABEL[c.kind].padEnd(8)} ${c.project}${task}  ${c.title}${status}  ${ago(c.openedAt, now)}`;
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
  if (c.look) out.push("", `Look at: ${c.look}`);
  for (const o of c.open ?? []) out.push(`Open: ${o}`);
  for (const a of c.attach ?? []) out.push(`Attached: ${a}`);
  if (c.from) out.push(`From: ${c.from}`);
  for (const a of c.answers) {
    const choice = a.choice !== undefined ? ` chose ${a.choice}${c.options?.[a.choice - 1] ? ` (${c.options[a.choice - 1]})` : ""}` : "";
    out.push("", `${a.by}${choice}${a.comment ? `: ${a.comment}` : ""}`);
    for (const f of a.attach ?? []) out.push(`  attached ${f}`);
  }
  for (const m of c.comments) out.push(`${m.by}: ${m.text}`);
  if (c.closeNote) out.push("", `Closed: ${c.closeNote}`);
  return out.join("\n");
}

export function inboxLine(i: InboxItem): string {
  const head = `[${i.card.project}] ${i.card.id} "${i.card.title}"`;
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

function runLine(r: Run, now: number): string {
  const who = r.kind === "subagent" ? `subagent${r.model ? `, ${r.model}` : ""}` : r.runtime === r.kind ? r.runtime : `${r.runtime} ${r.kind}`;
  const role = r.role ? ` ${r.role}` : "";
  const what = r.error ? `unreadable: ${r.error}` : r.action ?? "";
  return `${STATE_MARK[r.state]} ${r.title}  (${who}${role}, ${r.id.slice(0, 8)})  ${r.state} ${ago(r.lastActivity, now)}${what ? `  ${what}` : ""}`;
}

/** Runs grouped by project, children indented under their parent. */
export function runsTree(runs: Run[], now = Date.now()): string {
  const out: string[] = [];
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = r.project ?? "(no project)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const names = [...groups.keys()].sort((a, b) => (a === "(no project)" ? 1 : b === "(no project)" ? -1 : a.localeCompare(b)));
  for (const name of names) {
    const rs = groups.get(name)!;
    out.push(name);
    const ids = new Set(rs.map((r) => r.id));
    const roots = rs.filter((r) => !r.parent || !ids.has(r.parent));
    const walk = (r: Run, depth: number) => {
      out.push(`${"  ".repeat(depth + 1)}${runLine(r, now)}`);
      for (const c of rs.filter((x) => x.parent === r.id)) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
  }
  return out.join("\n");
}
