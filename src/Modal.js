/**
 * Modal.js — the shell all three dialogs share.
 *
 * There were three of them by stage 8 (help, convergence, comparison), each
 * hand-rolling the overlay and each getting the keyboard slightly differently
 * wrong. A dialog has four obligations beyond looking like one, and none of them
 * is optional:
 *
 *   - **Escape closes it.** It is the only way out that needs no mouse and no
 *     hunting for a button.
 *   - **Focus moves in on open.** Otherwise a screen reader is still reading the
 *     page behind, and a keyboard user's next Tab lands in the left panel.
 *   - **Tab stays inside.** A modal that leaks focus to the controls it is
 *     covering is a trap of the other kind: things move that the user cannot see.
 *   - **Focus goes back where it came from on close.** Reopening help from the
 *     button and being returned to the top of the document loses the user's place.
 *
 * `aria-modal` tells assistive technology the rest of the page is inert, which is
 * what makes the trap honest rather than merely a nuisance.
 */

import React, { useEffect, useRef } from 'react';

/** Everything a keyboard can land on, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function Modal({ onClose, label, className = '', children }) {
  const surfaceRef = useRef(null);
  const returnRef = useRef(null);

  useEffect(() => {
    // Remembered before focus moves, so closing puts it back on the button that
    // opened this rather than at the top of the document.
    returnRef.current = document.activeElement;
    const surface = surfaceRef.current;
    if (!surface) return undefined;

    const focusable = () => [...surface.querySelectorAll(FOCUSABLE)];
    // The surface itself is focusable (tabIndex -1 below), so a dialog whose
    // content is all text still gets the announcement.
    const first = focusable()[0] || surface;
    first.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const edge = event.shiftKey ? items[0] : items[items.length - 1];
      // Only the edges need handling; everything in between is the browser's
      // own tab order, which is already right.
      if (document.activeElement !== edge && surface.contains(document.activeElement)) return;
      event.preventDefault();
      (event.shiftKey ? items[items.length - 1] : items[0]).focus();
    };

    surface.addEventListener('keydown', onKeyDown);
    return () => {
      surface.removeEventListener('keydown', onKeyDown);
      const target = returnRef.current;
      // Guard: the element may have been unmounted while the dialog was open.
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus();
      }
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={surfaceRef}
        className={`modal-content ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export default Modal;
