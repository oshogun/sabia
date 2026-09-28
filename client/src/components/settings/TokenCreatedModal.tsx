import { CodeSnippet, InlineNotification, Modal } from '@carbon/react';
import { ModalPortal, useLauncherRef } from '../ConfirmModal';

/** A freshly created token, held only for the current render. */
export interface TokenCreatedInfo {
  label: string;
  public_id: string;
  secret: string;
}

interface TokenCreatedModalProps {
  /** null closes the modal. The caller clears this the instant it does, so the secret never outlives it. */
  info: TokenCreatedInfo | null;
  onClose: () => void;
}

/**
 * The one-time reveal for a token's plaintext. Deliberately has no "cancel" —
 * the token already exists on the server by the time this opens, so the only
 * choice is to acknowledge having copied it.
 */
export function TokenCreatedModal({ info, onClose }: TokenCreatedModalProps) {
  const open = info !== null;
  const launcherRef = useLauncherRef(open);
  return (
    <ModalPortal>
      <Modal
        open={open}
        launcherButtonRef={launcherRef}
        size="sm"
        data-testid="token-created-modal"
        modalHeading="Token created"
        primaryButtonText="Done"
        preventCloseOnClickOutside
        onRequestSubmit={onClose}
        onRequestClose={onClose}
      >
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Copy this token now. You won't be able to see it again."
        />
        {info && (
          <div data-testid="token-created-value" style={{ marginBlockStart: '1rem' }}>
            <CodeSnippet type="single" feedback="Copied" aria-label={`Token for ${info.label}`}>
              {info.secret}
            </CodeSnippet>
          </div>
        )}
      </Modal>
    </ModalPortal>
  );
}
