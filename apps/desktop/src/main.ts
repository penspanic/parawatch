/**
 * Parawatch desktop: the panel in its own window, a menu bar (tray) icon with the count of cards
 * waiting, a dock or taskbar badge, and system notifications. It reads and writes the same event
 * store as the CLI, through the CLI's own code, so it needs nothing else installed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, autoUpdater as squirrel, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, protocol, shell, systemPreferences, Tray } from "electron";
import { readClient, recordClient, versionSkew } from "../../../src/core/clients.js";
import { answerCard, hideRun, readState, UserError } from "../../../src/core/ops.js";
import { cardContextLine, resolveGoto } from "../../../src/core/desktop.js";
import { followEvents } from "../../../src/core/follow.js";
import { syncGithub } from "../../../src/core/github.js";
import { desktopPidPath } from "../../../src/core/integrate.js";
import { allowedSite, siteForPr } from "../../../src/core/sites.js";
import { snapshot as takeSnapshot } from "../../../src/core/snapshot.js";
import { attachmentsDir, deviceName, homeDir } from "../../../src/core/store.js";
import { syncStatus, touchDevice } from "../../../src/core/sync.js";
import type { PwEvent, Snapshot } from "../../../src/core/types.js";
import { artPng, trayPng, type TrayState } from "./art.js";
import { logger, logPath } from "./logger.js";
import { siteIcon } from "./siteIcons.js";
import { KEEP_CLOSED, SINCE_HOURS, THEMES, validPref, type AboutInfo, type Prefs, type Theme, type UpdateState } from "./prefs.js";
import { alertFor, agentsWorking, issueUrl, needsYou, newlyStuck, summary } from "./rules.js";
import { checkNow, installNow, RELEASES_URL, resumeUnfinished, scheduleUpdates, stopUpdates, updateState } from "./updater.js";
import { clearMarker, installingNotice, interruptedNotice, readMarker, startState, stillInstallingNotice, writeMarker } from "./updateInstall.js";

const MEDIA_SCHEME = "pwfile";
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/** Open at login lives with the system, not in this file. */
interface Settings extends Omit<Prefs, "openAtLogin"> {
  bounds?: { x: number; y: number; width: number; height: number };
}

const DEFAULTS: Settings = { sinceHours: 6, notify: true, theme: "system", keepClosed: 20, checkUpdates: true, serviceIcons: true };
const REPO_URL = "https://github.com/penspanic/parawatch";

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
    if (typeof s.checkUpdates !== "boolean") s.checkUpdates = DEFAULTS.checkUpdates;
    if (typeof s.serviceIcons !== "boolean") s.serviceIcons = DEFAULTS.serviceIcons;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    logger.warn("could not save settings:", err); // a convenience; the app works without them
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
/** stuck pull requests and jobs already reported; the first look only learns them */
const stuck = new Set<string>();
let stuckPrimed = false;
let githubTimer: NodeJS.Timeout | undefined;

// ------------------------------------------------------------------ data

function refresh(): void {
  try {
    latest = takeSnapshot({ sinceHours: settings.sinceHours, closed: settings.keepClosed });
    lastError = undefined;
    const alerts = newlyStuck(latest, stuck);
    if (stuckPrimed && settings.notify) for (const a of alerts) notifyHuman(a);
    stuckPrimed = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== lastError) logger.error("reading the store failed:", err);
    lastError = msg;
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

/**
 * Read GitHub through `gh` on the configured interval. News lands as events (which refresh and
 * notify); the snapshot is refreshed anyway so waiting times move.
 */
function watchGithub(): void {
  const tick = async () => {
    try {
      const before = fs.existsSync(path.join(homeDir(), "github.json")) ? fs.statSync(path.join(homeDir(), "github.json")).mtimeMs : 0;
      touchDevice(app.getVersion());
      await syncGithub({ state: readState() });
      const after = fs.existsSync(path.join(homeDir(), "github.json")) ? fs.statSync(path.join(homeDir(), "github.json")).mtimeMs : 0;
      if (after !== before) refresh();
    } catch (err) {
      logger.warn("reading GitHub failed:", err instanceof Error ? err.message : String(err));
    }
  };
  void tick();
  githubTimer = setInterval(() => void tick(), 60_000);
}

function onEvent(ev: PwEvent): void {
  // every machine reads GitHub itself, so news another machine logged is told here already
  const echo = ev.type === "pr.change" && !!ev.dev && ev.dev !== deviceName();
  const alert = settings.notify && !echo
    ? alertFor(ev, { runTitle: (id) => readState().runs.get(id)?.title })
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
    logger.warn(`system notification refused (${error}); using the fallback notifier`);
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
  const u = updateState();
  return Menu.buildFromTemplate([
    { label: "Open Parawatch", click: () => showWindow() },
    { label: summary(latest), enabled: false },
    { type: "separator" },
    ...(u.status === "ready" ? [{ label: `Restart to Update to ${u.version}`, click: () => void restartToUpdate() }, { type: "separator" as const }] : []),
    { label: "Settings…", click: () => openSettings() },
    { label: "Check for Updates…", click: () => void checkForUpdatesByHand() },
    { type: "separator" },
    { label: "Quit Parawatch", role: "quit" },
  ]);
}

// ------------------------------------------------------------------ versions and updates

/** One line on sharing for the settings: the other machines and whether the sync tool is fine. */
async function syncLine(): Promise<AboutInfo["sync"]> {
  const st = await syncStatus().catch(() => undefined);
  if (!st) return undefined;
  const peers = st.peers.map((p) => `${p.name} ${p.connected === true ? "connected" : p.connected === false ? "not connected" : "seen"}`).join(", ") || "no other machine yet";
  const problems = [st.error, st.conflicts.length ? `${st.conflicts.length} conflict copies` : ""].filter(Boolean).join(" · ");
  return { device: st.device, text: `${st.adapter} · ${peers}${problems ? ` · ${problems}` : ""}`, warn: !st.ok || !!problems };
}

async function aboutInfo(): Promise<AboutInfo> {
  const cli = readClient("cli");
  const sync = await syncLine();
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    platform: `${process.platform}-${process.arch} ${process.getSystemVersion?.() ?? ""}`.trim(),
    ...(cli ? { cli: { version: cli.version, at: cli.at, path: cli.path } } : {}),
    skew: versionSkew(cli?.version, app.getVersion())?.text,
    logPath: logPath(),
    dataPath: homeDir(),
    ...(sync ? { sync } : {}),
  };
}

