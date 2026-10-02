import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, FileUploaderButton, InlineNotification, ProgressBar, Select, SelectItem, SkeletonText, Stack, Tile,
} from '@carbon/react';
import { UnauthorizedError } from '../../utils/api';
import {
  cancelLnmImport, fetchLnmImport, fetchLnmImportFiles, LNM_UPLOAD_REPEATED, LnmUploadNetworkError, LnmUploadRefusedError,
  startLnmPathImport, uploadLnmDatabase,
} from '../../utils/navdataApi';
import type { LnmImportFilesResponse, LnmImportJob, LnmStage, NavdataSource } from '../../types';

const DISMISSED_KEY = 'sabia.lnmImport.dismissedJob';
const POLL_MS = 1000;
/** A finished import is announced to a tile that did not watch it only while it is this recent. */
const RECENT_MS = 10 * 60_000;
const GIB = 2 ** 30;
const MIB = 2 ** 20;

const STAGE_LABEL: Record<LnmStage, string> = {
  validating: 'Checking the file',
  indexing: 'Reading the database',
  airports: 'Airports and runways',
  navaids: 'Navaids',
  waypoints: 'Waypoints',
  airways: 'Airways',
  procedures: 'Procedures',
  finalising: 'Finishing',
  coverage: 'Coverage',
  verifying: 'Verifying',
  swapping: 'Switching files',
};

const gib = (bytes: number): string => String(Math.round((bytes / GIB) * 10) / 10);
const megabytes = (bytes: number): string => String(Math.round(bytes / 1e6));
const mebibytes = (bytes: number): number => Math.ceil(bytes / MIB);

const isBusy = (job: LnmImportJob | null): boolean => job !== null && (job.state === 'receiving' || job.state === 'running');
const isAbortError = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';
const messageOf = (err: unknown): string => (err instanceof Error && err.message !== '' ? err.message : 'Request failed');

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(id: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, id);
  } catch {
    // Without storage the notice can come back on a later visit; nothing else depends on it.
  }
}

/** An upload in flight: the request's abort controller, and whether this page asked to cancel it. */
interface UploadAttempt {
  controller: AbortController;
  /**
   * Set when Cancel is clicked, before anything is awaited. However the request then ends (dropped, refused, resent
   * and refused, aborted), the cancel is the reason, so the end is not a failure. It stays set when the cancel's own
   * request fails; the upload is dropped in that case too.
   */
  cancelRequested: boolean;
}

/** An upload or start request the server refused or that never finished, shown until closed. */
interface LocalFailure {
  title: string;
  message: string;
  /** The job that was current when the request started; a failed job with another id is this request's own. */
  priorJobId: string | null;
}

export interface NavdataImportTileProps {
  /** Which source the map reads right now; decides what a finished import tells the operator to do next. */
  effectiveSource: NavdataSource | null;
  /** An import this tile watched has succeeded; the page reloads what depends on the imported data. */
  onImported: () => void;
}

