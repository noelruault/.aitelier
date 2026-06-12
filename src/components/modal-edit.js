import { BTN, BTN_PRIMARY } from "../lib/ui-classes.js";
import { bindBackdropClose } from "../lib/modal-helpers.js";
import { slugify, toast, humanizeName } from "../lib/util.js";
import { findEntity, loadUser, saveUser } from "../lib/storage.js";
import { CATEGORIES } from "../data/categories.data.js";
import { ENTITY_FOLDERS } from "../lib/group-entities.js";
import { navigateTo } from "../router.js";
import { state, rerender } from "../app.js";

/* ============================================================
 * Edit / Fork / New modal - table-driven on ENTITY_FOLDERS.
 *
 * One TYPE_REGISTRY entry per folder declares everything the
 * modal needs to know about that entity type:
 *
 *   - label              human label for the type select
 *   - bodyLabel/Hint     per-type Body field label + hint copy
 *   - defaultBody        starter Body text on "new"
 *   - extras[]           which extra <div id="…Field"> blocks to reveal
 *   - defaults(F)        re-seed extras to type defaults
 *   - prefill(F, src)    seed extras from a forked/edited entity
 *   - validate(F)        per-type extra validation, returns "" or error msg
 *   - applyExtras(entry,F,name)  attach type-specific fields to the entry
 *
 * Adding a fifth type = one new TYPE_REGISTRY row + corresponding
 * `<div id="x…Field">` block in the modal HTML. Nothing else.
 * ============================================================ */

export let editModalState = { mode: null, id: null, sourceId: null, type: "prompts" };

/* ---------- shared style strings ---------- */
const STYLE = {
  FIELD: "field mb-3.5",
  FIELD_LABEL_REQ: "block font-mono text-[10.5px] tracking-[.18em] uppercase text-ink font-semibold mb-1.5",
  FIELD_LABEL_OPT: "block font-mono text-[10.5px] tracking-[.18em] uppercase text-ink-mute mb-1.5",
  FIELD_INPUT:      "w-full bg-paper border border-rule rounded-sm px-3 py-2 text-ink text-sm focus:outline-none focus:border-ink",
  FIELD_INPUT_REQ:  "w-full bg-paper border border-rule rounded-sm px-3 py-2 text-ink text-sm focus:outline-none focus:border-ink aria-invalid:border-accent aria-invalid:bg-clay-soft",
  FIELD_TEXTAREA_REQ: "w-full bg-paper border border-rule rounded-sm px-3 py-2 text-ink font-mono text-[12.75px] leading-[1.6] min-h-[240px] resize-y focus:outline-none focus:border-ink aria-invalid:border-accent aria-invalid:bg-clay-soft",
  MODAL: "modal bg-paper border border-rule rounded w-full max-w-[720px] max-h-[90vh] overflow-y-auto shadow-3 p-7 max-md:px-[18px] max-md:py-5",
  MODAL_H3: "font-display italic text-[28px] m-0 mb-1",
  MODAL_SUB: "modal-sub text-ink-mute text-[13px] mb-[18px]",
  MODAL_LEGEND: "flex items-center gap-3 mb-4 font-mono text-[10.5px] tracking-[.12em] uppercase text-ink-mute",
  MODAL_ACTIONS: "modal-actions flex gap-2 justify-end mt-5 pt-4 border-t border-dashed border-rule flex-wrap",
  REQ_STAR: `<span class="text-accent ml-1" aria-hidden="true">*</span><span class="sr-only"> (required)</span>`,
  OPT_CHIP: `<span class="ml-2 inline-block font-mono text-[9px] tracking-[.16em] uppercase text-ink-mute bg-paper-deep border border-rule rounded-sm px-1.5 py-px font-normal">optional</span>`,
  HINT: "ml-2 font-normal lowercase text-ink-mute tracking-normal"
};

/* ---------- field-block renderers (pure) ---------- */
function fieldHint(text) {
  return text ? `<span class="${STYLE.HINT}">${text}</span>` : "";
}
function field({ id, label, hint = "", inputHtml, required, hidden = false, blockId }) {
  const wrapId = blockId || `${id}Field`;
  const labelCls = required ? STYLE.FIELD_LABEL_REQ : STYLE.FIELD_LABEL_OPT;
  const badge = required ? STYLE.REQ_STAR : STYLE.OPT_CHIP;
  return `<div class="${STYLE.FIELD}${hidden ? " hidden" : ""}" id="${wrapId}">
    <label class="${labelCls}" for="${id}">${label}${badge}${fieldHint(hint)}</label>
    ${inputHtml}
  </div>`;
}

