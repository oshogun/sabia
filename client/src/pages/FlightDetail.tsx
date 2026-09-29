import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Button, Checkbox, InlineLoading, InlineNotification, Link,
  Tab, TabList, TabPanel, TabPanels, Tabs, Tile,
} from '@carbon/react';
import { ConfirmModal } from '../components/ConfirmModal';
import { PageHeader } from '../components/PageHeader';
import { StatTiles } from '../components/StatTiles';
import { AltitudeChart } from '../components/charts';
import { FlightMap, NavdataOverlay, RouteGeometryOverlay } from '../components/maps';
import { ReplayPanel } from '../components/replay';
import {
  attachFlightPlan, deleteFlight, getFlight, getPlannedLeg, linkFlightToLeg, listTrips, patchFlight,
  removeFlightPlan, setFlightPlannedLegStatus,
} from '../api';
import type { Flight, PlannedLegWithChildren } from '../types';
import { downloadKml, downloadPdf, UnauthorizedError } from '../utils/api';
import { formatAlt, formatDate, formatDistance, formatDuration, formatSpeed } from '../utils/format';
import { EditFlightModal } from './flightdetail/EditFlightModal';
import { FlightPlanSection } from './flightdetail/FlightPlanSection';
import { PlannedLegSection } from './flightdetail/PlannedLegSection';
import { newReplayBridge, ReplayMarker, TrackOnTop } from './flightdetail/ReplayMarker';

type View = 'track' | 'replay';
const VIEW_LABEL: Record<View, string> = { track: 'Track', replay: 'Replay' };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const coordStr = (lat: number | null, lon: number | null) =>
  lat == null || lon == null ? '—' : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;

type Confirm = null | 'delete' | 'unlink' | 'removePlan';

