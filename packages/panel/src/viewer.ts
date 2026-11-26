/**
 * A viewer over the whole window for a card's pictures and videos: the page dims, the picture
 * fits the window, and it zooms (wheel, pinch, double click, + and -) and pans (drag). Arrows go
 * to the card's other pictures. Esc, the close button or a click beside the picture closes it.
 * Pictures of one comparison keep the zoom and the spot between them, so a difference stays in
 * view while the human flips; their captions sit under the picture as buttons. A comparison can
 * also be shown all at once, side by side or as a slider (see compare.ts); the choice is kept for
 * the next time.
 */

import { openCompare, type Compare, type CompareMode, type Moment } from "./compare";

export interface ViewerItem {
  file: string;
  /** a URL the page can load */
  src: string;
  video: boolean;
  /** the name the card gives it */
  caption?: string;
  /** the comparison it belongs to, if any: items of one group are side by side in the list */
  group?: number;
  /** the choice it belongs to */
  option?: number;
}

/** one at a time (flipping with the tabs), side by side, or a slider */
export type ViewMode = "one" | CompareMode;

export interface ViewerOptions {
  /** how a comparison is shown; without it, the way chosen last time */
  mode?: ViewMode;
}

const MODE_KEY = "pw.viewer.mode";
/** the way chosen last, for when the window cannot store it */
let remembered: ViewMode = "one";
function loadMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === "side" || v === "wipe" || v === "one" ? v : remembered;
  } catch {
    return remembered;
  }
}
function saveMode(v: ViewMode): void {
  remembered = v;
  try {
    window.localStorage.setItem(MODE_KEY, v);
  } catch {
    // kept for this window only
  }
}

export interface ViewerHost {
  icon(el: HTMLElement, name: string): void;
  /** opens the file in the program the system picks */
  openExternal(file: string): void;
}

const MAX_SCALE = 8;
const STEP = 1.25;
const basename = (f: string) => f.split(/[\\/]/).pop() || f;

