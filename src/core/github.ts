/**
 * Pull requests through the GitHub CLI (`gh`). Parawatch never holds a token: it runs `gh`, which
 * the human has already signed in, and reads what it prints. Without `gh`, or signed out, all of
 * this stays off and nothing else changes.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./ops.js";
import type { State } from "./state.js";
import { appendLocked, deviceName, homeDir, withLock } from "./store.js";
import type { EventBody, InboxThread, IssueChange, IssueRef, IssueView, NewsItem, PrChange, PrRef, PrView, PwEvent, Run } from "./types.js";

// ------------------------------------------------------------------ config

export interface GithubConfig {
  enabled: boolean;
  /** how often to read GitHub while something is watching (the desktop app, a wait) */
  intervalMinutes: number;
  /** hours in one state after which a pull request counts as stalled, by `waitingOn` */
  stallHours: Record<string, number>;
  /** pull requests nobody touched for longer are left out, unless a session owns them */
  maxAgeDays: number;
}

export const DEFAULT_STALL_HOURS: Record<string, number> = {
  review: 24,
  "no reviewer": 4,
  "changes requested": 24,
  CI: 2,
  "CI failed": 4,
  conflict: 4,
  "merge queue": 6,
  "auto-merge": 6,
  merge: 24,
  "merge held": 8,
};

/** `config.json` in the parawatch home, all of it optional. */
export function githubConfig(): GithubConfig {
  let raw: { github?: Partial<GithubConfig> } = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(homeDir(), "config.json"), "utf8"));
  } catch {
    // no config file: defaults
  }
  const g = raw.github ?? {};
  return {
    enabled: process.env.PARAWATCH_GITHUB === "0" ? false : g.enabled !== false,
    intervalMinutes: typeof g.intervalMinutes === "number" && g.intervalMinutes > 0 ? g.intervalMinutes : 5,
    stallHours: { ...DEFAULT_STALL_HOURS, ...(g.stallHours ?? {}) },
    maxAgeDays: typeof g.maxAgeDays === "number" && g.maxAgeDays > 0 ? g.maxAgeDays : 60,
  };
}

// ------------------------------------------------------------------ refs

