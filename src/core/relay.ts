/**
 * Keeping the shared folder in step through a relay server (src/relay/server.ts) instead of a sync
 * tool. The folder stays where it is on every machine; this mirror uploads what changed here and
 * writes what changed elsewhere, file by file.
 *
 * Everything is sealed on the machine with the space key, which the server never sees: a file's
 * path and its bytes go in one AES-256-GCM box, and the server knows it only by a keyed hash of the
 * path. The server sees how many files there are, their sizes and when they change.
 *
 * The join code carries the server, the space, its token and the key. Anyone with it can read and
 * write the space, so it is passed between one's own machines by hand.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { homeDir, readConfig } from "./store.js";
import { findConflicts, folderPeers, type SyncAdapter } from "./sync.js";

export interface RelayConfig {
  url: string;
  space: string;
  token: string;
  /** the space key, base64url; never sent to the server */
  key: string;
}

const CODE_PREFIX = "pwr1.";
/** Files bigger than this stay on their machine (a long screen recording, say). */
export const MIRROR_MAX_FILE = 200 * 1024 * 1024;

// ------------------------------------------------------------------ sealing

interface Keys {
  enc: Buffer;
  name: Buffer;
}

function keysOf(key: string): Keys {
  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 32) throw new UserError("the relay key is not 32 bytes; join again with a fresh code");
  const derive = (info: string) => Buffer.from(crypto.hkdfSync("sha256", raw, Buffer.alloc(0), info, 32));
  return { enc: derive("parawatch relay seal v1"), name: derive("parawatch relay name v1") };
}

/** The name the server knows a path by. */
export function sealedName(keys: Keys, rel: string): string {
  return crypto.createHmac("sha256", keys.name).update(rel).digest("hex").slice(0, 40);
}

/** One box: version, nonce, tag, then the path and the bytes, encrypted together. */
export function seal(keys: Keys, rel: string, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keys.enc, iv);
  const p = Buffer.from(rel, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(p.length);
  const body = Buffer.concat([c.update(len), c.update(p), c.update(data), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
}

export function open(keys: Keys, box: Buffer): { rel: string; data: Buffer } {
  if (box.length < 29 || box[0] !== 1) throw new Error("not a sealed parawatch file");
  const d = crypto.createDecipheriv("aes-256-gcm", keys.enc, box.subarray(1, 13));
  d.setAuthTag(box.subarray(13, 29));
  const plain = Buffer.concat([d.update(box.subarray(29)), d.final()]);
  const n = plain.readUInt32BE(0);
  return { rel: plain.subarray(4, 4 + n).toString("utf8"), data: plain.subarray(4 + n) };
}

export function newKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ------------------------------------------------------------------ join codes

export function joinCode(c: RelayConfig): string {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ u: c.url, s: c.space, t: c.token, k: c.key })).toString("base64url");
}

export function readJoinCode(code: string): RelayConfig {
  const t = code.trim();
  if (!t.startsWith(CODE_PREFIX)) throw new UserError("that is not a parawatch relay code (it starts with pwr1.)");
  try {
    const o = JSON.parse(Buffer.from(t.slice(CODE_PREFIX.length), "base64url").toString("utf8")) as { u: string; s: string; t: string; k: string };
    if (typeof o.u !== "string" || typeof o.s !== "string" || typeof o.t !== "string" || typeof o.k !== "string") throw new Error("missing parts");
    keysOf(o.k);
    return { url: o.u.replace(/\/+$/, ""), space: o.s, token: o.t, key: o.k };
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError("that relay code is cut short or changed; copy it again");
  }
}

/** The relay this machine uses, from config.json, when its sync adapter is the relay. */
export function relayConfig(): RelayConfig | undefined {
  const s = readConfig().sync;
  if (s?.adapter !== "relay") return undefined;
  const r = s.relay as Partial<RelayConfig> | undefined;
  return r && r.url && r.space && r.token && r.key ? (r as RelayConfig) : undefined;
}

// ------------------------------------------------------------------ the server's API

