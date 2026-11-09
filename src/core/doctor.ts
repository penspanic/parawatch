/**
 * `parawatch doctor`: one look at how parawatch is set up on this machine, for setting it up on a
 * new one and for bug reports. It only reads; every line that needs work says what to run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_UPDATE, readClient, runningDesktop, versionSkew } from "./clients.js";
import { ghHosts, githubConfig, readCache, runGh, type GhRunner } from "./github.js";
import { instructionState } from "./integrate.js";
import { listeners } from "./ops.js";
import { fold } from "./state.js";
import { deviceName, eventFiles, homeDir, readEvents, sharedDir, storeFormat } from "./store.js";
import { readDevice, syncStatus, type SyncStatus } from "./sync.js";
import { skillState, skillTargets, type SkillTarget } from "./skill.js";
import { STORE_FORMAT } from "./types.js";
import { updateChecksOn, type UpdateInfo } from "./update.js";

export type CheckState = "ok" | "warn" | "off" | "info";

export interface Check {
  area: string;
  state: CheckState;
  text: string;
  /** what to run or do about it */
  fix?: string;
}

export interface DoctorInput {
  version: string;
  /** where the command line runs from */
  bin?: string;
  update?: UpdateInfo;
  cwd?: string;
  targets?: SkillTarget[];
  gh?: GhRunner;
  /** Claude Code settings files to look for the hook in */
  claudeSettings?: string[];
  /** how sharing is doing; read from the sync tool when not given */
  sync?: SyncStatus | null;
}

