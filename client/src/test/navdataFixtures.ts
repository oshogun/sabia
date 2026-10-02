import type {
  FeaturesResponse, LnmImportFilesResponse, LnmImportJob, NavdataDataset, NavdataSourceResponse, NavdataStatusResponse,
} from '../types';

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

/** The import folder's answer: one small file, room for a 2 GiB upload and plenty of free space. */
export function importFiles(over: Partial<LnmImportFilesResponse> = {}): LnmImportFilesResponse {
  return {
    dir: '/srv/navdata',
    files: [{ name: 'lnm_test.sqlite', sizeBytes: 5_000_000, modifiedAt: 1 }],
    maxUploadBytes: 2 * 2 ** 30,
    availableBytes: 50 * 2 ** 30,
    reserveBytes: 1.25 * 2 ** 30,
    ...over,
  };
}

/** A running import job; override `state` and the fields that go with it for the other states. */
export function importJob(over: Partial<LnmImportJob> = {}): LnmImportJob {
  return {
    id: 'job-1', origin: 'upload', sourceFileName: 'lnm_test.sqlite', sourceBytes: 5_000_000,
    state: 'running', stage: 'airports', fraction: 0.5, startedAt: 1_000, finishedAt: null,
    error: null, result: null,
    ...over,
  };
}

export function succeededJob(over: Partial<LnmImportJob> = {}): LnmImportJob {
  return importJob({
    state: 'succeeded', stage: 'swapping', fraction: 1, finishedAt: Date.now(),
    result: {
      dataset: currentLnmDataset,
      counts: {
        airports: 1, runways: 1, frequencies: 1, navaids: 1, waypoints: 1, airwayLegs: 1, procedures: 1,
        transitions: 1, legs: 1, coverageCells: 1,
      },
      warnings: 0,
    },
    ...over,
  });
}

/**
 * A stand-in for XMLHttpRequest that records what the code under test does and
 * lets a test drive the answer. Install with
 * `vi.stubGlobal('XMLHttpRequest', FakeXhr)` after `FakeXhr.instances = []`.
 */
export class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  body: unknown = null;
  headers: Record<string, string> = {};
  status = 0;
  responseText = '';
  aborted = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  /** The connection drops. */
  fail() {
    this.onerror?.();
  }

  /** Bytes of the request body that have gone out. */
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  /** The server's answer. */
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
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
