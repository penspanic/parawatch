/**
 * The shared folder as a phone sees it through the relay. The phone keeps no copy of the folder:
 * it reads the few files that make the picture (every machine's log, runs, device and listener
 * files) and writes its own log, so an answer given here reaches the machines like one given on
 * another of them (docs/protocol.md).
 *
 * The server knows files only by a keyed hash of their path. The paths that matter are known from
 * the machines' names (`events/<device>.jsonl`, ...); the names themselves are found by opening the
 * small files once (a device file is a few hundred bytes), which also finds the listener files.
 */
import { mergeLogs, parseEventLines } from "../../../src/core/log.js";
import { fold, type State } from "../../../src/core/state.js";
import type { Card, Listener, PwEvent, Run, Snapshot } from "../../../src/core/types.js";
import { keysOf, open, seal, sealedName, type Keys, type RelayConfig } from "./seal";

/** Small enough to open just to learn its path: device and listener files are far smaller. */
const PROBE_MAX = 4096;
const RUNS_GONE_MS = 15 * 60_000;
const LISTENER_GONE_MS = 3 * 60_000;
const DEVICE_EVERY_MS = 10 * 60_000;
const WAIT_S = 25;
const CLOSED_KEPT = 30;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Where the phone keeps its few things: `localStorage` in the app, a map in tests. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Change {
  name: string;
  seq: number;
  size?: number;
  deleted?: boolean;
}

/** What a machine says about itself in `devices/<name>.json` (the parts read here). */
export interface DeviceFile {
  name: string;
  platform?: string;
  host?: string;
  home?: string;
  shared?: string;
  version?: string;
  at?: string;
}

interface Saved {
  v: 1;
  cursor: number;
  /** sealed name → path, for files opened once; "" for files left unread (pictures, mostly) */
  paths: Record<string, string>;
  /** this phone's own log, as last written */
  own: string;
  /** whether the own log still has to reach the server */
  ownPending?: boolean;
  host: string;
}

export interface SpaceOptions {
  config: RelayConfig;
  /** this phone's name in the folder */
  device: string;
  version: string;
  store: Store;
  fetch?: typeof fetch;
  now?: () => number;
}

class Api {
  constructor(
    private c: RelayConfig,
    private f: typeof fetch,
  ) {}

  private async call(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.f(`${this.c.url}/v1/spaces/${this.c.space}${pathname}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.c.token}` } });
    if (!res.ok) {
      let why = `${res.status}`;
      try {
        why = ((await res.json()) as { error?: string }).error ?? why;
      } catch {
        // not JSON
      }
      throw new Error(`relay: ${why}`);
    }
    return res;
  }

  async changes(after: number, wait: number, signal?: AbortSignal): Promise<{ head: number; changes: Change[] }> {
    return (await (await this.call(`/changes?after=${after}&wait=${wait}`, { signal })).json()) as { head: number; changes: Change[] };
  }

  async get(name: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.call(`/files/${name}`)).arrayBuffer());
  }

  async put(name: string, body: Uint8Array): Promise<void> {
    await this.call(`/files/${name}`, { method: "PUT", body: body as BodyInit, headers: { "content-type": "application/octet-stream" } });
  }
}

/** The log format this app writes (core/types.ts STORE_FORMAT). */
const STORE_FORMAT = 2;

/** The phone's name is taken in the folder: nothing is written until another is picked. */
export class NameTaken extends Error {}

const dec = new TextDecoder();
const enc = new TextEncoder();

export class Space {
  readonly device: string;
  private api: Api;
  private keys?: Keys;
  private saved: Saved;
  private key: string;
  private now: () => number;
  /** what the server holds now: sealed name → its last change */
  private server = new Map<string, Change>();
  /** text of the files read, by path */
  private text = new Map<string, string>();
  private nameOf = new Map<string, string>();
  private gen = 0;
  private abort?: AbortController;
  private listenersFns = new Set<() => void>();
  private deviceWritten = 0;
  private started = false;
  /** sends of the own log, one after another */
  private sending: Promise<void> = Promise.resolve();
  error?: string;
  lastOk?: number;

