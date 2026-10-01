import type { WxWeatherPayload } from './types';

// ── Weather API client ────────────────────────────────────────────────────────
//
// The only module in this tree that talks to aviationweather.gov. It owns the
// network and nothing else: no database, no express, no ACARS vocabulary — it
// hands back a plain METAR/TAF result for src/routes/acars.ts to file into the
// message thread, or rejects with a WeatherFetchError and never anything else.
//
// No authentication of any kind is involved. No key, no token, no cookie.
// Nothing here may start sending a credential: the request is for a
// third-party service that answers anyone.
//
// The METAR and TAF endpoints disagree on how "no data" is signalled — an
// empty body, an HTTP 204, or a 200 with an empty JSON array all mean the same
// thing, "no current report," and none of them is an error (see
// fetchOneProduct below).

/** Reasons a lookup could not be answered. Every one maps to a user-facing sentence. */
export type WeatherErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'BAD_STATUS'
  | 'BAD_BODY';

/**
 * Thrown by fetchWeather/getCachedWeather, and the only thing either throws.
 *
 * `message` is written for the log; `userMessage` is written for a human and
 * never contains a URL or an ICAO the operator didn't already type.
 *
 * No `upstreamStatus` field: unlike SimBrief, aviationweather.gov does not
 * embed a machine-readable verdict string in its body — httpStatus is the
 * only signal there is.
 */
export class WeatherFetchError extends Error {
  readonly code: WeatherErrorCode;
  readonly userMessage: string;
  readonly httpStatus?: number;

  constructor(
    code: WeatherErrorCode,
    detail: string,
    userMessage: string,
    extra: { httpStatus?: number } = {},
  ) {
    super(`${code} (${detail})`);
    this.name = 'WeatherFetchError';
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = extra.httpStatus;
  }
}

export interface FetchWeatherOptions {
  /**
   * Injected by tests and by nothing else. A parameter with a default rather
   * than a module-level global, so two tests running concurrently cannot see
   * each other's stub.
   */
  fetchImpl?: typeof fetch;
  /** Applies independently to the METAR fetch and the TAF fetch. */
  timeoutMs?: number;
}

/**
 * A few minutes: comfortably inside METAR's ~1/hour and TAF's ~10-minute
 * update cadence, and short enough that a crew re-requesting the same station
 * mid-approach still gets a report from within the same flight phase.
 */
export const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Structurally identical to WxWeatherPayload (src/types.ts) except `metar` is
 * nullable. fetchWeather/getCachedWeather return this, not WxWeatherPayload
 * directly, because a fetch can genuinely succeed with no current METAR for
 * the station — that is not an error this module throws, but it is also not
 * the shape a stored, available WX reply uses. src/routes/acars.ts is the one
 * place that narrows RawWeather into WxWeatherPayload, once `metar !== null`
 * is confirmed.
 */
export interface RawWeather {
  icao: string;
  metar: string | null;
  taf: string | null;
  fetched_at: string;
}

// Compile-time check, not a runtime call: fails to typecheck if RawWeather
// (once its metar is known non-null) ever drifts from WxWeatherPayload's
// shape — the two are meant to stay field-for-field identical.
function _rawWeatherMatchesWxWeatherPayload(w: RawWeather & { metar: string }): WxWeatherPayload {
  return w;
}
void _rawWeatherMatchesWxWeatherPayload;

/** Generous margin over real captures (~1.7s) while still answering promptly. */
const WEATHER_TIMEOUT_MS = 10_000;

/**
 * Overridable so a scratch server can point at a local stub instead of the
 * real service. Read per call rather than captured at module load, so
 * setting the variable does not depend on import order. Deliberately not
 * part of src/config.ts's ENV_VARS, which is scoped to configuration this
 * app's security depends on; this is a test seam.
 */
const WEATHER_API_BASE_URL_DEFAULT = 'https://aviationweather.gov/api/data';
function baseUrl(): string {
  return process.env.WEATHER_API_BASE_URL ?? WEATHER_API_BASE_URL_DEFAULT;
}

/** `kind` is always one of the two string literals this module writes, never
 *  request input, so building the path by template literal is safe; the
 *  *parameter* (`ids`) still goes through `searchParams.set`, never
 *  concatenation. */
function productUrl(kind: 'metar' | 'taf', icao: string): URL {
  const url = new URL(`${baseUrl()}/${kind}`);
  url.searchParams.set('ids', icao);
  url.searchParams.set('format', 'json');
  return url;
}

const USER_MESSAGES: Record<WeatherErrorCode, (detail: { timeoutMs?: number; status?: number }) => string> = {
  TIMEOUT: ({ timeoutMs }) =>
    `The weather service did not respond within ${Math.round((timeoutMs ?? WEATHER_TIMEOUT_MS) / 1000)} seconds. Try again in a moment.`,
  NETWORK: () => 'Could not reach the weather service. Check your internet connection and try again.',
  RATE_LIMITED: () => 'The weather service is rate-limiting requests right now. Try again in a minute.',
  BAD_STATUS: ({ status }) => `The weather service returned an error (HTTP ${status}). Try again in a moment.`,
  BAD_BODY: () => 'The weather service returned a response this app could not read.',
};

/** A timeout surfaces as an abort, sometimes wrapped by the runtime's own error. */
function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return isAbort((err as { cause?: unknown }).cause);
}

const RAW_FIELD: Record<'metar' | 'taf', 'rawOb' | 'rawTAF'> = { metar: 'rawOb', taf: 'rawTAF' };

/**
 * One product (METAR or TAF) for one ICAO. Returns the raw text, or null
 * meaning "no current report" — a normal, successful outcome, never an error.
 * Throws WeatherFetchError for every genuine failure.
 */
