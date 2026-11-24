import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { artPng, countLabel, draw, drawTray, TRAY_IDLE, trayWidth } from "../src/art.js";
import { findNpm, forCmd, npmBin, npmFailure, npmPrefix } from "../src/npmPath.js";
import { agentsWorking, alertFor, appUpdateStep, combineAlerts, issueUrl, needsYou, summary, toDo, updateLabel, type Alert } from "../src/rules.js";
import type { Card, PwEvent, Snapshot } from "../../../src/core/types.js";

const card = (id: string, kind: Card["kind"], status: Card["status"] = "open"): Card => ({
  id,
  kind,
  project: "game",
  title: `Card ${id}`,
  openedAt: "2026-11-07T00:00:00.000Z",
  status,
  answers: [],
  comments: [],
});
const snap = (cards: Card[]): Snapshot => ({ v: 1, generatedAt: "", projects: [], cards, runs: [] });
const ev = (body: object): PwEvent => ({ v: 1, seq: 1, ts: "", ...body }) as PwEvent;
const noRuns = { runTitle: () => undefined };

describe("what needs the human", () => {
  it("counts open cards that are not to-dos", () => {
    const s = snap([card("c1", "decide"), card("c2", "block"), card("c3", "todo"), card("c4", "try", "answered")]);
    expect(needsYou(s)).toBe(2);
    expect(toDo(s)).toBe(1);
    expect(summary(s)).toBe("2 need you · 1 to do");
    expect(summary(snap([]))).toBe("Nothing needs you");
  });

  it("sees agents at work from their runs", () => {
    const run = (state: "working" | "idle") => ({ id: "r", runtime: "codex", kind: "exec", title: "r", state }) as const;
    expect(agentsWorking({ ...snap([]), runs: [run("idle")] })).toBe(false);
    expect(agentsWorking({ ...snap([]), runs: [run("idle"), run("working")] })).toBe(true);
  });

  it("notifies for new cards and failed jobs, never for to-dos or answers", () => {
    const open = (kind: Card["kind"]) => ev({ type: "card.open", card: { id: "c9", kind, project: "game", title: "Ship it?" } });
    expect(alertFor(open("decide"), noRuns)).toEqual({ title: "game · Decide", body: "Ship it?", card: "c9" });
    expect(alertFor(open("block"), noRuns)?.title).toBe("game · Blocked");
    expect(alertFor(open("todo"), noRuns)).toBeUndefined();
    expect(alertFor(ev({ type: "card.answer", card: "c9", by: "human", choice: 1 }), noRuns)).toBeUndefined();
    expect(alertFor(ev({ type: "run.end", run: "r2", status: "failed", note: "UI test timed out" }), { runTitle: () => "PR 212 CI" })).toEqual({
      title: "A job failed",
      body: "PR 212 CI: UI test timed out",
    });
    expect(alertFor(ev({ type: "run.end", run: "r2", status: "done" }), noRuns)).toBeUndefined();
  });

  it("tells an issue assigned to the human and a new comment on it, and opens the issue on a click", () => {
    const issue = { key: "github.com/kim/game#21", host: "github.com", repo: "kim/game", number: 21, url: "https://github.com/kim/game/issues/21" };
    expect(alertFor(ev({ type: "issue.change", issue, change: "assigned", title: "Wreck interior", by: "kim", source: "github" }), noRuns)).toEqual({
      title: "game#21 · assigned to you by kim",
      body: "Wreck interior",
      focus: `issue:${issue.key}`,
      url: issue.url,
      dedupe: issue.url,
    });
    expect(alertFor(ev({ type: "issue.change", issue, change: "commented", title: "Wreck interior", by: "kim", source: "github" }), noRuns)?.title).toBe("game#21 · kim commented");
    expect(alertFor(ev({ type: "issue.aside", issue: issue.key }), noRuns)).toBeUndefined();
    expect(alertFor(ev({ type: "issue.change", issue, change: "assigned", by: "kim", source: "github", late: true }), noRuns)).toBeUndefined();
  });

  it("tells a notification from another person and opens it where the panel shows it", () => {
    const thread = { key: "github.com:7", host: "github.com", id: "7", repo: "kim/game", kind: "issue", number: 21, title: "Wreck interior", reason: "mention", by: "kim", url: "https://github.com/kim/game/issues/21", at: "" };
    expect(alertFor(ev({ type: "inbox.new", thread }), noRuns)).toEqual({ title: "game#21 · kim mentioned you", body: "Wreck interior", focus: "inbox:github.com:7", url: thread.url, dedupe: thread.url });
    expect(alertFor(ev({ type: "inbox.new", thread, late: true }), noRuns)).toBeUndefined();
  });

  it("tells the same thing once, keeps cards apart, and folds a burst into one notification", () => {
    const a = (title: string, extra: Partial<Alert> = {}): Alert => ({ title, body: "", ...extra });
    expect(combineAlerts([a("x", { dedupe: "u" }), a("y", { dedupe: "u" }), a("z")]).map((x) => x.title)).toEqual(["x", "z"]);
    const burst = combineAlerts([a("card", { card: "c1" }), a("one"), a("two"), a("three"), a("four"), a("five")]);
    expect(burst.map((x) => x.title)).toEqual(["card", "5 updates on GitHub and jobs"]);
    expect(burst[1]).toMatchObject({ body: "one\ntwo\nthree\nand 2 more", focus: "news" });
    // many cards and one other: nothing to fold
    expect(combineAlerts([a("c1", { card: "1" }), a("c2", { card: "2" }), a("c3", { card: "3" }), a("x")])).toHaveLength(4);
  });
});

