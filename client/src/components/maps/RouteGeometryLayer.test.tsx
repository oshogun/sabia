import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MapContainer } from 'react-leaflet';
import {
  FetchDetailPrompt,
  buildGeometryPaths,
  detailTargets,
  geometryHasChains,
  procedureNote,
  useRouteGeometry,
} from './RouteGeometryLayer';
import { mockFetchRoutes } from '../../test/mockFetch';
import { currentLnmDataset, lnmStatus, presentStatus } from '../../test/navdataFixtures';
import type { GeometryChain, GeometryPoint, PlannedLegWithChildren, RouteGeometryResponse } from '../../types';

const empty: GeometryChain = { source: null, synthetic: false, points: [], arcs: [] };
const pt = (lat: number, lon: number, ident: string | null = null): GeometryPoint => ({
  lat, lon, ident, legType: null, flyOver: null, altitude1M: null, altitude2M: null, speedLimitKt: null,
});

function geometry(over: Partial<RouteGeometryResponse> = {}): RouteGeometryResponse {
  return {
    legId: 7,
    origin: { ident: 'ZZAA', lat: 10, lon: 20, isAirport: true },
    destination: { ident: 'ZZBB', lat: 11, lon: 21, isAirport: true },
    sid: empty, enroute: empty, star: empty, approach: empty,
    skippedLegs: 0,
    skippedByChain: { sid: 0, enroute: 0, star: 0, approach: 0 },
    unresolved: [],
    ...over,
  };
}

const leg = {
  sid_name: 'ZZAA28', star_name: null, approach_name: 'ZZBB31',
} as unknown as PlannedLegWithChildren;

describe('procedureNote', () => {
  it('is today\'s line for an empty answer', () => {
    const today = 'SID ZZAA28 · APP ZZBB31 (planned route excludes SID/STAR/approach legs)';
    expect(procedureNote(leg)).toBe(today);
    expect(procedureNote(leg, null)).toBe(today);
    expect(procedureNote(leg, geometry())).toBe(today);
  });

  it('explains a drawn custom procedure without apologising', () => {
    const g = geometry({
      approach: { source: 'ZZBB31', synthetic: true, points: [pt(11, 20.9), pt(11, 21)], arcs: [] },
    });
    const note = procedureNote(leg, g) ?? '';
    expect(note).toContain('custom APP, not a simulator procedure — drawn from the runway');
    expect(note).not.toContain('excludes');
  });

  it('gives a plain reason, never an error, when a custom chain could not be built', () => {
    const g = geometry({ unresolved: [{ kind: 'approach', name: 'ZZBB31', reason: 'custom procedure, no runway' }] });
    expect(procedureNote(leg, g)).toContain('APP ZZBB31 — custom procedure, not a simulator procedure — runway detail not fetched yet');
  });

  it('says an approach without a runway is not drawn', () => {
    const g = geometry({ unresolved: [{ kind: 'approach', name: 'ZZDD09', reason: 'approach runway not specified' }] });
    expect(procedureNote(leg, g)).toContain('APP ZZDD09 — runway not specified, so not drawn');
  });

  it('names an unresolved custom procedure once and promises a fetch only for an airport', () => {
    const only = { sid_name: null, star_name: null, approach_name: 'ZZCC09' } as unknown as PlannedLegWithChildren;
    const unresolved = [{ kind: 'approach' as const, name: 'ZZCC09', reason: 'custom procedure, no runway' as const }];
    const dest = (isAirport: boolean | null) =>
      ({ ident: 'ZZCC', lat: 1, lon: 2, isAirport }) as unknown as RouteGeometryResponse['destination'];
    expect(procedureNote(only, geometry({ unresolved, destination: dest(true) }))).toBe(
      'APP ZZCC09 — custom procedure, not a simulator procedure — runway detail not fetched yet'
    );
    for (const flag of [false, null]) {
      const note = procedureNote(only, geometry({ unresolved, destination: dest(flag) })) ?? '';
      expect(note).toBe('APP ZZCC09 — custom procedure, not a simulator procedure — could not be drawn');
      expect(note).not.toContain('not fetched yet');
    }
  });
});

