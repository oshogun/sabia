import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NavdataControls, NavdataOverlay, kindNote, type NavdataControlsProps } from './NavdataControls';
import { FlightMap } from './FlightMap';
import { mockFetchRoutes } from '../../test/mockFetch';
import {
  absentStatus, cov, currentLnmDataset, emptyFeatures, expiredLnmDataset, expiredNoCycleDataset, lnmStatus, presentStatus,
  undatedLnmDataset,
} from '../../test/navdataFixtures';
import type { FeaturesResponse } from '../../types';
import type { FlightPoint } from '../../types';

const allOff = { airports: false, navaids: false, waypoints: false, airways: false, runways: false };

function renderControls(data: FeaturesResponse | null, over: Partial<NavdataControlsProps> = {}) {
  return render(
    <NavdataControls
      status={presentStatus}
      visible={{ ...allOff, airports: true, waypoints: true }}
      onToggle={() => {}}
      features={{ data, anchor: [0, 0], loading: false, error: null }}
      {...over}
    />
  );
}

describe('kindNote', () => {
  it('says not fetched yet when no cell was harvested', () => {
    const d = emptyFeatures({ coverage: { ...emptyFeatures().coverage, byKind: { V: cov(0, 0), N: cov(0, 0), W: cov(0, 0) } } });
    expect(kindNote('waypoints', d)).toMatch(/Not fetched here yet/);
  });

  it('says none here only when every cell was harvested and nothing came back', () => {
    expect(kindNote('waypoints', emptyFeatures())).toBe('None here');
  });

  it('says partly fetched with the percentage', () => {
    const d = emptyFeatures({ coverage: { ...emptyFeatures().coverage, byKind: { V: cov(4, 1), N: cov(4, 1), W: cov(2, 0.42) } } });
    expect(kindNote('waypoints', d)).toBe('Partly fetched here (42%)');
  });

  it('has no note for a fully harvested kind that returned rows', () => {
    const d = emptyFeatures({ waypoints: [{ key: 'k', ident: 'ZZAAA', region: 'ZZ', lat: 1, lon: 1, terminal: null }] });
    expect(kindNote('waypoints', d)).toBeNull();
  });

  it('reports a gated kind as needing zoom, ahead of coverage', () => {
    expect(kindNote('waypoints', emptyFeatures({ gated: ['waypoints'] }))).toBe('Zoom in to see waypoints');
  });

  it('trusts an empty airport answer because the index is global', () => {
    expect(kindNote('airports', emptyFeatures())).toBe('None here');
  });

  it('names the tier and hidden count when airports are thinned to large', () => {
    const d = emptyFeatures({ airportThinning: { mode: 'tier', through: 'large', hidden: 12, byTier: null, nextZoom: 7 } });
    expect(kindNote('airports', d)).toBe('Major airports only — 12 more when you zoom in');
  });

  it('names the tier and hidden count when airports are thinned to medium', () => {
    const d = emptyFeatures({ airportThinning: { mode: 'tier', through: 'medium', hidden: 1686, byTier: null, nextZoom: 8 } });
    expect(kindNote('airports', d)).toBe('Major and regional airports — 1686 more when you zoom in');
  });

  it('names the hidden count when airports are thinned to small', () => {
    const d = emptyFeatures({ airportThinning: { mode: 'tier', through: 'small', hidden: 40, byTier: null, nextZoom: 9 } });
    expect(kindNote('airports', d)).toBe('Hiding 40 unlisted or non-airport fields — zoom in for the rest');
  });

  it('names the hidden count when airports are thinned to unknown', () => {
    const d = emptyFeatures({ airportThinning: { mode: 'tier', through: 'unknown', hidden: 3, byTier: null, nextZoom: 10 } });
    expect(kindNote('airports', d)).toBe('Hiding 3 heliports and closed fields — zoom in for the rest');
  });
});

