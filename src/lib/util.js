/* Tiny utility belt. No deps. */

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";
}

/* kebab-case name → Title Case display string.
 * "code-reviewer" → "Code Reviewer", "go-hot-pot-jo" → "Go Hot Pot Jo".
 * Pure; used by card titles, manpage doc-head, galaxy node labels. */
export function humanizeName(name) {
  return String(name || "").split("-").filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function cssEscape(s) {
  return String(s).replace(/(["\\\]\[#.:>+~*^$|()=!])/g, "\\$1");
}

export function badgeLabel(src) {
  if (src === "builtin") return "CORE";
  if (src === "edited-builtin") return "EDITED";
  if (src === "fork") return "FORK";
  return "LOCAL";
}
export function badgeClass(src) {
  if (src === "builtin") return "core";
  if (src === "edited-builtin") return "fork";
  if (src === "fork") return "fork";
  return "local";
}

export function prettyKey(token) {
  return token
    .replace(/\bmod\b/gi, navigator.platform.includes("Mac") ? "⌘" : "Ctrl")
    .replace(/\bctrl\b/gi, "Ctrl")
    .replace(/\balt\b/gi, navigator.platform.includes("Mac") ? "⌥" : "Alt")
    .replace(/\bshift\b/gi, "⇧")
    .replace(/\bEnter\b/g, "⏎")
    .replace(/\bBackspace\b/g, "⌫")
    .replace(/\bDelete\b/g, "Del")
    .replace(/\bArrowUp\b/g, "↑")
    .replace(/\bArrowDown\b/g, "↓")
    .replace(/\bArrowLeft\b/g, "←")
    .replace(/\bArrowRight\b/g, "→")
    .replace(/\bEscape\b/g, "Esc");
}

export function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    toast("Copied");
  } catch {
    toast("Copy failed", true);
  }
  ta.remove();
}

export function copyText(text, label) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast(`Copied: ${label || "text"}`),
      () => fallbackCopy(text)
    );
  } else {
    fallbackCopy(text);
  }
}

export let toastTimer;
export function toast(msg, isError) {
  const el = document.getElementById("toast");
  if (!el) return;
  document.getElementById("toastMsg").textContent = msg;
  el.style.background = isError ? "#7a1c1c" : "var(--ink)";
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

export function isMultiStep(p) {
  return !!(p && Array.isArray(p.steps) && p.steps.length > 0);
}
export function effectiveBody(p) {
  if (!p) return "";
  if (isMultiStep(p)) {
    return p.steps.map((s, i) =>
      `## ${s.label || "Step " + (i + 1)}\n\n${s.body}`
    ).join("\n\n---\n\n");
  }
  return p.body || "";
}
export function stepBody(p, idx) {
  if (!isMultiStep(p)) return p.body || "";
  const s = p.steps[idx];
  return s ? s.body : "";
}
