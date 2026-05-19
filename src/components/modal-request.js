import { BTN, BTN_PRIMARY } from "../lib/ui-classes.js";
import { bindBackdropClose } from "../lib/modal-helpers.js";
import { toast, downloadFile, humanizeName } from "../lib/util.js";
import { findEntity, loadEditRequests, saveEditRequests } from "../lib/storage.js";

/* Edit-request modal. Persists drafts in localStorage aitelier-requests-v1.
 * Used to draft proposed changes to built-in entities, exportable as
 * markdown to file as a PR or ticket. */

export let reqModalState = { mode: null, requestId: null, entityId: null, entityType: null };

export function ensureRequestModal() {
  if (document.getElementById("reqModalBack")) return;
  const FIELD = "field mb-3.5";
  const FIELD_LABEL = "block font-mono text-[10.5px] tracking-[.18em] uppercase text-ink-mute mb-1.5";
  const FIELD_INPUT = "w-full bg-paper border border-rule rounded-sm px-3 py-2 text-ink text-sm focus:outline-none focus:border-ink";
  const FIELD_TEXTAREA = "w-full bg-paper border border-rule rounded-sm px-3 py-2 text-ink font-mono text-[12.75px] leading-[1.6] min-h-[240px] resize-y focus:outline-none focus:border-ink";
  const MODAL = "modal bg-paper border border-rule rounded w-full max-w-[720px] max-h-[90vh] overflow-y-auto shadow-3 p-7 max-md:px-[18px] max-md:py-5";
  const MODAL_H3 = "font-display italic text-[28px] m-0 mb-1";
  const MODAL_SUB = "modal-sub text-ink-mute text-[13px] mb-[18px]";
  const MODAL_ACTIONS = "modal-actions flex gap-2 justify-end mt-5 pt-4 border-t border-dashed border-rule flex-wrap";
  // BTN / BTN_PRIMARY are the shared constants from src/lib/ui-classes.js.
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal-back" id="reqModalBack">
      <div class="${MODAL}" role="dialog" aria-modal="true">
        <h3 class="${MODAL_H3}" id="reqModalTitle">Request edit</h3>
        <div class="${MODAL_SUB}">Built-ins are read-only. Draft a proposed change locally; export as Markdown to file as a PR or ticket.</div>
        <div class="${FIELD}"><label class="${FIELD_LABEL}">For</label><input id="rqFor" type="text" readonly class="${FIELD_INPUT}" /></div>
        <div class="${FIELD}"><label class="${FIELD_LABEL}">Reason / what should change &amp; why</label><textarea id="rqReason" class="${FIELD_TEXTAREA}"></textarea></div>
        <div class="${FIELD}"><label class="${FIELD_LABEL}">Proposed body (full replacement)</label><textarea id="rqBody" class="${FIELD_TEXTAREA}"></textarea></div>
        <div class="${MODAL_ACTIONS}">
          <button class="${BTN}" id="rqCancel">Cancel</button>
          <button class="${BTN}" id="rqExport">Export .md</button>
          <button class="${BTN_PRIMARY}" id="rqSave">Save request</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById("rqCancel").addEventListener("click", closeRequestModal);
  document.getElementById("rqSave").addEventListener("click", saveRequest);
  document.getElementById("rqExport").addEventListener("click", exportRequestDraft);
  bindBackdropClose(document.getElementById("reqModalBack"), closeRequestModal);
}

export function openRequestModal({ entityId, entityType, requestId } = {}) {
  ensureRequestModal();
  const back = document.getElementById("reqModalBack");
  const title = document.getElementById("reqModalTitle");
  const forEl = document.getElementById("rqFor");
  const reasonEl = document.getElementById("rqReason");
  const bodyEl = document.getElementById("rqBody");

  if (requestId) {
    const req = loadEditRequests().find(r => r.id === requestId);
    if (!req) { toast("Request not found", true); return; }
    reqModalState = { mode: "edit", requestId, entityId: req.entityId, entityType: req.entityType };
    const e = findEntity(req.entityType, req.entityId);
    title.textContent = `Edit request: ${e ? humanizeName(e.name) : req.entityId}`;
    forEl.value = `${req.entityType}/${req.entityId}`;
    reasonEl.value = req.reason || "";
    bodyEl.value = req.proposedBody || "";
  } else {
    const e = findEntity(entityType, entityId);
    if (!e) { toast("Entity not found", true); return; }
    reqModalState = { mode: "new", requestId: null, entityId: e.name, entityType };
    title.textContent = `Request edit: ${humanizeName(e.name)}`;
    forEl.value = `${entityType}/${e.name}`;
    reasonEl.value = "";
    bodyEl.value = e.body || "";
  }
  back.classList.add("open");
  setTimeout(() => reasonEl.focus(), 50);
}

export function closeRequestModal() {
  const back = document.getElementById("reqModalBack");
  if (back) back.classList.remove("open");
  reqModalState = { mode: null };
}

export function saveRequest() {
  const [entityType, entityId] = document.getElementById("rqFor").value.split("/");
  const reason = document.getElementById("rqReason").value.trim();
  const proposedBody = document.getElementById("rqBody").value;
  if (!reason) { toast("Reason required", true); return; }
  const all = loadEditRequests();
  if (reqModalState.mode === "edit") {
    const idx = all.findIndex(r => r.id === reqModalState.requestId);
    if (idx >= 0) all[idx] = { ...all[idx], reason, proposedBody, updatedAt: new Date().toISOString() };
  } else {
    all.unshift({
      id: "req-" + Date.now().toString(36),
      entityType, entityId,
      reason, proposedBody, status: "draft",
      createdAt: new Date().toISOString()
    });
  }
  saveEditRequests(all);
  closeRequestModal();
  toast("Edit request saved");
  renderRequestsCounter();
}

export function exportRequestDraft() {
  const [entityType, entityId] = document.getElementById("rqFor").value.split("/");
  const reason = document.getElementById("rqReason").value.trim();
  const proposedBody = document.getElementById("rqBody").value;
  if (!reason) { toast("Reason required to export", true); return; }
  const draft = { id: reqModalState.requestId || "draft", entityType, entityId, reason, proposedBody, status: "draft", createdAt: new Date().toISOString() };
  downloadFile(`${entityType}__${entityId}__${draft.id}.md`, requestToMarkdown(draft), "text/markdown");
}

export function requestToMarkdown(req) {
  const e = findEntity(req.entityType, req.entityId);
  const title = e ? humanizeName(e.name) : req.entityId;
  return `# Edit request: ${title}

- Type: \`${req.entityType}\`
- Id: \`${req.entityId}\`
- Status: ${req.status}
- Created: ${req.createdAt}
${req.updatedAt ? `- Updated: ${req.updatedAt}\n` : ""}

## Reason

${req.reason}

## Proposed body

\`\`\`
${req.proposedBody}
\`\`\`
`;
}

export function renderRequestsCounter() {
  const el = document.getElementById("reqCounter");
  if (!el) return;
  const n = loadEditRequests().length;
  el.textContent = String(n);
  el.style.display = n ? "" : "none";
}