describe('NavdataControls', () => {
  it('renders nothing when the replica is absent or status is unknown', () => {
    const { container, rerender } = renderControls(null, { status: absentStatus });
    expect(container).toBeEmptyDOMElement();
    rerender(
      <NavdataControls status={null} visible={allOff} onToggle={() => {}} features={{ data: null, anchor: null, loading: false, error: null }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('labels the simulator data under the title', () => {
    renderControls(null);
    expect(screen.getByText('Simulator')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no label line when the status carries no dataset', () => {
    const { container } = renderControls(null, { status: { ...presentStatus, dataset: null } });
    expect(container.querySelector('.navdata-panel__muted')).toBeNull();
  });

  it('labels an imported Little Navmap dataset with its validity window', () => {
    renderControls(null, { status: lnmStatus(currentLnmDataset) });
    expect(screen.getByText('Little Navmap · Navigraph AIRAC 9901 · valid 2099-01-02 – 2099-01-29')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('labels a Little Navmap dataset without validity by its label alone', () => {
    renderControls(null, { status: lnmStatus(undatedLnmDataset) });
    expect(screen.getByText('Little Navmap · MSFS scenery, compiled 2099-01-01')).toBeInTheDocument();
  });

  it('labels the simulator dataset with its validity when it has one', () => {
    renderControls(null, { status: { ...presentStatus, dataset: { ...currentLnmDataset, source: 'mcdu', label: 'Simulator' } } });
    expect(screen.getByText('Simulator · valid 2099-01-02 – 2099-01-29')).toBeInTheDocument();
  });

  it('flags an expired dataset as not for navigation, alongside its label', () => {
    renderControls(null, { status: lnmStatus(expiredLnmDataset) });
    expect(screen.getByText('Little Navmap · Navigraph AIRAC 2001 · valid 2020-01-02 – 2020-01-29')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Expired AIRAC — not for navigation');
    expect(screen.getByRole('alert')).toHaveClass('navdata-panel__error');
  });

  it('labels an expired dataset with no AIRAC cycle by its label and valid-through, never "null"', () => {
    const { container } = renderControls(null, { status: lnmStatus(expiredNoCycleDataset) });
    expect(screen.getByText('Little Navmap · Navigraph build 2020-01 · valid until 2020-01-29')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Expired AIRAC — not for navigation');
    expect(container.textContent).not.toContain('null');
  });

  it('renders no label or alert for a status from a server that sends no dataset', () => {
    const legacy = { ...presentStatus } as Partial<typeof presentStatus>;
    delete legacy.dataset;
    renderControls(null, { status: legacy as typeof presentStatus });
    expect(screen.getByText('Navdata')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a toggle per kind and reports clicks', () => {
    const toggled: string[] = [];
    renderControls(null, { onToggle: k => toggled.push(k) });
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Navaids' }));
    expect(toggled).toEqual(['navaids']);
  });

  it('greys a gated toggle and gives the reason', () => {
    renderControls(emptyFeatures({ gated: ['waypoints'] }));
    expect(screen.getByText('Waypoints: Zoom in to see waypoints')).toBeInTheDocument();
    // The Carbon Checkbox renders its input beside the label, not inside it,
    // so the gated state is asserted on the row wrapper the input sits in,
    // which is what carries the dimming class and the reason as a title.
    const wrapper = screen.getByRole('checkbox', { name: 'Waypoints' }).closest('.navdata-panel__kind')!;
    expect(wrapper).toHaveClass('navdata-panel__kind--gated');
    expect(wrapper).toHaveAttribute('title', 'Zoom in to see waypoints');
  });

  it('warns when the answer was truncated', () => {
    renderControls(emptyFeatures({ truncated: true }));
    expect(screen.getByText(/Too many to draw — zoom in for more/)).toBeInTheDocument();
  });

  it('shows coverage messages per enabled kind only', () => {
    renderControls(emptyFeatures());
    expect(screen.getByText('Waypoints: None here')).toBeInTheDocument();
    expect(screen.getByText('Airports: None here')).toBeInTheDocument();
    expect(screen.queryByText(/Navaids:/)).toBeNull();
  });

  it('offers fetch detail for index-only airports and posts the request', async () => {
    const posts: unknown[] = [];
    mockFetchRoutes({
      '/api/navdata/request': { POST: init => {
        posts.push(JSON.parse(init!.body as string));
        return [200, { ok: true, state: 'queued', ident: 'ZZAA' }];
      } },
    });
    renderControls(emptyFeatures({
      airports: [
        { ident: 'ZZAA', lat: 1, lon: 1, name: null, hasDetail: false, runways: null, procedures: null, longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null },
        { ident: 'ZZBB', lat: 1, lon: 1, name: null, hasDetail: true, runways: 1, procedures: 1, longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null },
      ],
    }));
    const buttons = screen.getAllByRole('button', { name: 'Fetch detail' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(screen.getByText('Queued')).toBeInTheDocument());
    expect(posts).toEqual([{ kind: 'A', ident: 'ZZAA' }]);
  });

  it('shows a failed request instead of throwing, and lets it be retried', async () => {
    mockFetchRoutes({ '/api/navdata/request': { POST: [500, { error: 'nope' }] } });
    renderControls(emptyFeatures({
      airports: [{ ident: 'ZZAA', lat: 1, lon: 1, name: null, hasDetail: false, runways: null, procedures: null, longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Fetch detail' }));
    await waitFor(() => expect(screen.getByText('Request failed: nope')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Fetch detail' })).toBeInTheDocument();
  });

  it('never offers fetch detail for an ident that is not airport-shaped', () => {
    renderControls(emptyFeatures({
      airports: [{ ident: 'ZZ-BAD!', lat: 1, lon: 1, name: null, hasDetail: false, runways: null, procedures: null, longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null }],
    }));
    expect(screen.queryByRole('button', { name: 'Fetch detail' })).toBeNull();
  });
});

const track: FlightPoint[] = [0, 1].map(i => ({
  id: i,
  flight_id: 1,
  ts: new Date(Date.parse('2026-01-01T12:00:00.000Z') + i * 5000).toISOString(),
  lat: 50 + i * 0.01,
  lon: 8 + i * 0.01,
  altitude_ft: 1000,
  airspeed_kts: 120,
  ground_speed_kts: 130,
  heading_deg: 90,
  vertical_speed_fpm: 0,
  on_ground: 0,
}));

// jsdom has no real <canvas> 2D context, and the flown track always draws
// through Leaflet's own canvas renderer, so mounting a real FlightMap here
// needs a context stub — every draw call is a no-op, only property
// assignment is kept, which is all the renderer needs to not throw.
function stubCanvasContext() {
  const target: Record<PropertyKey, unknown> = {};
  const fakeCtx = new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop as PropertyKey] : () => undefined),
    set: (t, prop, value) => {
      t[prop as PropertyKey] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
}

// Leaflet's canvas renderer schedules its own redraw on the next animation
// frame, but a synchronous redraw fired in between (here, from the map
// fitting its bounds right after the track is added) can leave that original
// frame request orphaned: cancelled bookkeeping, but the browser still calls
// it. If that stray frame lands after the test has already unmounted the
// map, it runs against a canvas the renderer has already torn down and
// throws. Giving Leaflet a couple of real animation frames to settle before
// unmounting lets that redraw happen while the canvas is still alive, so
// nothing is left pending to fire later.
function flushAnimationFrames(times = 2) {
  return Array.from({ length: times }).reduce<Promise<void>>(
    p => p.then(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))),
    Promise.resolve()
  );
}

// FlightMap renders NavdataOverlay (and everything else navdata-shaped) as a
// child, not through a boolean prop, so a map that never mounts the overlay
// must stay completely inert: no status poll, no pane.
describe('a map without NavdataOverlay', () => {
  afterEach(async () => {
    await flushAnimationFrames();
    vi.restoreAllMocks();
  });

  it('makes no /api/navdata/status request and creates no navdata pane', async () => {
    stubCanvasContext();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(presentStatus), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<FlightMap points={track} />);
    await new Promise(r => setTimeout(r, 20));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('.leaflet-navdata-pane')).toBeNull();
  });
});

describe('NavdataOverlay', () => {
  afterEach(async () => {
    await flushAnimationFrames();
    vi.restoreAllMocks();
  });

  it('renders no controls and fetches no features when the replica is absent', async () => {
    stubCanvasContext();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/navdata/status') return new Response(JSON.stringify(absentStatus), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <FlightMap points={track}>
        <NavdataOverlay />
      </FlightMap>
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/navdata/status', expect.anything()));
    await new Promise(r => setTimeout(r, 20));

    expect(screen.queryByText('Navdata')).toBeNull();
    expect(container.querySelector('.leaflet-navdata-pane')).toBeNull();
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/api/navdata/features'))).toBe(false);
  });

  it('creates the pane and renders the controls when the replica is present', async () => {
    stubCanvasContext();
    mockFetchRoutes({ '/api/navdata/status': [200, presentStatus] });
    const { container } = render(
      <FlightMap points={track}>
        <NavdataOverlay />
      </FlightMap>
    );
    await waitFor(() => expect(screen.getByText('Navdata')).toBeInTheDocument());
    expect(container.querySelector('.leaflet-navdata-pane')).not.toBeNull();
  });
});
