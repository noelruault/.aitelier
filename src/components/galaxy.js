import { allEntities, findById } from "../lib/storage.js";
import { humanizeName } from "../lib/util.js";
import { navigateTo } from "../router.js";
import { getCapabilitiesSync } from "../data/capabilities.js";

/* Galaxy view — a physics "marble bag". Every entity is a labelled pill; each
 * category TAG sits at its cluster centre with the pills radiating out on spokes.
 * Pills hard-collide (no label overlaps) and follow their tag; the residue that
 * cannot fit is hidden to a faint dot (hover reveals it). Drag a pill to reshuffle,
 * click it to open the deep-dive, drag the background to pan, wheel/buttons to zoom.
 *
 *   renderGalaxy(mountEl[, { entities, onSelect }])
 *
 * Two layouts (an A/B switch, default from env via capabilities.galaxyLayout):
 *   - "islands": tags repel each other → categories spread as distinct islands.
 *   - "circle":  tags snap to a ring → the classic clusters-on-a-circle look.
 *
 * ponytail: O(n²) collision per tick — fine for a curated library (tens of nodes);
 * add a grid index only if it grows huge. */

export const SEP = 0.85;      // separation strength (how hard overlaps push apart)
export const CLUSTER = 0.016; // pull of each pill toward its tag + slot (short leash)
export const MARGIN = 10;     // gap kept around every label box
const DAMP = 0.88;            // velocity damping per tick
const ITERS = 8;              // collision relaxation passes per tick
const HEAD_MASS = 10;         // headings are heavy → entity pills yield around them
const TAG_PAD = 16;           // extra exclusion zone around a tag so nothing crowds it
const ISLAND_GAP = 18;        // empty space wanted between two island edges (compact but clear)
const FONT_NODE_PX = 13;
const FONT_CAT_PX = 12;
const CAT_LS = "0.14em";      // tag letter-spacing — MUST be applied when measuring too,
                              // else the collision box is narrower than the drawn text
const SANS = 'Optima, "Avenir Next", Avenir, "Gill Sans", "Helvetica Neue", system-ui, sans-serif';

// Per-layout force tuning. "islands": weak home pull + tag↔tag repulsion → spread.
// "circle": strong home pull + no repulsion → clusters lock onto the ring.
const LAYOUTS = {
  islands: { tagHome: 0.006, island: 0.07 },
  circle:  { tagHome: 0.06,  island: 0 },
};
const LAYOUT_KEY = "aitelier-galaxy-layout-v1";

// Resolve the starting layout: a per-tab user choice (localStorage) wins; else the
// deployment default advertised by the Worker env (capabilities.galaxyLayout); else
// "islands". The A/B switch writes localStorage so it sticks across reloads.
export function galaxyLayoutDefault() {
  try { const v = localStorage.getItem(LAYOUT_KEY); if (LAYOUTS[v]) return v; } catch { /* private mode */ }
  const cap = getCapabilitiesSync();
  if (cap && LAYOUTS[cap.galaxyLayout]) return cap.galaxyLayout;
  // device default: phones get islands (room to spread + zoom); tablets/desktop circle.
  const phone = typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
  return phone ? "islands" : "circle";
}

export function nodeRadiusForType(t) {
  if (t === "prompts") return 6.5;
  if (t === "skills") return 5.5;
  if (t === "agents") return 5;
  if (t === "hooks") return 4.5;
  return 5;
}

