import type { FeaturesResponse, NavdataDataset, NavdataSourceResponse, NavdataStatusResponse } from '../types';

// Synthetic idents, coordinates, dataset labels and dates only.

export const mcduDataset: NavdataDataset = {
  source: 'mcdu', label: 'Simulator', provider: null, airacCycle: null, validFrom: null, validThrough: null,
  expired: null, compiledAt: null, navigraphUpdate: null, importedAt: 1,
};

const lnmDataset: NavdataDataset = {
  source: 'lnm', label: 'Test dataset', provider: 'NAVIGRAPH', airacCycle: null, validFrom: null, validThrough: null,
  expired: null, compiledAt: null, navigraphUpdate: null, importedAt: 2,
};

/** A current AIRAC cycle with a validity window. */
export const currentLnmDataset: NavdataDataset = {
  ...lnmDataset, label: 'Navigraph AIRAC 9901', airacCycle: '9901',
  validFrom: '2099-01-02', validThrough: '2099-01-29', expired: false,
};

/** Past its valid-through date; the server says so in `expired`. */
export const expiredLnmDataset: NavdataDataset = {
  ...lnmDataset, label: 'Navigraph AIRAC 2001', airacCycle: '2001',
  validFrom: '2020-01-02', validThrough: '2020-01-29', expired: true,
};

/** Validity came from the file's valid-through text while the cycle text was unusable. */
export const expiredNoCycleDataset: NavdataDataset = {
  ...lnmDataset, label: 'Navigraph build 2020-01', airacCycle: null, validFrom: null,
  validThrough: '2020-01-29', expired: true,
};

/** A scenery build with no cycle and no validity at all. */
export const undatedLnmDataset: NavdataDataset = { ...lnmDataset, label: 'MSFS scenery, compiled 2099-01-01', provider: 'MSFS' };

export const presentStatus: NavdataStatusResponse = {
  present: true, schemaVersion: 1, snapshotId: 'snap-zz', rev: 1, simId: '2024',
  simAppName: null, simAppVersion: null, snapshotAppliedAt: 1, lastRowsAt: null,
  counts: null, sidecar: null,
  source: 'mcdu', selectedSource: 'mcdu', sourceFallback: null, dataset: mcduDataset,
};

export const absentStatus: NavdataStatusResponse = {
  ...presentStatus, present: false, snapshotId: null, rev: null, dataset: null,
};

/** A status answered from the imported Little Navmap replica. */
export function lnmStatus(dataset: NavdataDataset): NavdataStatusResponse {
  return { ...presentStatus, source: 'lnm', selectedSource: 'lnm', dataset };
}

/** The source endpoint's answer with the simulator selected and Little Navmap data imported. */
export function sourceResponse(over: Partial<NavdataSourceResponse> = {}): NavdataSourceResponse {
  return {
    selected: 'mcdu', effective: 'mcdu', fallback: null,
    mcdu: { present: true, dataset: mcduDataset },
    lnm: { present: true, dataset: currentLnmDataset },
    importDir: '/srv/navdata',
    ...over,
  };
}

const cov = (harvestedCells: number, fraction: number) =>
  ({ harvestedCells, fraction, oldestHarvestAt: null, newestHarvestAt: null });

export function emptyFeatures(over: Partial<FeaturesResponse> = {}): FeaturesResponse {
  return {
    bbox: [0, 0, 1, 1], zoom: 9, gated: [], truncated: false, limit: 2000,
    airports: [], navaids: [], waypoints: [], airways: [], runways: [],
    coverage: {
      totalCells: 4,
      byKind: { V: cov(4, 1), N: cov(4, 1), W: cov(4, 1) },
      airportsComplete: true,
    },
    airportThinning: { mode: 'none', through: null, hidden: 0, byTier: null, nextZoom: null },
    ...over,
  };
}

export { cov };
