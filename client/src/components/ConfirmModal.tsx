import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '@carbon/react';

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isRendered = (el: HTMLElement) => el.getClientRects().length > 0;

/**
 * Carbon wraps focus with sentinel spans and a blur handler that moves focus on
 * a zero-delay timeout. Two Tab or Shift+Tab presses inside that gap step onto
 * the sentinel and then out to the page behind the modal. Wrapping the ends
 * synchronously, here, means focus never reaches a sentinel; Carbon's own
 * handler is left in place and still handles focus that arrives by other means.
 */
function trapKeys(e: KeyboardEvent) {
  if ((e.key !== 'Tab' && e.key !== 'Escape') || e.ctrlKey || e.altKey || e.metaKey) return;
  const modals = document.querySelectorAll<HTMLElement>('.cds--modal.is-visible');
  const container = modals[modals.length - 1]?.querySelector<HTMLElement>('.cds--modal-container');
  if (!container) return;
  if (e.key === 'Escape') {
    // The close button's tooltip swallows the first Escape when that button has
    // focus; pressing the button itself closes the modal in one keystroke.
    const close = container.querySelector<HTMLElement>('.cds--modal-close');
    if (close && container.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
      close.click();
    }
    return;
  }
  const items = Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter(isRendered);
  if (items.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at === -1 || (e.shiftKey && at === 0) || (!e.shiftKey && at === items.length - 1)) {
    e.preventDefault();
    items[e.shiftKey ? items.length - 1 : 0].focus();
  }
}

let trapUsers = 0;

/** One document-level Tab and Escape handler, shared by every mounted ModalPortal and aimed at the topmost open modal. */
function useModalFocusTrap() {
  useEffect(() => {
    if (trapUsers++ === 0) document.addEventListener('keydown', trapKeys, true);
    return () => {
      if (--trapUsers === 0) document.removeEventListener('keydown', trapKeys, true);
    };
  }, []);
}

/**
 * Carbon's Modal renders where it is declared, inside the page content, so Tab
 * leaving its focus sentinels walks through <body> and the shell's own controls
 * before wrapping back. Mounting it under <body> keeps the trap self-contained,
 * and the shared Tab trap keeps fast key presses from stepping past the ends.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  useModalFocusTrap();
  return createPortal(children, document.body);
}

/**
 * Carbon's Modal returns focus on close only to a launcher it is handed by ref,
 * and the launchers here are ordinary buttons elsewhere in the page. This
 * remembers the element focused when `open` turned true and returns the ref to
 * pass as the Modal's `launcherButtonRef`.
 */
export function useLauncherRef(open: boolean) {
  const launcher = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) launcher.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  return launcher;
}

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** Renders the confirm button as a danger action. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel,
}: ConfirmModalProps) {
  const launcherRef = useLauncherRef(open);
  return (
    <ModalPortal>
    <Modal
      open={open}
      launcherButtonRef={launcherRef}
      size="xs"
      selectorPrimaryFocus=".cds--modal-footer .cds--btn--primary"
      danger={danger}
      modalHeading={title}
      primaryButtonText={confirmLabel}
      secondaryButtonText="Cancel"
      onRequestSubmit={onConfirm}
      onRequestClose={onCancel}
    >
      <p>{message}</p>
    </Modal>
    </ModalPortal>
  );
}