export function groupByCategory(entities) {
  const m = new Map();
  for (const e of entities) {
    const cat = e.category || "uncategorized";
    if (!m.has(cat)) m.set(cat, []);
    m.get(cat).push(e);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  return m;
}

export function legendChip(cat, count) {
  const fill = `var(--cat-${escapeAttr(cat)}, var(--cat-default))`;
  return `<span class="galaxy-legend-chip inline-flex items-center gap-1.5"><span class="dot inline-block w-[9px] h-[9px] rounded-full" style="background:${fill}"></span>${escapeAttr(cat)}<span class="galaxy-legend-count ml-1 text-ink-faint">${count}</span></span>`;
}

export function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// deterministic [0,1) from a string — stable initial jitter without Math.random
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

export function renderGalaxy(mount, opts) {
  if (!mount) return;
  if (typeof mount._galaxyStop === "function") mount._galaxyStop();

  const o = opts || {};
  const entities = o.entities || allEntities();
  if (!entities.length) {
    mount.innerHTML = `<div class="galaxy-empty py-12 px-4 text-center font-display italic text-ink-mute">No entities loaded. Add a markdown to <code>prompts/</code>, <code>skills/</code>, or <code>agents/</code>.</div>`;
    return;
  }

  const byCat = groupByCategory(entities);
  const cats = [...byCat.keys()].sort();
  let mode = galaxyLayoutDefault();

  const ctlBtn = "px-2.5 py-1 rounded-full text-ink-mute cursor-pointer transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-paper";
  const zoomBtn = "w-7 h-7 inline-flex items-center justify-center rounded-full border border-rule bg-paper/90 text-ink-mute cursor-pointer transition-colors hover:text-ink hover:border-ink leading-none";
  mount.innerHTML = `
    <div class="galaxy-frame bg-paper border border-rule rounded-md px-3 pt-3 pb-4">
      <div class="galaxy-canvas-wrap relative w-full h-[76vh] min-h-[520px] max-h-[900px] overflow-hidden rounded">
        <canvas class="galaxy-canvas block w-full h-full touch-none" role="img" aria-label="Entity galaxy — drag a node to reshuffle, click to open it, drag the background to pan, scroll or pinch to zoom"></canvas>
        <div class="galaxy-layout-switch absolute top-2.5 right-2.5 z-10 inline-flex rounded-full border border-rule bg-paper/90 backdrop-blur p-[3px] font-mono text-[11px] uppercase tracking-[.14em]" role="group" aria-label="Galaxy layout">
          <button type="button" data-layout="islands" class="${ctlBtn}">Islands</button>
          <button type="button" data-layout="circle" class="${ctlBtn}">Circle</button>
        </div>
        <div class="galaxy-zoom absolute bottom-2.5 right-2.5 z-10 inline-flex gap-1.5 font-mono text-[13px]">
          <button type="button" data-zoom="out" class="${zoomBtn}" aria-label="Zoom out">&minus;</button>
          <button type="button" data-zoom="reset" class="${zoomBtn}" aria-label="Reset zoom" title="Reset view">&#8862;</button>
          <button type="button" data-zoom="in" class="${zoomBtn}" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div class="galaxy-legend flex flex-wrap gap-x-4 gap-y-2.5 mt-3 pt-3 border-t border-dashed border-rule font-mono text-[10.5px] tracking-[.14em] uppercase text-ink-mute">${cats.map(c => legendChip(c, byCat.get(c).length)).join("")}</div>
    </div>
  `;

  const canvas = mount.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Resolve theme colours (paper/ink + per-category) through a probe element so
  // the canvas stays in sync with the CSS custom properties — no hardcoded hex.
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:-9999px";
  mount.appendChild(probe);
  const col = (expr, fb) => { probe.style.color = ""; probe.style.color = expr; const c = getComputedStyle(probe).color; return c || fb; };
  const C = {
    edge: col("var(--paper-edge)", "#d8cbb4"),
    ink: col("var(--ink)", "#1d1a17"),
    inkSoft: col("var(--ink-soft)", "#3a342d"),
    inkMute: col("var(--ink-mute)", "#6b6358"),
  };
  const catColor = (cat) => col(`var(--cat-${cat}, var(--cat-default))`, "#555049");

  // --- build marbles: one pill per entity + one heavy tag per category ---
  const nodes = [];
  const anchors = {};
  const headOf = {};
  cats.forEach((cat, i) => {
    const t = cats.length <= 1 ? -Math.PI / 2 : (i / cats.length) * Math.PI * 2 - Math.PI / 2;
    anchors[cat] = { t, x: 0, y: 0 };
  });
  for (const cat of cats) {
    const members = byCat.get(cat);
    const m = members.length;
    const color = catColor(cat);
    // tag at cluster CENTRE → measure it first (with letter-spacing, so the sub-ring
    // and collision box match the drawn width) and size the sub-ring to clear it.
    const label = cat.replace(/-/g, " ").toUpperCase();
    ctx.font = "600 " + FONT_CAT_PX + "px " + SANS;
    ctx.letterSpacing = CAT_LS;
    const lw = ctx.measureText(label).width + 16;
    ctx.letterSpacing = "0px";
    // sub-ring sized to give every member room on the ring (≈ pill width of arc each)
    // so dense clusters collide less; labels are NEVER hidden, just packed.
    const subR = Math.max(Math.min(150, 44 + m * 16), lw / 2 + 30);
    let maxMW = 0;
    members.forEach((e, k) => {
      const dotR = nodeRadiusForType(e.type);
      const name = humanizeName(e.name);
      ctx.font = FONT_NODE_PX + "px " + SANS;
      const tw = ctx.measureText(name).width;
      const w = 12 + dotR * 2 + 7 + tw + 12;       // padL + dot + gap + text + padR
      if (w > maxMW) maxMW = w;
      // a lone pill points radially OUTWARD (away from the crowded centre) so it
      // doesn't dive into neighbouring clusters; multi-member pills ring the tag.
      const ang = m <= 1 ? anchors[cat].t : (k / m) * Math.PI * 2 - Math.PI / 2;
      nodes.push({ kind: "node", id: e.name, name, cat, color, dotR, w, h: 26, ox: Math.cos(ang) * subR, oy: Math.sin(ang) * subR, x: 0, y: 0, vx: 0, vy: 0, fixed: false, hidden: false });
    });
    // island radius: sub-ring + how far the widest pill juts out (so wide clusters
    // claim the room they really occupy when repelling other islands).
    const reach = subR + maxMW * 0.42 + 8;
    const head = { kind: "cat", name: label, cat, color, w: lw, h: 22, ox: 0, oy: 0, reach, x: 0, y: 0, vx: 0, vy: 0, fixed: false, hidden: false, mass: HEAD_MASS };
    headOf[cat] = head;
    nodes.push(head);
  }
  const heads = nodes.filter(n => n.kind === "cat");
  mount.removeChild(probe);

  let W = 0, H = 0, dpr = 1, scattered = false;       // W/H = viewport (CSS px)
  let worldW = 0, worldH = 0;                          // physics world (≥ viewport)
  let running = false, rafId = 0, frames = 0, idle = 0;
  let dragging = null, dragDX = 0, dragDY = 0, downAt = null, hover = null;
  let panning = false, panLast = null, userZoomed = false;
  const pointers = new Map();                          // active touch/mouse pointers (for pinch)
  let pinch = null;
  const view = { scale: 1, tx: 0, ty: 0 };             // world→screen: screen = world*scale + t

  let ringR = 0;
  // Size the physics WORLD to the content (not the viewport) so the clusters have
  // room to settle as separated, non-intertwining groups. The view then fits the
  // whole world on screen (zoom/pan to explore). Mode-dependent: circle needs a big
  // ring (perimeter ∝ N); islands pack in 2D (more compact).
  function sizeWorld() {
    const N = heads.length || 1;
    const maxReach = heads.reduce((mx, h) => Math.max(mx, h.reach), 80);
    if (mode === "circle" && N > 1) {
      // ring radius so adjacent cluster disks (~2·maxReach) don't overlap (capped)
      ringR = Math.min(1100, Math.max(300, (2 * maxReach + 60) / (2 * Math.sin(Math.PI / N))));
      worldW = worldH = Math.round(2 * (ringR + maxReach + 50));
    } else {
      // islands: 2D world just big enough that the repulsion separates the clusters
      // without wall-cramming — tight enough to read as one galaxy, not scattered dust.
      const area = heads.reduce((s, h) => s + Math.PI * h.reach * h.reach, 0);
      worldW = worldH = Math.round(Math.max(820, Math.sqrt(area * 1.7)));
      ringR = Math.min(worldW, worldH) * 0.30;
    }
  }
  function layoutAnchors() {
    const cx = worldW / 2, cy = worldH / 2;
    for (const cat in anchors) { const a = anchors[cat]; a.x = cx + Math.cos(a.t) * ringR; a.y = cy + Math.sin(a.t) * ringR; }
  }
  function scatter() {
    for (const n of nodes) {
      const a = anchors[n.cat];
      n.x = a.x + (n.ox || 0) + (hash(n.name + "x") - 0.5) * 10;
      n.y = a.y + (n.oy || 0) + (hash(n.name + "y") - 0.5) * 10;
      n.vx = 0; n.vy = 0; n.fixed = false;
    }
  }

  // one physics tick: soft pulls (mode-dependent) + island repulsion, then a hard
  // collision constraint (the no-overlap guarantee, resolved every tick).
  function step() {
    const tagHome = LAYOUTS[mode].tagHome, island = LAYOUTS[mode].island;
    for (const n of nodes) {
      if (n.fixed) continue;
      if (n.kind === "cat") {
        const a = anchors[n.cat];
        n.vx += (a.x - n.x) * tagHome;
        n.vy += (a.y - n.y) * tagHome;
      } else {
        const h = headOf[n.cat];
        n.vx += (h.x + n.ox - n.x) * CLUSTER;
        n.vy += (h.y + n.oy - n.y) * CLUSTER;
      }
    }
    if (island > 0) {
      for (let i = 0; i < heads.length; i++) {
        for (let j = i + 1; j < heads.length; j++) {
          const a = heads[i], b = heads[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const want = a.reach + b.reach + ISLAND_GAP;
          if (dist < want) {
            const push = (want - dist) * island * 0.5, ux = dx / dist, uy = dy / dist;
            if (!a.fixed) { a.vx -= ux * push; a.vy -= uy * push; }
            if (!b.fixed) { b.vx += ux * push; b.vy += uy * push; }
          }
        }
      }
    }
    let ke = 0;
    for (const n of nodes) {
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= DAMP; n.vy *= DAMP; n.x += n.vx; n.y += n.vy; ke += n.vx * n.vx + n.vy * n.vy;
    }
    for (let it = 0; it < ITERS; it++) {
      let any = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          // a tag claims its own space: pills must keep MARGIN + TAG_PAD clear of it.
          const pad = MARGIN + (a.kind === "cat" || b.kind === "cat" ? TAG_PAD : 0);
          const ox = (a.w + b.w) / 2 + pad - Math.abs(dx);
          const oy = (a.h + b.h) / 2 + pad - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            any++;
            const ma = a.mass || 1, mb = b.mass || 1, wa = mb / (ma + mb), wb = ma / (ma + mb);
            if (ox < oy) {
              const s = (dx < 0 ? -1 : 1) * ox * SEP;
              if (!a.fixed) a.x -= s * wa; if (!b.fixed) b.x += s * wb;
            } else {
              const s = (dy < 0 ? -1 : 1) * oy * SEP;
              if (!a.fixed) a.y -= s * wa; if (!b.fixed) b.y += s * wb;
            }
          }
        }
      }
      if (!any) break;
    }
    const pad = 16;
    for (const n of nodes) {
      const hw = n.w / 2, hh = n.h / 2;
      if (n.x < pad + hw) n.x = pad + hw;
      if (n.x > worldW - pad - hw) n.x = worldW - pad - hw;
      if (n.y < pad + hh) n.y = pad + hh;
      if (n.y > worldH - pad - hh) n.y = worldH - pad - hh;
    }
    return ke;
  }

  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

  function draw() {
    // clear in device space, then draw the world under the current zoom/pan view
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.tx * dpr, view.ty * dpr);

    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(106,99,88,0.18)";
    for (const n of nodes) {
      if (n.kind !== "node") continue;
      const head = headOf[n.cat];
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(n.x, n.y); ctx.stroke();
    }
    for (const pass of ["node", "cat"]) {
      for (const n of nodes) {
        if (n.kind !== pass) continue;
        const isHover = n === hover;
        if (n.kind === "cat") {
          ctx.font = "600 " + FONT_CAT_PX + "px " + SANS;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.letterSpacing = CAT_LS;
          const tw = ctx.measureText(n.name).width;
          ctx.fillStyle = "rgba(244,237,226,0.82)";
          rr(n.x - tw / 2 - 7, n.y - 9, tw + 14, 18, 4); ctx.fill();
          ctx.fillStyle = C.inkMute; ctx.fillText(n.name, n.x, n.y + 1);
          ctx.letterSpacing = "0px";
          continue;
        }
        const left = n.x - n.w / 2;
        rr(left, n.y - n.h / 2, n.w, n.h, 13);
        ctx.fillStyle = isHover ? "#fffaf0" : "rgba(239,230,216,0.94)"; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = isHover ? C.ink : C.edge; ctx.stroke();
        ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(left + 12 + n.dotR, n.y, n.dotR, 0, 7); ctx.fill();
        ctx.font = FONT_NODE_PX + "px " + SANS; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillStyle = isHover ? C.ink : C.inkSoft; ctx.fillText(n.name, left + 12 + n.dotR * 2 + 7, n.y + 1);
      }
    }
  }
  const redraw = () => { if (!running) draw(); };

  function frame() {
    frames++;
    const ke = step();
    draw();
    // settle when motion calms; hard backstop after ~12s so a residual limit-cycle
    // can't keep it spinning forever.
    if (!dragging && (frames > 720 || ke < 0.05)) { if (++idle > 24) { running = false; return; } } else idle = 0;
    rafId = requestAnimationFrame(frame);
  }
  function wake() {
    if (reduceMotion) { for (let i = 0; i < 30; i++) step(); draw(); return; }
    idle = 0; frames = Math.min(frames, 600);
    if (!running) { running = true; rafId = requestAnimationFrame(frame); }
  }
  function relayout() {           // re-seed + settle from scratch (mode change / resize)
    scatter();
    if (reduceMotion) { for (let i = 0; i < 900; i++) step(); draw(); return; }
    frames = 0; idle = 0; running = true; cancelAnimationFrame(rafId); rafId = requestAnimationFrame(frame);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return; // hidden tab: wait for show
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width; H = rect.height;
    // The world has a minimum size so a narrow phone screen still has room for the
    // clusters; the view then fits the whole world on-screen (zoom out) and the user
    // pans/pinches to explore. On a wide desktop the world == viewport (scale 1).
    sizeWorld();
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    layoutAnchors();
    if (!scattered) { scattered = true; homeView(); relayout(); }
    else { if (!userZoomed) homeView(); wake(); }
  }

  // --- zoom / pan ---
  let minZoom = 0.1;
  const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
  // The "home" view. Desktop/tablet: fit the whole world. Phone: start ~4 zoom-steps
  // in (a readable slice) and lock that as the zoom-OUT floor — the full overview is
  // uselessly tiny on a phone, so we never allow going below it.
  function homeView() {
    const fit = Math.min(W / worldW, H / worldH);
    // phone opens ~7 zoom-steps in (readable) and locks that as the zoom-out floor.
    const s = isPhone() ? fit * Math.pow(1.25, 7) : fit;
    minZoom = isPhone() ? s : Math.min(0.25, fit);
    view.scale = s; view.tx = (W - worldW * s) / 2; view.ty = (H - worldH * s) / 2;
    userZoomed = false;
  }
  function setZoomAround(ns, cx, cy) {
    const wx = (cx - view.tx) / view.scale, wy = (cy - view.ty) / view.scale;
    view.scale = ns; view.tx = cx - wx * ns; view.ty = cy - wy * ns;
    redraw();
  }
  function zoomBy(factor, cx, cy) { setZoomAround(Math.max(minZoom, Math.min(4, view.scale * factor)), cx, cy); userZoomed = true; }
  function resetView() { homeView(); redraw(); }

  // --- pointer: drag a pill / pan the background; a click without drag opens it ---
  const onSelect = typeof o.onSelect === "function" ? o.onSelect : (name) => { const e = findById(name); if (e) navigateTo(`#/${e.type}/${e.name}`); };
  const at = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const toWorld = (p) => ({ x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale });
  const pick = (w) => { for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]; if (n.kind === "node" && Math.abs(w.x - n.x) <= n.w / 2 + 4 && Math.abs(w.y - n.y) <= n.h / 2 + 4) return n; } return null; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function onDown(ev) {
    const sp = at(ev);
    pointers.set(ev.pointerId, sp);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported */ }
    if (pointers.size === 2) {                 // two fingers → pinch-zoom; cancel any drag/pan
      if (dragging) { dragging.fixed = false; dragging = null; }
      panning = false; downAt = null; canvas.style.cursor = "default";
      const p = [...pointers.values()];
      pinch = { d: dist(p[0], p[1]) || 1, s: view.scale };
      return;
    }
    const wp = toWorld(sp), n = pick(wp);
    downAt = { x: sp.x, y: sp.y, moved: 0 };
    if (n) { dragging = n; n.fixed = true; dragDX = n.x - wp.x; dragDY = n.y - wp.y; canvas.style.cursor = "grabbing"; wake(); }
    else { panning = true; panLast = sp; canvas.style.cursor = "grabbing"; }
  }
  function onMove(ev) {
    const sp = at(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, sp);
    if (pinch && pointers.size >= 2) {         // pinch: zoom around the fingers' midpoint
      const p = [...pointers.values()], c = mid(p[0], p[1]);
      setZoomAround(Math.max(minZoom, Math.min(4, pinch.s * (dist(p[0], p[1]) / pinch.d))), c.x, c.y);
      userZoomed = true; return;
    }
    if (dragging) { const wp = toWorld(sp); dragging.x = wp.x + dragDX; dragging.y = wp.y + dragDY; if (downAt) downAt.moved += Math.abs(sp.x - downAt.x) + Math.abs(sp.y - downAt.y); wake(); return; }
    if (panning) { view.tx += sp.x - panLast.x; view.ty += sp.y - panLast.y; panLast = sp; userZoomed = true; if (downAt) downAt.moved += 4; redraw(); return; }
    const n = pick(toWorld(sp));
    if (n !== hover) { hover = n; if (!running) draw(); }
    canvas.style.cursor = n ? "grab" : "default";
  }
  function onUp(ev) {
    pointers.delete(ev.pointerId);
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* unsupported */ }
    if (pointers.size < 2) pinch = null;
    if (dragging) {
      const n = dragging; dragging.fixed = false; dragging = null; canvas.style.cursor = "grab";
      if (downAt && downAt.moved < 6) onSelect(n.id); else wake();
    }
    panning = false; panLast = null; downAt = null;
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", () => { if (!dragging && !panning && hover) { hover = null; if (!running) draw(); } });
  canvas.addEventListener("wheel", (ev) => { ev.preventDefault(); const p = at(ev); zoomBy(ev.deltaY < 0 ? 1.12 : 0.89, p.x, p.y); }, { passive: false });

  // --- controls: A/B layout switch + zoom buttons ---
  const layoutBtns = mount.querySelectorAll("[data-layout]");
  const syncLayoutBtns = () => layoutBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.layout === mode)));
  syncLayoutBtns();
  layoutBtns.forEach(b => b.addEventListener("click", () => {
    const next = b.dataset.layout;
    if (!LAYOUTS[next] || next === mode) return;
    mode = next;
    try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* private mode */ }
    syncLayoutBtns();
    sizeWorld(); layoutAnchors(); homeView(); relayout();
  }));
  mount.querySelectorAll("[data-zoom]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.zoom;
    if (k === "in") zoomBy(1.25, W / 2, H / 2);
    else if (k === "out") zoomBy(0.8, W / 2, H / 2);
    else resetView();
  }));

  const ro = new ResizeObserver(resize); ro.observe(canvas);
  resize();

  mount._galaxyStop = () => { running = false; cancelAnimationFrame(rafId); ro.disconnect(); };
}
