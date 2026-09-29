import { Button, FileUploaderButton, InlineLoading, InlineNotification, Link, Tile } from '@carbon/react';
import type { Flight } from '../../types';

export interface FlightPlanSectionProps {
  flight: Flight;
  uploading: boolean;
  uploadError: string;
  onFile: (file: File) => void;
  onRemove: () => void;
}

/** The attached flight-plan PDF, or the picker to attach one. */
export function FlightPlanSection({ flight, uploading, uploadError, onFile, onRemove }: FlightPlanSectionProps) {
  return (
    <Tile style={{ marginBottom: '1rem' }} data-testid="flight-plan-section">
      <h2 className="sabia-heading-03" style={{ marginBottom: '0.75rem' }}>Flight plan</h2>
      {flight.flight_plan_name ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <Link href={`/api/flights/${flight.id}/flight-plan`} data-testid="flight-plan-name">
            {flight.flight_plan_name}
          </Link>
          <Button kind="ghost" size="md" onClick={onRemove}>Remove</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <FileUploaderButton
            labelText="Attach PDF"
            buttonKind="tertiary"
            size="md"
            accept={['application/pdf']}
            disabled={uploading}
            disableLabelChanges
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) onFile(file);
            }}
          />
          {uploading && <InlineLoading description="Uploading flight plan…" />}
        </div>
      )}
      {uploadError && <InlineNotification kind="error" title="Could not upload flight plan" subtitle={uploadError} hideCloseButton lowContrast />}
    </Tile>
  );
}
