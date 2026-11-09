// Versions, update checks, the store format guard, doctor, and taking parawatch out again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readClient, recordClient, runningDesktop, versionSkew } from "../src/core/clients.js";
import { doctor, doctorText } from "../src/core/doctor.js";
import { instructionState, instructions, removeInstructions, writeInstructions } from "../src/core/integrate.js";
import { addProject, UserError } from "../src/core/ops.js";
import { compareVersions } from "../src/core/semver.js";
import { installSkill, skillSource, skillState, uninstallSkill, type SkillTarget } from "../src/core/skill.js";
import { eventsPath, homeDir, readEvents } from "../src/core/store.js";
import { checkUpdate, updateLine, type Fetcher } from "../src/core/update.js";
import { packageVersion } from "../src/core/version.js";
import { freshHome } from "./helpers.js";

beforeEach(() => {
  freshHome();
  delete process.env.PARAWATCH_UPDATE_CHECK;
  delete process.env.CI;
  process.env.PARAWATCH_GITHUB = "0";
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "parawatch-upkeep-"));

describe("versions", () => {
  it("reads its own version from package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(packageVersion()).toBe(pkg.version);
  });

  it("compares x.y.z versions, a pre-release before its release", () => {
    expect(compareVersions("0.2.1", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
  });

  it("says which copy to update when the app and the command line differ", () => {
    expect(versionSkew("0.2.1", "0.2.1")).toBeUndefined();
    expect(versionSkew("0.2.0", "0.2.1")?.older).toBe("cli");
    expect(versionSkew("0.2.0", "0.2.1")?.text).toContain("npm i -g parawatch@latest");
    expect(versionSkew("0.3.0", "0.2.1")?.older).toBe("desktop");
    expect(versionSkew(undefined, "0.2.1")).toBeUndefined();
  });

  it("keeps a note per copy and rewrites it only when something changed", () => {
    recordClient({ name: "cli", version: "0.2.1", path: "/bin/parawatch" }, Date.parse("2026-11-09T00:00:00Z"));
    recordClient({ name: "cli", version: "0.2.1", path: "/bin/parawatch" }, Date.parse("2026-11-09T01:00:00Z"));
    expect(readClient("cli")?.at).toBe("2026-11-09T00:00:00.000Z");
    recordClient({ name: "cli", version: "0.2.2", path: "/bin/parawatch" }, Date.parse("2026-11-09T02:00:00Z"));
    expect(readClient("cli")?.version).toBe("0.2.2");
  });

  it("sees the desktop app only while its process lives", () => {
    recordClient({ name: "desktop", version: "0.2.1", pid: process.pid });
    expect(runningDesktop()?.version).toBe("0.2.1");
    recordClient({ name: "desktop", version: "0.2.1", pid: 2 ** 22 + 12345 });
    expect(runningDesktop()).toBeUndefined();
  });
});

describe("update checks", () => {
  const registry = (version: string, calls: string[] = []): Fetcher => async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ version }) };
  };

  it("asks the registry once a day and remembers the answer", async () => {
    const calls: string[] = [];
    const now = Date.parse("2026-11-09T00:00:00Z");
    const a = await checkUpdate("0.2.1", { now, fetch: registry("0.2.2", calls) });
    expect(a).toMatchObject({ latest: "0.2.2", newer: true });
    const b = await checkUpdate("0.2.1", { now: now + 3_600_000, fetch: registry("0.2.3", calls) });
    expect(b?.latest).toBe("0.2.2");
    expect(calls).toHaveLength(1);
    const c = await checkUpdate("0.2.1", { now: now + 25 * 3_600_000, fetch: registry("0.2.3", calls) });
    expect(c?.latest).toBe("0.2.3");
    expect(updateLine(c)).toBe("parawatch 0.2.3 is out (this is 0.2.1): npm i -g parawatch@latest");
  });

  it("is quiet when this is the newest", async () => {
    const u = await checkUpdate("0.2.1", { fetch: registry("0.2.1") });
    expect(u?.newer).toBe(false);
    expect(updateLine(u)).toBeUndefined();
  });

  it("never fails a command and tries again within the hour after an error", async () => {
    const now = Date.parse("2026-11-09T00:00:00Z");
    const down: Fetcher = async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    };
    const u = await checkUpdate("0.2.1", { now, fetch: down });
    expect(u).toMatchObject({ newer: false, error: expect.stringContaining("ENOTFOUND") });
    const calls: string[] = [];
    await checkUpdate("0.2.1", { now: now + 30 * 60_000, fetch: registry("0.2.2", calls) });
    expect(calls).toHaveLength(0);
    const later = await checkUpdate("0.2.1", { now: now + 61 * 60_000, fetch: registry("0.2.2", calls) });
    expect(later?.latest).toBe("0.2.2");
  });

  it("stays off when turned off, and in CI", async () => {
    const calls: string[] = [];
    process.env.PARAWATCH_UPDATE_CHECK = "0";
    expect(await checkUpdate("0.2.1", { fetch: registry("0.2.2", calls) })).toBeUndefined();
    delete process.env.PARAWATCH_UPDATE_CHECK;
    process.env.CI = "true";
    expect(await checkUpdate("0.2.1", { fetch: registry("0.2.2", calls) })).toBeUndefined();
    delete process.env.CI;
    fs.writeFileSync(path.join(homeDir(), "config.json"), JSON.stringify({ updates: { check: false } }));
    expect(await checkUpdate("0.2.1", { fetch: registry("0.2.2", calls) })).toBeUndefined();
    expect(calls).toHaveLength(0);
    // doctor asks anyway
    expect((await checkUpdate("0.2.1", { force: true, fetch: registry("0.2.2", calls) }))?.newer).toBe(true);
  });
});

