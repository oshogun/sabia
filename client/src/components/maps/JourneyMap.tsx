import type { ReactNode } from 'react';
import { CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
import type { JourneyAirport, JourneyLeg } from '../../types';
import { EmptyState } from '../EmptyState';
import { useFitBoundsOnChange } from '../../hooks/useFitBoundsOnChange';
import { CarbonMap } from './CarbonMap';
import { palette } from './palette';
import { airportPositions, journeyLegChains, sortedJourneyLegs, type LatLng } from './trip/chains';

/**
 * Legs are tinted along a hue ramp from the first flight to the most recent, so
 * the direction of travel reads at a glance on a map with no time axis. (A
 * five-colour cycle would repeat many times over a long journey.)
 */
export function legColor(seq: number, total: number): string {
  if (total <= 1) return 'hsl(210 90% 62%)';
  const t = (seq - 1) / (total - 1);
  const hue = 210 - t * 190; // blue -> cyan -> green -> amber
  return `hsl(${hue.toFixed(0)} 85% 60%)`;
}

function FitAll({ points }: { points: LatLng[] }) {
  const map = useMap();
  useFitBoundsOnChange(map, points, [28, 28]);
  return null;
}

export interface JourneyMapProps {
  legs: JourneyLeg[];
  airports: JourneyAirport[];
  /** Leg id drawn thick while every other leg is dimmed, or null for none. */
  highlightId: number | null;
  /** Called with a leg id on hover, and null when the pointer leaves it. */
  onHighlight: (id: number | null) => void;
  /** CSS height of the map. Default `'32rem'`. */
  height?: string;
  /** Map-level overlays such as the navdata layers. */
  children?: ReactNode;
}

/** Every leg of a trip on one map, tinted by order, with an airport dot for each ICAO. */
export function JourneyMap({ legs, airports, highlightId, onHighlight, height = '32rem', children }: JourneyMapProps) {
  if (legs.length === 0) {
    return <EmptyState title="No flights in this trip yet" />;
  }

  const ordered = sortedJourneyLegs(legs);
  const trackChains = journeyLegChains(legs);
  const positions = airportPositions(ordered, trackChains);

  return (
    <CarbonMap center={ordered[0].track[0] ?? [0, 0]} zoom={4} height={height} data-testid="journey-map">
      {ordered.map((leg, legIdx) => {
        const dimmed = highlightId !== null && highlightId !== leg.id;
        return (
          <Polyline
            key={leg.id}
            positions={trackChains[legIdx]}
            pathOptions={{
              color: legColor(leg.seq, legs.length),
              weight: highlightId === leg.id ? 4.5 : 2.2,
              opacity: dimmed ? 0.18 : 0.9,
            }}
            eventHandlers={{
              mouseover: () => onHighlight(leg.id),
              mouseout: () => onHighlight(null),
            }}
          >
            <Tooltip sticky>
              {`Leg ${leg.seq}: ${leg.departureIcao ?? '????'} → ${leg.arrivalIcao ?? '????'}`}
              {leg.aircraft ? ` · ${leg.aircraft}` : ''}
            </Tooltip>
          </Polyline>
        );
      })}

      {airports.map(a => (
        <CircleMarker
          key={a.icao}
          center={positions.get(a.icao) ?? [a.lat, a.lon]}
          radius={a.visits > 1 ? 5 : 3.5}
          pathOptions={{ color: palette.markerBorder, weight: 1.5, fillColor: palette.markerShadow, fillOpacity: 1 }}
        >
          <Tooltip>
            <strong>{a.icao}</strong>{a.name ? ` — ${a.name}` : ''}
            {a.visits > 1 ? ` (${a.visits} visits)` : ''}
          </Tooltip>
        </CircleMarker>
      ))}

      <FitAll points={trackChains.flat()} />
      {children}
    </CarbonMap>
  );
}