const URL_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;
const SHORT_RE = /^(?:([^/\s]+)\/)?([^/\s#]+\/[^/\s#]+)#(\d+)$/;

export function prRef(host: string, repo: string, number: number, url?: string): PrRef {
  return { key: `${host}/${repo}#${number}`, host, repo, number, url: url ?? `https://${host}/${repo}/pull/${number}` };
}

/** A PR from a URL, `owner/repo#12` or `host/owner/repo#12`, without asking GitHub. */
export function parsePrRef(input: string): PrRef | undefined {
  const t = input.trim();
  const u = URL_RE.exec(t);
  if (u) return prRef(u[1]!, u[2]!, Number(u[3]), `https://${u[1]}/${u[2]}/pull/${u[3]}`);
  const s = SHORT_RE.exec(t);
  if (s) return prRef(s[1] ?? "github.com", s[2]!, Number(s[3]));
  return undefined;
}

/** Like `parsePrRef`, but `#12` or `12` asks `gh` which repository the folder is. */
export function resolvePrRef(input: string, cwd = process.cwd()): PrRef {
  const direct = parsePrRef(input);
  if (direct) return direct;
  const n = /^#?(\d+)$/.exec(input.trim());
  if (!n) throw new UserError(`"${input}" is not a pull request: give a URL, owner/repo#N, or #N inside the repository`);
  let url: string;
  try {
    url = execFileSync(ghCommand(), ["pr", "view", n[1]!, "--json", "url", "-q", ".url"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
  } catch (err) {
    throw new UserError(`could not look up #${n[1]} with gh here: ${String((err as { stderr?: string }).stderr ?? err).trim().split("\n")[0]}`);
  }
  const ref = parsePrRef(url);
  if (!ref) throw new UserError(`gh returned "${url}", which is not a pull request URL`);
  return ref;
}

const ISSUE_URL_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/;

export function issueRef(host: string, repo: string, number: number, url?: string): IssueRef {
  return { key: `${host}/${repo}#${number}`, host, repo, number, url: url ?? `https://${host}/${repo}/issues/${number}` };
}

/** An issue from a URL, `owner/repo#12` or `host/owner/repo#12`. */
export function parseIssueRef(input: string): IssueRef | undefined {
  const t = input.trim();
  const u = ISSUE_URL_RE.exec(t);
  if (u) return issueRef(u[1]!, u[2]!, Number(u[3]));
  const s = SHORT_RE.exec(t);
  if (s) return issueRef(s[1] ?? "github.com", s[2]!, Number(s[3]));
  return undefined;
}

/** The PR a link in a run's log or a key points at. */
export function keyOf(input: string): string | undefined {
  return parsePrRef(input)?.key;
}

// ------------------------------------------------------------------ reading GitHub

/** One pull request as parawatch keeps it, a reduced copy of what GitHub reports. */
export interface PrStatus {
  key: string;
  url: string;
  host: string;
  repo: string;
  number: number;
  title: string;
  author?: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  mergeable?: string;
  /** GitHub's mergeStateStatus; BLOCKED with approvals and green CI means a rule or system other than reviews and CI holds it */
  mergeState?: string;
  reviewDecision?: string;
  /** reviewers asked and not answered yet */
  pending: string[];
  reviews: { by: string; state: string; at: string }[];
  comments: number;
  ci?: string;
  queue?: { state: string; position?: number };
  autoMerge: boolean;
  updatedAt: string;
  mine: boolean;
  reviewRequested: boolean;
}

/** An open issue assigned to the human, a reduced copy of what GitHub reports. */
export interface IssueStatus {
  key: string;
  url: string;
  host: string;
  repo: string;
  number: number;
  title: string;
  author?: string;
  assignedBy?: string;
  assignedAt?: string;
  /** the human assigned it to themselves: nothing to tell them */
  byMe?: boolean;
  /** the latest comment by someone other than the human */
  lastOther?: { by: string; at: string };
  updatedAt: string;
  /** the registered project whose repository this is, found when GitHub was read */
  project?: string;
}

export interface GithubCache {
  /** the last reading that worked; a failed one leaves it, so a reader whose gh works tries at once */
  fetchedAt?: string;
  error?: string;
  /** when the last attempt failed entirely, and which process it was */
  failedAt?: string;
  failedBy?: string;
  /** hosts `gh` is signed in to; empty when `gh` is missing or signed out */
  hosts?: string[];
  prs: PrStatus[];
  /** what each PR waits on and since when */
  since: Record<string, { waitingOn: string; since: string }>;
  /** linked PRs seen merged or closed: not asked for again */
  finished?: string[];
  /** open issues assigned to the human; absent until the first reading that asked for them */
  issues?: IssueStatus[];
  /** unread GitHub notifications from other people; absent until the first reading that asked for them */
  inbox?: InboxThread[];
}

export function cachePath(): string {
  return path.join(homeDir(), "github.json");
}

/**
 * The notifications from people live in a file of their own: a version before 0.3.27 (an agent's
 * `wait` not yet updated) rewrites github.json without them, which would empty the list and make
 * every reading after it look like the first.
 */
function inboxPath(): string {
  return path.join(homeDir(), "github-inbox.json");
}

export function readCache(): GithubCache {
  let c: GithubCache;
  try {
    c = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as GithubCache;
  } catch {
    c = { prs: [], since: {} };
  }
  let inbox = c.inbox;
  try {
    inbox = (JSON.parse(fs.readFileSync(inboxPath(), "utf8")) as { inbox?: InboxThread[] }).inbox ?? inbox;
  } catch {
    // none yet
  }
  return { ...c, prs: c.prs ?? [], since: c.since ?? {}, inbox };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n");
  fs.renameSync(tmp, file);
}

function writeCache(c: GithubCache): void {
  const { inbox, ...rest } = c;
  if (inbox) writeJson(inboxPath(), { inbox });
  writeJson(cachePath(), rest);
}

/** Runs `gh`; tests swap this for a fake. */
export type GhRunner = (args: string[]) => Promise<string>;

/** Where `gh` is usually installed, for a process whose PATH lacks it (an app opened from Finder). */
export function ghCandidates(platform = process.platform, env = process.env): string[] {
  if (platform === "win32") {
    const dirs = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")].filter((d): d is string => !!d);
    const out = dirs.map((d) => path.join(d, "GitHub CLI", "gh.exe"));
    if (env.USERPROFILE) out.push(path.join(env.USERPROFILE, "scoop", "shims", "gh.exe"));
    return out;
  }
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh", "/usr/bin/gh", "/snap/bin/gh"];
}

function onPath(name: string, env = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (fs.existsSync(path.join(dir, name + ext.toLowerCase())) || fs.existsSync(path.join(dir, name + ext))) return true;
  }
  return false;
}

let ghFound: string | undefined;

/**
 * The `gh` to run: `github.cli` in config.json, else `gh` on this process's PATH, else the first
 * usual install location that exists. Found once per process.
 */
export function ghCommand(): string {
  const configured = githubCli();
  if (configured) return configured;
  if (ghFound) return ghFound;
  ghFound = onPath("gh") ? "gh" : (ghCandidates().find((f) => fs.existsSync(f)) ?? "gh");
  return ghFound;
}

function githubCli(): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir(), "config.json"), "utf8")) as { github?: { cli?: unknown } };
    return typeof raw.github?.cli === "string" && raw.github.cli ? raw.github.cli : undefined;
  } catch {
    return undefined;
  }
}

