import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapContainer } from 'react-leaflet';
import L from 'leaflet';
import {
  AIRPORT_LABEL_COLLISION_PX, airportGlyph, chooseLabelledCandidates, compareAirportLabelPriority,
  NavdataLayers, NavdataPanes, unwrapAirwayLeg, unwrapPoint,
  type LabelCandidate, type NavdataVisibility,
} from './NavdataLayers';
import { emptyFeatures } from '../../test/navdataFixtures';
import type { FeatureAirport, FeatureNavaid, FeatureRunway, FeatureWaypoint, FeaturesResponse } from '../../types';

describe('antimeridian unwrapping', () => {
  it('draws a dateline airway leg through the unwrapped chain, not across the world', () => {
    const [from, to] = unwrapAirwayLeg([0, 179], [0, 179.5], [0, -179.5]);
    expect(from).toEqual([0, 179.5]);
    expect(to).toEqual([0, 180.5]);
  });

  it('places a leg anchored east of the dateline in the same frame', () => {
    const [from, to] = unwrapAirwayLeg([0, -179], [0, 179.5], [0, -179.5]);
    expect(from[1]).toBeCloseTo(-180.5);
    expect(to[1]).toBeCloseTo(-179.5);
  });

  it('puts a marker position beside the anchor, not a world-copy away', () => {
    expect(unwrapPoint([5, 181], 5, -179)).toEqual([5, 181]);
    expect(unwrapPoint([5, -181], 5, 179)).toEqual([5, -181]);
  });
});


