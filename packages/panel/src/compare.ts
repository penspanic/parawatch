/**
 * The pictures or videos of one comparison at once, inside the viewer: side by side, or laid over
 * each other with a line to drag between them (a slider). The zoom and the spot are shared, so the
 * same part of each stays in view. Videos run on one clock: the longest leads and the others follow
 * it, and one bar plays, pauses, moves and steps them all by a frame.
 */

export type CompareMode = "side" | "wipe";

export interface CompareItem {
  file: string;
  /** a URL the page can load */
  src: string;
  video: boolean;
  caption?: string;
  option?: number;
}

export interface CompareHost {
  icon(el: HTMLElement, name: string): void;
}

/** where the videos are, carried between the ways of showing them */
export interface Moment {
  t: number;
  playing: boolean;
}

export interface CompareOptions {
  /** start the videos here; without it they start at the beginning and play */
  moment?: Moment;
  /** the zoom changed, for the level button */
  onZoom?(): void;
}

export interface Compare {
  zoomBy(k: number): void;
  fit(): void;
  actual(): void;
  /** the zoom as a share of the first picture's own size */
  level(): number;
  canZoomIn(): boolean;
  canZoomOut(): boolean;
  /** handles a key of its own (play, frame steps); true when it did */
  key(e: KeyboardEvent): boolean;
  resize(): void;
  moment(): Moment | undefined;
  destroy(): void;
}

// ---- the clock: what a following video does to stay with the leading one

export interface Follower {
  t: number;
  duration: number;
  paused: boolean;
  seeking: boolean;
  rate: number;
}

export interface FollowStep {
  seek?: number;
  play?: boolean;
  pause?: boolean;
  rate?: number;
}

/** further apart than this while playing: jump instead of catching up */
export const JUMP = 0.25;
/** closer than this while playing: leave it */
export const SLACK = 0.008;
/** the most a follower speeds up or slows down to catch up, as a share of the speed */
export const CATCH_UP = 0.1;

/**
 * What a video following the leader does when the leader is at `lead` seconds. A video shorter
 * than the leader holds its last frame once the leader passes its end. Paused, it sits on the
 * leader's moment; playing, it plays a little faster or slower until it is with the leader, and
 * jumps when it is far behind or ahead.
 */
export function follow(lead: number, playing: boolean, speed: number, f: Follower): FollowStep {
  if (f.seeking) return {};
  const step: FollowStep = {};
  if (lead >= f.duration) {
    if (!f.paused) step.pause = true;
    if (Math.abs(f.t - f.duration) > 0.001) step.seek = f.duration;
    return step;
  }
  if (!playing) {
    if (!f.paused) step.pause = true;
    if (Math.abs(f.t - lead) > 0.001) step.seek = lead;
    if (f.rate !== speed) step.rate = speed;
    return step;
  }
  const drift = f.t - lead;
  if (f.paused) return { seek: lead, play: true, rate: speed };
  if (Math.abs(drift) > JUMP) return { seek: lead, ...(f.rate !== speed ? { rate: speed } : {}) };
  const want = Math.abs(drift) > SLACK ? speed * (1 - Math.max(-CATCH_UP, Math.min(CATCH_UP, drift * 2))) : speed;
  return Math.abs(want - f.rate) > 1e-3 ? { rate: want } : {};
}

/** 75.5 → "1:15.50" */
export function clockLabel(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00.00";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

// ---- the view: a box per pane that every picture in it fits, zoomed and moved together

export interface Size {
  w: number;
  h: number;
}

/** The box the pictures of a pane fit at zoom 1: the largest of them, fitted to the pane and never enlarged. */
export function baseBox(pane: Size, sizes: Size[]): Size {
  const ref = sizes.reduce<Size | undefined>((a, s) => (!a || s.w * s.h > a.w * a.h ? s : a), undefined);
  if (!ref || !(ref.w > 0 && ref.h > 0) || !(pane.w > 0 && pane.h > 0)) return { w: 0, h: 0 };
  const k = Math.min(pane.w / ref.w, pane.h / ref.h, 1);
  return { w: ref.w * k, h: ref.h * k };
}

/**
 * Where the box sits in the pane at zoom `z` with the spot (cx, cy) of the box (0 to 1) in the
 * middle: a box smaller than the pane is centred, a larger one never leaves a gap at an edge.
 */
export function boxOrigin(pane: Size, box: Size, z: number, cx: number, cy: number): { x: number; y: number } {
  const place = (room: number, size: number, c: number) => (size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, room / 2 - c * size)));
  return { x: place(pane.w, box.w * z, cx), y: place(pane.h, box.h * z, cy) };
}