/** A `gh` that could not be started, as opposed to one that ran and failed. */
export class GhMissing extends Error {}

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    const cmd = ghCommand();
    execFile(cmd, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") reject(new GhMissing(`gh not found on this process's PATH or in the usual places (set github.cli in config.json)`));
      else if (err) reject(new Error(String(stderr || err.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });

/** Hosts `gh` is signed in to, or why there are none. */
export async function ghAuth(gh: GhRunner = runGh): Promise<{ hosts: string[]; error?: string }> {
  try {
    const out = JSON.parse(await gh(["auth", "status", "--json", "hosts"])) as { hosts?: Record<string, { state?: string }[]> };
    const hosts = Object.entries(out.hosts ?? {})
      .filter(([, accounts]) => accounts.some((a) => a.state === "success"))
      .map(([h]) => h);
    return hosts.length ? { hosts } : { hosts, error: "gh is not signed in" };
  } catch (err) {
    return { hosts: [], error: err instanceof GhMissing ? err.message : `gh is not installed or not signed in (${(err as Error).message})` };
  }
}

/** Hosts `gh` is signed in to. */
export async function ghHosts(gh: GhRunner = runGh): Promise<string[]> {
  return (await ghAuth(gh)).hosts;
}

/** Which kind of process this is, for saying who could not read GitHub. */
function whoReads(): string {
  return process.versions.electron ? "the desktop app" : "the command line";
}

const FIELDS = (withQueue: boolean) => `
  number title url state isDraft mergeable reviewDecision updatedAt
  author { login }
  repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } } }
  latestReviews(first: 30) { nodes { author { login } state submittedAt } }
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  ${withQueue ? "mergeQueueEntry { state position }\n  autoMergeRequest { enabledAt }\n  mergeStateStatus" : ""}`;

const ISSUE_FIELDS = `
  number title url updatedAt
  author { login }
  repository { nameWithOwner }
  timelineItems(itemTypes: [ASSIGNED_EVENT], last: 10) { nodes { ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } } } } }
  comments(last: 20) { nodes { author { login } createdAt } }`;

function gqlString(s: string): string {
  return JSON.stringify(s);
}

function buildQuery(extra: PrRef[], withQueue: boolean, updatedSince: string): string {
  const aliases = extra
    .map((r, i) => {
      const [owner, name] = r.repo.split("/");
      return `  p${i}: repository(owner: ${gqlString(owner!)}, name: ${gqlString(name!)}) { pullRequest(number: ${r.number}) { ...P } }`;
    })
    .join("\n");
  return `query {
  viewer { login }
  mine: search(query: "is:pr is:open author:@me archived:false updated:>=${updatedSince}", type: ISSUE, first: 50) { nodes { ...P } }
  asked: search(query: "is:pr is:open review-requested:@me archived:false updated:>=${updatedSince}", type: ISSUE, first: 30) { nodes { ...P } }
  assigned: search(query: "is:issue is:open assignee:@me archived:false updated:>=${updatedSince}", type: ISSUE, first: 30) { nodes { ... on Issue {${ISSUE_FIELDS}
  } } }
${aliases}
}
fragment P on PullRequest {${FIELDS(withQueue)}
}`;
}

type Obj = Record<string, unknown>;
const o = (x: unknown): Obj => (typeof x === "object" && x !== null ? (x as Obj) : {});
const s = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

function toStatus(host: string, node: Obj, viewer: string, asked: boolean): PrStatus | undefined {
  const repo = s(o(node.repository).nameWithOwner);
  const number = typeof node.number === "number" ? node.number : undefined;
  if (!repo || number === undefined) return undefined;
  const ref = prRef(host, repo, number, s(node.url));
  const author = s(o(node.author).login);
  const pending = ((o(node.reviewRequests).nodes as unknown[]) ?? [])
    .map((n) => {
      const r = o(o(n).requestedReviewer);
      return s(r.login) ?? s(r.name);
    })
    .filter((x): x is string => Boolean(x));
  const reviews = ((o(node.latestReviews).nodes as unknown[]) ?? []).map((n) => ({
    by: s(o(o(n).author).login) ?? "someone",
    state: s(o(n).state) ?? "COMMENTED",
    at: s(o(n).submittedAt) ?? "",
  }));
  const commit = o(o(((o(node.commits).nodes as unknown[]) ?? [])[0]).commit);
  const queue = o(node.mergeQueueEntry);
  const state = s(node.state);
  return {
    key: ref.key,
    url: ref.url,
    host,
    repo,
    number,
    title: s(node.title) ?? "",
    author,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    draft: node.isDraft === true,
    mergeable: s(node.mergeable),
    mergeState: s(node.mergeStateStatus),
    reviewDecision: s(node.reviewDecision) ?? undefined,
    pending,
    reviews,
    comments: typeof o(node.comments).totalCount === "number" ? (o(node.comments).totalCount as number) : 0,
    ci: s(o(commit.statusCheckRollup).state),
    queue: s(queue.state) ? { state: s(queue.state)!, position: typeof queue.position === "number" ? queue.position : undefined } : undefined,
    autoMerge: Boolean(node.autoMergeRequest),
    updatedAt: s(node.updatedAt) ?? new Date().toISOString(),
    mine: Boolean(viewer) && author === viewer,
    reviewRequested: asked,
  };
}

/** One open issue from a search result, with who assigned it to `viewer` and the latest comment by anyone else. */
export function toIssue(host: string, node: Obj, viewer: string): IssueStatus | undefined {
  const repo = s(o(node.repository).nameWithOwner);
  const number = typeof node.number === "number" ? node.number : undefined;
  if (!repo || number === undefined) return undefined;
  const ref = issueRef(host, repo, number, s(node.url));
  const assigned = ((o(node.timelineItems).nodes as unknown[]) ?? [])
    .map((n) => o(n))
    .filter((n) => s(o(n.assignee).login) === viewer)
    .pop();
  const others = ((o(node.comments).nodes as unknown[]) ?? [])
    .map((n) => ({ by: s(o(o(n).author).login) ?? "someone", at: s(o(n).createdAt) ?? "" }))
    .filter((c) => c.by !== viewer && c.at);
  return {
    key: ref.key,
    url: ref.url,
    host,
    repo,
    number,
    title: s(node.title) ?? "",
    author: s(o(node.author).login),
    assignedBy: assigned ? s(o(assigned.actor).login) : undefined,
    assignedAt: assigned ? s(assigned.createdAt) : undefined,
    byMe: assigned ? s(o(assigned.actor).login) === viewer || undefined : undefined,
    lastOther: others.pop(),
    updatedAt: s(node.updatedAt) ?? new Date().toISOString(),
  };
}

/** Every open PR the human wrote or is asked to review on one host, plus the extra ones named, and the issues assigned to the human. */
export async function fetchHost(host: string, extra: PrRef[], gh: GhRunner = runGh, maxAgeDays = 60): Promise<{ prs: PrStatus[]; issues: IssueStatus[]; viewer: string }> {
  const updatedSince = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  const ask = async (withQueue: boolean) => JSON.parse(await gh(["api", "graphql", "--hostname", host, "-f", `query=${buildQuery(extra, withQueue, updatedSince)}`])) as Obj;
  let out: Obj;
  try {
    out = await ask(true);
  } catch (err) {
    // older GitHub Enterprise servers have no merge queue fields, nor mergeStateStatus
    if (!/mergeQueueEntry|autoMergeRequest|mergeStateStatus/.test(String((err as Error).message))) throw err;
    out = await ask(false);
  }
  const data = o(out.data);
  const viewer = s(o(data.viewer).login) ?? "";
  const byKey = new Map<string, PrStatus>();
  const put = (node: unknown, asked: boolean) => {
    const st = toStatus(host, o(node), viewer, asked);
    if (!st) return;
    const had = byKey.get(st.key);
    byKey.set(st.key, had ? { ...st, reviewRequested: had.reviewRequested || asked } : st);
  };
  for (const n of (o(data.mine).nodes as unknown[]) ?? []) put(n, false);
  for (const n of (o(data.asked).nodes as unknown[]) ?? []) put(n, true);
  extra.forEach((_, i) => {
    const pr = o(o(data[`p${i}`]).pullRequest);
    if (Object.keys(pr).length) put(pr, false);
  });
  const issues = ((o(data.assigned).nodes as unknown[]) ?? []).map((n) => toIssue(host, o(n), viewer)).filter((x): x is IssueStatus => Boolean(x));
  return { prs: [...byKey.values()], issues, viewer };
}

// ------------------------------------------------------------------ notifications from people

const SUBJECT_RE = /\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases|discussions)\/([^/?#]+)/;
const SUBJECT_KIND: Record<string, InboxThread["kind"]> = { pulls: "pr", issues: "issue", commits: "commit", releases: "release", discussions: "discussion" };
/** Reasons that are about the human whoever's thread it is: someone asked for them. */
const PERSONAL = new Set(["mention", "team_mention", "assign", "review_requested", "approval_requested", "invitation", "security_alert", "member_feature_requested"]);
/** CI news reaches the session that owns the pull request, and shows on it. */
const NOT_INBOX = new Set(["ci_activity"]);
/** Comment authors looked up per reading at most; the rest wait for the next one. */
const LOOKUPS = 50;

/** One notification as GitHub's REST API gives it, reduced; `comment` is where its latest comment is. */
export function toThread(host: string, n: Obj): { thread: Omit<InboxThread, "project">; comment?: string } | undefined {
  const id = s(n.id);
  const repo = s(o(n.repository).full_name);
  const subject = o(n.subject);
  if (!id || !repo) return undefined;
  const m = SUBJECT_RE.exec(s(subject.url) ?? "");
  const kind: InboxThread["kind"] = m ? (SUBJECT_KIND[m[2]!] ?? "other") : s(subject.type) === "Discussion" ? "discussion" : "other";
  const number = m && (kind === "pr" || kind === "issue") ? Number(m[3]) : undefined;
  const url =
    number !== undefined ? `https://${host}/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}` : kind === "release" || kind === "commit" || kind === "discussion" ? `https://${host}/${repo}/${kind}s` : `https://${host}/${repo}`;
  return {
    thread: {
      key: `${host}:${id}`,
      host,
      id,
      repo,
      kind,
      number,
      item: number !== undefined ? `${host}/${repo}#${number}` : undefined,
      title: s(subject.title) ?? "",
      reason: s(n.reason) ?? "subscribed",
      url,
      at: s(n.updated_at) ?? new Date().toISOString(),
    },
    comment: s(subject.latest_comment_url) ?? undefined,
  };
}

/**
 * The unread notifications on one host that another person caused. Left out: CI news, news on a
 * pull request a session owns (the session is told, and shows it), and threads whose latest word
 * is the human's own account (which is also every agent's) or a bot, or is not a comment at all. Someone
 * asking for the human (a mention, a review request, an assignment) always stays.
 */
export async function fetchInbox(
  host: string,
  viewer: string,
  owned: ReadonlySet<string>,
  known: ReadonlyMap<string, InboxThread>,
  gh: GhRunner = runGh,
): Promise<Omit<InboxThread, "project">[]> {
  const raw = JSON.parse(await gh(["api", "--hostname", host, "notifications?per_page=50"])) as unknown;
  const out: Omit<InboxThread, "project">[] = [];
  let lookups = 0;
  const authorOf = async (url: string): Promise<string | undefined> => {
    const p = /repos\/.*$/.exec(url)?.[0];
    if (!p || lookups >= LOOKUPS) return undefined;
    lookups++;
    try {
      return s(o(o(JSON.parse(await gh(["api", "--hostname", host, p]))).user).login);
    } catch {
      return undefined;
    }
  };
  for (const n of Array.isArray(raw) ? raw : []) {
    const got = toThread(host, o(n));
    if (!got || NOT_INBOX.has(got.thread.reason)) continue;
    const t = got.thread;
    const was = known.get(t.key);
    // the same news as last time: keep who wrote it, do not ask again
    const by = was && was.at === t.at ? was.by : got.comment ? await authorOf(got.comment) : undefined;
    if (PERSONAL.has(t.reason)) {
      // who asked is not always who wrote last; name the last writer only when it is someone else
      out.push(by && by !== viewer ? { ...t, by } : t);
      continue;
    }
    if (t.item && owned.has(t.item)) continue;
    // news on the human's own threads counts only when someone else wrote it: the account's own
    // words are the human's or an agent's, and a change without a comment says nobody's
    if (!by || by === viewer || by.endsWith("[bot]")) continue;
    out.push(by ? { ...t, by } : t);
  }
  return out;
}

/**
 * The inbox news between two readings: a thread not seen before, or one with news since. The first
 * reading that asks for the inbox (`prev` absent) reports nothing; a thread marked read stays quiet
 * until it has news after that.
 */
export function nextInbox(prev: InboxThread[] | undefined, fresh: InboxThread[], read: ReadonlyMap<string, string>): EventBody[] {
  if (!prev) return [];
  const old = new Map(prev.map((t) => [t.key, t]));
  const out: EventBody[] = [];
  for (const t of fresh) {
    const was = old.get(t.key);
    if (was && was.at >= t.at) continue;
    const readAt = read.get(t.key);
    if (readAt && readAt >= t.at) continue;
    const { project: _p, ...thread } = t;
    out.push({ type: "inbox.new", thread });
  }
  return out;
}

// ------------------------------------------------------------------ what changed

/** What a PR waits on now, and on whom. */
export function waitingOn(p: PrStatus): { what: string; who?: string[] } {
  const author = p.author ? [p.author] : undefined;
  if (p.state === "merged") return { what: "merged" };
  if (p.state === "closed") return { what: "closed" };
  if (p.draft) return { what: "draft", who: author };
  if (p.mergeable === "CONFLICTING") return { what: "conflict", who: author };
  if (p.ci === "FAILURE" || p.ci === "ERROR") return { what: "CI failed", who: author };
  if (p.reviewDecision === "CHANGES_REQUESTED") {
    const by = p.reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.by);
    return { what: "changes requested", who: author ?? by };
  }
  if (p.queue) return { what: "merge queue" };
  if (p.ci === "PENDING" || p.ci === "EXPECTED") return { what: "CI" };
  // approved (or no review needed) and CI green, yet GitHub says it cannot be merged: a rule other
  // than reviews and CI, or a merge system outside GitHub, holds it. GitHub does not say who.
  if (p.mergeState === "BLOCKED" && p.reviewDecision !== "REVIEW_REQUIRED" && !p.pending.length) return { what: "merge held" };
  if (p.reviewDecision === "APPROVED") return p.autoMerge ? { what: "auto-merge" } : { what: "merge", who: author };
  if (p.pending.length) return { what: "review", who: p.pending };
  if (p.reviewDecision === "REVIEW_REQUIRED") return { what: "no reviewer", who: author };
  return { what: "merge", who: author };
}

/** A reading of a PR from before anything happened to it: open, CI running, its reviews and comments as now. */
function unseen(p: PrStatus): PrStatus {
  // a PR already finished reports only that, not the CI it had
  return { ...p, state: "open", ci: p.state === "open" ? "PENDING" : p.ci, mergeable: p.state === "open" ? undefined : p.mergeable, queue: p.queue };
}

const REVIEW_CHANGE: Record<string, PrChange> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "review", DISMISSED: "review" };

/** The events between two readings of the same PR. */
export function changesBetween(old: PrStatus, now: PrStatus): { change: PrChange; by?: string }[] {
  const out: { change: PrChange; by?: string }[] = [];
  const seen = new Set(old.reviews.map((r) => `${r.by}|${r.state}|${r.at}`));
  for (const r of now.reviews) {
    if (!seen.has(`${r.by}|${r.state}|${r.at}`)) out.push({ change: REVIEW_CHANGE[r.state] ?? "review", by: r.by });
  }
  if (now.comments > old.comments) out.push({ change: "commented" });
  const failed = (x?: string) => x === "FAILURE" || x === "ERROR";
  if (failed(now.ci) && !failed(old.ci)) out.push({ change: "ci_failed" });
  if (now.ci === "SUCCESS" && old.ci && old.ci !== "SUCCESS") out.push({ change: "ci_passed" });
  if (now.queue && !old.queue) out.push({ change: "queued" });
  if (!now.queue && old.queue && now.state === "open") out.push({ change: "queue_removed" });
  if (now.mergeable === "CONFLICTING" && old.mergeable !== "CONFLICTING") out.push({ change: "conflict" });
  if (now.state === "merged" && old.state !== "merged") out.push({ change: "merged" });
  if (now.state === "closed" && old.state === "open") out.push({ change: "closed" });
  return out;
}

/**
 * GitHub answers UNKNOWN while it works out again whether a PR merges, which it does each time the
 * base branch moves. That is no answer: keep the last one, or a PR that stays in conflict reports
 * a new conflict every time someone merges to main.
 */
function keepMergeable(p: PrStatus, old: PrStatus | undefined): PrStatus {
  if (p.state !== "open" || (p.mergeable && p.mergeable !== "UNKNOWN") || !old?.mergeable || old.mergeable === "UNKNOWN") return p;
  return { ...p, mergeable: old.mergeable };
}

/**
 * Next cache and the events it implies, given the previous cache and a fresh reading. `newlyLinked`
 * names PRs a session linked since the previous reading: one first seen with its CI already done,
 * or already merged or closed, reports that, since no earlier reading can show it changing (a CI
 * of a minute ends before the first reading).
 */
export function nextCache(
  prev: GithubCache,
  fresh: PrStatus[],
  hosts: string[],
  at: string,
  newlyLinked: ReadonlySet<string> = new Set(),
): { cache: GithubCache; events: EventBody[] } {
  const old = new Map(prev.prs.map((p) => [p.key, p]));
  const events: EventBody[] = [];
  const since: GithubCache["since"] = {};
  fresh = fresh.map((p) => keepMergeable(p, old.get(p.key)));
  for (const p of fresh) {
    const was = old.get(p.key) ?? (newlyLinked.has(p.key) ? unseen(p) : undefined);
    if (was) {
      for (const c of changesBetween(was, p)) {
        events.push({ type: "pr.change", pr: prRef(p.host, p.repo, p.number, p.url), change: c.change, title: p.title, by: c.by, source: "github" });
      }
    }
    const w = waitingOn(p).what;
    const before = prev.since[p.key];
    // first sighting: the last update is the best guess of when it entered this state
    since[p.key] = before && before.waitingOn === w ? before : { waitingOn: w, since: was ? at : p.updatedAt };
  }
  // keep closed and merged ones for a day, so the change shows, then forget them
  const dayAgo = new Date(Date.parse(at) - 86_400_000).toISOString();
  const prs = fresh.filter((p) => p.state === "open" || (since[p.key]?.since ?? at) > dayAgo);
  for (const k of Object.keys(since)) if (!prs.some((p) => p.key === k)) delete since[k];
  return { cache: { fetchedAt: at, hosts, prs, since }, events };
}

/**
 * The issue news between two readings: an issue newly assigned to the human, and a comment by
 * someone else on one already assigned. The first reading that asks for issues (`prev` absent)
 * reports nothing: what was assigned before shows in the list, without a notification each. An
 * issue assigned long ago that only now came into the reading (an old one someone touched) is
 * not news either.
 */
export function nextIssues(prev: IssueStatus[] | undefined, fresh: IssueStatus[], prevAt: string | undefined): EventBody[] {
  if (!prev) return [];
  const old = new Map(prev.map((i) => [i.key, i]));
  const events: EventBody[] = [];
  const news = (i: IssueStatus, change: IssueChange, by?: string) =>
    events.push({ type: "issue.change", issue: issueRef(i.host, i.repo, i.number, i.url), change, title: i.title, by, source: "github" });
  // a day of slack: a machine that read GitHub last night still reports what came overnight
  const recent = (at?: string) => !at || !prevAt || Date.parse(at) > Date.parse(prevAt) - 86_400_000;
  for (const i of fresh) {
    const was = old.get(i.key);
    if (!was) {
      if (!i.byMe && recent(i.assignedAt)) news(i, "assigned", i.assignedBy);
      continue;
    }
    if (i.lastOther && (!was.lastOther || i.lastOther.at > was.lastOther.at)) news(i, "commented", i.lastOther.by);
  }
  return events;
}

/**
 * Drop news another machine already reported. This machine's reading spans from its previous
 * reading (`since`) to now; the same change on the same PR that another machine wrote in that
 * span is the one this machine just noticed, maybe long after. A machine that reads GitHub for
 * the first time in hours would otherwise tell every agent again what they already handled.
 */
export function dropReported(fresh: EventBody[], log: PwEvent[], since: string | undefined, me = deviceName()): EventBody[] {
  if (!since) return fresh;
  const seen = new Set<string>();
  const key = (b: EventBody) =>
    b.type === "pr.change"
      ? `${b.pr.key}|${b.change}|${b.by ?? ""}`
      : b.type === "issue.change"
        ? `issue|${b.issue.key}|${b.change}|${b.by ?? ""}`
        : b.type === "inbox.new"
          ? `inbox|${b.thread.key}|${b.thread.at}`
          : undefined;
  for (const e of log) {
    const k = key(e);
    if (k && e.dev && e.dev !== me && e.ts >= since) seen.add(k);
  }
  if (!seen.size) return fresh;
  return fresh.filter((b) => !seen.has(key(b) ?? ""));
}

// ------------------------------------------------------------------ sync

/** A reading this long after the previous one marks what it found as late. */
export const LATE_MS = 30 * 60_000;

/** When this process last failed to read GitHub at all. */
let failedHere = 0;

/** For tests: forget this process's last failure and the gh it found. */
export function resetGithubProcess(): void {
  failedHere = 0;
  ghFound = undefined;
}

/** A failed attempt newer than the last good reading: news is not coming in. */
export function githubFailing(c: GithubCache): boolean {
  return !!c.failedAt && (!c.fetchedAt || c.failedAt > c.fetchedAt);
}

function fetchingPath(): string {
  return path.join(homeDir(), "github.fetching");
}

/** Only one process reads GitHub at a time; a crashed reader's mark goes stale after a minute. */
function takeFetch(): boolean {
  fs.mkdirSync(homeDir(), { recursive: true });
  try {
    fs.writeFileSync(fetchingPath(), String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(fetchingPath()).mtimeMs > 60_000) {
        fs.rmSync(fetchingPath(), { force: true });
        return takeFetch();
      }
    } catch {
      // gone in between; someone just finished
    }
    return false;
  }
}

