import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Backend, PwEvent, Reply, Snapshot } from "./types";

const HOME = os.homedir();

/** Where a GUI app finds node and parawatch: apps started from the Dock do not get the shell's PATH. */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".volta/bin"), path.join(HOME, ".npm-global/bin"), path.join(HOME, ".local/bin"), path.join(HOME, ".bun/bin")];

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

function expand(p: string): string {
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

/** Same rule as the CLI: $PARAWATCH_HOME, else $XDG_STATE_HOME/parawatch, else ~/.local/state/parawatch. */
export function parawatchHome(): string {
  if (process.env.PARAWATCH_HOME) return process.env.PARAWATCH_HOME;
  return path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "parawatch");
}

export interface CliOptions {
  /** Path to the parawatch binary; empty means look for it. */
  binary: () => string;
  sinceHours: () => number;
}

export class CliBackend implements Backend {
  private urls = new Map<string, string>();

  constructor(private opts: CliOptions) {}

  bin(): string {
    const set = this.opts.binary().trim();
    if (set) return expand(set);
    for (const dir of EXTRA_PATH) {
      const p = path.join(dir, "parawatch");
      if (fs.existsSync(p)) return p;
    }
    return "parawatch";
  }

  private env(): NodeJS.ProcessEnv {
    const bin = this.bin();
    const dirs = [...(bin.includes("/") ? [path.dirname(bin)] : []), ...EXTRA_PATH, process.env.PATH ?? ""];
    // the plugin shows cards itself, so the CLI should not also post desktop notifications
    return { ...process.env, PATH: dirs.filter(Boolean).join(":"), PARAWATCH_NOTIFY: "0" };
  }

  run(args: string[], timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.bin(), args, { env: this.env(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      });
    });
  }

  async snapshot(): Promise<Snapshot> {
    return JSON.parse(await this.run(["status", "--json", "--since", String(this.opts.sinceHours())])) as Snapshot;
  }

  async answer(card: string, reply: Reply): Promise<void> {
    const args = ["answer", card];
    if (reply.choice !== undefined) args.push("--choice", String(reply.choice));
    if (reply.comment) args.push("--comment", reply.comment);
    for (const a of reply.attach ?? []) args.push("--attach", a);
    await this.run(args);
  }

  open(target: string): void {
    const electron = loadElectron();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      if (electron?.shell) void electron.shell.openExternal(target);
      else window.open(target);
      return;
    }
    if (electron?.shell) {
      void electron.shell.openPath(expand(target));
      return;
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [expand(target)], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  }

  async mediaUrl(file: string): Promise<string | undefined> {
    const p = expand(file);
    const cached = this.urls.get(p);
    if (cached) return cached;
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > MAX_MEDIA_BYTES) return undefined;
      const buf = await fs.promises.readFile(p);
      const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: mimeOf(p) }));
      this.urls.set(p, url);
      return url;
    } catch {
      return undefined;
    }
  }

  async saveAttachment(data: ArrayBuffer, ext: string): Promise<string> {
    const dir = path.join(parawatchHome(), "attachments");
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `pasted-${stamp}.${ext.replace(/[^a-z0-9]/gi, "") || "png"}`);
    await fs.promises.writeFile(file, new Uint8Array(data));
    return file;
  }

  droppedPath(file: File): string | undefined {
    const electron = loadElectron();
    const viaUtils = electron?.webUtils?.getPathForFile?.(file);
    if (viaUtils) return viaUtils;
    return (file as File & { path?: string }).path || undefined;
  }

  /** Stream new events; restarts the child if it exits. Returns a stop function. */
  watch(onEvent: (e: PwEvent) => void, onError: (message: string) => void): () => void {
    let child: ChildProcess | undefined;
    let stopped = false;
    let timer: number | undefined;
    const start = () => {
      if (stopped) return;
      let buf = "";
      let stderr = "";
      try {
        child = spawn(this.bin(), ["watch"], { env: this.env(), stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        onError(String(err));
        timer = window.setTimeout(start, 15_000);
        return;
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            onEvent(JSON.parse(line) as PwEvent);
          } catch {
            // not an event line
          }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (err) => onError(err.message));
      child.on("exit", () => {
        if (stopped) return;
        if (stderr.trim()) onError(stderr.trim());
        timer = window.setTimeout(start, 5_000);
      });
    };
    start();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      child?.kill();
    };
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

interface ElectronLike {
  shell?: { openPath(p: string): Promise<string>; openExternal(url: string): Promise<void> };
  webUtils?: { getPathForFile?(f: File): string };
}

function loadElectron(): ElectronLike | undefined {
  try {
    // provided by Obsidian's desktop runtime
    return (window as unknown as { require?: (m: string) => ElectronLike }).require?.("electron");
  } catch {
    return undefined;
  }
}

function mimeOf(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    heic: "image/heic",
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  return map[ext] ?? "application/octet-stream";
}