describe('buildGeometryPaths', () => {
  it('keeps a dateline-crossing chain continuous and joins the ends with dashed connectors', () => {
    const g = geometry({
      origin: { ident: 'ZZAA', lat: 0, lon: 179, isAirport: true },
      destination: { ident: 'ZZBB', lat: 0, lon: -178, isAirport: true },
      enroute: { source: 'planned', synthetic: false, points: [pt(0, 179.5), pt(0, -179.5)], arcs: [] },
    });
    const paths = buildGeometryPaths(g);
    expect(paths.replacesPlanned).toBe(true);
    expect(paths.chains[0].points.map(p => p[1])).toEqual([179.5, 180.5]);
    expect(paths.connectors).toHaveLength(2);
    expect(paths.connectors[1][1][1]).toBeCloseTo(182);
  });

  it('does not join across a missing enroute chain and does not replace the planned polyline', () => {
    const g = geometry({
      sid: { source: 'ZZAA28', synthetic: true, points: [pt(10, 20.1), pt(10, 20.2)], arcs: [] },
      approach: { source: 'ZZBB31', synthetic: true, points: [pt(11, 20.8), pt(11, 20.95)], arcs: [] },
    });
    const paths = buildGeometryPaths(g);
    expect(paths.replacesPlanned).toBe(false);
    expect(paths.connectors).toHaveLength(2);
    expect(geometryHasChains(g)).toBe(true);
  });

  it('expands an arc into 24 segments', () => {
    const g = geometry({
      enroute: {
        source: 'planned', synthetic: false,
        points: [pt(0, 0.1), pt(0.1, 0)], arcs: [{ fromIndex: 0, toIndex: 1, centerLat: 0, centerLon: 0, turn: 'L' }],
      },
    });
    expect(buildGeometryPaths(g).chains[0].path).toHaveLength(2 + 23);
  });
});

describe('fetch detail', () => {
  const noRunway = { kind: 'approach' as const, name: 'ZZBB31', reason: 'custom procedure, no runway' as const };

  it('is offered only for an endpoint that is an airport', () => {
    expect(detailTargets(geometry({ unresolved: [noRunway] })).map(t => t.ident)).toEqual(['ZZBB']);
    const snippet = geometry({
      destination: { ident: 'ZZBB', lat: 11, lon: 21, isAirport: false },
      unresolved: [noRunway],
    });
    expect(detailTargets(snippet)).toEqual([]);
    expect(detailTargets(geometry({ destination: null, unresolved: [noRunway] }))).toEqual([]);
  });

  it('renders a button for a target and nothing for none', () => {
    const { container, rerender } = render(
      <MapContainer><FetchDetailPrompt targets={[]} /></MapContainer>
    );
    expect(container.querySelector('button')).toBeNull();
    rerender(<MapContainer><FetchDetailPrompt targets={[{ ident: 'ZZBB', why: 'x' }]} /></MapContainer>);
    expect(screen.getByRole('button', { name: 'Fetch detail' })).toBeInTheDocument();
  });

  it('renders nothing while the imported Little Navmap data is the source', async () => {
    mockFetchRoutes({ '/api/navdata/status': [200, lnmStatus(currentLnmDataset)] });
    const targets = [{ ident: 'ZZBB', why: 'x' }];
    const { container } = render(<MapContainer><FetchDetailPrompt targets={targets} /></MapContainer>);

    await waitFor(() => expect(container.querySelector('button')).toBeNull());
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(0);
  });

  it('keeps the button for the simulator source once the status is known', async () => {
    mockFetchRoutes({ '/api/navdata/status': [200, presentStatus] });
    render(<MapContainer><FetchDetailPrompt targets={[{ ident: 'ZZBB', why: 'x' }]} /></MapContainer>);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(screen.getByRole('button', { name: 'Fetch detail' })).toBeInTheDocument();
  });

  it('does not poll the status while there is nothing to offer', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<MapContainer><FetchDetailPrompt targets={[]} /></MapContainer>);
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useRouteGeometry', () => {
  it('requests the geometry again once when the status poll reports a new snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let snapshotId = 'snap-a';
      const geometryCalls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/navdata/status') return new Response(JSON.stringify({ ...presentStatus, snapshotId }), { status: 200 });
        if (url === '/api/planned-legs/7/route-geometry') {
          geometryCalls.push(url);
          return new Response(JSON.stringify(geometry()), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }));

      const { result } = renderHook(() => useRouteGeometry([7]));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(geometryCalls).toHaveLength(1);
      expect(result.current.geometries[7]?.legId).toBe(7);

      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(geometryCalls).toHaveLength(1);

      snapshotId = 'snap-b';
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(geometryCalls).toHaveLength(2);
      expect(result.current.geometries[7]?.legId).toBe(7);

      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(geometryCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
