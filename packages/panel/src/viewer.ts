/**
 * A viewer over the whole window for a card's pictures and videos: the page dims, the picture
 * fits the window, and it zooms (wheel, pinch, double click, + and -) and pans (drag). Arrows go
 * to the card's other pictures. Esc, the close button or a click beside the picture closes it.
 */

export interface ViewerItem {
  file: string;
  /** a URL the page can load */
  src: string;
  video: boolean;
}

export interface ViewerHost {
  icon(el: HTMLElement, name: string): void;
  /** opens the file in the program the system picks */
  openExternal(file: string): void;
}

const MAX_SCALE = 8;
const STEP = 1.25;
const basename = (f: string) => f.split(/[\\/]/).pop() || f;

export function openViewer(doc: Document, items: ViewerItem[], start: number, host: ViewerHost): () => void {
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

  let index = start;
  let media: HTMLImageElement | HTMLVideoElement | undefined;
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
    fit = fitScale();
    scale = fit;
    draw();
  };

  const show = (i: number) => {
    index = (i + items.length) % items.length;
    const item = items[index]!;
    stage.replaceChildren();
    root.classList.toggle("is-video", item.video);
    root.classList.remove("is-zoomed");
    if (item.video) {
      const v = el("video", "pw-viewer-video", stage);
      v.controls = true;
      v.autoplay = true;
      v.setAttribute("controlslist", "nodownload noremoteplayback");
      v.src = item.src;
      media = v;
    } else {
      const img = el("img", "pw-viewer-img", stage);
      img.alt = basename(item.file);
      img.draggable = false;
      img.addEventListener("load", () => {
        nw = img.naturalWidth;
        nh = img.naturalHeight;
        toFit();
        img.classList.add("is-ready");
      });
      img.src = item.src;
      media = img;
    }
    caption.textContent = items.length > 1 ? `${basename(item.file)}  ·  ${index + 1} / ${items.length}` : basename(item.file);
    caption.title = item.file;
    prev.hidden = next.hidden = items.length < 2;
  };

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
    if (e.target === stage && media instanceof HTMLVideoElement) done();
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

  zoomIn.onclick = () => zoomTo(scale * STEP);
  zoomOut.onclick = () => zoomTo(scale / STEP);
  level.onclick = () => (Math.abs(scale - 1) < 0.001 ? toFit() : zoomTo(1));
  external.onclick = () => host.openExternal(items[index]!.file);
  close.onclick = () => done();
  prev.onclick = () => show(index - 1);
  next.onclick = () => show(index + 1);

  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLVideoElement && (e.key === " " || e.key.startsWith("Arrow"));
    if (e.key === "Escape") done();
    else if (typing) return;
    else if (e.key === "ArrowLeft" && items.length > 1) show(index - 1);
    else if (e.key === "ArrowRight" && items.length > 1) show(index + 1);
    else if ((e.key === "+" || e.key === "=") && !items[index]!.video) zoomTo(scale * STEP);
    else if (e.key === "-" && !items[index]!.video) zoomTo(scale / STEP);
    else if (e.key === "0" && !items[index]!.video) toFit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  doc.addEventListener("keydown", onKey, true);
  const onResize = () => {
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
