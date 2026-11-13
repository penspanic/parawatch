import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The command line as an agent and the human use it: the real program in a child process, against
 * a fresh state folder, run from a folder outside any repository.
 */
const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "src", "bin", "cli.ts");
const loader = pathToFileURL(path.join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href;

let home = "";
let cwd = "";

function pw(args: string[], opts: { session?: string; input?: string } = {}): { out: string; err: string; code: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PARAWATCH_HOME: home,
    PARAWATCH_NOTIFY: "0",
    PARAWATCH_GITHUB: "0",
    PARAWATCH_SHARED: "",
    PARAWATCH_CLAUDE_DESKTOP_DIR: path.join(home, "claude-desktop"),
    PARAWATCH_CLAUDE_DIR: path.join(home, "claude"),
    PARAWATCH_CODEX_DIR: path.join(home, "codex"),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (opts.session) env.CLAUDE_CODE_SESSION_ID = opts.session;
  const r = spawnSync(process.execPath, ["--import", loader, cli, ...args], { cwd, env, input: opts.input ?? "", encoding: "utf8", timeout: 30_000 });
  return { out: r.stdout, err: r.stderr, code: r.status ?? -1 };
}

/** Run and expect success; returns stdout. */
function ok(args: string[], opts: { session?: string; input?: string } = {}): string {
  const r = pw(args, opts);
  expect(r.err, `parawatch ${args.join(" ")}`).toBe("");
  expect(r.code, `parawatch ${args.join(" ")}`).toBe(0);
  return r.out;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-cli-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-cwd-"));
});

describe("cli: a card from question to close", () => {
  it("asks, shows, takes an answer once, and closes", () => {
    expect(ok(["ask", "-p", "demo", "Ship it?", "-o", "yes", "-o", "no", "-r", "1", "-b", "Users see it today."]).trim()).toBe("c1");
    expect(ok(["cards", "-p", "demo"])).toMatch(/c1\s+decide\s+demo\s+Ship it\?/);
    const shown = ok(["show", "c1"]);
    expect(shown).toContain("Users see it today.");
    expect(shown).toContain("1. yes  (recommended)");
    expect(shown).toContain("no session gets an answer");

    const bad = pw(["answer", "c1", "--choice", "9"]);
    expect(bad).toMatchObject({ code: 1, err: "parawatch: --choice must be between 1 and 2\n" });
    ok(["answer", "c1", "--choice", "1", "--comment", "go"]);

    const line = '[demo] c1 "Ship it?" chose 1 (yes); said: go\n';
    expect(ok(["inbox", "--peek"])).toBe(line);
    expect(ok(["inbox"])).toBe(line);
    expect(ok(["inbox"])).toBe("");

    ok(["close", "c1", "-n", "shipped"]);
    expect(ok(["cards", "-p", "demo"])).not.toContain("c1");
    expect(ok(["cards", "-p", "demo", "-a"])).toContain("c1");
  });

  it("says what is wrong and exits 1 on a card that does not exist", () => {
    expect(pw(["show", "c99"])).toMatchObject({ code: 1, err: 'parawatch: no card "c99"\n' });
    expect(pw(["answer", "c99", "--choice", "1"]).code).toBe(1);
  });

  it("an answer needs something in it", () => {
    ok(["ask", "-p", "demo", "Which?"]);
    expect(pw(["answer", "c1"])).toMatchObject({ code: 1, err: expect.stringContaining("needs --choice, --comment or --attach") });
  });

  it("a wait with a timeout and nothing to read exits 2", () => {
    expect(pw(["wait", "--timeout", "1"]).code).toBe(2);
  });

  it("a waiting wait wakes for an answer given meanwhile", () => {
    ok(["ask", "-p", "demo", "Go?", "-o", "go"]);
    ok(["answer", "c1", "--choice", "1"]);
    expect(ok(["wait", "--timeout", "5"])).toContain('c1 "Go?" chose 1 (go)');
  });

  it("dismiss closes a card and tells its asker once", () => {
    ok(["ask", "-p", "demo", "Still needed?"]);
    ok(["dismiss", "c1"]);
    expect(ok(["inbox"])).toContain("dismissed by the human");
    expect(ok(["inbox"])).toBe("");
  });
});