export function openViewer(doc: Document, items: ViewerItem[], start: number, host: ViewerHost, opts: ViewerOptions = {}): () => void {
  const win = doc.defaultView ?? window;
  const opener = doc.activeElement as HTMLElement | null;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    parent?.appendChild(e);
    return e;
  };
  const button = (parent: HTMLElement, icon: string, label: string, cls = "") => {
    const b = el("button", `pw-viewer-btn ${cls}`.trim(), parent);
    host.icon(b, icon);
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  };

  const root = el("div", "pw-viewer", doc.body);
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const stage = el("div", "pw-viewer-stage", root);
  const bar = el("div", "pw-viewer-bar", root);
  const modes = el("div", "pw-viewer-modes", bar);
  const modeButtons: Record<ViewMode, HTMLButtonElement> = {
    one: button(modes, "square", "One at a time (1)"),
    side: button(modes, "columns-2", "Side by side (2)"),
    wipe: button(modes, "square-split-horizontal", "Slider (3)"),
  };
  el("span", "pw-viewer-sep pw-viewer-modes-sep", bar);
  const zoomOut = button(bar, "zoom-out", "Zoom out (-)", "pw-viewer-zoom");
  const level = el("button", "pw-viewer-level pw-viewer-zoom", bar);
  level.title = "Actual size, or fit when it is at actual size (0 fits)";
  const zoomIn = button(bar, "zoom-in", "Zoom in (+)", "pw-viewer-zoom");
  el("span", "pw-viewer-sep pw-viewer-zoom", bar);
  const external = button(bar, "external-link", "Open in its own app");
  const close = button(bar, "x", "Close (Esc)");
  const prev = button(root, "chevron-left", "Previous (←)", "pw-viewer-prev");
  const next = button(root, "chevron-right", "Next (→)", "pw-viewer-next");
  const caption = el("div", "pw-viewer-caption", root);
  const tabs = el("div", "pw-viewer-tabs", root);

  let index = start;
  let mode: ViewMode = opts.mode ?? loadMode();
  if (opts.mode) saveMode(opts.mode);
  let media: HTMLImageElement | HTMLVideoElement | undefined;
  /** the comparison shown all at once, when it is */
  let cmp: Compare | undefined;
  // the picture's natural size, and where and how big it is drawn
  let nw = 0;
  let nh = 0;
  let scale = 1;
  let fit = 1;
  let tx = 0;
  let ty = 0;

  const area = () => ({ w: stage.clientWidth, h: stage.clientHeight });
  const fitScale = () => {
    const { w, h } = area();
    // leave room for the previous and next buttons when the window is wide enough to spare it
    const side = items.length > 1 && w > 640 ? 128 : 48;
    return nw && nh ? Math.min((w - side) / nw, (h - 120) / nh, 1) : 1;
  };
  /** keeps a picture larger than the window from leaving it, and centres one that is smaller */
  const clamp = () => {
    const { w, h } = area();
    const dw = nw * scale;
    const dh = nh * scale;
    tx = dw <= w ? (w - dw) / 2 : Math.min(0, Math.max(w - dw, tx));
    ty = dh <= h ? (h - dh) / 2 : Math.min(0, Math.max(h - dh, ty));
  };
  const drawCompare = () => {
    if (!cmp) return;
    level.textContent = `${Math.round(cmp.level() * 100)}%`;
    zoomOut.disabled = !cmp.canZoomOut();
    zoomIn.disabled = !cmp.canZoomIn();
  };
  const draw = () => {
    if (!(media instanceof HTMLImageElement)) return;
    clamp();
    media.style.width = `${nw}px`;
    media.style.height = `${nh}px`;
    media.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    level.textContent = `${Math.round(scale * 100)}%`;
    root.classList.toggle("is-zoomed", scale > fit * 1.001);
    zoomOut.disabled = scale <= Math.min(fit, 1) * 0.5 + 1e-6;
    zoomIn.disabled = scale >= MAX_SCALE - 1e-6;
  };
  /** zoom to `to`, keeping the point (x, y) of the stage where it is */
  const zoomTo = (to: number, x = area().w / 2, y = area().h / 2) => {
    const s = Math.min(MAX_SCALE, Math.max(Math.min(fit, 1) * 0.5, to));
    tx = x - ((x - tx) * s) / scale;
    ty = y - ((y - ty) * s) / scale;
    scale = s;
    draw();
  };
  const toFit = () => {
    if (cmp) return cmp.fit();
    fit = fitScale();
    scale = fit;
    draw();
  };

  /** the comparison an item belongs to, when it has two or more pictures here */
  const groupOf = (i: number) => {
    const g = items[i]?.group;
    const members = g === undefined ? [] : items.map((x, k) => (x.group === g ? k : -1)).filter((k) => k >= 0);
    return members.length > 1 ? members : [];
  };
  /** where the videos are now, to carry to the next way of showing them */
  const momentNow = (): Moment | undefined => (cmp ? cmp.moment() : media instanceof HTMLVideoElement ? { t: media.currentTime, playing: !media.paused } : undefined);

  const show = (i: number) => {
    const before = items[index];
    const beforeIndex = index;
    const kept = { nw, nh, scale, tx, ty };
    index = (i + items.length) % items.length;
    const item = items[index]!;
    const members = groupOf(index);
    const sameGroup = before !== undefined && before.group !== undefined && before.group === item.group && (before !== item || beforeIndex === index);
    // flipping inside a comparison keeps the zoom and the spot when the pictures are the same size
    const same = before !== item && sameGroup && !item.video && media instanceof HTMLImageElement;
    // and a video comparison keeps the moment, and keeps playing if it was
    const moment = sameGroup ? momentNow() : undefined;
    if (media instanceof HTMLVideoElement) media.pause();
    cmp?.destroy();
    cmp = undefined;
    media = undefined;
    stage.replaceChildren();
    root.classList.remove("is-zoomed");
    modes.hidden = !members.length;
    bar.querySelector<HTMLElement>(".pw-viewer-modes-sep")!.hidden = !members.length;
    for (const [m, b] of Object.entries(modeButtons)) {
      b.classList.toggle("is-on", m === mode);
      b.setAttribute("aria-pressed", String(m === mode));
    }
    const all = members.length > 0 && mode !== "one";
    root.classList.toggle("is-compare", all);
    root.classList.toggle("is-video", !all && item.video);
    root.classList.toggle("has-nav", items.length > 1 && groupOf(index).length < items.length);
    if (all) {
      cmp = openCompare(
        stage,
        members.map((k) => items[k]!),
        mode as CompareMode,
        { icon: (e, n) => host.icon(e, n) },
        { moment, onZoom: drawCompare },
      );
      drawCompare();
    } else if (item.video) {
      const v = el("video", "pw-viewer-video", stage);
      v.controls = true;
      v.autoplay = !moment || moment.playing;
      v.setAttribute("controlslist", "nodownload noremoteplayback");
      if (moment) v.addEventListener("loadedmetadata", () => (v.currentTime = Math.min(moment.t, v.duration || moment.t)), { once: true });
      v.src = item.src;
      media = v;
    } else {
      const img = el("img", "pw-viewer-img", stage);
      img.alt = basename(item.file);
      img.draggable = false;
      img.addEventListener("load", () => {
        nw = img.naturalWidth;
        nh = img.naturalHeight;
        if (same && nw === kept.nw && nh === kept.nh) {
          fit = fitScale();
          ({ scale, tx, ty } = kept);
          draw();
        } else toFit();
        img.classList.add("is-ready");
      });
      img.src = item.src;
      media = img;
    }
    const nameOf = (x: ViewerItem) => (x.caption ? `${x.option ? `${x.option} · ` : ""}${x.caption}` : basename(x.file));
    if (all) {
      // each picture carries its own name; the line under them says where the comparison sits
      const first = members[0]! + 1;
      const last = members[members.length - 1]! + 1;
      caption.textContent = `${first}–${last} / ${items.length}`;
      caption.title = members.map((k) => items[k]!.file).join("\n");
    } else {
      const name = nameOf(item);
      caption.textContent = items.length > 1 ? `${name}  ·  ${index + 1} / ${items.length}` : name;
      caption.title = item.file;
    }
    tabs.replaceChildren();
    if (item.group !== undefined && !all) {
      items.forEach((x, k) => {
        if (x.group !== item.group) return;
        const b = el("button", k === index ? "pw-viewer-tab is-on" : "pw-viewer-tab", tabs, x.caption ?? basename(x.file));
        b.title = x.file;
        b.onclick = () => show(k);
      });
    }
    tabs.hidden = !tabs.childElementCount;
    caption.hidden = all && members.length === items.length;
    prev.hidden = next.hidden = items.length < 2 || (all && members.length === items.length);
  };
  /** the next one in `dir`; shown all at once, a comparison is one step */
  const go = (dir: 1 | -1) => {
    const members = cmp ? groupOf(index) : [];
    if (!members.length) return show(index + dir);
    let j = index;
    for (let n = 0; n < items.length; n++) {
      j = (j + dir + items.length) % items.length;
      if (!members.includes(j)) break;
    }
    // stepping back onto another comparison shows it from its first picture
    const other = groupOf(j);
    show(other.length && mode !== "one" ? other[0]! : j);
  };
  const setMode = (m: ViewMode) => {
    if (m === mode || !groupOf(index).length) return;
    mode = m;
    saveMode(m);
    show(index);
  };
  for (const [m, b] of Object.entries(modeButtons)) b.onclick = () => setMode(m as ViewMode);

  // ---- pointer: drag to pan, double click to zoom, a click beside the picture closes
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; beside: boolean } | undefined;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !(media instanceof HTMLImageElement)) return;
    // with the pointer captured every later event targets the stage, so note now where it went down
    drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false, beside: e.target === stage };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    root.classList.add("is-panning");
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    draw();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    const { moved, beside } = drag;
    drag = undefined;
    root.classList.remove("is-panning");
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    if (!moved && beside && e.type === "pointerup") done();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("click", (e) => {
    // a click on the dimmed space around a video closes too; the image path closes in pointerup
    if (e.target === stage && (media instanceof HTMLVideoElement || cmp)) done();
  });
  stage.addEventListener("dblclick", (e) => {
    // the stage holds the pointer capture, so the event names the stage: test the spot instead
    if (!(media instanceof HTMLImageElement)) return;
    const m = media.getBoundingClientRect();
    if (e.clientX < m.left || e.clientX > m.right || e.clientY < m.top || e.clientY > m.bottom) return;
    const r = stage.getBoundingClientRect();
    if (scale > fit * 1.001) toFit();
    else zoomTo(fit < 1 ? 1 : 2, e.clientX - r.left, e.clientY - r.top);
  });
  // wheel and trackpad pinch (which arrives as a wheel with ctrl held) zoom at the pointer
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!(media instanceof HTMLImageElement)) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomTo(scale * k, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );

  zoomIn.onclick = () => (cmp ? cmp.zoomBy(STEP) : zoomTo(scale * STEP));
  zoomOut.onclick = () => (cmp ? cmp.zoomBy(1 / STEP) : zoomTo(scale / STEP));
  level.onclick = () => {
    if (cmp) return Math.abs(cmp.level() - 1) < 0.001 ? cmp.fit() : cmp.actual();
    Math.abs(scale - 1) < 0.001 ? toFit() : zoomTo(1);
  };
  external.onclick = () => host.openExternal(items[index]!.file);
  close.onclick = () => done();
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);

  const onKey = (e: KeyboardEvent) => {
    const typing = (e.target instanceof HTMLVideoElement || e.target instanceof HTMLInputElement) && (e.key === " " || e.key.startsWith("Arrow"));
    const zooms = cmp || !items[index]!.video;
    if (e.key === "Escape") done();
    else if (typing && !(cmp && e.key === " ")) return;
    else if (cmp?.key(e)) {
      // played, paused or stepped
    } else if (e.key === "ArrowLeft" && items.length > 1) go(-1);
    else if (e.key === "ArrowRight" && items.length > 1) go(1);
    else if ((e.key === "1" || e.key === "2" || e.key === "3") && groupOf(index).length) setMode(e.key === "1" ? "one" : e.key === "2" ? "side" : "wipe");
    else if ((e.key === "+" || e.key === "=") && zooms) cmp ? cmp.zoomBy(STEP) : zoomTo(scale * STEP);
    else if (e.key === "-" && zooms) cmp ? cmp.zoomBy(1 / STEP) : zoomTo(scale / STEP);
    else if (e.key === "0" && zooms) toFit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  doc.addEventListener("keydown", onKey, true);
  const onResize = () => {
    if (cmp) return cmp.resize();
    if (!(media instanceof HTMLImageElement) || !nw) return;
    const atFit = Math.abs(scale - fit) < 0.001;
    fit = fitScale();
    if (atFit) scale = fit;
    draw();
  };
  win.addEventListener("resize", onResize);

  let closed = false;
  function done() {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKey, true);
    win.removeEventListener("resize", onResize);
    if (media instanceof HTMLVideoElement) media.pause();
    cmp?.destroy();
    cmp = undefined;
    root.classList.add("is-closing");
    const remove = () => root.remove();
    root.addEventListener("animationend", remove, { once: true });
    win.setTimeout(remove, 200);
    opener?.focus?.({ preventScroll: true });
  }

  show(start);
  root.focus({ preventScroll: true });
  return done;
}
