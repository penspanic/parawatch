#!/usr/bin/env node
// How agents on this machine learn and use parawatch, from their own logs (read only): how often
// they read the skill or the guide, which commands they run, how often they look at --help, which
// calls fail, and how they attach pictures. Run it before and after a change to the skill, the
// AGENTS.md block or the help, and compare.
//
//   node scripts/agent-usage.mjs [--days 10] [--json]
//
// Reads ~/.claude/projects/*/*.jsonl (Claude Code) and ~/.codex/sessions/**/*.jsonl (Codex), or
// PARAWATCH_CLAUDE_DIR and PARAWATCH_CODEX_DIR. Prints counts only, never log text, except the
// failing command lines (cut short) so a wrong flag can be found.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1]) || 10;
const json = args.includes("--json");
const since = Date.now() - days * 86_400_000;
const claudeDir = process.env.PARAWATCH_CLAUDE_DIR || path.join(os.homedir(), ".claude", "projects");
const codexDir = process.env.PARAWATCH_CODEX_DIR || path.join(os.homedir(), ".codex", "sessions");

function files(dir, depth) {
  const out = [];
  const walk = (d, n) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && n > 0 && e.name !== "subagents") walk(p, n - 1);
      else if (e.isFile() && e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since) out.push(p);
    }
  };
  walk(dir, depth);
  return out;
}

const COMMAND = /(?:^|[\s;&|(`$])parawatch\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?([^\n;&|`]*)/g;
const FAILED = /error: (unknown option|unknown command|missing required argument|too many arguments)[^\n"\\]*|parawatch: [^\n"\\]{0,120}/;
const PLACES = /\b(first|second|third|last)\s+(picture|image|shot|video|sheet)\b|\bleft to right\b|(첫|둘째|셋째)\s?(그림|장|영상|시트)|(왼쪽|오른쪽|위)\s?부터|맨\s?(왼쪽|오른쪽)/i;
const NESTED = new Set(["run", "pr", "sync", "relay", "skill", "project", "issue", "deploy"]);
// the commands this copy knows, read from its own source, so prose ("parawatch is ...") is not counted
const KNOWN = new Set(
  [...fs.readFileSync(new URL("../src/bin/cli.ts", import.meta.url), "utf8").matchAll(/\.command\("([a-z][a-z-]*)|cardCommand\("[a-z]+", "([a-z]+)"/g)].map((m) => m[1] ?? m[2]),
);

function blank() {
  return { sessions: 0, using: 0, skillReads: 0, maxSkillReads: 0, guide: 0, help: {}, commands: {}, failed: [], attach2: 0, captioned: 0, compare: 0, optionAttach: 0, places: 0 };
}

/** The shell commands a session ran, with what came back, from one log line. */
function calls(line, runtime) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const out = [];
  if (runtime === "claude") {
    for (const b of o?.message?.content ?? []) {
      if (b?.type === "tool_use") out.push({ id: b.id, cmd: b.name === "Bash" ? b.input?.command ?? "" : "", read: b.name === "Read" ? b.input?.file_path ?? "" : "", skill: b.name === "Skill" ? b.input?.skill ?? "" : "" });
      if (b?.type === "tool_result") out.push({ result: b.tool_use_id, text: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "") });
    }
  } else {
    const p = o?.payload ?? {};
    if (/call$/.test(p.type ?? "")) out.push({ id: p.call_id, cmd: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? p.input ?? p.action ?? "") });
    if (/call_output$/.test(p.type ?? "")) out.push({ result: p.call_id, text: JSON.stringify(p.output ?? "") });
  }
  return out;
}

async function scan(list, runtime) {
  const s = blank();
  for (const f of list) {
    s.sessions++;
    let used = false;
    let reads = 0;
    const pending = new Map();
    // logs reach hundreds of megabytes: read them a line at a time
    for await (const line of readline.createInterface({ input: fs.createReadStream(f, "utf8"), crlfDelay: Infinity })) {
      if (!line.includes("parawatch")) continue;
      for (const c of calls(line, runtime)) {
        if (c.result !== undefined) {
          const cmd = pending.get(c.result);
          const m = cmd && FAILED.exec(c.text);
          if (m && /error:|unknown|missing|no card|needs|takes|has no/.test(m[0])) s.failed.push(`${cmd.slice(0, 100)}  =>  ${m[0].slice(0, 100)}`);
          continue;
        }
        if (c.skill === "parawatch" || /parawatch[\\/]SKILL\.md/.test(c.read) || /parawatch[\\/]SKILL\.md/.test(c.cmd)) reads++;
        for (const m of c.cmd.matchAll(COMMAND)) {
          if (!KNOWN.has(m[1])) continue;
          const name = NESTED.has(m[1]) && m[2] && KNOWN.has(m[2]) ? `${m[1]} ${m[2]}` : m[1];
          const rest = m[3] ?? "";
          used = true;
          s.commands[name] = (s.commands[name] ?? 0) + 1;
          if (name === "guide") s.guide++;
          if (/(^|\s)(--help|-h)(\s|$)/.test(rest)) s.help[name] = (s.help[name] ?? 0) + 1;
          if (name === "ask" || name === "try") {
            const attaches = rest.match(/--attach\s+("[^"]*"|'[^']*'|\S+)/g) ?? [];
            if (attaches.length >= 2) {
              s.attach2++;
              if (attaches.every((a) => /=/.test(a))) s.captioned++;
              if (/--compare\b/.test(rest)) s.compare++;
              if (/--option-attach\b/.test(rest)) s.optionAttach++;
              if (PLACES.test(rest)) s.places++;
            }
          }
          if (c.id) pending.set(c.id, `parawatch ${name}${rest}`.trim());
        }
      }
    }
    if (used || reads) s.using++;
    s.skillReads += reads;
    s.maxSkillReads = Math.max(s.maxSkillReads, reads);
  }
  return s;
}

const report = {
  days,
  claude: await scan(files(claudeDir, 1), "claude"),
  codex: await scan(files(codexDir, 4), "codex"),
};
if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
else {
  const top = (o) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "none";
  for (const [name, s] of [["Claude Code", report.claude], ["Codex", report.codex]]) {
    process.stdout.write(
      [
        `${name}, last ${days} days: ${s.using} of ${s.sessions} sessions used parawatch`,
        `  skill read ${s.skillReads} times (at most ${s.maxSkillReads} in one session), guide ${s.guide} times`,
        `  commands: ${top(s.commands)}`,
        `  --help: ${top(s.help)}`,
        `  cards with 2+ attachments: ${s.attach2}; all captioned ${s.captioned}, --compare ${s.compare}, --option-attach ${s.optionAttach}, body points at places ${s.places}`,
        `  failed calls: ${s.failed.length}`,
        ...s.failed.slice(0, 20).map((x) => `    ${x}`),
        "",
      ].join("\n"),
    );
  }
}
