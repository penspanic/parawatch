import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { byteRange, mediaResponse, mediaType } from "../src/mediaResponse.js";

describe("byteRange", () => {
  it("reads a closed range and clamps its end to the file", () => {
    expect(byteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("reads an open range and a suffix range", () => {
    expect(byteRange("bytes=40-", 100)).toEqual({ start: 40, end: 99 });
    expect(byteRange("bytes=-30", 100)).toEqual({ start: 70, end: 99 });
    expect(byteRange("bytes=-300", 100)).toEqual({ start: 0, end: 99 });
  });

  it("serves the first range of a list", () => {
    expect(byteRange("bytes=0-4, 10-14", 100)).toEqual({ start: 0, end: 4 });
  });

  it("answers the whole file for no header or one it does not read", () => {
    expect(byteRange(undefined, 100)).toBeUndefined();
    expect(byteRange(null, 100)).toBeUndefined();
    expect(byteRange("items=0-4", 100)).toBeUndefined();
    expect(byteRange("bytes=-", 100)).toBeUndefined();
    expect(byteRange("bytes=20-10", 100)).toBeUndefined();
  });

  it("refuses a range that starts past the end", () => {
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});

describe("mediaResponse", () => {
  let dir: string;
  let file: string;
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-media-"));
    file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, bytes);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sends the whole file and says ranges work", async () => {
    const r = await mediaResponse(file, null);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("content-length")).toBe("256");
    expect(r.headers.get("content-range")).toBeNull();
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
  });

  it("sends the part a range asks for", async () => {
    const r = await mediaResponse(file, "bytes=100-149");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 100-149/256");
    expect(r.headers.get("content-length")).toBe("50");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(100, 150));
  });

  it("sends the end of the file for a suffix range", async () => {
    const r = await mediaResponse(file, "bytes=-6");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 250-255/256");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(250));
  });

  it("answers 416 for a range past the end", async () => {
    const r = await mediaResponse(file, "bytes=256-");
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */256");
  });

  it("answers 404 for a missing file or a folder", async () => {
    expect((await mediaResponse(path.join(dir, "gone.mp4"), null)).status).toBe(404);
    expect((await mediaResponse(dir, null)).status).toBe(404);
  });

  it("names the type from the extension", () => {
    expect(mediaType("/a/B.MOV")).toBe("video/quicktime");
    expect(mediaType("/a/b.png")).toBe("image/png");
    expect(mediaType("/a/b.xyz")).toBe("application/octet-stream");
  });
});
