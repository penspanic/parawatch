import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Point parawatch at a fresh state directory for one test. */
export function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-test-"));
  process.env.PARAWATCH_HOME = dir;
  process.env.PARAWATCH_NOTIFY = "0";
  // never read this machine's Claude desktop sessions
  process.env.PARAWATCH_CLAUDE_DESKTOP_DIR = path.join(dir, "claude-desktop");
  return dir;
}
