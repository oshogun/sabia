import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ProgressBar, Tag, Tile } from '@carbon/react';
import { EmptyState } from '../../components/EmptyState';
import { StatTiles, type StatTile } from '../../components/StatTiles';
import { JourneyMap, legColor } from '../../components/maps/JourneyMap';
import { formatAlt, formatDistance, formatDuration, formatSpeed } from '../../utils/format';
import type { Journey } from '../../types';
import './tripatlas.scss';

export interface TripAtlasProps {
  /** The trip's journey summary, as returned by GET /api/trips/:id/journey. */
  journey: Journey;
  /** Map-level overlays (navdata layers) passed through to the journey map. */
  mapChildren?: ReactNode;
}

/**
 * The Atlas view of a trip: totals, planned-route progress, countries, the
 * longest unbroken chain, every leg on one map, hoverable route chips and a
 * per-aircraft breakdown. Hovering or focusing a chip highlights its leg.
 */
export function TripAtlas({ journey, mapChildren }: TripAtlasProps) {
  const [highlightId, setHighlightId] = useState<number | null>(null);

  if (journey.legCount === 0) {
    return <EmptyState title="No flights in this trip yet" />;
  }

  const tiles: StatTile[] = [
    { label: 'Distance (nm)', value: formatDistance(journey.totalDistanceNm) },
    { label: 'Air time', value: formatDuration(journey.totalDurationSec) },
    { label: 'Legs', value: journey.legCount },
    { label: 'Airports', value: journey.airports.length },
    { label: 'Aircraft', value: journey.aircraftCount },
    { label: 'Ceiling (ft)', value: formatAlt(journey.maxAltitudeFt) },
    { label: 'Top speed (kts)', value: formatSpeed(journey.maxAirspeedKts) },
    {
      label: journey.longestLeg?.route ? `Longest leg (nm) · ${journey.longestLeg.route}` : 'Longest leg (nm)',
      value: journey.longestLeg ? formatDistance(journey.longestLeg.distanceNm) : '—',
    },
  ];

  const progress = journey.plannedRouteProgressPct;
  const chain = journey.longestChain;

  return (
    <div className="tripatlas">
      <StatTiles tiles={tiles} />

      {progress !== undefined && (
        <section>
          <h2 className="sabia-heading-03 tripatlas__section-title">Planned route progress</h2>
          <ProgressBar
            label="Planned route progress"
            hideLabel
            value={Math.min(100, Math.max(0, progress))}
            max={100}
            helperText={`${progress.toFixed(1)}% of approx. planned distance flown`}
          />
        </section>
      )}

      {journey.countries.length > 0 && (
        <section>
          <h2 className="sabia-heading-03 tripatlas__section-title">
            {journey.countries.length === 1 ? 'Country' : `Countries — ${journey.countries.length}`}
          </h2>
          <div className="tripatlas__tags">
            {journey.countries.map(c => (
              <Tag key={c.name} type="gray" title={`${c.airports} airport${c.airports === 1 ? '' : 's'}`}>
                {c.flag} {c.name} · {c.airports}
              </Tag>
            ))}
          </div>
        </section>
      )}

      {/* Only worth calling out once there is actually a run to describe */}
      {chain && chain.length > 1 && (
        <div className="tripatlas__chain">
          <strong>{chain.length} legs end to end</strong>
          {' — '}{chain.from} → {chain.to}
          {journey.chainBreaks === 0
            ? ', every landing the next departure.'
            : ` (${journey.chainBreaks} break${journey.chainBreaks === 1 ? '' : 's'} elsewhere).`}
        </div>
      )}

      <section>
        <h2 className="sabia-heading-03 tripatlas__section-title">Every leg</h2>
        <JourneyMap
          legs={journey.legs}
          airports={journey.airports}
          highlightId={highlightId}
          onHighlight={setHighlightId}
        >
          {mapChildren}
        </JourneyMap>
      </section>

      <section>
        <h2 className="sabia-heading-03 tripatlas__section-title">Route</h2>
        <div className="tripatlas__route">
          {journey.legs.map(leg => (
            <Link
              to={`/flight/${leg.id}`}
              key={leg.id}
              className={`tripatlas__hop${highlightId === leg.id ? ' is-active' : ''}`}
              onMouseEnter={() => setHighlightId(leg.id)}
              onMouseLeave={() => setHighlightId(null)}
              onFocus={() => setHighlightId(leg.id)}
              onBlur={() => setHighlightId(null)}
              aria-label={`Leg ${leg.seq}: ${leg.departureIcao ?? 'unknown'} to ${leg.arrivalIcao ?? 'unknown'}, ${leg.aircraft ?? 'unknown aircraft'}, ${formatDistance(leg.distanceNm)} nm`}
              title={`Leg ${leg.seq} · ${leg.aircraft ?? 'Unknown'} · ${formatDistance(leg.distanceNm)} nm`}
            >
              <span
                className="tripatlas__hop-dot"
                style={{ background: legColor(leg.seq, journey.legs.length) }}
                aria-hidden="true"
              />
              {leg.departureIcao ?? '????'} <span className="tripatlas__hop-arrow" aria-hidden="true">→</span> {leg.arrivalIcao ?? '????'}
            </Link>
          ))}
        </div>
      </section>

      {journey.aircraft.length > 1 && (
        <section>
          <h2 className="sabia-heading-03 tripatlas__section-title">Aircraft</h2>
          <div className="tripatlas__fleet">
            {journey.aircraft.map(a => (
              <Tile key={a.name}>
                <div className="tripatlas__plane-name">{a.name}</div>
                <div className="tripatlas__plane-stats">
                  {a.legs} leg{a.legs === 1 ? '' : 's'} · {formatDistance(a.distanceNm)} nm
                </div>
                <ProgressBar
                  label={`${a.name} share of distance`}
                  hideLabel
                  size="small"
                  value={journey.totalDistanceNm > 0 ? (a.distanceNm / journey.totalDistanceNm) * 100 : 0}
                  max={100}
                />
              </Tile>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