/** The app bundle on macOS, the program folder elsewhere, the source folder in development. */
function installedAt(): string {
  if (!app.isPackaged) return app.getAppPath();
  const exe = app.getPath("exe");
  return process.platform === "darwin" ? path.resolve(exe, "..", "..", "..") : path.dirname(exe);
}

let toldReady: string | undefined;

/**
 * Show a notification and resolve once it is on screen (or after a moment), so a quit right after
 * it does not swallow it.
 */
function notifyAndWait(alert: { title: string; body: string }): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    setTimeout(done, 1500);
    // macOS refuses notifications until the user allows them; then the system's own notifier says it
    const fallback = () => {
      if (process.platform !== "darwin") return done();
      const esc = (x: string) => x.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      execFile("osascript", ["-e", `display notification "${esc(alert.body)}" with title "Parawatch" subtitle "${esc(alert.title)}"`], done);
    };
    if (!Notification.isSupported()) return fallback();
    const n = new Notification({ title: alert.title, body: alert.body, silent: false });
    n.on("show", done);
    n.on("failed", fallback);
    n.show();
  });
}

/**
 * Restart to Update. The install takes about half a minute with nothing on screen, and opening the
 * app again meanwhile makes it fail, so say so first and leave a marker for the next start.
 */
async function restartToUpdate(): Promise<void> {
  const u = updateState();
  if (u.status !== "ready" || !u.version) return;
  writeMarker(app.getPath("userData"), u.version);
  logger.info(`quitting to install ${u.version}`);
  await notifyAndWait(installingNotice(u.version));
  installNow();
}

/**
 * What an earlier restart to update left behind. Returns true when the app should step aside
 * because the install is still going on.
 */
function checkUnfinishedInstall(): boolean {
  const dir = app.getPath("userData");
  const marker = readMarker(dir);
  const state = startState(marker, app.getVersion());
  if (!marker) return false;
  if (state === "none") {
    logger.info(`now running ${app.getVersion()}; the update to ${marker.version} is done`);
    clearMarker(dir);
    return false;
  }
  if (state === "installing") {
    logger.info(`started while ${marker.version} is still being installed; quitting so it can finish`);
    void notifyAndWait(stillInstallingNotice(marker.version)).then(() => app.quit());
    return true;
  }
  logger.warn(`the update to ${marker.version} never finished (asked ${marker.at}); looking for it again`);
  void resumeUnfinished(marker.version);
  return false;
}

function onUpdate(s: UpdateState): void {
  if (win && !win.isDestroyed()) win.webContents.send("pw:update", s);
  if (tray) tray.setContextMenu(trayMenu());
  buildAppMenu();
  if (s.status === "latest") clearUnfinishedMarker();
  if (s.status === "ready" && s.version && toldReady !== s.version) {
    toldReady = s.version;
    logger.info(`update ${s.version} downloaded`);
    const text = s.interrupted ? interruptedNotice(s.version) : { title: `Parawatch ${s.version} is ready`, body: "Restart Parawatch to use it. It also updates when you quit." };
    const n = settings.notify && Notification.isSupported() ? new Notification(text) : undefined;
    n?.on("click", () => openSettings());
    n?.show();
  }
}