async function fetchOneProduct(
  kind: 'metar' | 'taf',
  icao: string,
  opts: FetchWeatherOptions,
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? WEATHER_TIMEOUT_MS;
  const url = productUrl(kind, icao);

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (isAbort(err)) {
      throw new WeatherFetchError('TIMEOUT', `${timeoutMs}ms`, USER_MESSAGES.TIMEOUT({ timeoutMs }));
    }
    throw new WeatherFetchError(
      'NETWORK',
      err instanceof Error ? err.message : String(err),
      USER_MESSAGES.NETWORK({}),
    );
  }

  const httpStatus = res.status;

  if (httpStatus === 204) return null;

  if (httpStatus === 429) {
    throw new WeatherFetchError('RATE_LIMITED', `http ${httpStatus}`, USER_MESSAGES.RATE_LIMITED({}), { httpStatus });
  }
  if (httpStatus !== 200) {
    throw new WeatherFetchError('BAD_STATUS', `http ${httpStatus}`, USER_MESSAGES.BAD_STATUS({ status: httpStatus }), {
      httpStatus,
    });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new WeatherFetchError(
      'NETWORK',
      err instanceof Error ? err.message : String(err),
      USER_MESSAGES.NETWORK({}),
    );
  }

  // Defensive: matches the "no content" case even if a future response uses
  // 200 + empty body instead of 204.
  if (text === '') return null;

  const excerpt = `http ${httpStatus}, first 200 chars: ${text.slice(0, 200)}`;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WeatherFetchError('BAD_BODY', excerpt, USER_MESSAGES.BAD_BODY({}), { httpStatus });
  }
  if (!Array.isArray(body)) {
    throw new WeatherFetchError('BAD_BODY', excerpt, USER_MESSAGES.BAD_BODY({}), { httpStatus });
  }
  if (body.length === 0) return null;

  const first = body[0];
  const rawField = RAW_FIELD[kind];
  const raw = typeof first === 'object' && first !== null ? (first as Record<string, unknown>)[rawField] : undefined;
  if (typeof raw !== 'string' || raw === '') {
    throw new WeatherFetchError('BAD_BODY', excerpt, USER_MESSAGES.BAD_BODY({}), { httpStatus });
  }
  return raw.trim();
}

/**
 * The uncached network call. Always hits aviationweather.gov: fetches METAR
 * and TAF for `icao` concurrently and returns the merged result, or throws
 * WeatherFetchError.
 *
 * CONTRACT: `icao` must already be normalised (trimmed, uppercased) and
 * shape-validated by the caller (src/acars.ts's isValidIcaoShape). This
 * function does neither — it treats `icao` as an opaque string. A malformed
 * icao is not this module's problem to reject; the route rejects it before
 * this module is ever called.
 */
export async function fetchWeather(icao: string, opts: FetchWeatherOptions = {}): Promise<RawWeather> {
  const [metarSettled, tafSettled] = await Promise.allSettled([
    fetchOneProduct('metar', icao, opts),
    fetchOneProduct('taf', icao, opts),
  ]);

  // METAR failure is fatal: this feature is about METAR first, and there is
  // no notion of a WX reply carrying only a TAF.
  if (metarSettled.status === 'rejected') throw metarSettled.reason;
  const metar = metarSettled.value; // string | null — null means "no current METAR", not a bug

  // TAF failure degrades to null, exactly like "this station has no TAF on
  // file" — a flaky TAF fetch is not a reason to fail a request that has a
  // good METAR.
  const taf = tafSettled.status === 'fulfilled' ? tafSettled.value : null;

  return {
    icao, // already normalised by the caller — see the CONTRACT note above
    metar,
    taf,
    fetched_at: new Date().toISOString(),
  };
}

interface CacheEntry {
  expiresAt: number; // Date.now() reading at insert + WEATHER_CACHE_TTL_MS
  result: RawWeather | null; // set on a successful fetchWeather
  error: WeatherFetchError | null; // set when fetchWeather threw
}
const cache = new Map<string, CacheEntry>(); // key: the normalised icao, as given

/**
 * The cache-aware entry point, and the only one src/routes/acars.ts calls.
 * On a cache hit, returns/throws the cached outcome WITHOUT calling
 * fetchWeather at all — so opts.fetchImpl is not invoked a second time. On a
 * miss, calls fetchWeather, and caches whatever it returns OR throws.
 *
 * Failures are cached too, for the same TTL as successes: a crew that
 * re-requests weather for a currently-unfetchable ICAO must not re-hit the
 * upstream on every retry within the window. Every call still writes a fresh
 * pair of messages regardless, so the crew still sees an answer each time.
 */
export async function getCachedWeather(icao: string, opts: FetchWeatherOptions = {}): Promise<RawWeather> {
  const now = Date.now();
  const cached = cache.get(icao);
  if (cached && cached.expiresAt > now) {
    if (cached.error) throw cached.error;
    return cached.result as RawWeather;
  }

  try {
    const result = await fetchWeather(icao, opts);
    cache.set(icao, { expiresAt: now + WEATHER_CACHE_TTL_MS, result, error: null });
    return result;
  } catch (err) {
    const error = err instanceof WeatherFetchError
      ? err
      : new WeatherFetchError('NETWORK', err instanceof Error ? err.message : String(err), USER_MESSAGES.NETWORK({}));
    cache.set(icao, { expiresAt: now + WEATHER_CACHE_TTL_MS, result: null, error });
    throw error;
  }
}

/** Test-only reset of the module-level cache. Not called by production code. */
export function clearWeatherCache(): void {
  cache.clear();
}
