import { Link as RouterLink } from 'react-router-dom';
import { Button, InlineNotification, Select, SelectItem, TableCell, TableRow } from '@carbon/react';
import type { Flight, PlannedLegWithChildren, Trip } from '../../types';
import { StatusTag } from '../StatusTag';
import { formatAlt, formatDate, formatDistance } from '../../utils/format';
import { plannedLegLandingNote } from './landingNote';
import { isPlannedLegMovable, type MoveTargetChoice } from './movable';

/**
 * The eight columns a table hosting GhostLegRow must declare, in order: the
 * same headers the flown-legs table uses. The last two are the action cells
 * (move/link/ACARS, then skip/delete) and carry no visible header.
 */
export const GHOST_LEG_COLUMNS = [
  { key: 'leg', header: 'Leg' },
  { key: 'aircraft', header: 'Aircraft' },
  { key: 'date', header: 'Date' },
  { key: 'duration', header: 'Duration' },
  { key: 'distance', header: 'Distance' },
  { key: 'route', header: 'Route' },
  { key: 'actions', header: '' },
  { key: 'status-actions', header: '' },
] as const;

/**
 * Props for {@link GhostLegRow}. Fully controlled: the consuming page owns the
 * picker's open flag, the fetched candidate list and every busy/error flag.
 */
export interface GhostLegRowProps {
  leg: PlannedLegWithChildren;
  /** Number of table columns, for the full-width error/picker sub-rows. Default 8 (see GHOST_LEG_COLUMNS). */
  colSpan?: number;
  /** Disables reorder while a reorder request is in flight. */
  busy?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Reorder arrows are hidden entirely when this is omitted (e.g. on Prefiles). */
  onMove?: (legId: number, direction: 'up' | 'down') => void;
  /** Asks the page to confirm; the row itself never deletes. */
  onDelete: (legId: number) => void;

  /** Link-a-flight picker. `linkableFlights === null` means still loading. */
  linkPickerOpen: boolean;
  onToggleLinkPicker: () => void;
  linkBusy?: boolean;
  linkError?: string;
  /** Only flights that are not already linked to a leg. */
  linkableFlights: Flight[] | null;
  linkFlightsError?: string;
  linkFlightChoice: number | '';
  onLinkFlightChoiceChange: (flightId: number | '') => void;
  onConfirmLink: () => void;

  /** Skip / unskip: this only requests it; open a {@link SkipLegConfirm}. */
  skipBusy?: boolean;
  /** Inline error (e.g. the 409 from the server) shown under the row. */
  skipError?: string;
  onToggleSkip: () => void;

  /**
   * "Move to trip" picker. Omitted entirely on a page that doesn't offer it;
   * when given, the button itself only shows for a leg {@link isPlannedLegMovable}.
   */
  movePicker?: GhostLegMovePicker;
}

/** Controlled state for a {@link GhostLegRow}'s "Move to trip" picker. */
export interface GhostLegMovePicker {
  open: boolean;
  onToggle: () => void;
  /** Every trip (`listTrips()`); null while loading. The row excludes `leg.trip_id` itself. */
  trips: Trip[] | null;
  tripsError?: string;
  choice: MoveTargetChoice;
  onChoiceChange: (choice: MoveTargetChoice) => void;
  onConfirm: () => void;
  busy?: boolean;
  /** The server's 4xx message; rendered as its own row whenever set, open or not. */
  error?: string;
}

/**
 * One planned leg as a dimmed "ghost" row (8 cells) of a Carbon table. Must be rendered
 * inside a `TableBody`; returns the row plus optional full-width error and
 * picker rows. A snippet's idents are shown as parsed, with a Snippet tag so
 * they are never mistaken for airport codes.
 */
