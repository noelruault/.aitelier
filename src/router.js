import { onRouteChange } from "./app.js";
import { ENTITY_FOLDERS } from "./lib/group-entities.js";

/* Hash router. Parses location.hash into { route, id }.
 *
 *   (empty)             -> { route: "dashboard", id: null }
 *   #/                  -> { route: "dashboard", id: null }
 *   #/prompts           -> { route: "prompts", id: null }
 *   #/prompts/<id>      -> { route: "prompts", id: "<id>" }
 *   #/skills, #/agents  -> same shape
 *   anything else       -> { route: "dashboard", id: null } (fallback)
 */

export function parseHashRoute() {
  const raw = location.hash.replace(/^#\/?/, "").trim();
  if (!raw) return { route: "dashboard", id: null };
  const parts = raw.split("/").filter(Boolean);
  const head = parts[0];
  if (ENTITY_FOLDERS.includes(head)) {
    return { route: head, id: parts[1] || null };
  }
  if (head === "dashboard") return { route: "dashboard", id: null };
  return { route: "dashboard", id: null };
}

export function navigateTo(target) {
  // accepts "#/..." or "/..." or "..."
  const t = target.startsWith("#") ? target : ("#/" + target.replace(/^\/+/, ""));
  if (location.hash === t) onRouteChange();
  else location.hash = t;
}
