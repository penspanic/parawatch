#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Command } from "commander";
import {
  UserError,
  addProject,
  answerCard,
  beatRun,
  claimSession,
  closeCard,
  commentCard,
  inboxScope,
  editCard,
  endRun,
  linkPr,
  listeners,
  listenersFor,
  noteRun,
  openCard,
  prEvent,
  findCard,
  readInbox,
  readState,
  removeProject,
  startListening,
  startRun,
  unlinkPr,
  waitInbox,
  type CardInput,
} from "../core/ops.js";
import { githubConfig, readCache, resolvePrRef, syncGithub, prViews } from "../core/github.js";
import { digest, digestText, localDate } from "../core/digest.js";
import { everywhere, readEvents } from "../core/store.js";
import { followEvents } from "../core/follow.js";
import { adapterNames, setRoot, setupSync, syncAdapter, syncStatus, touchDevice } from "../core/sync.js";
import { syncText } from "../core/format.js";
import { collectRuns, shareRunsDue } from "../core/runs.js";
import { askRows, cardDetail, cardLine, cardRows, inboxLine, prRows, runsTree, view } from "../core/format.js";
import { hookContext, notify, removeInstructions, writeInstructions } from "../core/integrate.js";
import { installSkill, skillSource, skillTargets, uninstallSkill } from "../core/skill.js";
import { recordClient, runningDesktop, versionSkew } from "../core/clients.js";
import { doctor, doctorText } from "../core/doctor.js";
import { checkUpdate, updateLine } from "../core/update.js";
import { packageVersion } from "../core/version.js";
import { cardContextLine, resolveGoto } from "../core/desktop.js";
import { snapshot } from "../core/snapshot.js";
import { SCHEMA_VERSION, type Card } from "../core/types.js";

const collect = (v: string, prev: string[] = []) => [...prev, v];
const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UserError(`"${v}" is not a whole number`);
  return n;
};
const print = (x: unknown) => process.stdout.write(JSON.stringify(x) + "\n");

/** The agent session running this command, when its runtime says so. */
function currentSession(): string | undefined {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || undefined;
}

const VERSION = packageVersion();

/** Where this command line is installed, for the note other copies read. */
function binPath(): string | undefined {
  try {
    return fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return process.argv[1];
  }
}

recordClient({ name: "cli", version: VERSION, path: binPath() });
touchDevice(VERSION);

const program = new Command();
program
  .name("parawatch")
  .description("See what your agents are doing, what needs you, and wake the right agent when you answer.")
  .version(VERSION);

/** Read GitHub when the last reading is old; never fails the command. */
async function refreshGithub(force = false): Promise<void> {
  try {
    await syncGithub({ state: readState(), force });
  } catch (err) {
    if (force) throw err;
  }
}

// ------------------------------------------------------------------ cards

function cardCommand(kind: Card["kind"], name: string, summary: string) {
  return program
    .command(`${name} <title>`)
    .description(summary)
    .requiredOption("-p, --project <name>", "project this card belongs to")
    .option("-t, --task <task>", "task within the project")
    .option("-b, --body <text>", "two or three lines of context")
    .option("--attach <file>", "image, video or file to look at (repeatable)", collect)
    .option("--from <who>", "who is asking (defaults to the calling session's claimed title)")
    .option("--session <id>", "the agent session asking (defaults to the calling session)")
    .option("--since <date>", "when the matter first came up, if earlier (YYYY-MM-DD)")
    .option("--json", "print the card as JSON");
}

/** Options every card kind shares. */
function common(o: Record<string, string | string[] | undefined>) {
  return {
    project: o.project as string,
    task: o.task as string | undefined,
    body: o.body as string | undefined,
    attach: o.attach as string[] | undefined,
    from: o.from as string | undefined,
    session: (o.session as string | undefined) ?? currentSession(),
    since: o.since as string | undefined,
  };
}

function finishCard(input: CardInput, json?: boolean) {
  const card = openCard(input);
  notify(card);
  if (json) print(card);
  else process.stdout.write(`${card.id}\n`);
}

