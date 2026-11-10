import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProject, answerCard, claimSession, closeCard, hideRun, unhideRun, listeners, openCard, prEvent, readInbox, readState, startListening, startRun, endRun, waitInbox, linkPr } from "../src/core/ops.js";
import { snapshot } from "../src/core/snapshot.js";
import { collectRuns, otherRuns, shareRuns, SHARED_RUNS_GONE_MS } from "../src/core/runs.js";
import type { Run } from "../src/core/types.js";
import { eventFiles, eventsPath, readCursor, readEvents, writeCursor } from "../src/core/store.js";
import { findConflicts, mapPath, readDevice, setRoot, setupSync, syncStatus, type DeviceInfo } from "../src/core/sync.js";
import { readSyncthingGui } from "../src/core/syncthing.js";
import { dropReported } from "../src/core/github.js";
import { doctor } from "../src/core/doctor.js";
import { STORE_FORMAT, type PrChange } from "../src/core/types.js";

/**
 * Two machines on one test box: each has its own parawatch home and its own copy of the shared
 * folder. `carry` plays the sync tool and copies every file it finds between the two copies.
 */
let root = "";
const machines = ["mac", "pc"] as const;
type Machine = (typeof machines)[number];
const home = (m: Machine) => path.join(root, m, "home");
const shared = (m: Machine) => path.join(root, m, "agent-sync", "parawatch");

function on<T>(m: Machine, fn: () => T): T {
  const before = { home: process.env.PARAWATCH_HOME, device: process.env.PARAWATCH_DEVICE };
  process.env.PARAWATCH_HOME = home(m);
  delete process.env.PARAWATCH_DEVICE;
  try {
    return fn();
  } finally {
    process.env.PARAWATCH_HOME = before.home;
    if (before.device === undefined) delete process.env.PARAWATCH_DEVICE;
    else process.env.PARAWATCH_DEVICE = before.device;
  }
}

/** Copy what one machine's shared folder has and the other lacks or has older. */
function carry(from: Machine, to: Machine): void {
  const walk = (dir: string, rel = "") => {
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const r = path.join(rel, n.name);
      if (n.isDirectory()) walk(dir, r);
      else if (!n.name.startsWith(".")) {
        const src = path.join(dir, r);
        const dst = path.join(shared(to), r);
        // a machine's own files only ever go out
        if (/^events[\\/]/.test(r) && path.basename(r, ".jsonl") === to) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  };
  walk(shared(from));
}

const both = () => {
  carry("mac", "pc");
  carry("pc", "mac");
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-shared-"));
  process.env.PARAWATCH_NOTIFY = "0";
  process.env.PARAWATCH_GITHUB = "0";
  process.env.PARAWATCH_CLAUDE_DIR = path.join(root, "claude");
  process.env.PARAWATCH_CODEX_DIR = path.join(root, "codex");
  process.env.PARAWATCH_CLAUDE_DESKTOP_DIR = path.join(root, "claude-desktop");
  for (const m of machines) fs.mkdirSync(home(m), { recursive: true });
});

afterEach(() => {
  delete process.env.PARAWATCH_GITHUB;
  delete process.env.PARAWATCH_CLAUDE_DIR;
  delete process.env.PARAWATCH_CODEX_DIR;
  delete process.env.PARAWATCH_CLAUDE_DESKTOP_DIR;
});

describe("one machine", () => {
  it("writes the same log as before: format 1, plain ids, a seq cursor", () => {
    on("mac", () => {
      const c = openCard({ kind: "decide", project: "game", title: "Which ending?", options: ["A", "B"] });
      expect(c.id).toBe("c1");
      expect(eventsPath()).toBe(path.join(home("mac"), "events.jsonl"));
      const line = JSON.parse(fs.readFileSync(eventsPath(), "utf8").trim()) as Record<string, unknown>;
      expect(line).toMatchObject({ v: 1, seq: 1, type: "card.open" });
      expect(line).not.toHaveProperty("dev");
      answerCard("c1", { choice: 2 });
      expect(JSON.parse(fs.readFileSync(eventsPath(), "utf8").trim().split("\n")[1]!)).not.toHaveProperty("seen");
      expect(readInbox("game", { project: "game" }, true)).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(home("mac"), "cursors", "game.json"), "utf8"))).toEqual({ seq: 2, at: expect.any(String) });
      expect(readInbox("game", { project: "game" }, true)).toHaveLength(0);
    });
  });
});

