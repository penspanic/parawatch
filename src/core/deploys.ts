/**
 * Deployments waiting for the human. A GitHub Actions job that deploys to an environment with
 * required reviewers stops until one of them approves it, and GitHub tells nobody when the person
 * who started it is that reviewer. So parawatch reads, in the repositories of registered projects
 * that have such an environment, the runs that wait, keeps the ones the human can approve, and
 * records each as a `deploy.change` event: the panels show it, the desktop app notifies, and the
 * human approves or rejects it from there. What became of it (approved, rejected, how the run
 * ended) follows as more events.
 *
 * The events, not a cache, hold the list, so the phone sees it too. A decision made on the phone
 * is a `deploy.ask` to the machine that read the deployment; that machine carries it out with its
 * own `gh` and records the result.
 */
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { deployLabel, findDeploy } from "./deployViews.js";
import { projectRepos, runGh, type GhRunner } from "./github.js";
import type { DeployState, State } from "./state.js";
import { appendEvent, deviceName, homeDir } from "./store.js";
import type { DeployChange, DeployRef, EventBody, PwEvent } from "./types.js";

export { askDeploy, deployLabel, deployViews, findDeploy } from "./deployViews.js";

/** How often the repositories' environments are read again to find the ones with reviewers. */
const ENVIRONMENTS_MS = 24 * 3_600_000;
/** An approved run followed longer than this is let go without its result. */
const FOLLOW_MS = 2 * 86_400_000;

type Obj = Record<string, unknown>;
const o = (x: unknown): Obj => (x && typeof x === "object" ? (x as Obj) : {});
const s = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

export function deployKey(host: string, repo: string, run: number): string {
  return `${host}/${repo}/actions/runs/${run}`.toLowerCase();
}

