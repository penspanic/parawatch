/**
 * Serves a card's picture or video to the window, with byte ranges. A video asks for the part it
 * needs (`Range: bytes=…`) when the human moves the playhead; Electron's `net.fetch` of a file URL
 * answers with the whole file instead, so Chromium took the video as one it cannot seek in and
 * snapped back to where it was playing. Kept apart from Electron so it can be tested.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".heic": "image/heic",
};

export function mediaType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The bytes a `Range` header asks for in a file of `size` bytes: undefined for the whole file (no
 * header, or one this does not read), "unsatisfiable" when it starts past the end. Only the first
 * range of a list is served, which is all a video element asks for.
 */
export function byteRange(header: string | null | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = header ? /^bytes=\s*(\d*)\s*-\s*(\d*)/i.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    // the last n bytes
    const n = Number(m[2]);
    if (!n) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (end < start) return undefined;
  return { start, end };
}

/** The file as a response: the part asked for (206), or all of it (200), always saying ranges work. */
export async function mediaResponse(file: string, range: string | null | undefined): Promise<Response> {
  let size: number;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return new Response("not a file", { status: 404 });
    size = st.size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const type = mediaType(file);
  const r = byteRange(range, size);
  if (r === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
  const start = r?.start ?? 0;
  const end = r?.end ?? size - 1;
  const length = size ? end - start + 1 : 0;
  const body = length ? (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>) : null;
  const headers: Record<string, string> = { "Content-Type": type, "Content-Length": String(length), "Accept-Ranges": "bytes" };
  if (r) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: r ? 206 : 200, headers });
}
