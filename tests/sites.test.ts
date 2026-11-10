import { describe, expect, it } from "vitest";
import {
  allowedSite,
  CLAUDE_SITE,
  CODEX_SITE,
  ICON_FAIL_TTL_MS,
  ICON_TTL_MS,
  iconCacheState,
  iconExtension,
  parseIconLinks,
  rankIcons,
  serviceName,
  siteFileKey,
  siteForPr,
  siteForRun,
} from "../src/core/sites.js";

describe("siteForRun", () => {
  it("maps the two runtimes to their sites", () => {
    expect(siteForRun({ runtime: "claude-code" })).toBe(CLAUDE_SITE);
    expect(siteForRun({ runtime: "codex" })).toBe(CODEX_SITE);
    expect(serviceName({ runtime: "codex" })).toBe("Codex");
  });
  it("has none for declared runs and unknown runtimes", () => {
    expect(siteForRun({ runtime: "declared" })).toBeUndefined();
    expect(siteForRun({ runtime: "aider" })).toBeUndefined();
  });
});

describe("siteForPr", () => {
  it("is the root of the host", () => {
    expect(siteForPr({ url: "https://github.com/o/r/pull/3" })).toBe("https://github.com/");
    expect(siteForPr({ url: "https://git.example.com:8443/o/r/pull/3?x=1" })).toBe("https://git.example.com:8443/");
  });
  it("has none for a URL that is not https", () => {
    expect(siteForPr({ url: "http://github.com/o/r/pull/3" })).toBeUndefined();
    expect(siteForPr({ url: "nope" })).toBeUndefined();
  });
});

describe("allowedSite", () => {
  it("allows the fixed sites and the hosts of listed pull requests only", () => {
    expect(allowedSite(CLAUDE_SITE, [])).toBe(true);
    expect(allowedSite(CODEX_SITE, [])).toBe(true);
    expect(allowedSite("https://github.com/", ["github.com"])).toBe(true);
    expect(allowedSite("https://github.com/", [])).toBe(false);
    expect(allowedSite("https://evil.test/", ["github.com"])).toBe(false);
  });
  it("refuses anything that carries data", () => {
    expect(allowedSite("https://github.com/?q=1", ["github.com"])).toBe(false);
    expect(allowedSite("https://u:p@github.com/", ["github.com"])).toBe(false);
    expect(allowedSite("https://github.com/path", ["github.com"])).toBe(false);
    expect(allowedSite("http://github.com/", ["github.com"])).toBe(false);
    expect(allowedSite(42, [])).toBe(false);
  });
});

describe("parseIconLinks and rankIcons", () => {
  const base = "https://developers.openai.com/codex";
  it("reads the icon link of the codex page", () => {
    const links = parseIconLinks('<html><head><link rel="icon" type="image/png" href="/favicon.png"></head>', base);
    expect(links).toEqual([{ url: "https://developers.openai.com/favicon.png", svg: false, size: undefined }]);
    expect(rankIcons(links, base)).toEqual(["https://developers.openai.com/favicon.png", "https://developers.openai.com/favicon.ico"]);
  });
  it("understands shortcut icon, single quotes and attribute order", () => {
    const links = parseIconLinks(`<link href='a.ico' rel='shortcut icon'><link rel="stylesheet" href="x.css"><LINK REL="apple-touch-icon" SIZES="180x180" HREF="/t.png">`, "https://x.test/dir/page");
    expect(links.map((l) => l.url)).toEqual(["https://x.test/dir/a.ico", "https://x.test/t.png"]);
  });
  it("prefers SVG, then the raster closest to 32px or larger", () => {
    const html = `
      <link rel="icon" href="/16.png" sizes="16x16">
      <link rel="icon" href="/180.png" sizes="180x180">
      <link rel="icon" href="/48.png" sizes="48x48">
      <link rel="icon" href="/32.png" sizes="32x32">`;
    expect(rankIcons(parseIconLinks(html, "https://x.test/"), "https://x.test/").slice(0, 4)).toEqual([
      "https://x.test/32.png",
      "https://x.test/48.png",
      "https://x.test/180.png",
      "https://x.test/16.png",
    ]);
    const withSvg = html + '<link rel="icon" type="image/svg+xml" href="/i.svg">';
    expect(rankIcons(parseIconLinks(withSvg, "https://x.test/"), "https://x.test/")[0]).toBe("https://x.test/i.svg");
  });
  it("falls back to /favicon.ico and skips links that are not https", () => {
    expect(rankIcons(parseIconLinks("<p>no icons</p>", "https://github.com/"), "https://github.com/")).toEqual(["https://github.com/favicon.ico"]);
    expect(parseIconLinks('<link rel="icon" href="http://x.test/a.png"><link rel="icon" href="data:image/png;base64,AA==">', "https://x.test/")).toEqual([]);
  });
});

describe("iconCacheState", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("is stale without an entry", () => {
    expect(iconCacheState(undefined, now)).toBe("stale");
  });
  it("keeps an icon for 7 days", () => {
    expect(iconCacheState({ fetchedAt: ago(ICON_TTL_MS - 1000) }, now)).toBe("fresh");
    expect(iconCacheState({ fetchedAt: ago(ICON_TTL_MS + 1000) }, now)).toBe("stale");
  });
  it("remembers a failure for 1 day", () => {
    expect(iconCacheState({ failedAt: ago(ICON_FAIL_TTL_MS - 1000) }, now)).toBe("failed");
    expect(iconCacheState({ failedAt: ago(ICON_FAIL_TTL_MS + 1000) }, now)).toBe("stale");
  });
  it("keeps showing an older icon over a failure that is newer than its refresh", () => {
    expect(iconCacheState({ fetchedAt: ago(ICON_TTL_MS + 5000), failedAt: ago(1000) }, now)).toBe("failed");
    expect(iconCacheState({ fetchedAt: ago(1000), failedAt: ago(5000) }, now)).toBe("fresh");
  });
});

describe("file names", () => {
  it("makes safe keys and picks extensions", () => {
    expect(siteFileKey(CODEX_SITE)).toBe("developers.openai.com_codex");
    expect(siteFileKey("https://github.com/")).toBe("github.com");
    expect(iconExtension("image/svg+xml; charset=utf-8")).toBe("svg");
    expect(iconExtension("text/html")).toBeUndefined();
  });
});
