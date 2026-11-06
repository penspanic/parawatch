import zlib from "node:zlib";

/**
 * The app draws its own icons from code, so the repository holds no image files: the app icon
 * (a radar on an accent tile), the menu bar icon (the same radar as a monochrome template) and a
 * small dot for the Windows taskbar overlay.
 */

type Rgba = [number, number, number, number];

const ACCENT: Rgba = [120, 82, 238, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const RED: Rgba = [233, 49, 71, 255];

/** Coverage of a pixel by a ring between two radii, with a one-pixel soft edge. */
function ring(d: number, inner: number, outer: number): number {
  const a = Math.min(1, Math.max(0, d - inner + 0.5));
  const b = Math.min(1, Math.max(0, outer - d + 0.5));
  return Math.min(a, b);
}

function disc(d: number, r: number): number {
  return Math.min(1, Math.max(0, r - d + 0.5));
}

/** Signed distance outside a rounded square of half-size h and corner radius r (negative inside). */
function roundedBox(x: number, y: number, h: number, r: number): number {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Radar marks at unit scale (1 = half the drawing): two rings, a sweep line and a centre dot. */
function radar(x: number, y: number, px: number): number {
  const d = Math.hypot(x, y);
  const w = Math.max(px * 1.4, 0.075);
  let c = Math.max(ring(d / px, (0.82 - w / 2) / px, (0.82 + w / 2) / px), ring(d / px, (0.48 - w / 2) / px, (0.48 + w / 2) / px));
  c = Math.max(c, disc(d / px, 0.15 / px));
  // a sweep from the centre toward the upper right
  const ang = Math.atan2(-y, x);
  if (d < 0.82 && Math.abs(ang - Math.PI / 4) < 0.6) {
    const along = (x + -y) / Math.SQRT2;
    const across = Math.abs(x - -y) / Math.SQRT2;
    if (along > 0) c = Math.max(c, Math.min(1, Math.max(0, (w / 2 - across) / px + 0.5)));
  }
  return c;
}

export type Art = "app" | "tray" | "overlay";

/** RGBA pixels, row by row. */
export function draw(art: Art, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const half = size / 2;
  const px = 1 / half; // one pixel in unit space
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5 - half) / half;
      const y = (j + 0.5 - half) / half;
      let rgba: Rgba = [0, 0, 0, 0];
      if (art === "app") {
        // macOS-style tile: 80% of the canvas, corner radius about 22%
        const edge = roundedBox(x, y, 0.8, 0.18);
        const tile = Math.min(1, Math.max(0, -edge / px + 0.5));
        if (tile > 0) {
          const mark = radar(x / 0.56, y / 0.56, px / 0.56);
          const mix = (a: number, b: number) => Math.round(a + (b - a) * mark);
          rgba = [mix(ACCENT[0], WHITE[0]), mix(ACCENT[1], WHITE[1]), mix(ACCENT[2], WHITE[2]), Math.round(255 * tile)];
        }
      } else if (art === "tray") {
        const mark = radar(x / 0.94, y / 0.94, px / 0.94);
        rgba = [0, 0, 0, Math.round(255 * mark)];
      } else {
        const c = disc(Math.hypot(x, y) / px, 0.8 / px);
        rgba = [RED[0], RED[1], RED[2], Math.round(255 * c)];
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
export function png(rgba: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function artPng(art: Art, size: number): Buffer {
  return png(draw(art, size), size);
}