cardCommand("decide", "ask", "ask the human to decide, or to approve a prepared action")
  .option("-o, --option <text>", "a choice (repeatable)", collect)
  .option("-r, --recommend <n>", "the recommended choice, 1-based", int)
  .option("--action <text>", "the exact command or step that runs on yes (options default to Do it / Don't)")
  .option("--preview <file>", "a file with the text the action sends or changes (a message, a diff)")
  .action((title: string, o) =>
    finishCard({ kind: "decide", title, ...common(o), options: o.option, recommend: o.recommend, action: o.action, preview: o.preview }, o.json),
  );

cardCommand("try", "try", "ask the human to try a build, watch a video or look at a screen")
  .option("--open <path>", "app, file or URL to open (repeatable)", collect)
  .option("-l, --look <text>", "what to look at")
  .action((title: string, o) => finishCard({ kind: "try", title, ...common(o), open: o.open, look: o.look }, o.json));

cardCommand("block", "block", "something only the human can do, and you are stuck until they do it")
  .action((title: string, o) => finishCard({ kind: "block", title, ...common(o) }, o.json));

cardCommand("todo", "todo", "something only the human can do, but nothing waits on it now")
  .action((title: string, o) => finishCard({ kind: "todo", title, ...common(o) }, o.json));

program
  .command("edit <card>")
  .description("change a card: its kind, wording, task, who asked or when it came up (an empty value clears)")
  .option("-k, --kind <kind>", "decide, try, block or todo")
  .option("--title <text>", "new title")
  .option("-b, --body <text>", "new body")
  .option("-t, --task <task>", "task within the project")
  .option("--from <who>", "who asked")
  .option("--session <id>", "the agent session that asked")
  .option("--since <date>", "when the matter first came up (YYYY-MM-DD)")
  .option("--json", "print the card as JSON")
  .action((id: string, o) => {
    const card = editCard(id, { kind: o.kind, title: o.title, body: o.body, task: o.task, from: o.from, session: o.session, since: o.since });
    if (o.json) print(card);
    else process.stdout.write(cardLine(card) + "\n");
  });

program
  .command("goto <target>")
  .description("open the agent session behind a card, a pull request (URL, owner/repo#N, repo#N) or a session id in the Claude desktop app")
  .option("--copy", "also put a line about the card on the clipboard, to paste into that session")
  .option("--print", "print the link instead of opening it")
  .action((target: string, o) => {
    const g = resolveGoto(target, readState());
    if (o.copy && g.card) {
      const line = cardContextLine(g.card);
      try {
        execFileSync("pbcopy", { input: line });
      } catch {
        process.stderr.write(`parawatch: could not copy to the clipboard; the line is: ${line}\n`);
      }
    }
    if (!g.url) throw new UserError(`${g.name} is not a Claude desktop session. In a terminal: claude --resume ${g.session}`);
    if (o.print) {
      process.stdout.write(g.url + "\n");
      return;
    }
    execFileSync("open", [g.url]);
    process.stdout.write(`Opened ${g.name}${g.desktop?.archived ? " (archived)" : ""}\n`);
  });

program
  .command("answer <card>")
  .description("answer a card (this is what wakes the waiting agent)")
  .option("-c, --choice <n>", "chosen option, 1-based", int)
  .option("-m, --comment <text>", "free text")
  .option("--attach <file>", "a screenshot or file (repeatable)", collect)
  .option("--by <who>", "who answers", "human")
  .action((id: string, o) => answerCard(id, { choice: o.choice, comment: o.comment, attach: o.attach, by: o.by }));

program
  .command("comment <card> <text>")
  .description("add a comment to a card")
  .option("--by <who>", "who comments (use 'human' to wake the agent)", "agent")
  .action((id: string, text: string, o) => commentCard(id, text, o.by));

program
  .command("close <card>")
  .description("close a card once it has been acted on")
  .option("-n, --note <text>", "what was done")
  .action((id: string, o) => closeCard(id, o.note));

