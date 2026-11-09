/**
 * Whether a newer parawatch is out, for the command line. It asks the npm registry at most once a
 * day and remembers the answer; it never blocks a command for long and never fails one. Turn it off
 * with `"updates": { "check": false }` in config.json or PARAWATCH_UPDATE_CHECK=0 (also off in CI).
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./store.js";
import { compareVersions } from "./semver.js";

export const REGISTRY_URL = "https://registry.npmjs.org/parawatch/latest";
const DAY_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
const TIMEOUT_MS = 2_000;

export interface UpdateCache {
  checkedAt?: string;
  latest?: string;
  error?: string;
}

export interface UpdateInfo {
  current: string;
  latest?: string;
  newer: boolean;
  checkedAt?: string;
  error?: string;
}

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function cachePath(): string {
  return path.join(homeDir(), "update.json");
}

export function updateChecksOn(): boolean {
  if (process.env.PARAWATCH_UPDATE_CHECK === "0") return false;
  if (process.env.PARAWATCH_UPDATE_CHECK !== "1" && process.env.CI) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir(), "config.json"), "utf8")) as { updates?: { check?: boolean } };
    return raw.updates?.check !== false;
  } catch {
    return true;
  }
}

export function readUpdateCache(): UpdateCache {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf8")) as UpdateCache;
  } catch {
    return {};
  }
}

function writeUpdateCache(c: UpdateCache): void {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    const tmp = `${cachePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c) + "\n");
    fs.renameSync(tmp, cachePath());
  } catch {
    // the next run asks again
  }
}

function info(current: string, c: UpdateCache): UpdateInfo {
  return { current, latest: c.latest, newer: !!c.latest && compareVersions(c.latest, current) > 0, checkedAt: c.checkedAt, error: c.error };
}

/**
 * The newest published version, from the cache while it is fresh. `force` asks now. Returns
 * undefined when update checks are off.
 */
export async function checkUpdate(current: string, opts: { force?: boolean; now?: number; fetch?: Fetcher } = {}): Promise<UpdateInfo | undefined> {
  if (!opts.force && !updateChecksOn()) return undefined;
  const now = opts.now ?? Date.now();
  const cache = readUpdateCache();
  const age = cache.checkedAt ? now - Date.parse(cache.checkedAt) : Infinity;
  if (!opts.force && age < (cache.error ? RETRY_MS : DAY_MS)) return info(current, cache);
  const get = opts.fetch ?? (globalThis.fetch as unknown as Fetcher);
  let next: UpdateCache;
  try {
    const res = await get(REGISTRY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") throw new Error("the npm registry gave no version");
    next = { checkedAt: new Date(now).toISOString(), latest: body.version };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? "the npm registry did not answer in time" : err.message) : String(err);
    next = { checkedAt: new Date(now).toISOString(), latest: cache.latest, error: msg };
  }
  writeUpdateCache(next);
  return info(current, next);
}

export function updateLine(u: UpdateInfo | undefined): string | undefined {
  if (!u?.newer) return undefined;
  return `parawatch ${u.latest} is out (this is ${u.current}): npm i -g parawatch@latest`;
}
