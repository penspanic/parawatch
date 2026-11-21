// Deployments waiting for the human: read from GitHub, decided here or from the phone, followed to the end.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { askDeploy, asksFor, decideDeploy, deployViews, dropSeenDeploys, readDeploys } from "../src/core/deploys.js";
import { newsViews } from "../src/core/github.js";
import { addProject, readState } from "../src/core/ops.js";
import { appendEvent, appendLocked, withLock } from "../src/core/store.js";
import type { EventBody, PwEvent } from "../src/core/types.js";
import { freshHome } from "./helpers.js";

const RUN = 4450;
const KEY = `github.com/kim/game/actions/runs/${RUN}`;

/** A GitHub with one repository whose `production` needs a reviewer; `calls` records what was asked. */
function fakeGithub() {
  const calls: string[] = [];
  const world = {
    waiting: true,
    canApprove: true,
    approvals: [] as unknown[],
    run: { status: "waiting", conclusion: null as string | null },
  };
  const gh = async (args: string[]) => {
    const p = args.find((a) => a.startsWith("repos/")) ?? "";
    calls.push([args.includes("POST") ? "POST" : "GET", p, ...args.filter((a) => a.startsWith("environment_ids") || a.startsWith("state="))].join(" "));
    if (p.endsWith("/environments"))
      return JSON.stringify({ environments: [{ name: "plan", protection_rules: [{ type: "branch_policy" }] }, { name: "production", protection_rules: [{ type: "required_reviewers" }] }] });
    if (p.includes("runs?status=waiting"))
      return JSON.stringify({
        workflow_runs: world.waiting
          ? [{ id: RUN, name: "Deploy", display_title: "Release 0.3.29", html_url: `https://github.com/kim/game/actions/runs/${RUN}`, repository: { full_name: "kim/game" }, triggering_actor: { login: "me" } }]
          : [],
      });
    if (p.endsWith("/pending_deployments") && !args.includes("POST"))
      return JSON.stringify([{ environment: { id: 77, name: "production" }, current_user_can_approve: world.canApprove }]);
    if (p.endsWith("/pending_deployments")) return "[]";
    if (p.endsWith("/approvals")) return JSON.stringify(world.approvals);
    if (p.endsWith(`/runs/${RUN}`)) return JSON.stringify(world.run);
    throw new Error(`unexpected ${p}`);
  };
  return { gh, calls, world };
}

/** Record what a reading found, the way `syncGithub` does. */
async function sync(gh: (args: string[]) => Promise<string>) {
  const { events, errors } = await readDeploys(readState(), ["github.com"], gh);
  expect(errors).toEqual([]);
  withLock(() => appendLocked((log) => dropSeenDeploys(events, log)));
  return events;
}

beforeEach(() => {
  const home = freshHome();
  const repo = path.join(home, "game");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:kim/game.git\n');
  addProject("game", [repo]);
});

describe("deployments waiting for you", () => {
  it("finds a run waiting on an environment you can approve, once", async () => {
    const { gh, calls } = fakeGithub();
    const first = await sync(gh);
    expect(first.map((e) => e.type === "deploy.change" && e.change)).toEqual(["waiting"]);
    const views = deployViews(readState());
    expect(views).toEqual([
      expect.objectContaining({ key: KEY, repo: "kim/game", run: RUN, workflow: "Deploy", title: "Release 0.3.29", environments: ["production"], startedBy: "me", project: "game" }),
    ]);
    // the next reading finds it still waiting: nothing new, and the environments are not read again
    expect(await sync(gh)).toEqual([]);
    expect(calls.filter((c) => c.endsWith("/environments"))).toHaveLength(1);
  });

  it("leaves runs someone else has to approve", async () => {
    const { gh, world } = fakeGithub();
    world.canApprove = false;
    await sync(gh);
    expect(deployViews(readState())).toEqual([]);
  });

  it("approves with every environment it waits on, then follows the run to its end", async () => {
    const { gh, calls, world } = fakeGithub();
    await sync(gh);
    await decideDeploy(readState(), String(RUN), "approved", gh);
    expect(calls).toContain(`POST repos/kim/game/actions/runs/${RUN}/pending_deployments environment_ids[]=77 state=approved`);
    expect(deployViews(readState())).toEqual([]);

    // GitHub now shows who approved it; that is not news again
    world.waiting = false;
    world.approvals = [{ state: "approved", user: { login: "me" }, environments: [{ id: 77 }] }];
    world.run = { status: "in_progress", conclusion: null };
    expect(await sync(gh)).toEqual([]);
    world.run = { status: "completed", conclusion: "failure" };
    const ended = await sync(gh);
    expect(ended.map((e) => e.type === "deploy.change" && e.change)).toEqual(["failed"]);
    const news = newsViews(readState(), "2000-01-01T00:00:00Z");
    expect(news.map((n) => [n.kind, n.label, n.change])).toEqual([
      ["deploy", "game production", "failed"],
      ["deploy", "game production", "approved"],
    ]);
    expect(await sync(gh)).toEqual([]);
  });

  it("tells who approved it on GitHub, and how it went", async () => {
    const { gh, world } = fakeGithub();
    await sync(gh);
    world.waiting = false;
    world.approvals = [{ state: "approved", user: { login: "kim" }, environments: [{ id: 77 }] }];
    world.run = { status: "completed", conclusion: "success" };
    const got = await sync(gh);
    expect(got.map((e) => e.type === "deploy.change" && [e.change, e.by])).toEqual([
      ["approved", "kim"],
      ["succeeded", undefined],
    ]);
  });

  it("a decision on the phone goes to the machine that read it, which carries it out or says why not", async () => {
    const { gh } = fakeGithub();
    await sync(gh);
    const me = readState().deploys.get(KEY)!.dev!;
    appendEvent(() => askDeploy(readState(), KEY, "approved"));
    expect(deployViews(readState())[0]!.asking).toEqual(expect.objectContaining({ decision: "approved", to: me }));
    expect(asksFor(readState(), me).map((d) => d.ref.key)).toEqual([KEY]);
    expect(asksFor(readState(), "someone-else")).toEqual([]);
    appendEvent(() => ({ type: "deploy.fail", deploy: KEY, error: "HTTP 422" }));
    expect(deployViews(readState())[0]).toEqual(expect.objectContaining({ asking: undefined, error: "HTTP 422" }));
    expect(asksFor(readState(), me)).toEqual([]);
  });

  it("a deployment another machine logged is not logged again", () => {
    const body: EventBody = {
      type: "deploy.change",
      deploy: { key: KEY, host: "github.com", repo: "kim/game", run: RUN, url: "u", workflow: "Deploy", title: "t", environments: [{ id: 77, name: "production" }] },
      change: "waiting",
      source: "github",
    };
    const log = [{ ...body, v: 2, seq: 1, ts: "2026-11-21T00:00:00Z", dev: "pc" }] as PwEvent[];
    expect(dropSeenDeploys([body], log)).toEqual([]);
    expect(dropSeenDeploys([{ ...body, change: "approved" }], log)).toHaveLength(1);
  });
});
