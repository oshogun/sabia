import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetchRoutes } from '../test/mockFetch';
import {
  currentLnmDataset, expiredNoCycleDataset, FakeXhr, importFiles, importJob, mcduDataset, sourceResponse, undatedLnmDataset,
} from '../test/navdataFixtures';
import { setUnauthorizedHandler, UnauthorizedError } from './api';
import {
  cancelLnmImport, fetchLnmImport, fetchLnmImportFiles, fetchNavdataSource, LNM_UPLOAD_REPEATED, LnmUploadNetworkError,
  LnmUploadRefusedError, paddedBbox, saveNavdataSource, startLnmPathImport, uploadLnmDatabase, validityText,
} from './navdataApi';

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

describe('import helpers', () => {
  it('fetchLnmImport reads the current job, null included', async () => {
    mockFetchRoutes({ '/api/navdata/lnm-import': { GET: [200, { job: importJob() }] } });
    expect((await fetchLnmImport()).job?.id).toBe('job-1');
    mockFetchRoutes({ '/api/navdata/lnm-import': { GET: [200, { job: null }] } });
    expect((await fetchLnmImport()).job).toBeNull();
  });

  it('fetchLnmImportFiles reads the folder, the limit and the free space', async () => {
    mockFetchRoutes({ '/api/navdata/lnm-import/files': { GET: [200, importFiles()] } });
    const r = await fetchLnmImportFiles();
    expect(r.dir).toBe('/srv/navdata');
    expect(r.maxUploadBytes).toBe(2 * 2 ** 30);
    expect(r.files.map(f => f.name)).toEqual(['lnm_test.sqlite']);
  });

  it('startLnmPathImport posts the file name as JSON', async () => {
    const seen: { method?: string; headers?: HeadersInit; body?: string }[] = [];
    mockFetchRoutes({
      '/api/navdata/lnm-import/path': {
        POST: init => {
          seen.push({ method: init?.method, headers: init?.headers, body: init?.body as string });
          return [202, { job: importJob({ origin: 'path' }) }];
        },
      },
    });

    expect((await startLnmPathImport('a.sqlite')).job?.origin).toBe('path');
    expect(seen).toEqual([{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"fileName":"a.sqlite"}' }]);
  });

  it('startLnmPathImport rejects with the server message on a refusal', async () => {
    mockFetchRoutes({
      '/api/navdata/lnm-import/path': { POST: [409, { error: 'Another Little Navmap import is already running', code: 'LNM_IMPORT_BUSY' }] },
    });
    await expect(startLnmPathImport('a.sqlite')).rejects.toThrow('Another Little Navmap import is already running');
  });

  it('cancelLnmImport sends DELETE and returns the job', async () => {
    const methods: (string | undefined)[] = [];
    mockFetchRoutes({
      '/api/navdata/lnm-import': { DELETE: init => { methods.push(init?.method); return [202, { job: importJob() }]; } },
    });
    expect((await cancelLnmImport()).job?.id).toBe('job-1');
    expect(methods).toEqual(['DELETE']);
  });

  it('cancelLnmImport treats "nothing running" as no job, not as a failure', async () => {
    mockFetchRoutes({
      '/api/navdata/lnm-import': { DELETE: [409, { error: 'No Little Navmap import is running', code: 'LNM_NOT_RUNNING' }] },
    });
    expect(await cancelLnmImport()).toEqual({ job: null });
  });

  it('cancelLnmImport rejects on any other failure', async () => {
    mockFetchRoutes({ '/api/navdata/lnm-import': { DELETE: [500, { error: 'worker not reachable' }] } });
    await expect(cancelLnmImport()).rejects.toThrow('worker not reachable');
  });

  it('cancelLnmImport reports a session that has expired', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    try {
      mockFetchRoutes({ '/api/navdata/lnm-import': { DELETE: [401, { error: 'Authentication required' }] } });
      await expect(cancelLnmImport()).rejects.toBeInstanceOf(UnauthorizedError);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setUnauthorizedHandler(null);
    }
  });
});

/** Records the order in which the upload calls open, setRequestHeader and send. */
class OrderedXhr extends FakeXhr {
  calls: string[] = [];

  open(method: string, url: string) {
    this.calls.push('open');
    super.open(method, url);
  }

  setRequestHeader(name: string, value: string) {
    this.calls.push('setRequestHeader');
    super.setRequestHeader(name, value);
  }

  send(body: unknown) {
    this.calls.push('send');
    super.send(body);
  }
}

describe('uploadLnmDatabase', () => {
  const file = new File(['x'], 'lnm_test.sqlite');

  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  it('posts the file as multipart form data in the lnmDatabase field, with an attempt id and no Content-Type of its own', () => {
    void uploadLnmDatabase(file, () => {});

    const [xhr] = FakeXhr.instances;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/navdata/lnm-import/upload');
    expect(Object.keys(xhr.headers)).toEqual(['X-Upload-Attempt']);
    expect(xhr.headers['X-Upload-Attempt']).toMatch(/^[0-9a-f]{32}$/);
    expect((xhr.body as FormData).get('lnmDatabase')).toBe(file);
  });

  it('sends a different attempt id with every call', () => {
    void uploadLnmDatabase(file, () => {});
    void uploadLnmDatabase(file, () => {});

    const [first, second] = FakeXhr.instances.map(x => x.headers['X-Upload-Attempt']);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it('sets the attempt id after the request is opened and before it is sent', () => {
    vi.stubGlobal('XMLHttpRequest', OrderedXhr);
    void uploadLnmDatabase(file, () => {});

    const [xhr] = FakeXhr.instances as OrderedXhr[];
    expect(xhr.calls).toEqual(['open', 'setRequestHeader', 'send']);
  });

  it('reports the bytes sent as they go out and resolves with the job', async () => {
    const seen: [number, number][] = [];
    const p = uploadLnmDatabase(file, (loaded, total) => seen.push([loaded, total]));
    const [xhr] = FakeXhr.instances;

    xhr.progress(10, 100);
    xhr.progress(100, 100);
    xhr.respond(202, { job: importJob({ state: 'running' }) });

    expect(seen).toEqual([[10, 100], [100, 100]]);
    expect((await p).job?.state).toBe('running');
  });

  it('ignores a progress event that has no computable total', () => {
    const onProgress = vi.fn();
    void uploadLnmDatabase(file, onProgress);
    FakeXhr.instances[0].upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 0 });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects with the server message on a refusal', async () => {
    const p = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[0].respond(413, { error: 'File exceeds 2 GiB', code: 'LNM_TOO_LARGE' });
    await expect(p).rejects.toThrow('File exceeds 2 GiB');
  });

  it('rejects a refusal with its status and the code the server gave it', async () => {
    const message = 'This upload was already received once; start a new upload to send the file again';
    const p = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[0].respond(409, { error: message, code: LNM_UPLOAD_REPEATED });

    const err = await p.catch(e => e);
    expect(err).toBeInstanceOf(LnmUploadRefusedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
    expect(err.code).toBe('LNM_UPLOAD_REPEATED');
    expect(err.message).toBe(message);
  });

  it('carries no code when the refusal body has none', async () => {
    const cases: [number, unknown][] = [
      [502, '<html>bad gateway</html>'],
      [500, { error: 'worker not reachable' }],
      [500, { error: 'worker not reachable', code: '' }],
      [500, { error: 'worker not reachable', code: 7 }],
    ];
    for (const [status, body] of cases) {
      FakeXhr.instances = [];
      const p = uploadLnmDatabase(file, () => {});
      FakeXhr.instances[0].respond(status, body);

      const err = await p.catch(e => e);
      expect(err).toBeInstanceOf(LnmUploadRefusedError);
      expect(err.status).toBe(status);
      expect(err.code).toBeNull();
    }
  });

  it('refuses a success answer that holds no job, with the status', async () => {
    const p = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[0].respond(200, {});

    const err = await p.catch(e => e);
    expect(err).toBeInstanceOf(LnmUploadRefusedError);
    expect(err.status).toBe(200);
    expect(err.code).toBeNull();
    expect(err.message).toBe('Upload failed (HTTP 200)');
  });

  it('names the status when the refusal has no message', async () => {
    const p = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[0].respond(502, '<html>bad gateway</html>');
    await expect(p).rejects.toThrow('Upload failed (HTTP 502)');

    const q = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[1].respond(500, { error: '' });
    await expect(q).rejects.toThrow('Upload failed (HTTP 500)');
  });

  it('reports an expired session like every other request', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    try {
      const p = uploadLnmDatabase(file, () => {});
      FakeXhr.instances[0].respond(401, { error: 'Authentication required' });
      await expect(p).rejects.toBeInstanceOf(UnauthorizedError);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  it('rejects with LnmUploadNetworkError when the connection drops, times out or answers with status 0', async () => {
    const dropped = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[0].fail();
    const timedOut = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[1].ontimeout?.();
    const empty = uploadLnmDatabase(file, () => {});
    FakeXhr.instances[2].respond(0, '');

    for (const p of [dropped, timedOut, empty]) {
      const err = await p.catch(e => e);
      expect(err).toBeInstanceOf(LnmUploadNetworkError);
      expect(err.message).toBe('Upload failed — connection closed');
    }
  });

  it('aborts the request when the signal fires and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const p = uploadLnmDatabase(file, () => {}, controller.signal);
    const [xhr] = FakeXhr.instances;

    controller.abort();

    const err = await p.catch(e => e);
    expect(xhr.aborted).toBe(true);
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('AbortError');
  });

  it('rejects at once, without opening a request, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await uploadLnmDatabase(file, () => {}, controller.signal).catch(e => e);
    expect(err.name).toBe('AbortError');
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('settles once: a later event changes nothing, and the signal is released', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const p = uploadLnmDatabase(file, () => {}, controller.signal);
    const [xhr] = FakeXhr.instances;

    xhr.respond(202, { job: importJob() });
    xhr.fail();
    controller.abort();

    expect((await p).job?.id).toBe('job-1');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(xhr.aborted).toBe(false);
  });
});
