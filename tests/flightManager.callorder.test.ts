// Characterization net for FlightManager: each scenario drives the manager
// through public methods only, and the WHOLE ordered log of stubbed IO calls,
// scope notifies and console lines is compared with a golden captured from
// the current code. Any change in the order or count of a call, a notify or a
// log line fails here, even when every value-level test still passes.
//
// Only the five IO boundaries are mocked (see ./helpers/callOrder); the
// manager and its pure collaborators run for real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFrame, makeCandidate, makePlannedLegWithChildren, northOfNm, KSBA, useFakeClock, useRealClock } from './helpers';

vi.mock('../src/db', async () => (await import('./helpers/callOrder')).dbStub);
vi.mock('../src/db/groundSessions', async () => (await import('./helpers/callOrder')).groundSessionsStub);
vi.mock('../src/airports', async () => (await import('./helpers/callOrder')).airportsStub);
vi.mock('../src/acarsEvents', async () => (await import('./helpers/callOrder')).acarsEventsStub);
vi.mock('../src/acars', async (importOriginal) =>
  (await import('./helpers/callOrder')).wrapAcars(await importOriginal<typeof import('../src/acars')>()));

import { FlightManager } from '../src/flightManager';
import {
  behave, ground, takeLog, golden, consoleText, captureConsole, attachListener, resetCallOrder, makeSessionRow,
  PARKED, ROLL, TAXI, LANDED, iso, feed, takeoff, cruise, park, land, arrangeLeg, openRow, TRACK, boom, thrown,
  notifies, warns, callsTo, endState,
} from './helpers/callOrder';

function newFm(): FlightManager {
  const fm = new FlightManager();
  attachListener(fm);
  return fm;
}

const savedInterval = process.env.POSITION_REPORT_INTERVAL_MIN;

beforeEach(() => {
  resetCallOrder();
  useFakeClock();
  captureConsole();
  delete process.env.POSITION_REPORT_INTERVAL_MIN;
});
afterEach(() => {
  useRealClock();
  if (savedInterval === undefined) delete process.env.POSITION_REPORT_INTERVAL_MIN;
  else process.env.POSITION_REPORT_INTERVAL_MIN = savedInterval;
});

const BOOT_CHECK = '[FlightManager] Open-flight check failed; starting fresh if a takeoff follows: Error: ';