// jsdom has no real <canvas> 2D context, and the runway polyline always draws
// through Leaflet's own canvas renderer (never the SVG one), so exercising it
// here needs a context stub — every draw call is a no-op, only property
// assignment is kept, which is all the renderer needs to not throw.
function stubCanvasContext(): Record<PropertyKey, unknown> {
  const target: Record<PropertyKey, unknown> = {};
  const fakeCtx = new Proxy(
    target,
    {
      get: (t, prop) => (prop in t ? t[prop as PropertyKey] : () => undefined),
      set: (t, prop, value) => {
        t[prop as PropertyKey] = value;
        return true;
      },
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
  return target;
}

describe('runway-end labels', () => {
  const allOff: NavdataVisibility = { airports: false, navaids: false, waypoints: false, airways: false, runways: false };

  beforeEach(() => stubCanvasContext());

  function runway(over: Partial<FeatureRunway> = {}): FeatureRunway {
    return {
      airport: 'ZZAA', lat: 10, lon: 20, headingDeg: 140, lengthM: 2000, widthM: 45,
      designation: '14L', secondaryDesignation: '32R',
      ...over,
    };
  }

  function renderRunways(runways: FeatureRunway[], runwaysVisible: boolean) {
    const data = emptyFeatures({ runways });
    return render(
      <MapContainer center={[10, 20]} zoom={13} style={{ height: 300, width: 300 }}>
        <NavdataPanes>
          <NavdataLayers data={data} anchor={[10, 20]} visible={{ ...allOff, runways: runwaysVisible }} />
        </NavdataPanes>
      </MapContainer>
    );
  }

  // Runway-end labels are the only rotated element this layer draws — the
  // dot-plus-text markers for waypoints/navaids/airports never rotate.
  function rotatedLabels(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('div'))
      .filter(el => (el.getAttribute('style') ?? '').includes('rotate('))
      .map(el => ({ text: el.textContent, style: el.getAttribute('style') ?? '' }));
  }

  it('draws both ends, each rotated to its own approach heading', () => {
    const { container } = renderRunways([runway()], true);
    const labels = rotatedLabels(container);
    expect(labels).toHaveLength(2);
    const primary = labels.find(l => l.text === '14L');
    const secondary = labels.find(l => l.text === '32R');
    expect(primary?.style).toContain('rotate(140deg)');
    expect(secondary?.style).toContain('rotate(320deg)');
  });

  it('wraps the secondary end past 360 back into 0-360', () => {
    const { container } = renderRunways([runway({ headingDeg: 250, designation: '25', secondaryDesignation: '07' })], true);
    const labels = rotatedLabels(container);
    const primary = labels.find(l => l.text === '25');
    const secondary = labels.find(l => l.text === '07');
    expect(primary?.style).toContain('rotate(250deg)');
    expect(secondary?.style).toContain('rotate(70deg)');
  });

  it('draws only the primary label when the secondary designation is unknown', () => {
    const { container } = renderRunways([runway({ secondaryDesignation: '' })], true);
    const labels = rotatedLabels(container);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe('14L');
    expect(labels[0].style).toContain('rotate(140deg)');
  });

  it('draws only the secondary label when the primary designation is unknown', () => {
    const { container } = renderRunways([runway({ designation: '' })], true);
    const labels = rotatedLabels(container);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe('32R');
    expect(labels[0].style).toContain('rotate(320deg)');
  });

  it('draws no runway labels at all when runways are hidden', () => {
    const { container } = renderRunways([runway()], false);
    expect(rotatedLabels(container)).toHaveLength(0);
  });
});

describe('airport glyphs', () => {
  const allOff: NavdataVisibility = { airports: false, navaids: false, waypoints: false, airways: false, runways: false };

  function airport(over: Partial<FeatureAirport> = {}): FeatureAirport {
    return {
      ident: 'ZZAA', lat: 10, lon: 20, name: null, hasDetail: true, runways: 1, procedures: 1,
      longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null,
      ...over,
    };
  }

  function renderAirports(airports: FeatureAirport[]) {
    const data = emptyFeatures({ airports });
    return render(
      <MapContainer center={[10, 20]} zoom={13} style={{ height: 300, width: 300 }}>
        <NavdataPanes>
          <NavdataLayers data={data} anchor={[10, 20]} visible={{ ...allOff, airports: true }} />
        </NavdataPanes>
      </MapContainer>
    );
  }

  // The `data-*` attributes are the contract: a test reads the glyph's own
  // claim off them, never the inline CSS that renders it.
  function glyphEls(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('div[data-glyph]')).map(el => ({
      ident: el.textContent,
      shape: el.getAttribute('data-glyph'),
      size: el.getAttribute('data-size'),
      color: el.getAttribute('data-color'),
      fill: el.getAttribute('data-fill'),
    }));
  }

  function directionLines(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('span[data-direction-line]')).map(el => ({
      rotateDeg: el.getAttribute('data-rotate-deg'),
      style: el.getAttribute('style') ?? '',
    }));
  }

  it('renders the unknown diamond with no color claim and no line for an index-only airport (nothing known)', () => {
    const { container } = renderAirports([airport({ ident: 'ZZAA', longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null })]);
    const [g] = glyphEls(container);
    expect(g).toEqual({ ident: 'ZZAA', shape: 'diamond', size: '8', color: 'none', fill: 'none' });
    expect(directionLines(container)).toHaveLength(0);
  });

  it('is not the same claim as a known small/soft/untowered airport', () => {
    const indexOnly = airportGlyph(airport({ longestRunwayM: null, surface: null, towered: null }));
    const smallSoftUntowered = airportGlyph(airport({ longestRunwayM: 900, surface: 'soft', towered: false }));
    expect(indexOnly).not.toEqual(smallSoftUntowered);
  });

  it('colors a towered airport blue', () => {
    const { container } = renderAirports([airport({ ident: 'ZZTW', longestRunwayM: 1500, surface: 'soft', towered: true })]);
    const [g] = glyphEls(container);
    expect(g.color).toBe('#78a9ff');
  });

  it('colors an uncontrolled airport purple', () => {
    const { container } = renderAirports([airport({ ident: 'ZZNT', longestRunwayM: 1500, surface: 'soft', towered: false })]);
    const [g] = glyphEls(container);
    expect(g.color).toBe('#be95ff');
  });

  it('colors a tower-unknown airport gray, distinct from both towered and untowered', () => {
    const { container } = renderAirports([airport({ ident: 'ZZUK', longestRunwayM: 900, surface: 'soft', towered: null })]);
    const [g] = glyphEls(container);
    expect(g.color).toBe('#a8a8a8');
    expect(g.color).not.toBe('#78a9ff');
    expect(g.color).not.toBe('#be95ff');
  });

  it('renders a paved airport hollow', () => {
    const { container } = renderAirports([airport({ ident: 'ZZPV', longestRunwayM: 3714.5, surface: 'paved', towered: true })]);
    const [g] = glyphEls(container);
    expect(g).toEqual({ ident: 'ZZPV', shape: 'disc', size: '18', color: '#78a9ff', fill: 'hollow' });
  });

  it('renders a soft-field airport filled', () => {
    const { container } = renderAirports([airport({ ident: 'ZZSF', longestRunwayM: 1500, surface: 'soft', towered: false })]);
    const [g] = glyphEls(container);
    expect(g).toEqual({ ident: 'ZZSF', shape: 'disc', size: '13', color: '#be95ff', fill: 'filled' });
  });

  it('renders a water airport filled, same treatment as soft', () => {
    const { container } = renderAirports([airport({ ident: 'ZZWT', longestRunwayM: 1100, surface: 'water', towered: true })]);
    const [g] = glyphEls(container);
    expect(g).toEqual({ ident: 'ZZWT', shape: 'disc', size: '9', color: '#78a9ff', fill: 'filled' });
  });

  it('renders a surface-unknown airport as reduced-opacity filled, distinct from both hollow and filled', () => {
    const { container } = renderAirports([airport({ ident: 'ZZSU', longestRunwayM: 1500, surface: null, towered: true })]);
    const [g] = glyphEls(container);
    expect(g.fill).toBe('faded');
  });

  it('draws a runway-direction line at the mod-180 rotation for a known heading', () => {
    const { container } = renderAirports([airport({ ident: 'ZZHD', longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: 70 })]);
    const lines = directionLines(container);
    expect(lines).toHaveLength(1);
    expect(lines[0].rotateDeg).toBe('70');
  });

  it('draws the same rotation for headings 180 degrees apart, since a line has no direction', () => {
    const { container } = renderAirports([
      airport({ ident: 'ZZH1', longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: 250 }),
      airport({ ident: 'ZZH2', longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: 70 }),
    ]);
    const lines = directionLines(container);
    expect(lines).toHaveLength(2);
    expect(lines[0].rotateDeg).toBe(lines[1].rotateDeg);
    expect(lines[0].rotateDeg).toBe('70');
  });

  it('draws no line at all when the heading is unknown', () => {
    const { container } = renderAirports([airport({ ident: 'ZZNH', longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: null })]);
    expect(directionLines(container)).toHaveLength(0);
  });

  // The line's own span is a horizontal bar at rest (its long axis lies
  // along screen bearing 090), so pointing it at a given heading needs a
  // -90 correction on top of the raw heading — pinning the actual applied
  // CSS rotation for two cardinal headings catches a constant-90°-off bug
  // that the mod-180 test above would not (a line 90° off at every heading
  // still renders N and N+180 identically).
  it('rotates the CSS transform 90 degrees short of a north heading, since the bar itself rests along bearing 090', () => {
    const { container } = renderAirports([airport({ ident: 'ZZN', longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: 0 })]);
    const [line] = directionLines(container);
    expect(line.style).toContain('rotate(-90deg)');
  });

  it('applies no rotation offset for an east heading, which already matches the bar\'s resting axis', () => {
    const { container } = renderAirports([airport({ ident: 'ZZE', longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: 90 })]);
    const [line] = directionLines(container);
    expect(line.style).toContain('rotate(0deg)');
  });

  it('sizes at the large/medium tier boundary, 2500 m', () => {
    expect(airportGlyph(airport({ longestRunwayM: 2500 })).sizePx).toBe(18);
    expect(airportGlyph(airport({ longestRunwayM: 2499.99 })).sizePx).toBe(13);
  });

  it('sizes at the medium/small tier boundary, 1200 m', () => {
    expect(airportGlyph(airport({ longestRunwayM: 1200 })).sizePx).toBe(13);
    expect(airportGlyph(airport({ longestRunwayM: 1199.99 })).sizePx).toBe(9);
  });

  it('gives an unknown length no size claim at all: an 8px diamond, not a small disc', () => {
    const g = airportGlyph(airport({ longestRunwayM: null }));
    expect(g.shape).toBe('diamond');
    expect(g.sizePx).toBe(8);
  });
});