  constructor(private o: SpaceOptions) {
    if (!DEVICE.test(o.device)) throw new Error("A device name may only use a-z, 0-9 and -, up to 32 characters");
    this.device = o.device;
    this.api = new Api(o.config, o.fetch ?? fetch.bind(globalThis));
    this.now = o.now ?? Date.now;
    this.key = `pw.space.${o.config.space}.${o.device}`;
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(o.store.getItem(this.key) ?? "") as Saved;
    } catch {
      saved = undefined;
    }
    this.saved = saved && saved.v === 1 ? saved : { v: 1, cursor: 0, paths: {}, own: "", host: `web:${crypto.randomUUID()}` };
    this.text.set(this.ownPath(), this.saved.own);
  }

  private ownPath(): string {
    return `events/${this.device}.jsonl`;
  }

  /** Take the own log another tab of this app wrote meanwhile, when it is ours plus more. */
  private adoptStored(): void {
    try {
      const stored = JSON.parse(this.o.store.getItem(this.key) ?? "") as Saved;
      if (stored?.v === 1 && stored.own.length > this.saved.own.length && stored.own.startsWith(this.saved.own)) {
        this.saved.own = stored.own;
        this.saved.ownPending = this.saved.ownPending || stored.ownPending;
        this.text.set(this.ownPath(), this.saved.own);
      }
    } catch {
      // nothing stored yet
    }
  }

  private persist(): void {
    this.adoptStored();
    try {
      this.o.store.setItem(this.key, JSON.stringify(this.saved));
    } catch {
      // full; kept in memory
    }
  }

  /** Called whenever what the phone knows changes. */
  onChange(fn: () => void): () => void {
    this.listenersFns.add(fn);
    return () => this.listenersFns.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listenersFns) fn();
  }

  private async name(rel: string): Promise<string> {
    let n = this.nameOf.get(rel);
    if (!n) {
      n = await sealedName(this.keys!, rel);
      this.nameOf.set(rel, n);
    }
    return n;
  }

  /** The machines in the folder, from the paths known so far. */
  devices(): string[] {
    const out = new Set<string>([this.device]);
    for (const rel of Object.values(this.saved.paths)) {
      const m = /^(?:events\/([a-z0-9][a-z0-9-]*)\.jsonl|devices\/([a-z0-9][a-z0-9-]*)\.json|runs\/([a-z0-9][a-z0-9-]*)\.json)$/.exec(rel);
      const d = m?.[1] ?? m?.[2] ?? m?.[3];
      if (d) out.add(d);
    }
    return [...out].sort();
  }

  /** Whether a path is one this phone reads. */
  private wanted(rel: string): boolean {
    return /^(events\/[a-z0-9][a-z0-9-]*\.jsonl|devices\/[a-z0-9][a-z0-9-]*\.json|runs\/[a-z0-9][a-z0-9-]*\.json|listeners\/[a-z0-9][a-z0-9-]*\.json)$/.test(rel);
  }

  private async read(name: string): Promise<void> {
    const box = await this.api.get(name);
    const { rel, data } = await open(this.keys!, box);
    this.saved.paths[name] = rel;
    this.nameOf.set(rel, name);
    if (this.wanted(rel)) this.text.set(rel, dec.decode(data));
  }

  /** The path of a sealed name, when known: computed from a machine's name, or opened once. */
  private relOf(name: string): string | undefined {
    for (const [rel, n] of this.nameOf) if (n === name) return rel;
    return this.saved.paths[name];
  }

  /** Names for the files of every machine known now, so their logs are read without probing. */
  private async expect(): Promise<void> {
    for (const d of this.devices()) for (const rel of [`events/${d}.jsonl`, `runs/${d}.json`, `devices/${d}.json`]) await this.name(rel);
  }

  private async readAll(names: string[]): Promise<void> {
    // a few at a time: the first opening probes some dozens of small files
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(
        names.slice(i, i + 8).map((n) =>
          this.read(n).catch(() => {
            // gone meanwhile, or not ours to open; the next change of it tries again
          }),
        ),
      );
    }
  }

  /** Bring what the phone reads up to date with these changes of the server. */
  private async apply(changes: Change[]): Promise<boolean> {
    await this.expect();
    const fresh = new Set<string>();
    const probe: string[] = [];
    let any = false;
    for (const c of changes) {
      this.server.set(c.name, c);
      const rel = this.relOf(c.name);
      if (c.deleted) {
        if (rel && this.text.delete(rel)) any = true;
        // listener files come and go with every wait; forget them
        delete this.saved.paths[c.name];
        if (rel) this.nameOf.delete(rel);
        continue;
      }
      fresh.add(c.name);
      if (rel === undefined) {
        if ((c.size ?? Infinity) <= PROBE_MAX) probe.push(c.name);
        else this.saved.paths[c.name] = "";
      }
    }
    if (probe.length) {
      await this.readAll(probe);
      any = true;
      // a device found by probing names its log and runs, which may be big
      await this.expect();
    }
    const own = this.ownPath();
    const reads: string[] = [];
    for (const [rel, n] of this.nameOf) {
      const c = this.server.get(n);
      if (!c || c.deleted || !this.wanted(rel) || probe.includes(n)) continue;
      // the phone's own log is read back only when it has none (a fresh install), until it is
      if (rel === own) {
        if (!this.saved.own) reads.push(n);
        continue;
      }
      if (fresh.has(n) || !this.text.has(rel)) reads.push(n);
    }
    if (reads.length) {
      await this.readAll(reads);
      any = true;
    }
    if (!this.saved.own && this.text.get(own)) this.saved.own = this.text.get(own)!;
    return any;
  }

  /** The server holds a log of this phone that it has not read back yet: writing now would replace it. */
  private ownUnread(): boolean {
    const n = this.nameOf.get(this.ownPath());
    const c = n ? this.server.get(n) : undefined;
    return !!c && !c.deleted && !this.saved.own;
  }

  /** Read everything once: the whole list of the server, then the files that matter. */
  async start(): Promise<void> {
    this.keys = await keysOf(this.o.config.key);
    const { head, changes } = await this.api.changes(0, 0);
    // unknown and known alike: after a fresh list nothing from before is trusted to still be there
    this.server.clear();
    for (const rel of [...this.text.keys()]) if (rel !== this.ownPath()) this.text.delete(rel);
    // files read before are read again: their text is not kept between openings
    for (const [n, rel] of Object.entries(this.saved.paths)) if (rel) this.nameOf.set(rel, n);
    await this.apply(changes);
    if (this.ownUnread()) throw new Error("Could not read this phone's earlier answers; trying again");
    // a name another machine or browser writes under: writing here would overwrite its files
    const there = this.deviceFile(this.device);
    if (there && there.host !== this.saved.host) throw new NameTaken(`"${this.device}" is already the name of ${there.platform === "web" ? "another browser" : "a machine"} in this folder; pick another`);
    this.saved.cursor = head;
    this.lastOk = this.now();
    this.error = undefined;
    this.started = true;
    this.persist();
    await this.flush();
    await this.writeDevice();
    this.changed();
  }

  /** Follow the server until stopped. Starting again stops the loop before. */
  async run(): Promise<void> {
    const gen = ++this.gen;
    this.abort?.abort();
    const live = () => this.gen === gen;
    while (live()) {
      try {
        if (!this.started) {
          await this.start();
          continue;
        }
        const abort = (this.abort = new AbortController());
        const { head, changes } = await this.api.changes(this.saved.cursor, WAIT_S, abort.signal);
        if (!live()) break;
        const any = await this.apply(changes);
        this.saved.cursor = Math.max(this.saved.cursor, head);
        this.lastOk = this.now();
        const hadError = !!this.error;
        this.error = undefined;
        this.persist();
        await this.flush();
        if (this.now() - this.deviceWritten > DEVICE_EVERY_MS) await this.writeDevice();
        if (any || hadError) this.changed();
      } catch (err) {
        if (!live()) break;
        this.error = err instanceof Error ? err.message : String(err);
        if (err instanceof NameTaken) {
          this.changed();
          break;
        }
        this.changed();
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.gen++;
    this.abort?.abort();
  }

  // ---------------------------------------------------------------- writing

  private async writeDevice(): Promise<void> {
    const body: DeviceFile = { name: this.device, platform: "web", host: this.saved.host, home: "", shared: "", version: this.o.version, at: new Date(this.now()).toISOString() };
    await this.putFile(`devices/${this.device}.json`, JSON.stringify(body) + "\n");
    this.deviceWritten = this.now();
  }

  private async putFile(rel: string, text: string): Promise<void> {
    const box = await seal(this.keys!, rel, enc.encode(text));
    const n = await this.name(rel);
    await this.api.put(n, box);
    this.saved.paths[n] = rel;
  }

  /** Send the own log if it has not reached the server, one send at a time. */
  private flush(): Promise<void> {
    const next = this.sending.then(async () => {
      if (!this.saved.ownPending || !this.started) return;
      const text = this.saved.own;
      await this.putFile(this.ownPath(), text);
      // a later event went in meanwhile: it is sent by the next flush
      if (this.saved.own === text) this.saved.ownPending = false;
      this.persist();
    });
    this.sending = next.catch(() => {});
    return next;
  }

  /** When an event about this card may be stamped: after everything already said about it. */
  private stamp(card: unknown): string {
    let ts = new Date(this.now()).toISOString();
    if (typeof card !== "string") return ts;
    for (const e of this.events()) {
      const about = e.type === "card.open" ? e.card.id : "card" in e ? (e as { card: unknown }).card : undefined;
      // a phone clock behind the machines' would sort the answer before the card
      if (about === card && e.ts >= ts) ts = new Date(Date.parse(e.ts) + 1).toISOString();
    }
    return ts;
  }

  /**
   * Append one event to this phone's log and send it. When the relay cannot be reached it stays
   * here and goes out with the next round; the answer counts as given.
   */
  async append(body: Record<string, unknown> & { type: string }): Promise<void> {
    if (!this.started || this.ownUnread()) throw new Error("Still reading this phone's earlier answers; try again in a moment");
    if (this.events().some((e) => typeof e.v === "number" && e.v > STORE_FORMAT)) throw new Error("A newer Parawatch wrote to this folder; reload this page to update it");
    this.adoptStored();
    const own = parseEventLines(this.saved.own);
    const seq = (own[own.length - 1]?.seq ?? 0) + 1;
    const ev = { v: STORE_FORMAT, seq, ts: this.stamp(body.card), ...body };
    this.saved.own += JSON.stringify(ev) + "\n";
    this.saved.ownPending = true;
    this.text.set(this.ownPath(), this.saved.own);
    this.persist();
    this.changed();
    try {
      await this.flush();
    } catch (err) {
      this.error = `Not sent yet: ${err instanceof Error ? err.message : String(err)}`;
      this.changed();
    }
  }

  // ---------------------------------------------------------------- reading

  events(): PwEvent[] {
    const lists: PwEvent[][] = [];
    for (const d of this.devices()) {
      const t = this.text.get(`events/${d}.jsonl`);
      if (t) lists.push(parseEventLines(t, d));
    }
    return lists.length > 1 ? mergeLogs(lists) : (lists[0] ?? []);
  }

  state(): State {
    return fold(this.events());
  }

  deviceFile(name: string): DeviceFile | undefined {
    try {
      return JSON.parse(this.text.get(`devices/${name}.json`) ?? "") as DeviceFile;
    } catch {
      return undefined;
    }
  }

  private json<T>(rel: string): T | undefined {
    try {
      return JSON.parse(this.text.get(rel) ?? "") as T;
    } catch {
      return undefined;
    }
  }

  snapshot(): Snapshot {
    const now = this.now();
    const state = this.state();
    const all = [...state.cards.values()];
    const closed = all
      .filter((c) => c.status === "closed")
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
      .slice(0, CLOSED_KEPT);
    const cards: Card[] = [...all.filter((c) => c.status !== "closed"), ...closed].map((c) => {
      const missing = [...(c.attach ?? []), ...(c.open ?? [])].filter((f) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(f) && !this.reachable(f, c.dev));
      return missing.length ? { ...c, missing } : c;
    });
    const runs: Run[] = [];
    for (const d of this.devices()) {
      if (d === this.device) continue;
      const s = this.json<{ at: string; runs: Run[] }>(`runs/${d}.json`);
      const at = s ? Date.parse(s.at) : NaN;
      if (!s || !Number.isFinite(at) || now - at > RUNS_GONE_MS || !Array.isArray(s.runs)) continue;
      const shift = Math.max(0, Math.floor((now - at) / 60_000));
      for (const r of s.runs) runs.push({ ...r, device: d, activity: r.activity?.map((x) => x + shift).filter((x) => x < 60) });
    }
    const listeners: Listener[] = [];
    for (const rel of this.text.keys()) {
      if (!rel.startsWith("listeners/")) continue;
      const l = this.json<Listener>(rel);
      if (l?.beat && now - Date.parse(l.beat) < LISTENER_GONE_MS) listeners.push(l);
    }
    return {
      v: 1,
      generatedAt: new Date(now).toISOString(),
      projects: [...state.projects.values()],
      cards,
      runs: withoutHidden(runs, state),
      listeners,
      devices: { me: this.device, others: this.devices().filter((d) => d !== this.device && this.text.has(`events/${d}.jsonl`)) },
    };
  }

  // ---------------------------------------------------------------- files cards carry

  /** A file of a card as a path in the shared folder, when it is in there. */
  sharedPath(file: string, dev?: string): string | undefined {
    const norm = file.replace(/\\/g, "/");
    const candidates = dev ? [dev, ...this.devices().filter((d) => d !== dev)] : this.devices();
    for (const d of candidates) {
      const shared = this.deviceFile(d)?.shared?.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!shared) continue;
      if (norm.toLowerCase().startsWith(shared.toLowerCase() + "/")) return norm.slice(shared.length + 1);
    }
    return undefined;
  }

  private reachable(file: string, dev?: string): boolean {
    const rel = this.sharedPath(file, dev);
    if (!rel) return false;
    const n = this.nameOf.get(rel);
    // its name is computed only when asked for; until then, assume it is there
    return n ? this.server.has(n) && !this.server.get(n)!.deleted : true;
  }

  /** The bytes of a file in the shared folder, opened here. */
  async fileBytes(rel: string): Promise<Uint8Array | undefined> {
    const n = await this.name(rel);
    const c = this.server.get(n);
    if (!c || c.deleted) return undefined;
    const { data } = await open(this.keys!, await this.api.get(n));
    return data;
  }
}

/** Leave out runs the human hid, until they do something new (core/runs.ts withoutHidden). */
function withoutHidden(runs: Run[], state: State): Run[] {
  if (!state.hidden.size) return runs;
  const byId = new Map(runs.map((r) => [r.id, r]));
  const hiddenAt = (r: Run, seen = new Set<string>()): number | undefined => {
    seen.add(r.id);
    const own = state.hidden.get(r.id);
    const at = own !== undefined ? Date.parse(own) : r.parent && !seen.has(r.parent) && byId.has(r.parent) ? hiddenAt(byId.get(r.parent)!, seen) : undefined;
    return at !== undefined && Number.isFinite(at) ? at : undefined;
  };
  return runs.filter((r) => {
    const at = hiddenAt(r);
    if (at === undefined) return true;
    return r.lastActivity ? Date.parse(r.lastActivity) > at : false;
  });
}
