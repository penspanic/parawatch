import fs from "node:fs";

/** Read up to `bytes` from the start of a file, dropping a torn last line. */
export function readHeadLines(file: string, bytes: number): unknown[] {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const lines = text.split("\n");
    if (n === bytes) lines.pop();
    return parseLines(lines);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read up to `bytes` from the end of a file, dropping a torn first line. Agent logs can be hundreds of MB. */
export function readTailLines(file: string, bytes: number): unknown[] {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, "r");
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return parseLines(lines);
  } finally {
    fs.closeSync(fd);
  }
}

/** Raw text from the start of a file, for lines too long to parse whole (inline images). */
export function readHeadText(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Every JSON string value of a "text" key found in raw, possibly truncated, JSON text. */
export function textValues(raw: string): string[] {
  const out: string[] = [];
  const re = /"text":"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    try {
      out.push(JSON.parse(`"${m[1]}"`) as string);
    } catch {
      // malformed escape; skip
    }
  }
  return out;
}

function parseLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip partial or foreign lines
    }
  }
  return out;
}

export function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

export const ACTIVITY_MINUTES = 60;

/** Which of the last `window` minutes saw any of these times: minutes before now, ascending. */
export function activeMinutes(times: Iterable<number>, now: number, window = ACTIVITY_MINUTES): number[] {
  const set = new Set<number>();
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    const m = Math.floor((now - t) / 60_000);
    if (m >= 0 && m < window) set.add(m);
  }
  return [...set].sort((a, b) => a - b);
}

const STAMP = /"timestamp":"([^"]{10,40})"/g;

/** Every record timestamp in raw log text, in milliseconds. */
export function timestampsIn(text: string): number[] {
  const out: number[] = [];
  for (let m = STAMP.exec(text); m; m = STAMP.exec(text)) {
    const t = Date.parse(m[1]!);
    if (Number.isFinite(t)) out.push(t);
  }
  STAMP.lastIndex = 0;
  return out;
}

// How far back the first look at a log goes. Later looks read only what was appended since.
const FIRST_LOOK_BYTES = 16 * 1024 * 1024;
const seen = new Map<string, { offset: number; times: number[] }>();

/**
 * The active minutes of an append-only log. A long-running process (the desktop app) keeps what
 * it has read, so each refresh reads only the new end of the file.
 */
export function logActivity(file: string, now: number): number[] {
  const size = fs.statSync(file).size;
  let entry = seen.get(file);
  if (!entry || size < entry.offset) entry = { offset: Math.max(0, size - FIRST_LOOK_BYTES), times: [] };
  if (size > entry.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const len = size - entry.offset;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, entry.offset);
      const text = buf.subarray(0, n).toString("utf8");
      // stop at the last full line so a record being written is read next time
      const end = text.lastIndexOf("\n") + 1;
      entry.times.push(...timestampsIn(text.slice(0, end)));
      entry.offset += Buffer.byteLength(text.slice(0, end), "utf8");
    } finally {
      fs.closeSync(fd);
    }
  }
  const horizon = now - ACTIVITY_MINUTES * 60_000;
  entry.times = entry.times.filter((t) => t >= horizon);
  seen.set(file, entry);
  return activeMinutes(entry.times, now);
}