describe("icons drawn in code", () => {
  it("draws a tile with transparent corners and a monochrome tray mark", () => {
    const app = draw("app", 64);
    expect(app[3]).toBe(0); // top-left corner is outside the rounded tile
    expect(app[(32 * 64 + 4) * 4 + 3]).toBe(0); // left edge, outside the tile
    expect(app[(32 * 64 + 32) * 4 + 3]).toBe(255); // centre
    const tray = draw("tray", 32);
    for (let i = 0; i < tray.length; i += 4) expect([tray[i], tray[i + 1], tray[i + 2]]).toEqual([0, 0, 0]);
    expect(tray.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
  });

  it("moves the tray dots only while agents work, and holds the one that needs you", () => {
    const opaque = (px: Uint8Array) => px.filter((v, i) => i % 4 === 3 && v === 255).length;
    const idle = (phase: number) => draw("tray", 36, { phase, working: false, attention: false });
    expect(idle(0.3)).toEqual(idle(0.7));
    const work = (phase: number) => draw("tray", 36, { phase, working: true, attention: false });
    expect(work(0.3)).not.toEqual(work(0.7));
    const held = draw("tray", 36, { phase: 0.125, working: false, attention: true });
    expect(opaque(held)).toBeGreaterThan(opaque(idle(0.125)));
    const white = draw("tray", 36, TRAY_IDLE, [255, 255, 255]);
    expect([white[0], white[1], white[2]]).toEqual([255, 255, 255]);
  });

  it("encodes a valid PNG", () => {
    const buf = artPng("overlay", 16);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(16); // width in IHDR
    const idat = buf.indexOf("IDAT");
    const len = buf.readUInt32BE(idat - 4);
    expect(zlib.inflateSync(buf.subarray(idat + 4, idat + 4 + len)).length).toBe(16 * (16 * 4 + 1));
  });

  it("draws the count inside the menu bar icon", () => {
    expect(countLabel(7)).toBe("7");
    expect(countLabel(140)).toBe("99+");
    expect(trayWidth(0)).toBe(18);
    expect(trayWidth(12)).toBeGreaterThan(trayWidth(1));
    const plain = drawTray(TRAY_IDLE, 0, 2);
    expect(plain.width).toBe(36);
    const one = drawTray(TRAY_IDLE, 1, 2);
    const twelve = drawTray(TRAY_IDLE, 12, 2);
    expect(twelve.width).toBeGreaterThan(one.width);
    // amber bubble pixels, and dark digit pixels inside it
    const px = (img: { rgba: Uint8Array }, test: (r: number, g: number, b: number, a: number) => boolean) => {
      let n = 0;
      for (let i = 0; i < img.rgba.length; i += 4) if (test(img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!)) n++;
      return n;
    };
    const amber = (r: number, g: number, b: number, a: number) => a > 250 && r > 240 && g > 160 && b < 80;
    const digit = (r: number, g: number, b: number, a: number) => a > 250 && r < 80 && g < 50;
    expect(px(plain, amber)).toBe(0);
    expect(px(one, amber)).toBeGreaterThan(50);
    expect(px(one, digit)).toBeGreaterThan(10);
    expect(px(twelve, digit)).toBeGreaterThan(px(one, digit));
  });
});

describe("pull requests and stuck work", () => {
  const pr = { type: "pr.change", pr: { key: "github.com/acme/api#88", host: "github.com", repo: "acme/api", number: 88, url: "https://github.com/acme/api/pull/88" }, title: "Fix login", source: "github" };

  it("notifies what keeps a pull request from landing, and the landing", () => {
    expect(alertFor(ev({ ...pr, change: "queue_removed" }), noRuns)).toEqual({ title: "api#88 · dropped from the merge queue", body: "Fix login", focus: "pr:github.com/acme/api#88", url: pr.pr.url });
    expect(alertFor(ev({ ...pr, change: "changes_requested", by: "alice" }), noRuns)?.title).toBe("api#88 · changes requested by alice");
    expect(alertFor(ev({ ...pr, change: "commented" }), noRuns)).toBeUndefined();
  });

  it("stays quiet on news a live session hears itself, and on news read late", () => {
    const owned = { ...noRuns, ownedLive: (k: string) => k === pr.pr.key };
    expect(alertFor(ev({ ...pr, change: "ci_failed" }), owned)).toBeUndefined();
    expect(alertFor(ev({ ...pr, change: "merged", late: true }), noRuns)).toBeUndefined();
    expect(alertFor(ev({ ...pr, change: "merged" }), noRuns)?.title).toBe("api#88 · merged");
  });

  it("reports a pull request or a job once when it gets stuck, and again only after it recovers", async () => {
    const { newlyStuck } = await import("../src/rules.js");
    const view = { key: "k", url: "", repo: "acme/api", number: 88, title: "Fix login", state: "open", draft: false, waitingOn: "merge queue", since: "", stalled: true, reviewRequested: false, mine: true } as const;
    const job = { id: "r1", runtime: "declared", kind: "declared", title: "bench", state: "stalled", action: "no sign of life for 12m" } as const;
    const s = { ...snap([]), prs: [view], runs: [job] } as Snapshot;
    const seen = new Set<string>();
    expect(newlyStuck(s, seen).map((a) => a.title)).toEqual(["api#88 stuck in merge queue", "A job stopped showing signs of life"]);
    expect(newlyStuck(s, seen)).toEqual([]);
    expect(newlyStuck({ ...s, prs: [{ ...view, stalled: false }], runs: [] }, seen)).toEqual([]);
    expect(newlyStuck(s, seen)).toHaveLength(2);
  });
});

describe("versions and updates", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  it("says where the app's own update stands", () => {
    expect(updateLabel({ status: "latest", checkedAt: "2026-11-09T11:50:00Z" }, now)).toBe("Up to date · checked 10 min ago");
    expect(updateLabel({ status: "downloading", version: "0.2.2", percent: 40 }, now)).toBe("Downloading 0.2.2 · 40%");
    expect(updateLabel({ status: "ready", version: "0.2.2" }, now)).toBe("0.2.2 is ready · restart to use it");
    expect(updateLabel({ status: "off", reason: "a development build does not update itself" }, now)).toBe("A development build does not update itself");
    expect(updateLabel({ status: "error", error: "could not reach GitHub" }, now)).toBe("Could not check: could not reach GitHub");
  });

  it("opens an issue with the versions filled in and nothing else", () => {
    const url = issueUrl({ version: "0.2.1", electron: "45.2.3", platform: "darwin-arm64 27.2", cli: { version: "0.2.0", at: "" }, logPath: "/Users/someone/Library/Logs/Parawatch/main.log", dataPath: "/Users/someone/.local/state/parawatch" });
    expect(url.startsWith("https://github.com/penspanic/parawatch/issues/new?body=")).toBe(true);
    const body = decodeURIComponent(url.split("body=")[1]!);
    expect(body).toContain("Parawatch app 0.2.1 (Electron 45.2.3)");
    expect(body).toContain("parawatch CLI 0.2.0");
    expect(body).not.toContain("/Users/someone");
  });
});

