// tests/mcpFlightsChanged.test.ts — the onChanged callback createMcpRouter now
// threads through buildMcpServer to every write tool: exactly one call after
// each tool's DB write succeeds, zero on a toolError path. Read tools and
// tools/list are covered by tests/mcp.test.ts and are not repeated here.
//
// Same harness as tests/mcp.test.ts: a real MCP SDK client over a real
// loopback HTTP socket, with every db-touching module the write tools import
// mocked so no native sqlite binding is ever loaded.

import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Flight, FlightWithPoints } from '../src/types';
import type { FlightManager } from '../src/flightManager';
import type { McpConfig } from '../src/config';

vi.mock('../src/db/flights', () => ({
  getFlights: vi.fn(),
  getFlightById: vi.fn(),
  getFlightStats: vi.fn(),
  searchFlights: vi.fn(),
  countSearchFlights: vi.fn(),
  updateFlight: vi.fn(),
}));
vi.mock('../src/db/trips', () => ({
  getTripName: vi.fn(),
  getTrips: vi.fn(),
  getTripById: vi.fn(),
  createTrip: vi.fn(),
  assignFlightToTrip: vi.fn(),
}));
vi.mock('../src/db/plannedLegs', () => ({
  getPlannedLegsForTrip: vi.fn(),
  getAllPlannedLegs: vi.fn(),
  getPlannedLegById: vi.fn(),
}));
vi.mock('../src/db/acarsMessages', () => ({
  listAcarsMessagesForFlight: vi.fn(),
  listAcarsMessagesForPlannedLeg: vi.fn(),
}));
vi.mock('../src/db/groundSessions', () => ({
  getOpenGroundSession: vi.fn(),
}));
vi.mock('../src/simbriefImport', () => ({
  importSimbriefLooseLeg: vi.fn(),
}));
// See tests/mcp.test.ts's identical mock: createMcpTokenGate now reads the
// live token store, and this file has none.
vi.mock('../src/db/mcpTokens', () => ({
  verifyMcpToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import { createMcpRouter } from '../src/mcp/router';
import * as flightsDb from '../src/db/flights';
import * as tripsDb from '../src/db/trips';
import { importSimbriefLooseLeg } from '../src/simbriefImport';

const getFlightById = vi.mocked(flightsDb.getFlightById);
const updateFlight = vi.mocked(flightsDb.updateFlight);
const getTripById = vi.mocked(tripsDb.getTripById);
const createTrip = vi.mocked(tripsDb.createTrip);
const assignFlightToTrip = vi.mocked(tripsDb.assignFlightToTrip);
const importSimbriefLooseLegMock = vi.mocked(importSimbriefLooseLeg);

const TOKEN = 'test-mcp-token';

function makeFlightManager(): FlightManager {
  return {
    appState: {
      flightState: 'IDLE',
      currentFlightId: null,
      connected: false,
      lastFrame: null,
      paused: false,
      pauseFlags: 0,
    },
    getPlannedLegStatus: vi.fn(() => null),
    getGroundSessionStatus: vi.fn(() => null),
    refreshPlannedLegForFlight: vi.fn(),
  } as unknown as FlightManager;
}

function makeFlightFixture(over: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraft: 'Cessna 172',
    departure_lat: 34.426201,
    departure_lon: -119.841507,
    arrival_lat: 36.586952,
    arrival_lon: -121.843079,
    start_time: '2026-09-01T12:00:00.000Z',
    end_time: '2026-09-01T14:00:00.000Z',
    duration_sec: 7200,
    distance_nm: 150.4,
    max_altitude_ft: 8500,
    max_airspeed_kts: 120,
    point_count: 340,
    notes: 'A pleasant VFR hop.',
    trip_id: null,
    departure_icao: 'KSBA',
    departure_name: 'Santa Barbara Muni',
    arrival_icao: 'KMRY',
    arrival_name: 'Monterey Rgnl',
    flight_plan_name: null,
    planned_leg_id: null,
    planned_leg_link_source: null,
    planned_leg_prev_trip_id: null,
    ...over,
  };
}

function makeFlightWithPointsFixture(over: Partial<FlightWithPoints> = {}): FlightWithPoints {
  return { ...makeFlightFixture(over), points: over.points ?? [] };
}

// ── Server/client harness (modeled on tests/mcp.test.ts) ────────────────────

interface TestServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
  onChanged: ReturnType<typeof vi.fn>;
}

function createTestServer(): Promise<TestServerHandle> {
  const config: McpConfig = { token: TOKEN, enabled: true };
  const onChanged = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(config, makeFlightManager(), onChanged));

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
          server.close(error => (error ? closeReject(error) : closeResolve()));
        }),
        onChanged,
      });
    });
    server.on('error', reject);
  });
}