/** A spot of the box kept from showing a gap at an edge at zoom `z` (0.5 when the box fits). */
export function keepSpot(room: number, size: number, c: number): number {
  if (size <= room) return 0.5;
  const half = room / 2 / size;
  return Math.min(1 - half, Math.max(half, c));
}

/**
 * The columns that show `n` pictures of shape `ratio` (width over height) largest in a `room`:
 * side by side in a wide window, one above the other in a tall one, or a grid between.
 */
export function bestColumns(n: number, ratio: number, room: Size, gap = 8): number {
  if (!(n > 1) || !(ratio > 0) || !(room.w > 0 && room.h > 0)) return Math.max(1, n);
  let best = n;
  let size = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = (room.w - gap * (cols - 1)) / cols;
    const h = (room.h - gap * (rows - 1)) / rows;
    const s = Math.min(w / ratio, h);
    if (s > size + 1e-6) {
      size = s;
      best = cols;
    }
  }
  return best;
}

const MAX_SCALE = 8;
const STEP_DEFAULT = 1 / 30;
const basename = (f: string) => f.split(/[\\/]/).pop() || f;

interface Layer {
  item: CompareItem;
  holder: HTMLElement;
  media: HTMLImageElement | HTMLVideoElement;
  w: number;
  h: number;
}

interface Pane {
  el: HTMLElement;
  layers: Layer[];
  divider?: HTMLElement;
  labels: HTMLElement[];
}

