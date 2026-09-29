import { useEffect, useState } from 'react';
import { InlineNotification, Modal, TextArea, TextInput } from '@carbon/react';
import { ModalPortal, useLauncherRef } from '../../components/ConfirmModal';
import type { Flight } from '../../types';

export interface EditFlightModalProps {
  open: boolean;
  flight: Flight;
  saving: boolean;
  error: string;
  onSave: (values: { aircraft: string | null; notes: string | null }) => void;
  onCancel: () => void;
}

/** Aircraft name and notes; an emptied field is saved as null. */
export function EditFlightModal({ open, flight, saving, error, onSave, onCancel }: EditFlightModalProps) {
  const launcherRef = useLauncherRef(open);
  const [aircraft, setAircraft] = useState(flight.aircraft || '');
  const [notes, setNotes] = useState(flight.notes || '');

  // Each opening starts from the saved values, so a cancelled edit leaves nothing behind.
  useEffect(() => {
    if (open) {
      setAircraft(flight.aircraft || '');
      setNotes(flight.notes || '');
    }
  }, [open, flight.aircraft, flight.notes]);

  return (
    <ModalPortal>
      <Modal
        open={open}
        launcherButtonRef={launcherRef}
        size="sm"
        modalHeading="Edit flight"
        primaryButtonText={saving ? 'Saving…' : 'Save'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={saving}
        onRequestSubmit={() => onSave({ aircraft: aircraft.trim() || null, notes: notes.trim() || null })}
        onRequestClose={onCancel}
      >
        <TextInput
          id="edit-flight-aircraft"
          labelText="Aircraft"
          value={aircraft}
          maxLength={200}
          placeholder="Aircraft name"
          onChange={e => setAircraft(e.target.value)}
        />
        <div style={{ marginTop: '1rem' }}>
          <TextArea
            id="edit-flight-notes"
            labelText="Notes"
            rows={4}
            value={notes}
            placeholder="Free-form notes about this flight…"
            onChange={e => setNotes(e.target.value)}
          />
        </div>
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save flight"
            subtitle={error} style={{ maxInlineSize: 'none', marginBlockStart: '1rem' }} />
        )}
      </Modal>
    </ModalPortal>
  );
}