/** The check found nothing newer, so an install that never finished is moot (the release is gone). */
function clearUnfinishedMarker(): void {
  const dir = app.getPath("userData");
  if (readMarker(dir)) clearMarker(dir);
}

/** The menu item: look now and say what came of it, even when nothing is new. */
async function checkForUpdatesByHand(): Promise<void> {
  const s = await checkNow();
  const owner = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
  const box = (o: Electron.MessageBoxOptions) => (owner ? dialog.showMessageBox(owner, o) : dialog.showMessageBox(o));
  if (s.status === "ready") {
    const r = await box({ type: "info", message: `Parawatch ${s.version} is ready`, detail: "Restart now to use it, or it updates the next time you quit.", buttons: ["Restart Now", "Later"], defaultId: 0, cancelId: 1 });
    if (r.response === 0) void restartToUpdate();
  } else if (s.status === "available" || s.status === "downloading") {
    await box({ type: "info", message: `Parawatch ${s.version ?? ""} is downloading`.replace("  ", " "), detail: "You will be asked to restart when it is ready.", buttons: ["OK"] });
  } else if (s.status === "latest") {
    await box({ type: "info", message: "Parawatch is up to date", detail: `${app.getVersion()} is the newest version.`, buttons: ["OK"] });
  } else if (s.status === "off") {
    const r = await box({ type: "info", message: "This copy does not update itself", detail: `${s.reason ?? ""}. You have ${app.getVersion()}.`, buttons: ["Open Releases", "OK"], defaultId: 1, cancelId: 1 });
    if (r.response === 0) void shell.openExternal(RELEASES_URL);
  } else if (s.status === "error") {
    const r = await box({ type: "warning", message: "Could not check for updates", detail: s.error ?? "", buttons: ["Open Releases", "OK"], defaultId: 1, cancelId: 1 });
    if (r.response === 0) void shell.openExternal(RELEASES_URL);
  }
}

function openLink(which: string): void {
  if (which === "repo") void shell.openExternal(REPO_URL);
  else if (which === "releases") void shell.openExternal(`${RELEASES_URL}/tag/v${app.getVersion()}`);
  else if (which === "issue") void aboutInfo().then((a) => shell.openExternal(issueUrl(a)));
  else if (which === "logs") {
    if (fs.existsSync(logPath())) shell.showItemInFolder(logPath());
    else void shell.openPath(path.dirname(logPath()));
  } else if (which === "data") void shell.openPath(homeDir());
}

/**
 * The menu bar's menus. On macOS they are the app's own, with About, updates and help that lead to
 * this project; elsewhere the window has no menu bar and the tray menu and settings cover the same.
 */
function buildAppMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const u = updateState();
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          u.status === "ready"
            ? { label: `Restart to Update to ${u.version}`, click: () => void restartToUpdate() }
            : { label: "Check for Updates…", click: () => void checkForUpdatesByHand() },
          { type: "separator" },
          { label: "Settings…", accelerator: "Cmd+,", click: () => openSettings() },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Refresh", accelerator: "Cmd+R", click: () => refresh() },
          ...(dev ? [{ role: "toggleDevTools" as const }] : []),
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: "Parawatch on GitHub", click: () => openLink("repo") },
          { label: `What's New in ${app.getVersion()}`, click: () => openLink("releases") },
          { label: "Report an Issue…", click: () => openLink("issue") },
          { type: "separator" },
          { label: "Show Log File", click: () => openLink("logs") },
          { label: "Show Data Folder", click: () => openLink("data") },
        ],
      },
    ]),
  );
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
    checkUpdates: settings.checkUpdates,
    serviceIcons: settings.serviceIcons,
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
  if (key === "checkUpdates") scheduleUpdates(settings.checkUpdates, onUpdate);
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

let shownMenu: Menu | undefined;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The menu for a file, app or URL a card carries, like the one Finder shows: open, Quick Look,
 * show in Finder, copy the path, share. A card's files are on this machine, so there is no download.
 */