const openServers: Array<() => Promise<void>> = [];
const openClients: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(close => close()));
  await Promise.all(openServers.splice(0).map(close => close()));
});

beforeEach(() => {
  getFlightById.mockReset();
  updateFlight.mockReset();
  getTripById.mockReset();
  createTrip.mockReset();
  assignFlightToTrip.mockReset();
  importSimbriefLooseLegMock.mockReset();
});

async function startServer(): Promise<TestServerHandle> {
  const server = await createTestServer();
  openServers.push(server.close);
  return server;
}

async function connectClient(baseUrl: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  await client.connect(transport);
  openClients.push(() => client.close());
  return client;
}

describe('update_flight_notes onChanged', () => {
  it('calls onChanged once on a successful write', async () => {
    const fixture = makeFlightWithPointsFixture({ id: 1, notes: 'before' });
    updateFlight.mockReturnValue(true);
    getFlightById.mockReturnValue(fixture);

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({
      name: 'update_flight_notes',
      arguments: { flight_id: 1, notes: 'after' },
    });

    expect(result.isError).toBeFalsy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not call onChanged when the flight does not exist (toolError)', async () => {
    updateFlight.mockReturnValue(false);

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({
      name: 'update_flight_notes',
      arguments: { flight_id: 999, notes: 'after' },
    });

    expect(result.isError).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('create_trip onChanged', () => {
  it('calls onChanged once on success', async () => {
    createTrip.mockReturnValue(42);

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({ name: 'create_trip', arguments: { name: 'Alaska 2026' } });

    expect(result.isError).toBeFalsy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not call onChanged when the name is all whitespace (toolError)', async () => {
    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({ name: 'create_trip', arguments: { name: '   ' } });

    expect(result.isError).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(createTrip).not.toHaveBeenCalled();
  });
});

describe('assign_flight_to_trip onChanged', () => {
  it('calls onChanged once on success', async () => {
    getTripById.mockReturnValue({ id: 7, name: 'Test Trip', notes: null, created_at: '', is_active: 0 } as never);
    getFlightById.mockReturnValue(makeFlightWithPointsFixture({ id: 1 }));

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({
      name: 'assign_flight_to_trip',
      arguments: { flight_id: 1, trip_id: 7 },
    });

    expect(result.isError).toBeFalsy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(assignFlightToTrip).toHaveBeenCalledWith(1, 7);
  });

  it('does not call onChanged when the trip does not exist (toolError)', async () => {
    getTripById.mockReturnValue(null);

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({
      name: 'assign_flight_to_trip',
      arguments: { flight_id: 1, trip_id: 999 },
    });

    expect(result.isError).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(assignFlightToTrip).not.toHaveBeenCalled();
  });

  it('does not call onChanged when the flight does not exist (toolError)', async () => {
    getTripById.mockReturnValue({ id: 7, name: 'Test Trip', notes: null, created_at: '', is_active: 0 } as never);
    getFlightById.mockReturnValue(null);

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({
      name: 'assign_flight_to_trip',
      arguments: { flight_id: 999, trip_id: 7 },
    });

    expect(result.isError).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(assignFlightToTrip).not.toHaveBeenCalled();
  });
});

describe('import_simbrief_leg onChanged', () => {
  it('calls onChanged once on an imported outcome', async () => {
    importSimbriefLooseLegMock.mockResolvedValue({
      kind: 'imported',
      status: 201,
      body: {
        imported: [{ id: 5 } as never],
        result: { status: 'imported', planned_leg_id: 5, label: 'KSBA -> KMRY', warnings: [] },
      },
    });

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({ name: 'import_simbrief_leg', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('calls onChanged once on a duplicate outcome', async () => {
    importSimbriefLooseLegMock.mockResolvedValue({
      kind: 'duplicate',
      status: 200,
      body: {
        imported: [],
        result: { status: 'duplicate', planned_leg_id: 5, label: 'KSBA -> KMRY', warnings: [], error: 'already imported' },
      },
    });

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({ name: 'import_simbrief_leg', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not call onChanged on an error outcome', async () => {
    importSimbriefLooseLegMock.mockResolvedValue({
      kind: 'error',
      status: 400,
      body: { error: 'No SimBrief User ID is saved.', code: 'NO_USER_ID' },
    });

    const { baseUrl, onChanged } = await startServer();
    const client = await connectClient(baseUrl);

    const result = await client.callTool({ name: 'import_simbrief_leg', arguments: {} });

    expect(result.isError).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
