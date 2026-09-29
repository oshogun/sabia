import { Link as RouterLink } from 'react-router-dom';
import { Button, InlineLoading, InlineNotification, Link, Tag, Tile } from '@carbon/react';
import { StatusTag } from '../../components/StatusTag';
import { formatAlt, formatDistance, plannedLegLandingNote } from '../../components/legs';
import type { Flight, PlannedLegWithChildren } from '../../types';

const muted = { color: 'var(--cds-text-secondary)', marginTop: '0.25rem' } as const;

function procedureLine(label: string, parts: (string | null)[]): string {
  return `${label} ${parts.filter((p): p is string => !!p).join(' · ')}`;
}

/**
 * The SID, STAR and approach lines, verbatim. A CUSTOM approach is a
 * synthesized label rather than a published procedure, and the line says so.
 */
export function procedureLines(leg: PlannedLegWithChildren): string[] {
  const lines: string[] = [];
  if (leg.sid_name) lines.push(procedureLine('SID', [leg.sid_name, leg.sid_runway, leg.sid_transition]));
  if (leg.star_name) lines.push(procedureLine('STAR', [leg.star_name, leg.star_runway, leg.star_transition]));
  if (leg.approach_name) {
    let line = procedureLine('APP', [leg.approach_name, leg.approach_runway, leg.approach_transition]);
    if (leg.approach_type === 'CUSTOM') line += ' (custom — not a published procedure)';
    lines.push(line);
  }
  return lines;
}

export interface PlannedLegSectionProps {
  flight: Flight;
  leg: PlannedLegWithChildren | null;
  tripName: string | null;
  loading: boolean;
  loadError: string;
  unlinkBusy: boolean;
  unlinkError: string;
  markBusy: boolean;
  markError: string;
  onMark: (target: 'flown' | 'planned') => void;
  onUnlink: () => void;
}

export function PlannedLegSection({
  flight, leg, tripName, loading, loadError, unlinkBusy, unlinkError, markBusy, markError, onMark, onUnlink,
}: PlannedLegSectionProps) {
  const landingNote = leg ? plannedLegLandingNote(leg, flight.arrival_icao) : null;
  // Mirrors the server's gate; if the two ever disagree the server wins and
  // the user sees its 409 text.
  const handCloseEligible = !!leg
    && flight.planned_leg_link_source === 'manual'
    && flight.end_time !== null
    && (leg.status === 'planned' || leg.status === 'flown');
  const handCloseTarget: 'flown' | 'planned' = leg?.status === 'flown' ? 'planned' : 'flown';

  return (
    <Tile style={{ marginBottom: '1rem' }} data-testid="planned-leg-section">
      <h2 className="sabia-heading-03" style={{ marginBottom: '0.75rem' }}>Planned leg</h2>
      {loading && <InlineLoading description="Loading planned leg…" />}
      {loadError && <InlineNotification kind="error" title="Could not load planned leg" subtitle={loadError} hideCloseButton lowContrast />}
      {leg && (
        <>
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <StatusTag kind={leg.status} />
            {leg.is_snippet === 1 && <Tag type="cool-gray" size="md">Snippet</Tag>}
            <span>
              Leg {leg.seq} of{' '}
              {leg.trip_id !== null && tripName
                ? <Link as={RouterLink} to={`/trip/${leg.trip_id}`}>{tripName}</Link>
                : 'No trip'}
              : {leg.departure_ident} → {leg.destination_ident}
            </span>
          </p>
          <p style={muted}>
            Planned cruise {formatAlt(leg.cruise_alt_ft)} ft · approx. {formatDistance(leg.approx_distance_nm)} nm
          </p>
          {landingNote && (
            <p style={leg.status === 'diverted' ? { ...muted, color: 'var(--cds-text-error)' } : muted}>{landingNote}</p>
          )}
          <p style={muted}>
            {flight.planned_leg_link_source === 'auto'
              ? 'Linked automatically, at takeoff.'
              : flight.planned_leg_link_source === 'manual'
                ? 'Linked by hand.'
                : 'Linked.'}
          </p>
          {procedureLines(leg).map(line => <p key={line} style={muted}>{line}</p>)}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            {handCloseEligible && (
              <Button kind="ghost" size="md" disabled={markBusy} onClick={() => onMark(handCloseTarget)}>
                {handCloseTarget === 'flown'
                  ? (markBusy ? 'Marking…' : 'Mark flown')
                  : (markBusy ? 'Reopening…' : 'Back to planned')}
              </Button>
            )}
            <Button kind="ghost" size="md" disabled={unlinkBusy} onClick={onUnlink}>
              {unlinkBusy ? 'Unlinking…' : 'Unlink'}
            </Button>
          </div>
          {unlinkError && <InlineNotification kind="error" title="Could not unlink" subtitle={unlinkError} hideCloseButton lowContrast />}
          {markError && <InlineNotification kind="error" title="Could not change leg status" subtitle={markError} hideCloseButton lowContrast />}
        </>
      )}
    </Tile>
  );
}
