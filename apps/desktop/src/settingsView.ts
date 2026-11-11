/**
 * The settings screen: it takes the place of the panel in the window, one short row per setting,
 * each with a switch or a segmented choice. Changes apply at once; there is nothing to save.
 */
import { setIcon } from "@parawatch/panel";
import { KEEP_CLOSED, SINCE_HOURS, type AboutInfo, type Prefs, type Theme, type UpdateState } from "./prefs";
import { updateLabel } from "./rules";

interface Choice<T> {
  value: T;
  label: string;
  icon?: string;
  title?: string;
}

const THEME_CHOICES: Choice<Theme>[] = [
  { value: "system", label: "Auto", icon: "monitor", title: "Match the system" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** What the About group can ask the app to do. */
export interface AboutActions {
  checkUpdates(): void;
  installUpdate(): void;
  updateCli(): void;
  openLink(which: "repo" | "releases" | "issue" | "logs" | "data"): void;
}

export class SettingsView {
  private prefs?: Prefs;
  private about?: AboutInfo;
  private updateState?: UpdateState;
  private body: HTMLElement;

  constructor(
    private root: HTMLElement,
    private change: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void,
    private close: () => void,
    private actions: AboutActions,
  ) {
    const head = el("div", "st-head", undefined, root);
    const back = el("button", "st-back", undefined, head);
    const icon = el("span", "st-back-icon", undefined, back);
    setIcon(icon, "chevron-left");
    el("span", undefined, "Back", back);
    back.title = "Back (Esc)";
    back.setAttribute("aria-label", "Back to cards");
    back.onclick = () => this.close();
    el("span", "st-title", "Settings", head);
    this.body = el("div", "st-body", undefined, root);
  }

  update(prefs: Prefs): void {
    this.prefs = prefs;
    this.render();
  }

  setAbout(about: AboutInfo): void {
    this.about = about;
    this.render();
  }

  setUpdate(u: UpdateState): void {
    this.updateState = u;
    this.render();
  }

  private render(): void {
    const p = this.prefs;
    this.body.replaceChildren();
    if (!p) return;

    const look = this.group();
    this.row(look, "monitor", "Appearance", undefined, (c) => this.segmented(c, THEME_CHOICES, p.theme, (v) => this.change("theme", v)));
    this.row(look, "bell", "Notifications", "New cards and failed jobs", (c) => this.toggle(c, p.notify, (v) => this.change("notify", v)));
    this.row(look, "log-in", "Open at login", "Waits in the menu bar", (c) => this.toggle(c, p.openAtLogin, (v) => this.change("openAtLogin", v)));

    this.row(look, "bot", "Show service icons", "Fetched from each service's site", (c) => this.toggle(c, p.serviceIcons, (v) => this.change("serviceIcons", v)));

    const lists = this.group();
    this.row(lists, "activity", "Agents", "Active in the last", (c) =>
      this.segmented(
        c,
        SINCE_HOURS.map((h) => ({ value: h, label: `${h}h`, title: `Agents active in the last ${h} hour${h === 1 ? "" : "s"}` })),
        p.sinceHours,
        (v) => this.change("sinceHours", v),
      ),
    );
    this.row(lists, "archive", "Closed cards", "Newest kept to open again", (c) =>
      this.segmented(
        c,
        KEEP_CLOSED.map((n) => ({ value: n, label: n ? String(n) : "Off", title: n ? `Keep the ${n} newest closed cards` : "Keep none" })),
        p.keepClosed,
        (v) => this.change("keepClosed", v),
      ),
    );

    const a = this.about;
    const u = this.updateState;
    const about = this.group();
    this.row(about, "info", a ? `Parawatch ${a.version}` : "Parawatch", updateLabel(u), (c) => {
      if (u?.status === "ready") this.button(c, "Restart to Update", () => this.actions.installUpdate(), true);
      else if (u?.status !== "off") this.button(c, "Check Now", () => this.actions.checkUpdates(), false, u?.status === "checking" || u?.status === "downloading" || u?.status === "available");
      else this.button(c, "Releases", () => this.actions.openLink("releases"));
    });
    if (u?.status !== "off") this.row(about, "download", "Update automatically", "Downloads in the background, asks to restart", (c) => this.toggle(c, p.checkUpdates, (v) => this.change("checkUpdates", v)));
    if (a) {
      this.cliRows(about, a, p);
      if (a.sync)
        this.row(about, "network", `Shared as ${a.sync.device}`, a.sync.text, (c) => {
          if (a.sync?.warn) c.parentElement?.classList.add("is-warn");
        });
    }
    const links = el("div", "st-links", undefined, about);
    for (const [label, which] of [
      ["What's new", "releases"],
      ["Report an issue", "issue"],
      ["Log file", "logs"],
      ["Data folder", "data"],
    ] as const) {
      const b = el("button", "st-link", label, links);
      b.onclick = () => this.actions.openLink(which);
    }
  }

  /** The command line beside the app: its version, and an update through the npm that installed it. */
  private cliRows(group: HTMLElement, a: AboutInfo, p: Prefs): void {
    const s = a.cliUpdate;
    const v = s?.version ?? a.cli?.version;
    const label = v ? `Command line ${v}` : "Command line";
    let sub: string;
    let warn = false;
    let action: (() => void) | undefined;
    let busy = false;
    switch (s?.status) {
      case "updating":
        sub = `Updating to ${s.target}…`;
        busy = true;
        break;
      case "error":
        sub = `Could not update to ${s.target}: ${s.error ?? "npm failed"}`;
        warn = true;
        action = () => this.actions.updateCli();
        break;
      case "behind":
        warn = true;
        if (s.npm) {
          sub = `Older than the app (${a.version})`;
          action = () => this.actions.updateCli();
        } else sub = `Older than the app (${a.version}). Installed outside npm at ${s.path ?? "an unknown place"}; update it there`;
        break;
      case "current":
        sub = a.skew ?? "Same version as the app";
        warn = !!a.skew;
        break;
      default:
        sub = a.cli ? (a.skew ?? `parawatch ${a.cli.version}`) : "Not used with this Mac's data yet. npm i -g parawatch";
    }
    this.row(group, "terminal", label, sub, (c) => {
      if (warn) c.parentElement?.classList.add("is-warn");
      if (action || busy) this.button(c, busy ? "Updating…" : "Update", action ?? (() => {}), !busy, busy);
    });
    if (s?.npm)
      this.row(group, "download", "Update the command line too", "Follows the app's updates, through npm", (c) =>
        this.toggle(c, p.updateCli, (on) => this.change("updateCli", on)),
      );
  }

  private button(cell: HTMLElement, label: string, onClick: () => void, primary = false, disabled = false): void {
    const b = el("button", primary ? "st-btn is-primary" : "st-btn", label, cell);
    b.disabled = disabled;
    b.onclick = onClick;
  }

  private group(): HTMLElement {
    return el("div", "st-group", undefined, this.body);
  }

  private row(group: HTMLElement, icon: string, label: string, sub: string | undefined, control: (cell: HTMLElement) => void): void {
    const row = el("div", "st-row", undefined, group);
    const ic = el("span", "st-icon", undefined, row);
    setIcon(ic, icon);
    const text = el("div", "st-text", undefined, row);
    el("div", "st-label", label, text);
    if (sub) el("div", "st-sub", sub, text);
    control(el("div", "st-control", undefined, row));
  }

  private toggle(cell: HTMLElement, on: boolean, set: (v: boolean) => void): void {
    const b = el("button", "st-switch", undefined, cell);
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", String(on));
    b.onclick = () => set(!on);
    el("span", "st-knob", undefined, b);
  }

  private segmented<T>(cell: HTMLElement, choices: Choice<T>[], current: T, set: (v: T) => void): void {
    const box = el("div", "st-seg", undefined, cell);
    box.setAttribute("role", "radiogroup");
    for (const ch of choices) {
      const b = el("button", "st-seg-item", undefined, box);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(ch.value === current));
      if (ch.icon) setIcon(el("span", "st-seg-icon", undefined, b), ch.icon);
      el("span", undefined, ch.label, b);
      if (ch.title) b.title = ch.title;
      b.onclick = () => {
        if (ch.value !== current) set(ch.value);
      };
    }
  }
}
