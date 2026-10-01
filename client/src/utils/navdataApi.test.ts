import { describe, it, expect } from 'vitest';
import { mockFetchRoutes } from '../test/mockFetch';
import { currentLnmDataset, expiredNoCycleDataset, mcduDataset, sourceResponse, undatedLnmDataset } from '../test/navdataFixtures';
import { fetchNavdataSource, paddedBbox, saveNavdataSource, validityText } from './navdataApi';

const view = (west: number, south: number, east: number, north: number) => ({ west, south, east, north });

describe('paddedBbox', () => {
  it('pads a plain view by 20% on each side', () => {
    const [w, s, e, n] = paddedBbox(view(10, 40, 20, 50));
    expect([w, s, e, n]).toEqual([8, 38, 22, 52]);
  });

  it('folds a view panned past the dateline into [-180,180] with west > east', () => {
    const [w, , e] = paddedBbox(view(170, 0, 190, 10));
    expect(w).toBeCloseTo(166);
    expect(e).toBeCloseTo(-166);
    expect(w).toBeGreaterThan(e);
  });

  it('folds a view panned west of -180 the same way', () => {
    const [w, , e] = paddedBbox(view(-200, 0, -170, 10));
    expect(w).toBeGreaterThan(0);
    expect(e).toBeLessThan(0);
  });

  it('clamps a view of 360 degrees or more to the whole world', () => {
    const [w, , e] = paddedBbox(view(-300, -10, 300, 10));
    expect([w, e]).toEqual([-180, 180]);
  });

  it('clamps latitude', () => {
    const [, s, , n] = paddedBbox(view(0, -89, 10, 89));
    expect([s, n]).toEqual([-90, 90]);
  });
});

describe('validityText', () => {
  it('is empty when the dataset has no valid-through date', () => {
    expect(validityText(undatedLnmDataset)).toBe('');
    expect(validityText(mcduDataset)).toBe('');
    expect(validityText({ ...currentLnmDataset, validThrough: null })).toBe('');
  });

  it('gives the window when both ends are known, whether or not it has passed', () => {
    expect(validityText(currentLnmDataset)).toBe(' · valid 2099-01-02 – 2099-01-29');
    expect(validityText({ ...currentLnmDataset, expired: true })).toBe(' · valid 2099-01-02 – 2099-01-29');
  });

  it('gives only the end when the start is unknown', () => {
    expect(validityText(expiredNoCycleDataset)).toBe(' · valid until 2020-01-29');
  });
});

describe('navdata source helpers', () => {
  it('fetchNavdataSource reads the source endpoint', async () => {
    mockFetchRoutes({ '/api/settings/navdata-source': { GET: [200, sourceResponse({ selected: 'lnm' })] } });
    expect((await fetchNavdataSource()).selected).toBe('lnm');
  });

  it('saveNavdataSource puts the source as JSON and returns the answer', async () => {
    const seen: { method?: string; headers?: HeadersInit; body?: string }[] = [];
    mockFetchRoutes({
      '/api/settings/navdata-source': {
        PUT: init => {
          seen.push({ method: init?.method, headers: init?.headers, body: init?.body as string });
          return [200, sourceResponse({ selected: 'lnm', effective: 'lnm' })];
        },
      },
    });

    const r = await saveNavdataSource('lnm');

    expect(r.effective).toBe('lnm');
    expect(seen).toEqual([{ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"source":"lnm"}' }]);
  });

  it('saveNavdataSource rejects with the server message on a refusal', async () => {
    mockFetchRoutes({
      '/api/settings/navdata-source': { PUT: [409, { error: 'No Little Navmap data has been imported', code: 'LNM_NOT_AVAILABLE' }] },
    });
    await expect(saveNavdataSource('lnm')).rejects.toThrow('No Little Navmap data has been imported');
  });
});
