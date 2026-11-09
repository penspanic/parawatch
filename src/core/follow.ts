import fs from "node:fs";
import { endOf, eventFiles, eventsDir, isAfter, parseEventLines, readEvents, type Position } from "./store.js";
import type { PwEvent } from "./types.js";

/**
 * Call `onEvent` for every event appended after `after` (or after the current end when it is
 * undefined), in any machine's log. Watches the log folder and also checks once a second, so a
 * log a sync tool brings in from another machine shows up too. Returns a stop function.
 */
export function followEvents(onEvent: (ev: PwEvent) => void, after?: Position): () => void {
  const offsets = new Map<string, number>();
  let pos: Position = after ?? endOf(readEvents());
  const pump = () => {
    for (const f of eventFiles()) {
      let size = 0;
      try {
        size = fs.statSync(f.file).size;
      } catch {
        continue;
      }
      let offset = offsets.get(f.file) ?? 0;
      if (size < offset) offset = 0; // file replaced
      if (size === offset) continue;
      const fd = fs.openSync(f.file, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const cut = text.lastIndexOf("\n");
      if (cut < 0) continue;
      offsets.set(f.file, offset + Buffer.byteLength(text.slice(0, cut + 1)));
      for (const ev of parseEventLines(text.slice(0, cut + 1), f.device)) {
        if (!isAfter(ev, pos)) continue;
        pos = { ...pos, [f.device]: ev.seq };
        onEvent(ev);
      }
    }
  };
  pump();
  let watcher: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(eventsDir(), { recursive: true });
    watcher = fs.watch(eventsDir(), () => pump());
  } catch {
    watcher = undefined; // the timer alone still works
  }
  const timer = setInterval(pump, 1000);
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}
