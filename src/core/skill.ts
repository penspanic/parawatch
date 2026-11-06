import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./ops.js";

/** The agent skill shipped with this package (works from src/ and from dist/). */
export function skillSource(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "parawatch");
}

export interface SkillTarget {
  runtime: string;
  /** the folder that holds skills, e.g. ~/.claude/skills */
  dir: string;
  /** the runtime's config folder; when it does not exist the runtime is not installed */
  home: string;
}

export function skillTargets(): SkillTarget[] {
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const codex = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return [
    { runtime: "claude-code", dir: path.join(claude, "skills"), home: claude },
    { runtime: "codex", dir: path.join(codex, "skills"), home: codex },
  ];
}

export interface InstallResult {
  runtime: string;
  path: string;
  result: "linked" | "already linked" | "replaced link" | "skipped";
  note?: string;
}

/**
 * Link the skill into each runtime's skills folder. Runtimes whose config folder is missing are
 * skipped unless named. An existing folder that is not our link is left alone unless `force`.
 */
export function installSkill(targets: SkillTarget[], opts: { only?: string[]; force?: boolean } = {}): InstallResult[] {
  const src = skillSource();
  if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new UserError(`skill not found at ${src}`);
  const out: InstallResult[] = [];
  for (const t of targets) {
    const named = opts.only?.includes(t.runtime);
    if (opts.only && !named) continue;
    const dest = path.join(t.dir, "parawatch");
    if (!named && !fs.existsSync(t.home)) {
      out.push({ runtime: t.runtime, path: dest, result: "skipped", note: `${t.home} not found` });
      continue;
    }
    fs.mkdirSync(t.dir, { recursive: true });
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(dest);
    } catch {
      stat = undefined;
    }
    if (stat?.isSymbolicLink()) {
      const current = path.resolve(t.dir, fs.readlinkSync(dest));
      if (current === src) {
        out.push({ runtime: t.runtime, path: dest, result: "already linked" });
        continue;
      }
      fs.unlinkSync(dest);
      fs.symlinkSync(src, dest);
      out.push({ runtime: t.runtime, path: dest, result: "replaced link", note: `was ${current}` });
      continue;
    }
    if (stat) {
      if (!opts.force) {
        out.push({ runtime: t.runtime, path: dest, result: "skipped", note: "a folder is already there; use --force to replace it" });
        continue;
      }
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.symlinkSync(src, dest);
    out.push({ runtime: t.runtime, path: dest, result: "linked" });
  }
  return out;
}