program
  .command("show <card>")
  .description("show one card with its answers")
  .option("--json", "JSON output")
  .action((id: string, o) => {
    const card = findCard(readState(), id);
    if (!card) throw new UserError(`no card "${id}"`);
    if (o.json) {
      print(card);
      return;
    }
    const waits = card.status === "closed" ? [] : listenersFor(card, listeners());
    const delivery =
      card.status === "closed"
        ? ""
        : waits.length
          ? `\nDelivery: an agent is waiting (${waits.map((l) => l.consumer).join(", ")}); an answer wakes it now.`
          : "\nDelivery: no agent is waiting; an answer is kept until the agent next checks (its next turn, or its next wait).";
    process.stdout.write(cardDetail(card) + delivery + "\n");
  });

program
  .command("cards")
  .description("list cards (open and answered by default)")
  .option("-p, --project <name>", "only this project")
  .option("-a, --all", "include closed cards")
  .option("--json", "JSON output")
  .action((o) => {
    const cards = [...readState().cards.values()].filter((c) => (o.all || c.status !== "closed") && (!o.project || c.project === o.project));
    if (o.json) print({ v: SCHEMA_VERSION, cards });
    else process.stdout.write(cards.length ? cardRows(cards, view()).join("\n") + "\n" : "No cards.\n");
  });

// ------------------------------------------------------------------ inbox

function inboxOptions(c: Command) {
  return c
    .option("-p, --project <name>", "everything in this project, whoever owns it (for a lead)")
    .option("--card <id>", "only answers to this card")
    .option("--as <consumer>", "cursor name (defaults to the session, or the project with -p)")
    .option("--json", "JSON output");
}

inboxOptions(
  program
    .command("wait")
    .description("block until the human answers or a linked pull request has news, print it and exit. In an agent session it reads that session's own cards and pull requests"),
)
  .option("--timeout <seconds>", "give up after this long (exit code 2); 0 waits forever", int, 0)
  .action(async (o) => {
    const session = currentSession();
    const { consumer, filter } = inboxScope(o, session);
    startListening({ consumer, project: filter.project, card: filter.card, session, ...(filter.session ? { scope: "session" as const } : {}) });
    // while waiting, keep GitHub fresh so news on linked pull requests wakes this wait, and tell
    // the other machines what runs here
    const tick = () => {
      void refreshGithub();
      if (shareRunsDue()) collectRuns(readState(), { sinceHours: 6 });
    };
    tick();
    const timer = setInterval(tick, 60_000);
    timer.unref();
    const items = await waitInbox(consumer, filter, o.timeout * 1000);
    clearInterval(timer);
    if (!items.length) {
      process.exitCode = 2;
      return;
    }
    if (o.json) print({ v: SCHEMA_VERSION, items });
    else process.stdout.write(items.map(inboxLine).join("\n") + "\n");
  });

inboxOptions(program.command("inbox").description("print unhandled answers without waiting"))
  .option("--peek", "do not mark them as seen")
  .action((o) => {
    const { consumer, filter } = inboxScope(o, currentSession());
    const items = readInbox(consumer, filter, !o.peek);
    if (o.json) print({ v: SCHEMA_VERSION, items });
    else if (items.length) process.stdout.write(items.map(inboxLine).join("\n") + "\n");
  });

program
  .command("watch")
  .description("stream every new event as one JSON line (for plugins and monitors)")
  .option("--from <seq>", "replay events after this sequence number first (in every machine's log)", int)
  .action(async (o) => {
    followEvents(print, o.from === undefined ? undefined : everywhere(o.from, readEvents()));
    await new Promise(() => {});
  });

// ------------------------------------------------------------------ runs