describe("moving to a shared folder", () => {
  it("keeps every event, seq, id and cursor, and leaves a marker older copies refuse to write past", () => {
    on("mac", () => {
      openCard({ kind: "decide", project: "game", title: "One", options: ["A", "B"] });
      answerCard("c1", { choice: 1 });
      readInbox("game", { project: "game" }, true);
      const r = setupSync({ dir: shared("mac"), device: "mac", adapter: "folder" });
      expect(r).toMatchObject({ device: "mac", moved: 2, others: [] });
      expect(eventsPath()).toBe(path.join(shared("mac"), "events", "mac.jsonl"));
      expect(readEvents().map((e) => [e.seq, e.dev])).toEqual([
        [1, "mac"],
        [2, "mac"],
      ]);
      // the answer was delivered before the move and is not delivered again
      expect(readInbox("game", { project: "game" }, true)).toHaveLength(0);
      const old = fs.readFileSync(path.join(home("mac"), "events.jsonl"), "utf8");
      expect(JSON.parse(old)).toMatchObject({ v: 2, type: "store.moved" });
      expect(fs.existsSync(path.join(home("mac"), "events.jsonl.before-sync"))).toBe(true);
      // new ids carry the machine and go on from the old count
      expect(openCard({ kind: "todo", project: "game", title: "Two" }).id).toBe("mac-c2");
      expect(readState().cards.has("c1")).toBe(true);
      // running it again changes nothing
      expect(setupSync({ dir: shared("mac"), device: "mac" }).moved).toBe(0);
      expect(readEvents()).toHaveLength(3);
      expect(STORE_FORMAT).toBe(2);
    });
  });

  it("refuses a device name another machine already writes as", () => {
    on("mac", () => setupSync({ dir: shared("mac"), device: "mac" }));
    const file = path.join(shared("mac"), "devices", "mac.json");
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as DeviceInfo;
    fs.writeFileSync(file, JSON.stringify({ ...d, host: "other-box:/home/x" }));
    expect(() => on("mac", () => setupSync({ dir: shared("mac"), device: "mac" }))).toThrow(/already writes as "mac"/);
  });
});

