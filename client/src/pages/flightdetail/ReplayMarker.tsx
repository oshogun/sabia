import { useEffect, useRef } from 'react';
import { Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { FlightPoint } from '../../types';
import { unwrapLonChain } from '../../utils/geo';
import { palette } from '../../components/maps/palette';
import type { ReplaySample } from '../../components/replay';

/**
 * Where the replay clock and the map meet. The clock reports positions from
 * outside the map's React tree, and reports the first one before the map has
 * mounted its children, so the latest sample and follow flag are kept here
 * and handed to the marker as soon as it registers.
 */
export interface ReplayBridge {
  last: ReplaySample | null;
  follow: boolean;
  sink: ((sample: ReplaySample, follow: boolean) => void) | null;
}

export const newReplayBridge = (): ReplayBridge => ({ last: null, follow: true, sink: null });

const markerIcon = () =>
  L.divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div data-replay-heading style="width:24px;height:24px;display:flex;align-items:center;justify-content:center">`
      + `<svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2 L19 21 L12 17 L5 21 Z" fill="${palette.aircraft}" stroke="${palette.markerShadow}" stroke-width="1.2"/></svg></div>`,
  });

/**
 * The replay aircraft on the flight map. Moves a Leaflet marker directly on
 * every clock tick so playback costs no React render; with follow on, the map
 * pans to keep it in view.
 */
export function ReplayMarker({ bridge }: { bridge: ReplayBridge }) {
  const map = useMap();
  useEffect(() => {
    const marker = L.marker([0, 0], { icon: markerIcon(), interactive: false, keyboard: false, zIndexOffset: 1000, opacity: 0 });
    marker.addTo(map);
    const apply = (s: ReplaySample, follow: boolean) => {
      const ll: [number, number] = [s.lat, s.lon];
      marker.setLatLng(ll);
      marker.setOpacity(1);
      const el = marker.getElement();
      if (el) {
        el.dataset.replayMarker = '';
        el.dataset.lat = s.lat.toFixed(5);
        el.dataset.lon = s.lon.toFixed(5);
        const arrow = el.firstElementChild as HTMLElement | null;
        if (arrow) arrow.style.transform = `rotate(${s.headingDeg}deg)`;
      }
      if (follow) map.panTo(ll, { animate: false });
    };
    bridge.sink = apply;
    if (bridge.last) apply(bridge.last, bridge.follow);
    return () => {
      bridge.sink = null;
      marker.remove();
    };
  }, [map, bridge]);
  return null;
}

/**
 * The flown track drawn again on top of every other overlay. Route geometry is
 * fetched after the map first draws, so its polylines are added later and would
 * paint over the track in the shared canvas; each time a layer is added the
 * track is sent back to the front.
 */
export function TrackOnTop({ points }: { points: FlightPoint[] }) {
  const map = useMap();
  const track = useRef<L.Polyline | null>(null);
  useEffect(() => {
    const toFront = () => track.current?.bringToFront();
    toFront();
    map.on('layeradd', toFront);
    return () => { map.off('layeradd', toFront); };
  }, [map]);
  if (points.length < 2) return null;
  const latlngs = unwrapLonChain(points.map(p => [p.lat, p.lon] as [number, number]));
  return (
    <Polyline
      ref={track}
      positions={latlngs}
      pathOptions={{ color: palette.track, weight: 2.5, opacity: 0.9 }}
      interactive={false}
    />
  );
}