program
  .command("runs")
  .description("agents seen in their logs, grouped by project")
  .option("-p, --project <name>", "only this project")
  .option("--since <hours>", "look at logs touched in the last N hours", int, 6)
  .option("-a, --all", "include runs that ended a while ago")
  .option("--runtime <name>", "only this adapter (repeatable)", collect)
  .option("--every", "list each run of a scheduled task instead of one row per task")
  .option("-w, --wide", "show runtime and ids")
  .option("--json", "JSON output")
  .action((o) => {
    const runs = collectRuns(readState(), { sinceHours: o.since, project: o.project, includeEnded: o.all, runtimes: o.runtime, keepRepeats: o.every });
    if (o.json) print({ v: SCHEMA_VERSION, runs });
    else process.stdout.write((runs.length ? runsTree(runs, view({ wide: o.wide, all: o.all })) : "Nothing running.") + "\n");
  });

const run = program.command("run").description("report a job that leaves no agent log");
run
  .command("start <title>")
  .requiredOption("-p, --project <name>", "project")
  .option("-t, --task <task>", "task")
  .option("--parent <id>", "the run that started this one (defaults to the calling session)")
  .option("--heartbeat <seconds>", "count the run as stalled after this long without a beat, a note or log output", int)
  .option("--log <file>", "a log file the job writes; each change counts as a beat")
  .action((title: string, o) => {
    process.stdout.write(startRun({ title, project: o.project, task: o.task, parent: o.parent ?? currentSession(), heartbeat: o.heartbeat, log: o.log }) + "\n");
  });
run.command("note <id> <text>").description("say how it is going (also counts as a beat)").action((id: string, text: string) => noteRun(id, text));
run.command("beat <id>").description("say it is still alive").action((id: string) => beatRun(id));
run
  .command("end <id>")
  .option("--failed", "it failed")
  .option("-n, --note <text>", "how it ended")
  .action((id: string, o) => endRun(id, o.failed ? "failed" : "done", o.note));

program
  .command("claim [session]")
  .description("say which project and task an agent session works on (id prefix, 6+ characters; defaults to the calling session)")
  .option("-p, --project <name>", "project (may be left out once the session has claimed one)")
  .option("-t, --task <task>", "task: a ticket key, a PR, a short name")
  .option("--role <role>", "for example lead or worker")
  .option("--title <title>", "name to show")
  .option("--kind <kind>", "'scheduled' for a session a schedule starts again and again")
  .option("--done <summary>", "the work is finished; one line on how it ended")
  .action((session: string | undefined, o) => {
    const id = session ?? currentSession();
    if (!id) throw new UserError("no session id given and none found in the environment (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID)");
    if (o.kind !== undefined && o.kind !== "scheduled") throw new UserError("--kind can only be 'scheduled'");
    const c = claimSession({ session: id, project: o.project, task: o.task, role: o.role, title: o.title, kind: o.kind, done: o.done });
    process.stdout.write(`${id.slice(0, 8)} → ${c.project}${c.task ? ` / ${c.task}` : ""}${c.role ? ` (${c.role})` : ""}${c.done ? " · done" : ""}\n`);
  });

// ------------------------------------------------------------------ pull requests

const pr = program.command("pr").description("pull requests and what they wait on (reads GitHub through gh)");
pr.command("link <pr>")
  .description("say this pull request belongs to the calling session: news on it wakes the session's wait")
  .option("-p, --project <name>", "project (defaults to the session's claim)")
  .option("-t, --task <task>", "task (defaults to the session's claim)")
  .option("--session <id>", "the owning session (defaults to the calling session)")
  .action((ref: string, o) => {
    const r = resolvePrRef(ref);
    const session = o.session ?? currentSession();
    linkPr({ pr: r, session, project: o.project, task: o.task });
    process.stdout.write(`${r.repo}#${r.number} → ${session ? session.slice(0, 8) : o.project ?? "no session"}\n`);
  });
pr.command("unlink <pr>")
  .description("forget which session owns a pull request")
  .action((ref: string) => unlinkPr(resolvePrRef(ref).key));
