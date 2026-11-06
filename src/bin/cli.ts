#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import {
  UserError,
  addProject,
  answerCard,
  claimSession,
  closeCard,
  commentCard,
  consumerName,
  endRun,
  noteRun,
  openCard,
  readInbox,
  removeProject,
  startRun,
  waitInbox,
  type CardInput,
} from "../core/ops.js";
import { eventsPath, homeDir, readEvents, parseEventLines } from "../core/store.js";
import { fold } from "../core/state.js";
import { collectRuns } from "../core/runs.js";
import { cardDetail, cardRows, inboxLine, runsTree, view } from "../core/format.js";
import { hookContext, notify, writeInstructions } from "../core/integrate.js";
import { installSkill, skillSource, skillTargets } from "../core/skill.js";
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

const program = new Command();
program
  .name("parawatch")
  .description("See what your agents are doing, what needs you, and wake the right agent when you answer.")
  .version("0.1.0");

// ------------------------------------------------------------------ cards

function cardCommand(kind: Card["kind"], name: string, summary: string) {
  return program
    .command(`${name} <title>`)
    .description(summary)
    .requiredOption("-p, --project <name>", "project this card belongs to")
    .option("-t, --task <task>", "task within the project")
    .option("-b, --body <text>", "two or three lines of context")
    .option("--attach <file>", "image, video or file to look at (repeatable)", collect)
    .option("--from <who>", "who is asking (agent or session name)")
    .option("--json", "print the card as JSON");
}

function finishCard(input: CardInput, json?: boolean) {
  const card = openCard(input);
  notify(card);
  if (json) print(card);
  else process.stdout.write(`${card.id}\n`);
}

cardCommand("decide", "ask", "ask the human to decide")
  .option("-o, --option <text>", "a choice (repeatable)", collect)
  .option("-r, --recommend <n>", "the recommended choice, 1-based", int)
  .action((title: string, o) => finishCard({ kind: "decide", title, project: o.project, task: o.task, body: o.body, options: o.option, recommend: o.recommend, attach: o.attach, from: o.from }, o.json));

cardCommand("try", "try", "ask the human to try a build, watch a video or look at a screen")
  .option("--open <path>", "app, file or URL to open (repeatable)", collect)
  .option("-l, --look <text>", "what to look at")
  .action((title: string, o) => finishCard({ kind: "try", title, project: o.project, task: o.task, body: o.body, attach: o.attach, open: o.open, look: o.look, from: o.from }, o.json));

cardCommand("block", "block", "tell the human about something only they can do")
  .action((title: string, o) => finishCard({ kind: "block", title, project: o.project, task: o.task, body: o.body, attach: o.attach, from: o.from }, o.json));

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
    const card = fold(readEvents()).cards.get(id);
    if (!card) throw new UserError(`no card "${id}"`);
    if (o.json) print(card);
    else process.stdout.write(cardDetail(card) + "\n");
  });

program
  .command("cards")
  .description("list cards (open and answered by default)")
  .option("-p, --project <name>", "only this project")
  .option("-a, --all", "include closed cards")
  .option("--json", "JSON output")
  .action((o) => {
    const cards = [...fold(readEvents()).cards.values()].filter((c) => (o.all || c.status !== "closed") && (!o.project || c.project === o.project));
    if (o.json) print({ v: SCHEMA_VERSION, cards });
    else process.stdout.write(cards.length ? cardRows(cards, view()).join("\n") + "\n" : "No cards.\n");
  });

// ------------------------------------------------------------------ inbox

function inboxOptions(c: Command) {
  return c
    .option("-p, --project <name>", "only answers for this project")
    .option("--card <id>", "only answers to this card")
    .option("--as <consumer>", "cursor name (defaults to the project)")
    .option("--json", "JSON output");
}

inboxOptions(program.command("wait").description("block until the human answers, print the answers and exit"))
  .option("--timeout <seconds>", "give up after this long (exit code 2); 0 waits forever", int, 0)
  .action(async (o) => {
    const items = await waitInbox(consumerName(o), { project: o.project, card: o.card }, o.timeout * 1000);
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
    const items = readInbox(consumerName(o), { project: o.project, card: o.card }, !o.peek);
    if (o.json) print({ v: SCHEMA_VERSION, items });
    else if (items.length) process.stdout.write(items.map(inboxLine).join("\n") + "\n");
  });

