import zlib from "node:zlib";

/**
 * The app draws its own pictures from code, so the repository holds no image files. The design is
 * three lanes (agents running side by side) with one dot lit (the one that needs you).
 *
 * - "app": the icon for Windows, Linux and the dock while developing. A packaged macOS build uses
 *   the Liquid Glass icon in icon/Parawatch.icon instead, which the system renders.
 * - "tray": the menu bar icon as a monochrome template, in any animation state. `drawTray` adds
 *   the count of cards waiting, as a number in an amber bubble.
 * - "overlay": a small red dot for the Windows taskbar.
 */

type Rgba = [number, number, number, number];

const RED: Rgba = [233, 49, 71, 255];
const TOP: Rgba = [51, 168, 148, 255];
const BOTTOM: Rgba = [3, 61, 64, 255];
const LANE: Rgba = [166, 242, 220, 255];
const DOT: Rgba = [138, 245, 207, 255];
const SIGNAL: Rgba = [255, 178, 58, 255];
const GLOW: Rgba = [255, 158, 44, 255];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Coverage from a signed distance (negative inside), with a one-pixel soft edge. */
const cover = (sd: number, px: number) => clamp01(0.5 - sd / px);

/** Signed distance to a horizontal capsule (a lane) between x1 and x2 at height y. */
function capsule(x: number, y: number, x1: number, x2: number, cy: number, r: number): number {
  const dx = x - Math.min(Math.max(x, x1), x2);
  return Math.hypot(dx, y - cy) - r;
}

function circle(x: number, y: number, cx: number, cy: number, r: number): number {
  return Math.hypot(x - cx, y - cy) - r;
}

