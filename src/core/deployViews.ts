/** Deployments waiting for the human, as lists show them. No Node here: the phone uses it too. */
import { UserError } from "./errors.js";
import type { DeployState, State } from "./state.js";
import type { DeployRef, DeployView, EventBody } from "./types.js";

/** What to call a deployment in a list: the repository's name and the environments. */
export function deployLabel(d: Pick<DeployRef, "repo" | "environments">): string {
  return `${d.repo.split("/")[1]} ${d.environments.map((e) => e.name).join(", ")}`.trim();
}

/** Deployments waiting for the human, the longest waiting first. */
export function deployViews(state: State): DeployView[] {
  return [...state.deploys.values()]
    .filter((d) => d.status === "waiting")
    .sort((a, b) => a.since.localeCompare(b.since))
    .map((d) => ({
      key: d.ref.key,
      url: d.ref.url,
      repo: d.ref.repo,
      run: d.ref.run,
      workflow: d.ref.workflow,
      title: d.ref.title,
      environments: d.ref.environments.map((e) => e.name),
      startedBy: d.ref.startedBy,
      since: d.since,
      project: d.ref.project,
      device: d.dev,
      asking: d.ask,
      error: d.error,
    }));
}

/** A deployment by its key, its run id, or `owner/repo#<run id>`. */
export function findDeploy(state: State, ref: string): DeployState | undefined {
  const r = ref.trim().toLowerCase();
  const all = [...state.deploys.values()];
  return (
    state.deploys.get(r) ??
    all.find((d) => String(d.ref.run) === r || `${d.ref.repo}#${d.ref.run}`.toLowerCase() === r || d.ref.url.toLowerCase() === r)
  );
}

/**
 * Decide from somewhere without GitHub (the phone): ask the machine that read the deployment to
 * carry it out.
 */
export function askDeploy(state: State, ref: string, decision: "approved" | "rejected"): EventBody {
  const d = findDeploy(state, ref);
  if (!d) throw new UserError(`No deployment "${ref}" here`);
  if (d.status !== "waiting") throw new UserError(`It no longer waits (${d.status})`);
  if (!d.dev) throw new UserError("No machine reported this deployment, so none can approve it from here");
  return { type: "deploy.ask", deploy: d.ref.key, decision, to: d.dev };
}