export interface SyncOptions {
  /** read GitHub even if the last reading is recent */
  force?: boolean;
  gh?: GhRunner;
  state: State;
}

/**
 * Read GitHub if the last reading is older than the configured interval, record what changed as
 * `pr.change` events (they wake the agents that own the PRs), and return the cache.
 */
export async function syncGithub(opts: SyncOptions): Promise<GithubCache> {
  const cfg = githubConfig();
  const prev = readCache();
  if (!cfg.enabled) return prev;
  const age = prev.fetchedAt ? Date.now() - Date.parse(prev.fetchedAt) : Infinity;
  if (!opts.force && age < cfg.intervalMinutes * 60_000) return prev;
  // this process failed lately: wait the interval before trying again, others may still read
  if (!opts.force && Date.now() - failedHere < cfg.intervalMinutes * 60_000) return prev;
  if (!takeFetch()) return prev;
  const gh = opts.gh ?? runGh;
  const started = new Date().toISOString();
  try {
    const auth = await ghAuth(gh);
    const hosts = auth.hosts;
    if (!hosts.length) {
      failedHere = Date.now();
      return withLock(() => {
        const latest = readCache();
        if (latest.fetchedAt && latest.fetchedAt > started) return latest; // someone else read it meanwhile
        // keep the last good reading and its time: a process whose gh works reads at once
        const c: GithubCache = { ...latest, hosts: latest.hosts ?? [], error: auth.error, failedAt: started, failedBy: whoReads() };
        writeCache(c);
        return c;
      });
    }
    failedHere = 0;
    // PRs linked to sessions, and ones seen before, are read by number so merges and closes show.
    // The newest links first, leaving out the ones already seen finished: the number read is capped.
    const extra = new Map<string, PrRef>();
    const finished = new Set(prev.finished ?? []);
    const links = [...opts.state.prLinks.values()].reverse().sort((a, b) => b.at.localeCompare(a.at));
    for (const l of links) if (!finished.has(l.pr.key)) extra.set(l.pr.key, l.pr);
    const cutoff = new Date(Date.now() - cfg.maxAgeDays * 86_400_000).toISOString();
    for (const p of prev.prs) if (p.state === "open" && p.updatedAt >= cutoff) extra.set(p.key, prRef(p.host, p.repo, p.number, p.url));
    const fresh: PrStatus[] = [];
    const issues: IssueStatus[] = [];
    const inbox: InboxThread[] = [];
    const errors: string[] = [];
    const owned = new Set([...opts.state.prLinks.values()].filter((l) => l.session).map((l) => l.pr.key));
    const knownThreads = new Map((prev.inbox ?? []).map((t) => [t.key, t]));
    const allHosts = new Set([...hosts, ...[...extra.values()].map((r) => r.host)]);
    for (const host of allHosts) {
      if (!hosts.includes(host)) {
        errors.push(`gh is not signed in to ${host}`);
        continue;
      }
      try {
        const got = await fetchHost(host, [...extra.values()].filter((r) => r.host === host).slice(0, 80), gh, cfg.maxAgeDays);
        fresh.push(...got.prs);
        issues.push(...got.issues);
        try {
          inbox.push(...(await fetchInbox(host, got.viewer, owned, knownThreads, gh)));
        } catch (err) {
          errors.push(`${host} notifications: ${(err as Error).message}`);
          inbox.push(...(prev.inbox ?? []).filter((t) => t.host === host));
        }
      } catch (err) {
        errors.push(`${host}: ${(err as Error).message}`);
        // keep what we knew about that host
        fresh.push(...prev.prs.filter((p) => p.host === host));
        issues.push(...(prev.issues ?? []).filter((i) => i.host === host));
        inbox.push(...(prev.inbox ?? []).filter((t) => t.host === host));
      }
    }
    return withLock(() => {
      const latest = readCache();
      if (latest.fetchedAt && latest.fetchedAt > started) return latest; // someone else was faster
      // a first reading of everything reports nothing; after that, links made since the last reading are new
      const newly = new Set(latest.fetchedAt ? links.filter((l) => l.at > latest.fetchedAt!).map((l) => l.pr.key) : []);
      const { cache, events } = nextCache(latest, fresh, hosts, started, newly);
      const done = new Set([...(latest.finished ?? []), ...fresh.filter((p) => p.state !== "open").map((p) => p.key)]);
      cache.finished = [...done].filter((k) => opts.state.prLinks.has(k));
      const repos = projectRepos(opts.state);
      cache.issues = issues.map((i) => ({ ...i, project: repos.get(`${i.host}/${i.repo}`.toLowerCase()) }));
      cache.inbox = inbox.map((t) => ({ ...t, project: repos.get(`${t.host}/${t.repo}`.toLowerCase()) }));
      events.push(...nextIssues(latest.issues, issues, latest.fetchedAt));
      events.push(...nextInbox(latest.inbox, cache.inbox, opts.state.readThreads));
      // a reading long after the previous one finds old news: it still goes to the agents and the
      // news list, but is not notified as if it had just happened
      if (latest.fetchedAt && Date.parse(started) - Date.parse(latest.fetchedAt) > LATE_MS) {
        for (const e of events) if (e.type === "pr.change" || e.type === "issue.change" || e.type === "inbox.new") e.late = true;
      }
      if (errors.length) cache.error = errors.join("; ");
      appendLocked((log) => dropReported(events, log, latest.fetchedAt));
      writeCache(cache);
      return cache;
    });
  } finally {
    fs.rmSync(fetchingPath(), { force: true });
  }
}

