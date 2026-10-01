// ── Little Navmap import worker ──────────────────────────────────────────────
//
// Entry point of the worker thread started by workerRunner (index.ts). It reads
// the request from workerData, runs the pipeline, and posts the messages the
// runner forwards. It opens nothing but the atools file and the incoming
// replica: no flights.db, no replica handle of the main thread.

import { parentPort, workerData } from 'worker_threads';
import { runLnmPipelineToMessages } from './pipeline';
import type { LnmWorkerRequest } from './types';

if (!parentPort) throw new Error('the Little Navmap import worker must be started as a worker thread');
const port = parentPort;

runLnmPipelineToMessages(workerData as LnmWorkerRequest, message => port.postMessage(message));
