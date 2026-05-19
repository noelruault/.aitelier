/* Consumer for the Worker's grouped /api/library/list payload (Path B)
 * and a derivation of the same shape from a flat file list (Path A,
 * `_manifest.json` or fork snapshots). One representation lets the deep
 * dive and any future tooling treat folder-shaped and flat entities the
 * same way.
 *
 * Both inputs collapse to:
 *
 *   {
 *     prompts: GroupedEntity[],
 *     skills:  GroupedEntity[],
 *     agents:  GroupedEntity[],
 *     hooks:   GroupedEntity[]
 *   }
 *
 *   GroupedEntity = {
 *     slug,                  // filename without .md / folder name
 *     kind: "file"|"folder", // shape on disk
 *     main,                  // path to the markdown body
 *     attachments: [{ path, size }],
 *     collision?: boolean    // both shapes present for the same slug
 *   }
 *
 * Prompts ignore the folder shape per plan §2: any prompts/<slug>/...
 * entry is dropped (with a console warning when running in a browser
 * context) so the dashboard never tries to render a folder prompt.
 */

export const ENTITY_FOLDERS = ["prompts", "skills", "agents", "hooks"];

export function mainFileFor(folder) {
  switch (folder) {
    case "skills": return "SKILL.md";
    case "agents": return "AGENT.md";
    case "hooks":  return "hook.json";  // Phase 2: hooks are folder-shaped, hook.json is the verbatim settings.json snippet
    default:       return "";
  }
}

export function emptyGrouping() {
  const out = {};
  for (const f of ENTITY_FOLDERS) out[f] = [];
  return out;
}

/* Normalise the Worker's grouped tree. The Worker already enforces the
 * detection rule + collision flag; this exists so the SPA does not depend
 * on the exact field set surviving across versions. */
export function fromWorkerGrouped(raw) {
  const out = emptyGrouping();
  if (!raw || typeof raw !== "object") return out;
  for (const folder of ENTITY_FOLDERS) {
    const arr = Array.isArray(raw[folder]) ? raw[folder] : [];
    out[folder] = arr.map(e => ({
      slug: String(e.slug || ""),
      kind: e.kind === "folder" ? "folder" : "file",
      main: String(e.main || ""),
      attachments: Array.isArray(e.attachments) ? e.attachments
        .filter(a => a && typeof a.path === "string")
        .map(a => ({ path: a.path, size: Number(a.size || 0) })) : [],
      collision: !!e.collision
    })).filter(e => e.slug && e.main);
  }
  return out;
}

/* Derive the same shape from a flat list of file paths (e.g.
 * _manifest.json or fork snapshot keys). `sizeOf` is optional and is
 * consulted to populate attachment sizes; missing sizes default to 0. */
export function fromFlatPaths(paths, sizeOf = () => 0) {
  const out = emptyGrouping();
  if (!Array.isArray(paths)) return out;

  const buckets = new Map();
  for (const folder of ENTITY_FOLDERS) buckets.set(folder, []);
  for (const path of paths) {
    if (typeof path !== "string" || !path) continue;
    const slash = path.indexOf("/");
    if (slash < 0) continue;
    const folder = path.slice(0, slash);
    if (!buckets.has(folder)) continue;
    buckets.get(folder).push(path);
  }

  for (const folder of ENTITY_FOLDERS) {
    out[folder] = groupOne(folder, buckets.get(folder) || [], sizeOf);
  }
  return out;
}

function groupOne(folder, paths, sizeOf) {
  const main = mainFileFor(folder);
  const files = new Map();
  const folders = new Map();

  for (const path of paths) {
    const tail = path.slice(folder.length + 1);
    const slash = tail.indexOf("/");
    if (slash < 0) {
      if (!tail.endsWith(".md")) continue;
      const slug = tail.slice(0, -3);
      if (!slug) continue;
      files.set(slug, { slug, kind: "file", main: path, attachments: [] });
      continue;
    }
    if (folder === "prompts") continue;
    const slug = tail.slice(0, slash);
    if (!slug) continue;
    const rest = tail.slice(slash + 1);
    const mainKey = `${folder}/${slug}/${main}`;
    const ent = folders.get(slug) || { slug, kind: "folder", main: mainKey, attachments: [] };
    if (rest === main) {
      ent.main = mainKey;
    } else {
      ent.attachments.push({ path, size: sizeOf(path) });
    }
    folders.set(slug, ent);
  }

  // Folder entries without a main file are ignored (plan §2: "warning in
  // console, not an error"). The console hop only matters in browsers.
  for (const [slug, ent] of folders) {
    const sawMain = paths.includes(ent.main);
    if (!sawMain) {
      folders.delete(slug);
      if (typeof console !== "undefined" && console.warn) {
        console.warn(`group-entities: ${folder}/${slug}/ has no ${main}, skipping`);
      }
    }
  }

  const merged = [];
  const seen = new Set();
  for (const [slug, ent] of files) {
    if (folders.has(slug)) merged.push({ ...ent, collision: true });
    else merged.push(ent);
    seen.add(slug);
  }
  for (const [slug, ent] of folders) {
    if (seen.has(slug)) merged.push({ ...ent, collision: true });
    else {
      ent.attachments.sort((a, b) => a.path.localeCompare(b.path));
      merged.push(ent);
    }
  }
  merged.sort((a, b) => a.slug.localeCompare(b.slug));
  return merged;
}

/* Pull the GroupedEntity for a given (folder, slug). Returns null when
 * absent or when the entity is flagged as a collision (callers should
 * surface a collision card separately). */
export function findEntityShape(grouped, folder, slug) {
  const list = grouped && grouped[folder];
  if (!Array.isArray(list)) return null;
  return list.find(e => e.slug === slug) || null;
}
