import { lazy, Suspense, type ReactNode } from 'react';
import { Column, Grid, Tag, Tile } from '@carbon/react';
import type { Status } from '../../types';
import { formatAlt, formatDistance } from '../../utils/format';

// Home's only path to Leaflet, so it's kept out of the first-load bundle.
const LiveMapSlot = lazy(() => import('./LiveMapSlot').then((m) => ({ default: m.LiveMapSlot })));

function Readout({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <Column
      sm={2} md={2} lg={wide ? 8 : 4}
      style={{ marginBottom: '1rem', minInlineSize: 0, overflowWrap: 'anywhere' }}
    >
      <div className="sabia-readout-label">{label}</div>
      <div className="sabia-readout">{children}</div>
    </Column>
  );
}

const Unit = ({ children }: { children: string }) => (
  <span className="sabia-unit">{children}</span>
);

export function LivePanel({ status }: { status: Status }) {
  const { frame, flightState, aircraft, plannedLeg, paused } = status;
  if (flightState !== 'FLYING' || !frame) return null;

  const vs = Math.round(frame.verticalSpeedFpm);
  const vsColor = vs > 100 ? 'var(--cds-support-success)' : vs < -100 ? 'var(--cds-support-error)' : undefined;

  return (
    <Tile data-testid="live-panel" style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <Tag type={paused ? 'magenta' : 'green'} size="md">{paused ? 'Paused' : 'Recording'}</Tag>
        <h2 className="sabia-heading-03">{aircraft || 'Unknown'}</h2>
      </div>
      <Grid condensed narrow style={{ padding: 0, marginInline: 0 }}>
        <Readout label="Airspeed">{Math.round(frame.airspeedKnots)}<Unit>kts</Unit></Readout>
        <Readout label="Ground speed">{Math.round(frame.groundSpeedKnots)}<Unit>kts</Unit></Readout>
        <Readout label="Altitude">{formatAlt(frame.altitudeFt)}<Unit>ft</Unit></Readout>
        <Readout label="Heading">{String(Math.round(frame.headingDeg)).padStart(3, '0')}<Unit>°</Unit></Readout>
        <Readout label="Vertical speed">
          <span style={{ color: vsColor }}>{(vs >= 0 ? '+' : '') + vs.toLocaleString()}</span><Unit>fpm</Unit>
        </Readout>
        <Readout label="Position" wide>
          <span className="sabia-readout--compact">{frame.lat.toFixed(3)}, {frame.lon.toFixed(3)}</span>
        </Readout>
        {plannedLeg && (
          <>
            <Readout label={`Next waypoint → ${plannedLeg.destinationIdent}`} wide>{plannedLeg.nextWaypointIdent}</Readout>
            <Readout label="Remaining (planned route)" wide>
              <span className="sabia-readout--compact">approx. {formatDistance(plannedLeg.remainingDistanceNm)}</span><Unit>nm</Unit>
            </Readout>
          </>
        )}
      </Grid>
      <Suspense fallback={<div data-testid="live-map-slot-loading" style={{ marginTop: '1rem', height: '20rem' }} />}>
        <LiveMapSlot status={status} />
      </Suspense>
    </Tile>
  );
}