// ------------------------------------------------------------------ projects by repository

/** `host/owner/repo` of a git remote URL (https, ssh or scp-like), lower case. */
export function remoteRepo(url: string): string | undefined {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[:/](?:\d+\/)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** The `origin` remote of a checkout, read from its git config (a worktree points at the main one's). */
function originOf(dir: string): string | undefined {
  try {
    let git = path.join(dir, ".git");
    if (fs.statSync(git).isFile()) {
      const to = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"))?.[1]?.trim();
      if (!to) return undefined;
      git = path.resolve(dir, to);
      const common = path.join(git, "commondir");
      if (fs.existsSync(common)) git = path.resolve(git, fs.readFileSync(common, "utf8").trim());
    }
    const config = fs.readFileSync(path.join(git, "config"), "utf8");
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1];
    return url ? remoteRepo(url) : undefined;
  } catch {
    return undefined;
  }
}

/** Registered projects by the repository their folders push to: `host/owner/repo` → project. */
export function projectRepos(state: State): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of state.projects.values()) {
    for (const dir of p.paths ?? []) {
      const repo = originOf(dir);
      if (repo && !out.has(repo)) out.set(repo, p.name);
    }
  }
  return out;
}

// ------------------------------------------------------------------ views

/**
 * Mark a notification read, on GitHub too, so it leaves GitHub's own inbox as well. It comes back
 * here when the thread gets news. Without `gh` (or on another machine's thread), it is marked read
 * here only.
 */
