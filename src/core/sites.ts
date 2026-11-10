/**
 * Which website stands for the service behind a run or a pull request. The desktop app shows that
 * site's own icon (its favicon), fetched from the site at run time. Only the sites named here and
 * the hosts of pull requests the store already lists are ever asked for an icon.
 */
import type { Run } from "./types.js";

export const CLAUDE_SITE = "https://claude.ai/";
export const CODEX_SITE = "https://developers.openai.com/codex";

/** The fixed sites, with the name the tooltip uses. */
export const SERVICE_NAMES: Record<string, string> = {
  [CLAUDE_SITE]: "Claude Code",
  [CODEX_SITE]: "Codex",
};

/** The site for a run's runtime; declared runs and unknown runtimes have none. */
export function siteForRun(run: Pick<Run, "runtime">): string | undefined {
  if (run.runtime === "claude-code") return CLAUDE_SITE;
  if (run.runtime === "codex") return CODEX_SITE;
  return undefined;
}

/** The site for a pull request, from its URL (`https://<host>/...` becomes `https://<host>/`). */
export function siteForPr(pr: { url: string }): string | undefined {
  try {
    const u = new URL(pr.url);
    return u.protocol === "https:" && u.hostname ? `https://${u.host}/` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `site` may be fetched: a plain https URL with no credentials, query or fragment, that is
 * one of the fixed sites or the root of a host in `prHosts`.
 */
export function allowedSite(site: unknown, prHosts: Iterable<string>): site is string {
  if (typeof site !== "string") return false;
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return false;
  if (u.href !== site) return false;
  if (site in SERVICE_NAMES) return true;
  if (u.pathname !== "/") return false;
  for (const h of prHosts) if (h.toLowerCase() === u.host) return true;
  return false;
}

/** The runtime's product name, for tooltips. */
export function serviceName(run: Pick<Run, "runtime">): string | undefined {
  const site = siteForRun(run);
  return site ? SERVICE_NAMES[site] : undefined;
}

/** How long an icon is kept before it is fetched again, and how long a failure is remembered. */
export const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ICON_FAIL_TTL_MS = 24 * 60 * 60 * 1000;

export interface IconCacheEntry {
  /** when the icon was stored */
  fetchedAt?: string;
  /** when the last fetch failed */
  failedAt?: string;
}

/** `fresh`: use the stored icon; `failed`: do not try again yet; `stale`: fetch it. */
export function iconCacheState(e: IconCacheEntry | undefined, now: number): "fresh" | "failed" | "stale" {
  const fetched = e?.fetchedAt ? Date.parse(e.fetchedAt) : NaN;
  const failed = e?.failedAt ? Date.parse(e.failedAt) : NaN;
  if (Number.isFinite(failed) && now - failed < ICON_FAIL_TTL_MS && !(Number.isFinite(fetched) && fetched > failed)) return "failed";
  if (Number.isFinite(fetched) && now - fetched < ICON_TTL_MS) return "fresh";
  return "stale";
}

export interface IconLink {
  url: string;
  svg: boolean;
  /** the largest side in pixels, when the page says */
  size?: number;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of tag.replace(/^<link\b/i, "").matchAll(re)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** The icon links a page declares (`rel` icon, shortcut icon, apple-touch-icon), as absolute https URLs. */
export function parseIconLinks(html: string, base: string): IconLink[] {
  const found: IconLink[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    if (!a.href) continue;
    let url: URL;
    try {
      url = new URL(a.href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const svg = (a.type ?? "").toLowerCase().includes("svg") || /\.svg$/i.test(url.pathname);
    let size: number | undefined;
    for (const s of (a.sizes ?? "").toLowerCase().split(/\s+/)) {
      const wh = /^(\d+)x(\d+)$/.exec(s);
      if (wh) size = Math.max(size ?? 0, Number(wh[1]), Number(wh[2]));
    }
    found.push({ url: url.href, svg, size });
  }
  return found;
}

/**
 * The URLs to try, best first: an SVG, then the raster icon closest to 32px or larger, then the
 * site's `/favicon.ico`.
 */
export function rankIcons(links: IconLink[], base: string): string[] {
  const score = (l: IconLink) => {
    if (l.svg) return -1;
    const s = l.size ?? 32;
    return s >= 32 ? s - 32 : 1000 + (32 - s);
  };
  const urls = links
    .map((l, i) => ({ l, i }))
    .sort((a, b) => score(a.l) - score(b.l) || a.i - b.i)
    .map((x) => x.l.url);
  try {
    urls.push(new URL("/favicon.ico", base).href);
  } catch {
    // not a URL; nothing to fall back to
  }
  return [...new Set(urls)];
}

/** The file name an icon is stored under: the site without its scheme, safe for any file system. */
export function siteFileKey(site: string): string {
  return site.replace(/^https:\/\//, "").replace(/\/+$/, "").replace(/[^a-zA-Z0-9.-]+/g, "_").toLowerCase();
}

const EXTENSIONS: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The image types an icon may have; anything else is not shown. */
export function iconExtension(mime: string): string | undefined {
  return EXTENSIONS[mime.split(";")[0]!.trim().toLowerCase()];
}
