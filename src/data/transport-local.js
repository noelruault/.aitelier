/* Local entity transport. Reads `prompts/`, `skills/`, `agents/`,
 * `hooks/` from the same origin the page is served from.
 *
 * Listing strategy (first hit wins):
 *   1. `_manifest.json` at the site root, emitted by
 *      scripts/build-manifest.ts. Required on GitHub Pages, which serves
 *      no directory autoindex; also what the Worker uses to seed R2.
 *   2. Directory autoindex HTML, the fallback for python's http.server
 *      and wrangler dev so local development needs no manifest build.
 *
 * `fetch(folder, slug)` resolves both flat (skills/foo.md) and folder
 * (skills/foo/SKILL.md) shapes by consulting the manifest first.
 * `fetchSidecar(folder, slug)` resolves the optional Aitelier sidecar
 * (`prompts/foo.aitelier.json` next to the .md; `skills/foo/aitelier.json`
 * inside the folder) and returns null when absent - both 404 and parse
 * failures degrade silently so a missing sidecar means "uncategorized",
 * never a hard error. `shapes()` returns the grouped tree.
 */

import { ENTITY_FOLDERS, emptyGrouping, fromFlatPaths } from "../lib/group-entities.js";

export const TransportLocal = (() => {
  let manifestPromise = null;
  let shapePromise = null;

  async function readManifest() {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        try {
          const res = await fetch("_manifest.json", { cache: "no-cache" });
          if (!res.ok) return null;
          const json = await res.json();
          if (!json || !Array.isArray(json.files)) return null;
          const sizes = (json.sizes && typeof json.sizes === "object") ? json.sizes : {};
          const grouped = fromFlatPaths(json.files, (path) => Number(sizes[path]) || 0);
          const byFolder = emptyGrouping();
          for (const folder of ENTITY_FOLDERS) {
            for (const ent of grouped[folder] || []) {
              byFolder[folder].push(ent.slug);
            }
          }
          return { ids: byFolder, grouped, files: new Set(json.files) };
        } catch {
          return null;
        }
      })();
    }
    return manifestPromise;
  }

  function mainPath(folder, slug, grouped) {
    if (grouped && grouped[folder]) {
      const ent = grouped[folder].find(e => e.slug === slug);
      if (ent) return ent.main;
    }
    return `${folder}/${slug}.md`;
  }

  /* Folder-shape entities (skills/<slug>/SKILL.md, hooks/<slug>/hook.json)
   * keep the sidecar inside the folder as `aitelier.json`. Flat entities
   * (prompts/<slug>.md, agents/<slug>.md) keep it adjacent as
   * `<slug>.aitelier.json`. */
  function sidecarPath(folder, slug, grouped) {
    const ent = grouped && grouped[folder] && grouped[folder].find(e => e.slug === slug);
    if (ent && ent.kind === "folder") return `${folder}/${slug}/aitelier.json`;
    return `${folder}/${slug}.aitelier.json`;
  }

  async function listFromAutoindex(folder) {
    let res;
    try { res = await fetch(`${folder}/`); }
    catch { return []; }
    if (!res.ok) return [];
    const html = await res.text();
    const slugs = new Set();
    for (const m of html.matchAll(/href="([^"?#]+\.md)"/gi)) {
      const file = decodeURIComponent(m[1].split("/").pop());
      if (file && file.endsWith(".md")) slugs.add(file.slice(0, -3));
    }
    return [...slugs];
  }

  async function ensureShapes() {
    if (!shapePromise) {
      shapePromise = (async () => {
        const manifest = await readManifest();
        if (manifest && manifest.grouped) return manifest.grouped;
        const out = emptyGrouping();
        for (const folder of ENTITY_FOLDERS) {
          const slugs = await listFromAutoindex(folder);
          out[folder] = slugs.map(slug => ({
            slug,
            kind: "file",
            main: `${folder}/${slug}.md`,
            attachments: []
          }));
        }
        return out;
      })();
    }
    return shapePromise;
  }

  return {
    async list(folder) {
      const manifest = await readManifest();
      if (manifest && manifest.ids && manifest.ids[folder]) return manifest.ids[folder];
      return listFromAutoindex(folder);
    },

    async fetch(folder, slug) {
      const manifest = await readManifest();
      const grouped = manifest && manifest.grouped;
      const path = mainPath(folder, slug, grouped);
      const url = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
      return await res.text();
    },

    async fetchSidecar(folder, slug) {
      const manifest = await readManifest();
      const grouped = manifest && manifest.grouped;
      const path = sidecarPath(folder, slug, grouped);
      // When we have a manifest, skip the fetch entirely if the path is
      // not listed - saves a 404 round-trip on every load.
      if (manifest && manifest.files && !manifest.files.has(path)) return null;
      const url = path.split("/").map(encodeURIComponent).join("/");
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) return null;
        const json = await res.json();
        return (json && typeof json === "object") ? json : null;
      } catch {
        return null;
      }
    },

    /* Phase 2: folder-shaped hooks ship prose in README.md. Returns the
     * raw markdown string when present, null otherwise. Only meaningful
     * for hooks at the moment - other folders pass through null. */
    async fetchProse(folder, slug) {
      if (folder !== "hooks") return null;
      const manifest = await readManifest();
      const grouped = manifest && manifest.grouped;
      const ent = grouped && grouped[folder] && grouped[folder].find(e => e.slug === slug);
      if (!ent || ent.kind !== "folder") return null;
      const path = `${folder}/${slug}/README.md`;
      if (manifest && manifest.files && !manifest.files.has(path)) return null;
      const url = path.split("/").map(encodeURIComponent).join("/");
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },

    async shapes() {
      return await ensureShapes();
    }
  };
})();
