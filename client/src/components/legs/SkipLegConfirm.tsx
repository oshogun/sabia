import { InlineNotification, Modal } from '@carbon/react';
import { ModalPortal, useLauncherRef } from '../ConfirmModal';
import type { PlannedLegWithChildren } from '../../types';

/** Props for {@link SkipLegConfirm}. Controlled by the consuming page. */
export interface SkipLegConfirmProps {
  /** The leg being skipped/unskipped; null closes the modal. */
  leg: PlannedLegWithChildren | null;
  busy?: boolean;
  /** Inline error from the request (e.g. the server's 409), kept inside the modal so the user sees it in context. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirm step before a leg's status is toggled between planned and skipped. */
export function SkipLegConfirm({ leg, busy = false, error, onConfirm, onCancel }: SkipLegConfirmProps) {
  const launcherRef = useLauncherRef(leg !== null);
  const unskip = leg?.status === 'skipped';
  const route = leg ? `${leg.departure_ident} → ${leg.destination_ident}` : '';
  return (
    <ModalPortal>
    <Modal
      open={leg !== null}
      launcherButtonRef={launcherRef}
      size="xs"
      selectorPrimaryFocus=".cds--modal-footer .cds--btn--primary"
      modalHeading={unskip ? 'Unskip leg' : 'Skip leg'}
      primaryButtonText={busy ? 'Working…' : (unskip ? 'Unskip' : 'Skip')}
      primaryButtonDisabled={busy}
      secondaryButtonText="Cancel"
      onRequestSubmit={onConfirm}
      onRequestClose={onCancel}
    >
      <p>
        {unskip
          ? `Mark ${route} as planned again?`
          : `Mark ${route} as skipped? You can unskip it later.`}
      </p>
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title={unskip ? 'Could not unskip leg' : 'Could not skip leg'}
          subtitle={error} style={{ maxInlineSize: 'none', marginBlockStart: '1rem' }} />
      )}
    </Modal>
    </ModalPortal>
  );
}
