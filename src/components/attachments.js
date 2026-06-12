import { escapeHtml, copyText, toast } from "../lib/util.js";
import { BTN } from "../lib/ui-classes.js";
import { ENTITY_SHAPES } from "../data/load-entities.js";
import { findEntityShape } from "../lib/group-entities.js";

/* Attachments section for folder-shaped entities (skills/agents/hooks).
 * Renders a flat list of files; clicking an entry lazy-fetches the body
 * over plain HTTP and expands an inline <pre>. A Copy button copies the
 * loaded body. Sections render nothing for flat (file-shape) entities or
 * when the active transport did not surface shape information.
 *
 *   renderAttachments(parentEl, entity)
 *
 * Renders into `parentEl` and returns the appended <section> (or null).
 */

export function renderAttachments(parentEl, entity) {
  if (!entity || entity.type === "prompts") return null;
  const shape = findEntityShape(ENTITY_SHAPES, entity.type, entity.id);
  if (!shape || shape.kind !== "folder" || !shape.attachments.length) return null;

  const section = document.createElement("section");
  section.id = "section-attachments";
  section.className = "mt-11 scroll-mt-6";
  section.innerHTML = `
    <h3 class="section-h font-sans text-[12px] tracking-[.32em] uppercase text-ink font-bold m-0 mb-3.5 relative pb-2.5">Attachments</h3>
    <p class="text-ink-mute font-mono text-[11px] tracking-[.08em] m-0 mb-4">${shape.attachments.length} file${shape.attachments.length === 1 ? "" : "s"} under <code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px text-accent">${escapeHtml(`${entity.type}/${entity.id}/`)}</code></p>
    <ul class="attachments-list list-none p-0 m-0 flex flex-col gap-2" data-attachments-list></ul>
  `;
  const list = section.querySelector("[data-attachments-list]");
  for (const att of shape.attachments) {
    list.appendChild(renderAttachmentRow(att));
  }
  parentEl.appendChild(section);
  return section;
}

export function renderAttachmentRow(att) {
  const li = document.createElement("li");
  li.className = "border border-rule rounded-sm bg-paper-deep overflow-hidden";
  const fileName = att.path.split("/").pop();
  const size = formatBytes(att.size || 0);
  li.innerHTML = `
    <div class="att-head flex items-center gap-3 px-3.5 py-2.5 flex-wrap">
      <code class="att-name font-mono text-[12px] text-ink min-w-0 break-all">${escapeHtml(att.path)}</code>
      <span class="att-size font-mono text-[10.5px] tracking-[.08em] text-ink-mute ml-auto whitespace-nowrap">${escapeHtml(size)}</span>
      <button class="${BTN} att-toggle" type="button" data-toggle="closed" aria-expanded="false">Show</button>
      <button class="${BTN} att-copy" type="button">Copy</button>
    </div>
    <div class="att-body hidden border-t border-rule bg-paper" data-body></div>
  `;
  const body = li.querySelector("[data-body]");
  const toggle = li.querySelector(".att-toggle");
  const copy = li.querySelector(".att-copy");
  let loaded = null;

  async function load() {
    if (loaded !== null) return loaded;
    body.innerHTML = `<div class="px-3.5 py-3 text-ink-mute font-mono text-[11px]">Loading...</div>`;
    try {
      const res = await fetch(att.path);
      if (!res.ok) throw new Error(`${res.status}`);
      loaded = await res.text();
      body.innerHTML = `<pre class="m-0 px-3.5 py-3 font-mono text-[12px] leading-[1.55] text-ink whitespace-pre-wrap break-words overflow-x-auto">${escapeHtml(loaded)}</pre>`;
    } catch (err) {
      loaded = "";
      body.innerHTML = `<div class="px-3.5 py-3 text-accent font-mono text-[11px]">Fetch failed: ${escapeHtml(String(err && err.message || err))}</div>`;
    }
    return loaded;
  }

  toggle.addEventListener("click", async () => {
    const open = toggle.dataset.toggle === "open";
    if (open) {
      body.classList.add("hidden");
      toggle.dataset.toggle = "closed";
      toggle.textContent = "Show";
      toggle.setAttribute("aria-expanded", "false");
      return;
    }
    await load();
    body.classList.remove("hidden");
    toggle.dataset.toggle = "open";
    toggle.textContent = "Hide";
    toggle.setAttribute("aria-expanded", "true");
  });

  copy.addEventListener("click", async () => {
    const text = await load();
    if (text) copyText(text, fileName);
    else toast("Nothing to copy", true);
  });

  return li;
}

export function formatBytes(n) {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
