/**
 * Sharing the log between machines. Parawatch only reads and writes files in a shared folder:
 * each machine appends to `events/<device>.jsonl` and reads them all. Moving that folder between
 * machines is the job of a sync tool, and a sync adapter only reports how that tool is doing.
 *
 * Layout of the shared folder:
 *   events/<device>.jsonl   each machine's own log; only that machine writes it
 *   devices/<device>.json   each machine's paths, version and last sign of life
 *   listeners/              waits running on any machine
 *   attachments/            pasted images, so every machine can open them
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import type { PathMap } from "./state.js";
import {
  DEVICE_NAME,
  configPath,
  deviceName,
  eventFiles,
  expandHome,
  homeDir,
  parseEventLines,
  readConfig,
  sharedDir,
  withLock,
  writeConfig,
} from "./store.js";
import { syncthingAdapter } from "./syncthing.js";

// ------------------------------------------------------------------ devices

/** What a machine says about itself in `devices/<name>.json`. */
export interface DeviceInfo {
  name: string;
  platform: string;
  /** a fingerprint of the machine (host and home), to catch two machines using one name */
  host: string;
  home: string;
  /** where this machine keeps the shared folder */
  shared: string;
  /** other folders with a name, so the same place on another machine maps to here: `gdrive` */
  roots?: Record<string, string>;
  version?: string;
  at: string;
}

function devicesDir(shared: string): string {
  return path.join(shared, "devices");
}

function hostPrint(): string {
  return `${os.hostname()}:${os.homedir()}`;
}

export function readDevice(name: string, shared = sharedDir()): DeviceInfo | undefined {
  if (!shared) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(devicesDir(shared), `${name}.json`), "utf8")) as DeviceInfo;
  } catch {
    return undefined;
  }
}

export function readDevices(shared = sharedDir()): DeviceInfo[] {
  if (!shared) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(devicesDir(shared)).filter((n) => /^[a-z0-9][a-z0-9-]*\.json$/.test(n));
  } catch {
    return [];
  }
  const out: DeviceInfo[] = [];
  for (const n of names) {
    const d = readDevice(n.slice(0, -5), shared);
    if (d) out.push(d);
  }
  return out;
}

const DEVICE_REFRESH_MS = 10 * 60_000;

/** Write this machine's device file when something changed or it is getting old. */
export function touchDevice(version?: string, opts: { force?: boolean; roots?: Record<string, string> } = {}): DeviceInfo | undefined {
  const shared = sharedDir();
  if (!shared) return undefined;
  const name = deviceName();
  const before = readDevice(name, shared);
  const me: DeviceInfo = {
    name,
    platform: process.platform,
    host: hostPrint(),
    home: os.homedir(),
    shared,
    roots: { ...(before?.host === hostPrint() ? before.roots : {}), ...(opts.roots ?? {}) },
    version: version ?? before?.version,
    at: new Date().toISOString(),
  };
  if (!Object.keys(me.roots!).length) delete me.roots;
  const same =
    before &&
    before.host === me.host &&
    before.shared === me.shared &&
    before.version === me.version &&
    JSON.stringify(before.roots ?? {}) === JSON.stringify(me.roots ?? {}) &&
    Date.now() - Date.parse(before.at) < DEVICE_REFRESH_MS;
  if (same && !opts.force) return before;
  try {
    const dir = devicesDir(shared);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(me, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    // the shared folder may be read only for a moment; try again next time
  }
  return me;
}

// ------------------------------------------------------------------ paths

function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

function startsWithPath(p: string, root: string, caseless: boolean): string[] | undefined {
  const a = splitPath(p);
  const b = splitPath(root);
  if (!b.length || a.length < b.length) return undefined;
  for (let i = 0; i < b.length; i++) {
    const x = caseless ? a[i]!.toLowerCase() : a[i]!;
    const y = caseless ? b[i]!.toLowerCase() : b[i]!;
    if (x !== y) return undefined;
  }
  return a.slice(b.length);
}

function joinOn(platform: string, root: string, rest: string[]): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  return rest.length ? p.join(root, ...rest) : root;
}

/**
 * A path from another machine, as the same place on this one: under that machine's shared
 * folder, a named root, or its home. The longest match wins; anything else is left as it is.
 */
