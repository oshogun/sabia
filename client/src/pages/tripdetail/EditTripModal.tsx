import { InlineNotification, Modal, TextArea, TextInput } from '@carbon/react';
import { ModalPortal, useLauncherRef } from '../../components/ConfirmModal';

export interface EditTripModalProps {
  open: boolean;
  name: string;
  notes: string;
  onNameChange: (name: string) => void;
  onNotesChange: (notes: string) => void;
  saving: boolean;
  /** Request failure, shown inside the dialog so the edit is not lost. */
  error: string;
  onSave: () => void;
  onCancel: () => void;
}

/** Rename a trip and edit its free-form notes. A blank name cannot be saved. */
export function EditTripModal({
  open, name, notes, onNameChange, onNotesChange, saving, error, onSave, onCancel,
}: EditTripModalProps) {
  const launcherRef = useLauncherRef(open);
  const blank = name.trim() === '';
  return (
    <ModalPortal>
      <Modal
        open={open}
        launcherButtonRef={launcherRef}
        size="sm"
        selectorPrimaryFocus="#edit-trip-name"
        modalHeading="Edit trip"
        primaryButtonText={saving ? 'Saving…' : 'Save'}
        primaryButtonDisabled={saving || blank}
        secondaryButtonText="Cancel"
        onRequestSubmit={onSave}
        onRequestClose={onCancel}
      >
        <TextInput
          id="edit-trip-name"
          labelText="Trip name"
          maxLength={200}
          value={name}
          invalid={blank}
          invalidText="Name is required"
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !blank && !saving) onSave(); }}
        />
        <TextArea
          id="edit-trip-notes"
          labelText="Notes"
          rows={4}
          placeholder="Free-form notes about this trip…"
          value={notes}
          onChange={e => onNotesChange(e.target.value)}
          style={{ marginBlockStart: '1rem' }}
        />
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save"
            subtitle={error} style={{ maxInlineSize: 'none', marginBlockStart: '1rem' }} />
        )}
      </Modal>
    </ModalPortal>
  );
}
