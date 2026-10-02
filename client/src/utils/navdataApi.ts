import { apiFetch, reportUnauthorized } from './api';
import type {
  FeaturesResponse,
  LnmImportFilesResponse,
  LnmImportJobResponse,
  RouteGeometryResponse,
  NavdataRequestBody,
  NavdataDataset,
  NavdataRequestResponse,
  NavdataSource,
  NavdataSourceResponse,
  NavdataStatusResponse,
} from '../types';

export type NavdataKind = 'airports' | 'navaids' | 'waypoints' | 'airways' | 'runways';

/** [west, south, east, north]; west > east means the view crosses the antimeridian. */
export type Bbox = [number, number, number, number];

/** The replica is mid-swap. Not a failure: keep what is drawn and retry. */
export class NavdataBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Navdata is updating');
    this.name = 'NavdataBusyError';
  }
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Pads a Leaflet view by 20% and folds it into the server's [-180,180]
 * convention. A view that has been panned past the dateline reports longitudes
 * outside that range; folding them yields west > east, which the server splits
 * into two ranges. A view 360° or wider clamps to the whole world.
 */
export function paddedBbox(b: { west: number; south: number; east: number; north: number }): Bbox {
  const padLon = (b.east - b.west) * 0.2;
  const padLat = (b.north - b.south) * 0.2;
  const south = Math.max(-90, b.south - padLat);
  const north = Math.min(90, b.north + padLat);
  const west = b.west - padLon;
  const east = b.east + padLon;
  if (east - west >= 360) return [-180, south, 180, north];
  const w = wrapLon(west);
  let e = wrapLon(east);
  if (e === -180) e = 180;
  return [w, south, e, north];
}

export async function fetchNavdataStatus(signal?: AbortSignal): Promise<NavdataStatusResponse> {
  return apiFetch<NavdataStatusResponse>('/api/navdata/status', { signal });
}

export async function fetchNavdataSource(signal?: AbortSignal): Promise<NavdataSourceResponse> {
  return apiFetch<NavdataSourceResponse>('/api/settings/navdata-source', { signal });
}

export async function saveNavdataSource(source: NavdataSource): Promise<NavdataSourceResponse> {
  return apiFetch<NavdataSourceResponse>('/api/settings/navdata-source', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
}

/**
 * The validity window to append after a dataset's label: empty when the
 * dataset has no valid-through date, so a current dataset shows its window
 * too, not only an expired one.
 */
export function validityText(d: NavdataDataset): string {
  if (d.validThrough === null) return '';
  return d.validFrom !== null
    ? ` · valid ${d.validFrom} – ${d.validThrough}`
    : ` · valid until ${d.validThrough}`;
}

export async function fetchLnmImport(signal?: AbortSignal): Promise<LnmImportJobResponse> {
  return apiFetch<LnmImportJobResponse>('/api/navdata/lnm-import', { signal });
}

export async function fetchLnmImportFiles(signal?: AbortSignal): Promise<LnmImportFilesResponse> {
  return apiFetch<LnmImportFilesResponse>('/api/navdata/lnm-import/files', { signal });
}

/** Imports a .sqlite file that is already in the server's import folder. Answers with the job just started. */
export async function startLnmPathImport(fileName: string): Promise<LnmImportJobResponse> {
  return apiFetch<LnmImportJobResponse>('/api/navdata/lnm-import/path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });
}

/**
 * Asks the server to stop the running import. Nothing running (409
 * LNM_NOT_RUNNING) is not a failure: the job already ended, so this resolves
 * with `{ job: null }` and the caller reads the job's real state afterwards.
 */
export async function cancelLnmImport(): Promise<LnmImportJobResponse> {
  const res = await fetch('/api/navdata/lnm-import', { method: 'DELETE' });
  if (res.ok) return res.json() as Promise<LnmImportJobResponse>;
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string; code?: string };
  if (res.status === 401) throw reportUnauthorized(body.error || res.statusText);
  if (res.status === 409 && body.code === 'LNM_NOT_RUNNING') return { job: null };
  throw new Error(body.error || res.statusText);
}

/** The connection dropped (or never completed) while an upload was in flight; the server may still have recorded why. */
export class LnmUploadNetworkError extends Error {
  constructor() {
    super('Upload failed — connection closed');
    this.name = 'LnmUploadNetworkError';
  }
}

/** The server answered an upload with a refusal: its message, the HTTP status, and its error code when it sent one. */
export class LnmUploadRefusedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'LnmUploadRefusedError';
  }
}