/** Signed distance outside a rounded square of half-size h and corner radius r (negative inside). */
function roundedBox(x: number, y: number, h: number, r: number): number {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Paint `top` over `under` with coverage a. */
function over(under: Rgba, top: Rgba, a: number): Rgba {
  const ta = (top[3] / 255) * a;
  const ua = under[3] / 255;
  const oa = ta + ua * (1 - ta);
  if (oa === 0) return [0, 0, 0, 0];
  const mix = (i: number) => Math.round((top[i]! * ta + under[i]! * ua * (1 - ta)) / oa);
  return [mix(0), mix(1), mix(2), Math.round(oa * 255)];
}

function lerp(a: Rgba, b: Rgba, t: number): Rgba {
  return [0, 1, 2, 3].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgba;
}

// The lanes in icon units: a 1024 canvas, the same layout as the SVG layers of Parawatch.icon.
const LANES = [324, 512, 700];
const LANE_X1 = 270;
const LANE_X2 = 754;
const LANE_R = 74;

/** One pixel of the colour icon, in 1024 canvas units; px is one pixel in those units. */
function appPixel(u: number, v: number, px: number): Rgba {
  // the tile fills 84% of the canvas, like the system's own icons
  const tile = cover(roundedBox((u - 512) / 512, (v - 512) / 512, 0.84, 0.25) * 512, px);
  if (tile === 0) return [0, 0, 0, 0];
  const t = clamp01(((u - 512) * 0.45 + (v - 512)) / 1024 + 0.5);
  let c = lerp(TOP, BOTTOM, t);
  // content is drawn inside the tile: scale the 1024 layout down to the tile
  const s = 0.84;
  const x = (u - 512) / s + 512;
  const y = (v - 512) / s + 512;
  const q = px / s;
  for (const cy of LANES) c = over(c, LANE, 0.32 * cover(capsule(x, y, LANE_X1, LANE_X2, cy, LANE_R), q));
  c = over(c, GLOW, 0.75 * clamp01(1 - circle(x, y, 712, 512, 0) / 130) ** 2);
  c = over(c, DOT, cover(circle(x, y, 300, 324, 26), q));
  c = over(c, DOT, cover(circle(x, y, 512, 700, 26), q));
  c = over(c, SIGNAL, cover(circle(x, y, 712, 512, 34), q));
  c[3] = Math.round(c[3] * tile);
  return c;
}

export interface TrayState {
  /** 0..1 through the animation loop; dots travel along their lanes while agents work */
  phase: number;
  /** agents are working: the dots move */
  working: boolean;
  /** something needs the human: the middle dot stops, grows and breathes */
  attention: boolean;
}

export const TRAY_IDLE: TrayState = { phase: 0, working: false, attention: false };

/**
 * The menu bar icon in points (18 x 18): three translucent lanes and a solid dot on each.
 * Template images keep alpha, so the lanes read lighter than the dots in any menu bar.
 */
function trayAlpha(x: number, y: number, px: number, s: TrayState): number {
  const lanes = [4.2, 9, 13.8];
  const x1 = 2.6;
  const x2 = 15.4;
  const rest = [4.4, 13.2, 8.6];
  const speed = [1, 2, 1];
  const offset = [0, 0.35, 0.6];
  let a = 0;
  for (let i = 0; i < 3; i++) {
    const cy = lanes[i]!;
    a = Math.max(a, 0.42 * cover(capsule(x, y, x1, x2, cy, 1.8), px));
    const held = s.attention && i === 1;
    let cx = rest[i]!;
    if (s.working && !held) {
      const mid = (x1 + x2) / 2;
      cx = mid + ((x2 - x1) / 2) * Math.sin(2 * Math.PI * (s.phase * speed[i]! + offset[i]!));
    }
    let r = 1.25;
    if (held) r = 2.25 + 0.35 * Math.sin(2 * Math.PI * s.phase * 2);
    a = Math.max(a, cover(circle(x, y, cx, cy, r), px));
  }
  return a;
}

// ------------------------------------------------------------------ counts in the menu bar icon

// Digits drawn as round-capped strokes, so the count needs no font: polylines in a 1 x 1.6 box,
// y down. Arcs are sampled into short segments.
type Pt = [number, number];
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}
function quad(p0: Pt, c: Pt, p1: Pt, n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}
const GLYPHS: Record<string, Pt[][]> = {
  "0": [[...arc(0.5, 0.5, 0.45, 180, 360), ...arc(0.5, 1.1, 0.45, 0, 180), [0.05, 0.5]]],
  "1": [[[0.22, 0.38], [0.6, 0.05], [0.6, 1.55]]],
  "2": [[...arc(0.5, 0.47, 0.43, 195, 390), [0.05, 1.55], [0.95, 1.55]]],
  "3": [[...arc(0.5, 0.42, 0.37, 200, 450).slice(0, -1), ...arc(0.5, 1.13, 0.42, 270, 520)]],
  "4": [[[0.72, 1.55], [0.72, 0.05], [0.03, 1.1], [0.97, 1.1]]],
  "5": [[[0.88, 0.05], [0.2, 0.05], [0.13, 0.74], ...arc(0.5, 1.09, 0.45, 222, 515)]],
  "6": [quad([0.8, 0.05], [0.12, 0.45], [0.07, 1.1]), arc(0.5, 1.1, 0.43, 0, 360, 32)],
  "7": [[[0.04, 0.05], [0.96, 0.05], [0.36, 1.55]]],
  "8": [arc(0.5, 0.42, 0.36, 0, 360, 32), arc(0.5, 1.12, 0.43, 0, 360, 32)],
  "9": [arc(0.5, 0.5, 0.43, 0, 360, 32), quad([0.93, 0.5], [0.88, 1.2], [0.22, 1.55])],
  "+": [[[0.5, 0.45], [0.5, 1.15]], [[0.15, 0.8], [0.85, 0.8]]],
};
const GLYPH_WIDTH: Record<string, number> = { "1": 0.75, "+": 0.9 };
const GLYPH_GAP = 0.42;

function segment(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy || 1e-9;
  const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** The count as the menu bar shows it: up to 99, then 99+. */
export function countLabel(n: number): string {
  return n > 99 ? "99+" : String(n);
}

function textWidth(text: string, h: number): number {
  let w = 0;
  for (const ch of text) w += (GLYPH_WIDTH[ch] ?? 1) + GLYPH_GAP;
  return ((w - GLYPH_GAP) * h) / 1.6;
}

/** Signed distance to `text` drawn with glyph height h from (x0, top), strokes `stroke` wide. */
function textDistance(x: number, y: number, text: string, x0: number, top: number, h: number, stroke: number): number {
  const k = h / 1.6;
  let adv = 0;
  let d = Infinity;
  for (const ch of text) {
    // skip glyphs whose box is far from this pixel
    const gx = x0 + adv * k;
    const gw = (GLYPH_WIDTH[ch] ?? 1) * k;
    if (x > gx - stroke && x < gx + gw + stroke) {
      for (const line of GLYPHS[ch] ?? []) {
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1]!;
          const b = line[i]!;
          d = Math.min(d, segment(x, y, [gx + a[0] * k, top + a[1] * k], [gx + b[0] * k, top + b[1] * k]));
        }
      }
    }
    adv += (GLYPH_WIDTH[ch] ?? 1) + GLYPH_GAP;
  }
  return d - stroke / 2;
}

