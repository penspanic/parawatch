import { App, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, setIcon, type WorkspaceLeaf } from "obsidian";
import { CliBackend } from "./cli";
import { Panel } from "./panel";
import type { Card, PwEvent, Snapshot } from "./types";

const VIEW = "parawatch";

interface Settings {
  binary: string;
  refreshSeconds: number;
  sinceHours: number;
  notifyNewCards: boolean;
}

const DEFAULTS: Settings = { binary: "", refreshSeconds: 10, sinceHours: 6, notifyNewCards: true };
const KIND_WORD: Record<Card["kind"], string> = { decide: "Decide", try: "Try", block: "Blocked" };

export default class ParawatchPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  backend!: CliBackend;
  snapshot?: Snapshot;
  error?: string;
  private statusEl?: HTMLElement;
  private stopWatch?: () => void;
  private inFlight = false;
  private again = false;
  private timer?: number;
  private debounce?: number;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    this.backend = new CliBackend({ binary: () => this.settings.binary, sinceHours: () => this.settings.sinceHours });

    this.registerView(VIEW, (leaf) => new ParawatchView(leaf, this));
    this.addRibbonIcon("radar", "Open Parawatch", () => void this.activate());
    this.addCommand({ id: "open", name: "Open panel", callback: () => void this.activate() });
    this.addCommand({ id: "refresh", name: "Refresh", callback: () => this.refresh() });
    this.addSettingTab(new ParawatchSettings(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("pw-statusbar", "mod-clickable");
    this.statusEl.onclick = () => void this.activate();
    this.paintStatus();

    this.app.workspace.onLayoutReady(() => {
      this.startWatch();
      this.refresh();
      this.schedule();
    });
  }

  onunload(): void {
    this.stopWatch?.();
    if (this.timer) window.clearTimeout(this.timer);
    if (this.debounce) window.clearTimeout(this.debounce);
    this.backend?.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.stopWatch?.();
    this.startWatch();
    this.refresh();
  }

  async activate(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW, active: true });
    }
    void workspace.revealLeaf(leaf);
    this.refresh();
  }

  private views(): ParawatchView[] {
    return this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).filter((v): v is ParawatchView => v instanceof ParawatchView);
  }

  /** Poll faster while the panel is on screen; agents' logs change without events. */
  private schedule(): void {
    if (this.timer) window.clearTimeout(this.timer);
    const visible = this.views().some((v) => v.containerEl.isShown());
    const ms = visible ? Math.max(3, this.settings.refreshSeconds) * 1000 : 60_000;
    this.timer = window.setTimeout(() => {
      this.refresh();
      this.schedule();
    }, ms);
  }

  refresh(): void {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    this.backend
      .snapshot()
      .then((s) => {
        this.snapshot = s;
        this.error = undefined;
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.inFlight = false;
        this.paintStatus();
        for (const v of this.views()) v.show(this.snapshot, this.error);
        if (this.again) {
          this.again = false;
          this.refresh();
        }
      });
  }

  private startWatch(): void {
    this.stopWatch = this.backend.watch(
      (e) => this.onEvent(e),
      (message) => {
        this.error = message;
        this.paintStatus();
      },
    );
  }

  private onEvent(e: PwEvent): void {
    if (e.type === "card.open" && this.settings.notifyNewCards && e.card && typeof e.card === "object") {
      const c = e.card;
      const n = new Notice(`Parawatch · ${c.project}\n${KIND_WORD[c.kind]}: ${c.title}`, 12_000);
      n.noticeEl.addClass("pw-notice");
      n.noticeEl.onclick = () => void this.activate();
    }
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.refresh(), 250);
  }

  private paintStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    const open = this.snapshot?.cards.filter((c) => c.status === "open").length ?? 0;
    const icon = el.createSpan({ cls: "pw-statusbar-icon" });
    setIcon(icon, "radar");
    el.createSpan({ text: open ? `${open} need${open === 1 ? "s" : ""} you` : "Parawatch" });
    el.toggleClass("is-urgent", open > 0);
    el.toggleClass("is-error", Boolean(this.error) && !this.snapshot);
    el.setAttr("aria-label", this.error && !this.snapshot ? `Parawatch: ${this.error}` : open ? "Open Parawatch: cards waiting for you" : "Open Parawatch");
  }
}

class ParawatchView extends ItemView {
  private panel?: Panel;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ParawatchPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW;
  }

  getDisplayText(): string {
    return "Parawatch";
  }

  getIcon(): string {
    return "radar";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    this.panel = new Panel(root, this.plugin.backend, {
      renderMarkdown: (md, el) => void MarkdownRenderer.render(this.app, md, el, "", this),
      icon: (el, name) => setIcon(el, name),
      notice: (m) => new Notice(m),
      refresh: () => this.plugin.refresh(),
    });
    this.show(this.plugin.snapshot, this.plugin.error);
  }

  show(s: Snapshot | undefined, error?: string): void {
    this.panel?.update(s, error);
  }

  async onClose(): Promise<void> {
    this.panel = undefined;
  }
}

class ParawatchSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ParawatchPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    new Setting(containerEl)
      .setName("parawatch binary")
      .setDesc(`Leave empty to look in the usual places. Found: ${this.plugin.backend.bin()}`)
      .addText((t) =>
        t
          .setPlaceholder("/opt/homebrew/bin/parawatch")
          .setValue(s.binary)
          .onChange(async (v) => {
            s.binary = v;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("Refresh while open")
      .setDesc("Seconds between updates while the panel is visible. Cards update right away either way.")
      .addText((t) =>
        t.setValue(String(s.refreshSeconds)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 3) {
            s.refreshSeconds = n;
            await this.plugin.saveSettings();
          }
        }),
      );
    new Setting(containerEl)
      .setName("Agent history")
      .setDesc("Show agents active in the last N hours.")
      .addText((t) =>
        t.setValue(String(s.sinceHours)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.sinceHours = n;
            await this.plugin.saveSettings();
          }
        }),
      );
    new Setting(containerEl)
      .setName("Notify on new cards")
      .setDesc("Show an Obsidian notice when an agent asks you something.")
      .addToggle((t) =>
        t.setValue(s.notifyNewCards).onChange(async (v) => {
          s.notifyNewCards = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
