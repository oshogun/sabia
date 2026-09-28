// tests/mcp.test.ts — end-to-end coverage for src/mcp/**: a real MCP SDK
// client, over a real loopback HTTP socket, against the server's actual tool
// registrations (src/mcp/server.ts, src/mcp/tools/read.ts, src/mcp/tools/write.ts).
//
// Hermetic like tests/ingest.test.ts: the server binds to 127.0.0.1 on an
// ephemeral port and every module a tool handler could reach a database or
// SimBrief's network through is replaced (same convention as
// tests/flightManager.ground.test.ts's './db/groundSessions' mock — the
// submodule a tool imports directly, not the './db' barrel, since none of
// src/mcp/tools/*.ts import the barrel). No native binding is ever loaded, so
// no flights.db of any kind — live or scratch — is ever opened. get_status
// and get_ground_session's FlightManager dependency is a plain object literal
// (the same style ingest.test.ts uses for its FlightManager fake), not the
// real class, since no test here exercises live sim state.

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
// import_simbrief_leg's only dependency, replaced wholesale so its own import
// chain (src/db/settings.ts, src/simbriefClient.ts, ...) never loads either.
vi.mock('../src/simbriefImport', () => ({
  importSimbriefLooseLeg: vi.fn(),
}));
// createMcpTokenGate now verifies against the live token store on every
// request; this file never touches a database, so it is replaced with a
// fixed "zero active UI tokens" answer, which reproduces today's
// env-token-only behaviour for every existing assertion below.
vi.mock('../src/db/mcpTokens', () => ({
  verifyMcpToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import { createMcpRouter } from '../src/mcp/router';
import { toFlightSummary } from '../src/mcp/projections';
import * as flightsDb from '../src/db/flights';

// vi.mock() replaces the module at runtime, but a `* as` import is still typed
// against the real module's declarations — vi.mocked() re-types the same
// references as the mocks they actually are, with no unsafe cast (same
// pattern as tests/flightManager.ground.test.ts).
const getFlights = vi.mocked(flightsDb.getFlights);
const getFlightById = vi.mocked(flightsDb.getFlightById);
const updateFlight = vi.mocked(flightsDb.updateFlight);

const TOKEN = 'test-mcp-token';

// A golden list of the 18 tools the server registers, deliberately not
// derived from src/mcp/server.ts's own MCP_TOOLS export, so this test
// actually proves the registered set matches expectations rather than only
// that the source agrees with itself.
const EXPECTED_TOOL_NAMES = [
  'list_flights', 'get_flight', 'search_flights', 'get_flight_stats',
  'list_trips', 'get_trip', 'get_journey', 'list_planned_legs', 'get_planned_leg',
  'get_acars_thread', 'get_weather', 'list_canned_messages', 'get_status', 'get_ground_session',
  'update_flight_notes', 'create_trip', 'assign_flight_to_trip', 'import_simbrief_leg',
].sort();

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

// ── Server/client harness (modeled on tests/ingest.test.ts) ─────────────────

interface TestServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function createTestServer(token: string | null = TOKEN): Promise<TestServerHandle> {
  const config: McpConfig = { token, enabled: true };
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(config, makeFlightManager()));

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
  getFlights.mockReset();
  getFlightById.mockReset();
  updateFlight.mockReset();
});

async function startServer(token?: string | null): Promise<TestServerHandle> {
  const server = await createTestServer(token);
  openServers.push(server.close);
  return server;
}

async function connectClient(baseUrl: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  await client.connect(transport);
  openClients.push(() => client.close());
  return client;
}

function textOf(result: unknown): string {
  const block = (result as { content: Array<{ type: string; text: string }> }).content[0];
  return block.text;
}

// ── tools/list ────────────────────────────────────────────────────────────

describe('tools/list', () => {
  it('returns exactly the 18 designed tools, by name', async () => {
    const { baseUrl } = await startServer();
    const client = await connectClient(baseUrl, TOKEN);

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(18);
    expect(tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });
});

// ── list_flights — read round trip ──────────────────────────────────────────

describe('list_flights — read round trip', () => {
  it('returns the mocked fixture, projected through toFlightSummary', async () => {
    const flights = [
      makeFlightFixture({ id: 1 }),
      makeFlightFixture({ id: 2, aircraft: 'Boeing 737', notes: null, trip_id: 7 }),
    ];
    getFlights.mockReturnValue(flights);

    const { baseUrl } = await startServer();
    const client = await connectClient(baseUrl, TOKEN);

    const result = await client.callTool({ name: 'list_flights', arguments: {} });
    const body = JSON.parse(textOf(result));

    expect(getFlights).toHaveBeenCalledTimes(1);
    expect(body.total).toBe(2);
    expect(body.flights).toEqual(flights.map(toFlightSummary));
  });
});

// ── update_flight_notes — write round trip ──────────────────────────────────

describe('update_flight_notes — write round trip', () => {
  it('mutates only notes; an extra aircraft field never changes it, whether dropped or rejected', async () => {
    let fixture = makeFlightWithPointsFixture({ id: 1, aircraft: 'Cessna 172', notes: 'original notes' });
    updateFlight.mockImplementation((id, payload) => {
      if (id !== fixture.id) return false;
      // The handler is supposed to build a fresh `{ notes }` literal — this
      // mock fails loudly if that ever regresses to forwarding raw input.
      expect(payload).not.toHaveProperty('aircraft');
      fixture = { ...fixture, notes: payload.notes ?? null };
      return true;
    });
    getFlightById.mockImplementation(id => (id === fixture.id ? fixture : null));

    const { baseUrl } = await startServer();
    const client = await connectClient(baseUrl, TOKEN);

    const first = await client.callTool({
      name: 'update_flight_notes',
      arguments: { flight_id: 1, notes: 'updated notes' },
    });
    expect(first.isError).toBeFalsy();
    expect(fixture.notes).toBe('updated notes');
    expect(fixture.aircraft).toBe('Cessna 172');

    const aircraftBefore = fixture.aircraft;
    let rejected = false;
    let second: Awaited<ReturnType<typeof client.callTool>> | undefined;
    try {
      second = await client.callTool({
        name: 'update_flight_notes',
        arguments: { flight_id: 1, notes: 'second update', aircraft: 'Boeing 747' },
      });
    } catch {
      rejected = true;
    }

    // Whichever branch fired — a schema rejection, a tool-level isError, or a
    // silently-dropped extra field — the aircraft column is untouched.
    if (!rejected && second && !second.isError) {
      expect(fixture.notes).toBe('second update');
    }
    expect(fixture.aircraft).toBe(aircraftBefore);
    for (const call of updateFlight.mock.calls) {
      expect(call[1]).not.toHaveProperty('aircraft');
    }
  });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('MCP_TOKEN gate', () => {
  it('rejects a missing or invalid token before any tool executes', async () => {
    const { baseUrl } = await startServer();
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_flights', arguments: {} },
    });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

    const missing = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body });
    expect(missing.status).toBe(401);

    const invalid = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer wrong-token' },
      body,
    });
    expect(invalid.status).toBe(401);

    expect(getFlights).not.toHaveBeenCalled();
  });

  it('passes a request straight through when no MCP credential is configured anywhere, as if /mcp were never mounted', async () => {
    const config: McpConfig = { token: null, enabled: false };
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter(config, makeFlightManager()));
    app.use((_req, res) => { res.status(404).end(); });

    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    openServers.push(() => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))));

    const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    expect(getFlights).not.toHaveBeenCalled();
  });
});
