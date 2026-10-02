import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetchRoutes, deferred, type ResponseTuple } from '../../test/mockFetch';
import { FakeXhr, importFiles, importJob, succeededJob } from '../../test/navdataFixtures';
import type { LnmImportFilesResponse, LnmImportJob, NavdataSource } from '../../types';
import { NavdataImportTile } from './NavdataImportTile';

const JOB_URL = '/api/navdata/lnm-import';
const FILES_URL = '/api/navdata/lnm-import/files';
const PATH_URL = '/api/navdata/lnm-import/path';
const DISMISSED_KEY = 'sabia.lnmImport.dismissedJob';
const NOT_RUNNING: ResponseTuple = [409, { error: 'No Little Navmap import is running', code: 'LNM_NOT_RUNNING' }];
const POLL_WAIT = { timeout: 4000 };

type Handler = ResponseTuple | ((init: RequestInit | undefined) => ResponseTuple | Promise<ResponseTuple>);

interface Served {
  /** What GET /api/navdata/lnm-import answers; tests reassign it to move the job along. */
  job: LnmImportJob | null;
}

function serve(opts: { files?: Handler; path?: Handler; del?: Handler; get?: Handler } = {}): Served {
  const served: Served = { job: null };
  mockFetchRoutes({
    [JOB_URL]: {
      GET: opts.get ?? (() => [200, { job: served.job }]),
      DELETE: opts.del ?? NOT_RUNNING,
    },
    [FILES_URL]: opts.files ?? [200, importFiles()],
    [PATH_URL]: { POST: opts.path ?? [202, { job: importJob({ origin: 'path' }) }] },
  });
  return served;
}

function requests(method: string, url?: string): string[] {
  const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls;
  return calls
    .filter(([u, init]) => (init?.method ?? 'GET') === method && (url === undefined || u === url))
    .map(([u]) => u);
}

/** A file with a chosen reported size, without allocating it. */
function sqliteFile(name = 'lnm_test.sqlite', size = 3_000_000): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function renderTile(over: { effectiveSource?: NavdataSource | null; onImported?: () => void } = {}) {
  const onImported = over.onImported ?? vi.fn();
  const utils = render(<NavdataImportTile effectiveSource={over.effectiveSource ?? 'mcdu'} onImported={onImported} />);
  return { ...utils, onImported };
}

async function pickAndUpload(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(await screen.findByLabelText('Choose file…'), file);
  await user.click(screen.getByRole('button', { name: 'Upload and import' }));
  return FakeXhr.instances[FakeXhr.instances.length - 1];
}

/** Lets already-resolved requests finish and their state updates land. */
async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

