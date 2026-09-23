/* Shared modal helpers.
 *
 * `bindBackdropClose(backdropEl, onClose)` wires a "click the dim
 * backdrop to close" handler. The same pattern was inlined in four
 * modals; centralizing it stops one of those copies from quietly losing
 * the equality check and starting to close on every inner click.
 *
 * `shouldCloseOnBackdropClick(event, backdropEl)` is the pure predicate
 * extracted so unit tests can exercise the logic without a real DOM. */

export function shouldCloseOnBackdropClick(event, backdropEl) {
  if (!event || !backdropEl) return false;
  return event.target === backdropEl;
}

export function bindBackdropClose(backdropEl, onClose) {
  if (!backdropEl || typeof onClose !== "function") return;
  backdropEl.addEventListener("click", e => {
    if (shouldCloseOnBackdropClick(e, backdropEl)) onClose();
  });
}