export function GhostLegRow({
  leg, colSpan = 8, busy = false, canMoveUp = true, canMoveDown = true, onMove, onDelete,
  linkPickerOpen, onToggleLinkPicker, linkBusy = false, linkError, linkableFlights, linkFlightsError,
  linkFlightChoice, onLinkFlightChoiceChange, onConfirmLink,
  skipBusy = false, skipError, onToggleSkip, movePicker,
}: GhostLegRowProps) {
  const routeTitle = `${leg.departure_name || leg.departure_ident} → ${leg.destination_name || leg.destination_ident}`;
  const landingNote = plannedLegLandingNote(leg);
  const dim = { opacity: 0.8 } as const;
  const meta = { color: 'var(--cds-text-secondary)', fontSize: '0.75rem' } as const;

  return (
    <>
      <TableRow style={dim}>
        <TableCell>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            <StatusTag kind={leg.status} />
            {leg.is_snippet === 1 && <StatusTag kind="snippet" />}
          </div>
        </TableCell>
        <TableCell>{leg.aircraft_type || 'Unknown'}</TableCell>
        <TableCell>—</TableCell>
        <TableCell>—</TableCell>
        <TableCell>approx. {formatDistance(leg.approx_distance_nm)} nm</TableCell>
        <TableCell>
          <span title={routeTitle}>{leg.departure_ident} → {leg.destination_ident}</span>
          <div style={meta}>
            {formatAlt(leg.cruise_alt_ft)} ft cruise · {leg.waypoint_count} wpt{leg.waypoint_count !== 1 ? 's' : ''}
          </div>
          {landingNote && <div style={meta}>{landingNote}</div>}
        </TableCell>
        <TableCell>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            {onMove && (
              <>
                <Button kind="ghost" size="sm" disabled={busy || !canMoveUp}
                  onClick={() => onMove(leg.id, 'up')} aria-label="Move earlier">↑</Button>
                <Button kind="ghost" size="sm" disabled={busy || !canMoveDown}
                  onClick={() => onMove(leg.id, 'down')} aria-label="Move later">↓</Button>
              </>
            )}
            <Button kind="ghost" size="sm" disabled={linkBusy} onClick={onToggleLinkPicker}>
              {linkPickerOpen ? 'Cancel' : 'Link flight'}
            </Button>
            {movePicker && isPlannedLegMovable(leg) && (
              <Button kind="ghost" size="sm" disabled={movePicker.busy} onClick={movePicker.onToggle}>
                {movePicker.open ? 'Cancel' : 'Move to trip'}
              </Button>
            )}
            <Button kind="ghost" size="sm" as={RouterLink} to={`/planned-leg/${leg.id}/acars`}>ACARS</Button>
          </div>
        </TableCell>
        <TableCell>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            <Button kind="tertiary" size="sm" disabled={skipBusy} onClick={onToggleSkip}>
              {skipBusy ? 'Working…' : (leg.status === 'skipped' ? 'Unskip' : 'Skip')}
            </Button>
            <Button kind="danger--ghost" size="sm" onClick={() => onDelete(leg.id)}>Delete</Button>
          </div>
        </TableCell>
      </TableRow>
      {skipError && (
        <TableRow style={dim}>
          <TableCell colSpan={colSpan}>
            <InlineNotification kind="error" lowContrast hideCloseButton title="Could not change status"
              subtitle={skipError} style={{ maxInlineSize: 'none' }} />
          </TableCell>
        </TableRow>
      )}
      {linkPickerOpen && (
        <TableRow style={dim}>
          <TableCell colSpan={colSpan}>
            {linkableFlights === null ? (
              <span style={meta}>Loading flights…</span>
            ) : linkableFlights.length === 0 ? (
              <span style={meta}>No unlinked flights available.</span>
            ) : (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 auto', maxInlineSize: '40rem' }}>
                  <Select id={`link-flight-${leg.id}`} labelText="Flight to link" size="sm"
                    value={linkFlightChoice}
                    onChange={e => onLinkFlightChoiceChange(e.target.value === '' ? '' : Number(e.target.value))}>
                    <SelectItem value="" text="Choose a flight…" />
                    {linkableFlights.map(lf => (
                      <SelectItem key={lf.id} value={lf.id}
                        text={`#${lf.id} · ${lf.aircraft || 'Unknown'} · ${formatDate(lf.start_time)}${
                          (lf.departure_icao || lf.arrival_icao)
                            ? ` · ${lf.departure_icao || '???'} → ${lf.arrival_icao || '???'}` : ''}`} />
                    ))}
                  </Select>
                </div>
                <Button kind="primary" size="sm" disabled={!linkFlightChoice || linkBusy} onClick={onConfirmLink}>
                  {linkBusy ? 'Linking…' : 'Link'}
                </Button>
              </div>
            )}
            {linkFlightsError && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load flights"
                subtitle={linkFlightsError} style={{ maxInlineSize: 'none' }} />
            )}
            {linkError && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Could not link"
                subtitle={linkError} style={{ maxInlineSize: 'none' }} />
            )}
          </TableCell>
        </TableRow>
      )}
      {movePicker?.open && (
        <TableRow style={dim}>
          <TableCell colSpan={colSpan}>
            {movePicker.trips === null ? (
              <span style={meta}>Loading trips…</span>
            ) : (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 auto', maxInlineSize: '40rem' }}>
                  <Select id={`move-leg-${leg.id}`} labelText="Move to" size="sm"
                    value={movePicker.choice}
                    onChange={e => movePicker.onChoiceChange(
                      e.target.value === '' ? '' : e.target.value === 'loose' ? 'loose' : Number(e.target.value),
                    )}>
                    <SelectItem value="" text="Choose a trip…" />
                    {leg.trip_id !== null && <SelectItem value="loose" text="No trip" />}
                    {movePicker.trips.filter(t => t.id !== leg.trip_id).map(t => (
                      <SelectItem key={t.id} value={t.id} text={t.name} />
                    ))}
                  </Select>
                </div>
                <Button kind="primary" size="sm" disabled={movePicker.choice === '' || movePicker.busy}
                  onClick={movePicker.onConfirm}>
                  {movePicker.busy ? 'Moving…' : 'Move'}
                </Button>
              </div>
            )}
            {movePicker.tripsError && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load trips"
                subtitle={movePicker.tripsError} style={{ maxInlineSize: 'none' }} />
            )}
          </TableCell>
        </TableRow>
      )}
      {movePicker?.error && (
        <TableRow style={dim}>
          <TableCell colSpan={colSpan}>
            <InlineNotification kind="error" lowContrast hideCloseButton title="Could not move"
              subtitle={movePicker.error} style={{ maxInlineSize: 'none' }} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
