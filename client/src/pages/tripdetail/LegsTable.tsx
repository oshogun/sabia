import { Fragment } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Button, InlineNotification, Pagination, Select, SelectItem, Table, TableBody, TableCell, TableContainer, TableHead,
  TableHeader, TableRow,
} from '@carbon/react';
import { EmptyState } from '../../components/EmptyState';
import { StatusTag } from '../../components/StatusTag';
import { GHOST_LEG_COLUMNS, GhostLegRow, plannedLegLandingNote } from '../../components/legs';
import { legColor } from '../../components/maps/palette';
import { formatDate, formatDistance, formatDuration } from '../../utils/format';
import type { Flight, PlannedLegWithChildren } from '../../types';
import { interleaveTripRows } from './interleave';
import { LEGS_PER_PAGE, type LegsTableProps } from './legsTableProps';

const errorNote = (title: string, subtitle: string) => (
  <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle={subtitle}
    style={{ maxInlineSize: 'none' }} />
);

interface FlownRowProps extends LegsTableProps {
  flight: Flight;
  index: number;
  linkedLeg: PlannedLegWithChildren | undefined;
  showLinkToLeg: boolean;
}

function FlownRow({
  flight: f, index, linkedLeg, showLinkToLeg, unlinkBusyFlightId, unlinkErrorByFlight, onRequestUnlink,
  onRequestRemoveFlight, flightPicker,
}: FlownRowProps) {
  const landingNote = linkedLeg ? plannedLegLandingNote(linkedLeg, f.arrival_icao) : null;
  const unlinkBusy = unlinkBusyFlightId === f.id;
  const pickerOpen = flightPicker.openFlightId === f.id;
  const pickBusy = flightPicker.busyFlightId === f.id;
  const label = `Leg ${index + 1}, ${f.departure_icao || '???'} to ${f.arrival_icao || '???'}`;
  const { legs } = flightPicker;
  return (
    <Fragment>
      <TableRow>
        <TableCell>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span aria-hidden="true" style={{
              inlineSize: '0.75rem', blockSize: '0.75rem', borderRadius: '50%', background: legColor(index),
            }} />
            <span>Leg {index + 1}</span>
            {linkedLeg && <StatusTag kind={linkedLeg.status} />}
          </div>
        </TableCell>
        <TableCell>{f.aircraft || 'Unknown'}</TableCell>
        <TableCell>{formatDate(f.start_time)}</TableCell>
        <TableCell>{formatDuration(f.duration_sec)}</TableCell>
        <TableCell>{formatDistance(f.distance_nm)} nm</TableCell>
        <TableCell>
          {(f.departure_icao || f.arrival_icao) ? (
            <span title={`${f.departure_name || ''} → ${f.arrival_name || ''}`}>
              {f.departure_icao || '???'} → {f.arrival_icao || '???'}
            </span>
          ) : <span className="sabia-meta">—</span>}
          {landingNote && (
            <div
              className="sabia-meta"
              style={linkedLeg?.status === 'diverted' ? { color: 'var(--cds-support-error)' } : undefined}
            >
              {landingNote}
            </div>
          )}
        </TableCell>
        <TableCell>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            <Button kind="ghost" size="sm" as={RouterLink} to={`/flight/${f.id}`} aria-label={`View ${label}`}>View</Button>
            <Button kind="ghost" size="sm" as={RouterLink} to={`/flight/${f.id}/acars`} aria-label={`ACARS for ${label}`}>ACARS</Button>
            {f.planned_leg_id != null ? (
              <Button kind="ghost" size="sm" disabled={unlinkBusy} onClick={() => onRequestUnlink(f.id)}
                aria-label={`Unlink ${label} from its planned leg`}>
                {unlinkBusy ? 'Unlinking…' : 'Unlink'}
              </Button>
            ) : showLinkToLeg ? (
              <Button kind="ghost" size="sm" disabled={pickBusy} onClick={() => flightPicker.onToggle(f.id)}
                aria-expanded={pickerOpen} aria-label={`${pickerOpen ? 'Cancel linking' : 'Link to leg'}: ${label}`}>
                {pickerOpen ? 'Cancel' : 'Link to leg'}
              </Button>
            ) : null}
          </div>
        </TableCell>
        <TableCell>
          <Button kind="danger--ghost" size="sm" onClick={() => onRequestRemoveFlight(f.id)}
            aria-label={`Remove ${label} from the trip`}>Remove</Button>
        </TableCell>
      </TableRow>
      {unlinkErrorByFlight[f.id] && (
        <TableRow><TableCell colSpan={GHOST_LEG_COLUMNS.length}>
          {errorNote('Could not unlink', unlinkErrorByFlight[f.id])}
        </TableCell></TableRow>
      )}
      {pickerOpen && (
        <TableRow>
          <TableCell colSpan={GHOST_LEG_COLUMNS.length}>
            {legs === null ? (
              flightPicker.legsError ? null : <span className="sabia-meta">Loading legs…</span>
            ) : legs.length === 0 ? (
              <span className="sabia-meta">No unlinked planned legs available.</span>
            ) : (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 auto', maxInlineSize: '40rem' }}>
                  <Select id={`link-leg-${f.id}`} labelText="Planned leg to link" size="sm" value={flightPicker.choice}
                    onChange={e => flightPicker.onChoiceChange(e.target.value === '' ? '' : Number(e.target.value))}>
                    <SelectItem value="" text="Choose a leg…" />
                    {legs.map(l => (
                      <SelectItem key={l.id} value={l.id}
                        text={`${l.trip_name ?? 'No trip'} · Leg ${l.seq}: ${l.departure_ident} → ${l.destination_ident}${
                          l.status === 'skipped' ? ' (Skipped)' : ''}`} />
                    ))}
                  </Select>
                </div>
                <Button kind="primary" size="sm" disabled={!flightPicker.choice || pickBusy}
                  onClick={() => flightPicker.onConfirm(f.id)}>{pickBusy ? 'Linking…' : 'Link'}</Button>
              </div>
            )}
            {flightPicker.legsError && errorNote('Could not load legs', flightPicker.legsError)}
            {flightPicker.errorByFlight[f.id] && errorNote('Could not link', flightPicker.errorByFlight[f.id])}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

/**
 * The trip's legs: flown flights and unflown planned legs interleaved in leg
 * order, windowed 20 to a page. Ghost rows are the shared GhostLegRow. Purely
 * presentational; every change is a request to the page.
 */
export function LegsTable(props: LegsTableProps) {
  const { flights, plannedLegs, page, onPageChange, legPicker, onMoveLeg, reorderingLegId, onRequestDeleteLeg,
    onRequestSkip, skipBusyLegId, skipErrorByLeg, legMovePicker } = props;
  const rows = interleaveTripRows(flights, plannedLegs);
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No legs in this trip yet"
        description="Import a Little Navmap or SimBrief plan above, or add flights from All flights."
      />
    );
  }

  const pageCount = Math.max(1, Math.ceil(rows.length / LEGS_PER_PAGE));
  const current = Math.min(Math.max(1, page), pageCount);
  const pageRows = rows.slice((current - 1) * LEGS_PER_PAGE, current * LEGS_PER_PAGE);
  const legById = new Map(plannedLegs.map(l => [l.id, l] as const));
  // The link-to-leg action only appears once the trip uses planned legs at all.
  const showLinkToLeg = plannedLegs.length > 0;

  return (
    <TableContainer>
      <div style={{ overflowX: 'auto' }}>
        <Table size="lg" aria-label="Trip legs" data-testid="legs-table">
          <TableHead>
            <TableRow>
              {GHOST_LEG_COLUMNS.map(c => <TableHeader key={c.key}>{c.header}</TableHeader>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {pageRows.map(row => {
              if (row.kind === 'planned') {
                const leg = row.leg;
                const idx = plannedLegs.findIndex(l => l.id === leg.id);
                return (
                  <GhostLegRow
                    key={`planned-${leg.id}`}
                    leg={leg}
                    onDelete={onRequestDeleteLeg}
                    onMove={onMoveLeg}
                    canMoveUp={idx > 0}
                    canMoveDown={idx >= 0 && idx < plannedLegs.length - 1}
                    busy={reorderingLegId !== null}
                    linkPickerOpen={legPicker.openLegId === leg.id}
                    onToggleLinkPicker={() => legPicker.onToggle(leg.id)}
                    linkBusy={legPicker.busyLegId === leg.id}
                    linkError={legPicker.errorByLeg[leg.id]}
                    linkableFlights={legPicker.flights}
                    linkFlightsError={legPicker.flightsError}
                    linkFlightChoice={legPicker.choice}
                    onLinkFlightChoiceChange={legPicker.onChoiceChange}
                    onConfirmLink={() => legPicker.onConfirm(leg.id)}
                    skipBusy={skipBusyLegId === leg.id}
                    skipError={skipErrorByLeg[leg.id]}
                    onToggleSkip={() => onRequestSkip(leg.id)}
                    movePicker={{
                      open: legMovePicker.openLegId === leg.id,
                      onToggle: () => legMovePicker.onToggle(leg.id),
                      trips: legMovePicker.trips,
                      tripsError: legMovePicker.tripsError,
                      choice: legMovePicker.choice,
                      onChoiceChange: legMovePicker.onChoiceChange,
                      onConfirm: () => legMovePicker.onConfirm(leg.id),
                      busy: legMovePicker.busyLegId === leg.id,
                      error: legMovePicker.errorByLeg[leg.id],
                    }}
                  />
                );
              }
              return (
                <FlownRow
                  key={`flight-${row.flight.id}`}
                  {...props}
                  flight={row.flight}
                  index={row.flightIndex}
                  linkedLeg={row.flight.planned_leg_id != null ? legById.get(row.flight.planned_leg_id) : undefined}
                  showLinkToLeg={showLinkToLeg}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
      {rows.length > LEGS_PER_PAGE && (
        <Pagination
          page={current}
          pageSize={LEGS_PER_PAGE}
          pageSizes={[LEGS_PER_PAGE]}
          totalItems={rows.length}
          itemsPerPageText="Legs per page"
          onChange={({ page: p }: { page: number }) => onPageChange(p)}
        />
      )}
    </TableContainer>
  );
}
