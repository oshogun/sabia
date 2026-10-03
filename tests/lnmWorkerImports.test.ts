// The Little Navmap import worker thread must not load the modules that open
// the server's databases. Both are replaced with factories that throw, so any
// import of them while loading the pipeline module or the worker entry fails
// the test and names the module. The worker entry is loaded with
// worker_threads replaced, so parentPort is null and the worker stops at its
// worker-thread check.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection', () => {
  throw new Error('src/db/connection was loaded by the Little Navmap import worker');
});
vi.mock('../src/navdata/connection', () => {
  throw new Error('src/navdata/connection was loaded by the Little Navmap import worker');
});
vi.mock('worker_threads', () => ({ parentPort: null, workerData: undefined }));

describe('Little Navmap import worker imports', () => {
  it('loads the pipeline without loading either database connection module', async () => {
    vi.resetModules();
    const pipeline = await import('../src/navdata/lnm/pipeline');
    expect(typeof pipeline.runLnmPipeline).toBe('function');
  });

  it('loads the worker entry up to its worker-thread check without loading either database connection module', async () => {
    vi.resetModules();
    const err = await import('../src/navdata/lnm/worker').then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect((err?.cause ?? err)?.message).toContain('must be started as a worker thread');
  });
});
