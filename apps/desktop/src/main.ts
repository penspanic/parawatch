/**
 * Parawatch desktop: the panel in its own window, a menu bar (tray) icon with the count of cards
 * waiting, a dock or taskbar badge, and system notifications. It reads and writes the same event
 * store as the CLI, through the CLI's own code, so it needs nothing else installed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, protocol, shell, systemPreferences, Tray } from "electron";
import { answerCard, UserError } from "../../../src/core/ops.js";
import { cardContextLine, resolveGoto } from "../../../src/core/desktop.js";
import { followEvents } from "../../../src/core/follow.js";
import { desktopPidPath } from "../../../src/core/integrate.js";
import { snapshot as takeSnapshot } from "../../../src/core/snapshot.js";
import { fold } from "../../../src/core/state.js";
import { homeDir, readEvents } from "../../../src/core/store.js";
import type { PwEvent, Snapshot } from "../../../src/core/types.js";
import { artPng, trayPng, type TrayState } from "./art.js";
import { KEEP_CLOSED, SINCE_HOURS, THEMES, validPref, type Prefs, type Theme } from "./prefs.js";
import { alertFor, agentsWorking, needsYou, summary } from "./rules.js";

const MEDIA_SCHEME = "pwfile";
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/** Open at login lives with the system, not in this file. */
interface Settings extends Omit<Prefs, "openAtLogin"> {
  bounds?: { x: number; y: number; width: number; height: number };
}

const DEFAULTS: Settings = { sinceHours: 6, notify: true, theme: "system", keepClosed: 20 };

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Partial<Settings>) };
    if (!THEMES.includes(s.theme)) s.theme = DEFAULTS.theme;
    if (!SINCE_HOURS.includes(s.sinceHours)) s.sinceHours = DEFAULTS.sinceHours;
    if (!KEEP_CLOSED.includes(s.keepClosed)) s.keepClosed = DEFAULTS.keepClosed;
    if (typeof s.notify !== "boolean") s.notify = DEFAULTS.notify;
    return s;
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
    latest = takeSnapshot({ sinceHours: settings.sinceHours, closed: settings.keepClosed });
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
  if (process.platform === "darwin") {
    // a number, not a label: once the app may send notifications, macOS keeps the dock badge as
    // a count that outlives the app, and only setting the count to 0 clears it
    app.setBadgeCount(n);
    if (!n) app.dock?.setBadge("");
  } else if (process.platform === "linux") app.setBadgeCount(n);
  else if (win && !win.isDestroyed()) {
    overlay ??= nativeImage.createFromBuffer(artPng("overlay", 32), { scaleFactor: 2 });
    win.setOverlayIcon(n ? overlay : null, n ? `${n} cards need you` : "");
  }
  if (tray) {
    tray.setToolTip(`Parawatch: ${summary(latest)}`);
    tray.setContextMenu(trayMenu());
    paintTray();
  }
}

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "Open Parawatch", click: () => showWindow() },
    { label: summary(latest), enabled: false },
    { type: "separator" },
    { label: "Settings…", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit Parawatch", role: "quit" },
  ]);
}

// The menu bar icon moves: dots travel along the lanes while agents work, and the middle dot
// stops, grows and breathes while something needs you. Still when nothing happens, and when the
// system asks for reduced motion.
const TRAY_FPS = 12;
const TRAY_LOOP = 48; // frames, four seconds
const trayFrames = new Map<string, Electron.NativeImage>();
let trayTimer: NodeJS.Timeout | undefined;
let trayFrame = 0;
let trayMode = "";

/**
 * The ink of the icon with a count. A template image is recoloured by the system, but that icon
 * has an amber bubble, so it is drawn in colour. On macOS the menu bar takes its colour from the
 * wallpaper, which an app cannot read, so the lanes are a grey that reads on light and dark bars.
 */
const MENU_BAR_GREY: [number, number, number] = [142, 142, 147];

