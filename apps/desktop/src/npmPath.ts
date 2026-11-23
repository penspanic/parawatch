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

/**
 * The npm that can update an npm global install at `prefix`, or undefined when there is none.
 * The npm inside the prefix comes first, as it is the one that made the install. On Windows the
 * global prefix (%APPDATA%\npm) usually holds no npm of its own: npm sits beside node (Program
 * Files\nodejs, or the folder nvm links), so those come next, then any npm.cmd on the PATH. The
 * app passes --prefix, so whichever npm runs writes into the install the command line runs from.
 */
export function findNpm(
  prefix: string,
  platform: string = process.platform,
  exists: (file: string) => boolean,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const own = npmBin(prefix, platform);
  if (exists(own)) return own;
  if (platform !== "win32") return undefined;
  const dirs = [
    env.NVM_SYMLINK,
    env.ProgramFiles && `${env.ProgramFiles}\\nodejs`,
    env["ProgramFiles(x86)"] && `${env["ProgramFiles(x86)"]}\\nodejs`,
    ...(env.Path ?? env.PATH ?? "").split(";"),
  ];
  for (const d of dirs) {
    const dir = d?.trim().replace(/[\\/]+$/, "");
    if (!dir) continue;
    const npm = `${dir}\\npm.cmd`;
    if (exists(npm)) return npm;
  }
  return undefined;
}

/**
 * A path or argument for a command run through cmd.exe (`shell: true` on Windows), which splits an
 * unquoted `C:\Program Files\nodejs\npm.cmd` at its space and runs `C:\Program`. Quoted there when
 * it holds a space or a character cmd treats specially; unchanged elsewhere.
 */
export function forCmd(s: string, platform: string = process.platform): string {
  if (platform !== "win32" || /^".*"$/.test(s) || !/[\s&()^|<>,;=]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
