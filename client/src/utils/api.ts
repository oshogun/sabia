/**
 * Thrown by apiFetch/download when the server answers 401. Distinguishable by
 * `instanceof`, so a caller can tell "logged out" from "request failed".
 */
export class UnauthorizedError extends Error {
  readonly status = 401 as const;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Registered once by <RequireAuth>, so a mid-session expiry bounces the
 * operator to /login. Never registered on a /print/* route.
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

/**
 * For the rare call site that cannot use apiFetch — a partial-failure batch
 * carries a body worth rendering on a non-2xx status, which apiFetch
 * discards — but still answers 401 on session expiry like every other
 * endpoint. Calling this on that 401 gives it the same "bounce to /login"
 * behaviour apiFetch gives everything else, before throwing.
 */
export function reportUnauthorized(message?: string): UnauthorizedError {
  unauthorizedHandler?.();
  return new UnauthorizedError(message);
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401) {
      unauthorizedHandler?.();
      throw new UnauthorizedError((body as { error?: string }).error || res.statusText);
    }
    throw new Error((body as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

/** The request options download() accepts. Private to this module. */
type DownloadInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * fetch → Blob → synthetic <a download>. The only place in the client that
 * calls URL.createObjectURL. Reads the filename from Content-Disposition,
 * falls back to `fallbackName`. Throws Error(body.error ?? statusText) on a
 * non-2xx so the caller can render a message instead of navigating to JSON.
 */
async function download(url: string, fallbackName: string, init: DownloadInit = {}): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401) {
      unauthorizedHandler?.();
      throw new UnauthorizedError((body as { error?: string }).error || res.statusText);
    }
    throw new Error((body as { error?: string }).error || res.statusText);
  }

  const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = match?.[1] ?? fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Downloads a generated PDF.
 *
 * Uses fetch + Blob rather than a plain <a download> so the caller can show a
 * progress state (generation takes seconds) and so an error response renders as
 * a message instead of navigating the user to raw JSON.
 *
 * The browser's locale and timezone are forwarded because the PDF is rendered
 * headlessly on the server, whose timezone is not the user's.
 */
export async function downloadPdf(
  path: string,
  fallbackName: string,
  opts: { includePlans?: boolean } = {}
): Promise<void> {
  const params = new URLSearchParams();
  try {
    params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
    params.set('locale', navigator.language);
  } catch { /* fall back to server defaults */ }
  if (opts.includePlans === false) params.set('plans', '0');

  await download(`${path}?${params}`, fallbackName);
}

/** GET a .kml endpoint. No query parameters are sent. */
export async function downloadKml(path: string, fallbackName: string): Promise<void> {
  await download(path, fallbackName);
}

/** POST /api/flights/export.kml with {ids}. */
export async function downloadFlightSetKml(ids: number[]): Promise<void> {
  await download('/api/flights/export.kml', `flights-${ids.length}.kml`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}