beforeEach(() => {
  window.localStorage.clear();
  FakeXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

describe('NavdataImportTile layout', () => {
  it('states the limit and the import folder from the server, with the Docker note', async () => {
    serve();
    renderTile();

    expect(await screen.findByText(/up to 2 GiB\), or put it in \/srv\/navdata on the server and pick it below\./)).toBeInTheDocument();
    expect(screen.getByText(/Sabiá builds its own navigation database from it; the simulator's database is never changed\./)).toBeInTheDocument();
    expect(screen.getByText(
      'In Docker, this is the navdata folder mounted into the container (./navdata next to docker-compose.yml).'
    )).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Import Little Navmap data' })).toBeInTheDocument();
  });

  it('lists the files in the import folder as name and size', async () => {
    serve({ files: [200, importFiles({ files: [{ name: 'a.sqlite', sizeBytes: 888_143_872, modifiedAt: 1 }] })] });
    renderTile();

    expect(await screen.findByRole('option', { name: 'a.sqlite — 888 MB' })).toBeInTheDocument();
  });

  it('says so when the import folder has no .sqlite file', async () => {
    serve({ files: [200, importFiles({ files: [] })] });
    renderTile();

    expect(await screen.findByText('No .sqlite files in /srv/navdata')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('shows the server message when the folder cannot be read, and still offers the upload', async () => {
    serve({ files: [500, { error: 'import folder unreadable' }] });
    renderTile();

    expect(await screen.findByText('import folder unreadable')).toBeInTheDocument();
    expect(screen.getByText('Could not read the import folder')).toBeInTheDocument();
    expect(screen.getByLabelText('Choose file…')).toBeEnabled();
  });

  it('reads the folder again on Refresh', async () => {
    let files: LnmImportFilesResponse = importFiles({ files: [] });
    const user = userEvent.setup();
    serve({ files: () => [200, files] });
    renderTile();
    await screen.findByText('No .sqlite files in /srv/navdata');

    files = importFiles();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('option', { name: 'lnm_test.sqlite — 5 MB' })).toBeInTheDocument();
  });
});

describe('NavdataImportTile upload', () => {
  it('shows the bytes sent, then follows the import it started to a success notice and tells the page', async () => {
    const user = userEvent.setup();
    const served = serve();
    const { onImported } = renderTile();

    const xhr = await pickAndUpload(user, sqliteFile('lnm_test.sqlite', 3_000_000));
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/navdata/lnm-import/upload');
    expect((xhr.body as FormData).get('lnmDatabase')).toBeInstanceOf(File);
    expect(xhr.headers).toEqual({});

    act(() => xhr.progress(1_500_000, 3_000_000));
    const bar = await screen.findByRole('progressbar', { name: 'Uploading' });
    expect(bar).toHaveAttribute('aria-valuenow', '1500000');
    expect(bar).toHaveAttribute('aria-valuemax', '3000000');
    expect(screen.getByText('2 / 3 MB')).toBeInTheDocument();
    expect(screen.getByText('Keep this page open until the upload finishes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload and import' })).toBeDisabled();

    served.job = importJob({ state: 'running', stage: 'airports', fraction: 0.5 });
    act(() => xhr.respond(202, { job: served.job }));
    expect(await screen.findByRole('progressbar', { name: 'Importing — Airports and runways' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Uploading' })).toBeNull();
    expect(onImported).not.toHaveBeenCalled();

    served.job = succeededJob();
    expect(await screen.findByText('Imported Navigraph AIRAC 9901.', {}, POLL_WAIT)).toBeInTheDocument();
    expect(screen.getByText('Select “Little Navmap import” above to use it.')).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('refuses a file over the limit before any request is made', async () => {
    const user = userEvent.setup();
    serve();
    renderTile();

    await user.upload(await screen.findByLabelText('Choose file…'), sqliteFile('big.sqlite', 3 * 2 ** 30));

    expect(await screen.findByText('File is larger than 2 GiB')).toBeInTheDocument();
    const upload = screen.getByRole('button', { name: 'Upload and import' });
    expect(upload).toBeDisabled();
    await user.click(upload);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(requests('POST')).toEqual([]);
  });

  it('warns about disk space but lets the upload go ahead', async () => {
    const user = userEvent.setup();
    serve({ files: [200, importFiles({ availableBytes: 900 * 2 ** 20, reserveBytes: 1280 * 2 ** 20 })] });
    renderTile();

    await user.upload(await screen.findByLabelText('Choose file…'), sqliteFile('lnm_test.sqlite', 2 ** 20 * 10));

    expect(await screen.findByText('The server may not have enough disk space (need 1290 MiB, 900 MiB free)')).toBeInTheDocument();
    expect(screen.queryByText(/File is larger than/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it('sends the upload without a disk warning when free space is unknown', async () => {
    const user = userEvent.setup();
    serve({ files: [200, importFiles({ availableBytes: null })] });
    renderTile();

    await user.upload(await screen.findByLabelText('Choose file…'), sqliteFile());
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));

    expect(screen.queryByText(/not have enough disk space/)).toBeNull();
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it('shows the server message once when the upload is refused, though the server also recorded a failed job', async () => {
    const user = userEvent.setup();
    const message = 'The file is not a SQLite database';
    const served = serve();
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    served.job = importJob({
      id: 'job-bad', state: 'failed', finishedAt: Date.now(), error: { code: 'LNM_NOT_SQLITE', message },
    });
    act(() => xhr.respond(400, { error: message, code: 'LNM_NOT_SQLITE' }));

    expect(await screen.findByText('Import failed')).toBeInTheDocument();
    expect(await screen.findByText(message)).toBeInTheDocument();
    await settle();
    expect(screen.getAllByText('Import failed')).toHaveLength(1);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Upload and import' })).toBeEnabled();
  });

  it('shows the server message for a refusal that creates no job', async () => {
    const user = userEvent.setup();
    serve();
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    act(() => xhr.respond(507, { error: 'Not enough disk space: need 2127 MiB free, 900 MiB available', code: 'LNM_INSUFFICIENT_STORAGE' }));

    expect(await screen.findByText('Not enough disk space: need 2127 MiB free, 900 MiB available')).toBeInTheDocument();
    expect(screen.getByText('Import failed')).toBeInTheDocument();
  });

  it('names the status when a refusal carries no message', async () => {
    const user = userEvent.setup();
    serve();
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    act(() => xhr.respond(502, '<html>bad gateway</html>'));

    expect(await screen.findByText('Upload failed (HTTP 502)')).toBeInTheDocument();
  });

  it('reports a dropped connection, then replaces the generic text with the reason the server recorded', async () => {
    const user = userEvent.setup();
    const followUp = deferred<ResponseTuple>();
    let gets = 0;
    serve({ get: () => (++gets === 1 ? [200, { job: null }] : followUp.handler()) });
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    act(() => xhr.fail());

    expect(await screen.findByText('Upload failed — connection closed')).toBeInTheDocument();
    expect(screen.getByText('Upload failed')).toBeInTheDocument();
    await waitFor(() => expect(gets).toBe(2));

    await act(async () => {
      followUp.resolve([200, { job: importJob({
        id: 'job-big', state: 'failed', finishedAt: Date.now(), error: { code: 'LNM_TOO_LARGE', message: 'File exceeds 2 GiB' },
      }) }]);
    });

    expect(await screen.findByText('File exceeds 2 GiB')).toBeInTheDocument();
    expect(screen.queryByText('Upload failed — connection closed')).toBeNull();
    expect(screen.queryByText('Import failed')).toBeNull();
  });

  it('keeps the generic text when the server recorded nothing', async () => {
    const user = userEvent.setup();
    serve();
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    act(() => xhr.fail());

    expect(await screen.findByText('Upload failed — connection closed')).toBeInTheDocument();
    await settle();
    expect(screen.getByText('Upload failed — connection closed')).toBeInTheDocument();
  });

  it('cancels during an upload by telling the server first, then dropping the request, and ends on a plain notice', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const served = serve({
      del: () => {
        events.push('DELETE');
        served.job = importJob({ state: 'cancelled', stage: null, fraction: 0, finishedAt: Date.now() });
        return [202, { job: served.job }];
      },
    });
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    const abort = xhr.abort.bind(xhr);
    xhr.abort = () => { events.push('abort'); abort(); };
    act(() => xhr.progress(100, 3_000_000));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Import cancelled.')).toBeInTheDocument();
    expect(events).toEqual(['DELETE', 'abort']);
    expect(xhr.aborted).toBe(true);
    expect(requests('DELETE')).toEqual([JOB_URL]);
    expect(screen.queryByText(/Upload failed/)).toBeNull();
    expect(screen.queryByText('Import failed')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload and import' })).toBeEnabled();
  });

  it('does not treat the connection the server destroys on cancel as an upload failure', async () => {
    const user = userEvent.setup();
    const answer = deferred<ResponseTuple>();
    const served = serve({ del: answer.handler });
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    // The server destroys the upload connection as it handles the cancel, before the client has its answer.
    act(() => xhr.fail());
    await settle();
    expect(screen.queryByText(/Upload failed/)).toBeNull();

    served.job = importJob({ state: 'receiving', stage: null, fraction: 0 });
    await act(async () => { answer.resolve([202, { job: served.job }]); });
    served.job = importJob({ state: 'cancelled', stage: null, fraction: 0, finishedAt: Date.now() });

    expect(await screen.findByText('Import cancelled.', {}, POLL_WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/Upload failed/)).toBeNull();
    expect(screen.queryByText('Import failed')).toBeNull();
  });

  it('shows as the cancel it came from an upload the browser resent and this page then closed', async () => {
    const user = userEvent.setup();
    const abortedMessage = 'Upload stopped: the page was closed or the connection dropped';
    const served = serve({
      del: () => {
        served.job = importJob({ id: 'job-resent', state: 'failed', stage: null, fraction: 0, finishedAt: Date.now(),
          error: { code: 'LNM_UPLOAD_ABORTED', message: abortedMessage } });
        return [202, { job: importJob({ id: 'job-first', state: 'receiving', stage: null, fraction: 0 }) }];
      },
    });
    renderTile();

    await pickAndUpload(user, sqliteFile());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Import cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('Import failed')).toBeNull();
    expect(screen.queryByText(abortedMessage)).toBeNull();
  });

  it('keeps an aborted upload as a failure when no cancel was asked for', async () => {
    const served = serve();
    served.job = importJob({
      state: 'failed', stage: null, fraction: 0, finishedAt: Date.now() - 1000,
      error: { code: 'LNM_UPLOAD_ABORTED', message: 'Upload stopped: the page was closed or the connection dropped' },
    });
    renderTile();

    expect(await screen.findByText('Upload stopped: the page was closed or the connection dropped')).toBeInTheDocument();
    expect(screen.getByText('Import failed')).toBeInTheDocument();
    expect(screen.queryByText('Import cancelled.')).toBeNull();
  });

  it('reports a dropped connection that no cancel asked for', async () => {
    const user = userEvent.setup();
    serve();
    renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    act(() => xhr.fail());

    expect(await screen.findByText('Upload failed — connection closed')).toBeInTheDocument();
  });

  it('does not bring back the previous job\'s notice when a new request is refused without creating a job', async () => {
    const user = userEvent.setup();
    const served = serve();
    served.job = succeededJob({ finishedAt: Date.now() - 60_000 });
    renderTile();
    expect(await screen.findByText('Imported Navigraph AIRAC 9901.')).toBeInTheDocument();

    const xhr = await pickAndUpload(user, sqliteFile());
    expect(screen.queryByText('Imported Navigraph AIRAC 9901.')).toBeNull();
    act(() => xhr.respond(507, { error: 'Not enough disk space', code: 'LNM_INSUFFICIENT_STORAGE' }));

    expect(await screen.findByText('Not enough disk space')).toBeInTheDocument();
    await settle();
    expect(screen.queryByText('Imported Navigraph AIRAC 9901.')).toBeNull();
  });

  it('aborts the request, without cancelling the job, when the tile unmounts mid-upload', async () => {
    const user = userEvent.setup();
    serve();
    const { unmount } = renderTile();

    const xhr = await pickAndUpload(user, sqliteFile());
    expect(xhr.aborted).toBe(false);
    unmount();

    expect(xhr.aborted).toBe(true);
    expect(requests('DELETE')).toEqual([]);
  });
});

describe('NavdataImportTile server-side import', () => {
  it('starts the picked file, follows it by stage and can cancel it', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    const running = importJob({ origin: 'path', state: 'running', stage: 'procedures', fraction: 0.47 });
    const served = serve({
      path: init => { posts.push(JSON.parse(init!.body as string)); served.job = running; return [202, { job: running }]; },
      del: () => {
        served.job = importJob({ origin: 'path', state: 'cancelled', finishedAt: Date.now() });
        return [202, { job: served.job }];
      },
    });
    renderTile();

    await screen.findByRole('option', { name: 'lnm_test.sqlite — 5 MB' });
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(posts).toEqual([{ fileName: 'lnm_test.sqlite' }]);
    const bar = await screen.findByRole('progressbar', { name: 'Importing — Procedures' });
    expect(bar).toHaveAttribute('aria-valuenow', '47');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload and import' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Import cancelled.')).toBeInTheDocument();
    expect(requests('DELETE')).toEqual([JOB_URL]);
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('shows the server message when the import is refused', async () => {
    const user = userEvent.setup();
    serve({ path: [404, { error: 'No such file in the import directory', code: 'LNM_FILE_NOT_FOUND' }] });
    renderTile();

    await screen.findByRole('option', { name: 'lnm_test.sqlite — 5 MB' });
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('No such file in the import directory')).toBeInTheDocument();
    expect(screen.getByText('Import failed')).toBeInTheDocument();
  });

  it('shows a failed job with the server message', async () => {
    const user = userEvent.setup();
    const message = "unsupported Little Navmap data source 'XP12'";
    const failed = importJob({
      origin: 'path', state: 'failed', finishedAt: Date.now(), error: { code: 'LNM_UNSUPPORTED_SOURCE', message },
    });
    const served = serve({ path: () => { served.job = failed; return [202, { job: importJob({ origin: 'path' }) }]; } });
    renderTile();

    await screen.findByRole('option', { name: 'lnm_test.sqlite — 5 MB' });
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText(message, {}, POLL_WAIT)).toBeInTheDocument();
    expect(screen.getByText('Import failed')).toBeInTheDocument();
  });

  it('shows another session\'s upload as indeterminate, with Cancel', async () => {
    const user = userEvent.setup();
    const served = serve({
      del: () => {
        served.job = importJob({ state: 'cancelled', stage: null, fraction: 0, finishedAt: Date.now() });
        return [202, { job: served.job }];
      },
    });
    served.job = importJob({ state: 'receiving', stage: null, fraction: 0 });
    renderTile();

    const bar = await screen.findByRole('progressbar', { name: 'Uploading (another session)' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('button', { name: 'Upload and import' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Import cancelled.')).toBeInTheDocument();
  });

  it('ignores a cancel the server answers with "nothing running" and shows the job as it now is', async () => {
    const user = userEvent.setup();
    const served = serve();
    served.job = importJob({ state: 'running' });
    renderTile();
    await screen.findByRole('progressbar', { name: 'Importing — Airports and runways' });

    served.job = succeededJob();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Imported Navigraph AIRAC 9901.')).toBeInTheDocument();
    expect(screen.queryByText('Could not cancel the import')).toBeNull();
  });

  it('shows a cancel the server fails to carry out, and leaves Cancel usable', async () => {
    const user = userEvent.setup();
    const served = serve({ del: [500, { error: 'worker not reachable' }] });
    served.job = importJob({ state: 'running' });
    renderTile();
    await screen.findByRole('progressbar', { name: 'Importing — Airports and runways' });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('worker not reachable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('reports a status request that fails', async () => {
    serve({ get: [500, { error: 'status unavailable' }] });
    renderTile();

    expect(await screen.findByText('status unavailable')).toBeInTheDocument();
    expect(screen.getByText('Could not read the import status')).toBeInTheDocument();
  });
});

describe('NavdataImportTile finished jobs', () => {
  it('does not announce a job that finished an hour ago', async () => {
    const served = serve();
    served.job = succeededJob({ finishedAt: Date.now() - 60 * 60_000 });
    const { onImported } = renderTile();

    await screen.findByRole('option', { name: 'lnm_test.sqlite — 5 MB' });
    await settle();

    expect(requests('GET', JOB_URL)).toHaveLength(1);
    expect(screen.queryByText(/^Imported /)).toBeNull();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('announces a job that finished a minute ago, without telling the page it just finished', async () => {
    const served = serve();
    served.job = succeededJob({ finishedAt: Date.now() - 60_000 });
    const { onImported } = renderTile();

    expect(await screen.findByText('Imported Navigraph AIRAC 9901.')).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('announces a job it watched finish even when the server clock puts the end long ago', async () => {
    const served = serve();
    served.job = importJob({ state: 'running' });
    const { onImported } = renderTile();
    await screen.findByRole('progressbar', { name: 'Importing — Airports and runways' });

    served.job = succeededJob({ finishedAt: Date.now() - 60 * 60_000 });

    expect(await screen.findByText('Imported Navigraph AIRAC 9901.', {}, POLL_WAIT)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('announces failed and cancelled jobs the same way', async () => {
    const served = serve();
    served.job = importJob({
      state: 'failed', finishedAt: Date.now() - 1000, error: { code: 'LNM_EMPTY', message: 'The database holds no airports' },
    });
    const { unmount } = renderTile();
    expect(await screen.findByText('The database holds no airports')).toBeInTheDocument();
    expect(screen.getByText('Import failed')).toBeInTheDocument();
    unmount();

    served.job = importJob({ id: 'job-2', state: 'cancelled', finishedAt: Date.now() - 1000 });
    renderTile();
    expect(await screen.findByText('Import cancelled.')).toBeInTheDocument();
  });

  it('does not announce a dismissed job again, now or after the tile is mounted again', async () => {
    const user = userEvent.setup();
    const served = serve();
    served.job = succeededJob({ finishedAt: Date.now() - 60_000 });
    const first = renderTile();

    expect(await screen.findByText('Imported Navigraph AIRAC 9901.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(screen.queryByText('Imported Navigraph AIRAC 9901.')).toBeNull();
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe('job-1');
    first.unmount();

    renderTile();
    await screen.findByRole('option', { name: 'lnm_test.sqlite — 5 MB' });
    await settle();
    expect(screen.queryByText(/^Imported /)).toBeNull();

    served.job = succeededJob({ id: 'job-2', finishedAt: Date.now() - 60_000 });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.queryByText(/^Imported /)).toBeNull();
  });

  it('follows the effective source in the success notice', async () => {
    const served = serve();
    served.job = succeededJob({ finishedAt: Date.now() - 1000 });
    const { rerender } = renderTile({ effectiveSource: 'mcdu' });

    expect(await screen.findByText('Select “Little Navmap import” above to use it.')).toBeInTheDocument();

    rerender(<NavdataImportTile effectiveSource="lnm" onImported={() => {}} />);
    expect(screen.getByText('The map now shows this data.')).toBeInTheDocument();
    expect(screen.queryByText('Select “Little Navmap import” above to use it.')).toBeNull();
  });

  it('does not tell the page about an import twice', async () => {
    const served = serve();
    served.job = importJob({ state: 'running' });
    const { onImported } = renderTile();
    await screen.findByRole('progressbar', { name: 'Importing — Airports and runways' });

    served.job = succeededJob();
    await screen.findByText('Imported Navigraph AIRAC 9901.', {}, POLL_WAIT);
    await settle();

    expect(onImported).toHaveBeenCalledTimes(1);
  });
});