function targetMenu(target: string): Menu {
  const mac = process.platform === "darwin";
  if (URL_RE.test(target)) {
    return Menu.buildFromTemplate([
      { label: "Open Link", click: () => void shell.openExternal(target) },
      { label: "Copy Link", click: () => clipboard.writeText(target) },
      ...(mac ? [{ type: "separator" as const }, { role: "shareMenu" as const, sharingItem: { urls: [target] } }] : []),
    ]);
  }
  const file = path.resolve(target);
  const there = fs.existsSync(file);
  const show = mac ? "Show in Finder" : process.platform === "win32" ? "Show in File Explorer" : "Show in Folder";
  return Menu.buildFromTemplate([
    { label: there ? "Open" : "File not found", enabled: there, click: () => void shell.openPath(file) },
    ...(mac ? [{ label: "Quick Look", enabled: there, click: () => win?.previewFile(file) }] : []),
    { label: show, enabled: there, click: () => shell.showItemInFolder(file) },
    { type: "separator" },
    { label: "Copy Path", click: () => clipboard.writeText(file) },
    ...(mac && there ? [{ type: "separator" as const }, { role: "shareMenu" as const, sharingItem: { filePaths: [file] } }] : []),
  ]);
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
  ipcMain.handle("pw:hide-run", (_e, id: string) => {
    hideRun(id);
    refresh();
  });
  ipcMain.handle("pw:goto", async (_e, target: string) => {
    const g = resolveGoto(target, readState());
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
  ipcMain.handle("pw:target-menu", (e, target: string) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    if (!owner) return;
    // keep the menu alive while it is open; a menu only the popup refers to can be collected
    shownMenu = targetMenu(target);
    shownMenu.popup({ window: owner, callback: () => (shownMenu = undefined) });
  });
  ipcMain.handle("pw:site-icon", async (_e, site: unknown) => {
    if (!settings.serviceIcons) return undefined;
    // only the fixed sites and the hosts of pull requests the store lists
    const hosts = new Set((latest?.prs ?? []).map((p) => siteForPr(p)).filter((s): s is string => !!s).map((s) => new URL(s).host));
    if (!allowedSite(site, hosts)) return undefined;
    return siteIcon(path.join(app.getPath("userData"), "icons"), site);
  });
  ipcMain.handle("pw:about", () => aboutInfo());
  ipcMain.handle("pw:update-state", () => updateState());
  ipcMain.handle("pw:check-updates", () => checkNow());
  ipcMain.handle("pw:install-update", () => restartToUpdate());
  ipcMain.handle("pw:open-link", (_e, which: string) => openLink(String(which)));
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
    const dir = attachmentsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `pasted-${stamp}.${ext.replace(/[^a-z0-9]/gi, "") || "png"}`);
    await fs.promises.writeFile(file, new Uint8Array(data));
    return file;
  });
}

// ------------------------------------------------------------------ lifecycle

// A second copy for testing can keep its own settings and lock: PARAWATCH_DESKTOP_DATA=<folder>.
if (process.env.PARAWATCH_DESKTOP_DATA) app.setPath("userData", path.resolve(process.env.PARAWATCH_DESKTOP_DATA));

process.on("uncaughtException", (err) => logger.error("uncaught:", err));
process.on("unhandledRejection", (err) => logger.error("unhandled rejection:", err));

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
  // Restart to Update quits through Squirrel, which sends this instead of before-quit. Without it
  // the window's close handler only hides the window, the app never quits and the update waits.
  if (process.platform === "darwin") {
    squirrel.on("before-quit-for-update", () => {
      quitting = true;
    });
  }
  app.on("window-all-closed", () => {
    // stay in the menu bar
  });
  app.on("render-process-gone", (_e, contents, details) => {
    logger.error(`the window's page stopped: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason !== "clean-exit" && win && !win.isDestroyed() && contents === win.webContents) win.reload();
  });
  app.on("child-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit") logger.warn(`${details.type} process stopped: ${details.reason}`);
  });
  app.on("will-quit", () => {
    stopFollowing?.();
    stopUpdates();
    if (githubTimer) clearInterval(githubTimer);
    try {
      if (fs.readFileSync(desktopPidPath(), "utf8").trim() === String(process.pid)) fs.unlinkSync(desktopPidPath());
    } catch {
      // already gone
    }
  });

  void app.whenReady().then(() => {
    settings = loadSettings();
    logger.info(`Parawatch ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}-${process.arch} ${process.getSystemVersion?.() ?? ""}, packaged ${app.isPackaged})`);
    nativeTheme.themeSource = settings.theme;
    app.setAboutPanelOptions({
      applicationName: "Parawatch",
      applicationVersion: app.getVersion(),
      version: "",
      copyright: "© 2026 penspanic · MIT License",
      credits: "github.com/penspanic/parawatch",
      website: REPO_URL,
    });
    if (checkUnfinishedInstall()) return;
    buildAppMenu();
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
    } catch (err) {
      logger.warn("could not write the pid file (the CLI will notify as well):", err);
    }
    recordClient({ name: "desktop", version: app.getVersion(), pid: process.pid, log: logPath(), path: installedAt() });
    registerIpc();
    createWindow();
    createTray();
    refresh();
    stopFollowing = followEvents(onEvent);
    watchGithub();
    scheduleUpdates(settings.checkUpdates, onUpdate);
    Notification.isSupported(); // touch the API early so macOS asks for permission on first run
  });
}