/** `host`, `owner/repo` and the run id of a deployment key. */
function parseKey(key: string): { host: string; repo: string; run: number } | undefined {
  const m = /^([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(key);
  return m ? { host: m[1]!, repo: m[2]!, run: Number(m[3]) } : undefined;
}

// ------------------------------------------------------------------ which repositories

interface ReviewerRepos {
  checkedAt: string;
  /** the project repositories looked at, `host/owner/repo` */
  of: string[];
  /** those with an environment that has required reviewers */
  repos: string[];
}

function reposPath(): string {
  return path.join(homeDir(), "github-deploys.json");
}

function readReviewerRepos(): ReviewerRepos | undefined {
  try {
    return JSON.parse(fs.readFileSync(reposPath(), "utf8")) as ReviewerRepos;
  } catch {
    return undefined;
  }
}

/**
 * The project repositories with an environment that needs a reviewer, read again once a day or
 * when the projects change. A repository the human cannot read counts as having none.
 */
export async function reviewerRepos(candidates: string[], gh: GhRunner, now = Date.now()): Promise<string[]> {
  const known = readReviewerRepos();
  const same = known && known.of.length === candidates.length && candidates.every((c) => known.of.includes(c));
  if (known && same && now - Date.parse(known.checkedAt) < ENVIRONMENTS_MS) return known.repos;
  const repos: string[] = [];
  for (const c of candidates) {
    const [host, ...rest] = c.split("/");
    try {
      const envs = o(JSON.parse(await gh(["api", "--hostname", host!, `repos/${rest.join("/")}/environments`]))).environments;
      const reviewed = (Array.isArray(envs) ? envs : []).some((e) => {
        const rules = o(e).protection_rules;
        return Array.isArray(rules) && rules.some((r) => o(r).type === "required_reviewers");
      });
      if (reviewed) repos.push(c);
    } catch {
      // no access, or no environments: nothing to approve there
    }
  }
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(reposPath(), JSON.stringify({ checkedAt: new Date(now).toISOString(), of: candidates, repos } satisfies ReviewerRepos) + "\n");
  return repos;
}

// ------------------------------------------------------------------ reading

/** The runs in one repository waiting for an approval the human can give. */
export async function waitingDeploys(host: string, repo: string, gh: GhRunner, project?: string): Promise<DeployRef[]> {
  const runs = o(JSON.parse(await gh(["api", "--hostname", host, `repos/${repo}/actions/runs?status=waiting&per_page=20`]))).workflow_runs;
  const out: DeployRef[] = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const run = o(r);
    const id = typeof run.id === "number" ? run.id : undefined;
    if (id === undefined) continue;
    const pending = JSON.parse(await gh(["api", "--hostname", host, `repos/${repo}/actions/runs/${id}/pending_deployments`])) as unknown;
    const environments = (Array.isArray(pending) ? pending : [])
      .map(o)
      .filter((p) => p.current_user_can_approve === true)
      .map((p) => ({ id: Number(o(p.environment).id), name: s(o(p.environment).name) ?? "?" }))
      .filter((e) => Number.isFinite(e.id));
    if (!environments.length) continue;
    const full = s(o(run.repository).full_name) ?? repo;
    out.push({
      key: deployKey(host, full, id),
      host,
      repo: full,
      run: id,
      url: s(run.html_url) ?? `https://${host}/${full}/actions/runs/${id}`,
      workflow: s(run.name) ?? "workflow",
      title: s(run.display_title) ?? s(o(run.head_commit).message)?.split("\n")[0] ?? "",
      environments,
      startedBy: s(o(run.triggering_actor).login) ?? s(o(run.actor).login),
      ...(project ? { project } : {}),
    });
  }
  return out;
}

/** What became of a run that no longer waits: who approved or rejected it, or how it ended. */
export async function deployOutcome(d: DeployState, gh: GhRunner): Promise<{ change: DeployChange; by?: string }[]> {
  const { host, repo, run } = d.ref;
  const out: { change: DeployChange; by?: string }[] = [];
  const info = o(JSON.parse(await gh(["api", "--hostname", host, `repos/${repo}/actions/runs/${run}`])));
  if (d.status === "waiting") {
    const approvals = JSON.parse(await gh(["api", "--hostname", host, `repos/${repo}/actions/runs/${run}/approvals`])) as unknown;
    const names = new Set(d.ref.environments.map((e) => e.id));
    const decided = (Array.isArray(approvals) ? approvals : [])
      .map(o)
      .filter((a) => Array.isArray(a.environments) && a.environments.some((e) => names.has(Number(o(e).id))))
      .pop();
    const state = s(decided?.state);
    if (state === "approved" || state === "rejected") out.push({ change: state, by: s(o(decided!.user).login) });
    else if (s(info.status) === "completed") out.push({ change: "ended" });
    else return out; // in between: read again next time
    if (state !== "approved") return out;
  }
  if (s(info.status) === "completed") out.push({ change: s(info.conclusion) === "success" ? "succeeded" : "failed" });
  return out;
}

/**
 * The deployment news since the last reading: runs that now wait for the human, and what became
 * of the ones that waited or were approved. Only repositories with reviewers are read; deployments
 * another machine reported in repositories this one does not read are left to it.
 */
export async function readDeploys(state: State, hosts: string[], gh: GhRunner = runGh, now = Date.now()): Promise<{ events: EventBody[]; errors: string[] }> {
  const projects = projectRepos(state);
  const candidates = [...projects.keys()].filter((r) => hosts.includes(r.split("/")[0]!)).sort();
  const errors: string[] = [];
  if (!candidates.length) return { events: [], errors };
  const repos = await reviewerRepos(candidates, gh, now);
  const events: EventBody[] = [];
  const read = new Set<string>();
  const fresh = new Map<string, DeployRef>();
  for (const r of repos) {
    const [host, ...rest] = r.split("/");
    try {
      for (const d of await waitingDeploys(host!, rest.join("/"), gh, projects.get(r))) fresh.set(d.key, d);
      read.add(r);
    } catch (err) {
      errors.push(`${r} deployments: ${(err as Error).message}`);
    }
  }
  for (const d of fresh.values()) {
    const was = state.deploys.get(d.key);
    const sameEnvs = was && was.ref.environments.map((e) => e.id).join() === d.environments.map((e) => e.id).join();
    if (was?.status !== "waiting" || !sameEnvs) events.push({ type: "deploy.change", deploy: d, change: "waiting", source: "github" });
  }
  const repoOf = (key: string) => {
    const k = parseKey(key);
    return k ? `${k.host}/${k.repo}` : "";
  };
  for (const d of state.deploys.values()) {
    if (!read.has(repoOf(d.ref.key)) || fresh.has(d.ref.key)) continue;
    if (d.status !== "waiting" && !(d.status === "approved" && now - Date.parse(d.at) < FOLLOW_MS)) continue;
    try {
      for (const c of await deployOutcome(d, gh)) events.push({ type: "deploy.change", deploy: d.ref, change: c.change, ...(c.by ? { by: c.by } : {}), source: "github" });
    } catch (err) {
      errors.push(`${d.ref.repo} run ${d.ref.run}: ${(err as Error).message}`);
    }
  }
  return { events, errors };
}

/**
 * Drop deployment news the log already has: another machine read the same change first. The
 * latest change recorded for each run is what counts.
 */
export function dropSeenDeploys(fresh: EventBody[], log: PwEvent[]): EventBody[] {
  const last = new Map<string, DeployChange>();
  for (const e of log) if (e.type === "deploy.change") last.set(e.deploy.key, e.change);
  return fresh.filter((e) => {
    if (e.type !== "deploy.change") return true;
    if (last.get(e.deploy.key) === e.change) return false;
    last.set(e.deploy.key, e.change);
    return true;
  });
}

// ------------------------------------------------------------------ deciding

/** Approve or reject a waiting deployment with this machine's `gh`, and record it. */
export async function decideDeploy(state: State, ref: string, decision: "approved" | "rejected", gh: GhRunner = runGh): Promise<DeployState> {
  const d = findDeploy(state, ref);
  if (!d) throw new UserError(`No deployment "${ref}" here: parawatch deploy list shows the ones waiting`);
  if (d.status !== "waiting") throw new UserError(`${deployLabel(d.ref)} run ${d.ref.run} no longer waits (${d.status})`);
  const { host, repo, run } = d.ref;
  await gh([
    "api",
    "--hostname",
    host,
    "-X",
    "POST",
    `repos/${repo}/actions/runs/${run}/pending_deployments`,
    ...d.ref.environments.flatMap((e) => ["-F", `environment_ids[]=${e.id}`]),
    "-f",
    `state=${decision}`,
    "-f",
    `comment=${decision === "approved" ? "Approved" : "Rejected"} in Parawatch`,
  ]);
  appendEvent(() => ({ type: "deploy.change", deploy: d.ref, change: decision, source: "github" }));
  return d;
}

/** Decisions sent to this machine and not carried out yet. */
export function asksFor(state: State, me = deviceName()): DeployState[] {
  return [...state.deploys.values()].filter((d) => d.status === "waiting" && d.ask && d.ask.to === me);
}
