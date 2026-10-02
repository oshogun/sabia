import { useState, useEffect } from 'react';
import type L from 'leaflet';
import { fetchNavdataFeatures, NavdataBusyError, paddedBbox, type NavdataKind } from '../utils/navdataApi';
import type { FeaturesResponse } from '../types';

export const NAVDATA_DEBOUNCE_MS = 300;

export interface NavdataFeaturesState {
  data: FeaturesResponse | null;
  /** Map centre when `data` was requested: the frame its longitudes are unwrapped into. */
  anchor: [number, number] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Features for the current view of `map`. Every pan or zoom restarts a 300 ms
 * debounce; a request still in flight when the next one starts is aborted, so
 * at most one is ever live. A mid-swap 503 keeps what is on screen and is
 * retried once after the server's Retry-After. When `reloadKey` changes the
 * current view is requested again, keeping what is on screen until the answer
 * arrives; leaving it out never reloads.
 */
export function useNavdataFeatures(
  map: L.Map,
  kinds: NavdataKind[],
  enabled: boolean,
  reloadKey?: string | null
): NavdataFeaturesState {
  const [state, setState] = useState<NavdataFeaturesState>({ data: null, anchor: null, loading: false, error: null });
  const kindsKey = kinds.join(',');

  useEffect(() => {
    if (!enabled || kindsKey === '') {
      setState(s => (s.data === null && !s.loading && s.error === null ? s : { data: null, anchor: null, loading: false, error: null }));
      return;
    }
    const wanted = kindsKey.split(',') as NavdataKind[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let disposed = false;

    async function load(allowRetry: boolean) {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      setState(s => ({ ...s, loading: true, error: null }));
      try {
        const c = map.getCenter();
        const b = map.getBounds();
        const bbox = paddedBbox({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
        const data = await fetchNavdataFeatures(bbox, map.getZoom(), wanted, mine.signal);
        if (disposed || mine.signal.aborted) return;
        setState({ data, anchor: [c.lat, c.lng], loading: false, error: null });
      } catch (err) {
        if (disposed || mine.signal.aborted) return;
        if (err instanceof NavdataBusyError && allowRetry) {
          retryTimer = setTimeout(() => load(false), err.retryAfterSeconds * 1000);
          return;
        }
        setState(s => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'Navdata request failed' }));
      }
    }

    function schedule() {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      timer = setTimeout(() => load(true), NAVDATA_DEBOUNCE_MS);
    }

    schedule();
    map.on('moveend zoomend', schedule);
    return () => {
      disposed = true;
      map.off('moveend zoomend', schedule);
      clearTimeout(timer);
      clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [map, kindsKey, enabled, reloadKey]);

  return state;
}
