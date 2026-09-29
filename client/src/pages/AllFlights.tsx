import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button, Checkbox, DataTable, DataTableSkeleton, InlineNotification, Modal, Pagination, Select, SelectItem,
  Table, TableBatchAction, TableBatchActions, TableBody, TableCell, TableContainer, TableExpandHeader,
  TableExpandRow, TableExpandedRow, TableHead, TableHeader, TableRow, TableSelectAll, TableSelectRow,
  TableToolbar, TableToolbarContent, TableToolbarSearch, TextInput,
} from '@carbon/react';
import { Add, Export, FolderAdd, Merge } from '@carbon/icons-react';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { ConfirmModal, ModalPortal, useLauncherRef } from '../components/ConfirmModal';
import {
  addFlightToTrip, combineFlights, createTrip, listFlights, listTrips,
} from '../api';
import { UnauthorizedError, downloadFlightSetKml } from '../utils/api';
import { useLiveEvent } from '../shell/LiveEventsProvider';
import type { Flight, Trip } from '../types';
import './allflights/allflights.scss';
import { legColor } from '../components/maps/palette';
import { formatAlt, formatDate, formatDistance, formatDuration, formatSpeed } from '../utils/format';

const PAGE_SIZES = [5, 10, 20];
const COLUMN_COUNT = 9;
// Matches the server's MAX_FLIGHT_SET_IDS (src/kmlExport.ts) — the KML set
// export route rejects anything past this, so the picker is capped the same.
const MAX_KML_FLIGHTS = 100;

type Entry = { kind: 'trip'; trip: Trip; legs: Flight[] } | { kind: 'flight'; flight: Flight };
type Dialog = null | 'combine' | 'newTrip' | 'blankTrip' | 'addToTrip';

const isSelectable = (f: Flight) => f.point_count === null || f.point_count > 0;
const routeText = (f: Flight) => `${f.departure_icao || '???'} → ${f.arrival_icao || '???'}`;

function matches(f: Flight, q: string): boolean {
  const hay = [
    f.id, f.aircraft, f.departure_icao, f.arrival_icao, f.departure_name, f.arrival_name,
  ].filter(x => x != null).join(' ').toLowerCase();
  return hay.includes(q);
}

