// The only bridge between the page and the app: a small, typed API on window.parawatch.
import { contextBridge, ipcRenderer, webUtils } from "electron";

type Listener<T> = (value: T) => void;

function on<T>(channel: string, fn: Listener<T>): () => void {
  const handler = (_e: unknown, value: T) => fn(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  snapshot: () => ipcRenderer.invoke("pw:snapshot"),
  refresh: () => ipcRenderer.invoke("pw:refresh"),
  answer: (card: string, reply: unknown) => ipcRenderer.invoke("pw:answer", card, reply),
  goto: (target: string) => ipcRenderer.invoke("pw:goto", target),
  open: (target: string) => ipcRenderer.invoke("pw:open", target),
  mediaUrl: (file: string) => ipcRenderer.invoke("pw:media-url", file),
  saveAttachment: (data: ArrayBuffer, ext: string) => ipcRenderer.invoke("pw:save-attachment", data, ext),
  droppedPath: (file: File) => webUtils.getPathForFile(file) || undefined,
  onSnapshot: (fn: Listener<unknown>) => on("pw:snapshot", fn),
  onError: (fn: Listener<string | null>) => on("pw:error", fn),
  onFocusCard: (fn: Listener<string>) => on("pw:focus-card", fn),
};

contextBridge.exposeInMainWorld("parawatch", api);

export type ParawatchApi = typeof api;