describe("two machines", () => {
  beforeEach(() => {
    on("mac", () => setupSync({ dir: shared("mac"), device: "mac" }));
    on("pc", () => setupSync({ dir: shared("pc"), device: "pc" }));
  });

  it("a card opened on one machine is answered on the other and wakes the wait where it was asked", () => {
    const card = on("pc", () => openCard({ kind: "decide", project: "spill", title: "Ship it?", options: ["Yes", "No"] }));
    expect(card.id).toBe("pc-c1");
    expect(on("mac", () => readState().cards.size)).toBe(0);
    carry("pc", "mac");
    on("mac", () => {
      const seen = readState().cards.get("pc-c1")!;
      expect(seen).toMatchObject({ title: "Ship it?", dev: "pc" });
      // the short id works where it is unique
      answerCard("c1", { choice: 1, comment: "go" });
    });
    carry("mac", "pc");
    const items = on("pc", () => readInbox("spill", { project: "spill" }, true));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "answer", dev: "mac", choiceText: "Yes", comment: "go" });
    expect(on("pc", () => readInbox("spill", { project: "spill" }, true))).toHaveLength(0);
    const cursor = JSON.parse(fs.readFileSync(path.join(home("pc"), "cursors", "spill.json"), "utf8")) as { pos: Record<string, number> };
    expect(cursor.pos).toEqual({ mac: 1 });
  });

  it("both machines see the same order, and ids never clash", () => {
    on("mac", () => openCard({ kind: "todo", project: "a", title: "m1" }));
    on("pc", () => openCard({ kind: "todo", project: "a", title: "p1" }));
    on("mac", () => openCard({ kind: "todo", project: "a", title: "m2" }));
    both();
    const mac = on("mac", () => readEvents().map((e) => `${e.dev}:${e.seq}`));
    const pc = on("pc", () => readEvents().map((e) => `${e.dev}:${e.seq}`));
    expect(mac).toEqual(pc);
    expect(on("pc", () => [...readState().cards.keys()].sort())).toEqual(["mac-c1", "mac-c2", "pc-c1"]);
  });

  it("answers given on both machines at once: the first stands, the other is kept and not delivered", () => {
    on("pc", () => openCard({ kind: "decide", project: "spill", title: "Which?", options: ["A", "B"] }));
    both();
    on("mac", () => answerCard("pc-c1", { choice: 1 }));
    // the pc answers before the mac's answer reaches it
    on("pc", () => answerCard("pc-c1", { choice: 2 }));
    both();
    for (const m of machines) {
      const c = on(m, () => readState().cards.get("pc-c1")!);
      expect(c.answers.map((a) => [a.dev, a.choice, !!a.late])).toEqual([
        ["mac", 1, false],
        ["pc", 2, true],
      ]);
    }
    const items = on("pc", () => readInbox("spill", { project: "spill" }, true));
    expect(items.map((i) => i.choice)).toEqual([1]);
    // an answer given after seeing the first one is a real second answer
    on("mac", () => answerCard("pc-c1", { comment: "on second thought, B" }));
    carry("mac", "pc");
    expect(on("pc", () => readInbox("spill", { project: "spill" }, true)).map((i) => i.comment)).toEqual(["on second thought, B"]);
  });

  it("a wait on one machine wakes when the answer arrives from the other", async () => {
    on("pc", () => openCard({ kind: "decide", project: "spill", title: "Go?", options: ["Yes"] }));
    carry("pc", "mac");
    on("mac", () => answerCard("pc-c1", { choice: 1 }));
    process.env.PARAWATCH_HOME = home("pc");
    try {
      const waiting = waitInbox("spill", { project: "spill" }, 5000, 100);
      setTimeout(() => carry("mac", "pc"), 300);
      const items = await waiting;
      expect(items.map((i) => [i.dev, i.choice])).toEqual([["mac", 1]]);
    } finally {
      delete process.env.PARAWATCH_HOME;
    }
  });

  it("paths under the other machine's home, shared folder or named roots open here", () => {
    const mac = readDevice("mac", shared("mac"))!;
    const pc = readDevice("pc", shared("pc"))!;
    const macInfo: DeviceInfo = { ...mac, platform: "darwin", home: "/Users/sam", shared: "/Users/sam/agent-sync/parawatch", roots: { gdrive: "/Users/sam/Library/CloudStorage/GoogleDrive-x/My Drive" } };
    const pcInfo: DeviceInfo = { ...pc, platform: "win32", home: "C:\\Users\\alex", shared: "C:\\Users\\alex\\agent-sync\\parawatch", roots: { gdrive: "G:\\My Drive" } };
    expect(mapPath("C:\\Users\\alex\\dev\\spill\\capture.png", pcInfo, macInfo)).toBe("/Users/sam/dev/spill/capture.png");
    expect(mapPath("c:\\users\\ALEX\\agent-sync\\parawatch\\attachments\\x.png", pcInfo, macInfo)).toBe("/Users/sam/agent-sync/parawatch/attachments/x.png");
    expect(mapPath("G:\\My Drive\\Spill\\a.mp4", pcInfo, macInfo)).toBe("/Users/sam/Library/CloudStorage/GoogleDrive-x/My Drive/Spill/a.mp4");
    expect(mapPath("/Users/sam/Library/CloudStorage/GoogleDrive-x/My Drive/b.png", macInfo, pcInfo)).toBe("G:\\My Drive\\b.png");
    expect(mapPath("/Users/sam/dev/x", macInfo, pcInfo)).toBe("C:\\Users\\alex\\dev\\x");
    expect(mapPath("D:\\elsewhere\\c.png", pcInfo, macInfo)).toBe("D:\\elsewhere\\c.png");
    // a place on the reading machine, named by the writing one, is left alone
    expect(mapPath("/Users/Shared/Try/game/Game.app", pcInfo, macInfo)).toBe("/Users/Shared/Try/game/Game.app");
    expect(mapPath("C:\\Users\\Public\\Game.exe", macInfo, pcInfo)).toBe("C:\\Users\\Public\\Game.exe");
    expect(mapPath("https://example.com/x.png", pcInfo, macInfo)).toBe("https://example.com/x.png");
  });

  it("maps attachments and project folders written on the other machine when reading", () => {
    on("pc", () => {
      setRoot("work", path.join(root, "pc", "work"));
      addProject("spill", [path.join(root, "pc", "work", "spill")]);
      openCard({ kind: "try", project: "spill", title: "Look", attach: [path.join(root, "pc", "work", "spill", "a.png")] });
    });
    on("mac", () => setRoot("work", path.join(root, "mac", "work")));
    both();
    on("mac", () => {
      const s = readState();
      expect(s.projects.get("spill")!.paths).toEqual([path.join(root, "mac", "work", "spill")]);
      expect(s.cards.get("pc-c1")!.attach).toEqual([path.join(root, "mac", "work", "spill", "a.png")]);
      expect(snapshot().devices).toEqual({ me: "mac", others: ["pc"] });
    });
  });

  it("a wait on the other machine counts while its beat is fresh", () => {
    const stop = on("pc", () => startListening({ consumer: "spill", project: "spill" }));
    carry("pc", "mac");
    stop();
    const now = Date.now();
    const seen = on("mac", () => listeners(now));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ device: "pc", project: "spill" });
    expect(on("mac", () => listeners(now + 10 * 60_000))).toHaveLength(0);
  });

  it("the same pull request news read on both machines is delivered once", () => {
    const pr = { key: "github.com/o/r#1", host: "github.com", repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1" };
    on("pc", () => linkPr({ pr, project: "spill" }));
    both();
    on("mac", () => prEvent(pr, "ci_failed", { text: "build" }));
    on("pc", () => prEvent(pr, "ci_failed", { text: "build" }));
    both();
    expect(on("pc", () => readInbox("spill", { project: "spill" }, true))).toHaveLength(1);
  });

  it("news another machine reported since this machine last read GitHub is not written again", () => {
    const pr = { key: "github.com/o/r#504", host: "github.com", repo: "o/r", number: 504, url: "https://github.com/o/r/pull/504" };
    const lastRead = new Date(Date.now() - 3 * 3_600_000).toISOString();
    on("mac", () => {
      prEvent(pr, "ci_passed");
      prEvent(pr, "merged");
    });
    both();
    const news = (change: PrChange) => ({ type: "pr.change" as const, pr, change, source: "github" as const });
    // the pc last read GitHub hours ago and now sees the same two changes, plus one of its own
    const kept = on("pc", () => dropReported([news("ci_passed"), news("merged"), news("commented")], readEvents(), lastRead));
    expect(kept.map((b) => b.type === "pr.change" && b.change)).toEqual(["commented"]);
    // a change reported before the pc's last reading is a different one
    expect(on("pc", () => dropReported([news("merged")], readEvents(), new Date(Date.now() + 1000).toISOString()))).toHaveLength(1);
    // this machine's own earlier news never hides its new news
    expect(on("mac", () => dropReported([news("merged")], readEvents(), lastRead))).toHaveLength(1);
  });

  it("a run on one machine shows on the other with its machine, until that machine goes quiet", () => {
    const now = Date.now();
    const lead: Run = {
      id: "c004f2a7-1111-2222",
      runtime: "claude-code",
      kind: "session",
      title: "spill director",
      state: "working",
      lastActivity: new Date(now - 60_000).toISOString(),
      activity: [1, 2],
      touched: ["C:\\Users\\pc\\dev\\spill"],
    };
    on("pc", () => shareRuns([lead], now));
    on("pc", () => claimSession({ session: "c004f2a7", project: "spill", role: "lead", title: "Spill Director" }));
    both();
    const seen = on("mac", () => otherRuns(readState(), now + 2 * 60_000));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: lead.id, device: "pc", project: "spill", role: "lead", title: "Spill Director", state: "working" });
    // the chart slides by the summary's age, and the other machine's folders stay there
    expect(seen[0]!.activity).toEqual([3, 4]);
    expect(seen[0]!.touched).toBeUndefined();
    // a machine never reads its own summary back
    expect(on("pc", () => otherRuns(readState(), now))).toHaveLength(0);
    // a machine that stopped writing is left out
    expect(on("mac", () => otherRuns(readState(), now + SHARED_RUNS_GONE_MS + 1000))).toHaveLength(0);
  });

  describe("runs the other machine shared", () => {
    const lead = (now: number, minutesAgo: number): Run => ({
      id: "c004f2a7-1111-2222",
      runtime: "claude-code",
      kind: "session",
      title: "spill director",
      state: "idle",
      lastActivity: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    // the summary a machine writes for the others (shareRuns itself writes at most every 30 seconds)
    const share = (m: Machine, runs: Run[], at: number) => {
      // the sync tool carries it at once, so both copies of the folder get it
      for (const to of machines) {
        const dir = path.join(shared(to), "runs");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${m}.json`), JSON.stringify({ v: 1, device: m, at: new Date(at).toISOString(), runs }));
      }
    };
    // no local adapters: only declared runs and what the other machine shared
    const list = (m: Machine, now: number, all = false) => on(m, () => collectRuns(readState(), { sinceHours: 24, runtimes: ["none"], includeEnded: all }, now));

    it("a lead that claimed done drops after half an hour, an idle lead stays", () => {
      const now = Date.now();
      share("pc", [lead(now, 45)], now);
      on("pc", () => claimSession({ session: "c004f2a7", project: "spill", role: "lead" }));
      both();
      expect(list("mac", now).map((r) => r.id)).toEqual(["c004f2a7-1111-2222"]);
      on("pc", () => claimSession({ session: "c004f2a7", done: "finished" }));
      both();
      expect(list("mac", now)).toHaveLength(0);
      expect(list("mac", now, true)).toHaveLength(1);
      // a done lead is still listed in its first half hour
      share("pc", [lead(now, 10)], now);
      both();
      expect(list("mac", now).map((r) => r.state)).toEqual(["done"]);
    });

    it("hiding on one machine hides the other machine's run until it does something new", () => {
      const now = Date.now();
      share("pc", [lead(now, 1)], now);
      on("pc", () => claimSession({ session: "c004f2a7", project: "spill", role: "lead" }));
      both();
      expect(list("mac", now)).toHaveLength(1);
      expect(on("mac", () => hideRun("c004f2a7"))).toBe("c004f2a7-1111-2222");
      both();
      expect(list("mac", now)).toHaveLength(0);
      expect(list("pc", now)).toHaveLength(0);
      expect(list("mac", now, true)).toHaveLength(1);
      // it does something new
      const later = Date.now() + 5000;
      share("pc", [lead(later, 0)], later);
      both();
      expect(list("mac", later).map((r) => r.id)).toEqual(["c004f2a7-1111-2222"]);
      // unhide brings back a run that has not moved
      share("pc", [lead(now, 1)], now);
      both();
      on("mac", () => hideRun("c004f2a7"));
      expect(list("mac", now)).toHaveLength(0);
      on("mac", () => unhideRun("c004"));
      expect(list("mac", now)).toHaveLength(1);
    });
  });

  it("runs declared on either machine get their own ids and can be ended by the short id", () => {
    const id = on("pc", () => startRun({ project: "spill", title: "bake" }));
    expect(id).toBe("pc-r1");
    on("pc", () => endRun("r1", "done"));
    expect(on("pc", () => readState().runs.get("pc-r1")!.status)).toBe("done");
  });

  it("status and doctor report the other machine and conflict copies", async () => {
    on("pc", () => openCard({ kind: "todo", project: "a", title: "x" }));
    both();
    fs.writeFileSync(path.join(shared("mac"), "events", "pc.sync-conflict-20261109-101010-ABCDEFG.jsonl"), "");
    // a conflict copy is never read as a machine's log
    expect(on("mac", () => eventFiles().map((f) => f.device))).toEqual(["mac", "pc"]);
    const st = await on("mac", () => syncStatus());
    expect(st).toMatchObject({ adapter: "folder", device: "mac", ok: true });
    expect(st!.peers.map((p) => p.name)).toEqual(["pc"]);
    expect(st!.conflicts).toHaveLength(1);
    expect(findConflicts(shared("mac"))[0]).toContain("sync-conflict");
    const checks = await on("mac", () => doctor({ version: "0.3.0", targets: [], gh: async () => "", claudeSettings: [], cwd: root, sync: st }));
    const sync = checks.filter((c) => c.area === "sync");
    expect(sync.map((c) => c.state)).toEqual(["ok", "warn"]);
    expect(sync[0]!.text).toContain("pc");
  });

  it("closing on one machine closes everywhere", () => {
    on("mac", () => openCard({ kind: "todo", project: "a", title: "x" }));
    carry("mac", "pc");
    on("pc", () => closeCard("c1", "done"));
    carry("pc", "mac");
    expect(on("mac", () => readState().cards.get("mac-c1")!.status)).toBe("closed");
  });

  it("an old cursor (seq only) reads as this machine's position", () => {
    on("mac", () => {
      fs.mkdirSync(path.join(home("mac"), "cursors"), { recursive: true });
      fs.writeFileSync(path.join(home("mac"), "cursors", "old.json"), JSON.stringify({ seq: 7 }));
      expect(readCursor("old")).toEqual({ mac: 7 });
      writeCursor("old", { mac: 8, pc: 2 });
      expect(readCursor("old")).toEqual({ mac: 8, pc: 2 });
    });
  });
});

describe("the Syncthing adapter", () => {
  it("reads the GUI address and key from config.xml", () => {
    const dir = path.join(root, "st");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.xml"), `<configuration><gui enabled="true" tls="false"><address>127.0.0.1:8385</address><apikey>k3y</apikey></gui></configuration>`);
    expect(readSyncthingGui(dir)).toMatchObject({ url: "http://127.0.0.1:8385", apiKey: "k3y" });
  });

  it("reports the folder, the other device and when it was last in step", async () => {
    on("mac", () => setupSync({ dir: shared("mac"), device: "mac", adapter: "syncthing" }));
    const top = path.dirname(shared("mac"));
    const replies: Record<string, unknown> = {
      "/rest/config/folders": [{ id: "agent-sync", label: "agent-sync", path: top, devices: [{ deviceID: "ME" }, { deviceID: "PC" }] }],
      "/rest/system/status": { myID: "ME" },
      "/rest/config/devices": [
        { deviceID: "ME", name: "mac" },
        { deviceID: "PC", name: "winpc" },
      ],
      "/rest/system/connections": { connections: { PC: { connected: true, address: "192.168.1.20:22000" } } },
      "/rest/stats/device": { PC: { lastSeen: "2026-11-09T10:00:00Z" } },
      "/rest/db/status": { state: "idle", stateChanged: "2026-11-09T10:01:00Z", needFiles: 0, errors: 0 },
      "/rest/stats/folder": { "agent-sync": { lastFile: { at: "2026-11-09T10:00:30Z" } } },
    };
    const keys: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      keys.push(String((init?.headers as Record<string, string>)["X-API-Key"]));
      const p = new URL(url).pathname;
      return new Response(JSON.stringify(replies[p]), { status: p in replies ? 200 : 404 });
    }) as typeof fetch;
    process.env.PARAWATCH_SYNCTHING_KEY = "secret";
    try {
      const st = await on("mac", () => syncStatus({ fetch: fake }));
      expect(st).toMatchObject({ adapter: "syncthing", ok: true, lastSync: "2026-11-09T10:01:00Z" });
      expect(st!.peers).toEqual([expect.objectContaining({ name: "winpc", connected: true, address: "192.168.1.20:22000" })]);
      expect(st!.error).toBeUndefined();
      expect(new Set(keys)).toEqual(new Set(["secret"]));
      // Syncthing down
      const down = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      expect(await on("mac", () => syncStatus({ fetch: down }))).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
    } finally {
      delete process.env.PARAWATCH_SYNCTHING_KEY;
    }
  });
});
