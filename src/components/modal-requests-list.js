import { BTN, BTN_PRIMARY } from "../lib/ui-classes.js";
import { bindBackdropClose } from "../lib/modal-helpers.js";
import { escapeHtml, toast, downloadFile, humanizeName } from "../lib/util.js";
import { findEntity, loadEditRequests, saveEditRequests } from "../lib/storage.js";
import { navigateTo } from "../router.js";
import { openRequestModal, requestToMarkdown, renderRequestsCounter } from "./modal-request.js";

/* Requests list modal. View all saved edit-request drafts, export, delete. */

export function ensureRequestsListModal() {
  if (document.getElementById("reqListBack")) return;
  const MODAL = "modal bg-paper border border-rule rounded w-full max-w-[720px] max-h-[90vh] overflow-y-auto shadow-3 p-7 max-md:px-[18px] max-md:py-5";
  const MODAL_H3 = "font-display italic text-[28px] m-0 mb-1";
  const MODAL_SUB = "modal-sub text-ink-mute text-[13px] mb-[18px]";
  const MODAL_ACTIONS = "modal-actions flex gap-2 justify-end mt-5 pt-4 border-t border-dashed border-rule flex-wrap";
  // BTN / BTN_PRIMARY are the shared constants from src/lib/ui-classes.js.
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal-back" id="reqListBack">
      <div class="${MODAL}" role="dialog" aria-modal="true">
        <h3 class="${MODAL_H3}">Edit requests</h3>
        <div class="${MODAL_SUB}">Local drafts of proposed changes. Export any to hand off as a PR or ticket.</div>
        <div class="requests-list flex flex-col gap-3" id="reqList"></div>
        <div class="${MODAL_ACTIONS}">
          <button class="${BTN}" id="reqListExportAll">Export all .md</button>
          <button class="${BTN_PRIMARY}" id="reqListClose">Close</button>
        </div>
      </div>
    </div>
  `);
  document.getElementById("reqListClose").addEventListener("click", () => document.getElementById("reqListBack").classList.remove("open"));
  document.getElementById("reqListExportAll").addEventListener("click", exportAllRequests);
  bindBackdropClose(document.getElementById("reqListBack"), () => document.getElementById("reqListBack").classList.remove("open"));
}

export function openRequestsList() {
  ensureRequestsListModal();
  renderRequestsList();
  document.getElementById("reqListBack").classList.add("open");
}

export function renderRequestsList() {
  const list = document.getElementById("reqList");
  if (!list) return;
  const all = loadEditRequests();
  list.innerHTML = "";
  // BTN is the shared constant from src/lib/ui-classes.js.
  if (!all.length) {
    list.innerHTML = `<div class="request-empty py-8 px-3 text-center text-ink-mute italic font-display text-[18px]">No edit requests yet.</div>`;
    return;
  }
  all.forEach(req => {
    const e = findEntity(req.entityType, req.entityId);
    const card = document.createElement("div");
    card.className = "request-card border border-rule rounded-md px-4 py-3.5 bg-paper transition-colors duration-100 hover:border-paper-edge hover:bg-paper-deep";
    card.innerHTML = `
      <div class="req-head flex items-center justify-between mb-1.5">
        <div class="req-title font-display italic text-[18px]">${escapeHtml(e ? humanizeName(e.name) : req.entityId)}</div>
        <div class="req-meta font-mono text-[10.5px] text-ink-mute tracking-[.12em] uppercase">${escapeHtml(new Date(req.createdAt).toISOString().slice(0,16).replace("T"," "))} · ${escapeHtml(req.entityType)} · ${escapeHtml(req.status)}</div>
      </div>
      <div class="req-reason text-ink-soft text-[13.5px] my-1.5 mb-2.5 whitespace-pre-wrap">${escapeHtml(req.reason)}</div>
      <div class="req-actions flex gap-1.5 flex-wrap">
        <button class="${BTN}" data-act="open">Open ${escapeHtml(req.entityType.slice(0,-1))}</button>
        <button class="${BTN}" data-act="edit">Edit request</button>
        <button class="${BTN}" data-act="export">Export .md</button>
        <button class="${BTN}" data-act="delete">Delete</button>
      </div>
    `;
    card.querySelectorAll("[data-act]").forEach(btn => btn.addEventListener("click", () => {
      const a = btn.dataset.act;
      if (a === "open" && e) { document.getElementById("reqListBack").classList.remove("open"); navigateTo(`#/${req.entityType}/${req.entityId}`); }
      else if (a === "edit") { document.getElementById("reqListBack").classList.remove("open"); openRequestModal({ requestId: req.id }); }
      else if (a === "export") downloadFile(`${req.entityType}__${req.entityId}__${req.id}.md`, requestToMarkdown(req), "text/markdown");
      else if (a === "delete") {
        if (!confirm("Delete this request?")) return;
        saveEditRequests(loadEditRequests().filter(r => r.id !== req.id));
        renderRequestsList();
        renderRequestsCounter();
        toast("Request deleted");
      }
    }));
    list.appendChild(card);
  });
}

export function exportAllRequests() {
  const all = loadEditRequests();
  if (!all.length) { toast("No requests to export", true); return; }
  const bundle = all.map(requestToMarkdown).join("\n\n---\n\n");
  downloadFile(`edit-requests-${new Date().toISOString().slice(0,10)}.md`, bundle, "text/markdown");
}
