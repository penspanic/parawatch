/**
 * Parawatch desktop: the panel in its own window, a menu bar (tray) icon with the count of cards
 * waiting, a dock or taskbar badge, and system notifications. It reads and writes the same event
 * store as the CLI, through the CLI's own code, so it needs nothing else installed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray } from "electron";
import { answerCard, UserError } from "../../../src/core/ops.js";
import { cardContextLine, resolveGoto } from "../../../src/core/desktop.js";
import { followEvents } from "../../../src/core/follow.js";
import { desktopPidPath } from "../../../src/core/integrate.js";
import { snapshot as takeSnapshot } from "../../../src/core/snapshot.js";
import { fold } from "../../../src/core/state.js";
import { homeDir, readEvents } from "../../../src/core/store.js";
import type { PwEvent, Snapshot } from "../../../src/core/types.js";
import { artPng } from "./art.js";
import { alertFor, needsYou, summary, trayTitle } from "./rules.js";

const MEDIA_SCHEME = "pwfile";
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

interface Settings {
  sinceHours: number;
  notify: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

const DEFAULTS: Settings = { sinceHours: 6, notify: true };

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    // settings are a convenience; the app works without them
  }
}

let settings: Settings = DEFAULTS;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let latest: Snapshot | undefined;
let lastError: string | undefined;
let quitting = false;
let refreshTimer: NodeJS.Timeout | undefined;
let debounce: NodeJS.Timeout | undefined;
let stopFollowing: (() => void) | undefined;

// ------------------------------------------------------------------ data

function refresh(): void {
  try {
    latest = takeSnapshot({ sinceHours: settings.sinceHours });
    lastError = undefined;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  paintCounts();
  if (win && !win.isDestroyed()) {
    if (latest) win.webContents.send("pw:snapshot", latest);
    win.webContents.send("pw:error", lastError ?? null);
  }
  scheduleRefresh();
}

/** Refresh often while the window is on screen, rarely otherwise; events refresh at once. */
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const visible = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  refreshTimer = setTimeout(refresh, visible ? 10_000 : 60_000);
}

function onEvent(ev: PwEvent): void {
  const alert = settings.notify
    ? alertFor(ev, { runTitle: (id) => fold(readEvents()).runs.get(id)?.title })
    : undefined;
  if (alert) notifyHuman(alert);
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(refresh, 250);
}

/**
 * A system notification. macOS refuses notifications from an app the user has not allowed yet
 * (or an unsigned build); then the alert goes through the system's own notifier instead, which
 * cannot open the card but still gets the human's attention.
 */
function notifyHuman(alert: { title: string; body: string; card?: string }): void {
  const fallback = () => {
    if (process.platform !== "darwin") return;
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    execFile("osascript", ["-e", `display notification "${esc(alert.body)}" with title "Parawatch" subtitle "${esc(alert.title)}"`], () => {});
  };
  if (!Notification.isSupported()) return fallback();
  const n = new Notification({ title: alert.title, body: alert.body, silent: false });
  n.on("click", () => showWindow(alert.card));
  n.on("failed", (_e, error) => {
    console.warn(`parawatch: system notification refused (${error}); using the fallback notifier`);
    fallback();
  });
  n.show();
}

// ------------------------------------------------------------------ badge and tray

let overlay: Electron.NativeImage | undefined;

function paintCounts(): void {
  const n = needsYou(latest);
  if (process.platform === "darwin") app.dock?.setBadge(n ? String(n) : "");
  else if (process.platform === "linux") app.setBadgeCount(n);
  else if (win && !win.isDestroyed()) {
    overlay ??= nativeImage.createFromBuffer(artPng("overlay", 32), { scaleFactor: 2 });
    win.setOverlayIcon(n ? overlay : null, n ? `${n} cards need you` : "");
  }
  if (tray) {
    if (process.platform === "darwin") tray.setTitle(trayTitle(n), { fontType: "monospacedDigit" });
    tray.setToolTip(`Parawatch: ${summary(latest)}`);
    tray.setContextMenu(trayMenu());
  }
}

function trayMenu(): Menu {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Open Parawatch", click: () => showWindow() },
    { label: summary(latest), enabled: false },
    { type: "separator" },
    {
      label: "Notify on new cards",
      type: "checkbox",
      checked: settings.notify,
      click: (item) => {
        settings.notify = item.checked;
        saveSettings();
      },
    },
    {
      label: "Open at login",
      type: "checkbox",
      checked: login,
      // started at login, the app waits in the menu bar instead of opening its window
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }),
    },
    { type: "separator" },
    { label: "Quit Parawatch", role: "quit" },
  ]);
}