describe("cli: sessions, leads and hand-overs", () => {
  const worker = "aaaa1111-0001";
  const lead = "bbbb2222-0002";

  it("a session reads only its own answers; the human's status splits what no session gets", () => {
    expect(ok(["claim", "-p", "demo", "-t", "T1", "--title", "Worker"], { session: worker })).toContain("demo / T1");
    ok(["ask", "-p", "demo", "Mine?", "-o", "a"], { session: worker });
    ok(["ask", "-p", "demo", "Loose?", "-o", "a"]);
    ok(["answer", "c1", "--choice", "1"]);
    ok(["answer", "c2", "--choice", "1"]);

    expect(ok(["inbox", "--peek"], { session: worker })).toBe('[demo] c1 "Mine?" chose 1 (a)\n');
    const status = ok(["status"]);
    expect(status).toContain("NO SESSION GETS THESE  1");
    expect(status).toMatch(/c2\s+decide\s+demo\s+Loose\?/);
    expect(status).toContain("pick a lead: parawatch lead demo <session>");
    expect(status).toContain("ANSWERED, WAITING FOR THE AGENT  1");
  });

  it("lead picks a lead and hands it what no session got, told once", () => {
    ok(["ask", "-p", "demo", "Loose?", "-o", "a"]);
    ok(["answer", "c1", "--choice", "1"]);
    ok(["claim", "-p", "demo", "--title", "Director"], { session: lead });
    expect(ok(["lead", "demo", lead])).toBe(`${lead.slice(0, 8)} leads demo; handed c1\n`);
    expect(ok(["inbox"], { session: lead })).toContain('c1 "Loose?" handed to you by the human; the answer: chose 1 (a)');
    expect(ok(["inbox"], { session: lead })).toBe("");
    expect(ok(["status"])).not.toContain("NO SESSION GETS THESE");
  });

  it("claim --role lead does the same", () => {
    ok(["ask", "-p", "demo", "Loose?", "-o", "a"]);
    ok(["answer", "c1", "--choice", "1"]);
    expect(ok(["claim", "-p", "demo", "--role", "lead", "--title", "Director"], { session: lead })).toContain("handed c1");
  });

  it("hand gives a card, or a pull request named by owner/repo#n or URL, to another session", () => {
    ok(["claim", "-p", "demo", "--title", "Worker"], { session: worker });
    ok(["ask", "-p", "demo", "Mine?", "-o", "a"], { session: worker });
    expect(ok(["hand", "c1", lead])).toBe(`c1 → ${lead.slice(0, 8)}\n`);
    ok(["answer", "c1", "--choice", "1"]);
    expect(ok(["inbox"], { session: worker })).toBe("");
    expect(ok(["inbox"], { session: lead })).toContain("handed to you");

    ok(["pr", "link", "https://github.com/acme/app/pull/5", "-p", "demo"]);
    expect(ok(["hand", "acme/app#5", lead])).toBe(`acme/app#5 → ${lead.slice(0, 8)}\n`);
    expect(ok(["hand", "https://github.com/acme/app/pull/6", worker])).toBe(`acme/app#6 → ${worker.slice(0, 8)}\n`);
  });
});

describe("cli: pull requests and runs", () => {
  it("news recorded on a linked pull request wakes its session", () => {
    const s = "cccc3333-0003";
    ok(["claim", "-p", "demo", "--title", "Worker"], { session: s });
    expect(ok(["pr", "link", "acme/app#9"], { session: s })).toBe(`acme/app#9 → ${s.slice(0, 8)}\n`);
    ok(["pr", "event", "acme/app#9", "ci_failed", "-m", "lint"]);
    expect(ok(["inbox"], { session: s })).toContain("PR acme/app#9");
    expect(pw(["pr", "event", "acme/app#9", "exploded"])).toMatchObject({ code: 1, err: expect.stringContaining("change must be one of") });
  });

  it("a declared run starts, takes notes and ends", () => {
    const id = ok(["run", "start", "-p", "demo", "overnight bench", "--heartbeat", "600"]).trim();
    expect(id).not.toBe("");
    ok(["run", "note", id, "scene 3 of 8"]);
    expect(ok(["runs", "-p", "demo", "--wide"])).toContain("overnight bench");
    ok(["run", "end", id, "--failed", "-n", "editor stopped"]);
  });
});

describe("cli: projects and the hook", () => {
  it("adds and lists a project", () => {
    ok(["project", "add", "game", cwd]);
    expect(ok(["project", "list"])).toContain("game");
  });

  it("the Claude Code hook tells a session of its own news, and stays quiet otherwise", () => {
    const s = "dddd4444-0004";
    ok(["claim", "-p", "demo", "--title", "Worker"], { session: s });
    ok(["ask", "-p", "demo", "Mine?", "-o", "a"], { session: s });
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: s, cwd });
    expect(ok(["hook", "claude-code"], { input })).toBe("");
    ok(["answer", "c1", "--choice", "1"]);
    const out = JSON.parse(ok(["hook", "claude-code"], { input }));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("c1");
    expect(pw(["hook", "vim"])).toMatchObject({ code: 1 });
  });
});
