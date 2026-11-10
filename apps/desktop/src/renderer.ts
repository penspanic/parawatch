import { Marked } from "marked";
import { Panel, setIcon, type Backend, type Reply, type Snapshot } from "@parawatch/panel";
import type { ParawatchApi } from "./preload";
import { SettingsView } from "./settingsView";

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
  hideRun: (id: string) => call(api.hideRun(id) as Promise<void>),
  open: (target: string) => void call(api.open(target)).catch((err) => toast(plain(err).message)),
  mediaUrl: (file: string) => call(api.mediaUrl(file) as Promise<string | undefined>),
  saveAttachment: (data: ArrayBuffer, ext: string) => call(api.saveAttachment(data, ext) as Promise<string>),
  droppedPath: (file: File) => api.droppedPath(file),
  siteIcon: (site: string) => call(api.siteIcon(site)).catch(() => undefined),
  targetMenu: (target: string) => void call(api.targetMenu(target)).catch((err) => toast(plain(err).message)),
};

/** The settings button at the end of the status row. */
function settingsButton(row: HTMLElement): void {
  const b = document.createElement("button");
  b.className = "pw-icon-btn clickable-icon pw-settings-btn";
  setIcon(b, "settings");
  b.title = "Settings (⌘,)";
  b.setAttribute("aria-label", "Settings");
  b.onclick = () => showSettings(true);
  row.appendChild(b);
}

document.body.classList.add(`is-${api.platform}`);

const panel = new Panel(document.getElementById("panel")!, backend, {
  renderMarkdown,
  icon: setIcon,
  notice: toast,
  refresh: () => void api.refresh(),
  decorateHead: settingsButton,
});

const settingsRoot = document.getElementById("settings")!;
const settings = new SettingsView(
  settingsRoot,
  (key, value) => void call(api.setPref(key, value)).catch((err) => toast(plain(err).message)),
  () => showSettings(false),
  {
    checkUpdates: () => void api.checkUpdates().then((u) => settings.setUpdate(u)),
    installUpdate: () => void api.installUpdate(),
    openLink: (which) => void api.openLink(which),
  },
);

let beforeSettings: HTMLElement | null = null;

function showSettings(on: boolean): void {
  const was = document.body.classList.contains("is-settings");
  if (on && !was) beforeSettings = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.toggle("is-settings", on);
  settingsRoot.hidden = !on;
  if (on) {
    void api.prefs().then((p) => settings.update(p));
    void api.about().then((a) => settings.setAbout(a));
    void api.updateState().then((u) => settings.setUpdate(u));
    settingsRoot.querySelector<HTMLElement>(".st-back")?.focus();
  } else if (was) {
    // Back where the user was: the control that opened settings, or nothing if it is gone.
    if (beforeSettings?.isConnected) beforeSettings.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    beforeSettings = null;
  }
}

let showIcons: boolean | undefined;
api.onPrefs((p) => {
  settings.update(p);
  // turning the icons off or on draws the lists again
  if (showIcons !== undefined && showIcons !== p.serviceIcons) panel.resetSiteIcons();
  showIcons = p.serviceIcons;
});
void api.prefs().then((p) => (showIcons = p.serviceIcons));
api.onUpdate((u) => settings.setUpdate(u));
api.onOpenSettings(() => showSettings(true));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    showSettings(true);
  } else if (e.key === "Escape" && document.body.classList.contains("is-settings")) {
    e.preventDefault();
    showSettings(false);
  }
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
