/**
 * What deserves the human's attention, kept apart from Electron so it can be tested: what the
 * badge counts, and which events become a system notification.
 */
import type { Card, PwEvent, Snapshot } from "../../../src/core/types.js";
import { inboxReason } from "../../../src/core/words.js";
import type { AboutInfo, UpdateState } from "./prefs.js";

const KIND_WORD: Record<Card["kind"], string> = { decide: "Decide", try: "Try", block: "Blocked", todo: "To do" };

/** What needs the human now: open cards that are not to-dos, and deployments waiting for approval. */
export function needsYou(s: Snapshot | undefined): number {
  return (s?.cards.filter((c) => c.status === "open" && c.kind !== "todo").length ?? 0) + (s?.deploys?.length ?? 0);
}

export function toDo(s: Snapshot | undefined): number {
  return s?.cards.filter((c) => c.status === "open" && c.kind === "todo").length ?? 0;
}

/** Some agent is busy right now, so the menu bar icon shows movement. */
export function agentsWorking(s: Snapshot | undefined): boolean {
  return s?.runs.some((r) => r.state === "working") ?? false;
}

/** Pull request news worth a notification: things that stop it from landing, and the landing. */
const PR_ALERTS: Partial<Record<string, string>> = {
  changes_requested: "changes requested",
  ci_failed: "CI failed",
  conflict: "merge conflict",
  queue_removed: "dropped from the merge queue",
  merged: "merged",
};

/**
 * What became stuck since the last look: a pull request waiting too long in one state, or a job
 * that stopped showing signs of life. `seen` remembers what was already reported.
 */
export function newlyStuck(s: Snapshot | undefined, seen: Set<string>): Alert[] {
  if (!s) return [];
  const out: Alert[] = [];
  const now = new Set<string>();
  for (const p of s.prs ?? []) {
    if (!p.stalled || (p.reviewRequested && !p.mine)) continue;
    const key = `pr:${p.key}:${p.waitingOn}`;
    now.add(key);
    if (!seen.has(key)) out.push({ title: `${p.repo.split("/")[1]}#${p.number} stuck in ${p.waitingOn}`, body: p.title, focus: `pr:${p.key}`, url: p.url });
  }
  for (const r of s.runs) {
    if (r.state !== "stalled" || r.kind !== "declared") continue;
    const key = `run:${r.id}`;
    now.add(key);
    if (!seen.has(key)) out.push({ title: "A job stopped showing signs of life", body: r.action ? `${r.title}: ${r.action}` : r.title });
  }
  // forget what got unstuck, so it is reported again if it sticks again
  for (const k of [...seen]) if (!now.has(k)) seen.delete(k);
  for (const k of now) seen.add(k);
  return out;
}

export interface Alert {
  title: string;
  body: string;
  /** the card to show when the notification is clicked */
  card?: string;
  /** what to bring into view in the window on a click: `pr:<key>`, `issue:<key>`, `inbox:<key>` */
  focus?: string;
  /** the page behind it, opened when the window no longer shows it (a pull request already merged) */
  url?: string;
  /** the same thing told twice in one go (an assignment read as an issue and as a notification) is told once */
  dedupe?: string;
}

/** What the notification rules need to know beyond the event. */
export interface AlertContext {
  runTitle(id: string): string | undefined;
  /** a live session owns this pull request, so it hears the news itself */
  ownedLive?(prKey: string): boolean;
}

/**
 * The notification an event deserves, if any: a card that needs the human, a declared job that
 * failed, GitHub news that needs the human, and what another person sent them. To-dos, answers,
 * comments and closes stay quiet. So does pull request news a live session owns (the session is
 * told), and news a late reading found: it is old by the time it shows.
 */
