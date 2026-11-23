import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { instructions } from "../src/core/integrate.js";

/**
 * What agents are told to run must exist in the command they run: every `parawatch ...` the skill,
 * its reference pages and the AGENTS.md block name is a real command, with real flags. A doc that
 * drifts from the command teaches agents an error.
 */
const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "src", "bin", "cli.ts");
const loader = pathToFileURL(path.join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href;

interface Cmd {
  path: string;
  options: string[];
  sub: boolean;
  examples?: string[];
}

function commands(): Cmd[] {
  const r = spawnSync(process.execPath, ["--import", loader, cli, "commands"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PARAWATCH_NOTIFY: "0" } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Cmd[];
}

/** Every `parawatch …` in a text, cut at the end of its command (a backtick, a comment, a pipe). */
export function mentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w/-])parawatch\s+([a-z][^`\n#|;)]*)/g)) out.push(m[1]!.trim());
  return out;
}

/** The command a mention names (the longest known path) and the flags it uses before a bare `--`. */
export function parse(mention: string, known: Set<string>): { path?: string; flags: string[] } {
  // flags inside quotes belong to the quoted text (an --action command), not to parawatch
  const words = mention.replace(/"[^"]*"|'[^']*'/g, "Q").split(/\s+/);
  let p: string | undefined;
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    const cand = words.slice(0, n).join(" ");
    if (known.has(cand)) p = cand;
  }
  const flags: string[] = [];
  for (const w of words) {
    if (w === "--") break;
    const f = /^(--?[a-zA-Z][\w-]*)/.exec(w)?.[1];
    if (f && f !== "--help" && f !== "-h" && f !== "--version") flags.push(f);
  }
  return { path: p, flags };
}

function docs(cmds: Cmd[] = []): { name: string; text: string }[] {
  const skill = path.join(repo, "skills", "parawatch");
  const pages = [path.join(skill, "SKILL.md"), ...fs.readdirSync(path.join(skill, "references")).map((f) => path.join(skill, "references", f))];
  const guides = [path.join(repo, "README.md"), ...fs.readdirSync(path.join(repo, "docs")).filter((f) => f.endsWith(".md")).map((f) => path.join(repo, "docs", f))];
  return [...[...pages, ...guides].map((f) => ({ name: path.relative(repo, f), text: fs.readFileSync(f, "utf8") })), { name: "the AGENTS.md block", text: instructions("demo") }, { name: "examples in --help", text: cmds.flatMap((c) => c.examples ?? []).join("\n").replace(/\\\n\s*/g, " ") }];
}

describe("docs name only commands and flags that exist", () => {
  const cmds = commands();
  const byPath = new Map(cmds.map((c) => [c.path, c]));
  const known = new Set(byPath.keys());

  it("finds the commands in a line", () => {
    const k = new Set(["run", "run watch", "pr", "pr link", "ask"]);
    expect(parse(`run watch "CI" -p api -- gh run watch 1 --exit-status`, k)).toEqual({ path: "run watch", flags: ["-p"] });
    expect(parse(`pr link <url>`, k)).toEqual({ path: "pr link", flags: [] });
    expect(parse(`skill`, k).path).toBeUndefined();
    expect(parse(`ask -p api "Merge?" --action "gh pr merge 88 --squash"`, k)).toEqual({ path: "ask", flags: ["-p", "--action"] });
  });

  for (const d of docs(cmds)) {
    it(d.name, () => {
      const wrong: string[] = [];
      for (const m of mentions(d.text)) {
        const { path: p, flags } = parse(m, known);
        // prose like "parawatch can only guess" names no command
        if (!p) {
          if (/^[a-z]+\s+(<|-|"|$)/.test(m) || /^[a-z]+$/.test(m)) wrong.push(`unknown command: parawatch ${m}`);
          continue;
        }
        const c = byPath.get(p)!;
        for (const f of flags) if (!c.options.includes(f)) wrong.push(`parawatch ${p}: no ${f} (in "${m}")`);
      }
      expect(wrong).toEqual([]);
    });
  }
});