export function openCompare(stage: HTMLElement, items: CompareItem[], mode: CompareMode, host: CompareHost, opts: CompareOptions = {}): Compare {
  const doc = stage.ownerDocument;
  const win = doc.defaultView ?? window;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    parent?.appendChild(e);
    return e;
  };
  const button = (parent: HTMLElement, icon: string, label: string, cls = "") => {
    const b = el("button", `pw-cmp-btn ${cls}`.trim(), parent);
    host.icon(b, icon);
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  };
  const name = (x: CompareItem) => `${x.option ? `${x.option} · ` : ""}${x.caption ?? basename(x.file)}`;

  const root = el("div", `pw-cmp is-${mode}`, stage);
  const panesEl = el("div", "pw-cmp-panes", root);
  const note = el("div", "pw-cmp-note", root);
  note.hidden = true;

  // the slider shows two at a time: the left one under, the right one over it, cut at the line
  let shown = mode === "wipe" ? [0, 1] : items.map((_, k) => k);
  /** the side replaced next when another picture is picked for the slider */
  let older = 1;
  let split = 0.5;
  let z = 1;
  let cx = 0.5;
  let cy = 0.5;
  let panes: Pane[] = [];
  const layers: Layer[] = [];
  /** counts rebuilds, so a picture taken away does not report to the clock of the new ones */
  let generation = 0;

  const makeLayer = (pane: HTMLElement, item: CompareItem): Layer => {
    const holder = el("div", "pw-cmp-layer", pane);
    const media = item.video ? el("video", "pw-cmp-media", holder) : el("img", "pw-cmp-media", holder);
    const layer: Layer = { item, holder, media, w: 0, h: 0 };
    const gen = generation;
    if (media instanceof HTMLVideoElement) {
      media.preload = "auto";
      media.playsInline = true;
      media.muted = true;
      media.addEventListener("loadedmetadata", () => {
        layer.w = media.videoWidth;
        layer.h = media.videoHeight;
        if (gen !== generation) return;
        sized();
        ready();
      });
      media.addEventListener("error", () => gen === generation && ready());
    } else {
      media.alt = item.caption ?? basename(item.file);
      media.draggable = false;
      media.addEventListener("load", () => {
        layer.w = media.naturalWidth;
        layer.h = media.naturalHeight;
        sized();
      });
    }
    media.src = item.src;
    layers.push(layer);
    return layer;
  };

  const build = () => {
    panesEl.replaceChildren();
    if (mode === "side") {
      panes = items.map((item) => {
        const p = el("div", "pw-cmp-pane", panesEl);
        const layer = makeLayer(p, item);
        const label = el("div", "pw-cmp-label", p, name(item));
        label.title = item.file;
        return { el: p, layers: [layer], labels: [label] };
      });
    } else {
      const p = el("div", "pw-cmp-pane", panesEl);
      const ls = shown.map((k) => makeLayer(p, items[k]!));
      ls[1]?.holder.classList.add("is-over");
      const divider = el("div", "pw-cmp-divider", p);
      el("div", "pw-cmp-grip", divider);
      divider.title = "Drag to move the line, or click the picture where it should be";
      const labels = shown.map((k, j) => {
        const label = el("div", j ? "pw-cmp-label is-right" : "pw-cmp-label", p, name(items[k]!));
        label.title = items[k]!.file;
        return label;
      });
      panes = [{ el: p, layers: ls, divider, labels }];
    }
  };
  build();

  // ---- drawing
  const paneSize = (p: Pane): Size => ({ w: p.el.clientWidth, h: p.el.clientHeight });
  const box = (p: Pane) => baseBox(paneSize(p), p.layers.filter((l) => l.w && l.h).map((l) => ({ w: l.w, h: l.h })));
  /** pixels of the first picture's own size per pixel on screen at zoom 1 */
  const fitPx = () => {
    const p = panes[0];
    const l = p?.layers.find((x) => x.w);
    if (!p || !l) return 1;
    const b = box(p);
    return b.w && l.w ? Math.min(b.w / l.w, b.h / l.h) : 1;
  };
  const maxZ = () => MAX_SCALE / fitPx();
  const keep = () => {
    const p = panes[0];
    if (!p) return;
    const s = paneSize(p);
    const b = box(p);
    cx = keepSpot(s.w, b.w * z, cx);
    cy = keepSpot(s.h, b.h * z, cy);
  };
  const draw = () => {
    for (const p of panes) {
      const s = paneSize(p);
      const b = box(p);
      if (!b.w) continue;
      const o = boxOrigin(s, b, z, cx, cy);
      // names sit on the picture's top corners, not the pane's
      for (const label of p.labels) label.style.top = `${Math.max(0, o.y) + 8}px`;
      for (const l of p.layers) {
        if (!l.w) continue;
        const k = Math.min(b.w / l.w, b.h / l.h);
        const lw = l.w * k * z;
        const lh = l.h * k * z;
        l.media.style.width = `${l.w}px`;
        l.media.style.height = `${l.h}px`;
        l.media.style.transform = `translate(${o.x + (b.w * z - lw) / 2}px, ${o.y + (b.h * z - lh) / 2}px) scale(${k * z})`;
        l.media.classList.add("is-ready");
      }
      if (p.divider) {
        // the line stays on the picture
        const left = Math.max(0, o.x);
        const right = Math.min(s.w, o.x + b.w * z);
        const x = Math.min(right, Math.max(left, split * s.w));
        p.layers[1]?.holder.style.setProperty("clip-path", `inset(0 0 0 ${x}px)`);
        p.divider.style.left = `${x}px`;
        const top = Math.max(0, o.y);
        p.divider.style.top = `${top}px`;
        p.divider.style.height = `${Math.min(s.h, o.y + b.h * z) - top}px`;
      }
    }
    root.classList.toggle("is-zoomed", z > 1.001);
    opts.onZoom?.();
  };
  /** side by side, in rows or a column, whichever shows the pictures largest */
  const arrange = () => {
    if (mode !== "side") return;
    const l = layers.find((x) => x.w && x.h);
    const cols = l ? bestColumns(panes.length, l.w / l.h, { w: panesEl.clientWidth, h: panesEl.clientHeight }) : panes.length;
    panesEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    panesEl.style.gridTemplateRows = `repeat(${Math.ceil(panes.length / cols)}, minmax(0, 1fr))`;
  };
  const sized = () => {
    arrange();
    const sizes = layers.filter((l) => l.w).map((l) => `${l.w}×${l.h}`);
    const differ = new Set(sizes).size > 1;
    note.hidden = !differ;
    if (differ) note.textContent = `Not the same size: ${sizes.join(", ")}`;
    keep();
    draw();
  };
  /** zoom to `to`, keeping the spot under (x, y) of pane `p` where it is */
  const zoomTo = (to: number, p = panes[0], x?: number, y?: number) => {
    if (!p) return;
    const s = paneSize(p);
    const b = box(p);
    if (!b.w) return;
    const px = x ?? s.w / 2;
    const py = y ?? s.h / 2;
    const o = boxOrigin(s, b, z, cx, cy);
    const u = (px - o.x) / (b.w * z);
    const v = (py - o.y) / (b.h * z);
    const nz = Math.min(maxZ(), Math.max(0.5, to));
    // put (u, v) under the pointer again: the spot in the middle moves by the change
    cx = u + (s.w / 2 - px) / (b.w * nz);
    cy = v + (s.h / 2 - py) / (b.h * nz);
    z = nz;
    keep();
    draw();
  };

  // ---- pointer: drag to pan when zoomed, drag the line or click to move it, double click zooms
  // the panes hold the pointer capture while dragging, so later events name them: find the pane by the spot
  const paneAt = (x: number, y: number) =>
    panes.find((p) => {
      const r = p.el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  let drag: { p: Pane; x: number; y: number; cx: number; cy: number; line: boolean; moved: boolean; id: number } | undefined;
  const moveLine = (p: Pane, clientX: number) => {
    const r = p.el.getBoundingClientRect();
    split = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    draw();
  };
  panesEl.addEventListener("pointerdown", (e) => {
    const p = paneAt(e.clientX, e.clientY);
    if (e.button !== 0 || !p) return;
    const line = !!p.divider && p.divider.contains(e.target as Node);
    drag = { p, x: e.clientX, y: e.clientY, cx, cy, line, moved: false, id: e.pointerId };
    panesEl.setPointerCapture(e.pointerId);
    if (line) root.classList.add("is-sliding");
  });
  panesEl.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    if (drag.line) return moveLine(drag.p, e.clientX);
    if (z <= 1.001) return;
    root.classList.add("is-panning");
    const b = box(drag.p);
    cx = drag.cx - dx / (b.w * z);
    cy = drag.cy - dy / (b.h * z);
    keep();
    draw();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = undefined;
    root.classList.remove("is-panning", "is-sliding");
    if (panesEl.hasPointerCapture(e.pointerId)) panesEl.releasePointerCapture(e.pointerId);
    // a click on the slider's picture puts the line there
    if (!d.moved && e.type === "pointerup" && d.p.divider) moveLine(d.p, e.clientX);
  };
  panesEl.addEventListener("pointerup", endDrag);
  panesEl.addEventListener("pointercancel", endDrag);
  panesEl.addEventListener("dblclick", (e) => {
    const p = paneAt(e.clientX, e.clientY);
    if (!p) return;
    const r = p.el.getBoundingClientRect();
    if (z > 1.001) {
      z = 1;
      cx = cy = 0.5;
      draw();
    } else zoomTo(fitPx() < 1 ? 1 / fitPx() : 2, p, e.clientX - r.left, e.clientY - r.top);
  });
  panesEl.addEventListener(
    "wheel",
    (e) => {
      const p = paneAt(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const r = p.el.getBoundingClientRect();
      zoomTo(z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), p, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );

  // ---- the clock for videos: the longest leads, one bar for all
  const transport = el("div", "pw-cmp-transport", root);
  const playBtn = button(transport, "play", "Play (Space)");
  const back = button(transport, "step-back", "Previous frame (,)");
  const fwd = button(transport, "step-forward", "Next frame (.)");
  const time = el("span", "pw-cmp-time", transport, "0:00.00");
  const scrub = el("input", "pw-cmp-scrub", transport);
  scrub.type = "range";
  scrub.min = "0";
  scrub.step = "any";
  scrub.value = "0";
  scrub.setAttribute("aria-label", "Moment");
  const loopBtn = button(transport, "repeat", "Play again from the start at the end", "is-loop is-on");
  const muteBtn = button(transport, "volume-2", "Sound of the longest video (M)");

  let loop = true;
  let muted = false;
  loopBtn.onclick = () => {
    loop = !loop;
    loopBtn.classList.toggle("is-on", loop);
  };

  interface Clock {
    lead?: HTMLVideoElement;
    videos: HTMLVideoElement[];
    playing: boolean;
    frame: number;
    play(): void;
    pause(): void;
    seek(t: number): void;
    stepBy(n: number): void;
    moment(): Moment | undefined;
    stop(): void;
    ready(): void;
  }

  const makeClock = (start: Moment | undefined): Clock => {
    const videos = layers.map((l) => l.media).filter((m): m is HTMLVideoElement => m instanceof HTMLVideoElement);
    transport.hidden = !videos.length;
    let waiting = videos.length;
    let raf = 0;
    let stopped = false;
    const c: Clock = {
      videos,
      playing: false,
      frame: STEP_DEFAULT,
      play() {
        const lead = c.lead;
        if (!lead) return;
        if (lead.ended || lead.currentTime >= lead.duration - 0.001) c.seek(0);
        c.playing = true;
        void lead.play().catch(() => {});
        sync();
        tick();
        paint();
      },
      pause() {
        c.playing = false;
        c.lead?.pause();
        sync();
        paint();
      },
      seek(t: number) {
        const lead = c.lead;
        if (!lead) return;
        const at = Math.max(0, Math.min(t, lead.duration || 0));
        lead.currentTime = at;
        for (const v of videos) if (v !== lead) v.currentTime = Math.min(at, v.duration || 0);
        paint();
      },
      stepBy(n: number) {
        if (!c.lead) return;
        c.pause();
        c.seek(c.lead.currentTime + n * c.frame);
      },
      moment: () => (c.lead ? { t: c.lead.currentTime, playing: c.playing } : start),
      stop() {
        stopped = true;
        doc.removeEventListener("visibilitychange", shown);
        win.cancelAnimationFrame(raf);
        for (const v of videos) v.pause();
      },
      ready() {
        if (--waiting > 0 || stopped) return;
        const ok = videos.filter((v) => v.readyState >= 1 && v.duration > 0);
        c.lead = ok.reduce<HTMLVideoElement | undefined>((a, v) => (!a || v.duration > a.duration ? v : a), undefined);
        const lead = c.lead;
        if (!lead) return;
        for (const v of videos) v.muted = v !== lead || muted;
        scrub.max = String(lead.duration);
        lead.addEventListener("ended", () => {
          if (stopped) return;
          if (loop && c.playing) {
            c.seek(0);
            void lead.play().catch(() => {});
          } else c.pause();
        });
        // the leader paused from its own end (the system's media keys): follow it. A hidden window
        // pauses videos without sound by itself and plays them again when it shows; that is not a pause.
        lead.addEventListener("pause", () => {
          if (!stopped && c.playing && !lead.ended && !doc.hidden) c.pause();
        });
        lead.addEventListener("seeked", () => sync());
        watchFrames(lead);
        c.seek(start?.t ?? 0);
        if (start?.playing ?? true) c.play();
        else paint();
      },
    };
    /** one frame's length, from the frames the leader shows while it plays */
    const watchFrames = (v: HTMLVideoElement) => {
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number }).requestVideoFrameCallback;
      if (!rvfc) return;
      let last: { t: number; n: number } | undefined;
      const seen: number[] = [];
      const on = (_now: number, meta: { mediaTime: number; presentedFrames: number }) => {
        if (stopped) return;
        if (last && meta.presentedFrames === last.n + 1) {
          const d = meta.mediaTime - last.t;
          if (d > 0.001 && d < 0.5) {
            seen.push(d);
            if (seen.length > 30) seen.shift();
            c.frame = [...seen].sort((a, b) => a - b)[Math.floor(seen.length / 2)]!;
          }
        }
        last = { t: meta.mediaTime, n: meta.presentedFrames };
        rvfc.call(v, on);
      };
      rvfc.call(v, on);
    };
    const sync = () => {
      const lead = c.lead;
      if (!lead) return;
      for (const v of videos) {
        if (v === lead) continue;
        const s = follow(lead.currentTime, c.playing, lead.playbackRate, { t: v.currentTime, duration: v.duration || 0, paused: v.paused, seeking: v.seeking, rate: v.playbackRate });
        if (s.rate !== undefined) v.playbackRate = s.rate;
        if (s.pause) v.pause();
        if (s.seek !== undefined) v.currentTime = s.seek;
        if (s.play) void v.play().catch(() => {});
      }
    };
    const tick = () => {
      win.cancelAnimationFrame(raf);
      const loopFn = () => {
        if (stopped || !c.playing) return;
        sync();
        paint();
        raf = win.requestAnimationFrame(loopFn);
      };
      raf = win.requestAnimationFrame(loopFn);
    };
    const paint = () => {
      const lead = c.lead;
      host.icon(playBtn, c.playing ? "pause" : "play");
      playBtn.title = c.playing ? "Pause (Space)" : "Play (Space)";
      if (!lead) return;
      time.textContent = `${clockLabel(lead.currentTime)} / ${clockLabel(lead.duration)}`;
      if (!scrubbing) scrub.value = String(lead.currentTime);
    };
    const shown = () => {
      if (doc.hidden || stopped || !c.playing || !c.lead?.paused) return;
      void c.lead.play().catch(() => {});
      tick();
    };
    doc.addEventListener("visibilitychange", shown);
    if (!videos.length) waiting = 0;
    return c;
  };

  let scrubbing: { playing: boolean } | undefined;
  scrub.addEventListener("pointerdown", () => {
    scrubbing = { playing: clock.playing };
    if (clock.playing) clock.pause();
  });
  scrub.addEventListener("input", () => clock.seek(Number(scrub.value)));
  const endScrub = () => {
    if (!scrubbing) return;
    const was = scrubbing.playing;
    scrubbing = undefined;
    if (was) clock.play();
  };
  scrub.addEventListener("pointerup", endScrub);
  scrub.addEventListener("pointercancel", endScrub);
  scrub.addEventListener("change", endScrub);
  playBtn.onclick = () => (clock.playing ? clock.pause() : clock.play());
  back.onclick = () => clock.stepBy(-1);
  fwd.onclick = () => clock.stepBy(1);
  const setMuted = (m: boolean) => {
    muted = m;
    if (clock.lead) clock.lead.muted = m;
    host.icon(muteBtn, m ? "volume-x" : "volume-2");
  };
  muteBtn.onclick = () => setMuted(!muted);

  let clock = makeClock(opts.moment);
  function ready() {
    clock.ready();
  }
  if (!clock.videos.length) transport.hidden = true;

  // ---- the slider's pick: which two of three or more are shown
  if (mode === "wipe" && items.length > 2) {
    const pick = el("div", "pw-cmp-pick", root);
    const tabs = items.map((x, k) => {
      const b = el("button", "pw-cmp-tab", pick);
      el("span", "pw-cmp-side", b);
      el("span", "", b, name(x));
      b.title = x.file;
      b.onclick = () => choose(k);
      return b;
    });
    const mark = () =>
      tabs.forEach((b, k) => {
        const j = shown.indexOf(k);
        b.classList.toggle("is-on", j >= 0);
        b.querySelector(".pw-cmp-side")!.textContent = j === 0 ? "L" : j === 1 ? "R" : "";
      });
    // a shown one swaps sides; another takes the side picked longer ago
    const choose = (k: number) => {
      const j = shown.indexOf(k);
      if (j >= 0) shown = [shown[1]!, shown[0]!];
      else {
        shown[older] = k;
        older = 1 - older;
      }
      const m = clock.moment();
      clock.stop();
      generation++;
      layers.length = 0;
      build();
      clock = makeClock(m);
      mark();
      win.requestAnimationFrame(() => draw());
    };
    mark();
  }


  arrange();
  const ro =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          arrange();
          draw();
        });
  ro?.observe(panesEl);

  return {
    zoomBy: (k) => zoomTo(z * k),
    fit: () => {
      z = 1;
      cx = cy = 0.5;
      draw();
    },
    actual: () => zoomTo(1 / fitPx()),
    level: () => z * fitPx(),
    canZoomIn: () => z < maxZ() - 1e-6,
    canZoomOut: () => z > 0.5 + 1e-6,
    key: (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (!clock.videos.length) return false;
      if (e.key === " ") clock.playing ? clock.pause() : clock.play();
      else if (e.key === ",") clock.stepBy(-1);
      else if (e.key === ".") clock.stepBy(1);
      else if (e.key === "m" || e.key === "M") setMuted(!muted);
      else return false;
      return true;
    },
    resize: () => {
      arrange();
      keep();
      draw();
    },
    moment: () => clock.moment(),
    destroy: () => {
      clock.stop();
      ro?.disconnect();
      root.remove();
    },
  };
}
