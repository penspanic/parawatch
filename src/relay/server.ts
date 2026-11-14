/**
 * The relay: a small server that carries the shared folder between machines in place of a sync
 * tool. It keeps sealed files and hands out what changed. It never sees what is in them: every
 * machine seals a file and its path with a key the server is never given (see core/relay.ts).
 *
 * A space is the folder of one person (or one group). Each space has a token; anyone with it can
 * read and write the space's sealed files. Making a space needs the server's invite, so a public
 * server is not open to everyone.
 *
 *   POST   /v1/spaces                       invite → { space, token }
 *   GET    /v1/spaces/:space/changes?after=N&wait=S   { head, changes: [{ name, seq, size?, deleted? }] }
 *   PUT    /v1/spaces/:space/files/:name    the sealed bytes → { seq }
 *   GET    /v1/spaces/:space/files/:name    the sealed bytes
 *   DELETE /v1/spaces/:space/files/:name    → { seq }
 *   GET    /healthz
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const RELAY_MAX_FILE = 256 * 1024 * 1024;
const MAX_WAIT_S = 30;
const SPACE = /^[a-f0-9]{24}$/;
const NAME = /^[a-f0-9]{40}$/;

export interface RelayOptions {
  /** where spaces are kept */
  dataDir: string;
  /** what POST /v1/spaces needs as its bearer token; without it no space can be made */
  invite?: string;
  log?: (line: string) => void;
}

interface Entry {
  seq: number;
  size?: number;
  deleted?: boolean;
}

interface Space {
  id: string;
  dir: string;
  tokenHash: Buffer;
  head: number;
  files: Map<string, Entry>;
  journalLines: number;
  waiters: Set<() => void>;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

function sameSecret(given: string | undefined, hash: Buffer): boolean {
  if (!given) return false;
  return crypto.timingSafeEqual(sha(given), hash);
}

class Store {
  private spaces = new Map<string, Space>();
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  create(): { space: string; token: string } {
    const id = crypto.randomBytes(12).toString("hex");
    const token = crypto.randomBytes(32).toString("base64url");
    const dir = path.join(this.root, id);
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify({ v: 1, token: sha(token).toString("hex"), at: new Date().toISOString() }) + "\n");
    return { space: id, token };
  }

