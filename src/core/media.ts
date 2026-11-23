/**
 * How a card's attachments are shown: a caption on each, which choice a picture belongs to, which
 * pictures are one comparison (before and after, on and off, A and B), and a grid. Everything
 * points at attachments by their place in `attach`, not by path, because a path is mapped to each
 * machine's own folders while its place stays the same. A copy that does not know `media` shows the
 * attachments as before.
 */
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import type { CardMedia } from "./types.js";

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;
export const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const MAX_GRID = 6;
const MAX_CAPTION = 80;

export interface AttachSpec {
  file: string;
  caption?: string;
}

/** A path as a person or an agent writes one: absolute on either system, home-relative, relative or a URL. */
function looksLikePath(s: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ||
    path.posix.isAbsolute(s) ||
    path.win32.isAbsolute(s) ||
    /^~[\\/]/.test(s) ||
    /^\.\.?[\\/]/.test(s) ||
    fs.existsSync(s)
  );
}

/**
 * One `--attach` value: a file, or `caption=file`. A value that is itself a file that exists is a
 * file even when it holds a `=`, and the split is at the first `=` whose right side is a path.
 */
export function parseAttach(spec: string): AttachSpec {
  const s = spec.trim();
  if (!s.includes("=") || fs.existsSync(s)) return { file: s };
  let at = s.indexOf("=");
  while (at > 0) {
    const caption = s.slice(0, at).trim();
    const file = s.slice(at + 1).trim();
    if (caption && file && looksLikePath(file)) return { file, caption: caption.slice(0, MAX_CAPTION) };
    at = s.indexOf("=", at + 1);
  }
  return { file: s };
}

export interface MediaFlags {
  /** `--compare`: attachments shown as one comparison, by caption, file name or 1-based place */
  compare?: string[];
  /** `--option-attach`: `<choice>=<attachments>` */
  optionAttach?: string[];
  /** `--grid`: columns */
  grid?: number;
}

/** Finds one attachment by its 1-based place, its caption or its file name; fails with the names it knows. */
function resolveRef(ref: string, specs: AttachSpec[], flag: string): number {
  const r = ref.trim();
  if (/^\d+$/.test(r)) {
    const n = Number(r);
    if (n >= 1 && n <= specs.length) return n - 1;
  }
  const lower = r.toLowerCase();
  let i = specs.findIndex((s) => s.caption?.toLowerCase() === lower);
  if (i < 0) i = specs.findIndex((s) => path.basename(s.file.replace(/\\/g, "/")).toLowerCase() === lower);
  if (i >= 0) return i;
  const known = specs.map((s, k) => `${k + 1}${s.caption ? ` (${s.caption})` : ""}`).join(", ");
  throw new UserError(`${flag}: no attachment "${r}". Name one by its place, its caption or its file name: ${known || "there are no attachments"}`);
}

function refList(v: string, specs: AttachSpec[], flag: string): number[] {
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => resolveRef(x, specs, flag));
}

/**
 * The stored layout for attachments given as `specs`, or undefined when there is nothing beyond
 * the files. `options` is how many choices the card has.
 */
export function buildMedia(specs: AttachSpec[], flags: MediaFlags, options: number): CardMedia | undefined {
  const media: CardMedia = {};
  if (specs.some((s) => s.caption)) media.captions = specs.map((s) => s.caption ?? null);

  if (flags.compare?.length) {
    const used = new Set<number>();
    media.compare = flags.compare.map((v) => {
      const group = [...new Set(refList(v, specs, "--compare"))];
      if (group.length < 2) throw new UserError(`--compare needs two or more attachments, like --compare "before,after"; got "${v}"`);
      for (const i of group) {
        if (used.has(i)) throw new UserError(`--compare: attachment ${i + 1} is in two comparisons`);
        used.add(i);
      }
      return group;
    });
  }

  if (flags.optionAttach?.length) {
    if (!options) throw new UserError("--option-attach needs choices (-o)");
    const of: (number | null)[] = specs.map(() => null);
    for (const v of flags.optionAttach) {
      const m = /^\s*(\d+)\s*=\s*(.+)$/.exec(v);
      if (!m) throw new UserError(`--option-attach takes <choice>=<attachments>, like --option-attach "2=after"; got "${v}"`);
      const n = Number(m[1]);
      if (n < 1 || n > options) throw new UserError(`--option-attach: choice ${n} is not between 1 and ${options}`);
      for (const i of refList(m[2]!, specs, "--option-attach")) of[i] = n;
    }
    media.options = of;
  }

  if (flags.grid !== undefined) {
    if (!Number.isInteger(flags.grid) || flags.grid < 1 || flags.grid > MAX_GRID) throw new UserError(`--grid takes a number of columns from 1 to ${MAX_GRID}`);
    if (!specs.length) throw new UserError("--grid needs attachments");
    media.grid = flags.grid;
  }
  return Object.keys(media).length ? media : undefined;
}

