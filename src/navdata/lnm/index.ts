// ── Little Navmap import runners ─────────────────────────────────────────────
//
// How an import is started. workerRunner runs the pipeline in a worker thread
// and is what the server uses; inProcessRunner runs it on the calling thread
// and exists for vitest (which cannot start a .ts worker) and for the command
// line inspector. Both obey the same cancel latch: once cancel() has been
// called, no message reaches the caller and no error is invented for the
// stopped import.

import path from 'path';
import { Worker, type WorkerOptions } from 'worker_threads';
import { removeIncomingFiles, runLnmPipelineToMessages } from './pipeline';
import type { LnmImportRunner, LnmWorkerMessage, LnmWorkerRequest } from './types';

/** V8 old-space cap of the import worker; the build's measured peak is a fraction of it. */
export const WORKER_MAX_OLD_GENERATION_MB = 1024;

/** The slice of a worker thread the runner uses; a test substitutes a fake. */
export interface WorkerHandle {
  on(event: 'message', listener: (message: LnmWorkerMessage) => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}
export type WorkerSpawn = (file: string, options: WorkerOptions) => WorkerHandle;

const spawnWorker: WorkerSpawn = (file, options) => new Worker(file, options);

/** Under ts-node (npm run dev:server) this module is a .ts file, and so is the worker, compiled on load. */
const underTsNode = __filename.endsWith('.ts');

const logName = (err: unknown): string => (err instanceof Error ? err.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) : typeof err);

/** Runs the callback and logs, rather than throws, when it fails: a thrown error here would be uncaught in the server. */
function deliver(onMessage: (m: LnmWorkerMessage) => void, message: LnmWorkerMessage): void {
  try {
    onMessage(message);
  } catch (err) {
    console.error(`[Navdata] LNM import: the message handler failed: ${logName(err)}`);
  }
}

export function createWorkerRunner(spawn: WorkerSpawn = spawnWorker): LnmImportRunner {
  return {
    start(req: LnmWorkerRequest, onMessage) {
      let cancelled = false;
      // A done or error message has been forwarded (or invented); nothing else may be.
      let settled = false;
      let succeeded = false;
      let worker: WorkerHandle | null = null;

      const done = new Promise<void>(resolve => {
        const fail = (code: 'LNM_WORKER_FAILED' | 'LNM_OUT_OF_MEMORY', message: string): void => {
          if (cancelled || settled) return;
          settled = true;
          deliver(onMessage, { type: 'error', code, message });
        };
        const finish = (): void => {
          // A build that did not end in a delivered, uncancelled success leaves nothing behind.
          if (cancelled || !succeeded) removeIncomingFiles(req.incomingPath);
          resolve();
        };

        try {
          worker = spawn(path.join(__dirname, underTsNode ? 'worker.ts' : 'worker.js'), {
            workerData: req,
            resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB },
            ...(underTsNode ? { execArgv: ['--require', 'ts-node/register'] } : {}),
          });
        } catch (err) {
          console.error(`[Navdata] LNM import: could not start the worker: ${logName(err)}`);
          setImmediate(() => {
            fail('LNM_WORKER_FAILED', 'import worker stopped unexpectedly');
            finish();
          });
          return;
        }

        worker.on('message', message => {
          // A done the worker posted before terminate() is still delivered by Node afterwards.
          if (cancelled) return;
          if (message.type === 'done') succeeded = true;
          if (message.type !== 'progress') settled = true;
          deliver(onMessage, message);
        });
        // The exception text never crosses to the caller: it may hold a row value or a path.
        worker.on('error', err => {
          console.error(`[Navdata] LNM import: worker error: ${logName(err)}`);
          const outOfMemory = (err as { code?: unknown } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY';
          if (outOfMemory) fail('LNM_OUT_OF_MEMORY', 'import ran out of memory');
          else fail('LNM_WORKER_FAILED', 'import worker stopped unexpectedly');
        });
        worker.on('exit', () => {
          fail('LNM_WORKER_FAILED', 'import worker stopped unexpectedly');
          finish();
        });
      });

      return {
        done,
        cancel(): void {
          // The latch first: terminate() does not stop a message already on its way.
          cancelled = true;
          Promise.resolve(worker?.terminate()).catch(() => undefined);
        },
      };
    },
  };
}

/** The server's runner: one worker thread per import. */
export const workerRunner: LnmImportRunner = createWorkerRunner();

/** Runs the pipeline on the calling thread, in a setImmediate callback. Never used by the server. */
export const inProcessRunner: LnmImportRunner = {
  start(req: LnmWorkerRequest, onMessage) {
    let cancelled = false;
    const done = new Promise<void>(resolve => {
      setImmediate(() => {
        try {
          if (!cancelled) {
            runLnmPipelineToMessages(req, message => {
              if (!cancelled) deliver(onMessage, message);
            }, { isCancelled: () => cancelled });
          }
          if (cancelled) removeIncomingFiles(req.incomingPath);
        } finally {
          resolve();
        }
      });
    });
    return {
      done,
      cancel(): void {
        cancelled = true;
      },
    };
  },
};
