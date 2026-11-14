/**
 * The panel's backend on a phone: answers and the rest are events in the phone's own log, sent
 * through the relay. What only a machine can do (open a file, jump into a session, run Codex) says
 * where to do it instead.
 */
import type { Backend, Reply, Run } from "@parawatch/panel";
import type { Space } from "./space";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function phoneBackend(space: Space, openUrl: (url: string) => void, notice: (m: string) => void): Backend {
  const card = (id: string) => {
    const c = space.state().cards.get(id);
    if (!c) throw new Error(`No card ${id} here yet`);
    return c;
  };
  const runOf = (id: string): Run | undefined => {
    const runs = space.snapshot().runs;
    const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
    let r = runs.find((x) => same(x.id, id));
    // a subagent opens the session it works under
    const seen = new Set<string>();
    while (r?.parent && !seen.has(r.id)) {
      seen.add(r.id);
      const up = runs.find((x) => x.id === r!.parent);
      if (!up) break;
      r = up;
    }
    return r;
  };
  const media = new Map<string, Promise<string | undefined>>();

  return {
    snapshot: async () => space.snapshot(),

    async answer(id: string, reply: Reply) {
      const c = card(id);
      if (c.status === "closed") throw new Error(`Card ${id} is already closed`);
      if (reply.attach?.length) throw new Error("Pictures can only be attached from a computer for now");
      const comment = reply.comment?.trim() || undefined;
      if (reply.choice === undefined && !comment) throw new Error("Pick an option or write a note");
      if (reply.choice !== undefined && (!Number.isInteger(reply.choice) || reply.choice < 1 || reply.choice > (c.options?.length ?? 0))) throw new Error("That option is not on the card");
      const seen = space.events().filter((e) => e.type === "card.answer" && e.card === id).length;
      await space.append({ type: "card.answer", card: id, by: "human", choice: reply.choice, comment, seen });
    },

    async dismiss(id: string) {
      const c = card(id);
      if (c.status === "closed") throw new Error(`Card ${id} is already closed`);
      await space.append({ type: "card.close", card: id, dismissed: true });
    },

    async hideRun(id: string) {
      await space.append({ type: "run.hide", run: id });
    },

    async goto(target: string) {
      const c = space.state().cards.get(target);
      const r = runOf(c?.session ?? target);
      if (r?.remote) {
        openUrl(r.remote);
        return "Opened in Claude";
      }
      throw new Error(r?.device ? `Open it on ${r.device}: this session has no Remote Control link` : "That session is not here");
    },

    open(target: string) {
      if (URL_RE.test(target)) return openUrl(target);
      notice("That is a file or app on a computer; open it there");
    },

    mediaUrl(file: string) {
      let p = media.get(file);
      if (!p) {
        p = (async () => {
          const c = [...space.state().cards.values()].find((x) => x.attach?.includes(file));
          const rel = space.sharedPath(file, c?.dev);
          if (!rel) return undefined;
          const bytes = await space.fileBytes(rel).catch(() => undefined);
          if (!bytes) return undefined;
          const ext = rel.split(".").pop()?.toLowerCase() ?? "";
          return URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" }));
        })();
        media.set(file, p);
        // a failed reading may work later
        void p.then((u) => {
          if (!u) media.delete(file);
        });
      }
      return p;
    },

    async saveAttachment() {
      throw new Error("Pictures can only be attached from a computer for now");
    },

    droppedPath: () => undefined,
  };
}
