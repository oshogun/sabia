import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  InlineNotification, Link, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper,
  StructuredListHead, SkeletonText, Tile,
} from '@carbon/react';
import { FirstFlightEmptyState } from '../components/FirstFlightEmptyState';
import { PageHeader } from '../components/PageHeader';
import { StatTiles } from '../components/StatTiles';
import { listFlights, listTrips } from '../api';
import { UnauthorizedError } from '../utils/api';
import { useLiveEvent, useLiveEvents } from '../shell/LiveEventsProvider';
import type { Flight, Trip } from '../types';
import { GroundSection } from './home/GroundSection';
import { LivePanel } from './home/LivePanel';
import { formatDate, formatDistance, formatDuration } from '../utils/format';

const RECENT_FLIGHTS_LIMIT = 5;

export function Home() {
  const { status } = useLiveEvents();
  const [flights, setFlights] = useState<Flight[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, t] = await Promise.allSettled([listFlights(), listTrips()]);
    if (f.status === 'rejected') {
      if (f.reason instanceof UnauthorizedError) return;
      setError((f.reason as Error).message);
      return;
    }
    setFlights(f.value);
    setTrips(t.status === 'fulfilled' ? t.value : []);
    setError(null);
  }, []);

  useEffect(() => {
    load();
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useLiveEvent(['flights-changed', 'flight-state'], load);

  const list = flights ?? [];
  const totalDurationSec = list.reduce((s, f) => s + (f.duration_sec ?? 0), 0);
  const totalDistanceNm = list.reduce((s, f) => s + (f.distance_nm ?? 0), 0);
  const recent = [...list]
    .filter(f => f.start_time)
    .sort((a, b) => (b.start_time! < a.start_time! ? -1 : b.start_time! > a.start_time! ? 1 : 0))
    .slice(0, RECENT_FLIGHTS_LIMIT);

  return (
    <>
      <PageHeader title="Home" />

      {status?.flightState === 'FLYING' && status.frame && <LivePanel status={status} />}

      <GroundSection status={status} />

      <h2 className="sabia-heading-03" style={{ marginBottom: '1rem' }}>Flight log</h2>

      {error && (
        <InlineNotification kind="error" role="alert" title="Could not load flights" subtitle={error} hideCloseButton lowContrast />
      )}

      {flights === null && !error ? (
        <Tile><SkeletonText paragraph lineCount={3} /></Tile>
      ) : flights !== null && flights.length === 0 ? (
        <FirstFlightEmptyState />
      ) : flights !== null ? (
        <>
          <StatTiles
            tiles={[
              { label: 'Total flights', value: flights.length },
              { label: 'Total trips', value: trips.length },
              { label: 'Total duration', value: formatDuration(totalDurationSec) },
              { label: 'Total distance', value: `${formatDistance(totalDistanceNm)} nm` },
            ]}
          />
          <h3 className="sabia-heading-02" style={{ margin: '1.5rem 0 0.5rem' }}>Recent flights</h3>
          <StructuredListWrapper isCondensed aria-label="Recent flights">
            <StructuredListHead>
              <StructuredListRow head>
                <StructuredListCell head>Flight</StructuredListCell>
                <StructuredListCell head>Started</StructuredListCell>
              </StructuredListRow>
            </StructuredListHead>
            <StructuredListBody>
              {recent.map(f => (
                <StructuredListRow key={f.id}>
                  <StructuredListCell>
                    <Link as={RouterLink} to={`/flight/${f.id}`}>
                      {f.aircraft || 'Unknown'}
                      {(f.departure_icao || f.arrival_icao) && <> — {f.departure_icao || '???'} → {f.arrival_icao || '???'}</>}
                    </Link>
                  </StructuredListCell>
                  <StructuredListCell>{formatDate(f.start_time)}</StructuredListCell>
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
          <div style={{ marginTop: '1rem' }}>
            <Link as={RouterLink} to="/flights">All flights →</Link>
          </div>
        </>
      ) : null}
    </>
  );
}