describe('call order', () => {
  it('S-01 takeoff from GROUND with a linked leg, measured OUT', () => {
    arrangeLeg();
    const fm = newFm();
    park(fm); feed(fm, 2, TAXI); takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-01', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 2 });
    expect(warns(log)).toEqual([]);
    expect(callsTo(log, 'airports.findNearestAirport')).toHaveLength(2);
    expect(fm.getGroundSessionStatus()).toBeNull();
  });

  it('S-02 takeoff from IDLE, unlinked, no ground session', () => {
    const fm = newFm();
    takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-02', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([]);
  });

  it('S-03 resume with points', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightTrackPoints = () => TRACK;
    const fm = newFm();
    feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 3, northOfNm(KSBA, 6));
    const log = takeLog();
    const g = golden('S-03', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 2 });
    expect(callsTo(log, 'db.insertFlight')).toEqual([]);
    expect(callsTo(log, 'acars.buildOooiMessage')).toEqual([]);
  });

  it('S-04 resume without points', () => {
    behave.db.getOpenFlight = () => openRow();
    const fm = newFm();
    feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 3, northOfNm(KSBA, 6));
    const log = takeLog();
    const g = golden('S-04', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 2 });
    expect(callsTo(log, 'db.insertFlight')).toEqual([]);
  });

  it('S-05 landing with touchdown ON, linked', () => {
    arrangeLeg();
    behave.db.getFlightPlannedLegId = () => 11;
    const fm = newFm();
    takeoff(fm); cruise(fm); land(fm); feed(fm, 3, LANDED);
    const log = takeLog();
    const g = golden('S-05', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'airports.findNearestAirport')).toHaveLength(3);
    expect(callsTo(log, 'acars.buildOooiMessage')).toHaveLength(4);
  });

  it('S-06 sim exit while FLYING: ON fallback then IN, linked', () => {
    arrangeLeg();
    behave.db.getFlightPlannedLegId = () => 11;
    const fm = newFm();
    takeoff(fm); cruise(fm); feed(fm, 1, { simRunning: 0 }); feed(fm, 3, ROLL);
    const log = takeLog();
    const g = golden('S-06', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'db.closeFlight')).toHaveLength(1);
  });

  it('S-07 crash while FLYING, linked', () => {
    arrangeLeg();
    behave.db.getFlightPlannedLegId = () => 11;
    const fm = newFm();
    takeoff(fm); cruise(fm); fm.onCrash(); feed(fm, 3, ROLL);
    const log = takeLog();
    const g = golden('S-07', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'db.closeFlight')).toHaveLength(1);
  });

  it('S-08 ground entry by adopt, the airport agrees', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', parking_position: 'STAND 7', parking_position_source: 'manual' });
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    const g = golden('S-08', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(fm.getGroundSessionStatus()).toMatchObject({
      groundSessionId: 100, source: 'manual', airportIcao: 'KSBA', airportName: 'Santa Barbara Muni', parkingPosition: 'STAND 7',
    });
    expect(callsTo(log, 'groundSessions.insertGroundSession')).toEqual([]);
  });

  it('S-09 ground entry by adopt, the airport disagrees', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KLAX' });
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    const g = golden('S-09', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(consoleText(log)).toContain('detected airport KSBA disagrees with recorded KLAX; keeping KLAX');
  });

  it('S-10 ground entry by insert, with a matched leg', () => {
    arrangeLeg();
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    const g = golden('S-10', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(fm.getGroundSessionStatus()).toMatchObject({
      tripId: 1, tripName: 'Test Trip', departureIdent: 'KSBA', destinationIdent: 'KMRY',
    });
  });

  it('S-11 GROUND exit: slew', () => {
    const fm = newFm();
    park(fm); feed(fm, 1, { ...PARKED, simRunning: 3 }); park(fm, 3);
    const log = takeLog();
    const g = golden('S-11', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession').map(c => c.args)).toEqual([['slew']]);
  });

  it('S-12 GROUND exit: superseded', () => {
    const fm = newFm();
    const far = northOfNm(KSBA, 20);
    park(fm); park(fm, 1, far); park(fm, 3, far);
    const log = takeLog();
    const g = golden('S-12', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession').map(c => c.args)).toEqual([['superseded']]);
  });

  it('S-13 GROUND exit: a sim-exit frame closes a manual session', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA' });
    const fm = newFm();
    park(fm); feed(fm, 1, { ...PARKED, simRunning: 0 }); feed(fm, 3, { simRunning: 0 });
    const log = takeLog();
    const g = golden('S-13', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(ground.open).toBeNull();
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession').map(c => c.args)).toEqual([['sim-exit']]);
  });

  it('S-14 GROUND exit: the refresh finds the session closed', () => {
    const fm = newFm();
    park(fm);
    ground.open = null;
    fm.refreshGroundSession();
    park(fm, 3);
    const log = takeLog();
    const g = golden('S-14', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession')).toEqual([]);
  });

  it('S-15 GROUND exit: onSimDisconnect closes an auto session', () => {
    const fm = newFm();
    park(fm); fm.onSimDisconnect(); park(fm, 3);
    const log = takeLog();
    const g = golden('S-15', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession').map(c => c.args)).toEqual([['sim-exit']]);
  });

  it('S-16 GROUND exit: onCrash leaves a manual session open', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA' });
    const fm = newFm();
    park(fm); fm.onCrash(); park(fm, 3);
    const log = takeLog();
    const g = golden('S-16', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(ground.open).not.toBeNull();
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession')).toEqual([]);
  });

  it('S-17 a linked resume 25 min after start files position-report window 2 before the notify', () => {
    arrangeLeg();
    behave.db.getOpenFlight = () => openRow({ start_time: iso(-25 * 60_000) });
    behave.db.getFlightPlannedLegId = () => 11;
    const fm = newFm();
    feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 3, northOfNm(KSBA, 6));
    const log = takeLog();
    const g = golden('S-17', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 2 });
    const reports = callsTo(log, 'acars.buildPositionReportMessage');
    expect(reports).toHaveLength(1);
    expect(reports[0].args[0]).toMatchObject({ flightId: 77, windowIndex: 2, plannedLegId: 11 });
    const firstNotify = log.findIndex(e => e.t === 'notify');
    const reportAt = log.findIndex(e => e.t === 'call' && e.fn === 'acars.buildPositionReportMessage');
    const lastNotify = log.map(e => e.t).lastIndexOf('notify');
    expect(firstNotify).toBeLessThan(reportAt);
    expect(reportAt).toBeLessThan(lastNotify);
  });

  it('S-18 getOpenFlight throws: warned once, asked once over many frames', () => {
    behave.db.getOpenFlight = boom('open lookup failed');
    const fm = newFm();
    feed(fm, 2, ROLL); takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-18', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'open lookup failed']);
    expect(callsTo(log, 'db.getOpenFlight')).toHaveLength(1);
  });

  it('S-19 open row, getFlightTrackPoints throws: stays IDLE, and a takeoff follows', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightTrackPoints = boom('track read failed');
    const fm = newFm();
    feed(fm, 1); feed(fm, 2); cruise(fm);
    const log = takeLog();
    const g = golden('S-19', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'track read failed']);
    expect(callsTo(log, 'db.insertFlight')).toHaveLength(1);
  });

  it('S-20 open row, insertPoint throws during the resume: FLYING without the final notify', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.insertPoint = boom('point write failed');
    const fm = newFm();
    const threw = thrown(() => feed(fm, 1, northOfNm(KSBA, 5)));
    behave.db.insertPoint = () => undefined;
    cruise(fm, 3, northOfNm(KSBA, 6));
    const log = takeLog();
    const g = golden('S-20', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 1 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'point write failed']);
  });

  it('S-21 the first frame, at simRunning 0, does not look up; a slew frame next resumes', () => {
    behave.db.getOpenFlight = () => openRow();
    const fm = newFm();
    feed(fm, 1, { simRunning: 0 });
    const first = takeLog();
    expect(first).toEqual([]);
    feed(fm, 1, { simRunning: 3 }); cruise(fm);
    const log = takeLog();
    const g = golden('S-21', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 2 });
    expect(callsTo(log, 'db.getOpenFlight')).toHaveLength(1);
  });

  it('S-22 a slew frame in IDLE with no open row: the one lookup still runs', () => {
    const fm = newFm();
    feed(fm, 1, { simRunning: 3 }); feed(fm, 2, ROLL); takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-22', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(callsTo(log, 'db.getOpenFlight')).toHaveLength(1);
  });

  it('S-23 refresh while FLYING adopts, then drops the cache; the state stays FLYING', () => {
    const fm = newFm();
    takeoff(fm);
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', parking_position: 'STAND 7' });
    fm.refreshGroundSession();
    const adopted = fm.getGroundSessionStatus();
    ground.open = null;
    fm.refreshGroundSession();
    const dropped = fm.getGroundSessionStatus();
    cruise(fm);
    const log = takeLog();
    const g = golden('S-23', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 3 });
    expect(adopted?.groundSessionId).toBe(100);
    expect(dropped).toBeNull();
  });

  it('S-24 a manual session adopted by refresh while IDLE, then a takeoff: OUT comes from the session, estimated', () => {
    const fm = newFm();
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', airport_name: 'Santa Barbara Muni', parking_position: 'STAND 7', parking_position_source: 'manual' });
    fm.refreshGroundSession();
    takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-24', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 2 });
    const out = callsTo(log, 'acars.buildOooiMessage')[0].args[0];
    expect(out).toMatchObject({ event: 'OUT', airportIcao: 'KSBA', stand: 'STAND 7', estimated: true });
    expect(ground.open).toBeNull();
  });

  it('S-25 the position-report window is consumed when the status lookup throws', () => {
    process.env.POSITION_REPORT_INTERVAL_MIN = '0.5';
    arrangeLeg({ waypoints: [makePlannedLegWithChildren().waypoints[0]], waypoint_count: 1 });
    const fm = newFm();
    takeoff(fm); cruise(fm, 13);
    const log = takeLog();
    const g = golden('S-25', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    const text = "[FlightManager] Position report not filed: TypeError: Cannot read properties of undefined (reading 'lat')";
    expect(warns(log)).toEqual([text, text]);
    expect(callsTo(log, 'acars.buildPositionReportMessage')).toEqual([]);
  });

  it('S-26 a ground close in startFlight throws: warned, and the takeoff completes', () => {
    behave.groundSessions.closeOpenGroundSession = boom('close failed');
    const fm = newFm();
    takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-26', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 ground session close failed: Error: close failed']);
  });

  it('S-27 a linked takeoff from IDLE: link, notify, OUT, OFF, first point', () => {
    arrangeLeg();
    const fm = newFm();
    takeoff(fm); cruise(fm);
    const log = takeLog();
    const g = golden('S-27', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    const at = (pred: (e: (typeof log)[number]) => boolean): number => log.findIndex(pred);
    const link = at(e => e.t === 'call' && e.fn === 'db.linkFlightToPlannedLeg');
    const notify = at(e => e.t === 'notify');
    const interval = at(e => e.t === 'log' && e.text.includes('position reports every'));
    const out = at(e => e.t === 'call' && e.fn === 'acars.buildOooiMessage');
    const started = at(e => e.t === 'log' && e.text.includes('started'));
    const point = at(e => e.t === 'call' && e.fn === 'db.insertPoint');
    expect(link).toBeGreaterThan(-1);
    expect([link, notify, interval, out, started, point]).toEqual([link, notify, interval, out, started, point].sort((a, b) => a - b));
  });

  it('S-28 refreshPlannedLegForFlight: a non-current flight notifies only; a current flight links, then unlinks', () => {
    arrangeLeg();
    const fm = newFm();
    fm.refreshPlannedLegForFlight(999);
    behave.db.getActiveTripId = () => null;
    takeoff(fm);
    behave.db.getFlightPlannedLegId = () => 11;
    fm.refreshPlannedLegForFlight(1);
    const linked = fm.getPlannedLegStatus(KSBA.lat, KSBA.lon);
    behave.db.getFlightPlannedLegId = () => null;
    fm.refreshPlannedLegForFlight(1);
    const unlinked = fm.getPlannedLegStatus(KSBA.lat, KSBA.lon);
    cruise(fm);
    const log = takeLog();
    const g = golden('S-28', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 4 });
    expect(linked?.plannedLegId).toBe(11);
    expect(unlinked).toBeNull();
  });

  it('S-29 status reads: the payload reads the open session only outside a flight', () => {
    arrangeLeg();
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', planned_leg_id: 11 });
    const fm = newFm();
    const idle = fm.getFlightStatePayload();
    fm.getGroundSessionStatus(); fm.getPlannedLegStatus(KSBA.lat, KSBA.lon);
    takeoff(fm);
    const flying = fm.getFlightStatePayload();
    fm.getGroundSessionStatus(); fm.getPlannedLegStatus(KSBA.lat, KSBA.lon);
    cruise(fm);
    const log = takeLog();
    const g = golden('S-29', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(idle).toMatchObject({ flightState: 'IDLE', currentFlightId: null, plannedLegId: 11 });
    expect(flying).toMatchObject({ flightState: 'FLYING', currentFlightId: 1, plannedLegId: 11 });
  });

  it('S-30 pause and slew during FLYING are excluded from the duration', () => {
    const fm = newFm();
    takeoff(fm); cruise(fm, 2);
    fm.setPaused(true, 8); cruise(fm, 4); fm.setPaused(false);
    cruise(fm, 2); feed(fm, 2, { simRunning: 3 }, 5000); cruise(fm, 2);
    land(fm); feed(fm, 3, LANDED);
    const log = takeLog();
    const g = golden('S-30', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(consoleText(log)).toContain('30s (40s interrupted, excluded)');
  });

  it('S-31 onSimDisconnect while FLYING ends the flight from the last frame', () => {
    const fm = newFm();
    takeoff(fm); cruise(fm); fm.onSimDisconnect(); feed(fm, 3, ROLL);
    const log = takeLog();
    const g = golden('S-31', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(callsTo(log, 'db.closeFlight')).toHaveLength(1);
  });

  it('S-32 a second flight in the same process: OUT is estimated, and its own touchdown files ON', () => {
    const fm = newFm();
    park(fm); feed(fm, 2, TAXI); takeoff(fm); cruise(fm, 1); land(fm);
    takeoff(fm); cruise(fm, 1); land(fm);
    const log = takeLog();
    const g = golden('S-32', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 5 });
    expect(warns(log)).toEqual([]);
    const events = callsTo(log, 'acars.buildOooiMessage').map(c => c.args[0] as { flightId: number; event: string; estimated: boolean });
    expect(events.map(e => [e.flightId, e.event, e.estimated])).toEqual([
      [1, 'OUT', false], [1, 'OFF', false], [1, 'ON', false], [1, 'IN', false],
      [2, 'OUT', true], [2, 'OFF', false], [2, 'ON', false], [2, 'IN', false],
    ]);
  });

  it('S-33 a touchdown frame that is also due a point writes the point before it files ON', () => {
    const fm = newFm();
    takeoff(fm); cruise(fm, 1); feed(fm, 1, LANDED, 5000); land(fm);
    const log = takeLog();
    const g = golden('S-33', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual([]);
    const on = callsTo(log, 'acars.buildOooiMessage').find(c => (c.args[0] as { event: string }).event === 'ON')!;
    const touchdownPoint = log.findIndex(e => e.t === 'call' && e.fn === 'db.insertPoint' && e.args[1] === (on.args[0] as { at: string }).at);
    expect(touchdownPoint).toBeGreaterThan(-1);
    expect(touchdownPoint).toBeLessThan(log.indexOf(on));
  });

  it('S-34 the off-blocks memo starts at exactly 3 kt on the ground, not below it', () => {
    const fm = newFm();
    park(fm);
    feed(fm, 1, { onGround: true, groundSpeedKnots: 2.9, airspeedKnots: 0 });
    feed(fm, 1, { onGround: true, groundSpeedKnots: 3, airspeedKnots: 0 });
    vi.advanceTimersByTime(4000);
    takeoff(fm); cruise(fm, 1);
    const log = takeLog();
    const g = golden('S-34', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 2 });
    expect(warns(log)).toEqual([]);
    expect(callsTo(log, 'acars.buildOooiMessage')[0].args[0]).toMatchObject({ event: 'OUT', at: iso(7000), estimated: false });
  });

  it('S-35 a slew exit after taxiing forgets the off-blocks memo: a later takeoff from IDLE files OUT estimated', () => {
    const fm = newFm();
    park(fm); feed(fm, 2, TAXI); feed(fm, 1, { ...PARKED, simRunning: 3 });
    takeoff(fm); cruise(fm, 1);
    const log = takeLog();
    const g = golden('S-35', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 3 });
    expect(warns(log)).toEqual([]);
    expect(callsTo(log, 'acars.buildOooiMessage')[0].args[0]).toMatchObject({ event: 'OUT', at: iso(8000), estimated: true });
  });

  it('S-36 position reports disabled: a linked takeoff logs the disabled line and files no position report', () => {
    process.env.POSITION_REPORT_INTERVAL_MIN = '0';
    arrangeLeg();
    const fm = newFm();
    takeoff(fm); cruise(fm, 3);
    const log = takeLog();
    const g = golden('S-36', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([]);
    expect(consoleText(log)).toContain('log [FlightManager] Flight #1 position reports disabled (POSITION_REPORT_INTERVAL_MIN=0)\n');
    expect(callsTo(log, 'acars.buildPositionReportMessage')).toEqual([]);
  });

  it('S-37 a ground entry with no airport in range logs the no-airport line and records no airport', () => {
    const fm = newFm();
    const far = northOfNm(KSBA, 50);
    park(fm, 5, far); park(fm, 3, far);
    const log = takeLog();
    const g = golden('S-37', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(warns(log)).toEqual([]);
    expect(consoleText(log)).toContain('log [FlightManager] Ground session #100 — no airport within 10 nm\n');
    expect(fm.getGroundSessionStatus()).toMatchObject({ airportIcao: null, airportName: null });
  });

  it('S-38 a flight that takes off and lands out of range of any airport logs no airport lines and stores none', () => {
    const fm = newFm();
    const far = northOfNm(KSBA, 50);
    takeoff(fm, far); cruise(fm, 1, far); feed(fm, 10, { ...LANDED, ...far });
    const log = takeLog();
    const g = golden('S-38', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual([]);
    expect(consoleText(log)).not.toContain('Departure airport');
    expect(consoleText(log)).not.toContain('Arrival airport');
    expect(callsTo(log, 'db.insertFlight')[0].args.slice(4)).toEqual([null, null]);
    expect(callsTo(log, 'db.closeFlight')[0].args.slice(9)).toEqual([null, null]);
  });

  it('S-39 a single nearby leg that is refused names it in the refusal line, on the ground and at takeoff', () => {
    behave.db.getActiveTripId = () => 1;
    behave.db.getPlannedLegCandidatesForActiveTrip = () => [makeCandidate({ status: 'flown' })];
    const fm = newFm();
    park(fm); takeoff(fm); cruise(fm, 1);
    const log = takeLog();
    const g = golden('S-39', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 2 });
    expect(warns(log)).toEqual([]);
    expect(consoleText(log)).toContain('log [FlightManager] Ground session not linked to a planned leg — LEG_ALREADY_FLOWN (leg 11 within 10 nm, nearest 0.0 nm)\n');
    expect(consoleText(log)).toContain('log [FlightManager] Flight #1 not linked — LEG_ALREADY_FLOWN (leg 11 within 10 nm, nearest 0.0 nm)\n');
  });
});

describe('error policy', () => {
  it('E-01 insertFlight throws through: the takeoff is retried on the next airborne frame', () => {
    behave.db.insertFlight = boom('insert failed');
    const fm = newFm();
    fm.onFrame(makeFrame()); fm.onFrame(makeFrame());
    const first = thrown(() => fm.onFrame(makeFrame()));
    const again = thrown(() => feed(fm, 1));
    const log = takeLog();
    const g = golden('E-01', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(first).toBe('insert failed');
    expect(again).toBe('insert failed');
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual([]);
  });

  it('E-02 insertPoint throws through on the takeoff point, after the notify, OUT and OFF', () => {
    behave.db.insertPoint = boom('point failed');
    const fm = newFm();
    fm.onFrame(makeFrame()); fm.onFrame(makeFrame());
    const threw = thrown(() => fm.onFrame(makeFrame()));
    const log = takeLog();
    const g = golden('E-02', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('point failed');
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([]);
    expect(log[log.length - 1]).toMatchObject({ t: 'call', fn: 'db.insertPoint' });
  });

  it('E-03 insertPoint throws through on a FLYING frame', () => {
    const fm = newFm();
    takeoff(fm);
    behave.db.insertPoint = boom('point failed');
    const threw = thrown(() => cruise(fm, 1));
    const log = takeLog();
    const g = golden('E-03', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('point failed');
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([]);
  });

  it('E-04 closeFlight throws through: no ended log, no IN, no notify', () => {
    behave.db.closeFlight = boom('close failed');
    const fm = newFm();
    takeoff(fm); cruise(fm, 1);
    const threw = thrown(() => land(fm));
    const log = takeLog();
    const g = golden('E-04', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('close failed');
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([]);
    expect(log[log.length - 1]).toMatchObject({ t: 'call', fn: 'db.closeFlight' });
  });

  it('E-05 getOpenFlight throws: swallowed by the boot check, asked exactly once', () => {
    behave.db.getOpenFlight = boom('open lookup failed');
    const fm = newFm();
    const threw = thrown(() => feed(fm, 5, ROLL));
    const log = takeLog();
    const g = golden('E-05', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'open lookup failed']);
    expect(callsTo(log, 'db.getOpenFlight')).toHaveLength(1);
  });

  it('E-06 a resume getFlightTrackPoints throw is swallowed by the boot check', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightTrackPoints = boom('track read failed');
    const fm = newFm();
    const threw = thrown(() => { feed(fm, 1, ROLL); feed(fm, 3, ROLL); });
    const log = takeLog();
    const g = golden('E-06', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'track read failed']);
  });

  it('E-07 a resume insertPoint throw is swallowed by the boot check, after the leg-refresh notify', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.insertPoint = boom('point write failed');
    const fm = newFm();
    const threw = thrown(() => feed(fm, 1, northOfNm(KSBA, 5)));
    const log = takeLog();
    const g = golden('E-07', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 1 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'point write failed']);
  });

  it('E-08 the resume leg refresh throws: warned, and the resume completes', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightPlannedLegId = boom('leg id read failed');
    const fm = newFm();
    const threw = thrown(() => { feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 3, northOfNm(KSBA, 6)); });
    const log = takeLog();
    const g = golden('E-08', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #77 planned-leg cache not restored: Error: leg id read failed']);
  });

  it('E-09 the startFlight ground close throws: swallowed, and OUT has no airport or stand', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA' });
    behave.groundSessions.closeOpenGroundSession = boom('close failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm); });
    const log = takeLog();
    const g = golden('E-09', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 ground session close failed: Error: close failed']);
    expect(callsTo(log, 'acars.buildOooiMessage')[0].args[0]).toMatchObject({ event: 'OUT', airportIcao: null, stand: null });
  });

  it('E-10 insertGroundSession throws: stays IDLE and retries after another debounce', () => {
    behave.groundSessions.insertGroundSession = boom('insert session failed');
    const fm = newFm();
    const threw = thrown(() => { park(fm); park(fm, 4); });
    const between = fm.getGroundSessionStatus();
    park(fm, 1);
    const log = takeLog();
    const g = golden('E-10', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    const text = '[FlightManager] Ground session entry failed, staying IDLE: Error: insert session failed';
    expect(warns(log)).toEqual([text, text]);
    expect(between).toBeNull();
    expect(fm.getGroundSessionStatus()).toBeNull();
  });

  it('E-11 getOpenGroundSession throws in the entry: nothing after it runs', () => {
    behave.groundSessions.getOpenGroundSession = boom('open session read failed');
    const fm = newFm();
    const threw = thrown(() => { park(fm); park(fm, 3); });
    const log = takeLog();
    const g = golden('E-11', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session entry failed, staying IDLE: Error: open session read failed']);
    expect(callsTo(log, 'airports.findNearestAirport')).toEqual([]);
    expect(callsTo(log, 'db.getActiveTripId')).toEqual([]);
  });

  it('E-12 the ground-entry leg match throws: warned, and the session is still inserted', () => {
    behave.db.getActiveTripId = () => 1;
    behave.db.getPlannedLegCandidatesForActiveTrip = boom('candidates failed');
    const fm = newFm();
    const threw = thrown(() => { park(fm); park(fm, 3); });
    const log = takeLog();
    const g = golden('E-12', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session leg match failed: Error: candidates failed']);
    expect(callsTo(log, 'groundSessions.insertGroundSession')[0].args[0]).toMatchObject({ planned_leg_id: null, parking_position: null });
  });

  it('E-13 the slew ground close throws: warned, and the state still returns to IDLE', () => {
    const fm = newFm();
    park(fm);
    behave.groundSessions.closeOpenGroundSession = boom('close failed');
    const threw = thrown(() => { feed(fm, 1, { ...PARKED, simRunning: 3 }); park(fm, 3); });
    const log = takeLog();
    const g = golden('E-13', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session close (slew) failed: Error: close failed']);
  });

  it('E-14 the crash ground close throws: warned, and the state still returns to IDLE', () => {
    const fm = newFm();
    park(fm);
    behave.groundSessions.getOpenGroundSession = boom('open session read failed');
    const threw = thrown(() => fm.onCrash());
    behave.groundSessions.getOpenGroundSession = () => ground.open;
    park(fm, 3);
    const log = takeLog();
    const g = golden('E-14', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session close (crash) failed: Error: open session read failed']);
  });

  it('E-15 the auto-link throws: warned, and the flight is recorded unlinked', () => {
    behave.db.getActiveTripId = boom('active trip failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm); });
    const log = takeLog();
    const g = golden('E-15', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 auto-link failed, flight recorded unlinked: Error: active trip failed']);
    expect(callsTo(log, 'db.getPlannedLegCandidatesForActiveTrip')).toEqual([]);
  });

  it('E-16 the arrival write throws: warned, and IN still carries the leg', () => {
    arrangeLeg();
    behave.db.getFlightPlannedLegId = () => 11;
    behave.db.recordPlannedLegArrival = boom('arrival failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm, 1); land(fm); feed(fm, 3, LANDED); });
    const log = takeLog();
    const g = golden('E-16', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 arrival not recorded on its planned leg: Error: arrival failed']);
    expect(callsTo(log, 'acars.buildOooiMessage').map(c => (c.args[0] as { event: string }).event)).toEqual(['OUT', 'OFF', 'ON', 'IN']);
  });

  it('E-17 the position-report build throws: warned, and the point is kept', () => {
    process.env.POSITION_REPORT_INTERVAL_MIN = '0.5';
    arrangeLeg();
    behave.acars.buildPositionReportMessage = boom('report build failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm, 7); });
    const log = takeLog();
    const g = golden('E-17', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Position report not filed: Error: report build failed']);
    expect(callsTo(log, 'acarsEvents.fileAcarsMessageOnce').filter(c => String(c.args[0]).includes('position-report'))).toEqual([]);
  });

  it('E-18 the scope listener throws: warned, and the takeoff completes', () => {
    const fm = new FlightManager();
    fm.setScopeChangeListener(() => { throw new Error('listener failed'); });
    const threw = thrown(() => { takeoff(fm); cruise(fm, 1); });
    const log = takeLog();
    const g = golden('E-18', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 0 });
    expect(warns(log)).toEqual(['[FlightManager] scope listener failed: Error: listener failed']);
  });

  it('E-19 refreshGroundSession throws through when the lookup fails', () => {
    const fm = newFm();
    behave.groundSessions.getOpenGroundSession = boom('open session read failed');
    const threw = thrown(() => fm.refreshGroundSession());
    const log = takeLog();
    const g = golden('E-19', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('open session read failed');
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual([]);
    expect(fm.getGroundSessionStatus()).toBeNull();
  });

  it('E-20 refreshPlannedLegForFlight throws through for the current flight, with no notify', () => {
    const fm = newFm();
    takeoff(fm);
    behave.db.getFlightPlannedLegId = boom('leg id read failed');
    const threw = thrown(() => fm.refreshPlannedLegForFlight(1));
    const log = takeLog();
    const g = golden('E-20', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('leg id read failed');
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual([]);
  });

  it('E-21 getFlightStatePayload throws through outside a flight', () => {
    const fm = newFm();
    behave.groundSessions.getOpenGroundSession = boom('open session read failed');
    const threw = thrown(() => fm.getFlightStatePayload());
    const log = takeLog();
    const g = golden('E-21', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('open session read failed');
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual([]);
  });

  it('E-22 the touchdown airport lookup throws: the ON flag is already set, so no ON is ever filed', () => {
    arrangeLeg();
    const fm = newFm();
    takeoff(fm); cruise(fm, 1);
    behave.airports.findNearestAirport = boom('airport lookup failed');
    const threw = thrown(() => feed(fm, 1, LANDED));
    behave.airports.findNearestAirport = () => ({ icao: 'KMRY', name: 'Monterey Rgnl' });
    land(fm);
    const log = takeLog();
    const g = golden('E-22', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBe('airport lookup failed');
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual([]);
    expect(callsTo(log, 'acars.buildOooiMessage').map(c => (c.args[0] as { event: string }).event)).toEqual(['OUT', 'OFF', 'IN']);
  });

  it('E-23 the auto-link candidates read throws: warned, and the flight is recorded unlinked', () => {
    behave.db.getActiveTripId = () => 1;
    behave.db.getPlannedLegCandidatesForActiveTrip = boom('candidates failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm, 1); });
    const log = takeLog();
    const g = golden('E-23', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 auto-link failed, flight recorded unlinked: Error: candidates failed']);
    expect(callsTo(log, 'db.linkFlightToPlannedLeg')).toEqual([]);
  });

  it('E-24 the auto-link leg read throws: warned, no link is written, and the flight is recorded unlinked', () => {
    arrangeLeg();
    behave.db.getPlannedLegById = boom('leg read failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm, 1); });
    const log = takeLog();
    const g = golden('E-24', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 auto-link failed, flight recorded unlinked: Error: leg read failed']);
    expect(callsTo(log, 'db.linkFlightToPlannedLeg')).toEqual([]);
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('E-25 the auto-link write throws: warned, no leg status is kept, and the flight is recorded unlinked', () => {
    arrangeLeg();
    behave.db.linkFlightToPlannedLeg = boom('link write failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm, 1); });
    const log = takeLog();
    const g = golden('E-25', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 auto-link failed, flight recorded unlinked: Error: link write failed']);
    expect(callsTo(log, 'db.getTripName')).toEqual([]);
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('E-26 the auto-link trip-name read throws after the link was written: warned, no linked line, no leg status', () => {
    arrangeLeg();
    behave.db.getTripName = boom('trip name failed');
    const fm = newFm();
    const threw = thrown(() => { takeoff(fm); cruise(fm, 1); });
    const log = takeLog();
    const g = golden('E-26', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 1, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 auto-link failed, flight recorded unlinked: Error: trip name failed']);
    expect(callsTo(log, 'db.linkFlightToPlannedLeg')).toHaveLength(1);
    expect(consoleText(log)).not.toContain('linked to planned leg');
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('E-27 the arrival leg-id read throws: warned, and IN is still filed', () => {
    const fm = newFm();
    takeoff(fm); cruise(fm, 1);
    behave.db.getFlightPlannedLegId = boom('leg id read failed');
    const threw = thrown(() => land(fm));
    const log = takeLog();
    const g = golden('E-27', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 arrival not recorded on its planned leg: Error: leg id read failed']);
    expect(callsTo(log, 'db.recordPlannedLegArrival')).toEqual([]);
    expect(callsTo(log, 'acars.buildOooiMessage').map(c => (c.args[0] as { event: string }).event)).toEqual(['OUT', 'OFF', 'ON', 'IN']);
  });

  it('E-28 the arrival leg read throws: warned, no arrival is written, and IN is still filed', () => {
    arrangeLeg();
    behave.db.getFlightPlannedLegId = () => 11;
    const fm = newFm();
    takeoff(fm); cruise(fm, 1);
    behave.db.getPlannedLegById = boom('leg read failed');
    const threw = thrown(() => land(fm));
    const log = takeLog();
    const g = golden('E-28', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #1 arrival not recorded on its planned leg: Error: leg read failed']);
    expect(callsTo(log, 'db.recordPlannedLegArrival')).toEqual([]);
    expect(callsTo(log, 'acars.buildOooiMessage').map(c => (c.args[0] as { event: string }).event)).toEqual(['OUT', 'OFF', 'ON', 'IN']);
  });

  it('E-29 the resume leg read throws: warned, and the resume completes without a leg status', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightPlannedLegId = () => 11;
    behave.db.getPlannedLegById = boom('leg read failed');
    const fm = newFm();
    const threw = thrown(() => { feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 3, northOfNm(KSBA, 6)); });
    const log = takeLog();
    const g = golden('E-29', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #77 planned-leg cache not restored: Error: leg read failed']);
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('E-30 the resume trip-name read throws: warned, and the resume completes without a leg status', () => {
    arrangeLeg();
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightPlannedLegId = () => 11;
    behave.db.getTripName = boom('trip name failed');
    const fm = newFm();
    const threw = thrown(() => { feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 3, northOfNm(KSBA, 6)); });
    const log = takeLog();
    const g = golden('E-30', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'FLYING', currentFlightId: 77, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Flight #77 planned-leg cache not restored: Error: trip name failed']);
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('E-31 a resume whose first point write fails stays interrupted, so the next gap is not counted', () => {
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightTrackPoints = () => TRACK;
    let failing = true;
    behave.db.insertPoint = () => { if (failing) { failing = false; throw new Error('point write failed'); } };
    const fm = newFm();
    const threw = thrown(() => { feed(fm, 1, northOfNm(KSBA, 5)); cruise(fm, 1, northOfNm(KSBA, 6)); fm.onSimDisconnect(); });
    const log = takeLog();
    const g = golden('E-31', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual([BOOT_CHECK + 'point write failed']);
    const close = callsTo(log, 'db.closeFlight');
    expect(close).toHaveLength(1);
    expect(close[0].args[4]).toBe(15);
  });

  it('E-32 the ground-entry active-trip read throws: warned, and the session is still inserted', () => {
    behave.db.getActiveTripId = boom('active trip failed');
    const fm = newFm();
    const threw = thrown(() => { park(fm); park(fm, 3); });
    const log = takeLog();
    const g = golden('E-32', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session leg match failed: Error: active trip failed']);
    expect(callsTo(log, 'groundSessions.insertGroundSession')[0].args[0]).toMatchObject({ planned_leg_id: null, parking_position: null });
  });

  it('E-33 the ground-entry matched-leg read throws: warned, and the session is still inserted without a leg', () => {
    arrangeLeg();
    behave.db.getPlannedLegById = boom('leg read failed');
    const fm = newFm();
    const threw = thrown(() => { park(fm); park(fm, 3); });
    const log = takeLog();
    const g = golden('E-33', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'GROUND', currentFlightId: null, notifies: 1 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session leg match failed: Error: leg read failed']);
    expect(callsTo(log, 'groundSessions.insertGroundSession')[0].args[0]).toMatchObject({ planned_leg_id: null, parking_position: null });
    expect(fm.getGroundSessionStatus()?.plannedLegId).toBeNull();
  });

  it('E-34 the ground-entry airport lookup throws: nothing after it runs, and the state stays IDLE', () => {
    behave.airports.findNearestAirport = boom('airport lookup failed');
    const fm = newFm();
    const threw = thrown(() => { park(fm); park(fm, 3); });
    const log = takeLog();
    const g = golden('E-34', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session entry failed, staying IDLE: Error: airport lookup failed']);
    expect(callsTo(log, 'groundSessions.insertGroundSession')).toEqual([]);
    expect(callsTo(log, 'db.getActiveTripId')).toEqual([]);
  });

  it('E-35 the ground-entry cache leg read throws on an adopted session: the whole entry is abandoned', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', planned_leg_id: 11 });
    behave.db.getPlannedLegById = boom('leg read failed');
    const fm = newFm();
    const threw = thrown(() => park(fm));
    const log = takeLog();
    const g = golden('E-35', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session entry failed, staying IDLE: Error: leg read failed']);
    expect(fm.getGroundSessionStatus()).toBeNull();
  });

  it('E-36 the ground-entry cache trip-name read throws on an adopted session: the whole entry is abandoned', () => {
    arrangeLeg();
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', planned_leg_id: 11 });
    behave.db.getTripName = boom('trip name failed');
    const fm = newFm();
    const threw = thrown(() => park(fm));
    const log = takeLog();
    const g = golden('E-36', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session entry failed, staying IDLE: Error: trip name failed']);
    expect(fm.getGroundSessionStatus()).toBeNull();
  });

  it('E-37 the adopting fill throws: the whole entry is abandoned and the state stays IDLE', () => {
    ground.open = makeSessionRow({ source: 'manual' });
    behave.groundSessions.fillOpenGroundSessionGaps = boom('fill failed');
    const fm = newFm();
    const threw = thrown(() => park(fm));
    const log = takeLog();
    const g = golden('E-37', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 0 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session entry failed, staying IDLE: Error: fill failed']);
    expect(consoleText(log)).not.toContain('adopted');
    expect(fm.getGroundSessionStatus()).toBeNull();
  });

  it('E-38 the crash close of an auto session throws: warned, and the state still returns to IDLE', () => {
    const fm = newFm();
    park(fm);
    behave.groundSessions.closeOpenGroundSession = boom('close failed');
    const threw = thrown(() => fm.onCrash());
    park(fm, 3);
    const log = takeLog();
    const g = golden('E-38', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session close (crash) failed: Error: close failed']);
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession').map(c => c.args)).toEqual([['crash']]);
  });

  it('E-39 the disconnect close of an auto session throws: warned, and the state still returns to IDLE', () => {
    const fm = newFm();
    park(fm);
    behave.groundSessions.closeOpenGroundSession = boom('close failed');
    const threw = thrown(() => fm.onSimDisconnect());
    park(fm, 3);
    const log = takeLog();
    const g = golden('E-39', log);
    expect(log).toEqual(g.log);
    expect(consoleText(log)).toBe(g.consoleText);
    expect(threw).toBeNull();
    expect(endState(fm, log)).toEqual({ flightState: 'IDLE', currentFlightId: null, notifies: 2 });
    expect(warns(log)).toEqual(['[FlightManager] Ground session close (sim-exit) failed: Error: close failed']);
    expect(callsTo(log, 'groundSessions.closeOpenGroundSession').map(c => c.args)).toEqual([['sim-exit']]);
  });
});
