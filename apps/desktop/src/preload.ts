// The only bridge between the page and the app: a small, typed API on window.parawatch.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AboutInfo, Prefs, UpdateState } from "./prefs";

type Listener<T> = (value: T) => void;

function on<T>(channel: string, fn: Listener<T>): () => void {
  const handler = (_e: unknown, value: T) => fn(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  snapshot: () => ipcRenderer.invoke("pw:snapshot"),
  refresh: () => ipcRenderer.invoke("pw:refresh"),
  platform: process.platform,
  prefs: () => ipcRenderer.invoke("pw:prefs") as Promise<Prefs>,
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => ipcRenderer.invoke("pw:set-pref", key, value) as Promise<void>,
  onPrefs: (fn: Listener<Prefs>) => on("pw:prefs", fn),
  onOpenSettings: (fn: Listener<void>) => on("pw:open-settings", fn),
  about: () => ipcRenderer.invoke("pw:about") as Promise<AboutInfo>,
  onAbout: (fn: Listener<AboutInfo>) => on("pw:about", fn),
  updateCli: () => ipcRenderer.invoke("pw:update-cli") as Promise<AboutInfo>,
  updateState: () => ipcRenderer.invoke("pw:update-state") as Promise<UpdateState>,
  checkUpdates: () => ipcRenderer.invoke("pw:check-updates") as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.invoke("pw:install-update") as Promise<void>,
  openLink: (which: "repo" | "releases" | "issue" | "logs" | "data") => ipcRenderer.invoke("pw:open-link", which) as Promise<void>,
  onUpdate: (fn: Listener<UpdateState>) => on("pw:update", fn),
  answer: (card: string, reply: unknown) => ipcRenderer.invoke("pw:answer", card, reply),
  goto: (target: string) => ipcRenderer.invoke("pw:goto", target),
  hideRun: (id: string) => ipcRenderer.invoke("pw:hide-run", id),
  dismiss: (card: string) => ipcRenderer.invoke("pw:dismiss", card),
  open: (target: string) => ipcRenderer.invoke("pw:open", target),
  mediaUrl: (file: string) => ipcRenderer.invoke("pw:media-url", file),
  siteIcon: (site: string) => ipcRenderer.invoke("pw:site-icon", site) as Promise<string | undefined>,
  targetMenu: (target: string) => ipcRenderer.invoke("pw:target-menu", target),
  saveAttachment: (data: ArrayBuffer, ext: string) => ipcRenderer.invoke("pw:save-attachment", data, ext),
  droppedPath: (file: File) => webUtils.getPathForFile(file) || undefined,
  onSnapshot: (fn: Listener<unknown>) => on("pw:snapshot", fn),
  onError: (fn: Listener<string | null>) => on("pw:error", fn),
  onFocusCard: (fn: Listener<string>) => on("pw:focus-card", fn),
};

contextBridge.exposeInMainWorld("parawatch", api);

export type ParawatchApi = typeof api;
