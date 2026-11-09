/**
 * The Syncthing adapter: asks the local Syncthing (its REST API) how the shared folder is doing.
 * The API key is read from Syncthing's own config.xml and never printed or stored by parawatch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConflicts, folderPeers, type PeerStatus, type SyncAdapter, type SyncContext, type SyncStatus } from "./sync.js";

/** Where Syncthing keeps config.xml on this machine, newest layout first. */
export function syncthingHomes(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(local, "Syncthing")];
  }
  const state = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
  const out = [path.join(state, "syncthing")];
  if (process.platform === "darwin") out.push(path.join(home, "Library", "Application Support", "Syncthing"));
  out.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "syncthing"));
  return out;
}

export interface SyncthingGui {
  url: string;
  apiKey?: string;
  configFile?: string;
}

/** The GUI address and API key from config.xml (`home` overrides where to look). */
export function readSyncthingGui(home?: string): SyncthingGui {
  const dirs = home ? [home] : syncthingHomes();
  for (const d of dirs) {
    const file = path.join(d, "config.xml");
    let xml: string;
    try {
      xml = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const gui = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
    const attrs = gui?.[1] ?? "";
    const body = gui?.[2] ?? "";
    const address = /<address>([^<]+)<\/address>/.exec(body)?.[1]?.trim() || "127.0.0.1:8384";
    const tls = /\btls="true"/.test(attrs);
    const apiKey = /<apikey>([^<]+)<\/apikey>/.exec(body)?.[1]?.trim();
    const host = address.replace(/^0\.0\.0\.0(?=:)/, "127.0.0.1").replace(/^\[::\](?=:)/, "[::1]");
    return { url: `${tls ? "https" : "http"}://${host}`, apiKey, configFile: file };
  }
  return { url: "http://127.0.0.1:8384" };
}

interface StFolder {
  id: string;
  label?: string;
  path: string;
  devices?: { deviceID: string }[];
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export const syncthingAdapter: SyncAdapter = {
  name: "syncthing",
  about: "Syncthing on this machine (its REST API on localhost)",
  async status(ctx: SyncContext): Promise<SyncStatus> {
    const base: SyncStatus = { adapter: "syncthing", dir: ctx.dir, device: ctx.device, ok: false, peers: folderPeers(ctx.dir, ctx.device), conflicts: findConflicts(ctx.dir) };
    const gui = readSyncthingGui(typeof ctx.config.home === "string" ? ctx.config.home : undefined);
    const url = typeof ctx.config.url === "string" ? ctx.config.url : gui.url;
    const key = process.env.PARAWATCH_SYNCTHING_KEY || gui.apiKey;
    if (!key) return { ...base, error: "no Syncthing API key found (is Syncthing set up on this machine?)" };
    const f = ctx.fetch ?? fetch;
    const timeout = ctx.timeoutMs ?? 2000;
    const get = async <T>(p: string): Promise<T> => {
      const res = await f(`${url}${p}`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`Syncthing answered ${res.status} for ${p.split("?")[0]}`);
      return (await res.json()) as T;
    };
    let folders: StFolder[];
    try {
      folders = await get<StFolder[]>("/rest/config/folders");
    } catch (err) {
      const msg = (err as Error).message;
      return { ...base, error: /fetch failed|ECONNREFUSED|abort|timeout/i.test(msg) ? `Syncthing is not running at ${url}` : msg };
    }
    const folder = folders
      .map((x) => ({ ...x, path: x.path.replace(/^~(?=[\\/]|$)/, os.homedir()) }))
      .filter((x) => inside(ctx.dir, x.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!folder) return { ...base, ok: true, error: `no Syncthing folder holds ${ctx.dir}` };
    const [sys, devices, conns, stats, db, fstats] = await Promise.all([
      get<{ myID: string }>("/rest/system/status"),
      get<{ deviceID: string; name?: string }[]>("/rest/config/devices"),
      get<{ connections: Record<string, { connected: boolean; address?: string; clientVersion?: string }> }>("/rest/system/connections"),
      get<Record<string, { lastSeen?: string }>>("/rest/stats/device"),
      get<{ state?: string; stateChanged?: string; needFiles?: number; errors?: number; pullErrors?: number }>(`/rest/db/status?folder=${encodeURIComponent(folder.id)}`),
      get<Record<string, { lastScan?: string; lastFile?: { at?: string } }>>("/rest/stats/folder"),
    ]);
    const names = new Map(devices.map((d) => [d.deviceID, d.name || d.deviceID.slice(0, 7)]));
    const known = new Map(base.peers.map((p) => [p.name, p]));
    const peers: PeerStatus[] = [];
    for (const d of folder.devices ?? []) {
      if (d.deviceID === sys.myID) continue;
      const c = conns.connections[d.deviceID];
      const seen = stats[d.deviceID]?.lastSeen;
      const name = names.get(d.deviceID) ?? d.deviceID.slice(0, 7);
      const fromFolder = known.get(name);
      peers.push({
        name,
        connected: !!c?.connected,
        lastSeen: c?.connected ? new Date().toISOString() : seen && !seen.startsWith("1970") ? seen : fromFolder?.lastSeen,
        address: c?.connected ? c.address : undefined,
        version: fromFolder?.version,
      });
    }
    const idle = db.state === "idle" && !db.needFiles;
    const pending = db.needFiles ?? 0;
    const errors = (db.errors ?? 0) + (db.pullErrors ?? 0);
    return {
      ...base,
      ok: true,
      peers,
      pending: pending || undefined,
      lastSync: idle ? db.stateChanged : fstats[folder.id]?.lastFile?.at,
      error: errors ? `${errors} file(s) could not be synced (see Syncthing)` : !peers.length ? `folder "${folder.label || folder.id}" is not shared with another device yet` : undefined,
    };
  },
};
