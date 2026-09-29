import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Flight, PlannedLegWithChildren } from '../../types';
import { formatDistance } from '../../utils/format';
import { EmptyState } from '../EmptyState';
import { useFitBoundsOnChange } from '../../hooks/useFitBoundsOnChange';
import { CarbonMap } from './CarbonMap';
import { LEG_COLORS, palette } from './palette';
import { flightChains, plannedLegChains, sortedPlannedLegs, type LatLng } from './trip/chains';

const dotIcon = (color: string) =>
  L.divIcon({
    className: '',
    iconAnchor: [6, 6],
    html: `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid ${palette.markerBorder};box-shadow:0 0 4px ${palette.markerShadow}"></div>`,
  });

const waypointIcon = () =>
  L.divIcon({
    className: '',
    iconAnchor: [4, 4],
    html: `<div style="width:8px;height:8px;border-radius:50%;background:${palette.planned};border:1px solid ${palette.markerBorder};box-shadow:0 0 3px ${palette.markerShadow};opacity:0.9"></div>`,
  });

function BoundsController({ points }: { points: LatLng[] }) {
  const map = useMap();
  useFitBoundsOnChange(map, points, [30, 30]);
  return null;
}

/** What a caller draws for one planned leg on top of, or instead of, its stored waypoints. */
export interface LegOverlay {
  layer: ReactNode;
  /** True when `layer` replaces the dashed waypoint polyline (e.g. resolved procedure geometry). */
  replacesPlanned: boolean;
}

export interface TripMapProps {
  /** The trip's flights in leg order; each is drawn as one coloured track from `points`. */
  flights: Flight[];
  /**
   * Optional planned legs. Drawn dashed beneath the flown tracks exactly as
   * stored, never snapped toward the flown track.
   */
  plannedLegs?: PlannedLegWithChildren[];
  /** CSS height of the map. Default `'28rem'`. */
  height?: string;
  /** Show the zoom buttons. Default true. */
  zoomControl?: boolean;
  /**
   * Per-planned-leg extra layer (route geometry). Receives the leg and its
   * unwrapped waypoint chain; return null for no overlay. Flown tracks are
   * brought back to the front after each render that supplies overlays.
   */
  legOverlay?: (leg: PlannedLegWithChildren, chain: LatLng[]) => LegOverlay | null;
  /** Map-level overlays such as the navdata layers. */
  children?: ReactNode;
}

/**
 * A trip's combined route: one colour-cycled track per flight with departure
 * and arrival markers, and optionally its planned legs. Fits to everything
 * until the user moves the map.
 */
export function TripMap({ flights, plannedLegs = [], height = '28rem', zoomControl = true, legOverlay, children }: TripMapProps) {
  const trackRefs = useRef<(L.Polyline | null)[]>([]);
  // Overlays arrive after the tracks were drawn; keep the flown tracks on top.
  useEffect(() => {
    if (!legOverlay) return;
    trackRefs.current.forEach(t => t?.bringToFront());
  });

  const hasPoints = flights.some(f => f.points && f.points.length > 0);
  const hasPlannedWaypoints = plannedLegs.some(l => l.waypoints && l.waypoints.length > 0);
  if (!hasPoints && !hasPlannedWaypoints) {
    return <EmptyState title="No GPS points recorded for this trip" />;
  }

  const plannedChains = plannedLegChains(plannedLegs);
  const flownChains = flightChains(flights);
  const firstFlown = flownChains.find(c => c.length > 0);
  const center: LatLng = firstFlown?.[0] ?? plannedChains.find(c => c.length > 0)?.[0] ?? [0, 0];
  const fitPoints = [...flownChains.flat(), ...plannedChains.flat()];

  return (
    <CarbonMap center={center} zoom={10} height={height} zoomControl={zoomControl} data-testid="trip-map">
      {sortedPlannedLegs(plannedLegs).map((leg, legIdx) => {
        const sortedWaypoints = leg.waypoints.slice().sort((a, b) => a.seq - b.seq);
        if (sortedWaypoints.length === 0) return null;
        const chain = plannedChains[legIdx];
        const overlay = legOverlay?.(leg, chain) ?? null;
        const label =
          `Leg ${leg.seq} (planned) — ${leg.departure_ident} → ${leg.destination_ident}` +
          ` · approx. ${formatDistance(leg.approx_distance_nm)} nm`;
        return (
          <Fragment key={`planned-${leg.id}`}>
            {!overlay?.replacesPlanned && (
              <>
                <Polyline
                  positions={chain}
                  pathOptions={{ color: palette.planned, weight: 2, opacity: 0.9, dashArray: '6 6' }}
                >
                  <Tooltip sticky>{label}</Tooltip>
                </Polyline>
                {sortedWaypoints.map((w, i) => (
                  <Marker key={`${leg.id}-${w.seq}`} position={chain[i]} icon={waypointIcon()}>
                    <Tooltip>{`Leg ${leg.seq} · ${w.ident}`}</Tooltip>
                  </Marker>
                ))}
              </>
            )}
            {overlay?.layer}
          </Fragment>
        );
      })}
      {flights.map((f, i) => {
        const latlngs = flownChains[i];
        if (latlngs.length === 0) return null;
        const color = LEG_COLORS[i % LEG_COLORS.length];
        return (
          <Fragment key={f.id}>
            <Polyline
              ref={el => { trackRefs.current[i] = el; }}
              positions={latlngs}
              pathOptions={{ color, weight: 2.5, opacity: 0.9 }}
            >
              <Tooltip sticky>{`Leg ${i + 1}${f.aircraft ? ' — ' + f.aircraft : ''}`}</Tooltip>
            </Polyline>
            <Marker position={latlngs[0]} icon={dotIcon(palette.departure)}>
              <Tooltip>{`Leg ${i + 1} departure`}</Tooltip>
            </Marker>
            <Marker position={latlngs[latlngs.length - 1]} icon={dotIcon(palette.arrival)}>
              <Tooltip>{`Leg ${i + 1} arrival`}</Tooltip>
            </Marker>
          </Fragment>
        );
      })}
      <BoundsController points={fitPoints} />
      {children}
    </CarbonMap>
  );
}
