import { test, expect, type Page, type Request } from '@playwright/test';

/**
 * Cancelling a Little Navmap upload from the Settings page, against the real
 * scratch server. The server cuts the upload's connection when the import is
 * cancelled, and Chromium resends a request whose reused connection was cut
 * before any response. The cancel must still end as "Import cancelled.", on
 * the page that sent it and on a page opened afterwards, and the server must
 * report the one cancelled job, not a second job made by the resend.
 *
 * The upload is a synthetic file built here and sent slowly (Chrome DevTools
 * Protocol upload throttling), so Cancel lands while the body is still going
 * out. Chromium notices the cut connection on its next write of that slow
 * body, which is later than the page learns the cancel went through. The
 * DevTools latency setting delays the cancel's answer to the page, so the
 * resend reaches the server before the page reacts, as it does on a slow link.
 * The assertions hold whether or not Chromium resends; the browser does not
 * report its own resends, so the server's log is where to see one.
 */

const JOB_URL = '/api/navdata/lnm-import';
const UPLOAD_URL = '/api/navdata/lnm-import/upload';
const UPLOAD_BYTES = 16 * 1024 * 1024;
const UPLOAD_BYTES_PER_SECOND = 1024 * 1024;
const RESPONSE_DELAY_MS = 800;
const FAILURE_NOTICE = /Import failed|Upload failed/;

interface JobSummary {
  id: string;
  state: string;
}

async function currentJob(page: Page): Promise<JobSummary | null> {
  const res = await page.request.get(JOB_URL);
  expect(res.status()).toBe(200);
  const { job } = (await res.json()) as { job: JobSummary | null };
  return job && { id: job.id, state: job.state };
}

/** The job once it is finished and has stayed the same job for a moment, so a late resend cannot slip in after the check. */
async function settledJob(page: Page): Promise<JobSummary | null> {
  let last = await currentJob(page);
  await expect.poll(async () => {
    const before = last;
    last = await currentJob(page);
    const busy = last?.state === 'receiving' || last?.state === 'running';
    return !busy && before?.id === last?.id && before?.state === last?.state;
  }, { intervals: [300] }).toBe(true);
  return last;
}

/** Builds the file in the page: sending 16 MiB through the test driver's setInputFiles takes seconds. */
async function chooseSyntheticDatabase(page: Page): Promise<void> {
  await page.getByLabel('Choose file…').evaluate((input: HTMLInputElement, bytes: number) => {
    const content = new Uint8Array(bytes);
    content.set(new TextEncoder().encode('SQLite format 3\0'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'little_navmap_e2e.sqlite'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, UPLOAD_BYTES);
}

const isUploadPost = (req: Request): boolean => req.method() === 'POST' && new URL(req.url()).pathname === UPLOAD_URL;

test('cancelling an upload ends as "Import cancelled." on the page and after a reload, even when the browser resends the cut upload', async ({ page }) => {
  const uploadEnded = new Promise<void>(resolve => {
    const ended = (req: Request) => { if (isUploadPost(req)) resolve(); };
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
  });

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Import Little Navmap data' })).toBeVisible();
  // An earlier run on the same server leaves its own cancelled job here and its own "Import cancelled." notice,
  // so the job id is kept to tell this test's job from that one.
  const before = await currentJob(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const emulate = (latency: number, uploadThroughput: number) => cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency, downloadThroughput: -1, uploadThroughput,
  });
  await emulate(RESPONSE_DELAY_MS, UPLOAD_BYTES_PER_SECOND);

  await chooseSyntheticDatabase(page);
  // The upload goes out on a connection the page has already used, which is what a Settings page that has
  // loaded its status does, and the one a browser resends on. The server closes idle connections after a few
  // seconds, so these requests run right before the click.
  await page.evaluate(async (url) => {
    await Promise.all([1, 2, 3].map(async () => (await fetch(url)).text()));
  }, JOB_URL);
  await page.getByRole('button', { name: 'Upload and import' }).click();

  // Cancel has to reach a job the server has claimed, and while the body is still arriving.
  await expect.poll(async () => (await currentJob(page))?.state).toBe('receiving');
  const progress = page.getByText(/[1-9]\d* \/ \d+ MB/);
  await expect(progress).toBeVisible();
  const [loaded, total] = (await progress.innerText()).match(/\d+/g)!.map(Number);
  expect(loaded).toBeLessThan(total);

  const deleted = page.waitForResponse(res => new URL(res.url()).pathname === JOB_URL && res.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Cancel' }).click();
  const { job: cancelledJob } = (await (await deleted).json()) as { job: JobSummary };

  await expect(page.getByText('Import cancelled.')).toBeVisible();
  await emulate(0, -1);
  await uploadEnded;
  const settled = await settledJob(page);
  await expect(page.getByText(FAILURE_NOTICE)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Import Little Navmap data' })).toBeVisible();
  await expect(page.getByText('Import cancelled.')).toBeVisible();
  await expect(page.getByText(FAILURE_NOTICE)).toHaveCount(0);

  const final = await currentJob(page);
  expect(final).toEqual(settled);
  expect(final).toMatchObject({ id: cancelledJob.id, state: 'cancelled' });
  expect(final?.id).not.toBe(before?.id);
});
