import { KEYMAPS } from "../data/keymaps.data.js";
import { BUILTINS } from "../data/load-entities.js";
import { ENTITY_FOLDERS } from "./group-entities.js";

/* localStorage facade for aitelier. Seven namespaced keys. */

export const STORAGE = {
  prompts:  "aitelier-prompts-v1",   // user-added or user-edited prompts (map by id)
  skills:   "aitelier-skills-v1",    // user-added or user-edited skills (map by id)
  agents:   "aitelier-agents-v1",    // user-added or user-edited agents (map by id)
  hooks:    "aitelier-hooks-v1",     // user-added or user-edited hooks (map by id)
  keymap:   "aitelier-keymap-v1",    // string, active keymap id
  requests: "aitelier-requests-v1",  // array of edit-request drafts
  recently: "aitelier-recently-v1"   // array of { type, id, at } ordered newest first
};

export function loadMap(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}
export function saveMap(key, map) {
  localStorage.setItem(key, JSON.stringify(map));
}
export function loadArr(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}
export function saveArr(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
}
export function loadStr(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
export function saveStr(key, value) {
  try { localStorage.setItem(key, value); } catch { /* quota or private mode */ }
}

/* Parameterised user-entry helpers. The four loadUserX/saveUserX below
 * are facades for by-name imports; new code should use loadUser(type). */
export function loadUser(type) { return loadMap(STORAGE[type]); }
export function saveUser(type, m) { saveMap(STORAGE[type], m); }

export function loadUserPrompts() { return loadUser("prompts"); }
export function saveUserPrompts(m) { saveUser("prompts", m); }
export function loadUserSkills() { return loadUser("skills"); }
export function saveUserSkills(m) { saveUser("skills", m); }
export function loadUserAgents() { return loadUser("agents"); }
export function saveUserAgents(m) { saveUser("agents", m); }
export function loadUserHooks() { return loadUser("hooks"); }
export function saveUserHooks(m) { saveUser("hooks", m); }

export function loadKeymapPref() {
  const v = loadStr(STORAGE.keymap, "normal");
  return (typeof KEYMAPS === "object" && KEYMAPS[v]) ? v : "normal";
}
export function saveKeymapPref(name) { saveStr(STORAGE.keymap, name); }

export function loadEditRequests() { return loadArr(STORAGE.requests); }
export function saveEditRequests(arr) { saveArr(STORAGE.requests, arr); }

export function loadRecently() { return loadArr(STORAGE.recently); }
export function pushRecently(type, id) {
  const arr = loadRecently().filter(r => !(r.type === type && r.id === id));
  arr.unshift({ type, id, at: new Date().toISOString() });
  saveArr(STORAGE.recently, arr.slice(0, 12));
}

/* Merged entity lookup. Built-in arrays come from data files (BUILTINS).
 * User edits overlay builtins; user-added entries append. Returns array
 * of { ...entity, type, source } where source = "builtin" |
 * "edited-builtin" | "fork" | "local".
 *
 * Legacy localStorage entries from pre-Phase-1 carry id/title/summary
 * instead of name/description. `normaliseUserEntry` upgrades them on
 * read so the renderers see the new shape without forcing a one-time
 * migration write. Drop the upgrade once user storage has been bumped
 * to a v2 schema. */
function normaliseUserEntry(u) {
  const out = { ...u };
  if (!out.name) out.name = u.id || u.name || "";
  if (!out.id) out.id = out.name;
  if (!out.description) out.description = u.summary || u.description || "";
  return out;
}

export function allOfType(type) {
  const seed = BUILTINS[type];
  if (!seed) return [];
  const user = loadUser(type);
  const seedNames = new Set(seed.map(e => e.name));
  const merged = seed.map(e => {
    const u = user[e.name] || user[e.id];
    return u
      ? { ...normaliseUserEntry(u), type, source: "edited-builtin" }
      : { ...e, type, source: "builtin" };
  });
  const extras = Object.values(user)
    .map(normaliseUserEntry)
    .filter(u => !seedNames.has(u.name))
    .map(u => ({ ...u, type, source: u.forkOf ? "fork" : "local" }));
  return merged.concat(extras);
}

export function allEntities() {
  return ENTITY_FOLDERS.flatMap(allOfType);
}

export function findEntity(type, id) {
  return allOfType(type).find(e => e.id === id || e.name === id) || null;
}
export function findById(id) {
  return allEntities().find(e => e.id === id || e.name === id) || null;
}
