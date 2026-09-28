import express from 'express';
import type { Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// See tests/ingest.test.ts's identical mock: checkIngestCredential now reads
// the live token store, and this file has none.
vi.mock('../src/db/ingestTokens', () => ({
  verifyIngestToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import { createIngestRouter } from '../src/ingest';
import { makeFrame } from './helpers';

const ALLOWED_ORIGIN = 'coui://html_ui';
const TOKEN = 'test-ingest-token';

function createTestServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  onFrame: ReturnType<typeof vi.fn>;
}> {
  const onFrame = vi.fn();
  const flightManager = {
    appState: { connected: false, lastFrame: null },
    onFrame,
    onSimDisconnect: vi.fn(),
    setPaused: vi.fn(),
    onCrash: vi.fn(),
  } as unknown as Parameters<typeof createIngestRouter>[0];
  const trafficStore = {
    replace: vi.fn(),
  } as unknown as Parameters<typeof createIngestRouter>[1];
  const ingestConfig = {
    token: TOKEN,
  } as Parameters<typeof createIngestRouter>[2];

  const app = express();
  app.use(express.json());
  app.use('/api/ingest', createIngestRouter(flightManager, trafficStore, ingestConfig));

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Test server did not bind to a TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close(error => error ? closeReject(error) : closeResolve());
        }),
        onFrame,
      });
    });
    server.on('error', reject);
  });
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close => close()));
});

async function startServer() {
  const server = await createTestServer();
  openServers.push(server.close);
  return server;
}

describe('ingest router CORS', () => {
  it('answers allowed-origin preflight without authentication', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/api/ingest/frame`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Headers': 'content-type,x-ingest-token',
      },
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Ingest-Token');
    expect(response.headers.get('vary')?.split(',').map(value => value.trim())).toContain('Origin');
  });

  it('preserves a valid authenticated frame POST and exposes its response', async () => {
    const { baseUrl, onFrame } = await startServer();
    const frame = makeFrame();

    const response = await fetch(`${baseUrl}/api/ingest/frame`, {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
        'X-Ingest-Token': TOKEN,
      },
      body: JSON.stringify(frame),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(onFrame).toHaveBeenCalledWith(frame);
  });

  it('includes the allowed origin on an invalid-token response', async () => {
    const { baseUrl, onFrame } = await startServer();

    const response = await fetch(`${baseUrl}/api/ingest/frame`, {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
        'X-Ingest-Token': 'wrong-token',
      },
      body: JSON.stringify(makeFrame()),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('does not allow an unrelated origin', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/api/ingest/frame`, {
      method: 'POST',
      headers: {
        Origin: 'https://example.com',
        'Content-Type': 'application/json',
        'X-Ingest-Token': TOKEN,
      },
      body: JSON.stringify(makeFrame()),
    });

    expect(response.status).toBe(204);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('preserves origin-less desktop-agent behavior', async () => {
    const { baseUrl, onFrame } = await startServer();
    const frame = makeFrame();

    const response = await fetch(`${baseUrl}/api/ingest/frame`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Token': TOKEN,
      },
      body: JSON.stringify(frame),
    });

    expect(response.status).toBe(204);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.has('vary')).toBe(false);
    expect(onFrame).toHaveBeenCalledWith(frame);
  });
});