function trayImage(s: TrayState, count: number): Electron.NativeImage {
  const mac = process.platform === "darwin";
  const template = mac && count === 0;
  const ink: [number, number, number] = template ? [0, 0, 0] : mac ? MENU_BAR_GREY : nativeTheme.shouldUseDarkColors ? [255, 255, 255] : [0, 0, 0];
  const key = `${s.working}|${s.attention}|${s.phase.toFixed(4)}|${count}|${ink[0]}`;
  let img = trayFrames.get(key);
  if (!img) {
    if (trayFrames.size > 600) trayFrames.clear();
    img = nativeImage.createFromBuffer(trayPng(s, count, 2, ink), { scaleFactor: 2 });
    if (template) img.setTemplateImage(true);
    trayFrames.set(key, img);
  }
  return img;
}

function reducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion;
  } catch {
    return false;
  }
}

function paintTray(): void {
  if (!tray) return;
  const working = agentsWorking(latest);
  const count = needsYou(latest);
  const attention = count > 0;
  const still = (!working && !attention) || reducedMotion();
  if (still) {
    if (trayTimer) clearInterval(trayTimer);
    trayTimer = undefined;
    // a held dot at its largest, the others at rest
    tray.setImage(trayImage({ phase: 0.125, working: false, attention }, count));
    return;
  }
  const mode = `${working}|${attention}|${count}`;
  if (trayTimer && mode === trayMode) return; // already moving this way; keep the loop smooth
  trayMode = mode;
  const tick = () => {
    trayFrame = (trayFrame + 1) % TRAY_LOOP;
    tray?.setImage(trayImage({ phase: trayFrame / TRAY_LOOP, working, attention }, count));
  };
  if (trayTimer) clearInterval(trayTimer);
  trayTimer = setInterval(tick, 1000 / TRAY_FPS);
  tick();
}

function createTray(): void {
  tray = new Tray(trayImage({ phase: 0, working: false, attention: false }, 0));
  // on macOS a click opens the menu; elsewhere a click shows the window and the menu is on right-click
  if (process.platform !== "darwin") tray.on("click", () => showWindow());
  const repaint = () => {
    trayFrames.clear();
    trayMode = "";
    paintTray();
  };
  nativeTheme.on("updated", () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
    repaint();
  });
  paintCounts();
}

// ------------------------------------------------------------------ appearance

// The window's own colours follow nativeTheme: the page's prefers-color-scheme comes from it.
const WINDOW_BG = { light: "#f3f4f6", dark: "#131417" };

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light;
}

function prefs(): Prefs {
  return {
    theme: settings.theme,
    notify: settings.notify,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    sinceHours: settings.sinceHours,
    keepClosed: settings.keepClosed,
  };
}

/** Change one setting from the window, then tell the window what the settings are now. */
function setPref<K extends keyof Prefs>(key: K, value: unknown): void {
  if (!validPref(key, value)) return;
  if (key === "openAtLogin") {
    // started at login, the app waits in the menu bar instead of opening its window
    app.setLoginItemSettings({ openAtLogin: value as boolean, args: ["--hidden"] });
  } else {
    (settings as unknown as Record<string, unknown>)[key] = value;
    saveSettings();
  }
  if (key === "theme") nativeTheme.themeSource = value as Theme;
  if (key === "sinceHours" || key === "keepClosed") refresh();
  if (win && !win.isDestroyed()) win.webContents.send("pw:prefs", prefs());
}

function openSettings(): void {
  showWindow();
  const send = () => win!.webContents.send("pw:open-settings");
  if (win!.webContents.isLoading()) win!.webContents.once("did-finish-load", send);
  else send();
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
    backgroundColor: windowBackground(),
    // on macOS the status row is the title bar, with the window buttons inset at its left
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
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
  ipcMain.handle("pw:prefs", () => prefs());
  ipcMain.handle("pw:set-pref", (_e, key: keyof Prefs, value: unknown) => setPref(key, value));
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
    nativeTheme.themeSource = settings.theme;
    // a packaged macOS app shows its Liquid Glass icon; only a development run needs a dock icon
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromBuffer(artPng("app", 512)));
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