describe("npmPrefix", () => {
  it("finds the prefix of an npm global install", () => {
    expect(npmPrefix("/opt/homebrew/lib/node_modules/parawatch/dist/bin/cli.js", "darwin")).toBe("/opt/homebrew");
    expect(npmPrefix("/Users/me/.nvm/versions/node/v22.1.0/lib/node_modules/parawatch/dist/bin/cli.js", "darwin")).toBe("/Users/me/.nvm/versions/node/v22.1.0");
    expect(npmPrefix("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\parawatch\\dist\\bin\\cli.js", "win32")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm");
  });
  it("leaves other installs alone", () => {
    expect(npmPrefix("/Users/me/dev/parawatch/dist/bin/cli.js", "darwin")).toBeUndefined();
    expect(npmPrefix("/Users/me/project/node_modules/parawatch/dist/bin/cli.js", "darwin")).toBeUndefined();
    expect(npmPrefix(undefined, "darwin")).toBeUndefined();
  });
  it("names the npm beside the prefix", () => {
    expect(npmBin("/opt/homebrew", "darwin")).toBe("/opt/homebrew/bin/npm");
    expect(npmBin("C:\\npm", "win32")).toBe("C:\\npm\\npm.cmd");
  });
});

describe("deployments waiting for the human", () => {
  const KEY = "github.com/kim/game/actions/runs/4450";
  const deploy = { key: KEY, host: "github.com", repo: "kim/game", run: 4450, url: "https://x", workflow: "Deploy", title: "Release", environments: [{ id: 77, name: "production" }] };
  const ev = (change: "waiting" | "failed" | "approved", late?: boolean) => ({ type: "deploy.change", deploy, change, source: "github", late, v: 2, seq: 1, ts: "t" }) as PwEvent;
  const ctx = { runTitle: () => undefined };

  it("notifies when one waits or fails, not when a late reading finds it", () => {
    expect(alertFor(ev("waiting"), ctx)).toEqual(expect.objectContaining({ title: "game production · deploy waits for you", body: "Deploy: Release", url: "https://x" }));
    expect(alertFor(ev("failed"), ctx)?.title).toBe("game production · deploy failed");
    expect(alertFor(ev("approved"), ctx)).toBeUndefined();
    expect(alertFor(ev("waiting", true), ctx)).toBeUndefined();
  });

  it("counts one waiting as needing the human", () => {
    expect(needsYou({ cards: [], deploys: [{}] } as never)).toBe(1);
    expect(needsYou({ cards: [] } as never)).toBe(0);
  });
});

describe("findNpm", () => {
  const have = (...files: string[]) => (f: string) => files.includes(f);
  it("uses the npm inside the prefix first", () => {
    expect(findNpm("/opt/homebrew", "darwin", have("/opt/homebrew/bin/npm"))).toBe("/opt/homebrew/bin/npm");
    expect(findNpm("C:\\Users\\me\\AppData\\Roaming\\npm", "win32", have("C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd"), {})).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd");
  });
  it("finds the npm beside node on Windows, where the global prefix has none", () => {
    const env = { ProgramFiles: "C:\\Program Files", Path: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm" };
    expect(findNpm("C:\\Users\\me\\AppData\\Roaming\\npm", "win32", have("C:\\Program Files\\nodejs\\npm.cmd"), env)).toBe("C:\\Program Files\\nodejs\\npm.cmd");
  });
  it("prefers the node nvm links, then any npm on the PATH", () => {
    const nvm = { NVM_SYMLINK: "C:\\nvm4w\\nodejs", ProgramFiles: "C:\\Program Files", Path: "D:\\tools\\node\\" };
    expect(findNpm("C:\\npm", "win32", have("C:\\nvm4w\\nodejs\\npm.cmd", "C:\\Program Files\\nodejs\\npm.cmd"), nvm)).toBe("C:\\nvm4w\\nodejs\\npm.cmd");
    expect(findNpm("C:\\npm", "win32", have("D:\\tools\\node\\npm.cmd"), nvm)).toBe("D:\\tools\\node\\npm.cmd");
  });
  it("finds none on a Mac without npm in the prefix, and none on Windows without npm anywhere", () => {
    expect(findNpm("/usr/local", "darwin", have("/opt/homebrew/bin/npm"))).toBeUndefined();
    expect(findNpm("C:\\npm", "win32", have(), { Path: "C:\\Windows" })).toBeUndefined();
  });
});

describe("parawatch app update, from the app's side", () => {
  it("says restarting once a version is ready, and nothing while idle", () => {
    expect(appUpdateStep({ status: "ready", version: "0.3.33" })).toBe("restarting");
    expect(appUpdateStep({ status: "downloading", percent: 10 })).toBe("downloading");
    expect(appUpdateStep({ status: "available", version: "0.3.33" })).toBe("downloading");
    expect(appUpdateStep({ status: "latest" })).toBe("latest");
    expect(appUpdateStep({ status: "off", reason: "a development build does not update itself" })).toBe("off");
    expect(appUpdateStep({ status: "idle" })).toBeUndefined();
  });
});

describe("commands run through cmd.exe", () => {
  it("quotes a Windows path with a space, and leaves the rest alone", () => {
    expect(forCmd("C:\\Program Files\\nodejs\\npm.cmd", "win32")).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(forCmd("C:\\Users\\First Last\\AppData\\Roaming\\npm", "win32")).toBe('"C:\\Users\\First Last\\AppData\\Roaming\\npm"');
    expect(forCmd("C:\\Users\\panik\\AppData\\Roaming\\npm\\npm.cmd", "win32")).toBe("C:\\Users\\panik\\AppData\\Roaming\\npm\\npm.cmd");
    expect(forCmd("parawatch@0.3.34", "win32")).toBe("parawatch@0.3.34");
    expect(forCmd('"C:\\Program Files\\x.cmd"', "win32")).toBe('"C:\\Program Files\\x.cmd"');
    expect(forCmd("/opt/home brew/bin/npm", "darwin")).toBe("/opt/home brew/bin/npm");
  });

  // the Windows CI runs this for real: a .cmd under a folder with a space, as npm sits under Program Files
  it.runIf(process.platform === "win32")("runs a .cmd whose path has a space", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw cmd "));
    const cmd = path.join(dir, "say.cmd");
    fs.writeFileSync(cmd, "@echo off\r\necho said %~1\r\n");
    const out = await new Promise<string>((resolve, reject) =>
      execFile(forCmd(cmd), [forCmd("C:\\Some Folder")], { shell: true, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
    expect(out.trim()).toBe("said C:\\Some Folder");
  });
});

describe("npmFailure", () => {
  // what npm printed on a Windows machine a few minutes after a release was published
  const tarball404 = [
    "npm warn cleanup Failed to remove some directories [",
    "npm warn cleanup   [ 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\parawatch', [Error: EPERM: operation not permitted, rmdir] ]",
    "npm warn cleanup ]",
    "npm notice",
    "npm notice New major version of npm available! 11.6.2 -> 12.2.3",
    "npm notice To update run: npm install -g npm@12.2.3",
    "npm notice",
    "npm error code E404",
    "npm error 404 Not Found - GET https://registry.npmjs.org/parawatch/-/parawatch-0.3.35.tgz - Not found",
    "npm error 404",
    "npm error 404  The requested resource 'parawatch@https://registry.npmjs.org/parawatch/-/parawatch-0.3.35.tgz' could not be found or you do not have permission to access it.",
    "npm error A complete log of this run can be found in: C:\\Users\\me\\AppData\\Local\\npm-cache\\_logs\\x-debug-0.log",
  ].join("\r\n");

  it("takes a tarball npm does not serve yet as a version still on its way", () => {
    const f = npmFailure(tarball404);
    expect(f.notYet).toBe(true);
    expect(f.reason).toBe("npm error code E404 npm error 404 Not Found - GET https://registry.npmjs.org/parawatch/-/parawatch-0.3.35.tgz - Not found");
  });

  it("takes a version npm does not list yet as on its way", () => {
    expect(npmFailure("npm error code ETARGET\nnpm error notarget No matching version found for parawatch@9.9.9.").notYet).toBe(true);
  });

  it("names the error of any other failure, not npm's notices", () => {
    const f = npmFailure("npm notice To update run: npm install -g npm@12\nnpm error code EACCES\nnpm error syscall mkdir\nnpm error A complete log of this run can be found in: /x.log");
    expect(f.notYet).toBe(false);
    expect(f.reason).toBe("npm error code EACCES npm error syscall mkdir");
  });

  it("falls back to the last lines when npm printed no error line", () => {
    expect(npmFailure("one\ntwo\nthree\nfour").reason).toBe("two three four");
  });
});
