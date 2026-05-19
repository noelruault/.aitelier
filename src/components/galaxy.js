import { allEntities, findById } from "../lib/storage.js";
import { escapeHtml, humanizeName } from "../lib/util.js";
import { RELATED } from "../data/load-entities.js";
import { navigateTo } from "../router.js";

/* Galaxy view. Draws the same entities the dashboard rails draw, laid out
 * as clusters by category with edges from RELATED. Click a node = open its
 * deep-dive.
 *
 *   renderGalaxy(mountEl)
 *
 * Layout: clusters are placed on a fixed circle around the canvas center,
 * one per unique category. Inside each cluster the nodes sit on a small
 * ring at fixed slots, sorted by name so positions are stable across
 * reloads. Edges are drawn first, under the nodes. Labels sit just below
 * each node and are truncated to fit the per-node arc length so dense
 * clusters don't bleed into each other. */

export const GALAXY_W = 1200;
export const GALAXY_H = 720;
export const GALAXY_CX = GALAXY_W / 2;
export const GALAXY_CY = GALAXY_H / 2;
export const CLUSTER_RING = 250;
export const NODE_RING = 58;
// Upper bound on the inner ring so a packed cluster can't shove into an
// adjacent cluster. With CLUSTER_RING=250 and N up to ~6 clusters, the
// nearest-neighbour cluster centres sit ~250 px apart at their tightest,
// so 130 keeps a healthy gap.
export const NODE_RING_MAX = 130;
// Visible label cap. Names of 20 chars or fewer render in full; longer
// names get sliced to 20 then suffixed with "...". Tooltip keeps the full
// name. Calibrated with the user's preference for "no premature ellipsis".
export const LABEL_MAX_CHARS = 20;

export function renderGalaxy(mount, opts) {
  if (!mount) return;
  const o = opts || {};
  const entities = o.entities || allEntities();
  const related = o.related || RELATED;
  if (!entities.length) {
    mount.innerHTML = `<div class="galaxy-empty py-12 px-4 text-center font-display italic text-ink-mute">No entities loaded. Add a markdown to <code>prompts/</code>, <code>skills/</code>, or <code>agents/</code>.</div>`;
    return;
  }

  const byCat = groupByCategory(entities);
  const cats = [...byCat.keys()].sort();
  const positions = layoutPositions(byCat, cats);
  const edges = buildEdges(entities, positions, related);

  mount.innerHTML = `
    <div class="galaxy-wrap bg-paper border border-rule rounded-md px-3 pt-3 pb-4">
      <svg class="galaxy-svg w-full h-auto block font-sans" viewBox="0 0 ${GALAXY_W} ${GALAXY_H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Entity galaxy">
        <g class="galaxy-edges">${edges.map(e => edgeMarkup(e, positions)).join("")}</g>
        <g class="galaxy-clusters">${cats.map(c => clusterLabelMarkup(c, byCat.get(c), positions)).join("")}</g>
        <g class="galaxy-nodes">${entities.map(e => nodeMarkup(e, positions.get(e.name))).join("")}</g>
      </svg>
      <div class="galaxy-legend flex flex-wrap gap-x-4 gap-y-2.5 mt-2.5 pt-3 border-t border-dashed border-rule font-mono text-[10.5px] tracking-[.14em] uppercase text-ink-mute">${cats.map(c => legendChip(c, byCat.get(c).length)).join("")}</div>
    </div>
  `;

  const onSelect = typeof o.onSelect === "function" ? o.onSelect : (name) => {
    const e = findById(name);
    if (e) navigateTo(`#/${e.type}/${e.name}`);
  };
  mount.querySelectorAll("[data-galaxy-id]").forEach(el => {
    el.addEventListener("click", () => onSelect(el.dataset.galaxyId));
  });
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

export function nodeRingRadius(n) {
  if (n <= 1) return 0;
  if (n === 2) return NODE_RING;
  // Labels alternate above/below the ring (see nodeMarkup), so same-side
  // labels sit 2 slots apart. Need 2*r*sin(2π/n) >= ~135px (20-char label
  // width + margin) → r >= 67/sin(2π/n). Capped to keep clusters apart.
  const needed = Math.ceil(67 / Math.sin((2 * Math.PI) / n));
  return Math.max(NODE_RING, Math.min(NODE_RING_MAX, needed));
}

export function truncateLabel(s) {
  if (s.length <= LABEL_MAX_CHARS) return s;
  return s.slice(0, LABEL_MAX_CHARS) + "...";
}

export function layoutPositions(byCat, cats) {
  const out = new Map();
  const N = cats.length;
  cats.forEach((cat, i) => {
    const t = N <= 1 ? 0 : (i / N) * Math.PI * 2 - Math.PI / 2;
    const cx = GALAXY_CX + (N <= 1 ? 0 : Math.cos(t) * CLUSTER_RING);
    const cy = GALAXY_CY + (N <= 1 ? 0 : Math.sin(t) * CLUSTER_RING);
    const members = byCat.get(cat);
    const n = members.length;
    const r = nodeRingRadius(n);
    members.forEach((e, k) => {
      const a = n <= 1 ? -Math.PI / 2 : (k / n) * Math.PI * 2 - Math.PI / 2;
      out.set(e.name, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, cx, cy, cat, angle: a, ringR: r, n, slot: k });
    });
  });
  return out;
}

