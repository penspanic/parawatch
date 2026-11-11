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
import type { EventBody, PrChange, PrRef, PrView, PwEvent, Run } from "./types.js";

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
    url = execFileSync("gh", ["pr", "view", n[1]!, "--json", "url", "-q", ".url"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
  } catch (err) {
    throw new UserError(`could not look up #${n[1]} with gh here: ${String((err as { stderr?: string }).stderr ?? err).trim().split("\n")[0]}`);
  }
  const ref = parsePrRef(url);
  if (!ref) throw new UserError(`gh returned "${url}", which is not a pull request URL`);
  return ref;
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

export interface GithubCache {
  fetchedAt?: string;
  error?: string;
  /** hosts `gh` is signed in to; empty when `gh` is missing or signed out */
  hosts?: string[];
  prs: PrStatus[];
  /** what each PR waits on and since when */
  since: Record<string, { waitingOn: string; since: string }>;
}

export function cachePath(): string {
  return path.join(homeDir(), "github.json");
}

export function readCache(): GithubCache {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as GithubCache;
    return { ...c, prs: c.prs ?? [], since: c.since ?? {} };
  } catch {
    return { prs: [], since: {} };
  }
}

function writeCache(c: GithubCache): void {
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = `${cachePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c) + "\n");
  fs.renameSync(tmp, cachePath());
}

/** Runs `gh`; tests swap this for a fake. */
export type GhRunner = (args: string[]) => Promise<string>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });

/** Hosts `gh` is signed in to. */
export async function ghHosts(gh: GhRunner = runGh): Promise<string[]> {
  try {
    const out = JSON.parse(await gh(["auth", "status", "--json", "hosts"])) as { hosts?: Record<string, { state?: string }[]> };
    return Object.entries(out.hosts ?? {})
      .filter(([, accounts]) => accounts.some((a) => a.state === "success"))
      .map(([h]) => h);
  } catch {
    return [];
  }
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

/** Every open PR the human wrote or is asked to review on one host, plus the extra ones named. */
export async function fetchHost(host: string, extra: PrRef[], gh: GhRunner = runGh, maxAgeDays = 60): Promise<PrStatus[]> {
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
  return [...byKey.values()];
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

/** Next cache and the events it implies, given the previous cache and a fresh reading. */
export function nextCache(prev: GithubCache, fresh: PrStatus[], hosts: string[], at: string): { cache: GithubCache; events: EventBody[] } {
  const old = new Map(prev.prs.map((p) => [p.key, p]));
  const events: EventBody[] = [];
  const since: GithubCache["since"] = {};
  for (const p of fresh) {
    const was = old.get(p.key);
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
 * Drop news another machine already reported. This machine's reading spans from its previous
 * reading (`since`) to now; the same change on the same PR that another machine wrote in that
 * span is the one this machine just noticed, maybe long after. A machine that reads GitHub for
 * the first time in hours would otherwise tell every agent again what they already handled.
 */
export function dropReported(fresh: EventBody[], log: PwEvent[], since: string | undefined, me = deviceName()): EventBody[] {
  if (!since) return fresh;
  const seen = new Set<string>();
  for (const e of log) if (e.type === "pr.change" && e.dev && e.dev !== me && e.ts >= since) seen.add(`${e.pr.key}|${e.change}|${e.by ?? ""}`);
  if (!seen.size) return fresh;
  return fresh.filter((b) => b.type !== "pr.change" || !seen.has(`${b.pr.key}|${b.change}|${b.by ?? ""}`));
}

// ------------------------------------------------------------------ sync

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
  if (!takeFetch()) return prev;
  const gh = opts.gh ?? runGh;
  const started = new Date().toISOString();
  try {
    const hosts = await ghHosts(gh);
    if (!hosts.length) {
      const c: GithubCache = { ...prev, fetchedAt: started, hosts: [], error: "gh is not installed or not signed in" };
      writeCache(c);
      return c;
    }
    // PRs linked to sessions, and ones seen before, are read by number so merges and closes show
    const extra = new Map<string, PrRef>();
    for (const l of opts.state.prLinks.values()) extra.set(l.pr.key, l.pr);
    const cutoff = new Date(Date.now() - cfg.maxAgeDays * 86_400_000).toISOString();
    for (const p of prev.prs) if (p.state === "open" && p.updatedAt >= cutoff) extra.set(p.key, prRef(p.host, p.repo, p.number, p.url));
    const fresh: PrStatus[] = [];
    const errors: string[] = [];
    const allHosts = new Set([...hosts, ...[...extra.values()].map((r) => r.host)]);
    for (const host of allHosts) {
      if (!hosts.includes(host)) {
        errors.push(`gh is not signed in to ${host}`);
        continue;
      }
      try {
        fresh.push(...(await fetchHost(host, [...extra.values()].filter((r) => r.host === host).slice(0, 80), gh, cfg.maxAgeDays)));
      } catch (err) {
        errors.push(`${host}: ${(err as Error).message}`);
        // keep what we knew about that host
        fresh.push(...prev.prs.filter((p) => p.host === host));
      }
    }
    return withLock(() => {
      const latest = readCache();
      if (latest.fetchedAt && latest.fetchedAt > started) return latest; // someone else was faster
      const { cache, events } = nextCache(latest, fresh, hosts, started);
      if (errors.length) cache.error = errors.join("; ");
      appendLocked((log) => dropReported(events, log, latest.fetchedAt));
      writeCache(cache);
      return cache;
    });
  } finally {
    fs.rmSync(fetchingPath(), { force: true });
  }
}

// ------------------------------------------------------------------ views

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