export function mapPath(p: string, from: DeviceInfo | undefined, me: DeviceInfo | undefined): string {
  if (!from || !me || from.name === me.name || /^[a-z]+:\/\//i.test(p)) return p;
  const caseless = from.platform === "win32";
  const pairs: [string, string][] = [[from.shared, me.shared]];
  for (const [k, v] of Object.entries(from.roots ?? {})) {
    const mine = me.roots?.[k];
    if (mine) pairs.push([v, mine]);
  }
  pairs.push([from.home, me.home]);
  let best: { rest: string[]; root: string; len: number } | undefined;
  for (const [theirs, mine] of pairs) {
    const rest = startsWithPath(p, theirs, caseless);
    const len = splitPath(theirs).length;
    if (rest && (!best || len > best.len)) best = { rest, root: mine, len };
  }
  return best ? joinOn(me.platform, best.root, best.rest) : p;
}

/** The path map for reading the shared log on this machine, or undefined when nothing is shared. */
export function pathMap(): PathMap | undefined {
  const shared = sharedDir();
  if (!shared) return undefined;
  const devices = new Map(readDevices(shared).map((d) => [d.name, d]));
  const name = deviceName();
  const me: DeviceInfo = devices.get(name) ?? { name, platform: process.platform, host: hostPrint(), home: os.homedir(), shared, at: "" };
  if (devices.size <= 1) return undefined;
  return (p, from) => (from ? mapPath(p, devices.get(from), me) : p);
}

// ------------------------------------------------------------------ adapters

export interface PeerStatus {
  name: string;
  connected?: boolean;
  /** when it was last connected, or last wrote to the shared folder */
  lastSeen?: string;
  address?: string;
  version?: string;
}

export interface SyncStatus {
  adapter: string;
  dir: string;
  device: string;
  /** the tool is running and reachable */
  ok: boolean;
  /** when the tool last finished bringing the folder up to date, or the newest file from another machine */
  lastSync?: string;
  peers: PeerStatus[];
  /** copies a sync tool made when two machines changed one file */
  conflicts: string[];
  /** files that are still on their way */
  pending?: number;
  error?: string;
}

/**
 * Something that carries the shared folder between machines. Parawatch never asks it to move
 * anything: it only asks how it is doing, for `doctor`, `sync status` and the app.
 */
export interface SyncAdapter {
  name: string;
  /** one line on what it is, for `sync status` */
  about: string;
  status(ctx: SyncContext): Promise<SyncStatus>;
}

export interface SyncContext {
  dir: string;
  device: string;
  /** this adapter's own block in config.json (`sync.<adapter name>`) */
  config: Record<string, unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const CONFLICT = /\.sync-conflict-|conflicted copy|\(conflict\)|\.conflict\d*$/i;

/** Conflict copies anywhere in the shared folder (sync tools name them in their own ways). */
export function findConflicts(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (CONFLICT.test(n.name)) out.push(p);
      else if (n.isDirectory() && left > 0 && !n.name.startsWith(".st")) walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return out.sort();
}

/** Other machines as the shared folder shows them: their device files and their logs. */
export function folderPeers(dir: string, me: string): PeerStatus[] {
  const peers = new Map<string, PeerStatus>();
  for (const d of readDevices(dir)) if (d.name !== me) peers.set(d.name, { name: d.name, lastSeen: d.at, version: d.version });
  try {
    for (const n of fs.readdirSync(path.join(dir, "events"))) {
      const m = /^([a-z0-9][a-z0-9-]*)\.jsonl$/.exec(n);
      if (!m || m[1] === me) continue;
      const at = fs.statSync(path.join(dir, "events", n)).mtime.toISOString();
      const p = peers.get(m[1]!) ?? { name: m[1]! };
      if (!p.lastSeen || at > p.lastSeen) p.lastSeen = at;
      peers.set(m[1]!, p);
    }
  } catch {
    // no logs yet
  }
  return [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Any folder something else keeps in step: a cloud drive, a network share, a git checkout. */
export const folderAdapter: SyncAdapter = {
  name: "folder",
  about: "a folder kept in step by something else (a cloud drive, a network share)",
  async status(ctx) {
    const peers = folderPeers(ctx.dir, ctx.device);
    const newest = peers.map((p) => p.lastSeen ?? "").sort().pop() || undefined;
    return { adapter: "folder", dir: ctx.dir, device: ctx.device, ok: fs.existsSync(ctx.dir), lastSync: newest, peers, conflicts: findConflicts(ctx.dir) };
  },
};

let registry: Map<string, SyncAdapter> | undefined;

// built on first use: the Syncthing module imports helpers from this one
function adapters(): Map<string, SyncAdapter> {
  registry ??= new Map<string, SyncAdapter>([
    [folderAdapter.name, folderAdapter],
    [syncthingAdapter.name, syncthingAdapter],
  ]);
  return registry;
}

/** Add an adapter (another sync tool). The name is what `sync.adapter` in config.json picks. */
export function registerAdapter(a: SyncAdapter): void {
  adapters().set(a.name, a);
}

export function adapterNames(): string[] {
  return [...adapters().keys()];
}

export function syncAdapter(name: string | undefined): SyncAdapter {
  return adapters().get(name ?? "folder") ?? folderAdapter;
}

/** How sharing is doing, or undefined when this machine keeps its log to itself. */
export async function syncStatus(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SyncStatus | undefined> {
  const dir = sharedDir();
  if (!dir) return undefined;
  const cfg = readConfig().sync ?? {};
  const a = syncAdapter(typeof cfg.adapter === "string" ? cfg.adapter : undefined);
  const own = cfg[a.name];
  const ctx: SyncContext = { dir, device: deviceName(), config: own && typeof own === "object" ? (own as Record<string, unknown>) : {}, fetch: opts.fetch, timeoutMs: opts.timeoutMs };
  try {
    return await a.status(ctx);
  } catch (err) {
    return { adapter: a.name, dir, device: ctx.device, ok: false, peers: folderPeers(dir, ctx.device), conflicts: findConflicts(dir), error: (err as Error).message };
  }
}

// ------------------------------------------------------------------ setup

export interface SetupInput {
  dir: string;
  device?: string;
  adapter?: string;
  version?: string;
}

export interface SetupResult {
  dir: string;
  device: string;
  adapter: string;
  /** events moved from this machine's own log into the shared folder */
  moved: number;
  /** the old log, kept as it was */
  backup?: string;
  others: string[];
}

/** The line left in the old single-machine log, so an older parawatch refuses to write there. */
export function movedMarker(to: string, seq: number): string {
  return JSON.stringify({ v: 2, seq, ts: new Date().toISOString(), type: "store.moved", to }) + "\n";
}

/**
 * Start writing to a shared folder. This machine's log moves there as `events/<device>.jsonl`,
 * keeping every event and seq as it was, so ids, cursors and answers stay valid. The old file is
 * kept as a backup and replaced by a marker that makes older copies stop writing to it.
 * Running it again with the same folder and name changes nothing.
 */
export function setupSync(input: SetupInput): SetupResult {
  const dir = path.resolve(expandHome(input.dir.trim()));
  const cfg = readConfig();
  const device = (input.device ?? (typeof cfg.device === "string" ? cfg.device : undefined) ?? deviceName()).trim();
  if (!DEVICE_NAME.test(device)) throw new UserError(`device name "${device}" may only use a-z, 0-9 and -, up to 32 characters`);
  const adapter = input.adapter ?? (typeof cfg.sync?.adapter === "string" ? cfg.sync.adapter : "folder");
  if (!adapters().has(adapter)) throw new UserError(`unknown sync adapter "${adapter}" (known: ${adapterNames().join(", ")})`);
  const current = sharedDir();
  if (current && current !== dir) throw new UserError(`this machine already shares ${current}. Moving to another folder is not supported yet.`);

  return withLock(() => {
    fs.mkdirSync(path.join(dir, "events"), { recursive: true });
    const target = path.join(dir, "events", `${device}.jsonl`);
    const theirs = readDevice(device, dir);
    if (theirs && theirs.host !== hostPrint()) {
      throw new UserError(`another machine (${theirs.host}) already writes as "${device}" in ${dir}. Pick another name with --device.`);
    }
    const legacy = path.join(homeDir(), "events.jsonl");
    let moved = 0;
    let backup: string | undefined;
    const text = fs.existsSync(legacy) ? fs.readFileSync(legacy, "utf8") : "";
    const events = parseEventLines(text).filter((e) => e.type !== "store.moved");
    if (events.length) {
      const already = fs.existsSync(target) ? parseEventLines(fs.readFileSync(target, "utf8")) : [];
      if (already.length) throw new UserError(`${target} already has ${already.length} events and this machine has its own log too. Pick another --device name.`);
      const tmp = path.join(dir, "events", `.${device}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + "\n").join(""));
      fs.renameSync(tmp, target);
      backup = `${legacy}.before-sync`;
      fs.copyFileSync(legacy, backup);
      fs.writeFileSync(legacy, movedMarker(target, (events[events.length - 1]?.seq ?? 0) + 1));
      moved = events.length;
    }
    const sync = { ...(cfg.sync ?? {}), dir: input.dir.trim().startsWith("~") ? input.dir.trim() : dir, adapter };
    writeConfig({ ...cfg, device, sync });
    touchDevice(input.version, { force: true });
    const others = eventFiles()
      .map((f) => f.device)
      .filter((d) => d !== device);
    return { dir, device, adapter, moved, backup, others };
  });
}

/** Name a folder on this machine so paths under it map to the same name on other machines. */
export function setRoot(name: string, folder: string | undefined, version?: string): DeviceInfo {
  if (!sharedDir()) throw new UserError("this machine does not share its log yet: run `parawatch sync setup <folder>` first");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name) || name === "home" || name === "shared") throw new UserError(`root name "${name}" may use letters, digits, _ and -, and cannot be home or shared`);
  const before = readDevice(deviceName());
  const roots = { ...(before?.roots ?? {}) };
  if (folder) roots[name] = path.resolve(expandHome(folder));
  else delete roots[name];
  const shared = sharedDir()!;
  const me: DeviceInfo = { name: deviceName(), platform: process.platform, host: hostPrint(), home: os.homedir(), shared, roots, version: version ?? before?.version, at: new Date().toISOString() };
  if (!Object.keys(roots).length) delete me.roots;
  fs.mkdirSync(devicesDir(shared), { recursive: true });
  fs.writeFileSync(path.join(devicesDir(shared), `${me.name}.json`), JSON.stringify(me, null, 2) + "\n");
  return me;
}

export { configPath };