/** Imports a Little Navmap database, by upload or from the server's import folder, and follows the job. */
export function NavdataImportTile({ effectiveSource, onImported }: NavdataImportTileProps) {
  const [files, setFiles] = useState<LnmImportFilesResponse | null>(null);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [serverFile, setServerFile] = useState('');
  const [job, setJob] = useState<LnmImportJob | null>(null);
  const [jobError, setJobError] = useState('');
  const [uploading, setUploading] = useState<{ loaded: number; total: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [announcedId, setAnnouncedId] = useState<string | null>(null);
  const [localFailure, setLocalFailure] = useState<LocalFailure | null>(null);

  const mounted = useRef(false);
  const uploadAttempt = useRef<UploadAttempt | null>(null);
  const jobRef = useRef<LnmImportJob | null>(null);
  /** Ids of jobs this tile saw receiving or running, or was handed by its own request. */
  const watched = useRef(new Set<string>());
  const importedReported = useRef(new Set<string>());
  /** Finished jobs whose notice was cleared when a new request started; refreshing must not bring them back. */
  const noticeCleared = useRef(new Set<string>());
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  const applyJob = useCallback((next: LnmImportJob | null) => {
    jobRef.current = next;
    setJob(next);
    if (next === null) {
      setCancelling(false);
      return;
    }
    if (next.state === 'receiving' || next.state === 'running') {
      watched.current.add(next.id);
      return;
    }
    setCancelling(false);
    const wasWatched = watched.current.has(next.id);
    const recent = next.finishedAt !== null && Date.now() - next.finishedAt < RECENT_MS;
    if (readDismissed() !== next.id && !noticeCleared.current.has(next.id) && (wasWatched || recent)) {
      setAnnouncedId(next.id);
    }
    if (next.state === 'succeeded' && wasWatched && !importedReported.current.has(next.id)) {
      importedReported.current.add(next.id);
      onImportedRef.current();
    }
  }, []);

  const refreshJob = useCallback(async () => {
    try {
      const r = await fetchLnmImport();
      if (!mounted.current) return;
      applyJob(r.job);
      setJobError('');
    } catch (err) {
      if (!mounted.current || err instanceof UnauthorizedError) return;
      setCancelling(false);
      setJobError(messageOf(err));
    }
  }, [applyJob]);

  const loadFiles = useCallback(async (signal?: AbortSignal) => {
    setFilesLoading(true);
    try {
      const r = await fetchLnmImportFiles(signal);
      if (signal?.aborted || !mounted.current) return;
      setFiles(r);
      setFilesError('');
      setServerFile(current => (r.files.some(f => f.name === current) ? current : (r.files[0]?.name ?? '')));
    } catch (err) {
      if (signal?.aborted || !mounted.current || err instanceof UnauthorizedError) return;
      setFilesError(messageOf(err));
    } finally {
      if (!signal?.aborted && mounted.current) setFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadFiles(controller.signal);
    fetchLnmImport(controller.signal)
      .then(r => {
        if (controller.signal.aborted) return;
        applyJob(r.job);
      })
      .catch(err => {
        if (controller.signal.aborted || err instanceof UnauthorizedError) return;
        setJobError(messageOf(err));
      });
    return () => {
      mounted.current = false;
      controller.abort();
      // Leaving the page drops an upload in flight; the server ends that job as aborted.
      uploadAttempt.current?.controller.abort();
    };
  }, [applyJob, loadFiles]);

  const jobBusy = isBusy(job);
  useEffect(() => {
    if (!jobBusy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const r = await fetchLnmImport(controller.signal);
        if (stopped) return;
        applyJob(r.job);
        setJobError('');
      } catch (err) {
        if (stopped || err instanceof UnauthorizedError) return;
        setJobError(messageOf(err));
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [jobBusy, applyJob]);

  const clearNotices = () => {
    if (jobRef.current) noticeCleared.current.add(jobRef.current.id);
    setLocalFailure(null);
    setAnnouncedId(null);
    setCancelError('');
  };

  async function startUpload() {
    if (!file || tooLarge || busy) return;
    clearNotices();
    const priorJobId = jobRef.current?.id ?? null;
    const attempt: UploadAttempt = { controller: new AbortController(), cancelRequested: false };
    uploadAttempt.current = attempt;
    setUploading({ loaded: 0, total: file.size });
    try {
      const { job: started } = await uploadLnmDatabase(
        file,
        (loaded, total) => { if (mounted.current) setUploading({ loaded, total }); },
        attempt.controller.signal
      );
      if (!mounted.current) return;
      setFile(null);
      applyJob(started);
    } catch (err) {
      if (!mounted.current || err instanceof UnauthorizedError) return;
      // A cancel closes the request on purpose, and the browser may resend it; however the request then ends
      // (dropped, refused as busy, refused as already received) is part of the cancel, not a failure to report.
      if (attempt.cancelRequested || isAbortError(err)) return;
      // The server refuses a resend of an upload it already received. How that upload ended (cancelled from
      // another session, failed when its connection dropped, or still receiving) is in the job, so show that.
      if (err instanceof LnmUploadRefusedError && err.code === LNM_UPLOAD_REPEATED) {
        void refreshJob();
        return;
      }
      setLocalFailure({
        title: err instanceof LnmUploadNetworkError ? 'Upload failed' : 'Import failed',
        message: messageOf(err),
        priorJobId,
      });
      void refreshJob();
    } finally {
      if (uploadAttempt.current === attempt) uploadAttempt.current = null;
      if (mounted.current) setUploading(null);
    }
  }

  async function startPathImport() {
    if (!serverFile || busy) return;
    clearNotices();
    const priorJobId = jobRef.current?.id ?? null;
    setStarting(true);
    try {
      const { job: started } = await startLnmPathImport(serverFile);
      if (!mounted.current) return;
      applyJob(started);
    } catch (err) {
      if (!mounted.current || err instanceof UnauthorizedError) return;
      setLocalFailure({ title: 'Import failed', message: messageOf(err), priorJobId });
      void refreshJob();
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  /**
   * Stops the import. While an upload is open the server is told first, so the job ends cancelled rather than failed,
   * and then the request is dropped. The upload is read once, before the first await: a read of a terminal job can
   * re-enable the upload buttons while the cancel is still waiting for its answer, and a newer upload started then
   * must not be dropped by this cancel.
   */
  async function cancelImport() {
    const attempt = uploadAttempt.current;
    if (attempt) attempt.cancelRequested = true;
    setCancelling(true);
    setCancelError('');
    try {
      const { job: current } = await cancelLnmImport();
      if (current && mounted.current) applyJob(current);
    } catch (err) {
      if (mounted.current && !(err instanceof UnauthorizedError)) {
        setCancelError(messageOf(err));
        if (attempt === null || uploadAttempt.current !== attempt) setCancelling(false);
      }
    } finally {
      attempt?.controller.abort();
    }
    if (mounted.current) await refreshJob();
  }

  function dismissJob(id: string) {
    writeDismissed(id);
    setAnnouncedId(null);
  }

  function closeLocalFailure(failureJob: LnmImportJob | null) {
    if (failureJob) writeDismissed(failureJob.id);
    setLocalFailure(null);
    setAnnouncedId(null);
  }

  // The buttons that start an import stay disabled while a cancel waits for the server's answer: the cancel is meant
  // for the import that is current now, not for one started before the answer arrives.
  const busy = uploading !== null || starting || jobBusy || cancelling;
  const tooLarge = file !== null && files !== null && file.size > files.maxUploadBytes;
  const lowDisk = file !== null && files !== null && !tooLarge && files.availableBytes !== null
    && files.availableBytes < file.size + files.reserveBytes;
  // A request that ended while the server reports a cancelled job other than the one that was current before
  // the request started (cancelled from another page or session) ended because of that cancel, not on its own.
  const shownFailure = localFailure && !(job && job.state === 'cancelled' && job.id !== localFailure.priorJobId)
    ? localFailure
    : null;
  // The failed job that belongs to the failure being shown: its message replaces the generic one,
  // and the job is not announced a second time.
  const failureJob = shownFailure && job && job.state === 'failed' && job.error && job.id !== shownFailure.priorJobId
    ? job
    : null;
  const announced = job !== null && job.id === announcedId && !isBusy(job) && failureJob === null ? job : null;
  const cancelButton = (
    <Button kind="danger--ghost" size="sm" disabled={cancelling} onClick={() => { void cancelImport(); }}>Cancel</Button>
  );

  return (
    <Tile>
      <Stack gap={5}>
        <h3 className="sabia-heading-03">Import Little Navmap data</h3>
        <div>
          <p className="sabia-helper">
            {files
              ? `Upload a Little Navmap database (little_navmap_*.sqlite, up to ${gib(files.maxUploadBytes)} GiB), or put it in ${files.dir} on the server and pick it below. `
              : 'Upload a Little Navmap database (little_navmap_*.sqlite), or put it in the import folder on the server and pick it below. '}
            Sabiá builds its own navigation database from it; the simulator&apos;s database is never changed.
          </p>
          <p className="sabia-helper">
            In Docker, this is the navdata folder mounted into the container (./navdata next to docker-compose.yml).
          </p>
        </div>
        {filesLoading && files === null && <SkeletonText />}
        {filesError && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Could not read the import folder" subtitle={filesError} />
        )}

        <section aria-label="Upload a file">
          <Stack gap={4}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <FileUploaderButton
                labelText="Choose file…"
                buttonKind="tertiary"
                size="md"
                accept={['.sqlite']}
                disabled={busy}
                disableLabelChanges
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const picked = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  if (picked) setFile(picked);
                }}
              />
              {file && <span className="sabia-helper">{`${file.name} — ${megabytes(file.size)} MB`}</span>}
              <Button kind="primary" size="md" disabled={!file || tooLarge || busy} onClick={() => { void startUpload(); }}>
                Upload and import
              </Button>
            </div>
            {tooLarge && files && (
              <InlineNotification
                kind="error" lowContrast hideCloseButton style={{ maxInlineSize: 'none' }}
                title={`File is larger than ${gib(files.maxUploadBytes)} GiB`}
              />
            )}
            {lowDisk && file && files && files.availableBytes !== null && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton style={{ maxInlineSize: 'none' }}
                title={`The server may not have enough disk space (need ${mebibytes(file.size + files.reserveBytes)} MiB, ${Math.floor(files.availableBytes / MIB)} MiB free)`}
              />
            )}
            {uploading && (
              <div>
                <ProgressBar
                  label={cancelling ? 'Cancelling…' : 'Uploading'}
                  value={uploading.loaded}
                  max={Math.max(uploading.total, 1)}
                  helperText={`${megabytes(uploading.loaded)} / ${megabytes(uploading.total)} MB`}
                />
                <p className="sabia-helper">Keep this page open until the upload finishes.</p>
                {cancelButton}
              </div>
            )}
          </Stack>
        </section>

        <section aria-label="Import from the server">
          <Stack gap={4}>
            {files && files.files.length === 0 && (
              <p className="sabia-helper">{`No .sqlite files in ${files.dir}`}</p>
            )}
            {files && files.files.length > 0 && (
              <Select
                id="navdata-import-server-file"
                labelText="File on the server"
                value={serverFile}
                disabled={busy}
                onChange={e => setServerFile(e.target.value)}
              >
                {files.files.map(f => (
                  <SelectItem key={f.name} value={f.name} text={`${f.name} — ${megabytes(f.sizeBytes)} MB`} />
                ))}
              </Select>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <Button kind="ghost" size="md" disabled={filesLoading} onClick={() => { void loadFiles(); }}>Refresh</Button>
              <Button kind="primary" size="md" disabled={!serverFile || busy} onClick={() => { void startPathImport(); }}>
                Import
              </Button>
            </div>
          </Stack>
        </section>

        {!uploading && job?.state === 'running' && (
          <div>
            <ProgressBar
              label={cancelling ? 'Cancelling…' : `Importing — ${job.stage ? STAGE_LABEL[job.stage] : 'Starting'}`}
              value={Math.min(100, Math.max(0, job.fraction * 100))}
              max={100}
              helperText={job.sourceFileName}
            />
            {cancelButton}
          </div>
        )}
        {!uploading && job?.state === 'receiving' && (
          <div>
            <ProgressBar
              label={cancelling ? 'Cancelling…' : 'Uploading (another session)'}
              helperText={job.sourceFileName === '' ? undefined : job.sourceFileName}
            />
            {cancelButton}
          </div>
        )}

        {jobError && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Could not read the import status" subtitle={jobError} />
        )}
        {cancelError && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Could not cancel the import" subtitle={cancelError} />
        )}
        {shownFailure && (
          <InlineNotification
            kind="error" lowContrast style={{ maxInlineSize: 'none' }}
            title={shownFailure.title}
            subtitle={failureJob?.error?.message ?? shownFailure.message}
            onClose={() => closeLocalFailure(failureJob)}
          />
        )}
        {announced?.state === 'succeeded' && announced.result && (
          <InlineNotification
            key={announced.id} kind="success" lowContrast style={{ maxInlineSize: 'none' }}
            title={`Imported ${announced.result.dataset.label}.`}
            subtitle={effectiveSource === 'lnm' ? 'The map now shows this data.' : 'Select “Little Navmap import” above to use it.'}
            onClose={() => dismissJob(announced.id)}
          />
        )}
        {announced?.state === 'failed' && (
          <InlineNotification
            key={announced.id} kind="error" lowContrast style={{ maxInlineSize: 'none' }}
            title="Import failed"
            subtitle={announced.error?.message ?? 'The import did not finish.'}
            onClose={() => dismissJob(announced.id)}
          />
        )}
        {announced?.state === 'cancelled' && (
          <InlineNotification
            key={announced.id} kind="info" lowContrast style={{ maxInlineSize: 'none' }}
            title="Import cancelled."
            onClose={() => dismissJob(announced.id)}
          />
        )}
      </Stack>
    </Tile>
  );
}
