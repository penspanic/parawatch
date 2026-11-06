import fs from "node:fs";
import { eventsPath, homeDir, parseEventLines } from "./store.js";
import type { PwEvent } from "./types.js";

/**
 * Call `onEvent` for every event appended after `afterSeq` (or after the current end when it is
 * undefined). Watches the store folder and also checks once a second. Returns a stop function.
 */
export function followEvents(onEvent: (ev: PwEvent) => void, afterSeq?: number): () => void {
  const file = eventsPath();
  let offset = 0;
  let lastSeq = afterSeq ?? Infinity;
  try {
    const text = fs.readFileSync(file, "utf8");
    offset = Buffer.byteLength(text);
    const events = parseEventLines(text);
    const end = events[events.length - 1]?.seq ?? 0;
    if (afterSeq === undefined) lastSeq = end;
    else {
      for (const ev of events) if (ev.seq > afterSeq) onEvent(ev);
      lastSeq = Math.max(afterSeq, end);
    }
  } catch {
    lastSeq = afterSeq ?? 0;
  }
  const pump = () => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // file replaced
    if (size === offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const cut = text.lastIndexOf("\n");
    if (cut < 0) return;
    offset += Buffer.byteLength(text.slice(0, cut + 1));
    for (const ev of parseEventLines(text.slice(0, cut + 1))) {
      if (ev.seq > lastSeq) {
        onEvent(ev);
        lastSeq = ev.seq;
      }
    }
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    watcher = fs.watch(homeDir(), () => pump());
  } catch {
    watcher = undefined; // the timer alone still works
  }
  const timer = setInterval(pump, 1000);
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}