const BUBBLE: Rgba = [255, 178, 58, 255];
const BUBBLE_INK: Rgba = [42, 24, 0, 255];
const DIGIT_H = 8.6;
const BUBBLE_R = 5.6;

/** The width of the menu bar icon in points: 18, wider when it carries a count. */
export function trayWidth(count = 0): number {
  if (!count) return 18;
  return 13 + Math.max(9.6, textWidth(countLabel(count), DIGIT_H) + 5.4) / 2 + 4;
}

/**
 * The menu bar icon with the number of cards waiting, as RGBA (`scale` pixels per point). With
 * no count it is the plain lane icon in `ink`, fit for a template image. With a count the signal
 * dot grows into an amber bubble with the number in it, over the lanes; that image has colour,
 * so the caller picks an ink that reads on its menu bar.
 */
export function drawTray(s: TrayState, count: number, scale: number, ink: [number, number, number] = [0, 0, 0]): { rgba: Uint8Array; width: number; height: number } {
  const wPt = trayWidth(count);
  const width = Math.round(wPt * scale);
  const height = Math.round(18 * scale);
  const px = 1 / scale;
  const out = new Uint8Array(width * height * 4);
  const label = count ? countLabel(count) : "";
  const tw = label ? textWidth(label, DIGIT_H) : 0;
  const bw = Math.max(9.6, tw + 5.4);
  const cx = wPt - 2 - bw / 2;
  // with a count the bubble is the signal, so the middle dot is not held
  const lanes: TrayState = label ? { ...s, attention: false } : s;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = (i + 0.5) * px;
      const y = (j + 0.5) * px;
      let a = x < 18 ? trayAlpha(x, y, px, lanes) : 0;
      let rgba: Rgba = [ink[0], ink[1], ink[2], 0];
      if (label) {
        const bubble = capsule(x, y, cx - bw / 2 + BUBBLE_R, cx + bw / 2 - BUBBLE_R, 9, BUBBLE_R);
        // a clear ring around the bubble keeps it apart from the lanes; the lanes are drawn
        // stronger, as this image is not tinted by the system
        a = Math.min(1, a * 1.6) * (1 - cover(bubble - 1.4, px));
        rgba = [ink[0], ink[1], ink[2], Math.round(255 * a)];
        const b = cover(bubble, px);
        if (b > 0) {
          const t = cover(textDistance(x, y, label, cx - tw / 2, 9 - DIGIT_H / 2, DIGIT_H, 1.75), px);
          rgba = over(over(rgba, BUBBLE, b), BUBBLE_INK, b * t);
        }
      } else {
        rgba[3] = Math.round(255 * a);
      }
      out.set(rgba, (j * width + i) * 4);
    }
  }
  return { rgba: out, width, height };
}

/** The menu bar icon as a PNG, and its width in pixels. */
export function trayPng(s: TrayState, count: number, scale: number, ink?: [number, number, number]): Buffer {
  const { rgba, width, height } = drawTray(s, count, scale, ink);
  return png(rgba, width, height);
}

export type Art = "app" | "tray" | "overlay";

/**
 * RGBA pixels, row by row. The tray art takes an animation state, and an ink colour for menu bars
 * that do not recolour template images (Windows, Linux).
 */
export function draw(art: Art, size: number, tray: TrayState = TRAY_IDLE, ink: [number, number, number] = [0, 0, 0]): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let rgba: Rgba;
      if (art === "app") {
        const k = 1024 / size;
        rgba = appPixel((i + 0.5) * k, (j + 0.5) * k, k);
      } else if (art === "tray") {
        const k = 18 / size;
        rgba = [...ink, Math.round(255 * trayAlpha((i + 0.5) * k, (j + 0.5) * k, k, tray))];
      } else {
        const k = 2 / size;
        const d = circle((i + 0.5) * k - 1, (j + 0.5) * k - 1, 0, 0, 0.8);
        rgba = [RED[0], RED[1], RED[2], Math.round(255 * cover(d, k))];
      }
      out.set(rgba, (j * size + i) * 4);
    }
  }
  return out;
}

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGBA pixels as a PNG file. */
export function png(rgba: Uint8Array, width: number, height = width): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = width * 4 + 1;
  const raw = Buffer.alloc(height * row);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * row + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function artPng(art: Art, size: number, tray?: TrayState, ink?: [number, number, number]): Buffer {
  return png(draw(art, size, tray, ink), size);
}