export function FlightDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [flight, setFlight] = useState<Flight | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingKml, setExportingKml] = useState(false);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [includePlan, setIncludePlan] = useState(true);

  const [plannedLeg, setPlannedLeg] = useState<PlannedLegWithChildren | null>(null);
  const [plannedTripName, setPlannedTripName] = useState<string | null>(null);
  const [plannedLegLoading, setPlannedLegLoading] = useState(false);
  const [plannedLegError, setPlannedLegError] = useState('');
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');
  const [markBusy, setMarkBusy] = useState(false);
  const [markError, setMarkError] = useState('');

  const bridge = useRef(newReplayBridge()).current;

  useEffect(() => {
    setFlight(null);
    setLoadError(null);
    let cancelled = false;
    getFlight(id)
      .then(f => {
        if (cancelled) return;
        setFlight(f);
        document.title = `Flight #${f.id} — Sabiá`;
      })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) return;
        setLoadError(errMsg(err));
      });
    return () => { cancelled = true; };
  }, [id]);

  // Follows the link: fetched when the flight is loaded and again after Unlink,
  // so the section disappears without a reload. The trip's name is not on the
  // leg, so the trip list supplies it.
  const legId = flight?.planned_leg_id ?? null;
  useEffect(() => {
    if (legId == null) {
      setPlannedLeg(null);
      setPlannedTripName(null);
      setPlannedLegError('');
      return;
    }
    let cancelled = false;
    setPlannedLegLoading(true);
    setPlannedLegError('');
    Promise.all([getPlannedLeg(legId), listTrips()])
      .then(([leg, trips]) => {
        if (cancelled) return;
        setPlannedLeg(leg);
        setPlannedTripName(trips.find(t => t.id === leg.trip_id)?.name ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) return;
        setPlannedLegError(errMsg(err));
      })
      .finally(() => {
        if (!cancelled) setPlannedLegLoading(false);
      });
    return () => { cancelled = true; };
  }, [legId]);

  const points = flight?.points ?? [];
  const views = useMemo<View[]>(() => {
    const v: View[] = ['track'];
    if (flight?.end_time != null && points.length >= 2) v.push('replay');
    return v;
  }, [flight?.end_time, points.length]);
  const requested = search.get('view');
  const view: View = views.find(v => v === requested) ?? 'track';

  const onFollowChange = useCallback((follow: boolean) => {
    bridge.follow = follow;
    if (follow && bridge.last) bridge.sink?.(bridge.last, true);
  }, [bridge]);
  const onPosition = useCallback((s: Parameters<NonNullable<React.ComponentProps<typeof ReplayPanel>['onPosition']>>[0]) => {
    bridge.last = s;
    bridge.sink?.(s, bridge.follow);
  }, [bridge]);

  async function handleUnlink() {
    setConfirm(null);
    setUnlinkBusy(true);
    setUnlinkError('');
    try {
      setFlight(await linkFlightToLeg(id, null));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setUnlinkError(errMsg(err));
    } finally {
      setUnlinkBusy(false);
    }
  }

  async function handleMark(target: 'flown' | 'planned') {
    setMarkBusy(true);
    setMarkError('');
    try {
      setPlannedLeg(await setFlightPlannedLegStatus(id, target));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setMarkError(errMsg(err));
    } finally {
      setMarkBusy(false);
    }
  }

  async function handleSave(values: { aircraft: string | null; notes: string | null }) {
    setSaving(true);
    setSaveError('');
    try {
      setFlight(await patchFlight(id, values));
      setEditOpen(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSaveError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setConfirm(null);
    try {
      await deleteFlight(id);
      navigate('/flights');
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setActionError({ title: 'Could not delete flight', message: errMsg(err) });
    }
  }

  async function handleUpload(file: File) {
    if (file.type !== 'application/pdf') {
      setUploadError('File must be a PDF');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      setFlight(await attachFlightPlan(id, file));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setUploadError(errMsg(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleRemovePlan() {
    setConfirm(null);
    try {
      setFlight(await removeFlightPlan(id));
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setActionError({ title: 'Could not remove flight plan', message: errMsg(err) });
    }
  }

  async function handleExportPdf() {
    if (!flight) return;
    setExportingPdf(true);
    setActionError(null);
    try {
      await downloadPdf(`/api/flights/${flight.id}/export.pdf`, `flight-${flight.id}.pdf`, { includePlans: includePlan });
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setActionError({ title: 'Could not generate PDF', message: errMsg(err) });
    } finally {
      setExportingPdf(false);
    }
  }

  async function handleExportKml() {
    if (!flight) return;
    setExportingKml(true);
    setActionError(null);
    try {
      await downloadKml(`/api/flights/${flight.id}/export.kml`, `flight-${flight.id}.kml`);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setActionError({ title: 'Could not export KML', message: errMsg(err) });
    } finally {
      setExportingKml(false);
    }
  }

  const backLink = (
    <div style={{ marginBottom: '1rem' }}>
      <Link as={RouterLink} to="/flights">← All flights</Link>
    </div>
  );

  if (loadError) {
    return (
      <>
        {backLink}
        <InlineNotification kind="error" title="Could not load flight" subtitle={loadError} hideCloseButton />
      </>
    );
  }
  if (!flight) {
    return (
      <>
        {backLink}
        <InlineLoading description="Loading flight…" />
      </>
    );
  }

  const trackMap = (withReplay: boolean) => (
    <FlightMap points={points} plannedLeg={plannedLeg ?? undefined} height="28rem">
      <NavdataOverlay />
      {plannedLeg && <RouteGeometryOverlay leg={plannedLeg} />}
      <TrackOnTop points={points} />
      {withReplay && <ReplayMarker bridge={bridge} />}
    </FlightMap>
  );

  const tiles = [
    { label: 'Duration', value: formatDuration(flight.duration_sec) },
    { label: 'Distance', value: `${formatDistance(flight.distance_nm)} nm` },
    { label: 'Max altitude', value: `${formatAlt(flight.max_altitude_ft)} ft` },
    { label: 'Max airspeed', value: `${formatSpeed(flight.max_airspeed_kts)} kts` },
    { label: 'Points', value: flight.point_count ?? points.length },
    {
      label: 'Departure',
      value: flight.departure_icao || coordStr(flight.departure_lat, flight.departure_lon),
      sub: flight.departure_icao ? (flight.departure_name || coordStr(flight.departure_lat, flight.departure_lon)) : '',
    },
    {
      label: 'Arrival',
      value: flight.arrival_icao || coordStr(flight.arrival_lat, flight.arrival_lon),
      sub: flight.arrival_icao ? (flight.arrival_name || coordStr(flight.arrival_lat, flight.arrival_lon)) : '',
    },
  ];

  const panel = (v: View) => {
    if (v !== view) return null;
    if (v === 'track') return trackMap(false);
    return (
      <>
        {trackMap(true)}
        <div style={{ marginTop: '1rem' }}>
          <ReplayPanel id="replay-panel" points={points} onPosition={onPosition} onFollowChange={onFollowChange} />
        </div>
      </>
    );
  };

  return (
    <>
      {backLink}
      <PageHeader
        title={`Flight #${flight.id} — ${flight.aircraft || 'Unknown aircraft'}`}
        subtitle={`${formatDate(flight.start_time)}${flight.end_time ? ` → ${formatDate(flight.end_time)}` : ' (in progress)'}`}
      />

      <div style={{ marginBottom: '1rem' }}><StatTiles tiles={tiles} /></div>

      {flight.notes && (
        <Tile style={{ marginBottom: '1rem' }}>
          <h2 className="sabia-heading-03" style={{ marginBottom: '0.5rem' }}>Notes</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{flight.notes}</p>
        </Tile>
      )}

      {flight.planned_leg_id != null && (
        <PlannedLegSection
          flight={flight}
          leg={plannedLeg}
          tripName={plannedTripName}
          loading={plannedLegLoading}
          loadError={plannedLegError}
          unlinkBusy={unlinkBusy}
          unlinkError={unlinkError}
          markBusy={markBusy}
          markError={markError}
          onMark={handleMark}
          onUnlink={() => setConfirm('unlink')}
        />
      )}

      <FlightPlanSection
        flight={flight}
        uploading={uploading}
        uploadError={uploadError}
        onFile={handleUpload}
        onRemove={() => setConfirm('removePlan')}
      />

      <Tabs
        selectedIndex={views.indexOf(view)}
        onChange={({ selectedIndex }: { selectedIndex: number }) => {
          const next = new URLSearchParams(search);
          if (views[selectedIndex] === 'track') next.delete('view');
          else next.set('view', views[selectedIndex]);
          setSearch(next, { replace: true });
        }}
      >
        <TabList aria-label="Flight views" contained>
          {views.map(v => <Tab key={v}>{VIEW_LABEL[v]}</Tab>)}
        </TabList>
        <TabPanels>
          {views.map(v => <TabPanel key={v} style={{ padding: 0, paddingTop: '1rem' }}>{panel(v)}</TabPanel>)}
        </TabPanels>
      </Tabs>

      {points.length >= 2 && (
        <Tile style={{ marginTop: '1rem' }} data-testid="altitude-section">
          <h2 className="sabia-heading-03" style={{ marginBottom: '0.75rem' }}>Altitude profile</h2>
          <AltitudeChart points={points} />
        </Tile>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '1.5rem' }}>
        <Button as={RouterLink} to="/" kind="ghost">← Back</Button>
        <Button kind="ghost" onClick={() => { setSaveError(''); setEditOpen(true); }}>Edit</Button>
        <Button as={RouterLink} to={`/flight/${flight.id}/acars`} kind="ghost">ACARS messages</Button>
        <Button kind="ghost" disabled={exportingPdf} onClick={handleExportPdf}>
          {exportingPdf ? 'Generating PDF…' : 'Export PDF'}
        </Button>
        <Button kind="ghost" disabled={exportingKml} onClick={handleExportKml}>
          {exportingKml ? 'Exporting KML…' : 'Export KML'}
        </Button>
        {flight.flight_plan_name && (
          <Checkbox
            id="include-plan"
            labelText="Include flight plan"
            checked={includePlan}
            disabled={exportingPdf}
            onChange={(_, { checked }) => setIncludePlan(checked)}
          />
        )}
        <Button kind="danger" onClick={() => setConfirm('delete')}>Delete flight</Button>
      </div>
      {actionError && (
        <InlineNotification
          kind="error"
          title={actionError.title}
          subtitle={actionError.message}
          onCloseButtonClick={() => setActionError(null)}
        />
      )}

      <EditFlightModal
        open={editOpen}
        flight={flight}
        saving={saving}
        error={saveError}
        onSave={handleSave}
        onCancel={() => { setEditOpen(false); setSaveError(''); }}
      />
      <ConfirmModal
        open={confirm === 'delete'}
        title="Delete flight"
        message={`Delete flight #${flight.id}? Its track, ACARS messages and attached flight plan are deleted permanently. A linked planned leg goes back to planned.`}
        confirmLabel="Delete flight"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'unlink'}
        title="Unlink flight"
        message="Unlink this flight from its planned leg? The leg goes back to planned."
        confirmLabel="Unlink"
        onConfirm={handleUnlink}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'removePlan'}
        title="Remove flight plan"
        message={`Remove the attached flight plan${flight.flight_plan_name ? ` (${flight.flight_plan_name})` : ''}? The flight itself is kept.`}
        confirmLabel="Remove plan"
        onConfirm={handleRemovePlan}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
