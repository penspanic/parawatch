import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayClient, RelayMirror, joinCode, newKey, open, readJoinCode, seal, sealedName, type RelayConfig } from "../src/core/relay.js";
import { createRelayServer } from "../src/relay/server.js";

let root: string;
let server: http.Server;
let url: string;
const INVITE = "test-invite";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-relay-"));
  server = createRelayServer({ dataDir: path.join(root, "server"), invite: INVITE });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

/** The keys a mirror derives, reached through a sealed round trip (they are not exported). */
function keysFor(key: string) {
  return (new RelayMirror({ dir: root, config: { url, space: "x", token: "x", key }, stateFile: path.join(root, "k.json") }) as unknown as { keys: Parameters<typeof seal>[0] }).keys;
}

async function space(): Promise<RelayConfig> {
  const made = await RelayClient.createSpace(url, INVITE);
  return { url, ...made, key: newKey() };
}

function machine(name: string, c: RelayConfig) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const m = new RelayMirror({ dir, config: c, stateFile: path.join(root, `${name}-state.json`) });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (rel: string) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : undefined);
  return { dir, m, write, read };
}

describe("sealing", () => {
  it("opens what it sealed, and nothing else", () => {
    const k = keysFor(newKey());
    const box = seal(k, "events/mac.jsonl", Buffer.from("hello"));
    expect(open(k, box)).toEqual({ rel: "events/mac.jsonl", data: Buffer.from("hello") });
    expect(box.includes(Buffer.from("events/mac"))).toBe(false);
    const bent = Buffer.from(box);
    bent[bent.length - 1] = bent[bent.length - 1]! ^ 1;
    expect(() => open(k, bent)).toThrow();
    expect(() => open(keysFor(newKey()), box)).toThrow();
    expect(sealedName(k, "a")).toMatch(/^[a-f0-9]{40}$/);
    expect(sealedName(k, "a")).not.toBe(sealedName(keysFor(newKey()), "a"));
  });

  it("carries a relay in a join code", () => {
    const c = { url: "https://relay.example", space: "a".repeat(24), token: "t", key: newKey() };
    expect(readJoinCode(joinCode(c))).toEqual(c);
    expect(() => readJoinCode("pwr1.nonsense")).toThrow(/cut short/);
    expect(() => readJoinCode("hello")).toThrow(/starts with pwr1/);
  });
});

describe("the relay server", () => {
  it("makes a space only with its invite, and keeps out a wrong token", async () => {
    await expect(RelayClient.createSpace(url, "nope")).rejects.toThrow(/needs its invite/);
    const c = await space();
    await expect(new RelayClient({ ...c, token: "wrong" }).changes(0)).rejects.toThrow(/wrong token/);
    expect((await new RelayClient(c).changes(0)).head).toBe(0);
  });

  it("keeps files, lists what changed after a point, and forgets deleted ones", async () => {
    const r = new RelayClient(await space());
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(await r.put(a, Buffer.from("one"))).toBe(1);
    expect(await r.put(b, Buffer.from("two"))).toBe(2);
    expect(await r.put(a, Buffer.from("three"))).toBe(3);
    expect((await r.get(a)).toString()).toBe("three");
    expect((await r.changes(1)).changes.map((c) => [c.name, c.seq])).toEqual([
      [b, 2],
      [a, 3],
    ]);
    await r.remove(b);
    expect((await r.changes(3)).changes).toEqual([{ name: b, seq: 4, deleted: true }]);
    await expect(r.get(b)).rejects.toThrow(/no such file/);
    await expect(r.put("../x", Buffer.from("x"))).rejects.toThrow();
  });

  it("holds a request for changes until one comes", async () => {
    const r = new RelayClient(await space());
    const t0 = Date.now();
    const waiting = r.changes(0, 10);
    setTimeout(() => void r.put("c".repeat(40), Buffer.from("x")), 150);
    const got = await waiting;
    expect(got.changes).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("reads its spaces back after a restart", async () => {
    const c = await space();
    await new RelayClient(c).put("d".repeat(40), Buffer.from("kept"));
    const again = createRelayServer({ dataDir: path.join(root, "server") });
    await new Promise<void>((r) => again.listen(0, "127.0.0.1", r));
    const r2 = new RelayClient({ ...c, url: `http://127.0.0.1:${(again.address() as AddressInfo).port}` });
    expect((await r2.get("d".repeat(40))).toString()).toBe("kept");
    expect((await r2.changes(0)).head).toBe(1);
    await new Promise((r) => again.close(r));
  });
});

describe("two machines through a relay", () => {
  it("brings each machine's files to the other, deletions too, and the server sees no names or contents", async () => {
    const c = await space();
    const mac = machine("mac", c);
    const pc = machine("pc", c);
    mac.write("events/mac.jsonl", '{"seq":1,"type":"card.asked","title":"Ship it?"}\n');
    mac.write("attachments/shot.png", "PNGDATA");
    await mac.m.once();
    await pc.m.once();
    expect(pc.read("events/mac.jsonl")).toContain("Ship it?");
    expect(pc.read("attachments/shot.png")).toBe("PNGDATA");

    pc.write("events/pc.jsonl", '{"seq":1,"type":"card.answered"}\n');
    await pc.m.once();
    await mac.m.once();
    expect(mac.read("events/pc.jsonl")).toContain("card.answered");

    fs.rmSync(path.join(mac.dir, "attachments/shot.png"));
    await mac.m.once();
    await pc.m.once();
    expect(pc.read("attachments/shot.png")).toBeUndefined();

    const stored = fs
      .readdirSync(path.join(root, "server"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name)).toString("latin1"))
      .join("\n");
    for (const secret of ["Ship it", "card.answered", "events/mac", "attachments", "PNGDATA"]) expect(stored).not.toContain(secret);
  });

  it("a change made here and not yet sent wins over one that came in", async () => {
    const c = await space();
    const mac = machine("mac", c);
    const pc = machine("pc", c);
    mac.write("runs/mac.json", "first");
    await mac.m.once();
    await pc.m.once();
    pc.write("runs/mac.json", "changed on pc");
    mac.write("runs/mac.json", "second");
    await mac.m.once();
    await pc.m.pull();
    expect(pc.read("runs/mac.json")).toBe("changed on pc");
  });

  it("leaves hidden and temporary files alone, and deletes nothing when the folder reads empty", async () => {
    const c = await space();
    const mac = machine("mac", c);
    const pc = machine("pc", c);
    mac.write("events/mac.jsonl", "x\n");
    mac.write("events/.mac.123.tmp", "half");
    mac.write("runs/mac.sync-conflict-20261111-1.json", "copy");
    await mac.m.once();
    await pc.m.once();
    expect(fs.readdirSync(path.join(pc.dir, "events"))).toEqual(["mac.jsonl"]);
    expect(fs.existsSync(path.join(pc.dir, "runs"))).toBe(false);

    fs.rmSync(mac.dir, { recursive: true });
    fs.mkdirSync(mac.dir);
    await expect(mac.m.push()).rejects.toThrow(/reads as empty/);
    await pc.m.once();
    expect(pc.read("events/mac.jsonl")).toBe("x\n");
  });

  it("does not write a file outside the folder whatever path a sealed file names", async () => {
    const c = await space();
    const k = keysFor(c.key);
    await new RelayClient(c).put(sealedName(k, "../escape.txt"), seal(k, "../escape.txt", Buffer.from("x")));
    const pc = machine("pc", c);
    await pc.m.pull();
    expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
  });
});
