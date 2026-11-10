import fs from "node:fs";
import path from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * The real spelling of a path, for comparing: symlinks and Windows short names (`RUNNER~1`)
 * resolved, through the deepest part that exists. On Windows also lower case with `\` only, since
 * the file system ignores case and logs mix `/` and `\`.
 */
export function canonicalPath(p: string): string {
  let rest = "";
  let head = path.resolve(p);
  let out = head;
  for (;;) {
    try {
      out = path.join(fs.realpathSync.native(head), rest);
      break;
    } catch {
      const up = path.dirname(head);
      if (up === head) break;
      rest = path.join(path.basename(head), rest);
      head = up;
    }
  }
  return WINDOWS ? out.replace(/\//g, "\\").toLowerCase() : out;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Whether `child` is `parent` or inside it, as written or once both are resolved
 * (`canonicalPath`). Pass a canonical form when it is already known, to skip the file system.
 */
export function insidePath(child: string, parent: string, canon?: { child?: string; parent?: string }): boolean {
  if (within(path.resolve(child), path.resolve(parent))) return true;
  return within(canon?.child ?? canonicalPath(child), canon?.parent ?? canonicalPath(parent));
}

/** Whether two paths name the same folder. */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b) || canonicalPath(a) === canonicalPath(b);
}

/**
 * Whether a text (a prompt) names this folder: as written, or with `\` and `/` swapped, and on
 * Windows ignoring case.
 */
export function namesPath(text: string, dir: string): boolean {
  if (text.includes(dir)) return true;
  const hay = WINDOWS ? text.toLowerCase() : text;
  const d = WINDOWS ? dir.toLowerCase() : dir;
  return hay.includes(d.replace(/\\/g, "/")) || hay.includes(d.replace(/\//g, "\\"));
}