/* ---------- per-type body defaults ---------- */
const BODY_DEFAULTS = {
  prompts: `ROLE: You are <role>.

Before you start, interview me. Ask ONE focused question at a time. You need:
1. ...
2. ...

When you have all answers, restate the brief in 3 lines so I can confirm.

Then execute:
- ...
- ...

Halt at: <stopping point>. Wait for my approval before <next step>.

Conventions:
- All artifacts under ./<scope>/.
- Never push commits or modify production data without explicit approval.`,
  skills: `## When to invoke\n\n- Trigger 1\n- Trigger 2\n\n## What it does\n\nDescription of the skill.`,
  agents: `## When to spawn\n\nDescribe when to delegate to this agent.\n\n## Constraints\n\nList tool restrictions and behavior boundaries.`,
  hooks:  `What the hook does, why you'd reach for it, and any tuning notes.\n\n## Why\n\n- ...\n\n## Tuning\n\n- ...`
};

const HOOK_SNIPPET_DEFAULT = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "echo hello" }
        ]
      }
    ]
  }
}`;

/* ---------- TYPE_REGISTRY: the single source of per-type knowledge ---------- */
export const TYPE_REGISTRY = {
  prompts: {
    label: "prompt",
    bodyLabel: "Body", bodyHint: "prompt body",
    defaultBody: BODY_DEFAULTS.prompts,
    extras: [],
    defaults(_F) {},
    prefill(_F, _src) {},
    validate(_F) { return ""; },
    applyExtras(_entry, _F, _name) {}
  },
  skills: {
    label: "skill",
    bodyLabel: "Body", bodyHint: "SKILL.md body",
    defaultBody: BODY_DEFAULTS.skills,
    extras: ["fSlashField"],
    defaults(F) { F.fSlash.value = ""; },
    prefill(F, src) { F.fSlash.value = (src && src.slash) || ""; },
    validate(_F) { return ""; },
    applyExtras(entry, F, name) { entry.slash = F.fSlash.value.trim() || `/${name}`; }
  },
  agents: {
    label: "agent",
    bodyLabel: "Body", bodyHint: "system prompt",
    defaultBody: BODY_DEFAULTS.agents,
    extras: ["fModelToolsField"],
    defaults(F) { F.fModel.value = "inherit"; F.fTools.value = "*"; },
    prefill(F, src) {
      F.fModel.value = (src && src.model) || "inherit";
      F.fTools.value = (src && src.tools) || "*";
    },
    validate(_F) { return ""; },
    applyExtras(entry, F) {
      entry.model = F.fModel.value.trim() || "inherit";
      entry.tools = F.fTools.value.trim() || "*";
    }
  },
  hooks: {
    label: "hook",
    bodyLabel: "README", bodyHint: "prose: why + tuning",
    defaultBody: BODY_DEFAULTS.hooks,
    extras: ["fSnippetField", "fInstallField"],
    defaults(F) {
      F.fSnippet.value = HOOK_SNIPPET_DEFAULT;
      F.fInstallScope.value = "user";
    },
    prefill(F, src) {
      F.fSnippet.value = (src && src.snippetRaw) || HOOK_SNIPPET_DEFAULT;
      F.fInstallScope.value = (src && src.installScope) || "user";
    },
    // Per-type required field: hook.json must be present + parse.
    required: [{ id: "fSnippet", label: "hook.json" }],
    validate(F) {
      try { JSON.parse(F.fSnippet.value); return ""; }
      catch (e) { return `hook.json: ${e.message}`; }
    },
    applyExtras(entry, F) {
      entry.snippetRaw = F.fSnippet.value.trim();
      entry.installScope = F.fInstallScope.value || "user";
    }
  }
};

// Sanity check: registry must cover ENTITY_FOLDERS exactly.
for (const f of ENTITY_FOLDERS) {
  if (!TYPE_REGISTRY[f]) throw new Error(`modal-edit: TYPE_REGISTRY missing folder "${f}"`);
}

/* ---------- common-required fields, declared once ---------- */
const COMMON_REQUIRED = [
  { id: "fName",        label: "name" },
  { id: "fDescription", label: "description" }
];
// Body's missing-label is type-dependent (README for hooks, body otherwise).
function bodyMissingLabel(type) { return type === "hooks" ? "README" : "body"; }

/* ---------- form-field accessor (cached after first call) ---------- */
const FIELD_IDS = [
  "fType","fName","fDescription","fBody",
  "fCategory","fTags","fSlash","fModel","fTools","fSnippet","fInstallScope"
];
const TYPE_FIELD_BLOCKS = ["fSlashField","fModelToolsField","fSnippetField","fInstallField"];
let _fieldCache = null;
function formFields() {
  if (_fieldCache) return _fieldCache;
  const f = {};
  for (const id of FIELD_IDS) f[id] = document.getElementById(id);
  _fieldCache = f;
  return f;
}

/* ---------- modal HTML ---------- */
function modalHtml() {
  const typeOptions = ENTITY_FOLDERS.map(f => `<option value="${f}">${TYPE_REGISTRY[f].label}</option>`).join("");
  // Body field is special: its label + hint text swap by type at runtime, so
  // it carries a `<span id="fBodyLabel">` instead of static label text.
  const bodyBlock = `<div class="${STYLE.FIELD}" id="fBodyField">
    <label class="${STYLE.FIELD_LABEL_REQ}" for="fBody"><span id="fBodyLabel">Body</span>${STYLE.REQ_STAR}<span id="fBodyHint" class="${STYLE.HINT}"></span></label>
    <textarea id="fBody" class="${STYLE.FIELD_TEXTAREA_REQ}" aria-required="true"></textarea>
  </div>`;
  // Model + Tools share one row; render manually rather than forcing the
  // generic field() helper to handle the two-input layout.
  const modelToolsBlock = `<div class="${STYLE.FIELD} hidden" id="fModelToolsField">
    <label class="${STYLE.FIELD_LABEL_OPT}">Model · Tools${STYLE.OPT_CHIP}</label>
    <div style="display:flex; gap:8px;">
      <input id="fModel" type="text" placeholder="inherit" class="${STYLE.FIELD_INPUT}" />
      <input id="fTools" type="text" placeholder="*" class="${STYLE.FIELD_INPUT}" />
    </div>
  </div>`;
  return `
    <div class="modal-back" id="editModalBack">
      <div class="${STYLE.MODAL}" role="dialog" aria-modal="true">
        <h3 class="${STYLE.MODAL_H3}" id="editModalTitle">Add</h3>
        <div class="${STYLE.MODAL_SUB}" id="editModalSub">User entries live in your browser's localStorage.</div>
        <div class="${STYLE.MODAL_LEGEND}">
          <span><span class="text-accent" aria-hidden="true">*</span> required</span>
          <span class="opacity-60">·</span>
          <span>${STYLE.OPT_CHIP} may be left blank</span>
        </div>
        ${field({ id: "fType", label: "Type", required: true,
          inputHtml: `<select id="fType" class="${STYLE.FIELD_INPUT_REQ}" aria-required="true">${typeOptions}</select>` })}
        ${field({ id: "fName", label: "Name", hint: "kebab-case, becomes the filename", required: true,
          inputHtml: `<input id="fName" type="text" class="${STYLE.FIELD_INPUT_REQ}" placeholder="my-entry" aria-required="true" />` })}
        ${field({ id: "fDescription", label: "Description", hint: "one-line, Claude-spec required", required: true,
          inputHtml: `<input id="fDescription" type="text" class="${STYLE.FIELD_INPUT_REQ}" aria-required="true" />` })}
        ${bodyBlock}
        ${field({ id: "fSnippet", label: "hook.json", hint: "verbatim settings.json snippet, must parse", required: true, hidden: true,
          inputHtml: `<textarea id="fSnippet" class="${STYLE.FIELD_TEXTAREA_REQ}" aria-required="true" placeholder='{ "hooks": { "PreToolUse": [ ... ] } }'></textarea>` })}
        ${field({ id: "fCategory", label: "Category",
          inputHtml: `<select id="fCategory" class="${STYLE.FIELD_INPUT}"></select>` })}
        ${field({ id: "fTags", label: "Tags", hint: "comma-separated; spaces become dashes, lowercased",
          inputHtml: `<input id="fTags" type="text" class="${STYLE.FIELD_INPUT}" />` })}
        ${field({ id: "fSlash", label: "Slash invocation", hint: "defaults to /name", hidden: true,
          inputHtml: `<input id="fSlash" type="text" placeholder="/my-skill" class="${STYLE.FIELD_INPUT}" />` })}
        ${modelToolsBlock}
        ${field({ id: "fInstallScope", label: "Install scope", hint: "where to merge the snippet", hidden: true, blockId: "fInstallField",
          inputHtml: `<select id="fInstallScope" class="${STYLE.FIELD_INPUT}">
            <option value="user">user (~/.claude/settings.json)</option>
            <option value="project">project (&lt;repo&gt;/.claude/settings.json)</option>
          </select>` })}
        <div class="${STYLE.MODAL_ACTIONS}">
          <button class="${BTN}" id="editModalCancel">Cancel</button>
          <button class="${BTN_PRIMARY}" id="editModalSave">Save</button>
        </div>
      </div>
    </div>
  `;
}

export function ensureEditModal() {
  if (document.getElementById("editModalBack")) return;
  document.body.insertAdjacentHTML("beforeend", modalHtml());
  _fieldCache = null;

  const sel = document.getElementById("fCategory");
  // Explicit "uncategorized" as the no-value default; matches the rail bucket.
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "uncategorized";
  sel.appendChild(blank);
  for (const c of CATEGORIES) {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  }

  document.getElementById("editModalCancel").addEventListener("click", closeEditModal);
  document.getElementById("editModalSave").addEventListener("click", saveEditModal);
  bindBackdropClose(document.getElementById("editModalBack"), closeEditModal);
  document.getElementById("fType").addEventListener("change", reloadTypeDefaults);
}

/* ---------- open / close ---------- */
export function openEditModal({ mode, id, sourceId, sourceType } = {}) {
  ensureEditModal();
  editModalState = { mode, id: id || null, sourceId: sourceId || null, type: sourceType || "prompts" };
  const F = formFields();
  clearInvalid(F);

  const src = mode === "edit" ? findEntity(editModalState.type, id)
            : mode === "fork" ? findEntity(editModalState.type, sourceId)
            : null;
  applyModalHeader(mode, src);
  prefillForm(F, src);
  applyTypeFields(F.fType.value);
  document.getElementById("editModalBack").classList.add("open");
  setTimeout(() => F.fName.focus(), 50);
}

export function closeEditModal() {
  const back = document.getElementById("editModalBack");
  if (back) back.classList.remove("open");
  editModalState = { mode: null };
}

function applyModalHeader(mode, src) {
  const titleEl = document.getElementById("editModalTitle");
  const subEl = document.getElementById("editModalSub");
  if (mode === "edit") {
    titleEl.textContent = `Edit: ${humanizeName(src.name)}`;
    subEl.textContent = `Editing local ${editModalState.type.slice(0,-1)} (name: ${src.name}).`;
  } else if (mode === "fork") {
    titleEl.textContent = `Fork: ${humanizeName(src.name)}`;
    subEl.textContent = `Built-in is read-only. Saving creates a forked copy.`;
  } else {
    titleEl.textContent = "Add";
    subEl.textContent = "Pick a type, then fill the fields.";
  }
}

function prefillForm(F, src) {
  const type = editModalState.type;
  const reg = TYPE_REGISTRY[type];
  F.fType.value = type;
  F.fType.disabled = editModalState.mode === "edit" || editModalState.mode === "fork";
  F.fName.value = src ? (editModalState.mode === "fork" ? `${src.name}-fork` : src.name) : "";
  F.fCategory.value = src ? (src.category || "") : "";
  F.fTags.value = src ? (src.tags || []).join(", ") : "";
  F.fDescription.value = src ? (src.description || "") : "";
  F.fBody.value = src ? (src.body || "") : reg.defaultBody;
  if (src) reg.prefill(F, src);
  else reg.defaults(F);
}

/* ---------- type-driven field visibility ---------- */
function applyTypeFields(type) {
  const active = new Set(TYPE_REGISTRY[type].extras);
  for (const blockId of TYPE_FIELD_BLOCKS) {
    document.getElementById(blockId).classList.toggle("hidden", !active.has(blockId));
  }
  const lbl = document.getElementById("fBodyLabel");
  const hint = document.getElementById("fBodyHint");
  lbl.textContent = TYPE_REGISTRY[type].bodyLabel;
  hint.textContent = TYPE_REGISTRY[type].bodyHint;
  // Snippet input is hidden under the wrong type; clear its invalid state.
  formFields().fSnippet.removeAttribute("aria-invalid");
}

/* Called on Type-select change for a NEW entry. Re-seeds type-dependent
 * inputs to the type's defaults so leftover values from the previous type
 * don't bleed in. Brief Type-input tint telegraphs the swap. No-op on
 * edit/fork (the select is disabled in those modes anyway). */
export function reloadTypeDefaults() {
  if (editModalState.mode !== "new") return;
  const F = formFields();
  const type = F.fType.value;
  editModalState.type = type;
  const reg = TYPE_REGISTRY[type];
  F.fBody.value = reg.defaultBody;
  reg.defaults(F);
  applyTypeFields(type);

  // Subtle reload affordance - scroll-to-top + 240ms tint on the Type select.
  const dialog = document.querySelector("#editModalBack > .modal");
  if (dialog) dialog.scrollTop = 0;
  const t = F.fType;
  t.style.transition = "background-color 240ms ease";
  t.style.backgroundColor = "var(--clay-soft, #f3e3da)";
  setTimeout(() => { t.style.backgroundColor = ""; }, 260);
  setTimeout(() => { t.style.transition = ""; }, 520);
}

/* ---------- validation ---------- */
function clearInvalid(F) {
  for (const id of FIELD_IDS) F[id].removeAttribute("aria-invalid");
}
function setInvalid(el) { el.setAttribute("aria-invalid", "true"); }

function validateForm(F, type) {
  const reg = TYPE_REGISTRY[type];
  const missing = [];
  // Common required.
  for (const { id, label } of COMMON_REQUIRED) {
    if (!F[id].value.trim()) { setInvalid(F[id]); missing.push(label); }
  }
  if (!F.fBody.value.trim()) { setInvalid(F.fBody); missing.push(bodyMissingLabel(type)); }
  // Per-type required.
  for (const { id, label } of (reg.required || [])) {
    if (!F[id].value.trim()) { setInvalid(F[id]); missing.push(label); }
  }
  return missing;
}

/* ---------- save ---------- */
export function saveEditModal() {
  const F = formFields();
  clearInvalid(F);
  const type = F.fType.value;
  const reg = TYPE_REGISTRY[type];

  const missing = validateForm(F, type);
  if (missing.length) {
    toast(`Required: ${missing.join(", ")}`, true);
    // Focus first missing - look it up by label-to-id reverse.
    const focusEl = pickFocusForMissing(F, type, missing[0]);
    focusEl.focus();
    return;
  }
  const extraError = reg.validate(F);
  if (extraError) {
    if (reg.required) for (const { id } of reg.required) setInvalid(F[id]);
    toast(extraError, true);
    if (reg.required && reg.required.length) F[reg.required[0].id].focus();
    return;
  }

  const entry = buildEntry(F, type);
  const user = loadUser(type);
  user[entry.id] = entry;
  saveUser(type, user);
  closeEditModal();
  toast(`Saved: ${humanizeName(entry.name)}`);
  rerender();
  navigateTo(`#/${type}/${entry.id}`);
}