program
  .command("watch")
  .description("stream every new event as one JSON line (for plugins and monitors)")
  .option("--from <seq>", "replay events after this sequence number first", int)
  .action(async (o) => {
    const file = eventsPath();
    let offset = 0;
    let lastSeq = o.from ?? Infinity;
    try {
      const text = fs.readFileSync(file, "utf8");
      offset = Buffer.byteLength(text);
      const events = parseEventLines(text);
      if (o.from === undefined) lastSeq = events[events.length - 1]?.seq ?? 0;
      else for (const ev of events) if (ev.seq > o.from) print(ev);
      if (o.from !== undefined) lastSeq = Math.max(o.from, events[events.length - 1]?.seq ?? 0);
    } catch {
      lastSeq = o.from ?? 0;
    }
    const pump = () => {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0; // file replaced
      if (size === offset) return;
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const cut = text.lastIndexOf("\n");
      if (cut < 0) return;
      offset += Buffer.byteLength(text.slice(0, cut + 1));
      for (const ev of parseEventLines(text.slice(0, cut + 1))) {
        if (ev.seq > lastSeq) {
          print(ev);
          lastSeq = ev.seq;
        }
      }
    };
    fs.mkdirSync(homeDir(), { recursive: true });
    try {
      fs.watch(homeDir(), () => pump());
    } catch {
      // fall back to the timer alone
    }
    setInterval(pump, 1000);
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
  .option("-w, --wide", "show runtime and ids")
  .option("--json", "JSON output")
  .action((o) => {
    const runs = collectRuns(fold(readEvents()), { sinceHours: o.since, project: o.project, includeEnded: o.all, runtimes: o.runtime });
    if (o.json) print({ v: SCHEMA_VERSION, runs });
    else process.stdout.write((runs.length ? runsTree(runs, view({ wide: o.wide, all: o.all })) : "Nothing running.") + "\n");
  });

const run = program.command("run").description("report a job that leaves no agent log");
run
  .command("start <title>")
  .requiredOption("-p, --project <name>", "project")
  .option("-t, --task <task>", "task")
  .option("--parent <id>", "the run that started this one (defaults to the calling session)")
  .action((title: string, o) => {
    process.stdout.write(startRun({ title, project: o.project, task: o.task, parent: o.parent ?? currentSession() }) + "\n");
  });
run.command("note <id> <text>").action((id: string, text: string) => noteRun(id, text));
run
  .command("end <id>")
  .option("--failed", "it failed")
  .option("-n, --note <text>", "how it ended")
  .action((id: string, o) => endRun(id, o.failed ? "failed" : "done", o.note));

program
  .command("claim [session]")
  .description("say which project an agent session belongs to (id prefix, 6+ characters; defaults to the calling session)")
  .requiredOption("-p, --project <name>", "project")
  .option("-t, --task <task>", "task")
  .option("--role <role>", "for example lead or worker")
  .option("--title <title>", "name to show")
  .action((session: string | undefined, o) => {
    const id = session ?? currentSession();
    if (!id) throw new UserError("no session id given and none found in the environment (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID)");
    claimSession({ session: id, project: o.project, task: o.task, role: o.role, title: o.title });
    process.stdout.write(`${id.slice(0, 8)} → ${o.project}${o.role ? ` (${o.role})` : ""}\n`);
  });

// ------------------------------------------------------------------ status

program
  .command("status")
  .description("everything at a glance: what needs you, then what is running")
  .option("-p, --project <name>", "only this project")
  .option("--since <hours>", "look at logs touched in the last N hours", int, 6)
  .option("-w, --wide", "show runtime and ids")
  .option("--json", "JSON output")
  .action((o) => {
    const state = fold(readEvents());
    const cards = [...state.cards.values()].filter((c) => c.status !== "closed" && (!o.project || c.project === o.project));
    const runs = collectRuns(state, { sinceHours: o.since, project: o.project });
    if (o.json) {
      print({ v: SCHEMA_VERSION, generatedAt: new Date().toISOString(), projects: [...state.projects.values()], cards, runs });
      return;
    }
    const v = view({ wide: o.wide });
    const head = (title: string, n: number | string, ...extra: string[]) =>
      v.color ? `\x1b[1m${title}\x1b[0m  \x1b[2m${n}${extra.join("")}\x1b[0m` : `${title}  ${n}${extra.join("")}`;
    const open = cards.filter((c) => c.status === "open");
    const answered = cards.filter((c) => c.status === "answered");
    const out: string[] = [];
    out.push(head("NEEDS YOU", open.length || "nothing"));
    out.push(...cardRows(open, v, Date.now(), "  "));
    if (answered.length) {
      out.push("", head("ANSWERED, WAITING FOR THE AGENT", answered.length));
      out.push(...cardRows(answered, v, Date.now(), "  "));
    }
    const working = runs.filter((r) => r.state === "working" || r.state === "waiting").length;
    out.push("", head("AGENTS", runs.length ? `${working} working` : "nothing running"));
    if (runs.length) out.push(runsTree(runs, v));
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
    const ps = [...fold(readEvents()).projects.values()];
    if (o.json) print({ v: SCHEMA_VERSION, projects: ps });
    else process.stdout.write(ps.map((p) => `${p.name}  ${p.paths.join(", ")}`).join("\n") + (ps.length ? "\n" : "No projects.\n"));
  });

program
  .command("init")
  .description("add parawatch instructions for agents to an instruction file")
  .option("-f, --file <path>", "file to write", "AGENTS.md")
  .option("-p, --project <name>", "project name to put in the examples")
  .action((o) => {
    const changed = writeInstructions(o.file, o.project);
    process.stdout.write(changed ? `Updated ${o.file}\n` : `${o.file} already up to date\n`);
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