/** True when `media` says something about the attachments. */
export function hasMedia(media: CardMedia | undefined): media is CardMedia {
  return !!media && !!(media.captions?.some((c) => c) || media.compare?.length || media.options?.some((o) => o) || media.grid);
}

/**
 * Words that point at a picture by its place ("the first picture", "left to right", "the top row"),
 * in English and Korean. A body that does this is easier to read with captions on the pictures.
 */
const POSITIONAL = new RegExp(
  [
    String.raw`\b(first|second|third|fourth|last)\s+(picture|image|shot|still|video|clip|sheet|attachment|one)\b`,
    String.raw`\b(left|right|top|bottom)\s+(to|row|column|one|half)\b`,
    String.raw`\bfrom (the )?(left|right|top)\b`,
    String.raw`\b(top|bottom|middle)\s+(row|line)\b`,
    "(첫|둘째|셋째|넷째|마지막|두 번째|세 번째)\\s?(그림|장|사진|영상|시트|첨부|스틸)",
    "(왼쪽|오른쪽|위|아래)\\s?(부터|에서부터)",
    "맨\\s?(왼쪽|오른쪽|위|아래)",
    "(줄|칸|열|행)은\\s",
  ].join("|"),
  "i",
);

export function pointsAtPlaces(body: string | undefined): boolean {
  return !!body && POSITIONAL.test(body);
}

/**
 * What an agent should hear after opening or editing a card, so the human can tell the pictures
 * apart without reading the body: printed on stderr, never blocking.
 */
export function mediaHints(card: { id: string; body?: string; attach?: string[]; options?: string[]; media?: CardMedia }): string[] {
  const shown = (card.attach ?? []).filter((f) => IMAGE_FILE.test(f) || VIDEO_FILE.test(f));
  const out: string[] = [];
  if (shown.length < 2) return out;
  const caps = card.media?.captions ?? [];
  const missing = (card.attach ?? []).filter((f, i) => (IMAGE_FILE.test(f) || VIDEO_FILE.test(f)) && !caps[i]).length;
  const places = pointsAtPlaces(card.body);
  if (missing || places) {
    const why = places ? "the body points at pictures by their place" : `${missing} of ${shown.length} pictures and videos have no caption`;
    out.push(
      `hint: ${why}. Name each one on the picture itself instead: ` +
        `parawatch edit ${card.id} --attach "Now=/abs/now.png" --attach "Ring only=/abs/ring.png" (see parawatch guide attachments)`,
    );
  }
  if (card.options?.length && !card.media?.options?.some((o) => o) && shown.length >= card.options.length) {
    out.push(`hint: if each choice has its own picture, tie them together so the picture shows beside its choice: --option-attach "1=Now" --option-attach "2=Ring only"`);
  }
  return out;
}

/** Captioned lines for the text views (`show`), one per attachment. */
export function attachLines(attach: string[] | undefined, media: CardMedia | undefined): string[] {
  return (attach ?? []).map((f, i) => {
    const tags: string[] = [];
    const cap = media?.captions?.[i];
    const opt = media?.options?.[i];
    const group = media?.compare?.findIndex((g) => g.includes(i)) ?? -1;
    if (opt) tags.push(`choice ${opt}`);
    if (group >= 0) tags.push(`compare ${group + 1}`);
    return `${cap ? `${cap}: ` : ""}${f}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
  });
}
