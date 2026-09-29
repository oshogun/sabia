import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
// Bundled rather than loaded from a CDN: the PDF export renders this page
// headlessly, and a CDN outage would silently produce unstyled, broken maps.
import 'leaflet/dist/leaflet.css';
import './CarbonMap.scss';

type LatLng = [number, number];

/**
 * Standard OpenStreetMap tiles are light; this single filter darkens the tile
 * pane (and nothing else) to sit on Gray 100. Applied through a CSS custom
 * property read by `.sabia-map .leaflet-tile-pane`.
 */
export const TILE_DARK_FILTER = 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.9)';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export interface CarbonMapProps {
  /** Initial centre. Overlays such as `FlightMap` refit afterwards. */
  center: LatLng;
  /** Initial zoom. Default 10. */
  zoom?: number;
  /** CSS height of the map slot. Default `'24rem'`. The width is always 100% of the parent. */
  height?: string;
  /** Leaflet's own +/- control, restyled. Default true. */
  zoomControl?: boolean;
  /** Draw vectors on a canvas. Default true. */
  preferCanvas?: boolean;
  /** Extra class on the wrapper element. */
  className?: string;
  /** Test hook / a11y label for the wrapper. */
  'data-testid'?: string;
  /**
   * Overlay layers. Anything react-leaflet renders (`Polyline`, `Marker`,
   * `Tooltip`, custom components calling `useMap()`) goes here, and is rendered
   * above the tile layer. Never give an overlay a z-index above 1000.
   */
  children?: ReactNode;
}

/** Re-measures the map whenever its box changes size (side nav, window, tabs). */
function ResizeSync() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

/**
 * The one Leaflet host every Carbon map composes: sizing slot, dark tiles,
 * stacking isolation, resize handling. Wrap overlay layers as children.
 */
export function CarbonMap({
  center, zoom = 10, height = '24rem', zoomControl = true, preferCanvas = true, className, children,
  'data-testid': testId,
}: CarbonMapProps) {
  const style = { height, '--sabia-map-tile-filter': TILE_DARK_FILTER } as CSSProperties;
  return (
    <div className={['sabia-map', className].filter(Boolean).join(' ')} style={style} data-testid={testId}>
      <MapContainer center={center} zoom={zoom} preferCanvas={preferCanvas} zoomControl={zoomControl}>
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={18} />
        <ResizeSync />
        {children}
      </MapContainer>
    </div>
  );
}