export async function markThreadRead(key: string, gh: GhRunner = runGh): Promise<{ onGithub: boolean }> {
  const m = /^([^:]+):(\d+)$/.exec(key);
  if (!m) throw new UserError(`"${key}" is not a notification: give the key parawatch showed (host:id)`);
  let onGithub = true;
  try {
    await gh(["api", "--hostname", m[1]!, "-X", "PATCH", `notifications/threads/${m[2]}`]);
  } catch {
    onGithub = false;
  }
  withLock(() => {
    appendLocked(() => [{ type: "inbox.read", thread: key }]);
    const c = readCache();
    if (c.inbox?.some((t) => t.key === key)) writeCache({ ...c, inbox: c.inbox.filter((t) => t.key !== key) });
  });
  return { onGithub };
}

/** Unread notifications from other people, newest first, without the ones marked read since their last news. */
export function inboxViews(cache: GithubCache, state: State): InboxThread[] {
  return (cache.inbox ?? [])
    .filter((t) => {
      const readAt = state.readThreads.get(t.key);
      return !readAt || readAt < t.at;
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** What happened on pull requests and issues since `since`, newest first, the same news from two machines once. */
export function newsViews(state: State, since: string, runs: Run[] = []): NewsItem[] {
  const out: NewsItem[] = [];
  const seen = new Map<string, number>();
  // a merge says CI passed; the line before it adds nothing
  const merged = new Set(state.news.filter((e) => e.type === "pr.change" && e.change === "merged" && e.ts >= since).map((e) => (e.type === "pr.change" ? e.pr.key : "")));
  for (const e of state.news) {
    if (e.ts < since) continue;
    const ref = e.type === "pr.change" ? e.pr : e.issue;
    if (e.change === "ci_passed" && merged.has(ref.key)) continue;
    const id = `${ref.key}|${e.change}|${e.by ?? ""}|${e.type === "pr.change" ? (e.text ?? "") : ""}`;
    const t = Date.parse(e.ts);
    const before = seen.get(id);
    // two machines read the same change within minutes of each other
    if (before !== undefined && Math.abs(t - before) < 15 * 60_000) continue;
    seen.set(id, t);
    const link = e.type === "pr.change" ? state.prLinks.get(ref.key) : undefined;
    const claim = link?.session ? state.claims.find((c) => link.session!.startsWith(c.session)) : undefined;
    const run = link?.session ? runs.find((r) => r.id.startsWith(link.session!)) : undefined;
    out.push({
      at: e.ts,
      kind: e.type === "pr.change" ? "pr" : "issue",
      key: ref.key,
      url: ref.url,
      repo: ref.repo,
      number: ref.number,
      title: e.title,
      change: e.change,
      by: e.by,
      text: e.type === "pr.change" ? e.text : undefined,
      session: link?.session,
      sessionTitle: claim?.title ?? run?.title,
      project: link?.project ?? claim?.project,
    });
  }
  return out.reverse();
}

/** Open issues assigned to the human, newest assignment first, the ones set aside last. */
export function issueViews(cache: GithubCache, state: State): IssueView[] {
  return (cache.issues ?? [])
    .map((i) => {
      const asideAt = state.aside.get(i.key);
      return {
        key: i.key,
        url: i.url,
        repo: i.repo,
        number: i.number,
        title: i.title,
        author: i.author,
        assignedBy: i.assignedBy,
        assignedAt: i.assignedAt,
        lastOther: i.lastOther,
        project: i.project,
        // set aside until someone else writes again
        aside: !!asideAt && (!i.lastOther || i.lastOther.at <= asideAt),
      };
    })
    .sort((a, b) => Number(a.aside) - Number(b.aside) || (b.assignedAt ?? "").localeCompare(a.assignedAt ?? ""));
}

/** Open PRs as `status` shows them, each with the session that owns it when one does. */
export function prViews(cache: GithubCache, state: State, runs: Run[], now = Date.now()): PrView[] {
  const cfg = githubConfig();
  const created = new Map<string, Run>();
  for (const r of runs) for (const u of r.createdPrs ?? []) {
    const k = keyOf(u);
    if (k) created.set(k, r);
  }
  return cache.prs
    .filter((p) => p.state === "open")
    .map((p) => {
      const w = waitingOn(p);
      const since = cache.since[p.key]?.since ?? p.updatedAt;
      const limit = cfg.stallHours[w.what];
      const link = state.prLinks.get(p.key);
      const run = link?.session ? runs.find((r) => r.id.startsWith(link.session!)) : created.get(p.key);
      const session = link?.session ?? run?.id;
      const claim = session ? state.claims.find((c) => session.startsWith(c.session)) : undefined;
      return {
        key: p.key,
        url: p.url,
        repo: p.repo,
        number: p.number,
        title: p.title,
        author: p.author,
        state: p.state,
        draft: p.draft,
        waitingOn: w.what,
        who: w.who,
        since,
        stalled: limit !== undefined && now - Date.parse(since) > limit * 3_600_000,
        reviewRequested: p.reviewRequested,
        mine: p.mine,
        session,
        sessionTitle: claim?.title ?? run?.title,
        project: link?.project ?? claim?.project ?? run?.project,
        task: link?.task ?? claim?.task ?? run?.task,
      };
    })
    .sort((a, b) => Number(b.stalled) - Number(a.stalled) || a.since.localeCompare(b.since));
}
