/** The package's own version, read from package.json so it is written in one place. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** The version of this package (works from src/ and from dist/). */
export function packageVersion(): string {
  if (cached) return cached;
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    cached = String((JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }).version ?? "0.0.0");
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

export { compareVersions } from "./semver.js";