export function buildEdges(entities, positions, related) {
  const src = related || RELATED;
  const idSet = new Set(entities.map(e => e.name));
  const seen = new Set();
  const out = [];
  for (const [from, rels] of Object.entries(src || {})) {
    if (!positions.has(from)) continue;
    for (const to of rels) {
      if (!idSet.has(to) || !positions.has(to) || from === to) continue;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to });
    }
  }
  return out;
}

export function clusterLabelMarkup(cat, members, positions) {
  if (!members.length) return "";
  const first = positions.get(members[0].name);
  if (!first) return "";
  const nodeR = nodeRadiusForType(members[0].type);
  const ring = first.ringR || 0;
  const offset = members.length <= 1 ? nodeR + 26 : ring + nodeR + 26;
  const y = Math.max(24, first.cy - offset);
  return `<text class="galaxy-cluster-label" x="${first.cx.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${escapeHtml(cat)}</text>`;
}

export function nodeRadiusForType(t) {
  if (t === "prompts") return 11;
  if (t === "skills") return 9;
  if (t === "agents") return 8;
  if (t === "hooks") return 7;
  return 8;
}

export function nodeMarkup(e, pos) {
  if (!pos) return "";
  const cls = `galaxy-node galaxy-node-${e.type}`;
  const cat = e.category || "uncategorized";
  const fill = `var(--cat-${escapeAttr(cat)}, var(--cat-default))`;
  const r = nodeRadiusForType(e.type);
  const full = humanizeName(e.name);
  const label = escapeHtml(truncateLabel(full));
  const tooltip = escapeHtml(full);
  // Stagger labels above/below the ring so same-side labels sit 2 slots
  // apart, doubling the available arc. k=0 (top of ring) always stays below
  // so it never collides with the cluster label sitting just above.
  const n = pos.n || 1;
  const slot = pos.slot ?? 0;
  const above = n > 2 && slot % 2 === 1;
  const ly = above ? -(r + 4) : (r + 14);
  return `
    <g class="${cls}" data-galaxy-id="${escapeAttr(e.name)}" transform="translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})">
      <title>${tooltip}, ${escapeHtml(cat)}</title>
      <circle class="galaxy-node-halo" r="${r + 6}"></circle>
      <circle class="galaxy-node-dot" r="${r}" fill="${fill}"></circle>
      <text class="galaxy-node-label" y="${ly.toFixed(0)}" text-anchor="middle">${label}</text>
    </g>
  `;
}

export function edgeMarkup({ from, to }, positions) {
  const a = positions.get(from);
  const b = positions.get(to);
  if (!a || !b) return "";
  return `<line class="galaxy-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"></line>`;
}

export function legendChip(cat, count) {
  const fill = `var(--cat-${escapeAttr(cat)}, var(--cat-default))`;
  return `<span class="galaxy-legend-chip inline-flex items-center gap-1.5"><span class="dot inline-block w-[9px] h-[9px] rounded-full" style="background:${fill}"></span>${escapeHtml(cat)}<span class="galaxy-legend-count ml-1 text-ink-faint">${count}</span></span>`;
}

export function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
