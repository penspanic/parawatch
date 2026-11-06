import { Marked } from "marked";
import { Panel, setIcon, type Backend, type Reply, type Snapshot } from "@parawatch/panel";
import type { ParawatchApi } from "./preload";

const api = (window as unknown as { parawatch: ParawatchApi }).parawatch;

/** Electron prefixes errors from the main process; show only what was said. */
function plain(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ""));
}

async function call<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw plain(err);
  }
}

// Card bodies are Markdown written by agents. Raw HTML in them is shown as text, not run.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
  },
});

function renderMarkdown(md: string, el: HTMLElement): void {
  el.innerHTML = markdown.parse(md, { async: false }) as string;
  for (const a of Array.from(el.querySelectorAll("a"))) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) void call(api.open(href)).catch((err) => toast(plain(err).message));
    });
  }
}

let toastTimer: number | undefined;
function toast(text: string): void {
  const box = document.getElementById("toast")!;
  box.textContent = text;
  box.classList.add("is-shown");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.classList.remove("is-shown"), 5000);
}

const backend: Backend = {
  snapshot: () => call(api.snapshot() as Promise<Snapshot>),
  answer: (card: string, reply: Reply) => call(api.answer(card, reply) as Promise<void>),
  goto: (target: string) => call(api.goto(target) as Promise<string>),
  open: (target: string) => void call(api.open(target)).catch((err) => toast(plain(err).message)),
  mediaUrl: (file: string) => call(api.mediaUrl(file) as Promise<string | undefined>),
  saveAttachment: (data: ArrayBuffer, ext: string) => call(api.saveAttachment(data, ext) as Promise<string>),
  droppedPath: (file: File) => api.droppedPath(file),
};

const panel = new Panel(document.getElementById("panel")!, backend, {
  renderMarkdown,
  icon: setIcon,
  notice: toast,
  refresh: () => void api.refresh(),
});

api.onSnapshot((s) => panel.update(s as Snapshot));
api.onError((e) => {
  if (e) panel.update(undefined, e);
});
api.onFocusCard((id) => panel.focusCard(id));
void backend
  .snapshot()
  .then((s) => panel.update(s))
  .catch((err) => panel.update(undefined, plain(err).message));