function createTray(): void {
  const img = nativeImage.createFromBuffer(artPng("tray", 36), { scaleFactor: 2 });
  if (process.platform === "darwin") img.setTemplateImage(true);
  tray = new Tray(img);
  // on macOS a click opens the menu; elsewhere a click shows the window and the menu is on right-click
  if (process.platform !== "darwin") tray.on("click", () => showWindow());
  paintCounts();
}

// ------------------------------------------------------------------ window

function showWindow(card?: string): void {
  if (!win || win.isDestroyed()) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
  if (card) {
    const send = () => win!.webContents.send("pw:focus-card", card);
    if (win!.webContents.isLoading()) win!.webContents.once("did-finish-load", send);
    else send();
  }
  scheduleRefresh();
}

function startHidden(): boolean {
  if (process.argv.includes("--hidden")) return true;
  return process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

function createWindow(): void {
  const b = settings.bounds;
  win = new BrowserWindow({
    width: b?.width ?? 440,
    height: b?.height ?? 860,
    x: b?.x,
    y: b?.y,
    minWidth: 340,
    minHeight: 400,
    title: "Parawatch",
    show: false,
    backgroundColor: "#f6f6f6",
    icon: process.platform === "darwin" ? undefined : nativeImage.createFromBuffer(artPng("app", 256)),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => {
    if (!startHidden()) win?.show();
  });
  // links and window.open go to the system, never into this window
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file:")) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on("moved", remember);
  win.on("resized", remember);
  win.on("show", scheduleRefresh);
  win.on("hide", scheduleRefresh);
  // closing the window keeps the app in the menu bar; Quit ends it
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
}

// ------------------------------------------------------------------ IPC

/** Files the panel may show: the attachments of the cards it was given. */
function allowedMedia(): Set<string> {
  const out = new Set<string>();
  for (const c of latest?.cards ?? []) {
    for (const a of c.attach ?? []) out.add(path.resolve(a));
    for (const ans of c.answers) for (const a of ans.attach ?? []) out.add(path.resolve(a));
  }
  return out;
}

function registerIpc(): void {
  ipcMain.handle("pw:snapshot", () => {
    if (!latest) refresh();
    if (!latest) throw new Error(lastError ?? "no snapshot");
    return latest;
  });
  ipcMain.handle("pw:refresh", () => refresh());
  ipcMain.handle("pw:answer", (_e, card: string, reply: { choice?: number; comment?: string; attach?: string[] }) => {
    answerCard(card, { ...reply, by: "human" });
    refresh();
  });
  ipcMain.handle("pw:goto", async (_e, target: string) => {
    const g = resolveGoto(target, fold(readEvents()));
    if (g.card) clipboard.writeText(cardContextLine(g.card));
    if (!g.url) {
      clipboard.writeText(`claude --resume ${g.session}`);
      throw new UserError(`${g.name} is not a Claude desktop session. The command to resume it in a terminal is on your clipboard.`);
    }
    await shell.openExternal(g.url);
    return `Opened ${g.name}`;
  });
  ipcMain.handle("pw:open", async (_e, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) await shell.openExternal(target);
    else {
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
    }
  });
  ipcMain.handle("pw:media-url", (_e, file: string) => {
    const p = path.resolve(file);
    if (!allowedMedia().has(p)) return undefined;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_MEDIA_BYTES) return undefined;
    } catch {
      return undefined;
    }
    return `${MEDIA_SCHEME}://media/${encodeURIComponent(p)}`;
  });
  ipcMain.handle("pw:save-attachment", async (_e, data: ArrayBuffer, ext: string) => {
    const dir = path.join(homeDir(), "attachments");
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `pasted-${stamp}.${ext.replace(/[^a-z0-9]/gi, "") || "png"}`);
    await fs.promises.writeFile(file, new Uint8Array(data));
    return file;
  });
}

// ------------------------------------------------------------------ lifecycle

protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Parawatch");
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    // stay in the menu bar
  });
  app.on("will-quit", () => {
    stopFollowing?.();
    try {
      if (fs.readFileSync(desktopPidPath(), "utf8").trim() === String(process.pid)) fs.unlinkSync(desktopPidPath());
    } catch {
      // already gone
    }
  });

  void app.whenReady().then(() => {
    settings = loadSettings();
    if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromBuffer(artPng("app", 512)));
    protocol.handle(MEDIA_SCHEME, (req) => {
      const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
      if (!allowedMedia().has(path.resolve(p))) return new Response("not allowed", { status: 403 });
      return net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
    });
    try {
      fs.mkdirSync(homeDir(), { recursive: true });
      fs.writeFileSync(desktopPidPath(), String(process.pid));
    } catch {
      // the CLI will notify as well; harmless
    }
    registerIpc();
    createWindow();
    createTray();
    refresh();
    stopFollowing = followEvents(onEvent);
    Notification.isSupported(); // touch the API early so macOS asks for permission on first run
  });
}