function claudeSettingsFiles(): string[] {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return [path.join(dir, "settings.json"), path.join(dir, "settings.local.json")];
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function doctor(input: DoctorInput): Promise<Check[]> {
  const out: Check[] = [];
  const add = (area: string, state: CheckState, text: string, fix?: string) => out.push({ area, state, text, ...(fix ? { fix } : {}) });

  // the command line
  add("cli", "ok", `parawatch ${input.version} on node ${process.versions.node}${input.bin ? ` at ${input.bin}` : ""}`);
  const u = input.update;
  if (!u) add("updates", "off", updateChecksOn() ? "not checked" : "update checks are off");
  else if (u.newer) add("updates", "warn", `${u.latest} is out`, CLI_UPDATE);
  else if (u.error) add("updates", "info", `could not check: ${u.error}`);
  else add("updates", "ok", `up to date${u.latest ? ` (latest ${u.latest})` : ""}`);

  // the store
  const events = readEvents();
  let size = 0;
  for (const f of eventFiles()) {
    try {
      size += fs.statSync(f.file).size;
    } catch {
      // no events yet
    }
  }
  const format = storeFormat(events);
  const shared = sharedDir();
  const where = shared ? `${shared} (shared) · this machine ${homeDir()}` : homeDir();
  if (format > STORE_FORMAT) add("store", "warn", `${where} has format ${format}, newer than this copy reads (${STORE_FORMAT})`, CLI_UPDATE);
  else add("store", "ok", `${where} · ${events.length} events, ${bytes(size)}`);

  // other machines
  const st = input.sync === undefined ? await syncStatus().catch(() => undefined) : input.sync ?? undefined;
  if (!shared) add("sync", "off", "this machine only", "to share with another machine: parawatch sync setup <folder> --device <name>");
  else {
    const me = deviceName();
    const mine = readDevice(me);
    if (mine && mine.host !== `${os.hostname()}:${os.homedir()}`) add("sync", "warn", `another machine (${mine.host}) also writes as "${me}"`, "give each machine its own name: parawatch sync setup <folder> --device <name>");
    if (!st) add("sync", "info", `${me} · ${shared}`);
    else {
      const peers = st.peers.map((p) => `${p.name} ${p.connected === true ? "connected" : p.connected === false ? "not connected" : "seen"}`).join(", ");
      add("sync", st.error || !st.ok ? "warn" : "ok", `${me} · ${st.adapter} · ${peers || "no other machine yet"}${st.error ? ` · ${st.error}` : ""}`);
      if (st.conflicts.length) add("sync", "warn", `${st.conflicts.length} conflict copy(ies): ${st.conflicts.slice(0, 3).join(", ")}`, "each machine writes only its own file; look for two machines using one device name");
    }
  }
  const state = fold(events);
  add("projects", state.projects.size ? "ok" : "info", state.projects.size ? [...state.projects.keys()].join(", ") : "none registered (claims still work)");

  // the desktop app
  const desktop = runningDesktop();
  const seen = desktop ?? readClient("desktop");
  if (desktop) add("desktop", "ok", `Parawatch ${desktop.version} is running${desktop.log ? ` · log ${desktop.log}` : ""}`);
  else if (seen) add("desktop", "info", `not running (last seen ${seen.version}, ${seen.at.slice(0, 10)})${seen.log ? ` · log ${seen.log}` : ""}`);
  else add("desktop", "info", "not used on this machine (the command line works alone)");
  const skew = versionSkew(input.version, desktop?.version);
  if (skew) add("versions", "warn", skew.text, skew.older === "cli" ? CLI_UPDATE : "Parawatch > Check for Updates");

  // what agents are told
  for (const t of input.targets ?? skillTargets()) {
    const s = skillState(t);
    const where = path.join(t.dir, "parawatch");
    if (s.state === "linked") add(`skill:${t.runtime}`, "ok", where);
    else if (s.state === "linked elsewhere") add(`skill:${t.runtime}`, "warn", `${where} links to ${s.target}, not to this copy`, "parawatch skill install");
    else if (s.state === "folder") add(`skill:${t.runtime}`, "info", `${where} is a copy; it will not follow updates`, "parawatch skill install --force");
    else if (s.state === "missing") add(`skill:${t.runtime}`, "warn", "not installed", "parawatch skill install");
    else add(`skill:${t.runtime}`, "off", `${t.runtime} not found (${t.home})`);
  }
  const cwd = input.cwd ?? process.cwd();
  const files = ["AGENTS.md", "CLAUDE.md"].map((f) => path.join(cwd, f));
  const found = files.map((f) => ({ f, s: instructionState(f) })).filter((x) => x.s !== "absent");
  if (!found.length) add("instructions", "info", `no parawatch block in AGENTS.md or CLAUDE.md in ${cwd}`, "parawatch init");
  for (const x of found) {
    if (x.s === "current") add("instructions", "ok", x.f);
    else add("instructions", "warn", `${x.f} has an older parawatch block`, `parawatch init -f ${path.basename(x.f)}`);
  }
  const hooked = (input.claudeSettings ?? claudeSettingsFiles()).filter((f) => {
    try {
      return fs.readFileSync(f, "utf8").includes("parawatch hook");
    } catch {
      return false;
    }
  });
  add("hook", hooked.length ? "ok" : "info", hooked.length ? `Claude Code hook in ${hooked.join(", ")}` : "no Claude Code hook (optional; see the README)");

  // GitHub
  const g = githubConfig();
  if (!g.enabled) add("github", "off", "turned off in config.json or PARAWATCH_GITHUB=0");
  else {
    const gh = input.gh ?? runGh;
    let ghVersion: string | undefined;
    try {
      ghVersion = (await gh(["--version"])).split("\n")[0]?.trim();
    } catch {
      ghVersion = undefined;
    }
    if (!ghVersion) add("github", "off", "gh not found, so pull requests are not followed (nothing else needs it)", "install gh and run gh auth login");
    else {
      const hosts = await ghHosts(gh);
      if (!hosts.length) add("github", "warn", `${ghVersion}, but not signed in`, "gh auth login");
      else {
        const c = readCache();
        const when = c.fetchedAt ? `last read ${c.fetchedAt.replace("T", " ").slice(0, 16)}` : "not read yet";
        add("github", c.error ? "warn" : "ok", `${hosts.join(", ")} · ${c.prs.length} PRs · ${when}${c.error ? ` · ${c.error}` : ""}`, c.error ? "parawatch pr sync" : undefined);
      }
    }
  }

  const ls = listeners();
  add("waits", "info", ls.length ? `${ls.length} agent wait(s) armed` : "no agent is waiting right now");
  return out;
}

const MARK: Record<CheckState, string> = { ok: "✓", warn: "!", off: "-", info: "·" };

export function doctorText(checks: Check[], color = false): string {
  const width = Math.max(...checks.map((c) => c.area.length));
  return checks
    .map((c) => {
      const mark = color && c.state === "warn" ? `\x1b[33m${MARK[c.state]}\x1b[0m` : color && c.state === "ok" ? `\x1b[32m${MARK[c.state]}\x1b[0m` : MARK[c.state];
      const fix = c.fix ? (color ? `\n${" ".repeat(width + 4)}\x1b[2m→ ${c.fix}\x1b[0m` : `\n${" ".repeat(width + 4)}→ ${c.fix}`) : "";
      return `${mark} ${c.area.padEnd(width)}  ${c.text}${fix}`;
    })
    .join("\n");
}