export interface Change {
  name: string;
  seq: number;
  size?: number;
  deleted?: boolean;
}

export class RelayClient {
  constructor(
    private c: Pick<RelayConfig, "url" | "space" | "token">,
    private f: typeof fetch = fetch,
  ) {}

  private base(): string {
    return `${this.c.url}/v1/spaces/${this.c.space}`;
  }

  private async call(pathname: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const res = await this.f(`${this.base()}${pathname}`, { ...init, signal, headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.c.token}` } });
    if (!res.ok) {
      let why = `${res.status}`;
      try {
        why = ((await res.json()) as { error?: string }).error ?? why;
      } catch {
        // not JSON
      }
      throw new Error(`relay ${init.method ?? "GET"} ${pathname.split("/")[1]}: ${why}`);
    }
    return res;
  }

  async changes(after: number, wait = 0, signal?: AbortSignal): Promise<{ head: number; changes: Change[] }> {
    return (await (await this.call(`/changes?after=${after}&wait=${wait}`, {}, signal)).json()) as { head: number; changes: Change[] };
  }

  async get(name: string): Promise<Buffer> {
    return Buffer.from(await (await this.call(`/files/${name}`)).arrayBuffer());
  }

  async put(name: string, body: Buffer): Promise<number> {
    return ((await (await this.call(`/files/${name}`, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": "application/octet-stream" } })).json()) as { seq: number }).seq;
  }

  async remove(name: string): Promise<number> {
    return ((await (await this.call(`/files/${name}`, { method: "DELETE" })).json()) as { seq: number }).seq;
  }

  static async createSpace(url: string, invite: string, f: typeof fetch = fetch): Promise<{ space: string; token: string }> {
    const res = await f(`${url.replace(/\/+$/, "")}/v1/spaces`, { method: "POST", headers: { authorization: `Bearer ${invite}` } });
    if (!res.ok) {
      let why = `${res.status}`;
      try {
        why = ((await res.json()) as { error?: string }).error ?? why;
      } catch {
        // not JSON
      }
      throw new UserError(`the relay would not make a space: ${why}`);
    }
    return (await res.json()) as { space: string; token: string };
  }
}

// ------------------------------------------------------------------ the mirror

interface Known {
  /** what this machine last had for the path, sha256 of the plain bytes */
  hash: string;
  size: number;
  mtime: number;
}

export interface MirrorState {
  v: 1;
  space: string;
  /** the last change of the server seen here */
  cursor: number;
  files: Record<string, Known>;
  lastOk?: string;
  error?: string;
  /** files changed here and not yet on the server */
  pending?: number;
  skipped?: string[];
}

export function mirrorStatePath(): string {
  return path.join(homeDir(), "relay-state.json");
}

export function readMirrorState(space: string, file = mirrorStatePath()): MirrorState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as MirrorState;
    if (s.v === 1 && s.space === space && s.files) return s;
  } catch {
    // none yet
  }
  return { v: 1, space, cursor: 0, files: {} };
}

/** Files the mirror leaves alone: hidden and temporary files, and copies a sync tool made. */
function ignored(rel: string): boolean {
  return rel.split("/").some((p) => p.startsWith(".") || p.endsWith(".tmp") || /\.sync-conflict-/.test(p) || p === "~syncthing~");
}

/** Is `rel` a safe relative path inside the folder? A sealed file names its own path. */
function safeRel(rel: string): boolean {
  return !!rel && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel) && !rel.split("/").some((p) => p === ".." || p === "" || p === ".") && !rel.includes("\\");
}

const hashOf = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

export interface MirrorOptions {
  dir: string;
  config: RelayConfig;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** where the mirror remembers what it has seen; the home folder's relay-state.json by default */
  stateFile?: string;
}

export class RelayMirror {
  private keys: Keys;
  private client: RelayClient;
  private state: MirrorState;
  private names = new Map<string, string>();
  private stopped = false;
  private abort?: AbortController;
  private pushing = false;

  constructor(private o: MirrorOptions) {
    this.keys = keysOf(o.config.key);
    this.client = new RelayClient(o.config, o.fetch);
    this.state = readMirrorState(o.config.space, o.stateFile);
    for (const rel of Object.keys(this.state.files)) this.names.set(sealedName(this.keys, rel), rel);
  }

  private save(): void {
    try {
      const file = this.o.stateFile ?? mirrorStatePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.state) + "\n");
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      // kept in memory; the next save writes it
    }
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  /** Every file in the folder, as relative paths with forward slashes. */
  private scan(): Map<string, { size: number; mtime: number }> {
    const out = new Map<string, { size: number; mtime: number }>();
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (ignored(r)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, r);
        else if (e.isFile()) {
          try {
            const st = fs.statSync(p);
            out.set(r, { size: st.size, mtime: st.mtimeMs });
          } catch {
            // gone meanwhile
          }
        }
      }
    };
    walk(this.o.dir, "");
    return out;
  }

  /** Bring down what changed on the server since the last look; `wait` holds until something does. */
  async pull(wait = 0): Promise<number> {
    this.abort = new AbortController();
    const { head, changes } = await this.client.changes(this.state.cursor, wait, this.abort.signal);
    let n = 0;
    for (const ch of changes) {
      const known = this.names.get(ch.name);
      if (ch.deleted) {
        if (known) {
          const p = path.join(this.o.dir, ...known.split("/"));
          const k = this.state.files[known];
          // only a file this machine has not changed since goes away
          try {
            const buf = fs.readFileSync(p);
            if (k && hashOf(buf) === k.hash) fs.rmSync(p, { force: true });
          } catch {
            // already gone
          }
          delete this.state.files[known];
          this.names.delete(ch.name);
          n++;
        }
        continue;
      }
      if ((ch.size ?? 0) > MIRROR_MAX_FILE + 1024) continue;
      let rel: string;
      let data: Buffer;
      try {
        ({ rel, data } = open(this.keys, await this.client.get(ch.name)));
      } catch (err) {
        this.log(`could not open a file from the relay: ${(err as Error).message}`);
        continue;
      }
      if (!safeRel(rel) || ignored(rel) || sealedName(this.keys, rel) !== ch.name) {
        this.log(`left out a file with a path it may not have: ${JSON.stringify(rel)}`);
        continue;
      }
      const p = path.join(this.o.dir, ...rel.split("/"));
      const hash = hashOf(data);
      const k = this.state.files[rel];
      let here: Buffer | undefined;
      try {
        here = fs.readFileSync(p);
      } catch {
        // not here yet
      }
      const hereHash = here ? hashOf(here) : undefined;
      // a change made here that has not gone up yet wins; it goes up on the next push
      if (here && k && hereHash !== k.hash && hereHash !== hash) continue;
      if (hereHash !== hash) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = path.join(path.dirname(p), `.${path.basename(p)}.relay.tmp`);
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, p);
        n++;
      }
      const st = fs.statSync(p);
      this.state.files[rel] = { hash, size: st.size, mtime: st.mtimeMs };
      this.names.set(ch.name, rel);
    }
    this.state.cursor = head;
    this.state.lastOk = new Date().toISOString();
    this.state.error = undefined;
    this.save();
    return n;
  }

  /** Send up what changed here since the last look. */
  async push(): Promise<number> {
    if (this.pushing) return 0;
    this.pushing = true;
    try {
      if (!fs.existsSync(this.o.dir)) throw new Error(`the shared folder ${this.o.dir} is not there`);
      const seen = this.scan();
      let n = 0;
      let pending = 0;
      const skipped: string[] = [];
      for (const [rel, st] of seen) {
        const k = this.state.files[rel];
        if (k && k.size === st.size && k.mtime === st.mtime) continue;
        if (st.size > MIRROR_MAX_FILE) {
          skipped.push(rel);
          continue;
        }
        let data: Buffer;
        try {
          data = fs.readFileSync(path.join(this.o.dir, ...rel.split("/")));
        } catch {
          continue;
        }
        const hash = hashOf(data);
        if (k && k.hash === hash) {
          this.state.files[rel] = { ...k, size: st.size, mtime: st.mtime };
          continue;
        }
        pending++;
        const name = sealedName(this.keys, rel);
        await this.client.put(name, seal(this.keys, rel, data));
        this.state.files[rel] = { hash, size: st.size, mtime: st.mtime };
        this.names.set(name, rel);
        pending--;
        n++;
      }
      // a folder that reads as empty while files were here is more likely unmounted than emptied
      const vanished = Object.keys(this.state.files).filter((rel) => !seen.has(rel) && !ignored(rel));
      if (vanished.length && !seen.size) throw new Error(`the shared folder ${this.o.dir} reads as empty; nothing was deleted on the relay`);
      for (const rel of vanished) {
        const name = sealedName(this.keys, rel);
        await this.client.remove(name);
        delete this.state.files[rel];
        this.names.delete(name);
        n++;
      }
      this.state.pending = pending;
      this.state.skipped = skipped.length ? skipped.slice(0, 20) : undefined;
      if (n) this.save();
      return n;
    } finally {
      this.pushing = false;
    }
  }

  /** Pull first so a machine joining late takes what is there instead of sending it back. */
  async once(): Promise<{ pulled: number; pushed: number }> {
    const pulled = await this.pull(0);
    const pushed = await this.push();
    return { pulled, pushed };
  }

  /** Keep the folder in step until stopped: a held request for changes there, a look here every second. */
  async run(): Promise<void> {
    let backoff = 1000;
    const pushLoop = async () => {
      while (!this.stopped) {
        try {
          await this.push();
        } catch (err) {
          this.fail(err);
        }
        await sleep(1000);
      }
    };
    try {
      await this.pull(0);
    } catch (err) {
      this.fail(err);
    }
    void pushLoop();
    while (!this.stopped) {
      try {
        await this.pull(25);
        backoff = 1000;
      } catch (err) {
        if (this.stopped) break;
        this.fail(err);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private fail(err: unknown): void {
    const msg = (err as Error).message ?? String(err);
    if (this.state.error !== msg) this.log(`relay: ${msg}`);
    this.state.error = msg;
    this.save();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only one mirror per machine: the app and `parawatch relay run` would otherwise race. */
export function takeMirrorLock(): (() => void) | undefined {
  const file = path.join(homeDir(), "relay.pid");
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return undefined;
      }
    }
  } catch {
    // no lock
  }
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.rmSync(file, { force: true });
    } catch {
      // gone
    }
  };
}

// ------------------------------------------------------------------ status

/** How the mirror is doing, for `parawatch sync`, `doctor` and the app. */
export const relayAdapter: SyncAdapter = {
  name: "relay",
  about: "a parawatch relay server, sealed end to end",
  async status(ctx) {
    const c = relayConfig();
    const peers = folderPeers(ctx.dir, ctx.device);
    if (!c) return { adapter: "relay", dir: ctx.dir, device: ctx.device, ok: false, peers, conflicts: [], error: "no relay is set up: run `parawatch relay setup` or `parawatch relay join`" };
    const st = readMirrorState(c.space);
    let reachable = true;
    let error = st.error;
    try {
      const res = await (ctx.fetch ?? fetch)(`${c.url}/healthz`, { signal: AbortSignal.timeout(ctx.timeoutMs ?? 3000) });
      reachable = res.ok;
    } catch (err) {
      reachable = false;
      error = `cannot reach ${c.url}: ${(err as Error).message}`;
    }
    const fresh = !!st.lastOk && Date.now() - Date.parse(st.lastOk) < 2 * 60_000;
    return {
      adapter: "relay",
      dir: ctx.dir,
      device: ctx.device,
      ok: reachable && fresh && !st.error,
      lastSync: st.lastOk,
      peers,
      conflicts: findConflicts(ctx.dir),
      ...(st.pending ? { pending: st.pending } : {}),
      ...(error ? { error } : !fresh ? { error: "nothing is keeping the folder in step: open the app, or run `parawatch relay run`" } : {}),
    };
  },
};