/** The server's code for an upload attempt it has already received once; a browser's automatic resend of a cut upload gets it. */
export const LNM_UPLOAD_REPEATED = 'LNM_UPLOAD_REPEATED';

const UPLOAD_ATTEMPT_HEADER = 'X-Upload-Attempt';

function abortError(): DOMException {
  return new DOMException('The upload was aborted', 'AbortError');
}

/**
 * Uploads a Little Navmap database as multipart form data. fetch cannot report
 * how many bytes of a request body have gone out, so this uses XMLHttpRequest;
 * `onProgress` gets the bytes sent and the total. No Content-Type is set: the
 * browser adds the multipart boundary, and the Content-Length the server
 * requires. Every call sends a new random attempt id in X-Upload-Attempt. A
 * browser that resends the request after its connection was cut sends the
 * same id again, and the server refuses a second request with an id it has
 * already accepted (LNM_UPLOAD_REPEATED) instead of starting another import.
 * Aborting `signal` closes the request and rejects with an AbortError; a
 * dropped connection rejects with LnmUploadNetworkError; any other refusal
 * rejects with an LnmUploadRefusedError that carries the server's message,
 * status and code.
 */
export function uploadLnmDatabase(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<LnmImportJobResponse> {
  return new Promise<LnmImportJobResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const onSignalAbort = () => xhr.abort();
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onSignalAbort);
      finish();
    };

    // Not crypto.randomUUID: it exists only in secure contexts, and the server can be served over plain HTTP on a LAN.
    const idBytes = crypto.getRandomValues(new Uint8Array(16));
    const attemptId = Array.from(idBytes, b => b.toString(16).padStart(2, '0')).join('');

    xhr.open('POST', '/api/navdata/lnm-import/upload');
    xhr.setRequestHeader(UPLOAD_ATTEMPT_HEADER, attemptId);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => settle(() => {
      let body: { error?: unknown; code?: unknown; job?: unknown } | null = null;
      try {
        body = JSON.parse(xhr.responseText) as { error?: unknown; code?: unknown; job?: unknown } | null;
      } catch {
        body = null;
      }
      const message = typeof body?.error === 'string' && body.error !== '' ? body.error : null;
      const code = typeof body?.code === 'string' && body.code !== '' ? body.code : null;
      if (xhr.status === 401) {
        reject(reportUnauthorized(message ?? undefined));
      } else if (xhr.status === 0) {
        reject(new LnmUploadNetworkError());
      } else if (xhr.status >= 200 && xhr.status < 300 && body && typeof body.job === 'object') {
        resolve(body as unknown as LnmImportJobResponse);
      } else {
        reject(new LnmUploadRefusedError(message ?? `Upload failed (HTTP ${xhr.status})`, xhr.status, code));
      }
    });
    xhr.onerror = () => settle(() => reject(new LnmUploadNetworkError()));
    xhr.ontimeout = () => settle(() => reject(new LnmUploadNetworkError()));
    xhr.onabort = () => settle(() => reject(abortError()));
    signal?.addEventListener('abort', onSignalAbort, { once: true });

    const form = new FormData();
    form.append('lnmDatabase', file);
    xhr.send(form);
  });
}

export async function fetchNavdataFeatures(
  bbox: Bbox,
  zoom: number,
  kinds: NavdataKind[],
  signal?: AbortSignal
): Promise<FeaturesResponse> {
  const params = new URLSearchParams({
    bbox: bbox.map(v => v.toFixed(5)).join(','),
    zoom: String(Math.round(zoom)),
    kinds: kinds.join(','),
  });
  const url = `/api/navdata/features?${params}`;
  const res = await fetch(url, { signal });
  if (res.status === 503) {
    const retry = Number(res.headers.get('Retry-After'));
    throw new NavdataBusyError(Number.isFinite(retry) && retry > 0 ? retry : 2);
  }
  if (!res.ok) {
    if (res.status === 401) {
      // The session handler lives in api.ts and is only reachable through
      // apiFetch, so the 401 is replayed through it: it notifies the handler
      // and throws UnauthorizedError like every other request.
      return apiFetch<FeaturesResponse>(url, { signal });
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<FeaturesResponse>;
}

export async function requestNavdata(body: NavdataRequestBody): Promise<NavdataRequestResponse> {
  return apiFetch<NavdataRequestResponse>('/api/navdata/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function fetchRouteGeometry(legId: number, signal?: AbortSignal): Promise<RouteGeometryResponse> {
  return apiFetch<RouteGeometryResponse>(`/api/planned-legs/${legId}/route-geometry`, { signal });
}