export function alertFor(ev: PwEvent, state: AlertContext): Alert | undefined {
  if (ev.type === "card.open") {
    const c = ev.card;
    if (c.kind === "todo") return undefined;
    return { title: `${c.project} · ${KIND_WORD[c.kind]}`, body: c.title, card: c.id };
  }
  if (ev.type === "pr.change" && PR_ALERTS[ev.change]) {
    if (ev.late || state.ownedLive?.(ev.pr.key)) return undefined;
    return {
      title: `${ev.pr.repo.split("/")[1]}#${ev.pr.number} · ${PR_ALERTS[ev.change]}${ev.by && ev.source === "github" ? ` by ${ev.by}` : ""}`,
      body: ev.text ? `${ev.title ?? ""}\n${ev.text}`.trim() : (ev.title ?? ev.pr.url),
      focus: `pr:${ev.pr.key}`,
      url: ev.pr.url,
    };
  }
  if (ev.type === "issue.change") {
    if (ev.late) return undefined;
    const where = `${ev.issue.repo.split("/")[1]}#${ev.issue.number}`;
    const what = ev.change === "assigned" ? `assigned to you${ev.by ? ` by ${ev.by}` : ""}` : `${ev.by ?? "someone"} commented`;
    return { title: `${where} · ${what}`, body: ev.title ?? ev.issue.url, focus: `issue:${ev.issue.key}`, url: ev.issue.url, dedupe: ev.issue.url };
  }
  if (ev.type === "deploy.change" && (ev.change === "waiting" || ev.change === "failed")) {
    if (ev.late) return undefined;
    const d = ev.deploy;
    const where = `${d.repo.split("/")[1]} ${d.environments.map((e) => e.name).join(", ")}`;
    return {
      title: `${where} · ${ev.change === "waiting" ? "deploy waits for you" : "deploy failed"}`,
      body: `${d.workflow}: ${d.title}`.trim(),
      focus: `deploy:${d.key}`,
      url: d.url,
      dedupe: `${d.url}|${ev.change}`,
    };
  }
  if (ev.type === "inbox.new") {
    if (ev.late) return undefined;
    const t = ev.thread;
    const where = t.number !== undefined ? `${t.repo.split("/")[1]}#${t.number}` : t.repo;
    return { title: `${where} · ${inboxReason(t)}`, body: t.title, focus: `inbox:${t.key}`, url: t.url, dedupe: t.url };
  }
  if (ev.type === "run.end" && ev.status === "failed") {
    const title = state.runTitle(ev.run) ?? ev.run;
    return { title: "A job failed", body: ev.note ? `${title}: ${ev.note}` : title };
  }
  return undefined;
}

/**
 * Alerts that came in together, as notifications: the same thing told twice once, and more than
 * a few at a time as one notification that names them, so a burst does not pile up on the screen.
 */
export function combineAlerts(alerts: Alert[], most = 3): Alert[] {
  const seen = new Set<string>();
  const one = alerts.filter((a) => {
    if (!a.dedupe) return true;
    if (seen.has(a.dedupe)) return false;
    seen.add(a.dedupe);
    return true;
  });
  if (one.length <= most) return one;
  // a card is a question to answer: it keeps its own notification
  const cards = one.filter((a) => a.card);
  const rest = one.filter((a) => !a.card);
  if (rest.length <= 1) return one;
  const lines = rest.slice(0, most).map((a) => a.title);
  if (rest.length > most) lines.push(`and ${rest.length - most} more`);
  return [...cards, { title: `${rest.length} updates on GitHub and jobs`, body: lines.join("\n"), focus: "news" }];
}

/** One line on what needs the human, for the menu bar menu and tooltip. */
export function summary(s: Snapshot | undefined): string {
  const n = needsYou(s);
  const t = toDo(s);
  const parts = [n ? `${n} need${n === 1 ? "s" : ""} you` : "Nothing needs you"];
  if (t) parts.push(`${t} to do`);
  return parts.join(" · ");
}

/** One line on where the app's own update stands, for the settings screen. */
export function updateLabel(u: UpdateState | undefined, now = Date.now()): string {
  if (!u) return "";
  const ago = (iso?: string) => {
    if (!iso) return "";
    const m = Math.round((now - Date.parse(iso)) / 60_000);
    return m < 1 ? " just now" : m < 60 ? ` ${m} min ago` : m < 48 * 60 ? ` ${Math.round(m / 60)} h ago` : ` ${Math.round(m / 1440)} days ago`;
  };
  switch (u.status) {
    case "off":
      return u.reason ? u.reason.charAt(0).toUpperCase() + u.reason.slice(1) : "Updates are off";
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking…";
    case "latest":
      return `Up to date · checked${ago(u.checkedAt)}`;
    case "available":
      return `${u.version} found, downloading…`;
    case "downloading":
      return `Downloading ${u.version ?? "the update"}${u.percent !== undefined ? ` · ${u.percent}%` : ""}`;
    case "ready":
      return u.interrupted ? `${u.version} was not installed · restart to try again` : `${u.version} is ready · restart to use it`;
    case "error":
      return `Could not check: ${u.error ?? "unknown error"}`;
  }
}

/** A new GitHub issue with the versions filled in; the rest is for the human to write. */
export function issueUrl(a: AboutInfo): string {
  const body = [
    "**What happened**",
    "",
    "",
    "**What you expected**",
    "",
    "",
    "**Versions**",
    `- Parawatch app ${a.version} (Electron ${a.electron})`,
    `- ${a.cli ? `parawatch CLI ${a.cli.version}` : "parawatch CLI not used"}`,
    `- ${a.platform}`,
    "",
    "If you can, paste the output of `parawatch doctor` and attach the log file (Help > Show Log File); look through both for anything private first.",
  ].join("\n");
  return `https://github.com/penspanic/parawatch/issues/new?body=${encodeURIComponent(body)}`;
}
