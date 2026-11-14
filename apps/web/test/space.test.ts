import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayClient, RelayMirror, joinCode, newKey, open as nodeOpen, seal as nodeSeal, sealedName as nodeName, type RelayConfig } from "../../../src/core/relay.js";
import { parseEventLines } from "../../../src/core/log.js";
import { fold } from "../../../src/core/state.js";
import { createRelayServer } from "../../../src/relay/server.js";
import { phoneBackend } from "../src/backend";
import { keysOf, open, readJoinCode, seal, sealedName } from "../src/seal";
import { NameTaken, Space, type Store } from "../src/space";

let root: string;
let server: http.Server;
let url: string;
const INVITE = "test-invite";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-web-"));
  server = createRelayServer({ dataDir: path.join(root, "server"), invite: INVITE });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** The keys a node mirror derives (they are not exported). */
function nodeKeys(key: string) {
  return (new RelayMirror({ dir: root, config: { url, space: "x", token: "x", key }, stateFile: path.join(root, "k.json") }) as unknown as { keys: Parameters<typeof nodeSeal>[0] }).keys;
}

describe("sealing in the browser", () => {
  it("matches the machines: names, boxes both ways, and join codes", async () => {
    const key = newKey();
    const web = await keysOf(key);
    const node = nodeKeys(key);
    expect(await sealedName(web, "events/mac.jsonl")).toBe(nodeName(node, "events/mac.jsonl"));
    const fromNode = nodeSeal(node, "runs/mac.json", Buffer.from("hello"));
    const opened = await open(web, new Uint8Array(fromNode));
    expect(opened.rel).toBe("runs/mac.json");
    expect(Buffer.from(opened.data).toString()).toBe("hello");
    const fromWeb = await seal(web, "events/phone.jsonl", new TextEncoder().encode("hi"));
    expect(nodeOpen(node, Buffer.from(fromWeb))).toEqual({ rel: "events/phone.jsonl", data: Buffer.from("hi") });
    const bent = new Uint8Array(fromWeb);
    bent[bent.length - 1]! ^= 1;
    await expect(open(web, bent)).rejects.toThrow();
    const c = { url: "https://relay.example", space: "a".repeat(24), token: "t", key };
    expect(readJoinCode(joinCode(c))).toEqual(c);
    expect(() => readJoinCode("hello")).toThrow(/pwr1/);
  });
});

