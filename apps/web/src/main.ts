/**
 * Parawatch on a phone: the panel, fed from the shared folder through the relay. Pairing takes the
 * join code of one's own machines (`parawatch relay code`); the code holds the space key, so it is
 * kept on this phone only and never sent anywhere.
 */
import { Marked } from "marked";
import { Panel, setIcon } from "@parawatch/panel";
import { phoneBackend } from "./backend";
import { readJoinCode, type RelayConfig } from "./seal";
import { Space } from "./space";

declare const __VERSION__: string;

const PAIRED = "pw.paired";

interface Paired {
  config: RelayConfig;
  device: string;
}

const $ = (id: string) => document.getElementById(id)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

let toastTimer: number | undefined;
function toast(text: string): void {
  const box = $("toast");
  box.textContent = text;
  box.classList.add("is-shown");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.classList.remove("is-shown"), 5000);
}

function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return toast("Only web links open from here");
  window.open(url, "_blank", "noopener");
}

// Card bodies are Markdown written by agents. Raw HTML in them is shown as text, not run.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const markdown = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => escape(text) } });

function renderMarkdown(md: string, target: HTMLElement): void {
  target.innerHTML = markdown.parse(md, { async: false }) as string;
  for (const a of Array.from(target.querySelectorAll("a"))) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) openUrl(href);
    });
  }
}

function readPaired(): Paired | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(PAIRED) ?? "") as Paired;
    return p?.config?.key && p.device ? p : undefined;
  } catch {
    return undefined;
  }
}

/** A code given in the link (`#join=pwr1...`): read once, then taken out of the address. */
function codeFromLink(): string | undefined {
  const m = /(?:^|[#&])join=([^&]+)/.exec(location.hash);
  if (!m) return undefined;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]!);
}

function showPair(prefill?: string, error?: string): void {
  $("panel").hidden = true;
  $("about").hidden = true;
  const root = $("pair");
  root.hidden = false;
  root.replaceChildren();
  const box = el("div", "pa-box", undefined, root);
  el("h1", "pa-title", "Parawatch", box);
  el("p", "pa-text", "Pair this phone with your machines. On a computer that uses the relay, run:", box);
  el("code", "pa-cmd", "parawatch relay code", box);
  el("p", "pa-text", "and paste what it prints here. It holds the key to your folder and stays on this phone.", box);
  const code = el("textarea", "pa-code", undefined, box);
  code.placeholder = "pwr1.…";
  code.rows = 4;
  code.autocapitalize = "off";
  code.spellcheck = false;
  if (prefill) code.value = prefill;
  const nameRow = el("label", "pa-label", "This phone's name", box);
  const name = el("input", "pa-name", undefined, nameRow);
  name.value = "phone";
  name.autocapitalize = "off";
  name.spellcheck = false;
  const err = el("p", "pa-error", error ?? "", box);
  const go = el("button", "pa-go", "Connect", box);
  go.onclick = () => {
    err.textContent = "";
    let config: RelayConfig;
    try {
      config = readJoinCode(code.value);
    } catch (e) {
      err.textContent = (e as Error).message;
      return;
    }
    const device = name.value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(device)) {
      err.textContent = "The name may use a-z, 0-9 and -, up to 32 characters";
      return;
    }
    go.disabled = true;
    go.textContent = "Connecting…";
    void connect({ config, device }, true).catch((e) => {
      go.disabled = false;
      go.textContent = "Connect";
      err.textContent = (e as Error).message;
    });
  };
}

let current: { space: Space; panel: Panel; paired: Paired } | undefined;

async function connect(paired: Paired, fresh: boolean): Promise<void> {
  const space = new Space({ config: paired.config, device: paired.device, version: __VERSION__, store: localStorage });
  if (fresh) {
    // checks the name before writing anything
    await space.start();
    localStorage.setItem(PAIRED, JSON.stringify(paired));
  }
  $("pair").hidden = true;
  const root = $("panel");
  root.hidden = false;
  const panel = new Panel(root, phoneBackend(space, openUrl, toast), {
    renderMarkdown,
    icon: setIcon,
    notice: toast,
    refresh: () => panel.update(space.snapshot(), space.error),
    decorateHead: (row) => {
      const b = el("button", "pw-icon-btn clickable-icon pw-settings-btn", undefined, row);
      setIcon(b, "settings");
      b.setAttribute("aria-label", "This phone");
      b.onclick = () => showAbout();
    },
  });
  current = { space, panel, paired };
  space.onChange(() => panel.update(space.snapshot(), space.error));
  panel.update(space.snapshot(), space.error);
  // reads everything first (again, until it can), then follows the relay
  void space.run();
}

function showAbout(): void {
  if (!current) return;
  const { space, paired } = current;
  $("panel").hidden = true;
  const root = $("about");
  root.hidden = false;
  root.replaceChildren();
  const box = el("div", "pa-box", undefined, root);
  const back = el("button", "pa-back", "‹ Back", box);
  back.onclick = () => {
    root.hidden = true;
    $("panel").hidden = false;
  };
  el("h1", "pa-title", "This phone", box);
  const rows: [string, string][] = [
    ["Name", paired.device],
    ["Relay", paired.config.url.replace(/^https?:\/\//, "")],
    ["Machines", space.devices().filter((d) => d !== paired.device).join(", ") || "none yet"],
    ["Last in step", space.lastOk ? new Date(space.lastOk).toLocaleTimeString() : "not yet"],
    ["Version", __VERSION__],
  ];
  if (space.error) rows.push(["Problem", space.error]);
  const dl = el("dl", "pa-rows", undefined, box);
  for (const [k, v] of rows) {
    el("dt", undefined, k, dl);
    el("dd", undefined, v, dl);
  }
  el("p", "pa-text", "Answers, dismissals and hidden runs from here reach your machines like ones given there.", box);
  const forget = el("button", "pa-forget", "Unpair this phone", box);
  forget.onclick = () => {
    if (!confirm("Unpair this phone? Its key is removed from here; pair again with the code.")) return;
    space.stop();
    for (const k of Object.keys(localStorage)) if (k.startsWith("pw.")) localStorage.removeItem(k);
    location.reload();
  };
}

document.addEventListener("visibilitychange", () => {
  if (!current) return;
  // no polling in the background; catch up at once when shown again
  if (document.hidden) current.space.stop();
  else void current.space.run();
});

if ("serviceWorker" in navigator) void navigator.serviceWorker.register("sw.js").catch(() => {});

// a pairing link opened while the app is already showing
window.addEventListener("hashchange", () => {
  const code = codeFromLink();
  if (code && !current) showPair(code);
});

const linked = codeFromLink();
const paired = readPaired();
if (paired && !linked) void connect(paired, false);
else showPair(linked);