function pickFocusForMissing(F, type, label) {
  if (label === "name") return F.fName;
  if (label === "description") return F.fDescription;
  if (label === "body" || label === "README") return F.fBody;
  if (label === "hook.json") return F.fSnippet;
  return F.fName;
}

function buildEntry(F, type) {
  const reg = TYPE_REGISTRY[type];
  const name = slugify(F.fName.value.trim());
  const description = F.fDescription.value.trim();
  const body = F.fBody.value;
  const category = F.fCategory.value;
  const tags = normaliseTags(F.fTags.value);

  let key;
  if (editModalState.mode === "edit") key = editModalState.id;
  else if (editModalState.mode === "fork") key = `${editModalState.sourceId}-fork-${Date.now().toString(36)}`;
  else key = `${name}-${Date.now().toString(36)}`;

  const entry = { name, id: key, description, body };
  if (category) entry.category = category;
  if (tags.length) entry.tags = tags;
  reg.applyExtras(entry, F, name);
  if (editModalState.mode === "fork") entry.forkOf = editModalState.sourceId;
  entry.updatedAt = new Date().toISOString();
  return entry;
}

function normaliseTags(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(",")) {
    const v = slugify(part.trim());
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/* ---------- mutations ---------- */
export function duplicateEntity(entity) {
  const user = loadUser(entity.type);
  const key = `${entity.name}-copy-${Date.now().toString(36)}`;
  user[key] = {
    ...entity,
    name: `${entity.name}-copy`,
    id: key,
    forkOf: entity.name,
    updatedAt: new Date().toISOString(),
    source: undefined,
    type: undefined
  };
  saveUser(entity.type, user);
  toast(`Duplicated: ${humanizeName(entity.name)}`);
  rerender();
}

export function deleteEntity(entity) {
  if (entity.source === "builtin") { toast("Built-ins cannot be deleted, fork to edit."); return; }
  if (!confirm(`Delete "${humanizeName(entity.name)}"?`)) return;
  const user = loadUser(entity.type);
  delete user[entity.id];
  saveUser(entity.type, user);
  toast(`Deleted: ${humanizeName(entity.name)}`);
  if (state.route.id === entity.id) navigateTo(`#/${entity.type}`);
  else rerender();
}