  open(id: string): Space | undefined {
    if (!SPACE.test(id)) return undefined;
    const had = this.spaces.get(id);
    if (had) return had;
    const dir = path.join(this.root, id);
    let meta: { token: string };
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "space.json"), "utf8"));
    } catch {
      return undefined;
    }
    const s: Space = { id, dir, tokenHash: Buffer.from(meta.token, "hex"), head: 0, files: new Map(), journalLines: 0, waiters: new Set() };
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8");
    } catch {
      // a new space
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Entry & { name: string };
        if (!NAME.test(e.name) || !Number.isInteger(e.seq)) continue;
        s.files.set(e.name, e.deleted ? { seq: e.seq, deleted: true } : { seq: e.seq, size: e.size });
        s.head = Math.max(s.head, e.seq);
        s.journalLines++;
      } catch {
        // a line cut short by a crash; the file it named is written again by its machine
      }
    }
    this.spaces.set(id, s);
    if (s.journalLines > 4 * s.files.size + 100) this.compact(s);
    return s;
  }

  private compact(s: Space): void {
    const lines = [...s.files].sort((a, b) => a[1].seq - b[1].seq).map(([name, e]) => JSON.stringify({ name, ...e }) + "\n");
    const tmp = path.join(s.dir, "journal.jsonl.tmp");
    fs.writeFileSync(tmp, lines.join(""));
    fs.renameSync(tmp, path.join(s.dir, "journal.jsonl"));
    s.journalLines = lines.length;
  }

  record(s: Space, name: string, e: Omit<Entry, "seq">): number {
    const seq = ++s.head;
    const entry: Entry = { seq, ...e };
    s.files.set(name, entry);
    fs.appendFileSync(path.join(s.dir, "journal.jsonl"), JSON.stringify({ name, ...entry }) + "\n");
    s.journalLines++;
    if (s.journalLines > 4 * s.files.size + 100) this.compact(s);
    for (const w of [...s.waiters]) w();
    return seq;
  }

  filePath(s: Space, name: string): string {
    return path.join(s.dir, "files", name);
  }

  changes(s: Space, after: number): { head: number; changes: ({ name: string } & Entry)[] } {
    const changes = [...s.files].filter(([, e]) => e.seq > after).map(([name, e]) => ({ name, ...e }));
    return { head: s.head, changes: changes.sort((a, b) => a.seq - b.seq) };
  }
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/** A relay server; call `.listen(port)` on it. */
export function createRelayServer(opts: RelayOptions): http.Server {
  const store = new Store(opts.dataDir);
  const log = opts.log ?? (() => {});
  const inviteHash = opts.invite ? sha(opts.invite) : undefined;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const parts = url.pathname.split("/").filter(Boolean);
    const fail = (status: number, error: string) => send(res, status, { error });
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (parts[0] !== "v1" || parts[1] !== "spaces") return fail(404, "not found");

      if (parts.length === 2 && req.method === "POST") {
        if (!inviteHash || !sameSecret(bearer(req), inviteHash)) return fail(403, "this server needs its invite to make a space");
        const made = store.create();
        log(`space ${made.space} made`);
        return send(res, 201, made);
      }

      const s = parts[2] ? store.open(parts[2]) : undefined;
      // an unknown space and a wrong token look the same from outside
      if (!s || !sameSecret(bearer(req), s.tokenHash)) return fail(401, "unknown space or wrong token");

      if (parts.length === 4 && parts[3] === "changes" && req.method === "GET") {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? 0) || 0));
        const now = store.changes(s, after);
        if (now.changes.length || !wait) return send(res, 200, now);
        // nothing new: hold the request until something changes or the wait runs out
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          s.waiters.delete(finish);
          if (!res.writableEnded) send(res, 200, store.changes(s, after));
        };
        const timer = setTimeout(finish, wait * 1000);
        s.waiters.add(finish);
        req.on("close", () => {
          done = true;
          clearTimeout(timer);
          s.waiters.delete(finish);
        });
        return;
      }

      if (parts.length === 5 && parts[3] === "files") {
        const name = parts[4]!;
        if (!NAME.test(name)) return fail(400, "bad file name");
        const file = store.filePath(s, name);
        if (req.method === "GET") {
          const e = s.files.get(name);
          if (!e || e.deleted) return fail(404, "no such file");
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-seq": String(e.seq) });
          fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
          return;
        }
        if (req.method === "DELETE") {
          fs.rmSync(file, { force: true });
          return send(res, 200, { seq: store.record(s, name, { deleted: true }) });
        }
        if (req.method === "PUT") {
          const declared = Number(req.headers["content-length"] ?? NaN);
          if (Number.isFinite(declared) && declared > RELAY_MAX_FILE) return fail(413, "file too large");
          const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
          const out = fs.createWriteStream(tmp);
          let size = 0;
          let tooBig = false;
          req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > RELAY_MAX_FILE && !tooBig) {
              tooBig = true;
              out.destroy();
              fs.rmSync(tmp, { force: true });
              fail(413, "file too large");
              req.destroy();
            }
          });
          req.pipe(out);
          out.on("finish", () => {
            if (tooBig) return;
            fs.renameSync(tmp, file);
            send(res, 200, { seq: store.record(s, name, { size }) });
          });
          out.on("error", () => {
            fs.rmSync(tmp, { force: true });
            if (!res.headersSent) fail(500, "could not store the file");
          });
          return;
        }
      }
      return fail(404, "not found");
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      if (!res.headersSent) fail(500, "server error");
    }
  });
}