pr.command("list")
  .description("open pull requests you wrote or are asked to review, with what each waits on")
  .option("-p, --project <name>", "only this project")
  .option("--offline", "do not read GitHub, show the last reading")
  .option("--json", "JSON output")
  .action(async (o) => {
    if (!o.offline) await refreshGithub();
    const state = readState();
    const runs = collectRuns(state, { sinceHours: 72 });
    let prs = prViews(readCache(), state, runs);
    if (o.project) prs = prs.filter((p) => p.project === o.project);
    if (o.json) print({ v: SCHEMA_VERSION, prs });
    else process.stdout.write(prs.length ? prRows(prs, view()).join("\n") + "\n" : githubNote() ?? "No open pull requests.\n");
  });
pr.command("sync")
  .description("read GitHub now")
  .action(async () => {
    const c = await syncGithub({ state: readState(), force: true });
    if (c.error) process.stderr.write(`parawatch: ${c.error}\n`);
    process.stdout.write(`${c.prs.filter((p) => p.state === "open").length} open pull requests on ${(c.hosts ?? []).join(", ") || "no host"}\n`);
  });
pr.command("event <pr> <change>")
  .description("record news another tool saw on a pull request (a merge bot, a ticket system); it wakes the owner like GitHub's own")
  .option("-m, --text <text>", "what happened")
  .option("--by <who>", "who did it")
  .action((ref: string, change: string, o) => prEvent(resolvePrRef(ref), change, { text: o.text, by: o.by }));

function githubNote(): string | undefined {
  if (!githubConfig().enabled) return "GitHub is turned off in config.json.\n";
  const c = readCache();
  if (c.hosts && !c.hosts.length) return "GitHub: gh is not installed or not signed in (gh auth login).\n";
  return undefined;
}

program
  .command("digest")
  .description("what each session did on a day: work claimed, cards, jobs, pull request news, how it ended")
  .option("-d, --date <YYYY-MM-DD>", "the day (default: today)")
  .option("--json", "JSON output")
  .action((o) => {
    const d = digest(o.date ?? localDate());
    if (o.json) print({ v: SCHEMA_VERSION, ...d });
    else process.stdout.write(digestText(d) + "\n");
  });

// ------------------------------------------------------------------ status