describe("a phone on the relay", () => {
  async function folder() {
    const made = await RelayClient.createSpace(url, INVITE);
    const c: RelayConfig = { url, ...made, key: newKey() };
    const dir = path.join(root, "mac");
    const write = (rel: string, text: string | Buffer) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    const now = new Date().toISOString();
    write("devices/mac.json", JSON.stringify({ name: "mac", platform: "darwin", host: "h", home: "/Users/me", shared: dir, version: "0.3.16", at: now }));
    write(
      "events/mac.jsonl",
      [
        { v: 2, seq: 1, ts: now, type: "card.open", card: { id: "mac-c1", kind: "decide", project: "app", title: "Ship it?", options: ["Yes", "No"], attach: [path.join(dir, "attachments/shot.png")], session: "s1" } },
        { v: 2, seq: 2, ts: now, type: "card.open", card: { id: "mac-c2", kind: "todo", project: "app", title: "Pay the bill" } },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    write("runs/mac.json", JSON.stringify({ v: 1, device: "mac", at: now, runs: [{ id: "s1", runtime: "claude-code", kind: "session", title: "App work", project: "app", state: "working", lastActivity: now, remote: "https://claude.ai/code/x" }] }));
    write("listeners/mac-42.json", JSON.stringify({ consumer: "session-s1", session: "s1", scope: "session", pid: 42, since: now, device: "mac", beat: now }));
    // a picture bigger than what the phone opens to learn a path
    write("attachments/shot.png", Buffer.alloc(9000, 7));
    const mac = new RelayMirror({ dir, config: c, stateFile: path.join(root, "mac-state.json") });
    await mac.once();
    return { c, dir, mac };
  }

  it("shows the cards, runs and waits of the machines, and its answers reach them", async () => {
    const { c, dir, mac } = await folder();
    const store = memoryStore();
    const phone = new Space({ config: readJoinCode(joinCode(c)), device: "phone", version: "test", store });
    await phone.start();
    const snap = phone.snapshot();
    expect(snap.cards.map((x) => x.id).sort()).toEqual(["mac-c1", "mac-c2"]);
    expect(snap.cards.find((x) => x.id === "mac-c1")?.missing).toBeUndefined();
    expect(snap.runs.map((r) => [r.id, r.device])).toEqual([["s1", "mac"]]);
    expect(snap.listeners?.map((l) => l.session)).toEqual(["s1"]);
    expect(snap.devices).toEqual({ me: "phone", others: ["mac"] });

    const opened: string[] = [];
    const backend = phoneBackend(phone, (u) => opened.push(u), () => {});
    // the picture is opened only when the card shows it
    const pic = await phone.fileBytes("attachments/shot.png");
    expect(pic?.length).toBe(9000);
    await backend.answer("mac-c1", { choice: 1, comment: "go" });
    await backend.dismiss("mac-c2");
    expect(await backend.goto("mac-c1")).toBe("Opened in Claude");
    expect(opened).toEqual(["https://claude.ai/code/x"]);
    await expect(backend.answer("mac-c1", { choice: 3 })).rejects.toThrow(/not on the card/);

    await mac.once();
    const log = fs.readFileSync(path.join(dir, "events/phone.jsonl"), "utf8");
    const events = parseEventLines(log, "phone");
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "card.answer"],
      [2, "card.close"],
    ]);
    const state = fold([...parseEventLines(fs.readFileSync(path.join(dir, "events/mac.jsonl"), "utf8"), "mac"), ...events]);
    expect(state.cards.get("mac-c1")).toMatchObject({ status: "answered", answers: [{ by: "human", choice: 1, comment: "go", dev: "phone" }] });
    expect(state.cards.get("mac-c2")).toMatchObject({ status: "closed", dismissed: true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "devices/phone.json"), "utf8"))).toMatchObject({ name: "phone", platform: "web" });
  });

  it("follows what changes on a machine, and opens again from what it kept", async () => {
    const { c, dir, mac } = await folder();
    const store = memoryStore();
    const phone = new Space({ config: c, device: "phone", version: "test", store });
    await phone.start();
    let changed = 0;
    phone.onChange(() => changed++);
    const loop = phone.run();
    const later = new Date().toISOString();
    fs.appendFileSync(path.join(dir, "events/mac.jsonl"), JSON.stringify({ v: 2, seq: 3, ts: later, type: "card.close", card: "mac-c2" }) + "\n");
    await mac.once();
    for (let i = 0; i < 100 && phone.snapshot().cards.find((x) => x.id === "mac-c2")?.status !== "closed"; i++) await new Promise((r) => setTimeout(r, 30));
    expect(phone.snapshot().cards.find((x) => x.id === "mac-c2")?.status).toBe("closed");
    expect(changed).toBeGreaterThan(0);
    await phone.append({ type: "card.answer", card: "mac-c1", by: "human", choice: 2 });
    phone.stop();
    await loop;

    // a second opening, as after the app was closed: the paths are known, nothing is probed again
    const again = new Space({ config: c, device: "phone", version: "test", store });
    await again.start();
    expect(again.snapshot().cards.find((x) => x.id === "mac-c1")?.answers.map((a) => a.choice)).toEqual([2]);
    await again.append({ type: "card.comment", card: "mac-c1", by: "human", text: "and again" });
    await mac.once();
    expect(parseEventLines(fs.readFileSync(path.join(dir, "events/phone.jsonl"), "utf8")).map((e) => e.seq)).toEqual([1, 2]);

    // a fresh install cannot tell itself from a second browser, so it takes another name
    const fresh = new Space({ config: c, device: "phone", version: "test", store: memoryStore() });
    await expect(fresh.start()).rejects.toThrow(NameTaken);
  });

  it("writes nothing under a name another browser or machine uses", async () => {
    const { c, dir, mac } = await folder();
    const first = new Space({ config: c, device: "phone", version: "test", store: memoryStore() });
    await first.start();
    await first.append({ type: "card.answer", card: "mac-c1", by: "human", choice: 1 });
    // Safari and the home screen app keep apart: the second one is another browser
    const second = new Space({ config: c, device: "phone", version: "test", store: memoryStore() });
    await expect(second.start()).rejects.toThrow(NameTaken);
    await expect(second.append({ type: "card.answer", card: "mac-c1", by: "human", choice: 2 })).rejects.toThrow(/Still reading/);
    const machine = new Space({ config: c, device: "mac", version: "test", store: memoryStore() });
    await expect(machine.start()).rejects.toThrow(/a machine/);
    await mac.once();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "devices/mac.json"), "utf8")).platform).toBe("darwin");
    expect(parseEventLines(fs.readFileSync(path.join(dir, "events/phone.jsonl"), "utf8")).map((e) => (e as { choice?: number }).choice)).toEqual([1]);
  });

  it("sends answers given at once in order, stamps them after the card, and forgets listeners that left", async () => {
    const { c, dir, mac } = await folder();
    // a phone clock an hour behind the machines
    const phone = new Space({ config: c, device: "phone", version: "test", store: memoryStore(), now: () => Date.now() - 3600_000 });
    await phone.start();
    await Promise.all([1, 2, 3].map((n) => phone.append({ type: "card.comment", card: "mac-c1", by: "human", text: `n${n}` })));
    await mac.once();
    const events = parseEventLines(fs.readFileSync(path.join(dir, "events/phone.jsonl"), "utf8"), "phone");
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const state = fold([...parseEventLines(fs.readFileSync(path.join(dir, "events/mac.jsonl"), "utf8"), "mac"), ...events].sort((a, b) => a.ts.localeCompare(b.ts)));
    expect(state.cards.get("mac-c1")?.comments.map((x) => x.text)).toEqual(["n1", "n2", "n3"]);
    expect(phone.snapshot().listeners).toHaveLength(1);
    fs.rmSync(path.join(dir, "listeners/mac-42.json"));
    await mac.once();
    const loop = phone.run();
    for (let i = 0; i < 100 && phone.snapshot().listeners?.length; i++) await new Promise((r) => setTimeout(r, 30));
    phone.stop();
    await loop;
    expect(phone.snapshot().listeners).toEqual([]);
  });
});