describe("the store format", () => {
  it("refuses to write into a log a newer version wrote, and still reads it", () => {
    addProject("game", ["/work/game"]);
    fs.appendFileSync(eventsPath(), JSON.stringify({ v: 3, seq: 99, ts: new Date().toISOString(), type: "something.new" }) + "\n");
    expect(readEvents()).toHaveLength(2);
    expect(() => addProject("app", ["/work/app"])).toThrow(UserError);
    expect(() => addProject("app", ["/work/app"])).toThrow(/newer parawatch/);
  });
});

describe("taking it out again", () => {
  it("removes the instruction block and leaves the rest of the file", () => {
    const dir = tmp();
    const f = path.join(dir, "AGENTS.md");
    fs.writeFileSync(f, "# Notes\n\nKeep this.\n");
    writeInstructions(f, "game");
    expect(instructionState(f)).toBe("current");
    fs.appendFileSync(f, "\n## After\n\nAnd this.\n");
    expect(removeInstructions(f)).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("# Notes\n\nKeep this.\n\n## After\n\nAnd this.\n");
    expect(removeInstructions(f)).toBe(false);
    expect(instructionState(f)).toBe("absent");
  });

  it("tells an old block from the current one", () => {
    const f = path.join(tmp(), "CLAUDE.md");
    fs.writeFileSync(f, instructions("game").replace("Claim again", "Claim once more") + "\n");
    expect(instructionState(f)).toBe("outdated");
    writeInstructions(f, "game");
    expect(instructionState(f)).toBe("current");
    fs.writeFileSync(f, instructions() + "\n");
    expect(instructionState(f)).toBe("current");
  });

  it("removes only the links install made", () => {
    const root = tmp();
    const target = (runtime: string): SkillTarget => ({ runtime, dir: path.join(root, runtime, "skills"), home: path.join(root, runtime) });
    const claude = target("claude-code");
    const codex = target("codex");
    const other = target("other");
    for (const t of [claude, codex, other]) fs.mkdirSync(t.home, { recursive: true });
    installSkill([claude]);
    expect(skillState(claude).state).toBe("linked");
    fs.mkdirSync(path.join(codex.dir, "parawatch"), { recursive: true });
    fs.writeFileSync(path.join(codex.dir, "parawatch", "SKILL.md"), "my own copy");
    fs.mkdirSync(other.dir, { recursive: true });
    fs.symlinkSync(root, path.join(other.dir, "parawatch"));
    const out = uninstallSkill([claude, codex, other, target("missing")]);
    expect(out.map((r) => r.result)).toEqual(["removed", "skipped", "skipped", "not installed"]);
    expect(fs.existsSync(path.join(claude.dir, "parawatch"))).toBe(false);
    expect(fs.readFileSync(path.join(codex.dir, "parawatch", "SKILL.md"), "utf8")).toBe("my own copy");
    expect(skillState(codex).state).toBe("folder");
    expect(skillSource()).toMatch(/skills[/\\]parawatch$/);
  });
});

describe("doctor", () => {
  it("names what needs work and what to run", async () => {
    const root = tmp();
    const t: SkillTarget = { runtime: "claude-code", dir: path.join(root, ".claude", "skills"), home: path.join(root, ".claude") };
    fs.mkdirSync(t.home, { recursive: true });
    recordClient({ name: "desktop", version: "0.2.2", pid: process.pid, log: "/logs/main.log" });
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), instructions("game").replace("Claim again", "Claim once more") + "\n");
    const checks = await doctor({
      version: "0.2.1",
      update: { current: "0.2.1", latest: "0.2.2", newer: true },
      targets: [t],
      cwd,
      claudeSettings: [],
    });
    const by = (area: string) => checks.find((c) => c.area === area);
    expect(by("updates")).toMatchObject({ state: "warn", fix: "npm i -g parawatch@latest" });
    expect(by("desktop")).toMatchObject({ state: "ok", text: expect.stringContaining("0.2.2 is running") });
    expect(by("versions")?.state).toBe("warn");
    expect(by("skill:claude-code")).toMatchObject({ state: "warn", fix: "parawatch skill install" });
    expect(by("instructions")).toMatchObject({ state: "warn", fix: "parawatch init -f AGENTS.md" });
    expect(by("hook")?.state).toBe("info");
    expect(by("github")?.state).toBe("off");
    expect(by("store")?.text).toContain(homeDir());
    const text = doctorText(checks);
    expect(text).toContain("! updates");
    expect(text).toContain("→ npm i -g parawatch@latest");
  });

  it("finds gh missing without failing", async () => {
    delete process.env.PARAWATCH_GITHUB;
    const checks = await doctor({
      version: "0.2.1",
      targets: [],
      cwd: tmp(),
      claudeSettings: [],
      gh: async () => {
        throw new Error("spawn gh ENOENT");
      },
    });
    expect(checks.find((c) => c.area === "github")).toMatchObject({ state: "off", text: expect.stringContaining("gh not found") });
  });
});
