import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Dropdown, InlineNotification, Link, SkeletonText, Table, TableBody, TableCell, TableContainer, TableHead,
  TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch, Tile,
} from '@carbon/react';
import { ConfirmModal } from '../components/ConfirmModal';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { GHOST_LEG_COLUMNS, GhostLegRow, LnmplnImportPanel, SimbriefImportPanel, SkipLegConfirm } from '../components/legs';
import type { MoveTargetChoice } from '../components/legs';
import * as api from '../api';
import { UnauthorizedError } from '../utils/api';
import type {
  Flight, PlannedLegImportResponse, PlannedLegListItem, PlannedLegStatus, SimbriefImportResult, Trip,
} from '../types';

interface Option { id: string; label: string }

const STATUS_OPTIONS: Option[] = [
  { id: 'all', label: 'All statuses' },
  { id: 'planned', label: 'Planned' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'flown', label: 'Flown' },
  { id: 'diverted', label: 'Diverted' },
];

/** Every planned leg, loose or attached to a trip, with the two import panels. */
export function Prefiles() {
  const [legs, setLegs] = useState<PlannedLegListItem[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResponse, setImportResponse] = useState<PlannedLegImportResponse | null>(null);

  const [simbriefId, setSimbriefId] = useState<string | null | undefined>(undefined);
  const [simbriefImporting, setSimbriefImporting] = useState(false);
  const [simbriefError, setSimbriefError] = useState('');
  const [simbriefResult, setSimbriefResult] = useState<SimbriefImportResult | null>(null);

  const [skipTarget, setSkipTarget] = useState<PlannedLegListItem | null>(null);
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PlannedLegListItem | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const [linkingLegId, setLinkingLegId] = useState<number | null>(null);
  const [linkFlightChoice, setLinkFlightChoice] = useState<number | ''>('');
  const [linkableFlights, setLinkableFlights] = useState<Flight[] | null>(null);
  const [linkFlightsError, setLinkFlightsError] = useState('');
  const [linkBusyLegId, setLinkBusyLegId] = useState<number | null>(null);
  const [linkErrorByLeg, setLinkErrorByLeg] = useState<Record<number, string>>({});

  const [importTrips, setImportTrips] = useState<Trip[] | null>(null);
  const [importTripsError, setImportTripsError] = useState('');
  const [importTarget, setImportTarget] = useState('none');

  const [movingLegId, setMovingLegId] = useState<number | null>(null);
  const [moveChoice, setMoveChoice] = useState<MoveTargetChoice>('');
  const [moveBusyLegId, setMoveBusyLegId] = useState<number | null>(null);
  const [moveErrorByLeg, setMoveErrorByLeg] = useState<Record<number, string>>({});

  const [statusFilter, setStatusFilter] = useState('all');
  const [tripFilter, setTripFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const loadLegs = useCallback(async () => {
    try {
      setLegs(await api.listPlannedLegs());
      setLoadError('');
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadLegs();
    api.getSimbriefSettings()
      .then(s => setSimbriefId(s.simbrief_user_id))
      .catch(() => setSimbriefId(null));
    // A failed load leaves the import-target picker offering "No trip" only,
    // with no banner — import still works. The move-to-trip picker shares
    // this same list, though, and there the failure is worth surfacing: it's
    // the only way to explain an empty choice of trips once the picker opens.
    api.listTrips()
      .then(setImportTrips)
      .catch(err => {
        setImportTrips([]);
        setImportTripsError((err as Error).message);
      });
  }, [loadLegs]);

  async function handleFiles(files: File[]) {
    setImporting(true);
    setImportError('');
    setImportResponse(null);
    const tripId = importTarget === 'none' ? undefined : Number(importTarget);
    try {
      setImportResponse(await api.importPlannedLegs(files, tripId));
      await loadLegs();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setImportError('Import failed: ' + (err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function handleImportSimbrief() {
    setSimbriefImporting(true);
    setSimbriefError('');
    setSimbriefResult(null);
    const tripId = importTarget === 'none' ? undefined : Number(importTarget);
    try {
      const response = await api.importSimbriefLeg(tripId);
      setSimbriefResult(response.result);
      if (response.result.status === 'imported') await loadLegs();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSimbriefError((err as Error).message);
    } finally {
      setSimbriefImporting(false);
    }
  }

  async function handleMoveToTrip(leg: PlannedLegListItem) {
    if (moveChoice === '') return;
    setMoveErrorByLeg(prev => { const { [leg.id]: _drop, ...rest } = prev; return rest; });
    setMoveBusyLegId(leg.id);
    try {
      await api.movePlannedLeg(leg.id, moveChoice === 'loose' ? null : moveChoice);
      setMovingLegId(null);
      setMoveChoice('');
      await loadLegs();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setMoveErrorByLeg(prev => ({ ...prev, [leg.id]: (err as Error).message }));
    } finally {
      setMoveBusyLegId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deletePlannedLeg(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteError('');
      await loadLegs();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setDeleteError('Failed to delete planned leg: ' + (err as Error).message);
    }
  }

  async function confirmSkip() {
    if (!skipTarget) return;
    const next = skipTarget.status === 'skipped' ? 'planned' : 'skipped';
    setSkipBusy(true);
    setSkipError('');
    try {
      await api.setPlannedLegStatus(skipTarget.id, next);
      setSkipTarget(null);
      await loadLegs();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      // A 409 means a flight is linked to the leg; the server's message is
      // shown inside the confirm dialog instead of failing silently.
      setSkipError((err as Error).message);
    } finally {
      setSkipBusy(false);
    }
  }

  async function loadLinkableFlights() {
    setLinkFlightsError('');
    try {
      setLinkableFlights((await api.listFlights()).filter(f => f.planned_leg_id === null));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setLinkFlightsError((err as Error).message);
    }
  }

  async function handleLink(leg: PlannedLegListItem) {
    if (!linkFlightChoice) return;
    setLinkErrorByLeg(prev => { const { [leg.id]: _drop, ...rest } = prev; return rest; });
    setLinkBusyLegId(leg.id);
    try {
      await api.linkFlightToLeg(linkFlightChoice, leg.id);
      setLinkableFlights(null);
      setLinkingLegId(null);
      setLinkFlightChoice('');
      await loadLegs();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setLinkErrorByLeg(prev => ({ ...prev, [leg.id]: (err as Error).message }));
    } finally {
      setLinkBusyLegId(null);
    }
  }

  const importTripOptions = useMemo<Option[]>(() => [
    { id: 'none', label: 'No trip' },
    ...(importTrips ?? []).map(t => ({ id: String(t.id), label: t.name })),
  ], [importTrips]);

  const tripOptions = useMemo<Option[]>(() => {
    const byId = new Map<number, string>();
    for (const leg of legs ?? []) {
      if (leg.trip_id !== null) byId.set(leg.trip_id, leg.trip_name ?? `Trip #${leg.trip_id}`);
    }
    const trips = Array.from(byId.entries()).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ id: String(id), label: name }));
    return [{ id: 'all', label: 'All trips' }, { id: 'none', label: 'No trip' }, ...trips];
  }, [legs]);

  const filteredLegs = useMemo(() => {
    if (!legs) return null;
    const query = searchQuery.trim().toLowerCase();
    return legs.filter(leg => {
      if (statusFilter !== 'all' && leg.status !== (statusFilter as PlannedLegStatus)) return false;
      if (tripFilter === 'none' && leg.trip_id !== null) return false;
      if (tripFilter !== 'all' && tripFilter !== 'none' && String(leg.trip_id) !== tripFilter) return false;
      if (query) {
        const haystack = [leg.departure_ident, leg.destination_ident, leg.aircraft_type ?? ''].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [legs, statusFilter, tripFilter, searchQuery]);

  const skipDialogLeg = skipTarget;

  return (
    <>
      <PageHeader title="Prefiles" subtitle="Every planned leg, loose or attached to a trip." />

      <div style={{ inlineSize: '14rem', marginBottom: '1rem' }}>
        <Dropdown id="prefiles-import-trip" titleText="Import into" label="No trip" size="sm"
          items={importTripOptions} itemToString={(i: Option | null) => i?.label ?? ''}
          selectedItem={importTripOptions.find(o => o.id === importTarget) ?? importTripOptions[0]}
          onChange={({ selectedItem }: { selectedItem: Option | null }) => setImportTarget(selectedItem?.id ?? 'none')} />
      </div>

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', marginBottom: '2rem' }}>
        <Tile>
          <LnmplnImportPanel
            onFiles={handleFiles}
            importing={importing}
            error={importError}
            results={importResponse?.results ?? null}
            batch={importResponse?.batch}
          />
        </Tile>
        <Tile>
          <SimbriefImportPanel
            userId={simbriefId}
            importing={simbriefImporting}
            onImport={handleImportSimbrief}
            error={simbriefError}
            result={simbriefResult}
          />
        </Tile>
      </div>

            {loadError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Failed to load planned legs"
          subtitle={loadError} style={{ maxInlineSize: 'none' }} />
      )}
      {legs === null && !loadError && <SkeletonText paragraph lineCount={6} />}
      {legs !== null && legs.length === 0 && (
        <EmptyState title="No planned legs yet."
          description="Import a .lnmpln file or a SimBrief plan above to prefile one." />
      )}
      {legs !== null && legs.length > 0 && (
        <TableContainer title="Planned legs" description="Filter by status, trip, departure, destination or aircraft.">
          <TableToolbar aria-label="Planned leg filters" style={{ blockSize: 'auto', overflow: 'visible' }}>
            <TableToolbarContent style={{ gap: '1rem', alignItems: 'flex-end', justifyContent: 'flex-start', flexWrap: 'wrap', paddingInline: '1rem', paddingBlock: '0.5rem', blockSize: 'auto' }}>
              <div style={{ inlineSize: '12rem' }}>
                <Dropdown id="prefiles-status-filter" titleText="Status" label="All statuses" size="sm"
                  items={STATUS_OPTIONS} itemToString={(i: Option | null) => i?.label ?? ''}
                  selectedItem={STATUS_OPTIONS.find(o => o.id === statusFilter) ?? STATUS_OPTIONS[0]}
                  onChange={({ selectedItem }: { selectedItem: Option | null }) => setStatusFilter(selectedItem?.id ?? 'all')} />
              </div>
              <div style={{ inlineSize: '14rem' }}>
                <Dropdown id="prefiles-trip-filter" titleText="Trip" label="All trips" size="sm"
                  items={tripOptions} itemToString={(i: Option | null) => i?.label ?? ''}
                  selectedItem={tripOptions.find(o => o.id === tripFilter) ?? tripOptions[0]}
                  onChange={({ selectedItem }: { selectedItem: Option | null }) => setTripFilter(selectedItem?.id ?? 'all')} />
              </div>
              <TableToolbarSearch id="prefiles-search" persistent placeholder="Departure, destination, aircraft…"
                value={searchQuery} onChange={(e: React.ChangeEvent<HTMLInputElement> | '') =>
                  setSearchQuery(typeof e === 'string' ? e : e.target.value)} />
            </TableToolbarContent>
          </TableToolbar>
          {filteredLegs !== null && filteredLegs.length === 0 ? (
            <EmptyState title="No planned legs match these filters." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <Table size="lg" aria-label="Planned legs" data-testid="legs-table">
                <TableHead>
                  <TableRow>
                    {GHOST_LEG_COLUMNS.map(c => <TableHeader key={c.key}>{c.header}</TableHeader>)}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(filteredLegs ?? []).map(leg => {
                    const pickerOpen = linkingLegId === leg.id;
                    return (
                      <Fragment key={leg.id}>
                        <TableRow>
                          <TableCell colSpan={GHOST_LEG_COLUMNS.length} style={{ fontWeight: 600 }}>
                            {leg.trip_id !== null && leg.trip_name ? (
                              <Link as={RouterLink} to={`/trip/${leg.trip_id}`}>{leg.trip_name}</Link>
                            ) : 'No trip'}
                          </TableCell>
                        </TableRow>
                        <GhostLegRow
                          leg={leg}
                          colSpan={GHOST_LEG_COLUMNS.length}
                          onDelete={() => { setDeleteError(''); setDeleteTarget(leg); }}
                          linkPickerOpen={pickerOpen}
                          onToggleLinkPicker={() => {
                            const opening = !pickerOpen;
                            setLinkingLegId(opening ? leg.id : null);
                            setLinkFlightChoice('');
                            if (opening) { setLinkableFlights(null); void loadLinkableFlights(); }
                          }}
                          linkBusy={linkBusyLegId === leg.id}
                          linkError={linkErrorByLeg[leg.id]}
                          linkableFlights={linkableFlights}
                          linkFlightsError={linkFlightsError}
                          linkFlightChoice={linkFlightChoice}
                          onLinkFlightChoiceChange={setLinkFlightChoice}
                          onConfirmLink={() => handleLink(leg)}
                          onToggleSkip={() => { setSkipError(''); setSkipTarget(leg); }}
                          movePicker={{
                            open: movingLegId === leg.id,
                            onToggle: () => {
                              const opening = movingLegId !== leg.id;
                              setMovingLegId(opening ? leg.id : null);
                              setMoveChoice('');
                              setMoveErrorByLeg(prev => { const { [leg.id]: _drop, ...rest } = prev; return rest; });
                            },
                            trips: importTrips,
                            tripsError: importTripsError,
                            choice: moveChoice,
                            onChoiceChange: setMoveChoice,
                            onConfirm: () => handleMoveToTrip(leg),
                            busy: moveBusyLegId === leg.id,
                            error: moveErrorByLeg[leg.id],
                          }}
                        />
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TableContainer>
      )}

      <SkipLegConfirm leg={skipDialogLeg} busy={skipBusy} error={skipError}
        onConfirm={confirmSkip} onCancel={() => { setSkipTarget(null); setSkipError(''); }} />
      <ConfirmModal open={deleteTarget !== null} danger title="Delete planned leg"
        message={deleteError || (deleteTarget
          ? `Delete ${deleteTarget.departure_ident} → ${deleteTarget.destination_ident}? This cannot be undone.`
          : '')}
        confirmLabel="Delete" onConfirm={confirmDelete} onCancel={() => { setDeleteTarget(null); setDeleteError(''); }} />
    </>
  );
}