export function AllFlights() {
  const navigate = useNavigate();
  const [flights, setFlights] = useState<Flight[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [collapsedTrips, setCollapsedTrips] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exportingKml, setExportingKml] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tripName, setTripName] = useState('');
  const [pickerTripId, setPickerTripId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const launcherRef = useLauncherRef(dialog === 'newTrip' || dialog === 'blankTrip' || dialog === 'addToTrip');

  const loadFlights = useCallback(async () => {
    const [flightsResult, tripsResult] = await Promise.allSettled([listFlights(), listTrips()]);
    if (flightsResult.status === 'rejected') {
      if (flightsResult.reason instanceof UnauthorizedError) return;
      setError((flightsResult.reason as Error).message);
      return;
    }
    const newFlights = flightsResult.value;
    setFlights(newFlights);
    setTrips(tripsResult.status === 'fulfilled' ? tripsResult.value : []);
    setError(null);
    const ids = new Set(newFlights.map(f => f.id));
    setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  useEffect(() => {
    loadFlights();
    const onVisible = () => { if (!document.hidden) loadFlights(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadFlights]);

  useLiveEvent(['flights-changed', 'flight-state'], loadFlights);

  const allFlights = useMemo(() => flights ?? [], [flights]);
  const selectableCount = allFlights.filter(isSelectable).length;

  // Trips first (each with its legs), then the flights that belong to no trip.
  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const byId = new Map(allFlights.map(f => [f.id, f]));
    const inTrip = new Set(trips.flatMap(t => t.flights.map(f => f.id)));
    const out: Entry[] = [];
    for (const trip of trips) {
      const legs = trip.flights.map(f => byId.get(f.id)).filter((f): f is Flight => !!f);
      if (!q) { out.push({ kind: 'trip', trip, legs }); continue; }
      const nameHit = trip.name.toLowerCase().includes(q);
      const legHits = legs.filter(f => matches(f, q));
      if (nameHit || legHits.length) out.push({ kind: 'trip', trip, legs: nameHit ? legs : legHits });
    }
    for (const f of allFlights) {
      if (!inTrip.has(f.id) && (!q || matches(f, q))) out.push({ kind: 'flight', flight: f });
    }
    return out;
  }, [allFlights, trips, query]);

  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageEntries = entries.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const firstLooseIdx = pageEntries.findIndex(e => e.kind === 'flight');

  const n = selectedIds.size;
  const [selA, selB] = [...selectedIds];

  function toggleCheck(f: Flight, checked: boolean) {
    if (!isSelectable(f)) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(f.id); else next.delete(f.id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(allFlights.filter(isSelectable).map(f => f.id)) : new Set());
  }

  function toggleTrip(tripId: number) {
    setCollapsedTrips(prev => {
      const next = new Set(prev);
      if (!next.delete(tripId)) next.add(tripId);
      return next;
    });
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setActionError(`${label}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  const handleCombine = () => run('Combine failed', async () => {
    const result = await combineFlights(selA, selB);
    setSelectedIds(new Set());
    navigate(`/flight/${result.id}`);
  });

  const handleTripName = () => {
    const name = tripName.trim();
    if (!name) return;
    if (dialog === 'blankTrip') {
      return run('Failed to create trip', async () => {
        const { id } = await createTrip(name);
        navigate(`/trip/${id}`);
      });
    }
    return run('Failed to create trip', async () => {
      const { id } = await createTrip(name);
      for (const flightId of selectedIds) await addFlightToTrip(id, flightId);
      setSelectedIds(new Set());
      await loadFlights();
    });
  };

  const handleAddToTrip = () => {
    const tripId = Number(pickerTripId);
    if (!tripId) return;
    return run('Failed to add to trip', async () => {
      for (const flightId of selectedIds) await addFlightToTrip(tripId, flightId);
      setSelectedIds(new Set());
      await loadFlights();
    });
  };

  async function handleExportKml() {
    if (n === 0 || n > MAX_KML_FLIGHTS) return;
    setExportingKml(true);
    setActionError(null);
    try {
      await downloadFlightSetKml([...selectedIds]);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setActionError('Export failed: ' + (err as Error).message);
    } finally {
      setExportingKml(false);
    }
  }

  function openNewTrip(kind: 'newTrip' | 'blankTrip') {
    setTripName('');
    setDialog(kind);
  }

  function openAddToTrip() {
    if (!pickerTripId && trips[0]) setPickerTripId(trips[0].id);
    setDialog('addToTrip');
  }

  const statCells = (f: Flight) => (
    <>
      <TableCell>{formatDate(f.start_time)}</TableCell>
      <TableCell>{formatDuration(f.duration_sec)}</TableCell>
      <TableCell>{formatDistance(f.distance_nm)} nm</TableCell>
      <TableCell>{formatAlt(f.max_altitude_ft)} ft</TableCell>
      <TableCell>{formatSpeed(f.max_airspeed_kts)} kts</TableCell>
    </>
  );

  const aircraftCell = (f: Flight, color?: string) => (
    <TableCell>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {color && <span data-testid="leg-swatch" style={{ width: 10, height: 10, borderRadius: 2, background: color, flex: 'none' }} />}
        <div>
          {f.aircraft || 'Unknown'}
          {(f.departure_icao || f.arrival_icao) && (
            <div title={`${f.departure_name || ''} → ${f.arrival_name || ''}`} className="sabia-meta">
              {routeText(f)}
            </div>
          )}
        </div>
      </div>
    </TableCell>
  );

  const viewButton = (f: Flight) => (
    <TableCell>
      <Button as={Link} to={`/flight/${f.id}`} kind="tertiary" size="sm">View</Button>
    </TableCell>
  );

  const rowCheck = (f: Flight) => {
    const selectable = isSelectable(f);
    return (
      <TableSelectRow
        id={`select-flight-${f.id}`}
        name={`select-flight-${f.id}`}
        ariaLabel={selectable ? `Select flight ${f.id}` : `Flight ${f.id} has no recorded points`}
        checked={selectedIds.has(f.id) && selectable}
        disabled={!selectable}
        onSelect={e => toggleCheck(f, e.currentTarget.checked)}
      />
    );
  };

  function tripRows(entry: Extract<Entry, { kind: 'trip' }>) {
    const { trip, legs } = entry;
    const expanded = !collapsedTrips.has(trip.id);
    return [
      <TableExpandRow
        key={`trip-${trip.id}`}
        data-testid="trip-row"
        aria-label={`Toggle ${trip.name}`}
        isExpanded={expanded}
        onExpand={() => toggleTrip(trip.id)}
      >
        <TableCell className="cds--table-column-checkbox" />
        <TableCell colSpan={COLUMN_COUNT - 3}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <strong>{trip.name}</strong>
            {trip.is_active === 1 && <StatusTag kind="active-trip">Active</StatusTag>}
            <span style={{ color: 'var(--cds-text-secondary)' }}>
              {trip.flight_count} leg{trip.flight_count !== 1 ? 's' : ''} · {formatDuration(trip.total_duration_sec)} · {formatDistance(trip.total_distance_nm)} nm
            </span>
          </div>
        </TableCell>
        <TableCell>
          <Button as={Link} to={`/trip/${trip.id}`} kind="ghost" size="sm">View Trip</Button>
        </TableCell>
      </TableExpandRow>,
      expanded && (
        <TableExpandedRow key={`trip-${trip.id}-legs`} colSpan={COLUMN_COUNT}>
          {legs.length === 0 ? (
            <p style={{ color: 'var(--cds-text-secondary)' }}>No flights in this trip.</p>
          ) : (
            <Table size="sm" className="allflights-legs" aria-label={`${trip.name} legs`}>
              <colgroup>
                <col style={{ width: '3.5rem' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '20%' }} />
                <col />
                <col />
                <col />
                <col />
                <col style={{ width: '9.5rem' }} />
              </colgroup>
              <TableHead>
                <TableRow>
                  <TableHeader />
                  <TableHeader>Aircraft</TableHeader>
                  <TableHeader>Date</TableHeader>
                  <TableHeader>Duration</TableHeader>
                  <TableHeader>Distance</TableHeader>
                  <TableHeader>Max Alt</TableHeader>
                  <TableHeader>Max Speed</TableHeader>
                  <TableHeader />
                </TableRow>
              </TableHead>
              <TableBody>
                {legs.map(f => {
                  const selectable = isSelectable(f);
                  return (
                    <TableRow key={f.id} data-testid="leg-row" data-id={f.id}>
                      <TableCell>
                        <Checkbox
                          id={`select-flight-${f.id}`}
                          labelText={`Select flight ${f.id}`}
                          hideLabel
                          checked={selectedIds.has(f.id) && selectable}
                          disabled={!selectable}
                          title={selectable ? undefined : 'No recorded points'}
                          onChange={(_, { checked }) => toggleCheck(f, checked)}
                        />
                      </TableCell>
                      {aircraftCell(f, legColor(trip.flights.findIndex(x => x.id === f.id)))}
                      {statCells(f)}
                      {viewButton(f)}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </TableExpandedRow>
      ),
    ];
  }

  let body;
  if (flights === null && !error) {
    body = <DataTableSkeleton columnCount={COLUMN_COUNT} rowCount={6} showToolbar={false} showHeader={false} />;
  } else if (flights !== null && flights.length === 0) {
    // Once a load has succeeded with no flights, keep showing this empty
    // state even if a later background poll fails — a poll failure loses the
    // fresh data, not the fact that the log is empty, and dropping to the
    // raw table below would render a blank body with no explanation.
    body = <EmptyState title="No flights recorded yet." description="Start MSFS 2024 and take off to begin logging." />;
  } else {
    const headers = [
      { key: 'aircraft', header: 'Aircraft' }, { key: 'date', header: 'Date' },
      { key: 'duration', header: 'Duration' }, { key: 'distance', header: 'Distance' },
      { key: 'alt', header: 'Max Alt' }, { key: 'speed', header: 'Max Speed' },
    ];
    body = (
      <DataTable rows={[]} headers={headers} isSortable={false}>
        {({ getTableProps, getTableContainerProps }: {
          getTableProps: () => object; getTableContainerProps: () => object;
        }) => (
          <TableContainer {...getTableContainerProps()}>
            <TableToolbar aria-label="Flight log toolbar">
              {n > 0 && <TableBatchActions
                shouldShowBatchActions={n > 0}
                totalSelected={n}
                onCancel={() => setSelectedIds(new Set())}
                translateWithId={(id: string, state?: { totalSelected?: number }) =>
                  id === 'carbon.table.batch.cancel' ? 'Cancel'
                    : id === 'carbon.table.batch.selectAll' ? 'Select all'
                    : n === 1 ? '1 flight selected'
                    : n === 2 ? `Flights #${selA} and #${selB} selected`
                    : `${state?.totalSelected ?? n} flights selected`}
              >
                <TableBatchAction renderIcon={FolderAdd} onClick={() => openNewTrip('newTrip')}>New Trip</TableBatchAction>
                {trips.length > 0 && (
                  <TableBatchAction renderIcon={Add} onClick={openAddToTrip}>Add to Trip</TableBatchAction>
                )}
                <TableBatchAction renderIcon={Merge} disabled={n !== 2} onClick={() => setDialog('combine')}>
                  Combine Selected
                </TableBatchAction>
                <TableBatchAction
                  renderIcon={Export}
                  disabled={exportingKml || n > MAX_KML_FLIGHTS}
                  title={n > MAX_KML_FLIGHTS ? `Select at most ${MAX_KML_FLIGHTS} flights to export.` : undefined}
                  onClick={handleExportKml}
                >
                  {exportingKml ? 'Exporting KML…' : n > MAX_KML_FLIGHTS ? `Too many selected (max ${MAX_KML_FLIGHTS})` : 'Export KML'}
                </TableBatchAction>
              </TableBatchActions>}
              <TableToolbarContent aria-hidden={n > 0} className="allflights-toolbar">
                <TableToolbarSearch
                  persistent
                  placeholder="Search flights"
                  labelText="Search flights"
                  onChange={(e: { target?: { value?: string } } | string) => {
                    setQuery(typeof e === 'string' ? e : e?.target?.value ?? '');
                    setPage(1);
                  }}
                />
                <Button kind="primary" size="md" renderIcon={Add} onClick={() => openNewTrip('blankTrip')}>New Trip</Button>
              </TableToolbarContent>
            </TableToolbar>
            <div className="allflights-scroll">
            <Table {...getTableProps()} aria-label="Flight log">
              <TableHead>
                <TableRow>
                  <TableExpandHeader />
                  <TableSelectAll
                    id="select-all-flights"
                    name="select-all-flights"
                    ariaLabel="Select all completed flights"
                    checked={n > 0 && n === selectableCount}
                    indeterminate={n > 0 && n < selectableCount}
                    onSelect={() => toggleSelectAll(n < selectableCount)}
                  />
                  {headers.map(h => <TableHeader key={h.key}>{h.header}</TableHeader>)}
                  <TableHeader />
                </TableRow>
              </TableHead>
              <TableBody>
                {pageEntries.length === 0 && flights !== null && (
                  <TableRow>
                    <TableCell colSpan={COLUMN_COUNT + 1} style={{ textAlign: 'center', padding: '2rem' }}>
                      No flights match “{query.trim()}”.
                    </TableCell>
                  </TableRow>
                )}
                {pageEntries.flatMap((entry, i) => {
                  if (entry.kind === 'trip') return tripRows(entry);
                  const f = entry.flight;
                  const rows = [];
                  if (i === firstLooseIdx && trips.length > 0) {
                    rows.push(
                      <TableRow key="ungrouped" data-testid="ungrouped-row">
                        <TableCell colSpan={COLUMN_COUNT + 1} style={{ color: 'var(--cds-text-secondary)', fontWeight: 600 }}>
                          Ungrouped Flights
                        </TableCell>
                      </TableRow>,
                    );
                  }
                  rows.push(
                    <TableRow key={f.id} data-testid="flight-row" data-id={f.id}>
                      <TableCell className="cds--table-expand" />
                      {rowCheck(f)}
                      {aircraftCell(f)}
                      {statCells(f)}
                      {viewButton(f)}
                    </TableRow>,
                  );
                  return rows;
                })}
              </TableBody>
            </Table>
            </div>
            <Pagination
              page={currentPage}
              pageSize={pageSize}
              pageSizes={PAGE_SIZES}
              totalItems={entries.length}
              itemsPerPageText="Rows per page"
              onChange={({ page: p, pageSize: s }: { page: number; pageSize: number }) => {
                setPage(p);
                setPageSize(s);
              }}
            />
          </TableContainer>
        )}
      </DataTable>
    );
  }

  return (
    <>
      <PageHeader title="Flight Log" />
      {error && (
        <InlineNotification
          kind="error" lowContrast hideCloseButton title="Could not load flights" subtitle={error}
        />
      )}
      {actionError && (
        <InlineNotification
          kind="error" lowContrast title="Action failed" subtitle={actionError} onCloseButtonClick={() => setActionError(null)}
        />
      )}
      {body}

      <ConfirmModal
        open={dialog === 'combine'}
        title="Combine flights"
        message={`Combine flights #${selA} and #${selB} into one? Both originals will be deleted.`}
        confirmLabel="Combine"
        onConfirm={handleCombine}
        onCancel={() => setDialog(null)}
      />
      <ModalPortal>
      <Modal
        open={dialog === 'newTrip' || dialog === 'blankTrip'}
        size="xs"
        selectorPrimaryFocus="#new-trip-name"
        launcherButtonRef={launcherRef}
        modalHeading="New trip"
        primaryButtonText="Create"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={busy || !tripName.trim()}
        onRequestSubmit={handleTripName}
        onRequestClose={() => setDialog(null)}
      >
        <TextInput
          id="new-trip-name"
          labelText="Trip name"
          value={tripName}
          onChange={e => setTripName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleTripName(); }}
        />
      </Modal>
      </ModalPortal>
      <ModalPortal>
      <Modal
        open={dialog === 'addToTrip'}
        size="xs"
        selectorPrimaryFocus="#add-to-trip-select"
        launcherButtonRef={launcherRef}
        modalHeading="Add to trip"
        primaryButtonText="Add"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={busy || !pickerTripId}
        onRequestSubmit={handleAddToTrip}
        onRequestClose={() => setDialog(null)}
      >
        <Select
          id="add-to-trip-select"
          labelText="Trip"
          value={pickerTripId}
          onChange={e => setPickerTripId(Number(e.target.value))}
        >
          {trips.map(t => <SelectItem key={t.id} value={t.id} text={t.name} />)}
        </Select>
      </Modal>
      </ModalPortal>
    </>
  );
}
