/** Where an npm global install keeps things, worked out from its paths alone, so tests can run it for any platform. */

/** Where an npm global install of parawatch keeps its prefix, from the path of its cli.js. */
export function npmPrefix(cliPath: string | undefined, platform: string = process.platform): string | undefined {
  if (!cliPath) return undefined;
  const parts = cliPath.split(/[\\/]/);
  const at = parts.lastIndexOf("parawatch");
  if (at < 1 || parts[at - 1] !== "node_modules") return undefined;
  // posix: <prefix>/lib/node_modules/parawatch; windows: <prefix>\node_modules\parawatch
  if (platform === "win32") return parts.slice(0, at - 1).join("\\") || undefined;
  if (parts[at - 2] !== "lib") return undefined;
  return parts.slice(0, at - 2).join("/") || "/";
}

export function npmBin(prefix: string, platform: string = process.platform): string {
  return platform === "win32" ? `${prefix}\\npm.cmd` : `${prefix}/bin/npm`;
}