describe('chooseLabelledCandidates', () => {
  function candidate(over: Partial<LabelCandidate> = {}): LabelCandidate {
    return { key: 'ZZAA', x: 0, y: 0, priorityRank: 0, ...over };
  }

  it('labels two candidates well outside the collision radius', () => {
    const result = chooseLabelledCandidates(
      [candidate({ key: 'A', x: 0, y: 0 }), candidate({ key: 'B', x: 200, y: 0, priorityRank: 1 })],
      AIRPORT_LABEL_COLLISION_PX
    );
    expect(result).toEqual(new Set(['A', 'B']));
  });

  it('labels only the higher-priority candidate when two sit within the collision radius', () => {
    const result = chooseLabelledCandidates(
      [candidate({ key: 'A', x: 0, y: 0, priorityRank: 0 }), candidate({ key: 'B', x: 10, y: 0, priorityRank: 1 })],
      AIRPORT_LABEL_COLLISION_PX
    );
    expect(result).toEqual(new Set(['A']));
  });

  it('ignores input order and decides purely by priorityRank', () => {
    const result = chooseLabelledCandidates(
      [candidate({ key: 'B', x: 10, y: 0, priorityRank: 1 }), candidate({ key: 'A', x: 0, y: 0, priorityRank: 0 })],
      AIRPORT_LABEL_COLLISION_PX
    );
    expect(result).toEqual(new Set(['A']));
  });

  it('lets a third candidate through once it clears every already-labelled one, even close to the suppressed loser', () => {
    // A wins the A/B collision; C sits right next to B (loser, not on the
    // grid) but far enough from A that it collides with nothing labelled.
    const result = chooseLabelledCandidates(
      [
        candidate({ key: 'A', x: 0, y: 0, priorityRank: 0 }),
        candidate({ key: 'B', x: 10, y: 0, priorityRank: 1 }),
        candidate({ key: 'C', x: 60, y: 0, priorityRank: 2 }),
      ],
      AIRPORT_LABEL_COLLISION_PX
    );
    expect(result).toEqual(new Set(['A', 'C']));
  });

  it('completes near-linearly over a large synthetic set (grid-bucketing sanity check)', () => {
    const candidates: LabelCandidate[] = Array.from({ length: 2000 }, (_, i) => ({
      key: `Z${i}`,
      x: (i % 100) * 15,
      y: Math.floor(i / 100) * 15,
      priorityRank: i,
    }));
    const start = performance.now();
    const result = chooseLabelledCandidates(candidates, AIRPORT_LABEL_COLLISION_PX);
    const elapsedMs = performance.now() - start;
    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBeLessThan(candidates.length);
    // Not a strict benchmark — just proof an O(n^2) regression would blow
    // well past this on 2000 candidates in a unit test.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('compareAirportLabelPriority', () => {
  function airport(over: Partial<FeatureAirport> = {}): FeatureAirport {
    return {
      ident: 'ZZAA', lat: 10, lon: 20, name: null, hasDetail: true, runways: 1, procedures: 1,
      longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null,
      ...over,
    };
  }

  it('orders large before medium before small before unknown before other', () => {
    const airports = [
      airport({ ident: 'S', tier: 'small' }),
      airport({ ident: 'O', tier: 'other' }),
      airport({ ident: 'L', tier: 'large' }),
      airport({ ident: 'U', tier: 'unknown' }),
      airport({ ident: 'M', tier: 'medium' }),
    ];
    expect([...airports].sort(compareAirportLabelPriority).map(a => a.ident)).toEqual(['L', 'M', 'S', 'U', 'O']);
  });

  it('ranks a null tier below every classified tier, including other', () => {
    const airports = [airport({ ident: 'NONE', tier: null }), airport({ ident: 'OTHER', tier: 'other' })];
    expect([...airports].sort(compareAirportLabelPriority).map(a => a.ident)).toEqual(['OTHER', 'NONE']);
  });

  it('within a tier, ranks the longer runway first', () => {
    const airports = [
      airport({ ident: 'SHORT', tier: 'large', longestRunwayM: 2600 }),
      airport({ ident: 'LONG', tier: 'large', longestRunwayM: 4000 }),
    ];
    expect([...airports].sort(compareAirportLabelPriority).map(a => a.ident)).toEqual(['LONG', 'SHORT']);
  });

  it('never lets a null longestRunwayM win a tie against a known value', () => {
    const airports = [
      airport({ ident: 'UNKNOWN_LEN', tier: 'small', longestRunwayM: null }),
      airport({ ident: 'KNOWN_LEN', tier: 'small', longestRunwayM: 800 }),
    ];
    expect([...airports].sort(compareAirportLabelPriority).map(a => a.ident)).toEqual(['KNOWN_LEN', 'UNKNOWN_LEN']);
  });

  it('breaks a same-tier, same-runway tie by ident ascending', () => {
    const airports = [
      airport({ ident: 'ZZB', tier: 'medium', longestRunwayM: 1500 }),
      airport({ ident: 'ZZA', tier: 'medium', longestRunwayM: 1500 }),
    ];
    expect([...airports].sort(compareAirportLabelPriority).map(a => a.ident)).toEqual(['ZZA', 'ZZB']);
  });
});

describe('airport labels', () => {
  const allOff: NavdataVisibility = { airports: false, navaids: false, waypoints: false, airways: false, runways: false };

  function airport(over: Partial<FeatureAirport> = {}): FeatureAirport {
    return {
      ident: 'ZZAA', lat: 10, lon: 20, name: null, hasDetail: true, runways: 1, procedures: 1,
      longestRunwayM: null, surface: null, towered: null, longestRunwayHeadingDeg: null, tier: null,
      ...over,
    };
  }

  function renderAirports(airports: FeatureAirport[]) {
    const data = emptyFeatures({ airports });
    return render(
      <MapContainer center={[10, 20]} zoom={13} style={{ height: 300, width: 300 }}>
        <NavdataPanes>
          <NavdataLayers data={data} anchor={[10, 20]} visible={{ ...allOff, airports: true }} />
        </NavdataPanes>
      </MapContainer>
    );
  }

  // The real Leaflet projection is nonlinear and zoom-dependent — unrelated to
  // what the collision pass itself needs proven. A flat px-per-degree stand-in
  // makes the on-screen distance between two synthetic airports exactly what
  // each test says it is, the same way `stubCanvasContext()` above stands in
  // for a real canvas 2D context.
  function stubContainerPoint(pxPerDegree: number) {
    return vi.spyOn(L.Map.prototype, 'latLngToContainerPoint').mockImplementation((latlng => {
      const { lat, lng } = L.latLng(latlng as L.LatLngExpression);
      return L.point(lng * pxPerDegree, lat * pxPerDegree);
    }) as L.Map['latLngToContainerPoint']);
  }

  afterEach(() => vi.restoreAllMocks());

  it('labels both airports of a same-tier pair placed well apart on screen', () => {
    stubContainerPoint(10_000); // 0.01 deg lon apart -> 100px, above the 42px threshold
    renderAirports([
      airport({ ident: 'ZZFAR1', lat: 10, lon: 20, tier: 'large' }),
      airport({ ident: 'ZZFAR2', lat: 10, lon: 20.01, tier: 'large' }),
    ]);
    expect(screen.getByText('ZZFAR1')).toBeInTheDocument();
    expect(screen.getByText('ZZFAR2')).toBeInTheDocument();
  });

  it('labels only the higher-priority airport of a pair placed close together on screen', () => {
    stubContainerPoint(10_000); // 0.001 deg lon apart -> 10px, inside the 42px threshold
    renderAirports([
      airport({ ident: 'ZZSHORT', lat: 10, lon: 20, tier: 'large', longestRunwayM: 2600 }),
      airport({ ident: 'ZZLONG', lat: 10, lon: 20.001, tier: 'large', longestRunwayM: 4000 }),
    ]);
    // ZZLONG has the longer runway within the same tier, so it wins the collision.
    expect(screen.getByText('ZZLONG')).toBeInTheDocument();
    expect(screen.queryByText('ZZSHORT')).toBeNull();
  });

  it('still draws the suppressed airport\'s glyph, just without its ident label', () => {
    stubContainerPoint(10_000);
    const { container } = renderAirports([
      airport({ ident: 'ZZSHORT', lat: 10, lon: 20, tier: 'large', longestRunwayM: 2600 }),
      airport({ ident: 'ZZLONG', lat: 10, lon: 20.001, tier: 'large', longestRunwayM: 4000 }),
    ]);
    expect(container.querySelectorAll('div[data-glyph]')).toHaveLength(2);
  });

  it('prefers a large-tier airport over a close small-tier one, tier ranking before proximity order', () => {
    stubContainerPoint(10_000);
    renderAirports([
      airport({ ident: 'ZZSMALL', lat: 10, lon: 20, tier: 'small' }),
      airport({ ident: 'ZZBIG', lat: 10, lon: 20.001, tier: 'large' }),
    ]);
    expect(screen.getByText('ZZBIG')).toBeInTheDocument();
    expect(screen.queryByText('ZZSMALL')).toBeNull();
  });

  it('leaves glyph shape, color, fill and the direction line unaffected by label suppression', () => {
    stubContainerPoint(10_000);
    // A tight cluster (10px pitch, well under the 42px threshold) so only the
    // first-ranked airport keeps its label — the glyph markup for every
    // other airport must still be present.
    const cluster = Array.from({ length: 20 }, (_, i) => airport({
      ident: `ZZ${i}`, lat: 10, lon: 20 + i * 0.001,
      longestRunwayM: 1500, surface: 'paved', towered: true, longestRunwayHeadingDeg: 70, tier: 'small',
    }));
    const { container } = renderAirports(cluster);
    const glyphs = container.querySelectorAll<HTMLElement>('div[data-glyph]');
    expect(glyphs).toHaveLength(20);
    expect(glyphs[0].getAttribute('data-glyph')).toBe('disc');
    expect(glyphs[0].getAttribute('data-size')).toBe('13');
    expect(glyphs[0].getAttribute('data-color')).toBe('#78a9ff');
    expect(glyphs[0].getAttribute('data-fill')).toBe('hollow');
    expect(container.querySelectorAll('span[data-direction-line]')).toHaveLength(20);
    // Some, but not all, of the tightly-packed idents keep their label.
    const labels = container.querySelectorAll('span[style*="text-shadow:0 0 3px #161616"]');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(20);
  });

  it('labels every airport of a sparse set, regardless of tier', () => {
    stubContainerPoint(10_000); // 0.1 deg apart -> 1000px, far outside the threshold
    renderAirports([
      airport({ ident: 'ZZS1', lat: 10, lon: 20, tier: 'small' }),
      airport({ ident: 'ZZS2', lat: 10, lon: 20.1, tier: 'unknown' }),
    ]);
    expect(screen.getByText('ZZS1')).toBeInTheDocument();
    expect(screen.getByText('ZZS2')).toBeInTheDocument();
  });
});

describe('waypoint markers', () => {
  const allOff: NavdataVisibility = { airports: false, navaids: false, waypoints: false, airways: false, runways: false };

  function waypoint(over: Partial<FeatureWaypoint> = {}): FeatureWaypoint {
    return { key: 'W1', ident: 'ZAKRO', region: 'ZZ', lat: 10, lon: 20, terminal: null, ...over };
  }

  function navaid(over: Partial<FeatureNavaid> = {}): FeatureNavaid {
    return { kind: 'V', ident: 'ZZVR', region: 'ZZ', lat: 10, lon: 20, frequencyHz: null, name: null, navType: null, isDme: null, isNav: null, isTacan: null, magvar: null, ...over };
  }

  function renderNavdata(data: Partial<FeaturesResponse>, visible: Partial<NavdataVisibility>) {
    const full = emptyFeatures(data);
    return render(
      <MapContainer center={[10, 20]} zoom={13} style={{ height: 300, width: 300 }}>
        <NavdataPanes>
          <NavdataLayers data={full} anchor={[10, 20]} visible={{ ...allOff, ...visible }} />
        </NavdataPanes>
      </MapContainer>
    );
  }

  it('draws the labelled waypoint as a hollow magenta triangle, not a filled dot', () => {
    const { container } = renderNavdata({ waypoints: [waypoint()] }, { waypoints: true });
    const polygon = container.querySelector('svg polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('fill')).toBe('none');
    expect(polygon!.getAttribute('stroke')).toBe('#be95ff');
    // no dot markup like the other labelled navdata markers use
    expect(container.querySelector('span[style*="border-radius:50%"]')).toBeNull();
  });

  it('labels the waypoint magenta with the same halo as every other navdata label', () => {
    renderNavdata({ waypoints: [waypoint({ ident: 'ZAKRO' })] }, { waypoints: true });
    const label = screen.getByText('ZAKRO');
    const style = label.getAttribute('style') ?? '';
    expect(style).toContain('color:#be95ff');
    expect(style).toContain('text-shadow:0 0 3px #161616');
  });

  it('keeps the dense fallback a canvas CircleMarker recolored to magenta, not a per-node icon', async () => {
    const ctx = stubCanvasContext();
    const dense = Array.from({ length: 151 }, (_, i) => waypoint({ key: `W${i}`, ident: `W${i}`, lat: 10 + i * 0.001 }));
    const { container } = renderNavdata({ waypoints: dense }, { waypoints: true });
    // Leaflet's canvas renderer schedules its draw on the next frame.
    await new Promise(r => setTimeout(r, 50));
    expect(container.querySelector('svg polygon')).toBeNull();
    expect(container.querySelector('.leaflet-marker-icon')).toBeNull();
    expect(ctx.strokeStyle).toBe('#be95ff');
  });

  it('draws a default navaid as the basic sky-blue circle, not a dot, with the usual label styling', () => {
    const { container } = renderNavdata({ navaids: [navaid({ ident: 'ZZVR' })] }, { navaids: true });
    expect(container.querySelector('svg polygon')).toBeNull();
    const root = container.querySelector('[data-navaid-symbol="basic"]');
    expect(root).not.toBeNull();
    expect(root!.querySelector('svg circle')!.getAttribute('stroke')).toBe('#33b1ff');
    expect(container.querySelector('span[style*="border-radius:50%"]')).toBeNull();
    const label = screen.getByText('ZZVR');
    const style = label.getAttribute('style') ?? '';
    expect(style).toContain('color:#f4f4f4');
    expect(style).toContain('text-shadow:0 0 3px #161616');
  });

  it('draws a VOR/DME with a compass rose turned by minus its west variation', () => {
    const { container } = renderNavdata(
      { navaids: [navaid({ isNav: true, isTacan: false, isDme: true, magvar: 20, frequencyHz: 116500000 })] },
      { navaids: true },
    );
    const root = container.querySelector('[data-navaid-symbol="vordme"]');
    expect(root!.getAttribute('data-navaid-rose')).toBe('340.0');
    expect(screen.getByText('116.50')).toBeInTheDocument();
  });

  it('draws no rose when more than 40 rose-eligible stations are in view', () => {
    const vors = Array.from({ length: 41 }, (_, i) =>
      navaid({ ident: `V${i}`, lat: 10 + i * 0.001, isNav: true, isTacan: false, isDme: false, magvar: 20 }));
    const { container } = renderNavdata({ navaids: vors }, { navaids: true });
    expect(container.querySelectorAll('[data-navaid-symbol="vor"]')).toHaveLength(41);
    expect(container.querySelector('[data-navaid-rose]:not([data-navaid-rose="none"])')).toBeNull();
  });

  it('keeps the dense fallback a canvas CircleMarker for navaids, not a per-node icon', async () => {
    const ctx = stubCanvasContext();
    const dense = Array.from({ length: 151 }, (_, i) => navaid({ ident: `N${i}`, lat: 10 + i * 0.001 }));
    const { container } = renderNavdata({ navaids: dense }, { navaids: true });
    await new Promise(r => setTimeout(r, 50));
    expect(container.querySelector('.leaflet-marker-icon')).toBeNull();
    expect(container.querySelector('[data-navaid-symbol]')).toBeNull();
    expect(ctx.strokeStyle).toBe('#33b1ff');
  });

});
