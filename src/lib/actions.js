import { focusSearch, moveFocus, jumpFocus, focusedEntity, goView, toggleHelpOverlay, handleEscape } from "../app.js";
import { copyEntity } from "../components/card.js";
import { navigateTo } from "../router.js";
import { openEditModal, duplicateEntity, deleteEntity } from "../components/modal-edit.js";
import { openRequestModal } from "../components/modal-request.js";

/* Action registry. Action ids referenced from KEYMAPS bindings.
 * Implementations resolve against the global state and view functions
 * defined later in the load order (app.js, views/*, components/*). */

export const ACTIONS = {
  "search.focus":      () => focusSearch(),
  "focus.next":        () => moveFocus(1),
  "focus.prev":        () => moveFocus(-1),
  "focus.pageDown":    () => moveFocus(8),
  "focus.pageUp":      () => moveFocus(-8),
  "focus.first":       () => jumpFocus("first"),
  "focus.last":        () => jumpFocus("last"),
  "prompt.copy":       () => { const e = focusedEntity(); if (e) copyEntity(e); },
  "prompt.copyOpen":   () => { const e = focusedEntity(); if (!e) return; copyEntity(e); navigateTo(`#/${e.type}/${e.id}`); },
  "prompt.new":        () => openEditModal({ mode: "new" }),
  "prompt.edit":       () => {
    const e = focusedEntity();
    if (!e) return;
    if (e.source === "builtin") openEditModal({ mode: "fork", sourceId: e.id, sourceType: e.type });
    else openEditModal({ mode: "edit", id: e.id, sourceType: e.type });
  },
  "prompt.requestEdit": () => { const e = focusedEntity(); if (e) openRequestModal({ entityId: e.id, entityType: e.type }); },
  "prompt.duplicate":   () => { const e = focusedEntity(); if (e) duplicateEntity(e); },
  "prompt.delete":      () => { const e = focusedEntity(); if (e) deleteEntity(e); },
  "view.gallery":       () => goView("gallery"),
  "view.manpage":       () => goView("manpage"),
  "ui.help":            () => toggleHelpOverlay(),
  "ui.escape":          () => handleEscape()
};