program
  .command("status")
  .description("everything at a glance: what needs you, what waits on others, then what is running")
  .option("-p, --project <name>", "only this project")
  .option("--since <hours>", "look at logs touched in the last N hours", int, 6)
  .option("--offline", "do not read GitHub, show the last reading")
  .option("-w, --wide", "show runtime and ids")
  .option("--json", "JSON output")
  .action(async (o) => {
    // the update check runs beside the GitHub reading, and only for a person at a terminal
    const asking = !o.offline && !o.json && process.stdout.isTTY ? checkUpdate(VERSION).catch(() => undefined) : undefined;
    if (!o.offline) await refreshGithub();
    const snap = snapshot({ sinceHours: o.since, project: o.project });
    if (o.json) {
      print(snap);
      return;
    }
    const { cards, runs } = snap;
    const prs = snap.prs ?? [];
    const v = view({ wide: o.wide });
    const now = Date.now();
    const head = (title: string, n: number | string, ...extra: string[]) =>
      v.color ? `\x1b[1m${title}\x1b[0m  \x1b[2m${n}${extra.join("")}\x1b[0m` : `${title}  ${n}${extra.join("")}`;
    const open = cards.filter((c) => c.status === "open" && c.kind !== "todo");
    const todo = cards.filter((c) => c.status === "open" && c.kind === "todo");
    const answered = cards.filter((c) => c.status === "answered");
    const askers = runs.filter((r) => r.asks);
    const reviews = prs.filter((p) => p.reviewRequested && !p.mine);
    const waiting = prs.filter((p) => !(p.reviewRequested && !p.mine));
    const ls = snap.listeners ?? [];
    const out: string[] = [];
    out.push(head("NEEDS YOU", open.length || "nothing"));
    out.push(...cardRows(open, v, now, "  "));
    if (askers.length) {
      out.push("", head("ASKED IN CHAT, NO CARD", askers.length, "  (read from the log)"));
      out.push(...askRows(askers, v, now, "  "));
    }
    if (reviews.length) {
      out.push("", head("REVIEWS ASKED OF YOU", reviews.length));
      out.push(...prRows(reviews, v, now, "  "));
    }
    if (todo.length) {
      out.push("", head("TO DO, NOTHING WAITS ON IT", todo.length));
      out.push(...cardRows(todo, v, now, "  "));
    }
    if (answered.length) {
      const notes: Record<string, string> = {};
      for (const c of answered) if (!listenersFor(c, ls).length) notes[c.id] = "no agent waiting";
      out.push("", head("ANSWERED, WAITING FOR THE AGENT", answered.length));
      out.push(...cardRows(answered, v, now, "  ", notes));
    }
    if (waiting.length) {
      const stuck = waiting.filter((p) => p.stalled).length;
      out.push("", head("WAITING ON OTHERS", waiting.length, stuck ? ` · ${stuck} stuck` : ""));
      out.push(...prRows(waiting, v, now, "  "));
    }
    const working = runs.filter((r) => r.state === "working" || r.state === "waiting").length;
    out.push("", head("AGENTS", runs.length ? `${working} working` : "nothing running"));
    if (runs.length) out.push(runsTree(runs, v));
    const dim = (t: string) => (v.color ? `\x1b[2m${t}\x1b[0m` : t);
    const notes: string[] = [];
    if (snap.github?.error && snap.github.enabled) notes.push(`GitHub: ${snap.github.error}`);
    const skew = versionSkew(VERSION, runningDesktop()?.version);
    if (skew) notes.push(skew.text);
    const update = updateLine(await asking);
    if (update) notes.push(update);
    if (notes.length) out.push("", ...notes.map(dim));
    process.stdout.write(out.join("\n") + "\n");
  });

// ------------------------------------------------------------------ skill

const skill = program.command("skill").description("the agent skill that teaches agents to use parawatch");
skill
  .command("path")
  .description("print where the skill lives")
  .action(() => {
    process.stdout.write(skillSource() + "\n");
  });
skill
  .command("install")
  .description("link the skill into Claude Code (~/.claude/skills) and Codex (~/.codex/skills)")
  .option("--runtime <name>", "only this runtime: claude-code or codex (repeatable)", collect)
  .option("--force", "replace a folder that is already there")
  .action((o) => {
    for (const r of installSkill(skillTargets(), { only: o.runtime, force: o.force })) {
      process.stdout.write(`${r.runtime.padEnd(12)} ${r.result.padEnd(15)} ${r.path}${r.note ? `  (${r.note})` : ""}\n`);
    }
  });

skill
  .command("uninstall")
  .description("remove the skill links that install made")
  .option("--runtime <name>", "only this runtime: claude-code or codex (repeatable)", collect)
  .action((o) => {
    for (const r of uninstallSkill(skillTargets(), { only: o.runtime })) {
      process.stdout.write(`${r.runtime.padEnd(12)} ${r.result.padEnd(14)} ${r.path}${r.note ? `  (${r.note})` : ""}\n`);
    }
  });

// ------------------------------------------------------------------ setup

const project = program.command("project").description("projects you work on");
project
  .command("add <name> [paths...]")
  .description("register a project and the checkouts or folders it lives in")
  .action((name: string, paths: string[]) => addProject(name, paths.length ? paths : [process.cwd()]));
project.command("remove <name>").action((name: string) => removeProject(name));
project
  .command("list")
  .option("--json", "JSON output")
  .action((o) => {
    const ps = [...readState().projects.values()];
    if (o.json) print({ v: SCHEMA_VERSION, projects: ps });
    else process.stdout.write(ps.map((p) => `${p.name}  ${p.paths.join(", ")}`).join("\n") + (ps.length ? "\n" : "No projects.\n"));
  });

