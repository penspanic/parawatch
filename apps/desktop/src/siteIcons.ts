/**
 * Each service's own site icon, fetched from its site the way a browser shows a favicon and kept in
 * the app's data folder (`icons/<site>.<ext>` with a small JSON beside it). The image is shown as
 * it is. A plain GET carries no cookies, no query and no user data. Nothing here blocks the window:
 * the page asks, and shows the generic icon until the answer arrives.
 */
import fs from "node:fs";
import path from "node:path";
import { net } from "electron";
import { iconCacheState, iconExtension, parseIconLinks, rankIcons, siteFileKey, type IconCacheEntry } from "../../../src/core/sites.js";
import { logger } from "./logger.js";

const TIMEOUT_MS = 5000;
const MAX_HTML = 512 * 1024;
const MAX_ICON = 512 * 1024;

interface Meta extends IconCacheEntry {
  ext?: string;
  mime?: string;
}

const inflight = new Map<string, Promise<string | undefined>>();

/**
 * GET `start`, checking every redirect hop: https only. Returns the body and the URL it came from.
 * With `host` set, a redirect that leaves that host is refused. No cookies are sent or kept.
 */
function get(start: string, host: string | undefined, max: number): Promise<{ body: Buffer; type: string; url: string } | undefined> {
  return new Promise((resolve, reject) => {
    let url = start;
    const req = net.request({ url, method: "GET", redirect: "manual", credentials: "omit", useSessionCookies: false });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error("timed out"));
    }, TIMEOUT_MS);
    const done = (v: { body: Buffer; type: string; url: string } | undefined) => {
      clearTimeout(timer);
      resolve(v);
    };
    const allowed = (u: string) => {
      const p = new URL(u);
      return p.protocol === "https:" && (!host || p.host === host);
    };
    if (!allowed(url)) return done(undefined);
    let hops = 0;
    req.on("redirect", (_status, _method, to) => {
      if (++hops > 5 || !allowed(to)) {
        req.abort();
        return done(undefined);
      }
      url = to;
      req.followRedirect();
    });
    req.on("response", (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        req.abort();
        return done(undefined);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > max) {
          req.abort();
          return done(undefined);
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const type = res.headers["content-type"];
        done(size ? { body: Buffer.concat(chunks), type: (Array.isArray(type) ? type[0] : type) ?? "", url } : undefined);
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/** Find, download and return the icon of `site`, or undefined. */
async function download(site: string): Promise<{ body: Buffer; ext: string; mime: string } | undefined> {
  // the site may send us on (the Codex page moved to another host); its icons are on the host it lands on
  let landed = site;
  let html = "";
  try {
    const page = await get(site, undefined, MAX_HTML);
    if (page) {
      html = page.body.toString("utf8");
      landed = page.url;
    }
  } catch (err) {
    logger.warn(`page ${site}:`, err);
    // no page; the favicon path below may still answer
  }
  const host = new URL(landed).host;
  for (const url of rankIcons(parseIconLinks(html, landed), landed)) {
    if (new URL(url).host !== host) continue;
    try {
      const img = await get(url, host, MAX_ICON);
      if (!img) continue;
      let mime = img.type.split(";")[0]!.trim().toLowerCase();
      // servers often send an .ico as application/octet-stream
      if (!iconExtension(mime) && /\.ico$/i.test(new URL(url).pathname)) mime = "image/x-icon";
      const ext = iconExtension(mime);
      if (ext) return { body: img.body, ext, mime };
    } catch (err) {
      logger.warn(`icon candidate ${url}:`, err);
      // try the next candidate
    }
  }
  return undefined;
}

function dataUrl(file: string, mime: string): string | undefined {
  try {
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function readMeta(file: string): Meta | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Meta;
  } catch {
    return undefined;
  }
}

async function resolve(dir: string, site: string): Promise<string | undefined> {
  const key = siteFileKey(site);
  const metaFile = path.join(dir, `${key}.json`);
  const meta = readMeta(metaFile);
  const have = () => (meta?.ext && meta.mime ? dataUrl(path.join(dir, `${key}.${meta.ext}`), meta.mime) : undefined);
  const state = iconCacheState(meta, Date.now());
  if (state === "fresh") return have();
  if (state === "failed") return have();
  try {
    const got = await download(site);
    fs.mkdirSync(dir, { recursive: true });
    if (got) {
      fs.writeFileSync(path.join(dir, `${key}.${got.ext}`), got.body);
      const next: Meta = { fetchedAt: new Date().toISOString(), ext: got.ext, mime: got.mime };
      fs.writeFileSync(metaFile, JSON.stringify(next));
      return `data:${got.mime};base64,${got.body.toString("base64")}`;
    }
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, failedAt: new Date().toISOString() }));
  } catch (err) {
    logger.warn(`site icon for ${site} failed:`, err);
  }
  return have(); // an older icon beats none
}

/** The icon of `site` as a data URL, from the cache or the site. `site` must already be allowed. */
export function siteIcon(dir: string, site: string): Promise<string | undefined> {
  let p = inflight.get(site);
  if (!p) {
    p = resolve(dir, site).finally(() => inflight.delete(site));
    inflight.set(site, p);
  }
  return p;
}