program
  .command("init")
  .description("add parawatch instructions for agents to an instruction file")
  .option("-f, --file <path>", "file to write", "AGENTS.md")
  .option("-p, --project <name>", "project name to put in the examples")
  .option("--remove", "take the parawatch block out of the file instead")
  .action((o) => {
    if (o.remove) {
      process.stdout.write(removeInstructions(o.file) ? `Removed the parawatch block from ${o.file}\n` : `${o.file} has no parawatch block\n`);
      return;
    }
    const changed = writeInstructions(o.file, o.project);
    process.stdout.write(changed ? `Updated ${o.file}\n` : `${o.file} already up to date\n`);
  });

program
  .command("doctor")
  .description("how parawatch is set up here: versions, store, desktop app, skill, GitHub; paste it into bug reports")
  .option("--offline", "do not ask the npm registry for the latest version")
  .option("--json", "JSON output")
  .action(async (o) => {
    const update = o.offline ? undefined : await checkUpdate(VERSION, { force: true }).catch(() => undefined);
    const checks = await doctor({ version: VERSION, bin: binPath(), update });
    if (o.json) print({ v: SCHEMA_VERSION, version: VERSION, platform: `${process.platform}-${process.arch}`, checks });
    else process.stdout.write(`${doctorText(checks, view({}).color)}\n`);
  });

// ------------------------------------------------------------------ sharing between machines

const sync = program.command("sync").description("share cards and answers with your other machines through a synced folder");

sync
  .command("status", { isDefault: true })
  .description("how sharing is doing: this machine, the others, the sync tool")
  .option("--json", "JSON output")
  .action(async (o) => {
    const st = await syncStatus();
    if (o.json) print({ v: SCHEMA_VERSION, sync: st ?? null });
    else process.stdout.write(syncText(st, view({}).color) + "\n");
  });

sync
  .command("setup <folder>")
  .description("start writing to a shared folder; this machine's log moves there, nothing is lost")
  .option("-d, --device <name>", "this machine's name in the folder (a-z, 0-9, -); defaults to the host name")
  .option("-a, --adapter <name>", `the tool that carries the folder: ${adapterNames().join(", ")}`)
  .action((folder: string, o) => {
    const r = setupSync({ dir: folder, device: o.device, adapter: o.adapter, version: VERSION });
    const lines = [
      `This machine writes to ${r.dir} as "${r.device}" (adapter: ${r.adapter}, ${syncAdapter(r.adapter).about}).`,
      r.moved ? `Moved ${r.moved} events from this machine's log; the old file is kept at ${r.backup}.` : "",
      r.others.length ? `Other machines already here: ${r.others.join(", ")}.` : "No other machine has written here yet. Run the same command on the next one with its own --device.",
      "Older parawatch copies (before 0.3) on this machine stop writing until they are updated.",
    ];
    process.stdout.write(lines.filter(Boolean).join("\n") + "\n");
  });

sync
  .command("root <name> [folder]")
  .description("name a folder on this machine (a cloud drive, say) so paths under it open on the others; no folder removes it")
  .action((name: string, folder: string | undefined) => {
    const d = setRoot(name, folder, VERSION);
    process.stdout.write(Object.entries(d.roots ?? {}).map(([k, v]) => `${k}  ${v}`).join("\n") + (d.roots ? "\n" : "No named folders.\n"));
  });

program
  .command("hook <runtime>")
  .description("hook entry point; 'claude-code' reads the hook JSON on stdin")
  .option("-p, --project <name>", "project, when it cannot be told from the session")
  .action((runtime: string, o) => {
    if (runtime !== "claude-code") throw new UserError(`no hook for "${runtime}"`);
    let input: { session_id?: string; cwd?: string; hook_event_name?: string } = {};
    try {
      input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    } catch {
      input = {};
    }
    const text = hookContext(input, o.project);
    if (!text) return;
    if (input.hook_event_name) print({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } });
    else process.stdout.write(text + "\n");
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof UserError) {
    process.stderr.write(`parawatch: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
